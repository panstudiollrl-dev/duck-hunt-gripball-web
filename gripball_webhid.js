(function () {
  "use strict";

  const VENDOR_ID = 0x08e2;
  const PRODUCT_ID = 0x0101;
  const REPORT_IMU = 3;
  const REPORT_GRIP = 5;
  const CALIBRATION_ROUNDS = 3;
  const CALIBRATION_HOLD_MS = 1500;
  const SHOT_COOLDOWN_MS = 800;
  const GYRO_FIRE_MIN = 260;
  const GYRO_FIRE_STRONG = 480;
  const GYRO_RELEASE = 190;
  const ACCEL_FIRE_MIN = 0.16;
  const ACCEL_FIRE_STRONG = 0.30;
  const ACCEL_RELEASE = 0.09;
  const MOTION_CONFIRM_MS = 55;
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
    state.hapticIgnoreUntil = performance.now() + 80;
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

  function estimateGrip(player, grip) {
    player.grip = grip;
    if (player.baseline == null) {
      return;
    }
    const force = grip - player.baseline;
    const isHolding = force > Math.max(45, player.travel * 0.06);
    if (state.phase === "play" && !isHolding) {
      player.baseline = player.baseline * 0.995 + grip * 0.005;
    }
    const rawStrength = Math.max(0, Math.min(1, force / Math.max(player.travel, 120)));
    const strength = force > Math.max(35, player.travel * 0.04) ? Math.max(0.16, Math.sqrt(rawStrength)) : 0;
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
    if (gyro < 200 && impulse < 0.20) {
      player.accelReference = player.accelReference * 0.995 + accel * 0.005;
    }
    player.gyro = gyro;
    player.impulse = impulse;
    if (state.phase === "play" && performance.now() >= state.hapticIgnoreUntil) {
      if (gyro < 180 && impulse < 0.13) {
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

    const gyroThreshold = Math.max(GYRO_FIRE_MIN, player.gyroNoise * 4.0 + 110);
    const impulseThreshold = Math.max(ACCEL_FIRE_MIN, player.impulseNoise * 3.6 + 0.07);
    const moderate = player.gyro > gyroThreshold || player.impulse > impulseThreshold;
    const strong = player.gyro > GYRO_FIRE_STRONG || player.impulse > ACCEL_FIRE_STRONG;

    if (moderate) {
      if (!player.motionCandidate || now - player.motionCandidate > MOTION_CONFIRM_MS) {
        player.motionCandidate = now;
        player.motionHits = 1;
      } else {
        player.motionHits += 1;
      }
    } else if (player.motionCandidate && now - player.motionCandidate > MOTION_CONFIRM_MS) {
      player.motionCandidate = 0;
      player.motionHits = 0;
    }

    if (!(strong || player.motionHits >= 1)) return;

    player.armed = false;
    player.stableSince = 0;
    player.motionCandidate = 0;
    player.motionHits = 0;
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
        if (playerForDevice(device)) continue;
        if (!device.opened) await device.open();
        const player = makePlayer(device, state.players.length);
        device.addEventListener("inputreport", event => parseInput(player, event));
        state.players.push(player);
        await stream(player);
        await haptic(player, 55, 45);
      }
      updatePlayerNumbers();
      setStatus(
        `已連接 ${state.players.length} 顆：${state.players.map((p) => `P${p.playerId + 1}`).join(" / ")}。可繼續新增或開始。`,
        "waiting"
      );
      refreshUi();
    } catch (error) {
      if (error.name !== "NotFoundError") console.error(error);
      setStatus("尚未新增握力球，請再試一次。", "error");
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

  async function calibratePlayer(player) {
    await haptic(player, 45, 40);
    await waitForGrip(player);
    const baselineSamples = [];
    const baselineStart = performance.now();
    while (performance.now() - baselineStart < 1000) {
      if (player.grip != null) baselineSamples.push(player.grip);
      emitCalibration(player, "RELAX", Math.min((performance.now() - baselineStart) / 1000 * 100, 100));
      await sleep(80);
    }
    player.baseline = median(baselineSamples) || player.grip || 0;

    const peaks = [];
    for (let round = 1; round <= CALIBRATION_ROUNDS; round += 1) {
      await haptic(player, 60, 45);
      let holdStart = 0;
      let peak = player.baseline;
      let lastUi = 0;
      while (true) {
        const now = performance.now();
        const force = player.grip == null ? 0 : player.grip - player.baseline;
        peak = Math.max(peak, player.grip || peak);
        if (force > 55) {
          if (!holdStart) holdStart = now;
        } else if (force < 30) {
          holdStart = 0;
        }
        const heldMs = holdStart ? now - holdStart : 0;
        if (now - lastUi > 90) {
          emitCalibration(
            player,
            `PRESS ${round}/${CALIBRATION_ROUNDS} ${Math.min(heldMs / 1000, 1.5).toFixed(1)}/1.5s`,
            ((round - 1) + Math.min(heldMs / CALIBRATION_HOLD_MS, 1)) / CALIBRATION_ROUNDS * 100,
            peak
          );
          lastUi = now;
        }
        if (heldMs >= CALIBRATION_HOLD_MS) break;
        await sleep(20);
      }
      peaks.push(peak);
      emitCalibration(player, `RELEASE ${round}/${CALIBRATION_ROUNDS}`, round / CALIBRATION_ROUNDS * 100, peak);
      await haptic(player, 35, 25);
      const releaseStart = performance.now();
      while (performance.now() - releaseStart < 500) await sleep(20);
    }

    player.peak = median(peaks);
    player.travel = Math.max(player.peak - player.baseline, 120);
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
