(function () {
  "use strict";

  const VENDOR_ID = 0x08e2;
  const PRODUCT_ID = 0x0101;
  const REPORT_IMU = 3;
  const REPORT_GRIP = 5;
  const CALIBRATION_ROUNDS = 3;
  const CALIBRATION_HOLD_MS = 1500;
  const CALIBRATION_RELEASE_MS = 650;
  const CALIBRATION_SAMPLE_MS = 1200;
  const CALIBRATION_MIN_PRESS_FORCE = 85;
  const CALIBRATION_MAX_PRESS_FORCE = 220;
  const CALIBRATION_DIP_GRACE_MS = 260;
  const CALIBRATION_STEP_TIMEOUT_MS = 15000;
  const CALIBRATION_BASELINE_CREEP = 12;
  const SHOT_COOLDOWN_MS = 1150;
  const MOTION_REARM_MS = 140;

  const TRACK_ENGAGE_MIN = 8;
  const TRACK_RELEASE_MIN = 4;
  const GRIP_STALE_MS = 250;
  const SETTLE_MS = 2200;
  const AUTOZERO_WINDOW_MS = 6000;
  const WAKE_TIMEOUT_MS = 25000;
  const WAKE_STREAM_MS = 500;
  const REST_FLAT_MS = 600;
  const REST_FLAT_SAMPLES = 30;
  const REST_FLAT_TOLERANCE = 24;
  const REST_TIMEOUT_MS = 20000;

  const SHAKE_REST_MS = 900;
  const SHAKE_SAMPLE_MS = 2500;
  const SHAKE_FIRE_RATIO = 0.45;
  const SHAKE_RELEASE_RATIO = 0.22;
  const SHAKE_MIN_RANGE = 0.15;

  const MAX_PLAYERS = 8;

  const TUNING_KEY = "gripball-tuning-v2";
  const TUNING_DEFAULTS = {
    engageForce: 60,
    releaseForce: 25,
    fullForce: 400,
    fireAccel: 26,
    cooldownMs: 1150,
  };
  const TUNING_FIELDS = [
    {key: "engageForce", label: "追蹤啟動", unit: "力", min: 5, max: 900, step: 5},
    {key: "releaseForce", label: "追蹤放開", unit: "力", min: 2, max: 900, step: 5},
    {key: "fullForce", label: "追蹤全速", unit: "力", min: 40, max: 4000, step: 20},
    {key: "fireAccel", label: "甩動開槍", unit: "甩", min: 10, max: 90, step: 0.5},
    {key: "cooldownMs", label: "開槍冷卻", unit: "ms", min: 200, max: 2000, step: 50},
  ];
  let tuningTouched = false;
  const tuning = Object.assign({}, TUNING_DEFAULTS);

  function loadTuning() {
    try {
      const raw = window.localStorage.getItem(TUNING_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const key of Object.keys(TUNING_DEFAULTS)) {
        if (typeof saved[key] === "number" && isFinite(saved[key])) {
          tuning[key] = saved[key];
          tuningTouched = true;
        }
      }
    } catch (error) {
      console.warn("Could not load gripball tuning", error);
    }
  }

  function saveTuning() {
    try {
      window.localStorage.setItem(TUNING_KEY, JSON.stringify(tuning));
    } catch (error) {
      console.warn("Could not save gripball tuning", error);
    }
  }

  function fireRelease(player) {
    const rest = player.accelRest == null ? tuning.fireAccel * 0.4 : player.accelRest;
    if (tuning.fireAccel <= rest) return tuning.fireAccel * 0.9;
    return rest + (tuning.fireAccel - rest) * 0.45;
  }

  function suggestFromCalibration() {
    const travels = state.players.map((p) => p.travel).filter((v) => v > 0);
    if (travels.length) {
      const travel = Math.min(...travels);
      tuning.fullForce = Math.round(travel);
      tuning.engageForce = Math.round(Math.max(10, travel * 0.14));
      tuning.releaseForce = Math.round(Math.max(5, travel * 0.07));
    }
    const peaks = state.players.filter((p) => p.accelRest != null && p.accelPeak != null);
    if (peaks.length) {
      const rest = median(peaks.map((p) => p.accelRest));
      const peak = median(peaks.map((p) => p.accelPeak));
      tuning.fireAccel = Math.round((rest + (peak - rest) * 0.45) * 2) / 2;
    }
  }

  function applyTuning() {
    tuningTouched = true;
    saveTuning();
    refreshTuningUi();
  }

  const queue = [];
  const state = {
    players: [],
    phase: "connect",
    readyStarted: 0,
    lastTrackEmit: 0,
    calibrationStarted: 0,
    lastDebugAt: 0,
  };

  function emit(message) {
    queue.push(message);
  }

  async function command(device, commandId, bytes) {
    if (!device || !device.opened) return;
    const payload = new Uint8Array(26);
    payload[0] = commandId;
    if (bytes) payload.set(bytes.slice(0, 25), 1);
    try {
      await device.sendReport(1, payload);
    } catch (error) {
      console.warn("Gripball command failed", error);
    }
  }

  async function stream(player) {
    await command(player.device, 1, new Uint8Array([3]));
  }

  async function haptic(player, intensity, duration) {
    if (!player) return;
    const data = new Uint8Array([3, 6, 0, 1, intensity, duration]);
    await command(player.device, 11, data);
    player.hapticIgnoreUntil = performance.now() + 180;
  }

  function makePlayer(device, playerId) {
    return {
      device,
      playerId,
      grip: null,
      baseline: null,
      peak: null,
      travel: 900,
      tracking: -1,
      holding: false,
      holdSince: 0,
      gripLog: [],
      gripNoise: 0,
      lastGripAt: 0,
      accel: null,
      accelRest: null,
      accelPeak: null,
      fireThreshold: null,
      fireRelease: null,
      armed: false,
      stableSince: 0,
      hapticIgnoreUntil: 0,
      onInput: null,
      lastShot: 0,
    };
  }

  function playerForDevice(device) {
    return state.players.find((player) => player.device === device);
  }

  function updatePlayerNumbers() {
    state.players.forEach((player, index) => {
      player.playerId = index;
    });
  }

  function isGripball(device) {
    return device && device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID;
  }

  const enrolling = new Set();

  async function enrollDevice(device, vibrate = true) {
    if (!isGripball(device) || playerForDevice(device) || enrolling.has(device)) {
      return false;
    }
    if (state.players.length >= MAX_PLAYERS) return false;
    enrolling.add(device);
    try {
      return await enrollDeviceInner(device, vibrate);
    } finally {
      enrolling.delete(device);
    }
  }

  async function enrollDeviceInner(device, vibrate) {
    if (!device.opened) await device.open();
    if (playerForDevice(device)) return false;
    const player = makePlayer(device, state.players.length);
    player.onInput = (event) => parseInput(player, event);
    device.addEventListener("inputreport", player.onInput);
    state.players.push(player);
    await stream(player);
    if (vibrate) await haptic(player, 55, 45);
    updatePlayerNumbers();
    emit({type: "player_count", count: state.players.length});
    return true;
  }

  function setConnectedStatus(prefix = "已連接") {
    if (state.players.length > 0) {
      setStatus(
        `${prefix} ${state.players.length} 顆：${state.players.map((p) => `P${p.playerId + 1}`).join(" / ")}。可繼續新增或開始。`,
        "waiting"
      );
    } else {
      setStatus("尚未偵測到已授權握力球。若 Chrome 視窗出現 paired，仍需選取一次授權給這個網頁。", "waiting");
    }
    refreshUi();
  }

  function estimateGrip(player, grip) {
    player.grip = grip;
    if (player.baseline == null) {
      return;
    }
    const force = grip - player.baseline;
    const engageForce = tuning.engageForce;
    const releaseForce = Math.min(tuning.releaseForce, engageForce * 0.9);
    const now = performance.now();
    if (player.holding) {
      if (force < releaseForce) {
        player.holding = false;
        player.holdSince = 0;
      }
    } else if (force >= engageForce) {
      player.holding = true;
      player.holdSince = now;
    }

    player.gripLog.push(now, grip);
    while (player.gripLog.length > 2 && now - player.gripLog[0] > AUTOZERO_WINDOW_MS) {
      player.gripLog.splice(0, 2);
    }
    if (
      state.phase === "play" &&
      player.holding &&
      player.holdSince &&
      now - player.holdSince > AUTOZERO_WINDOW_MS &&
      player.gripLog.length >= 80
    ) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i < player.gripLog.length; i += 2) {
        const value = player.gripLog[i];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      if (hi - lo < releaseForce && lo > player.baseline + releaseForce) {
        player.baseline = lo;
        player.holding = false;
        player.holdSince = 0;
        player.gripLog.length = 0;
      }
    }

    if (state.phase === "play" && !player.holding) {
      player.baseline = player.baseline * 0.995 + grip * 0.005;
    }
    const rawStrength = Math.max(0, Math.min(1, force / Math.max(tuning.fullForce, 20)));
    const strength = player.holding ? Math.max(0.18, Math.sqrt(rawStrength)) : 0;
    if (state.phase === "play" && Math.abs(strength - player.tracking) >= 0.015) {
      player.tracking = strength;
      emit({type: "track_player", player: player.playerId, value: strength});
    }
  }

  function parseInput(player, event) {
    const view = event.data;
    if (event.reportId === REPORT_GRIP && view.byteLength >= 4) {
      player.lastGripAt = performance.now();
      estimateGrip(player, view.getUint16(2, true));
      return;
    }
    if (event.reportId !== REPORT_IMU || view.byteLength < 28) return;

    const ax = view.getFloat32(4, true);
    const ay = view.getFloat32(8, true);
    const az = view.getFloat32(12, true);
    player.accel = Math.hypot(ax, ay, az);

    if (state.phase === "play" && performance.now() >= player.hapticIgnoreUntil) {
      updateMotion(player);
    }
  }

  function updateMotion(player) {
    if (player.accel == null) return;
    const now = performance.now();
    const release = fireRelease(player);

    if (!player.armed) {
      if (player.accel < release) {
        if (!player.stableSince) player.stableSince = now;
        if (now - player.stableSince >= MOTION_REARM_MS) player.armed = true;
      } else {
        player.stableSince = 0;
      }
      return;
    }

    if (player.accel < tuning.fireAccel) return;

    player.armed = false;
    player.stableSince = 0;
    if (now - player.lastShot < tuning.cooldownMs) return;

    player.lastShot = now;
    emit({type: "shoot_player", player: player.playerId});
    haptic(player, 70, 35);
    setStatus(`P${player.playerId + 1} fired`, "ready");
  }

  function setStatus(text, kind) {
    const node = document.getElementById("gripball-status");
    if (node) {
      node.textContent = text;
      node.dataset.kind = kind || "";
    }
  }

  function refreshUi() {
    const startButton = document.getElementById("gripball-start");
    if (startButton) startButton.disabled = state.players.length < 1 || state.phase !== "connect";
    const connectButton = document.getElementById("gripball-connect");
    if (connectButton) connectButton.style.display = state.phase === "connect" ? "" : "none";
    if (startButton) startButton.style.display = state.phase === "connect" ? "" : "none";
  }

  async function resumeAudioAndFocusCanvas() {
    if (window.GodotAudio && window.GodotAudio.ctx && window.GodotAudio.ctx.state !== "running") {
      await window.GodotAudio.ctx.resume();
    }
    const canvas = document.getElementById("canvas");
    if (!canvas) return;
    canvas.focus();
    canvas.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, pointerId: 1, pointerType: "mouse"}));
    canvas.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, button: 0}));
    canvas.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, button: 0}));
    canvas.dispatchEvent(new PointerEvent("pointerup", {bubbles: true, pointerId: 1, pointerType: "mouse"}));
  }

  async function addDevices() {
    if (!navigator.hid) {
      setStatus("此瀏覽器不支援 WebHID，請使用最新版 Chrome 或 Edge。", "error");
      return;
    }
    try {
      await resumeAudioAndFocusCanvas();
      const gripballs = (await navigator.hid.requestDevice({
        filters: [{vendorId: VENDOR_ID, productId: PRODUCT_ID}],
      })).slice(0, MAX_PLAYERS);
      for (const device of gripballs) {
        await enrollDevice(device, true);
      }
      setConnectedStatus("已連接");
    } catch (error) {
      if (error.name !== "NotFoundError") console.error(error);
      setStatus("尚未新增握力球，請再試一次。", "error");
    }
  }

  async function restoreAuthorizedDevices() {
    if (!navigator.hid) {
      setStatus("此瀏覽器不支援 WebHID，請使用最新版 Chrome 或 Edge。", "error");
      refreshUi();
      return;
    }
    try {
      const devices = await navigator.hid.getDevices();
      let restored = 0;
      for (const device of devices) {
        if (!isGripball(device)) continue;
        try {
          if (await enrollDevice(device, false)) restored += 1;
        } catch (error) {
          console.warn("Authorized Gripball is unavailable", device.productName || device, error);
        }
      }
      setConnectedStatus(restored > 0 ? "已自動恢復" : "已連接");
    } catch (error) {
      console.warn("Could not restore authorized Gripballs", error);
      setConnectedStatus();
    }
  }

  async function identifyPlayers() {
    for (const player of state.players) {
      for (let i = 0; i <= player.playerId; i += 1) {
        await haptic(player, 72, 55);
        await new Promise(resolve => setTimeout(resolve, 160));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  function medianAbsoluteDeviation(values, center) {
    if (!values.length) return 0;
    return median(values.map((value) => Math.abs(value - center)));
  }

  function emitCalibration(player, text, progress, peak) {
    emit({
      type: "calibration",
      step: `P${player.playerId + 1} / ${state.players.length}`,
      text,
      progress,
      raw: player.grip == null ? "--" : Math.round(player.grip),
      baseline: player.baseline == null ? "--" : Math.round(player.baseline),
      force: player.grip == null || player.baseline == null ? "--" : Math.max(0, Math.round(player.grip - player.baseline)),
      peak: peak == null ? "--" : Math.round(peak),
    });
    setStatus(
      `P${player.playerId + 1}: ${text} ` +
      `(raw ${player.grip == null ? "--" : Math.round(player.grip)})`,
      "waiting"
    );
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function gripIsLive(player) {
    return player.grip != null && performance.now() - player.lastGripAt < GRIP_STALE_MS;
  }

  async function waitForStream(player, label) {
    const start = performance.now();
    let liveSince = 0;
    let lastUi = 0;
    while (true) {
      const now = performance.now();
      if (now - start > WAKE_TIMEOUT_MS) {
        throw new Error(`P${player.playerId + 1} 收不到壓力資料，請按一下球喚醒它`);
      }
      if (gripIsLive(player)) {
        if (!liveSince) liveSince = now;
        if (now - liveSince >= WAKE_STREAM_MS) break;
      } else {
        liveSince = 0;
      }
      if (now - lastUi > 90) {
        emitCalibration(player, label, 0);
        lastUi = now;
      }
      await sleep(25);
    }
  }

  async function captureRestBaseline(player, label, progress) {
    const samples = [];
    const start = performance.now();
    let flatSince = 0;
    let lastUi = 0;
    while (true) {
      const now = performance.now();
      if (now - start > REST_TIMEOUT_MS) {
        throw new Error(
          `P${player.playerId + 1} 靜置讀數抓不穩（raw ${player.grip == null ? "--" : Math.round(player.grip)}）`
        );
      }
      if (gripIsLive(player)) {
        samples.push(player.grip);
        while (samples.length > REST_FLAT_SAMPLES) samples.shift();
        if (samples.length >= REST_FLAT_SAMPLES) {
          const lo = Math.min(...samples);
          const hi = Math.max(...samples);
          if (hi - lo <= REST_FLAT_TOLERANCE) {
            if (!flatSince) flatSince = now;
          } else {
            flatSince = 0;
          }
        }
      } else {
        flatSince = 0;
        samples.length = 0;
      }
      if (flatSince && now - flatSince >= REST_FLAT_MS) break;
      if (now - lastUi > 90) {
        emitCalibration(player, label, progress || 0);
        lastUi = now;
      }
      await sleep(25);
    }
    player.baseline = median(samples);
    player.gripNoise = medianAbsoluteDeviation(samples, player.baseline);
    player.holding = false;
    player.holdSince = 0;
    player.gripLog.length = 0;
  }

  async function calibrateShake(player) {
    const restSamples = [];
    const restStart = performance.now();
    let lastUi = 0;
    while (performance.now() - restStart < SHAKE_REST_MS) {
      if (player.accel != null) restSamples.push(player.accel);
      if (performance.now() - lastUi > 90) {
        emitCalibration(player, "HOLD STILL - DO NOT SHAKE", 0);
        lastUi = performance.now();
      }
      await sleep(25);
    }
    if (!restSamples.length) {
      throw new Error(`P${player.playerId + 1} 沒有加速度資料`);
    }
    const rest = median(restSamples);
    player.accelRest = rest;

    await haptic(player, 60, 45);
    let peak = rest;
    const shakeStart = performance.now();
    lastUi = 0;
    while (performance.now() - shakeStart < SHAKE_SAMPLE_MS) {
      const now = performance.now();
      if (player.accel != null && now >= player.hapticIgnoreUntil) {
        peak = Math.max(peak, player.accel);
      }
      if (now - lastUi > 90) {
        const left = (SHAKE_SAMPLE_MS - (now - shakeStart)) / 1000;
        emitCalibration(
          player,
          `SHAKE NOW ${left.toFixed(1)}s (peak ${peak.toFixed(2)})`,
          (now - shakeStart) / SHAKE_SAMPLE_MS * 100
        );
        lastUi = now;
      }
      await sleep(20);
    }

    if (peak < rest * (1 + SHAKE_MIN_RANGE)) {
      throw new Error(
        `P${player.playerId + 1} 甩動幅度不足（靜止 ${rest.toFixed(2)}，最高 ${peak.toFixed(2)}）`
      );
    }

    player.accelPeak = peak;
    player.armed = false;
    player.stableSince = 0;
    emitCalibration(
      player,
      `SHAKE OK (rest ${rest.toFixed(2)} peak ${peak.toFixed(2)})`,
      100
    );
    await haptic(player, 70, 60);
    await sleep(250);
  }

  async function settleAllPlayers() {
    await Promise.all(
      state.players.map((player) => waitForStream(player, "PRESS EACH BALL ONCE"))
    );
    await Promise.all(
      state.players.map((player) =>
        captureRestBaseline(player, "ALL PLAYERS HOLD BALL - DO NOT PRESS", 100)
      )
    );
    for (const player of state.players) {
      player.tracking = -1;
    }
  }

  async function calibratePlayer(player) {
    await haptic(player, 45, 40);
    await waitForStream(player, "PRESS BALL ONCE TO WAKE");
    await captureRestBaseline(player, "HOLD BALL - DO NOT PRESS", 0);

    const peaks = [];
    for (let round = 1; round <= CALIBRATION_ROUNDS; round += 1) {
      const baseProgress = (round - 1) / CALIBRATION_ROUNDS * 100;
      await captureRestBaseline(player, `RELEASE BEFORE ${round}/${CALIBRATION_ROUNDS}`, baseProgress);
      await haptic(player, 60, 45);
      let holdStart = 0;
      let peak = player.grip || player.baseline;
      let peakForce = 0;
      let lastUi = 0;
      const pressThreshold = Math.min(
        CALIBRATION_MAX_PRESS_FORCE,
        Math.max(CALIBRATION_MIN_PRESS_FORCE, (player.gripNoise || 0) * 8 + 55)
      );
      const resetThreshold = Math.max(35, pressThreshold * 0.58);
      const pressStarted = performance.now();
      let dipStart = 0;
      while (true) {
        const now = performance.now();
        if (now - pressStarted > CALIBRATION_STEP_TIMEOUT_MS) {
          throw new Error(
            `P${player.playerId + 1} 按壓不足（需 ${Math.round(pressThreshold)}，最高 ${Math.round(peakForce)}）`
          );
        }
        const force = gripIsLive(player) ? player.grip - player.baseline : 0;
        peak = Math.max(peak, player.grip || peak);
        peakForce = Math.max(peakForce, force);
        if (force >= pressThreshold) {
          if (!holdStart) holdStart = now;
          dipStart = 0;
        } else if (force < resetThreshold) {
          if (!dipStart) dipStart = now;
          if (now - dipStart > CALIBRATION_DIP_GRACE_MS) {
            holdStart = 0;
            dipStart = 0;
          }
        }
        const heldMs = holdStart ? now - holdStart : 0;
        if (now - lastUi > 90) {
          emitCalibration(
            player,
            `PRESS ${round}/${CALIBRATION_ROUNDS} ${Math.min(heldMs / 1000, 1.5).toFixed(1)}/1.5s (need ${Math.round(pressThreshold)})`,
            ((round - 1) + Math.min(heldMs / CALIBRATION_HOLD_MS, 1)) / CALIBRATION_ROUNDS * 100,
            peak
          );
          lastUi = now;
        }
        if (heldMs >= CALIBRATION_HOLD_MS && peakForce >= pressThreshold) break;
        await sleep(20);
      }
      peaks.push(peak);
      emitCalibration(player, `RECORDED ${round}/${CALIBRATION_ROUNDS}`, round / CALIBRATION_ROUNDS * 100, peak);
      await haptic(player, 35, 25);
    }

    player.peak = median(peaks);
    player.travel = Math.max((player.peak - player.baseline) * 0.65, 80);
    player.tracking = -1;
    player.holding = false;

    await calibrateShake(player);

    emitCalibration(player, "DONE", 100, player.peak);
    await haptic(player, 70, 60);
    await sleep(300);
  }

  async function calibrateAllPlayers() {
    state.phase = "calibrating";
    refreshUi();
    state.calibrationStarted = performance.now();
    for (const player of state.players) {
      await calibratePlayer(player);
    }
    await settleAllPlayers();
    if (!tuningTouched) {
      suggestFromCalibration();
      saveTuning();
    }
    refreshTuningUi();
  }

  async function startGame() {
    if (state.players.length < 1 || state.phase !== "connect") return;
    try {
      await resumeAudioAndFocusCanvas();
      setStatus(`準備校正 ${state.players.length} 顆握力球…`, "waiting");
      await calibrateAllPlayers();
      state.phase = "starting";
      setStatus(`正在標記 ${state.players.length} 顆握力球編號…`, "waiting");
      await identifyPlayers();
      state.phase = "play";
      state.readyStarted = performance.now();
      emit({type: "player_count", count: state.players.length});
      emit({type: "calibration_done"});
      for (const player of state.players) {
        emit({type: "track_player", player: player.playerId, value: Math.max(0, player.tracking)});
      }
      setStatus(`開始！握住追蹤鴨子，甩動才發射。`, "ready");
    } catch (error) {
      console.error(error);
      state.phase = "connect";
      setStatus(`校正失敗：${error.message || error}。請放開握力球後再開始。`, "error");
    }
    refreshUi();
  }

  function refreshTuningUi() {
    for (const field of TUNING_FIELDS) {
      const slider = document.getElementById(`gt-${field.key}`);
      const box = document.getElementById(`gt-${field.key}-box`);
      const value = tuning[field.key];
      if (slider && Number(slider.value) !== value) {
        slider.value = Math.min(field.max, Math.max(field.min, value));
      }
      if (box && document.activeElement !== box && Number(box.value) !== value) {
        box.value = value;
      }
    }
  }

  function setTuning(key, raw) {
    const field = TUNING_FIELDS.find((item) => item.key === key);
    const value = Number(raw);
    if (!field || !isFinite(value)) return;
    tuning[key] = value;
    applyTuning();
  }

  function installTuningUi() {
    const panel = document.createElement("div");
    panel.id = "gripball-tuning";
    const rows = TUNING_FIELDS.map((field) => (
      `<label><span>${field.label}</span>` +
      `<input type="range" id="gt-${field.key}" min="${field.min}" max="${field.max}" step="${field.step}">` +
      `<input type="number" id="gt-${field.key}-box" step="${field.step}">` +
      `<i>${field.unit}</i></label>`
    )).join("");
    panel.innerHTML =
      `<button id="gt-toggle">靈敏度設定</button>` +
      `<div id="gt-body">${rows}` +
      `<button id="gt-import">從校正帶入</button>` +
      `<button id="gt-reset">重設為預設值</button></div>`;
    document.body.appendChild(panel);

    document.getElementById("gt-toggle").addEventListener("click", () => {
      const body = document.getElementById("gt-body");
      body.style.display = body.style.display === "block" ? "none" : "block";
      refreshTuningUi();
    });
    document.getElementById("gt-reset").addEventListener("click", () => {
      Object.assign(tuning, TUNING_DEFAULTS);
      applyTuning();
    });
    document.getElementById("gt-import").addEventListener("click", () => {
      suggestFromCalibration();
      applyTuning();
    });
    for (const field of TUNING_FIELDS) {
      document.getElementById(`gt-${field.key}`)
        .addEventListener("input", (event) => setTuning(field.key, event.target.value));
      document.getElementById(`gt-${field.key}-box`)
        .addEventListener("change", (event) => setTuning(field.key, event.target.value));
    }
    refreshTuningUi();
  }

  function installUi() {
    const style = document.createElement("style");
    style.textContent = "#gripball-webhid{position:fixed;z-index:99999;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;background:#111d;color:#fff;font:14px system-ui;box-shadow:0 4px 18px #0008}#gripball-webhid button{border:0;border-radius:7px;padding:8px 13px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gripball-webhid button:disabled{opacity:.45;cursor:not-allowed}#gripball-status[data-kind=error]{color:#ff9999}#gripball-status[data-kind=ready]{color:#a8f0ae}#gripball-tuning{position:fixed;z-index:99999;left:12px;bottom:12px;font:13px system-ui;color:#fff}#gripball-tuning button{border:0;border-radius:7px;padding:7px 11px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gt-body{display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:#111e;box-shadow:0 4px 18px #0008;min-width:270px}#gt-body label{display:flex;align-items:center;gap:8px;margin-bottom:8px}#gt-body label span{width:64px;flex:none}#gt-body label input[type=range]{flex:1;min-width:90px}#gt-body label input[type=number]{width:66px;flex:none;padding:3px 5px;border-radius:5px;border:1px solid #555;background:#222;color:#fff;font:13px system-ui;text-align:right}#gt-body label i{width:22px;flex:none;font-style:normal;opacity:.65}#gt-import,#gt-reset{width:100%;margin-top:5px}#gt-body{min-width:330px}";
    document.head.appendChild(style);
    const panel = document.createElement("div");
    panel.id = "gripball-webhid";
    panel.innerHTML = '<button id="gripball-connect">連接/新增握力球</button><button id="gripball-start" disabled>開始遊戲</button><span id="gripball-status">先連接所有要玩的握力球，再按開始。</span>';
    document.body.appendChild(panel);
    document.getElementById("gripball-connect").addEventListener("click", addDevices);
    document.getElementById("gripball-start").addEventListener("click", startGame);
    installTuningUi();
    refreshUi();
    restoreAuthorizedDevices();
  }

  if (navigator.hid) {
    navigator.hid.addEventListener("disconnect", (event) => {
      const player = playerForDevice(event.device);
      if (!player) return;
      if (player.onInput) {
        try {
          player.device.removeEventListener("inputreport", player.onInput);
        } catch (error) {
          console.warn("Could not detach Gripball listener", error);
        }
        player.onInput = null;
      }
      state.players = state.players.filter((item) => item !== player);
      updatePlayerNumbers();
      emit({type: "player_count", count: state.players.length});
      setConnectedStatus("已連接");
    });
    navigator.hid.addEventListener("connect", (event) => {
      if (state.phase === "connect" && isGripball(event.device)) {
        enrollDevice(event.device, false).then((added) => {
          if (added) setConnectedStatus("已自動連接");
        }).catch((error) => console.warn("Could not auto-connect Gripball", error));
      }
    });
  }

  window.gripballBridge = {
    poll() {
      const now = performance.now();
      if (state.phase === "play") {
        for (const player of state.players) {
          if (player.tracking > 0 && now - player.lastGripAt > GRIP_STALE_MS) {
            player.holding = false;
            player.tracking = 0;
            emit({type: "track_player", player: player.playerId, value: 0});
          }
        }
        if (now - state.readyStarted < 4000) {
          emit({type: "player_count", count: state.players.length});
          emit({type: "calibration_done"});
        }
        if (now - state.lastDebugAt > 200) {
          state.lastDebugAt = now;
          setStatus(
            state.players.map((player) => {
              const force = player.grip == null || player.baseline == null
                ? 0 : Math.round(player.grip - player.baseline);
              const engage = Math.round(tuning.engageForce);
              const accel = player.accel == null ? 0 : player.accel;
              const fire = tuning.fireAccel;
              const raw = player.grip == null ? "--" : Math.round(player.grip);
              return `P${player.playerId + 1} ${player.holding ? "握" : "放"} raw${raw}` +
                ` 力${force}/${engage} 甩${accel.toFixed(2)}/${fire.toFixed(2)}`;
            }).join("   "),
            "ready"
          );
        }
      }
      return JSON.stringify(queue.splice(0, queue.length));
    },
    proximity(_intensity) {
      // Party Mode uses visual timing instead of proximity haptics.
    },
  };

  loadTuning();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi);
  else installUi();
})();
