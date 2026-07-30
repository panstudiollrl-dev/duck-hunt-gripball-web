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
  // After a squeeze the sensor does not snap back - it creeps down over seconds. Demanding
  // a flat reading can therefore never be satisfied, which is what used to time the whole
  // calibration out. So: accept a reading that is still drifting as long as it is drifting
  // DOWNWARDS and slowly, and treat "settling" as a soft goal with a fallback rather than
  // a hard gate.
  const REST_SETTLE_TOLERANCE = 70;   // loosened window used once we are past REST_PATIENT_MS
  const REST_PATIENT_MS = 2600;       // after this long, stop demanding a dead-flat reading
  // A downward drift no steeper than this (per half-window, ~375ms) counts as settled.
  // Kept small: accepting a fast decay means recording a baseline well above true rest,
  // which makes every later press read weaker and fails calibration a different way.
  const REST_DECAY_MAX = 12;
  // Hard ceiling on how long a capture waits. A hard squeeze on a creepy sensor can take
  // 25s+ for the trend to flatten, which is far longer than anyone will hold still for.
  // Past this point, any downward drift is accepted and autoZeroDown() cleans up the rest.
  const REST_GIVE_UP_MS = 5000;
  const REST_MIN_SAMPLES = 12;        // enough to take a median from
  // "Released" means the reading has come back to within this much of the baseline. Pan
  // measured the real settling point at roughly a thousand counts above baseline, so this
  // allowance is deliberately generous - waiting for closer is waiting out creep that takes
  // many seconds.
  //
  // It is a cold-start value only, used before any press has been measured. It cannot be a
  // permanent floor: the bars have to satisfy
  //
  //     release bar  <  press bar  <=  what the ball can actually produce
  //
  // and a hard floor of 1000 forces the press bar to ~1600, which a ball whose full squeeze
  // reads 1400 can never clear - calibration would become impossible instead of merely slow.
  // So once a press has been measured the ratios take over and this value steps aside.
  const REST_RELEASE_MIN = 1000;
  const REST_RELEASE_RATIO = 0.55;
  // A press must clear this fraction of what the ball has been seen to produce. Sits above
  // REST_RELEASE_RATIO with margin, so a released-but-still-creeping ball cannot pass the
  // press check on residual alone.
  const CALIBRATION_PRESS_RATIO = 0.8;

  const SHAKE_REST_MS = 900;
  const SHAKE_SAMPLE_MS = 2500;
  const SHAKE_FIRE_RATIO = 0.45;
  const SHAKE_RELEASE_RATIO = 0.22;
  const SHAKE_MIN_RANGE = 0.15;

  const MAX_PLAYERS = 8;
  const KEYBOARD_PLAYER_COUNT = 2;
  const KEYBOARD_CONTROLS = {
    KeyA: {player: 0, action: "track"},
    KeyS: {player: 0, action: "shoot"},
    KeyK: {player: 1, action: "track"},
    KeyL: {player: 1, action: "shoot"},
  };

  const TUNING_KEY = "gripball-tuning-v2";
  const HUD_KEY = "gripball-hud-hidden";
  const TUNING_DEFAULTS = {
    engageForce: 60,
    releaseForce: 25,
    fullForce: 400,
    fireAccel: 26,
    cooldownMs: 1150,
    hapticPower: 95,
    hapticMs: 90,
  };
  const TUNING_FIELDS = [
    {key: "engageForce", label: "追蹤啟動", unit: "力", min: 5, max: 900, step: 5},
    {key: "releaseForce", label: "追蹤放開", unit: "力", min: 2, max: 900, step: 5},
    {key: "fullForce", label: "追蹤全速", unit: "力", min: 40, max: 4000, step: 20},
    {key: "fireAccel", label: "甩動開槍", unit: "甩", min: 10, max: 90, step: 0.5},
    {key: "cooldownMs", label: "開槍冷卻", unit: "ms", min: 200, max: 2000, step: 50},
    {key: "hapticPower", label: "震動強度", unit: "", min: 10, max: 100, step: 5},
    {key: "hapticMs", label: "震動長度", unit: "", min: 10, max: 200, step: 5},
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
    keyboardMode: false,
    keyboardHeld: {},
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
    player.hapticIgnoreUntil = performance.now() + Math.max(180, duration * 2 + 120);
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
      zeroLog: [],
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
      keyboard: false,
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
    haptic(player, Math.round(tuning.hapticPower), Math.round(tuning.hapticMs));
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
    if (startButton) startButton.disabled = state.players.length < 1 || state.phase !== "connect" || state.keyboardMode;
    const connectButton = document.getElementById("gripball-connect");
    const keyboardButton = document.getElementById("gripball-keyboard");
    if (connectButton) connectButton.style.display = state.phase === "connect" ? "" : "none";
    if (startButton) startButton.style.display = state.phase === "connect" ? "" : "none";
    if (keyboardButton) keyboardButton.style.display = state.phase === "connect" ? "" : "none";
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

  /**
   * Continuous downward auto-zero, used throughout calibration.
   *
   * A live reading below the baseline is, by definition, a better estimate of rest than the
   * baseline is - so adopt it. This is what makes the whole calibration tolerant of sensor
   * creep: the initial capture is allowed to settle on a value that is still a little high
   * (rather than waiting out a creep that can take ten seconds), and the remaining error is
   * walked off during the moments the player is not pressing.
   *
   * Only ever downward. Moving it up would let a press redefine rest, so the ball would
   * chase the player's grip and no press would ever register.
   */
  function autoZeroDown(player) {
    if (!gripIsLive(player)) return false;
    const log = player.zeroLog;
    log.push(player.grip);
    while (log.length > REST_MIN_SAMPLES) log.shift();
    if (log.length < REST_MIN_SAMPLES) return false;
    const half = Math.floor(log.length / 2);
    const drift = median(log.slice(half)) - median(log.slice(0, half));
    // While the sensor is still creeping down, follow the newest readings: a median over
    // the window lags behind a falling signal, and that lag is exactly the residual error
    // we are trying to remove. Once it has stopped falling, switch to the median so the
    // baseline settles in the middle of the noise band rather than at the bottom of it -
    // tracking the minimum would leave a constant phantom force at rest.
    const falling = drift < -REST_DECAY_MAX;
    const rested = falling ? median(log.slice(half)) : median(log);
    if (!(rested < player.baseline)) return false;
    player.baseline = rested;
    return true;
  }

  /**
   * Settle on a resting value for the sensor.
   *
   * The sensor creeps downward for seconds after being squeezed, so this accepts three
   * different kinds of "settled", loosening as it waits:
   *   1. genuinely flat (the old behaviour, and still the fastest path)
   *   2. within a looser window, once we have been patient a while
   *   3. drifting, but downwards and slowly - i.e. relaxing, not being pressed
   * If none of those happen before the timeout it takes the best estimate it has and
   * carries on. Timing out here used to abort the whole calibration, which is a much worse
   * outcome than a slightly imperfect baseline: play-phase auto-zeroing corrects the
   * baseline anyway, but a failed calibration means starting over.
   */
  async function captureRestBaseline(player, label, progress) {
    const samples = [];
    const start = performance.now();
    let flatSince = 0;
    let lastUi = 0;
    let settled = false;
    while (true) {
      const now = performance.now();
      const waited = now - start;
      if (waited > REST_TIMEOUT_MS) break;
      if (gripIsLive(player)) {
        samples.push(player.grip);
        while (samples.length > REST_FLAT_SAMPLES) samples.shift();
        if (samples.length >= REST_MIN_SAMPLES) {
          const lo = Math.min(...samples);
          const hi = Math.max(...samples);
          const spread = hi - lo;
          // Compare the two halves of the window: a negative step means the reading is
          // relaxing towards rest, which is fine to accept even though it is not flat.
          const half = Math.floor(samples.length / 2);
          const drift = median(samples.slice(half)) - median(samples.slice(0, half));
          const patient = waited >= REST_PATIENT_MS;
          // Two independent conditions, because the fast path alone is unsatisfiable on
          // some balls: raw spread mixes the creep trend together with sensor noise, so a
          // ball noisier than REST_FLAT_TOLERANCE never looks flat no matter how long you
          // wait - which is one of the ways calibration used to hang.
          //
          // The patient path therefore judges the trend (drift) separately from the noise
          // around it, and tolerates a wider noise band. Once the trend is slow, autoZeroDown()
          // takes care of whatever offset remains, so there is no need to wait the creep out.
          const ok =
            spread <= REST_FLAT_TOLERANCE ||
            (patient && Math.abs(drift) <= REST_DECAY_MAX && spread <= REST_SETTLE_TOLERANCE) ||
            (waited >= REST_GIVE_UP_MS && drift <= 0);
          if (ok) {
            if (!flatSince) flatSince = now;
          } else {
            flatSince = 0;
          }
        }
      } else {
        flatSince = 0;
        samples.length = 0;
      }
      if (flatSince && now - flatSince >= REST_FLAT_MS) { settled = true; break; }
      if (now - lastUi > 90) {
        emitCalibration(player, label, progress || 0);
        lastUi = now;
      }
      await sleep(25);
    }
    // Only a total absence of data is still fatal - that means the ball is asleep or
    // disconnected, which no amount of patience fixes.
    if (samples.length < REST_MIN_SAMPLES) {
      throw new Error(
        `P${player.playerId + 1} 收不到壓力資料，請按一下球喚醒它（raw ${player.grip == null ? "--" : Math.round(player.grip)}）`
      );
    }
    // Take the newest samples: while the sensor is creeping down, the most recent readings
    // are the closest to true rest. Biasing the baseline slightly low is also the safer
    // error - it makes presses read stronger, and play-phase auto-zeroing pulls it back up.
    const recent = samples.slice(-REST_MIN_SAMPLES);
    player.baseline = median(recent);
    // Noise must be measured on the same short window; over the whole buffer the creep
    // itself would count as noise and inflate the press threshold derived from it.
    player.gripNoise = Math.min(
      CALIBRATION_MAX_PRESS_FORCE / 8,
      medianAbsoluteDeviation(recent, player.baseline)
    );
    player.holding = false;
    player.holdSince = 0;
    player.gripLog.length = 0;
    // Hand the same window to autoZeroDown() so it can act on the very next sample rather
    // than spending another REST_MIN_SAMPLES building up history from scratch.
    player.zeroLog.length = 0;
    player.zeroLog.push(...recent);
    if (!settled) {
      console.warn(
        `P${player.playerId + 1} baseline taken while still drifting ` +
        `(raw ${Math.round(player.baseline)}, noise ${Math.round(player.gripNoise)})`
      );
    }
    return settled;
  }

  /**
   * How far above the baseline still counts as "let go of".
   *
   * Observed on real hardware: after a squeeze the reading settles a long way above the
   * baseline - roughly a thousand counts - and waiting for it to come closer is just waiting
   * out creep that takes many seconds. So the bar for "released" is deliberately generous.
   *
   * The constraint is that it must stay clear of what counts as a press. If the residual a
   * released ball sits at is itself above the press bar, the next round's press check passes
   * the instant it starts and records the residual as the peak. Both bars therefore scale
   * off the same measured press magnitude, so the gap between them is preserved whatever the
   * ball's range turns out to be.
   */
  function releaseForceFor(pressMagnitude) {
    if (!(pressMagnitude > 0)) return REST_RELEASE_MIN;
    // The generous absolute allowance only applies while it still leaves the press bar room
    // underneath the ball's actual range; past that, the ratio governs. Taking the smaller of
    // the two is what keeps the ordering above satisfiable on weak and strong balls alike.
    return Math.min(REST_RELEASE_MIN, pressMagnitude * REST_RELEASE_RATIO);
  }

  /**
   * How much force counts as a press, once we have seen this ball produce one.
   *
   * The noise-derived bar is capped at CALIBRATION_MAX_PRESS_FORCE (220), which is fine as a
   * cold start but far too low for a ball whose full squeeze reads ~1400: a released ball
   * still sitting a thousand counts high would sail past a 220 bar and the round would
   * "pass" on residual creep alone. Scaling the bar to the measured press keeps it
   * comfortably above the released residual, which is what makes the generous release bar
   * safe.
   */
  function pressBarFor(pressMagnitude, fallback) {
    if (!(pressMagnitude > 0)) return fallback;
    // Never ask for more than the ball has been seen to give - a bar above the ball's own
    // range is unreachable by definition.
    const scaled = Math.min(pressMagnitude, pressMagnitude * CALIBRATION_PRESS_RATIO);
    return Math.max(CALIBRATION_MIN_PRESS_FORCE, scaled);
  }

  /**
   * Between press rounds we only need the ball to be let go of - not to be perfectly
   * still. Re-running captureRestBaseline() here was the main reason calibration stalled:
   * it demanded a settled sensor three times over, right after each squeeze, which is
   * exactly when the sensor is least settled.
   *
   * Also tracks the floor the reading reaches, and nudges the baseline down to it. Without
   * that, a baseline captured before the first press drifts stale over three rounds and
   * every later press reads weaker than it was.
   */
  async function waitForRelease(player, label, progress, releaseForce) {
    const start = performance.now();
    let lastUi = 0;
    let belowSince = 0;
    let floor = Infinity;
    let released = false;
    while (performance.now() - start < REST_TIMEOUT_MS) {
      const now = performance.now();
      if (gripIsLive(player)) {
        if (player.grip < floor) floor = player.grip;
        autoZeroDown(player);
        const force = player.grip - player.baseline;
        if (force < releaseForce) {
          if (!belowSince) belowSince = now;
          if (now - belowSince >= 320) { released = true; break; }
        } else {
          belowSince = 0;
        }
      } else {
        belowSince = 0;
      }
      if (now - lastUi > 90) {
        emitCalibration(player, label, progress || 0);
        lastUi = now;
      }
      await sleep(25);
    }
    if (!Number.isFinite(floor)) {
      // No readings at all - leave the baseline alone rather than corrupt it.
    } else if (released) {
      // autoZeroDown() has already tracked the reading down sample by sample, so nothing
      // more is needed here on the happy path.
    } else {
      // Never came back down. The sensor has plateaued above where it started, so that
      // plateau is the new rest - adopt it. Leaving the old baseline in place would mean
      // walking into the next press round already reading a few hundred of "force", which
      // passes the press check instantly and records a garbage peak.
      //
      // The cost of being wrong here is bounded: the press threshold is derived once from
      // the initial rested capture rather than from this value, and play-phase auto-zeroing
      // re-derives the baseline again anyway.
      player.baseline = floor;
      console.warn(
        `P${player.playerId + 1} never released; adopting ${Math.round(floor)} as baseline`
      );
    }
    player.holding = false;
    player.holdSince = 0;
    player.gripLog.length = 0;
    return released;
  }

  async function calibrateShake(player) {
    const restSamples = [];
    const restStart = performance.now();
    let lastUi = 0;
    while (performance.now() - restStart < SHAKE_REST_MS) {
      if (player.accel != null) restSamples.push(player.accel);
      // The ball is being held still and not pressed here, which is the best chance in the
      // whole sequence to shed any baseline error left over from sensor creep.
      autoZeroDown(player);
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

    // Derive the press bar once, from the noise measured on a genuinely rested sensor. It
    // used to be recomputed each round from a baseline captured moments after a squeeze,
    // where sensor creep inflates the noise estimate - so the bar climbed round by round and
    // the player was asked to press ever harder to pass.
    //
    // Round 1 has no measured press to scale from, so it starts from the noise-derived bar.
    // From round 2 on, pressBarFor() rescales both bars off what this ball actually produces.
    let pressMagnitude = 0;
    const pressMagnitudes = [];
    let pressThreshold = Math.min(
      CALIBRATION_MAX_PRESS_FORCE,
      Math.max(CALIBRATION_MIN_PRESS_FORCE, (player.gripNoise || 0) * 8 + 55)
    );
    let resetThreshold = Math.max(35, pressThreshold * 0.58);

    const peaks = [];
    for (let round = 1; round <= CALIBRATION_ROUNDS; round += 1) {
      const baseProgress = (round - 1) / CALIBRATION_ROUNDS * 100;
      // Round 1 follows the initial baseline capture, so the ball is already at rest.
      if (round > 1) {
        pressThreshold = pressBarFor(pressMagnitude, pressThreshold);
        resetThreshold = Math.max(35, pressThreshold * 0.58);
        await waitForRelease(
          player, `RELEASE BEFORE ${round}/${CALIBRATION_ROUNDS}`, baseProgress,
          releaseForceFor(pressMagnitude)
        );
      }
      await haptic(player, 60, 45);
      let holdStart = 0;
      let peak = player.grip || player.baseline;
      let peakForce = 0;
      let lastUi = 0;
      const pressStarted = performance.now();
      let dipStart = 0;
      while (true) {
        const now = performance.now();
        if (now - pressStarted > CALIBRATION_STEP_TIMEOUT_MS) {
          // A round that got most of the way there is worth keeping: the peak is a median
          // over rounds, so one soft round barely moves it, whereas failing the whole
          // calibration costs the player every round they already did.
          if (peakForce >= pressThreshold * 0.6) {
            console.warn(
              `P${player.playerId + 1} round ${round} accepted soft ` +
              `(${Math.round(peakForce)} of ${Math.round(pressThreshold)})`
            );
            break;
          }
          throw new Error(
            `P${player.playerId + 1} 按壓不足（需 ${Math.round(pressThreshold)}，最高 ${Math.round(peakForce)}）`
          );
        }
        autoZeroDown(player);
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
      // Feed the measured press magnitude forward, so later rounds scale both the press and
      // release bars off this ball's real range rather than the cold-start guess. Median of
      // what we have seen, so one unusually soft or hard round does not swing the bars.
      pressMagnitudes.push(peakForce);
      pressMagnitude = median(pressMagnitudes);
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

  async function startKeyboardTest() {
    if (state.phase !== "connect") return;
    await resumeAudioAndFocusCanvas();
    state.keyboardMode = true;
    state.players = [];
    for (let i = 0; i < KEYBOARD_PLAYER_COUNT; i += 1) {
      const player = makePlayer(null, i);
      player.keyboard = true;
      player.tracking = 0;
      player.lastGripAt = Infinity;
      state.players.push(player);
    }
    state.phase = "play";
    state.readyStarted = performance.now();
    emit({type: "player_count", count: state.players.length});
    emit({type: "calibration_done"});
    for (const player of state.players) {
      emit({type: "track_player", player: player.playerId, value: 0});
    }
    setStatus("鍵盤測試：A/S 控 P1，K/L 控 P2。A/K 按住追蹤，S/L 開槍。", "ready");
    refreshUi();
  }

  function handleKeyboard(event, pressed) {
    if (!state.keyboardMode || state.phase !== "play") return;
    const control = KEYBOARD_CONTROLS[event.code];
    if (!control) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (pressed && state.keyboardHeld[event.code]) return;
    state.keyboardHeld[event.code] = pressed;
    const player = state.players[control.player];
    if (!player) return;
    if (control.action === "track") {
      player.tracking = pressed ? 1 : 0;
      player.holding = pressed;
      emit({type: "track_player", player: control.player, value: pressed ? 1 : 0});
      return;
    }
    if (control.action === "shoot" && pressed) {
      const now = performance.now();
      if (now - player.lastShot < 140) return;
      player.lastShot = now;
      emit({type: "shoot_player", player: control.player});
      setStatus(`鍵盤 P${control.player + 1} fired`, "ready");
    }
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

  function setHudHidden(hidden) {
    const panel = document.getElementById("gripball-webhid");
    const dot = document.getElementById("gripball-show");
    if (panel) panel.style.display = hidden ? "none" : "flex";
    if (dot) dot.style.display = hidden ? "block" : "none";
    try {
      window.localStorage.setItem(HUD_KEY, hidden ? "1" : "0");
    } catch (error) {
      console.warn("Could not save HUD state", error);
    }
  }

  function installUi() {
    const style = document.createElement("style");
    style.textContent = "#gripball-webhid{position:fixed;z-index:99999;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;background:#111d;color:#fff;font:14px system-ui;box-shadow:0 4px 18px #0008}#gripball-webhid button{border:0;border-radius:7px;padding:8px 13px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gripball-webhid button:disabled{opacity:.45;cursor:not-allowed}#gripball-status{cursor:pointer}#gripball-webhid button#gripball-keyboard{background:#65c7ff;color:#07121a}#gripball-webhid button#gripball-hide{background:#0000;color:#fff9;font-size:17px;font-weight:400;line-height:1;padding:2px 4px 4px;margin-left:2px}#gripball-webhid button#gripball-hide:hover{color:#fff}#gripball-show{position:fixed;z-index:99999;right:12px;top:12px;display:none;border:0;border-radius:7px;padding:5px 9px;background:#111a;color:#fff9;font:12px system-ui;cursor:pointer}#gripball-status[data-kind=error]{color:#ff9999}#gripball-status[data-kind=ready]{color:#a8f0ae}#gripball-tuning{position:fixed;z-index:99999;left:12px;bottom:12px;font:13px system-ui;color:#fff}#gripball-tuning button{border:0;border-radius:7px;padding:7px 11px;background:#f59b23;color:#15100a;font-weight:700;cursor:pointer}#gt-body{display:none;margin-top:8px;padding:10px 12px;border-radius:10px;background:#111e;box-shadow:0 4px 18px #0008;min-width:270px}#gt-body label{display:flex;align-items:center;gap:8px;margin-bottom:8px}#gt-body label span{width:64px;flex:none}#gt-body label input[type=range]{flex:1;min-width:90px}#gt-body label input[type=number]{width:66px;flex:none;padding:3px 5px;border-radius:5px;border:1px solid #555;background:#222;color:#fff;font:13px system-ui;text-align:right}#gt-body label i{width:22px;flex:none;font-style:normal;opacity:.65}#gt-import,#gt-reset{width:100%;margin-top:5px}#gt-body{min-width:330px}";
    document.head.appendChild(style);
    const panel = document.createElement("div");
    panel.id = "gripball-webhid";
    panel.innerHTML = '<button id="gripball-connect">連接/新增握力球</button><button id="gripball-start" disabled>開始遊戲</button><button id="gripball-keyboard">鍵盤測試</button><span id="gripball-status">先連接所有要玩的握力球，再按開始。</span><button id="gripball-hide" title="隱藏這一列">×</button>';
    document.body.appendChild(panel);
    const dot = document.createElement("button");
    dot.id = "gripball-show";
    dot.textContent = "數值";
    dot.title = "顯示即時數值";
    document.body.appendChild(dot);
    dot.addEventListener("click", () => setHudHidden(false));
    document.getElementById("gripball-hide").addEventListener("click", (event) => {
      event.stopPropagation();
      setHudHidden(true);
    });
    document.getElementById("gripball-status").addEventListener("click", () => setHudHidden(true));
    try {
      setHudHidden(window.localStorage.getItem(HUD_KEY) === "1");
    } catch (error) {
      setHudHidden(false);
    }

    document.getElementById("gripball-connect").addEventListener("click", addDevices);
    document.getElementById("gripball-start").addEventListener("click", startGame);
    document.getElementById("gripball-keyboard").addEventListener("click", startKeyboardTest);
    window.addEventListener("keydown", (event) => handleKeyboard(event, true));
    window.addEventListener("keyup", (event) => handleKeyboard(event, false));
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

  function installDuckSpatialAudio() {
    if (window.duckHuntSpatialAudio) return;

    const SOUND_URLS = {
      quack: "assets/sfx/duck_quack.mp3",
      scream: "assets/sfx/duck_scream.mp3",
      drop_fall: "assets/sfx/drop_fall.mp3",
      drop_hit: "assets/sfx/drop_hit.mp3",
    };
    const buffers = {};
    let ctx = null;
    let master = null;

    // Real measured HRIRs (SADIE-style, 48kHz float32 stereo, 256 taps) convolved per
    // sound, instead of the browser's own generic HRTF panner. Technique from the
    // SonicSquid G07_Binamix prototype (github.com/breampan/SonicSquid); the dataset is
    // this project's own assets/hrir/, which unlike SonicSquid's 72-azimuth set also has
    // elevation. Falls back to PannerNode if the IRs can't be loaded.
    const HRIR_DIR = "assets/hrir/";
    // Convolution scales the signal by the IR's own energy, and these IRs are stored very
    // quietly: their L2 norms run 0.055..0.130 in the front arc (-25..-18 dB), and 0.034 at
    // the very back. A single fixed boost therefore cannot match loudness - it was 1.8,
    // which implicitly assumes a norm of 0.556, so the convolver path came out ~13 dB below
    // the PannerNode path and swung 7.5 dB depending purely on which direction was selected.
    // That is inaudible for a quiet continuous source such as the aim tone.
    //
    // So divide by each IR's measured norm and apply one constant on top. HRIR_MATCH was
    // solved by rendering both paths offline with the same source and matching RMS, which
    // holds within about +-1 dB across the whole front arc. Dividing by the norm scales both
    // channels by the same number, so the measured ILD - the whole point of normalize=false
    // - is preserved exactly.
    const HRIR_MATCH = 0.93;
    // Guards against a pathological IR (an all-but-silent file would otherwise ask for an
    // enormous gain). Nothing in the shipped dataset comes near this.
    const HRIR_MIN_NORM = 0.02;
    const hrirNorms = {};   // filename -> L2 norm, computed once per decoded buffer

    function hrirGainFor(name, buffer) {
      if (!buffer) return HRIR_MATCH;
      let norm = hrirNorms[name];
      if (norm == null) {
        let sum = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
          const data = buffer.getChannelData(ch);
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
        }
        norm = Math.sqrt(sum);
        hrirNorms[name] = norm;
      }
      return HRIR_MATCH / Math.max(norm, HRIR_MIN_NORM);
    }
    const hrir = {
      ready: false,
      failed: false,
      loading: null,
      grid: null,     // ele -> sorted azimuth array
      byKey: null,    // "azi,ele" -> filename
      buffers: {},    // filename -> AudioBuffer (lazily decoded)
      pending: {},    // filename -> Promise
    };

    function getContext() {
      if (!ctx) {
        ctx = window.GodotAudio && window.GodotAudio.ctx
          ? window.GodotAudio.ctx
          : new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.72;
        master.connect(ctx.destination);
        pinListener(ctx);
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    // We may share Godot's AudioContext, and Godot's own audio bus can move the listener.
    // HRTF panning is relative to the listener, so a listener that has been rotated or
    // displaced elsewhere silently skews every duck position. Pin it at the origin facing
    // -Z (the convention connectHrtf's negative z values assume).
    function pinListener(context) {
      const listener = context.listener;
      if (!listener) return;
      const at = context.currentTime;
      const set = (param, value) => {
        if (!param) return false;
        if (typeof param.setValueAtTime === "function") param.setValueAtTime(value, at);
        else param.value = value;
        return true;
      };
      const positional = set(listener.positionX, 0)
        && set(listener.positionY, 0)
        && set(listener.positionZ, 0);
      if (!positional && typeof listener.setPosition === "function") {
        listener.setPosition(0, 0, 0);
      }
      const oriented = set(listener.forwardX, 0)
        && set(listener.forwardY, 0)
        && set(listener.forwardZ, -1)
        && set(listener.upX, 0)
        && set(listener.upY, 1)
        && set(listener.upZ, 0);
      if (!oriented && typeof listener.setOrientation === "function") {
        listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }

    async function loadBuffer(name) {
      if (buffers[name]) return buffers[name];
      const context = getContext();
      const response = await fetch(SOUND_URLS[name]);
      if (!response.ok) throw new Error(`Missing spatial sound ${name}`);
      const data = await response.arrayBuffer();
      buffers[name] = await context.decodeAudioData(data);
      return buffers[name];
    }

    // Only the manifest is fetched up front (~17KB). The IR wavs themselves are pulled in
    // on demand: the full set is 344 files and a duck only ever needs the handful of
    // angles it actually flies through, so preloading all of them would cost far more
    // than it saves.
    function loadHrirIndex() {
      if (hrir.ready || hrir.failed) return Promise.resolve(hrir.ready);
      if (hrir.loading) return hrir.loading;
      hrir.loading = (async () => {
        try {
          const response = await fetch(`${HRIR_DIR}manifest.json`);
          if (!response.ok) throw new Error(`HRIR manifest ${response.status}`);
          const entries = await response.json();
          if (!Array.isArray(entries) || !entries.length) throw new Error("HRIR manifest empty");
          const grid = {};
          const byKey = {};
          for (const entry of entries) {
            if (!entry || typeof entry.azi !== "number" || typeof entry.ele !== "number") continue;
            (grid[entry.ele] = grid[entry.ele] || []).push(entry.azi);
            byKey[`${entry.azi},${entry.ele}`] = entry.name;
          }
          const elevations = Object.keys(grid).map(Number);
          if (!elevations.length) throw new Error("HRIR manifest has no usable entries");
          for (const ele of elevations) grid[ele].sort((a, b) => a - b);
          hrir.grid = grid;
          hrir.elevations = elevations.sort((a, b) => a - b);
          hrir.byKey = byKey;
          hrir.ready = true;
        } catch (error) {
          console.warn("Duck HRIR convolution unavailable, using PannerNode", error);
          hrir.failed = true;
        }
        return hrir.ready;
      })();
      return hrir.loading;
    }

    function nearestIn(values, target) {
      let best = values[0];
      let bestDelta = Infinity;
      for (const value of values) {
        const delta = Math.abs(value - target);
        if (delta < bestDelta) { bestDelta = delta; best = value; }
      }
      return best;
    }

    // Azimuth wraps, so 358 deg is 4 deg away from 2 deg - a plain nearest search would
    // pick something on the wrong side of the head for anything near straight ahead.
    function nearestAzimuth(azimuths, target) {
      let best = azimuths[0];
      let bestDelta = Infinity;
      for (const azi of azimuths) {
        const raw = Math.abs(azi - target);
        const delta = Math.min(raw, 360 - raw);
        if (delta < bestDelta) { bestDelta = delta; best = azi; }
      }
      return best;
    }

    // Dataset convention, verified by measuring the shipped IRs: azimuth increases
    // counter-clockwise, so azi 90 is the LEFT ear (peak arrives 28 samples early on the
    // left, +20dB louder) and azi 270 is the right. A duck on the right of the screen
    // (lateral +1) therefore has to map to 270, not 90.
    function hrirNameFor(vector) {
      if (!hrir.ready) return null;
      const lateral = Math.max(-1, Math.min(1, vector.lateral));
      // Ducks are on a screen in front of the listener, never behind, so the useful arc is
      // the frontal one: straight ahead is 0 and we swing +/-90 deg to the sides.
      const degrees = lateral * 90;
      const azimuth = ((360 - degrees) % 360 + 360) % 360;
      const elevation = Math.max(-90, Math.min(90, vector.vertical * 30));
      const ele = nearestIn(hrir.elevations, elevation);
      const azi = nearestAzimuth(hrir.grid[ele], azimuth);
      return hrir.byKey[`${azi},${ele}`] || null;
    }

    function loadHrirBuffer(name) {
      if (hrir.buffers[name]) return Promise.resolve(hrir.buffers[name]);
      if (hrir.pending[name]) return hrir.pending[name];
      const context = getContext();
      hrir.pending[name] = (async () => {
        try {
          const response = await fetch(HRIR_DIR + name);
          if (!response.ok) throw new Error(`HRIR ${name} ${response.status}`);
          const data = await response.arrayBuffer();
          const buffer = await context.decodeAudioData(data);
          hrir.buffers[name] = buffer;
          return buffer;
        } catch (error) {
          console.warn(`Duck HRIR ${name} failed to load`, error);
          return null;
        } finally {
          delete hrir.pending[name];
        }
      })();
      return hrir.pending[name];
    }

    // x/y are Godot *viewport* coordinates, so the divisor has to be the game's own
    // viewport size (vw/vh, sent by duck.gd). window.innerWidth/Height is a different
    // coordinate space entirely: letterboxing, devicePixelRatio scaling, or a window
    // aspect that differs from the game's design aspect all skew the mapping, which is
    // what made the left/right placement drift. Fall back to the window only when the
    // caller sends no viewport (older pck).
    function sourceVector(x, y, vw, vh) {
      const width = Math.max(1, Number(vw) || window.innerWidth || 1);
      const height = Math.max(1, Number(vh) || window.innerHeight || 1);
      const lateral = Math.max(-1, Math.min(1, (x / width) * 2 - 1));
      const vertical = Math.max(-1, Math.min(1, 1 - (y / height) * 2));
      const front = Math.max(0.18, 0.82 + vertical * 0.20);
      const dist = Math.hypot(lateral * 0.9, vertical * 0.35);
      return {lateral, vertical, front, dist};
    }

    function makeMonoBuffer(input) {
      const context = getContext();
      const inputChannels = Math.max(1, input.numberOfChannels || 1);
      const out = context.createBuffer(1, input.length, input.sampleRate);
      const mono = out.getChannelData(0);
      for (let channel = 0; channel < inputChannels; channel += 1) {
        const data = input.getChannelData(channel);
        for (let i = 0; i < input.length; i += 1) {
          mono[i] += data[i] / inputChannels;
        }
      }
      return out;
    }

    // Air absorption: the further away a sound is, the more high end it loses. Technique
    // from SonicSquid's DraggableSound.airFilter. Distance read poorly when it was carried
    // by volume rolloff alone - a quieter sound is easy to mistake for a different sound,
    // a duller one reads as further away.
    function makeAirFilter(context, vector) {
      const airFilter = context.createBiquadFilter();
      airFilter.type = "lowpass";
      const depth = Math.min(1, vector.dist);
      airFilter.frequency.setValueAtTime(
        Math.max(1200, 16000 - depth * 11000), context.currentTime
      );
      return airFilter;
    }

    function connectHrtf(source, vector, options) {
      const context = getContext();
      const panner = context.createPanner();
      const airFilter = makeAirFilter(context, vector);
      const gain = context.createGain();
      const envelope = context.createGain();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 1;
      panner.maxDistance = 7;
      panner.rolloffFactor = 0.45;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
      const x = vector.lateral * 2.9;
      const y = vector.vertical * 0.85;
      const z = -1.35 - Math.min(1.8, vector.dist * 0.7);
      if (panner.positionX) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
      } else {
        panner.setPosition(x, y, z);
      }
      gain.gain.value = options.gain || 0.88;
      envelope.gain.value = 1;
      source.connect(envelope);
      envelope.connect(airFilter);
      airFilter.connect(panner);
      panner.connect(gain);
      gain.connect(master);
      return envelope;
    }

    // Real-HRIR path. These are one-shot sounds, so a single convolver per sound is
    // enough - the A/B crossfade SonicSquid needs is only for a continuously sounding
    // source that moves between angles mid-playback.
    function connectHrir(source, vector, options, irBuffer, irName) {
      const context = getContext();
      const airFilter = makeAirFilter(context, vector);
      const convolver = context.createConvolver();
      // The IRs already carry the correct interaural level difference; letting the browser
      // normalise them would flatten exactly the cue we came here for.
      convolver.normalize = false;
      convolver.buffer = irBuffer;
      const gain = context.createGain();
      const envelope = context.createGain();
      // A convolver has no distance model of its own, so fold the inverse-square rolloff
      // in by hand, matching the PannerNode path's refDistance 1 / rolloff 0.45.
      const distance = 1 + Math.min(1.8, vector.dist * 0.7);
      const rolloff = 1 / (1 + 0.45 * (distance - 1));
      gain.gain.value = (options.gain || 0.88) * hrirGainFor(irName, irBuffer) * rolloff;
      envelope.gain.value = 1;
      source.connect(envelope);
      envelope.connect(airFilter);
      airFilter.connect(convolver);
      convolver.connect(gain);
      gain.connect(master);
      return envelope;
    }

    // Prefer measured HRIRs; fall back to the browser's HRTF panner whenever the dataset
    // isn't there yet or the angle we want failed to load. Never blocks on the network:
    // if the IR isn't already decoded the sound plays through the panner rather than late.
    function spatialize(source, vector, options) {
      if (hrir.ready) {
        const name = hrirNameFor(vector);
        if (name) {
          const buffer = hrir.buffers[name];
          if (buffer) return connectHrir(source, vector, options, buffer, name);
          loadHrirBuffer(name);
        }
      }
      return connectHrtf(source, vector, options);
    }

    async function play(name, x, y, vw, vh) {
      try {
        const context = getContext();
        const buffer = await loadBuffer(name);
        const vector = sourceVector(Number(x) || 0, Number(y) || 0, vw, vh);
        const options = name === "drop_fall"
          ? {gain: 0.78}
          : {gain: name === "scream" ? 0.92 : name === "drop_hit" ? 0.9 : 0.84};
        const source = context.createBufferSource();
        source.buffer = makeMonoBuffer(buffer);
        const envelope = spatialize(source, vector, options);
        if (name === "drop_fall") {
          source.playbackRate.setValueAtTime(1.55, context.currentTime);
          source.playbackRate.exponentialRampToValueAtTime(0.34, context.currentTime + 0.38);
          envelope.gain.setValueAtTime(1, context.currentTime);
          envelope.gain.linearRampToValueAtTime(0.85, context.currentTime + 0.22);
          envelope.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.55);
          source.stop(context.currentTime + 0.58);
        } else if (name === "scream") {
          source.playbackRate.value = 1.04;
        }
        source.start();
        return true;
      } catch (error) {
        console.warn("Duck HRTF spatial audio failed", error);
        return false;
      }
    }

    // ---------------------------------------------------------------------------------
    // Aim-tracking tone
    //
    // A sustained FM voice per crosshair while the player is tracking a duck: pitch rises
    // as the crosshair closes on the duck (the "getting warmer" cue), the voice is
    // spatialized at the crosshair's own position on screen, and it falls silent at
    // lock-on so that aiming resolves into silence instead of into a held high note.
    //
    // Unlike the one-shot duck sounds, this voice keeps sounding while it moves, so
    // switching IRs under it would click. This is the case that needs the A/B convolver
    // crossfade from SonicSquid's G07_Binamix: two convolvers, the inactive one gets the
    // new IR, then a short equal-power-ish ramp hands over between them.
    // ---------------------------------------------------------------------------------
    const TONE_MIN_HZ = 196;          // G3 when the crosshair is nowhere near the duck
    const TONE_MAX_HZ = 784;          // G5 when it is right on top of it
    // Measured in Chrome against the real graph, not chosen by eye. Two things had to be
    // separated here: the convolver's *loudness* compensation (see hrirGainFor - that one is
    // exact) and the fact that a narrowband source loses far more to an HRIR than a
    // broadband one. These IRs are 256 taps at 48kHz = 5.3ms, which is barely one period at
    // 200Hz, so they carry little low-frequency gain: convolving this tone delivers only
    // 0.073..0.258 of the requested amplitude (median 0.116, i.e. -19dB) across the sweep and
    // the screen. A quack is broadband and loses almost none of it. So the old 0.16 - picked
    // by comparing dry amplitudes - shipped a tone that peaked at 0.033 against the quack's
    // 0.360: 21dB down, which is simply not audible over a game. Retuned by measurement
    // again after TONE_TILT_DB_PER_OCT below flattened the sweep (which by itself made the
    // tone nearly as loud as a quack): this lands the delivered peak around -10..-15dB
    // relative to the quack - clearly present, still plainly a background cue.
    const TONE_PEAK_GAIN = 0.24;      // still deliberately under the game's own sounds
    const TONE_FADE_MS = 90;          // in/out, and the IR handover
    const TONE_GLIDE_MS = 70;         // pitch/volume smoothing between updates
    // The tone drops out once the crosshair is on the duck. Aiming is then a movement
    // *into silence*, which makes the moment of alignment land as an event rather than as
    // "the pitch got a bit higher" - the spatial sweep reads as one brief gesture. The
    // voice itself stays alive and silent, so drifting off brings it straight back.
    //
    // Godot tells us when the crosshair is actually on the duck (`locked`), because only it
    // knows the hitbox. The fade has to *finish* by the time the hitbox is reached, or the
    // tone would still be at full volume the instant it cuts to silence. The game viewport
    // is 256x240 (NES), so the hitbox is a big fraction of the screen: at a ~22px lock
    // radius the fade has to start around 70px out, which is closeness ~0.69. Earlier
    // values here (0.88/0.98) put the whole fade *inside* the hitbox, so in practice the
    // tone jumped straight from full volume to silent and then stayed silent for most of
    // the hold - which is the "can't hear it at all" symptom.
    const TONE_LOCK_START = 0.82;     // starts ducking out here (~41px from the duck)
    const TONE_LOCK_SILENT = 0.90;    // fully silent by here (~23px), i.e. at the hitbox
    const TONE_LOCK_MS = 55;          // fast enough to feel like an event, not a click
    // These IRs are 256 taps at 48kHz - 5.3ms, which is about one period at 190Hz - so they
    // carry very little low-frequency energy. Measured over the front arc, the delivered
    // level of a narrowband source tilts +8.2dB per octave (196Hz: -26dB, 784Hz: -9dB).
    // For this tone that lands in the worst possible place: the low pitch means "far from the
    // duck", so the start of every sweep - the part that has to catch your attention - is
    // ~16dB quieter than the end, and the swell below was making it worse rather than better.
    // So pre-tilt the level by the inverse. This is a property of the IR length, not of the
    // synth, hence the correction lives here and not in the timbres.
    const TONE_TILT_DB_PER_OCT = 8.2;
    const TONE_TILT_REF_HZ = 784;     // full level at the top; correction only ever boosts
    function tiltCompensation(hz) {
      const octaves = Math.log2(Math.max(1, TONE_TILT_REF_HZ) / Math.max(1, hz));
      return Math.pow(10, (TONE_TILT_DB_PER_OCT * octaves) / 20);
    }
    // FM timbres, one per player. Each is a (harmonicity ratio, modulation index) pair -
    // the two numbers that decide an FM voice's character. Party Mode players need to tell
    // their own tone apart from everyone else's while all of them sweep the same pitch
    // range, and timbre separates far better than the detune it replaces: whole different
    // harmonic series rather than the same sound slightly out of tune.
    const TONE_TIMBRES = [
      {ratio: 1, index: 1.6, carrier: "sine"},       // P1: soft, nearly pure, flute-ish
      {ratio: 2, index: 3.2, carrier: "sine"},       // P2: nasal and reedy, clearly brighter
      {ratio: 3.5, index: 2.4, carrier: "sine"},     // P3: inharmonic ratio -> bell/metallic
      {ratio: 0.5, index: 4, carrier: "triangle"},   // P4: hollow, buzzy, sits underneath
    ];
    const voices = new Map();

    function timbreFor(id) {
      const count = TONE_TIMBRES.length;
      const index = ((Math.trunc(id) % count) + count) % count;
      return TONE_TIMBRES[index];
    }

    // 1.0 well away from the duck, 0.0 once it is aimed at. Smoothstep rather than a step,
    // so the drop-out has no corner in it to click on. `locked` (the game's own hit test)
    // forces silence regardless of closeness: the duck's hitbox is bigger than the couple of
    // pixels TONE_LOCK_SILENT works out to, so without it the tone would still be sounding
    // at positions where a shot already hits.
    function lockEnvelope(closeness, locked) {
      if (locked) return 0;
      if (closeness <= TONE_LOCK_START) return 1;
      if (closeness >= TONE_LOCK_SILENT) return 0;
      const t = (closeness - TONE_LOCK_START) / (TONE_LOCK_SILENT - TONE_LOCK_START);
      return 1 - t * t * (3 - 2 * t);
    }

    function makeTrackingVoice(id) {
      const context = getContext();
      // FM: one modulator bending the carrier's frequency. The modulator's own frequency
      // and depth are both kept proportional to the carrier below, which is what holds the
      // timbre steady while the pitch sweeps - a fixed depth in Hz would make the voice
      // change character as it rises.
      const timbre = timbreFor(id);
      const carrier = context.createOscillator();
      const mod = context.createOscillator();
      carrier.type = timbre.carrier;
      mod.type = "sine";
      const modDepth = context.createGain();
      modDepth.gain.value = 0;
      mod.connect(modDepth);
      modDepth.connect(carrier.frequency);

      const tone = context.createGain();
      tone.gain.value = 0;        // silent until the first update fades it in
      const airFilter = context.createBiquadFilter();
      airFilter.type = "lowpass";
      airFilter.frequency.value = 16000;

      carrier.connect(tone);
      tone.connect(airFilter);

      const voice = {
        id, context, timbre, carrier, mod, modDepth, tone, airFilter,
        started: false, stopping: false,
        irName: null, activeConv: "A", convA: null, convB: null, gainA: null, gainB: null,
        panner: null,
      };

      // Pick a spatialization path once, for the voice's whole life: swapping between
      // convolver and panner mid-note would be audible.
      const startingIr = hrir.ready ? hrirNameFor({lateral: 0, vertical: 0, dist: 0}) : null;
      const startingBuffer = startingIr ? hrir.buffers[startingIr] : null;
      if (startingBuffer) {
        voice.convA = context.createConvolver();
        voice.convB = context.createConvolver();
        voice.convA.normalize = false;
        voice.convB.normalize = false;
        voice.convA.buffer = startingBuffer;
        voice.convB.buffer = startingBuffer;
        voice.gainA = context.createGain();
        voice.gainB = context.createGain();
        // The per-IR compensation lives on these two, because it changes with every IR swap
        // and has to move as part of the crossfade. A/B start matched to the first IR.
        voice.gainA.gain.value = hrirGainFor(startingIr, startingBuffer);
        voice.gainB.gain.value = 0;
        voice.irName = startingIr;
        airFilter.connect(voice.convA);
        airFilter.connect(voice.convB);
        voice.convA.connect(voice.gainA);
        voice.convB.connect(voice.gainB);
        voice.gainA.connect(master);
        voice.gainB.connect(master);
      } else {
        voice.panner = context.createPanner();
        voice.panner.panningModel = "HRTF";
        voice.panner.distanceModel = "inverse";
        voice.panner.refDistance = 1;
        voice.panner.maxDistance = 7;
        voice.panner.rolloffFactor = 0.45;
        airFilter.connect(voice.panner);
        voice.panner.connect(master);
        if (hrir.ready && startingIr) loadHrirBuffer(startingIr);
      }
      return voice;
    }

    function setVoicePosition(voice, vector) {
      const context = voice.context;
      const now = context.currentTime;
      if (voice.panner) {
        const x = vector.lateral * 2.9;
        const y = vector.vertical * 0.85;
        const z = -1.35 - Math.min(1.8, vector.dist * 0.7);
        if (voice.panner.positionX) {
          voice.panner.positionX.setTargetAtTime(x, now, 0.02);
          voice.panner.positionY.setTargetAtTime(y, now, 0.02);
          voice.panner.positionZ.setTargetAtTime(z, now, 0.02);
        } else {
          voice.panner.setPosition(x, y, z);
        }
        return;
      }
      const wanted = hrirNameFor(vector);
      if (!wanted || wanted === voice.irName) return;
      const buffer = hrir.buffers[wanted];
      if (!buffer) {
        // Not decoded yet: keep sounding through the IR we already have and fetch this
        // one for next time. Never go quiet mid-note waiting on the network.
        loadHrirBuffer(wanted);
        return;
      }
      const fade = TONE_FADE_MS / 1000;
      const activeGain = voice.activeConv === "A" ? voice.gainA : voice.gainB;
      const idleGain = voice.activeConv === "A" ? voice.gainB : voice.gainA;
      const idleConv = voice.activeConv === "A" ? voice.convB : voice.convA;
      idleConv.buffer = buffer;
      for (const param of [activeGain.gain, idleGain.gain]) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
      }
      // Each IR needs its own compensation, and they differ by up to 7.5dB across the front
      // arc, so the incoming side fades up to ITS gain rather than to 1. Ramping the two
      // sides against each other is also what keeps the swap inaudible - stepping the shared
      // boost node instead would put a level jump in the middle of the crossfade.
      activeGain.gain.linearRampToValueAtTime(0, now + fade);
      idleGain.gain.linearRampToValueAtTime(hrirGainFor(wanted, buffer), now + fade);
      voice.activeConv = voice.activeConv === "A" ? "B" : "A";
      voice.irName = wanted;
    }

    // In Party Mode every player has their own crosshair, so several tracking voices sound
    // at once. Summing them at full level would be both loud and muddy, so share headroom
    // between them. Scaled by 1/sqrt(n) rather than 1/n: equal-power summing keeps the
    // perceived loudness roughly constant without making each individual voice vanish as
    // players join.
    function shareOfGain(count) {
      return 1 / Math.sqrt(Math.max(1, count));
    }

    function updateVoice(voice, closeness, vector, share, locked) {
      const context = voice.context;
      const now = context.currentTime;
      const glide = TONE_GLIDE_MS / 1000;
      // A brand new oscillator sits at the Web Audio default 440Hz, so gliding into the
      // first target would swoop down from A4 every time a press starts a voice - audible,
      // because the gain fades in over the same time constant rather than hiding it. So the
      // first update sets pitch outright and only later ones glide. The gain still fades:
      // that one wants smoothing precisely because it is starting from zero.
      const first = !voice.started;
      if (first) {
        voice.carrier.start();
        voice.mod.start();
        voice.started = true;
      }
      const setPitch = (param, value) => {
        if (first) param.setValueAtTime(value, now);
        else param.setTargetAtTime(value, now, glide);
      };
      // Pitch in semitones rather than Hz, so the rise sounds evenly paced rather than
      // bunched up at the bottom.
      const octaves = Math.log2(TONE_MAX_HZ / TONE_MIN_HZ);
      const hz = TONE_MIN_HZ * Math.pow(2, octaves * Math.max(0, Math.min(1, closeness)));
      setPitch(voice.carrier.frequency, hz);
      // Modulator tracks the carrier so the timbre stays put as the pitch sweeps, and the
      // depth is index * modulator frequency (the standard FM definition of index).
      const modHz = hz * voice.timbre.ratio;
      setPitch(voice.mod.frequency, modHz);
      setPitch(voice.modDepth.gain, modHz * voice.timbre.index);
      // Swell a little as it closes in, so the cue reads even at a glance-level of
      // attention, but never loud enough to fight the quacks - then duck out entirely at
      // lock-on. The lock-out uses its own short time constant: the swell wants to be
      // smooth, but the disappearance wants to be noticeable.
      const lock = lockEnvelope(closeness, locked);
      // Only the convolver path has the low-frequency shortfall; the PannerNode fallback is
      // roughly flat, so compensating there would make a far-away crosshair 16dB too loud.
      const tilt = voice.panner ? 1 : tiltCompensation(hz);
      const level =
        TONE_PEAK_GAIN * tilt * (0.55 + 0.45 * closeness) * (share == null ? 1 : share) * lock;
      voice.tone.gain.setTargetAtTime(
        level, now, lock < 1 ? TONE_LOCK_MS / 1000 : glide
      );
      const depth = Math.min(1, vector.dist);
      voice.airFilter.frequency.setTargetAtTime(
        Math.max(1200, 16000 - depth * 11000), now, glide
      );
      setVoicePosition(voice, vector);
    }

    function stopVoice(voice) {
      if (voice.stopping) return;
      voice.stopping = true;
      const context = voice.context;
      const now = context.currentTime;
      const fade = TONE_FADE_MS / 1000;
      voice.tone.gain.cancelScheduledValues(now);
      voice.tone.gain.setValueAtTime(voice.tone.gain.value, now);
      voice.tone.gain.linearRampToValueAtTime(0, now + fade);
      if (voice.started) {
        voice.carrier.stop(now + fade + 0.02);
        voice.mod.stop(now + fade + 0.02);
      }
    }

    // Called from gripball_input.gd every few frames with the full set of crosshairs that
    // are currently tracking. Anything previously sounding and absent from this list gets
    // faded out, so there is no separate "stop" bookkeeping on the Godot side.
    function syncTracking(payload, vw, vh) {
      try {
        const active = typeof payload === "string" ? JSON.parse(payload) : payload;
        if (!Array.isArray(active)) return false;
        getContext();
        // Locked voices are silent, so they should not take a share of the headroom - with
        // one player locked on, the others would otherwise duck for no audible reason.
        let audible = 0;
        for (const entry of active) {
          if (!entry) continue;
          const near = Math.max(0, Math.min(1, Number(entry.closeness) || 0));
          if (lockEnvelope(near, Boolean(entry.locked)) > 0) audible += 1;
        }
        const share = shareOfGain(audible);
        const seen = new Set();
        for (const entry of active) {
          if (!entry) continue;
          const id = Number(entry.id) || 0;
          const closeness = Math.max(0, Math.min(1, Number(entry.closeness) || 0));
          seen.add(id);
          let voice = voices.get(id);
          if (!voice || voice.stopping) {
            voice = makeTrackingVoice(id);
            voices.set(id, voice);
          }
          const vector = sourceVector(Number(entry.x) || 0, Number(entry.y) || 0, vw, vh);
          updateVoice(voice, closeness, vector, share, Boolean(entry.locked));
        }
        for (const [id, voice] of voices) {
          if (seen.has(id)) continue;
          stopVoice(voice);
          voices.delete(id);
        }
        return true;
      } catch (error) {
        console.warn("Duck tracking tone failed", error);
        return false;
      }
    }

    function stopAllTracking() {
      for (const [id, voice] of voices) {
        stopVoice(voice);
        voices.delete(id);
      }
    }

    // spatialize() never waits on the network, so without this the first few sounds of a
    // session would all fall back to the panner. Warming a coarse arc across the screen
    // (~30 files) means the common angles are already decoded before the first duck is
    // shot; anything in between is pulled in as it comes up.
    async function prewarmHrir() {
      if (!await loadHrirIndex()) return;
      const wanted = new Set();
      for (let i = 0; i <= 10; i += 1) {
        const lateral = -1 + (i / 10) * 2;
        for (const vertical of [0.6, 0, -0.4]) {
          const name = hrirNameFor({lateral, vertical, dist: 0});
          if (name) wanted.add(name);
        }
      }
      await Promise.all([...wanted].map(loadHrirBuffer));
    }

    // debugVoice() is read-only and exists for tone_bench.html, which needs to display the
    // gain/pitch actually reaching the graph rather than recomputing them and possibly
    // agreeing with itself about a bug.
    function debugVoice(id) {
      const voice = voices.get(Number(id) || 0);
      if (!voice) return null;
      return {
        hz: voice.carrier.frequency.value,
        gain: voice.tone.gain.value,
        irName: voice.irName,
        spatializer: voice.panner ? "panner" : "convolver",
      };
    }

    // Browsers only start an AudioContext from inside a user gesture, and ctx.resume() is
    // async - a caller that kicks off audio from a later frame gets a context that stays
    // suspended, which looks exactly like a broken graph (correct gain, no sound). Callers
    // that own the gesture (tone_bench.html) await this from the click handler itself.
    async function resumeAudio() {
      const context = getContext();
      if (context.state === "suspended") {
        try { await context.resume(); } catch (error) {
          console.warn("Could not resume audio", error);
        }
      }
      return {state: context.state, sampleRate: context.sampleRate};
    }

    // A real measurement of what is reaching the destination. Every scheduled-parameter
    // readout can look perfect while the output is silent - a suspended context, a listener
    // pinned somewhere odd, a convolver with an empty buffer, an output device that is not
    // the one being listened to. Only sampling the signal distinguishes those.
    let meter = null;
    function measureOutput() {
      const context = getContext();
      if (!meter) {
        meter = context.createAnalyser();
        meter.fftSize = 2048;
        // Taps master without consuming it: an AnalyserNode passes audio through, and
        // nothing is connected to its output, so this does not alter what is heard.
        master.connect(meter);
        meter.buffer = new Float32Array(meter.fftSize);
      }
      meter.getFloatTimeDomainData(meter.buffer);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < meter.buffer.length; i += 1) {
        const s = meter.buffer[i];
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / meter.buffer.length);
      return {
        state: context.state,
        peak, rms,
        db: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
        masterGain: master ? master.gain.value : null,
        destination: context.destination ? context.destination.channelCount : null,
        sinkId: typeof context.sinkId === "string" ? context.sinkId : "(default)",
        sharedWithGodot: Boolean(window.GodotAudio && window.GodotAudio.ctx === context),
        voices: voices.size,
      };
    }

    window.duckHuntSpatialAudio = {
      play, syncTracking, stopAllTracking, debugVoice, resumeAudio, measureOutput,
    };

    // Needs a live AudioContext to decode into, so it can only run after a user gesture.
    // Kick it off on the first interaction and let it finish in the background.
    const warmOnGesture = () => {
      window.removeEventListener("pointerdown", warmOnGesture);
      window.removeEventListener("keydown", warmOnGesture);
      prewarmHrir().catch((error) => console.warn("Duck HRIR prewarm failed", error));
    };
    window.addEventListener("pointerdown", warmOnGesture);
    window.addEventListener("keydown", warmOnGesture);
  }

  installDuckSpatialAudio();

  window.gripballBridge = {
    poll() {
      const now = performance.now();
      if (state.phase === "play") {
        for (const player of state.players) {
          if (!player.keyboard && player.tracking > 0 && now - player.lastGripAt > GRIP_STALE_MS) {
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
            state.keyboardMode ? "鍵盤測試：A/S 控 P1，K/L 控 P2。A/K 按住追蹤，S/L 開槍。" : state.players.map((player) => {
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
