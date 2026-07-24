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
  const GYRO_FIRE_MIN = 520;
  const GYRO_FIRE_STRONG = 760;
  const GYRO_RELEASE = 260;
  const ACCEL_FIRE_MIN = 0.34;
  const ACCEL_FIRE_STRONG = 0.52;
  const ACCEL_RELEASE = 0.16;
  const MOTION_CONFIRM_MS = 90;
  const MOTION_REQUIRED_HITS = 3;
  const MAX_PLAYERS = 8;

  const queue = [];
  const state = {
    players: [],
    phase: "connect",
    hapticIgnoreUntil: 0,
    readyStarted: 0,
    lastTrackEmit: 0,
    calibrationStarted: 0,
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
    state.hapticIgnoreUntil = performance.now() + 180;
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
      accelReference: null,
      gyro: 0,
      impulse: 0,
      armed: false,
      stableSince: 0,
      motionCandidate: 0,
      motionHits: 0,
      motionPeak: 0,
      gyroNoise: 35,
      impulseNoise: 0.025,
      lastShot: 0,
    };
  }

  function playerForDevice(device) {
    return state.players.find((player) => {
      if (player.device === device) return true;
      if (device.serialNumber && player.device.serialNumber) {
        return player.device.serialNumber === device.serialNumber;
      }
      return false;
    });
  }

  function updatePlayerNumbers() {
    state.players.forEach((player, index) => {
      player.playerId = index;
    });
  }

  function isGripball(device) {
    return device && device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID;
  }

  async function enrollDevice(device, vibrate = true) {
    if (!isGripball(device) || playerForDevice(device) || state.players.length >= MAX_PLAYERS) {
      return false;
    }
    if (!device.opened) await device.open();
    const player = makePlayer(device, state.players.length);
    device.addEventListener("inputreport", event => parseInput(player, event));
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
    const isHolding = force > Math.max(28, player.travel * 0.045);
    if (state.phase === "play" && !isHolding) {
      player.baseline = player.baseline * 0.995 + grip * 0.005;
    }
    const rawStrength = Math.max(0, Math.min(1, force / Math.max(player.travel, 80)));
    const strength = force > Math.max(20, player.travel * 0.03) ? Math.max(0.18, Math.sqrt(rawStrength)) : 0;
    if (state.phase === "play" && Math.abs(strength - player.tracking) >= 0.015) {
      player.tracking = strength;
      emit({type: "track_player", player: player.playerId, value: strength});
    }
  }

  function parseInput(player, event) {
    const view = event.data;
    if (event.reportId === REPORT_GRIP && view.byteLength >= 4) {
      estimateGrip(player, view.getUint16(2, true));
      return;
    }
    if (event.reportId !== REPORT_IMU || view.byteLength < 28) return;

    const ax = view.getFloat32(4, true);
    const ay = view.getFloat32(8, true);
    const az = view.getFloat32(12, true);
    const gx = view.getFloat32(16, true);
    const gy = view.getFloat32(20, true);
    const gz = view.getFloat32(24, true);
    const gyro = Math.hypot(gx, gy, gz);
    const accel = Math.hypot(ax, ay, az);
    if (player.accelReference == null) player.accelReference = Math.max(accel, 0.001);
    const impulse = Math.abs(accel - player.accelReference) / Math.max(player.accelReference, 0.001);
    if (gyro < 260 && impulse < 0.18) {
      player.accelReference = player.accelReference * 0.995 + accel * 0.005;
    }
    player.gyro = gyro;
    player.impulse = impulse;
    if (state.phase === "play" && performance.now() >= state.hapticIgnoreUntil) {
      if (gyro < 240 && impulse < 0.14) {
        player.gyroNoise = player.gyroNoise * 0.985 + gyro * 0.015;
        player.impulseNoise = player.impulseNoise * 0.985 + impulse * 0.015;
      }
      updateMotion(player);
    }
  }

  function updateMotion(player) {
    const now = performance.now();
    if (!player.armed) {
      if (player.gyro < GYRO_RELEASE && player.impulse < ACCEL_RELEASE) {
        if (!player.stableSince) player.stableSince = now;
        if (now - player.stableSince >= 180) player.armed = true;
      } else {
        player.stableSince = 0;
      }
      return;
    }

    const gyroThreshold = Math.max(GYRO_FIRE_MIN, player.gyroNoise * 4.8 + 180);
    const impulseThreshold = Math.max(ACCEL_FIRE_MIN, player.impulseNoise * 4.2 + 0.13);
    const moderate = player.gyro > gyroThreshold || player.impulse > impulseThreshold;
    const strong = player.gyro > GYRO_FIRE_STRONG || player.impulse > ACCEL_FIRE_STRONG;

    if (moderate) {
      if (!player.motionCandidate || now - player.motionCandidate > MOTION_CONFIRM_MS * 2.2) {
        player.motionCandidate = now;
        player.motionHits = 1;
        player.motionPeak = Math.max(player.gyro / gyroThreshold, player.impulse / impulseThreshold);
      } else {
        player.motionHits += 1;
        player.motionPeak = Math.max(
          player.motionPeak,
          player.gyro / gyroThreshold,
          player.impulse / impulseThreshold
        );
      }
    } else if (player.motionCandidate && now - player.motionCandidate > MOTION_CONFIRM_MS) {
      player.motionCandidate = 0;
      player.motionHits = 0;
      player.motionPeak = 0;
    }

    const confirmedFlick = (
      player.motionHits >= MOTION_REQUIRED_HITS &&
      now - player.motionCandidate >= MOTION_CONFIRM_MS &&
      player.motionPeak >= 1.18
    );
    if (!(strong || confirmedFlick)) return;

    player.armed = false;
    player.stableSince = 0;
    player.motionCandidate = 0;
    player.motionHits = 0;
    player.motionPeak = 0;
    if (now - player.lastShot < SHOT_COOLDOWN_MS) return;

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

  async function waitForGrip(player, timeoutMs = 3000) {
    const start = performance.now();
    while (player.grip == null && performance.now() - start < timeoutMs) {
      await sleep(20);
    }
    return player.grip != null;
  }

  async function collectReleasedBaseline(player, text, progress) {
    const samples = [];
    const start = performance.now();
    let lastUi = 0;
    while (performance.now() - start < CALIBRATION_SAMPLE_MS) {
      if (player.grip != null) samples.push(player.grip);
      if (performance.now() - lastUi > 90) {
        const tempBaseline = samples.length ? median(samples) : player.baseline;
        if (tempBaseline != null) player.baseline = tempBaseline;
        emitCalibration(player, text, progress);
        lastUi = performance.now();
      }
      await sleep(30);
    }
    if (samples.length) {
      player.baseline = median(samples);
      player.gripNoise = medianAbsoluteDeviation(samples, player.baseline);
    } else {
      player.gripNoise = 0;
    }
  }

  async function waitForReleased(player, round, progress) {
    const samples = [];
    const started = performance.now();
    let releaseStart = 0;
    let lastUi = 0;
    while (true) {
      const now = performance.now();
      if (now - started > CALIBRATION_STEP_TIMEOUT_MS) {
        throw new Error(
          `P${player.playerId + 1} 偵測不到放開（raw ${Math.round(player.grip)} / base ${Math.round(player.baseline)}）`
        );
      }
      if (player.grip != null) {
        samples.push(player.grip);
        while (samples.length > 35) samples.shift();
        const candidateBaseline = median(samples);
        const noise = medianAbsoluteDeviation(samples, candidateBaseline);
        const stableWindow = Math.max(...samples) - Math.min(...samples);
        if (samples.length >= 12 && stableWindow < Math.max(45, noise * 8 + 18)) {
          if (player.baseline == null || candidateBaseline < player.baseline + CALIBRATION_BASELINE_CREEP) {
            player.baseline = candidateBaseline;
          }
          player.gripNoise = noise;
        }
      }
      const force = player.grip == null || player.baseline == null ? 999 : Math.abs(player.grip - player.baseline);
      const releaseThreshold = Math.max(28, (player.gripNoise || 0) * 5 + 12);
      if (force <= releaseThreshold) {
        if (!releaseStart) releaseStart = now;
      } else {
        releaseStart = 0;
      }
      if (now - lastUi > 90) {
        emitCalibration(player, `RELEASE BEFORE ${round}/${CALIBRATION_ROUNDS}`, progress);
        lastUi = now;
      }
      if (releaseStart && now - releaseStart >= CALIBRATION_RELEASE_MS) break;
      await sleep(25);
    }
  }

  async function calibratePlayer(player) {
    await haptic(player, 45, 40);
    const hasGrip = await waitForGrip(player);
    if (!hasGrip) {
      throw new Error(`P${player.playerId + 1} has no grip data`);
    }
    await collectReleasedBaseline(player, "RELAX - DO NOT PRESS", 0);

    const peaks = [];
    for (let round = 1; round <= CALIBRATION_ROUNDS; round += 1) {
      const baseProgress = (round - 1) / CALIBRATION_ROUNDS * 100;
      await waitForReleased(player, round, baseProgress);
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
        const force = player.grip == null ? 0 : player.grip - player.baseline;
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

  function installUi() {
    const style = document.createElement("style");
    style.textContent = "#gripball-webhid{position:fixed;z-index:99999;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;background:#111d;color:#fff;font:14px system-ui;box-shadow:0 4px 18px #0008}#gripball-webhid button{border:0;border-radius:7px;padding:8px 13px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gripball-webhid button:disabled{opacity:.45;cursor:not-allowed}#gripball-status[data-kind=error]{color:#ff9999}#gripball-status[data-kind=ready]{color:#a8f0ae}";
    document.head.appendChild(style);
    const panel = document.createElement("div");
    panel.id = "gripball-webhid";
    panel.innerHTML = '<button id="gripball-connect">連接/新增握力球</button><button id="gripball-start" disabled>開始遊戲</button><span id="gripball-status">先連接所有要玩的握力球，再按開始。</span>';
    document.body.appendChild(panel);
    document.getElementById("gripball-connect").addEventListener("click", addDevices);
    document.getElementById("gripball-start").addEventListener("click", startGame);
    refreshUi();
    restoreAuthorizedDevices();
  }

  if (navigator.hid) {
    navigator.hid.addEventListener("disconnect", (event) => {
      const player = playerForDevice(event.device);
      if (!player) return;
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
      if (state.phase === "play" && performance.now() - state.readyStarted < 4000) {
        emit({type: "player_count", count: state.players.length});
        emit({type: "calibration_done"});
      }
      return JSON.stringify(queue.splice(0, queue.length));
    },
    proximity(_intensity) {
      // Party Mode uses visual timing instead of proximity haptics.
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi);
  else installUi();
})();
