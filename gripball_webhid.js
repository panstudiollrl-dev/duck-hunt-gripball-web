(function () {
  "use strict";

  const VENDOR_ID = 0x08e2;
  const PRODUCT_ID = 0x0101;
  const REPORT_IMU = 3;
  const REPORT_GRIP = 5;
  const SHOT_COOLDOWN_MS = 800;
  const GYRO_FIRE_MIN = 360;
  const GYRO_FIRE_STRONG = 650;
  const GYRO_RELEASE = 240;
  const ACCEL_FIRE_MIN = 0.22;
  const ACCEL_FIRE_STRONG = 0.44;
  const ACCEL_RELEASE = 0.12;
  const MOTION_CONFIRM_MS = 95;
  const MAX_PLAYERS = 8;

  const queue = [];
  const state = {
    devices: [],
    players: [],
    phase: "connect",
    hapticIgnoreUntil: 0,
    readyStarted: 0,
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
      lastDebug: 0,
    };
  }

  function parseInput(player, event) {
    const view = event.data;
    if (event.reportId === REPORT_GRIP && view.byteLength >= 4) {
      player.grip = view.getUint16(2, true);
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
      if (gyro < 220 && impulse < 0.16) {
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

    const gyroThreshold = Math.max(GYRO_FIRE_MIN, player.gyroNoise * 5.5 + 150);
    const impulseThreshold = Math.max(ACCEL_FIRE_MIN, player.impulseNoise * 5.0 + 0.10);
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

    if (!(strong || player.motionHits >= 2)) return;

    player.armed = false;
    player.stableSince = 0;
    player.motionCandidate = 0;
    player.motionHits = 0;
    if (now - player.lastShot < SHOT_COOLDOWN_MS) return;

    player.lastShot = now;
    emit({type: "shoot_player", player: player.playerId});
    haptic(player, 70, 35);
    setStatus(`P${player.playerId + 1} shot`, "ready");
  }

  function setStatus(text, kind) {
    const node = document.getElementById("gripball-status");
    if (node) {
      node.textContent = text;
      node.dataset.kind = kind || "";
    }
  }

  function uniqueGripballDevices(devices) {
    const seen = new Set();
    const out = [];
    for (const device of devices) {
      if (device.vendorId !== VENDOR_ID || device.productId !== PRODUCT_ID) continue;
      const key = device.serialNumber || `${device.productName}-${out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(device);
    }
    return out.slice(0, MAX_PLAYERS);
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

  async function identifyPlayers() {
    for (const player of state.players) {
      for (let i = 0; i <= player.playerId; i += 1) {
        await haptic(player, 72, 55);
        await new Promise(resolve => setTimeout(resolve, 160));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  async function connect() {
    if (!navigator.hid) {
      setStatus("此瀏覽器不支援 WebHID，請使用最新版 Chrome 或 Edge。", "error");
      return;
    }
    try {
      await resumeAudioAndFocusCanvas();
      await navigator.hid.requestDevice({filters: [{vendorId: VENDOR_ID, productId: PRODUCT_ID}]});
      const granted = await navigator.hid.getDevices();
      const devices = uniqueGripballDevices(granted);
      if (devices.length < 1) {
        setStatus("尚未連接握力球，請再試一次。", "error");
        return;
      }

      state.players = [];
      for (const device of devices) {
        if (!device.opened) await device.open();
        const player = makePlayer(device, state.players.length);
        device.addEventListener("inputreport", event => parseInput(player, event));
        state.players.push(player);
        await stream(player);
      }

      document.getElementById("gripball-connect").style.display = "none";
      setStatus(`已連接 ${state.players.length} 顆握力球，正在標記編號…`, "waiting");
      await identifyPlayers();

      state.phase = "play";
      state.readyStarted = performance.now();
      emit({type: "player_count", count: state.players.length});
      emit({type: "calibration_done"});
      setStatus(`Party Mode：${state.players.length} 顆握力球，每顆射自己的鴨子。`, "ready");
    } catch (error) {
      if (error.name !== "NotFoundError") console.error(error);
      setStatus("尚未連接握力球，請再試一次。", "error");
    }
  }

  function installUi() {
    const style = document.createElement("style");
    style.textContent = "#gripball-webhid{position:fixed;z-index:99999;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;background:#111d;color:#fff;font:14px system-ui;box-shadow:0 4px 18px #0008}#gripball-connect{border:0;border-radius:7px;padding:8px 13px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gripball-status[data-kind=error]{color:#ff9999}#gripball-status[data-kind=ready]{color:#a8f0ae}";
    document.head.appendChild(style);
    const panel = document.createElement("div");
    panel.id = "gripball-webhid";
    panel.innerHTML = '<button id="gripball-connect">連接握力球</button><span id="gripball-status">請使用 Chrome／Edge，連接一顆或多顆握力球。</span>';
    document.body.appendChild(panel);
    document.getElementById("gripball-connect").addEventListener("click", connect);
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
      // Party Mode does not use auto-aim proximity haptics.
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi);
  else installUi();
})();
