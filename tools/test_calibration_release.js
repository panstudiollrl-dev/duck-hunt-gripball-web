#!/usr/bin/env node
/**
 * Calibration release/settle test.
 *
 * Pulls the real captureRestBaseline() and waitForRelease() out of gripball_webhid.js and
 * drives them with simulated sensor traces - including the one that used to break
 * calibration: after a squeeze the sensor does not snap back, it creeps down over several
 * seconds, so a "reading must be flat" gate can never be satisfied and the whole
 * calibration times out and aborts.
 *
 * The clock and sleep() are faked, so a 20s timeout costs microseconds here.
 *
 * Usage: node tools/test_calibration_release.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "gripball_webhid.js"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error("could not find " + label);
  return m[0];
}
function constant(name) {
  const m = src.match(new RegExp("const " + name + " = (-?[\\d.]+);"));
  if (!m) throw new Error("could not find constant " + name);
  return Number(m[1]);
}

const CONSTANTS = [
  "GRIP_STALE_MS", "REST_FLAT_MS", "REST_FLAT_SAMPLES", "REST_FLAT_TOLERANCE",
  "REST_TIMEOUT_MS", "REST_SETTLE_TOLERANCE", "REST_PATIENT_MS", "REST_DECAY_MAX",
  "REST_GIVE_UP_MS",
  "REST_MIN_SAMPLES", "CALIBRATION_MAX_PRESS_FORCE", "CALIBRATION_MIN_PRESS_FORCE",
  "REST_RELEASE_MIN", "REST_RELEASE_RATIO", "CALIBRATION_PRESS_RATIO",
];

const pieces = [
  grab(/function median\(values\) \{[\s\S]*?\n  \}/, "median"),
  grab(/function medianAbsoluteDeviation\(values, center\) \{[\s\S]*?\n  \}/, "medianAbsoluteDeviation"),
  grab(/function gripIsLive\(player\) \{[\s\S]*?\n  \}/, "gripIsLive"),
  grab(/function autoZeroDown\(player\) \{[\s\S]*?\n  \}/, "autoZeroDown"),
  grab(/function releaseForceFor\(pressMagnitude\) \{[\s\S]*?\n  \}/, "releaseForceFor"),
  grab(/function pressBarFor\(pressMagnitude, fallback\) \{[\s\S]*?\n  \}/, "pressBarFor"),
  grab(/async function captureRestBaseline\(player, label, progress\) \{[\s\S]*?\n  \}/, "captureRestBaseline"),
  grab(/async function waitForRelease\(player, label, progress, releaseForce\) \{[\s\S]*?\n  \}/, "waitForRelease"),
];

// The pre-fix settle gate, kept verbatim, so the regression it caused stays demonstrable
// rather than merely asserted in a comment.
const OLD_CAPTURE = `
  async function oldCaptureRestBaseline(player) {
    const samples = [];
    const start = performance.now();
    let flatSince = 0;
    while (true) {
      const now = performance.now();
      if (now - start > REST_TIMEOUT_MS) throw new Error("靜置讀數抓不穩");
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
      await sleep(25);
    }
    player.baseline = median(samples);
  }
`;

// Fake clock. sleep() advances virtual time and asks the active trace for the next reading.
const harness = `
  ${CONSTANTS.map((c) => `const ${c} = ${constant(c)};`).join("\n  ")}
  let clock = 0;
  let trace = null;
  const warnings = [];
  const performance = {now: () => clock};
  const console = {warn(message) { warnings.push(message); }};
  function sleep(ms) {
    clock += ms;
    if (trace) trace(clock);
    return Promise.resolve();
  }
  function emitCalibration() {}
  ${pieces.join("\n")}
  ${OLD_CAPTURE}
  return {
    captureRestBaseline, waitForRelease, oldCaptureRestBaseline, autoZeroDown,
    releaseForceFor, pressBarFor,
    setTrace(fn) { trace = fn; },
    now: () => clock,
    warnings: () => warnings.slice(),
    reset() { clock = 0; trace = null; warnings.length = 0; },
  };
`;
const mod = new Function(harness)();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const REST = 500;

// Every grip-related field makePlayer() initialises. Checked against the real makePlayer()
// below, so a new field cannot silently be missing from the fixtures here - which is how a
// crash in autoZeroDown() slipped in once already.
const GRIP_FIELDS = ["grip", "baseline", "gripLog", "zeroLog", "gripNoise", "lastGripAt",
                     "holding", "holdSince"];
{
  const body = grab(/function makePlayer\(device, playerId\) \{[\s\S]*?\n  \}/, "makePlayer");
  const missing = GRIP_FIELDS.filter((f) => !new RegExp(`\\b${f}:`).test(body));
  if (missing.length) {
    throw new Error("fixture is out of date; makePlayer() no longer sets: " + missing.join(", "));
  }
  const declared = body.match(/^\s{6}(\w+):/gm).map((m) => m.trim().replace(":", ""));
  // Narrow enough to skip the shake-detection fields (fireThreshold, fireRelease...), which
  // this test does not exercise.
  const unknown = declared.filter(
    (f) => /^(grip|baseline|zero|holding|holdSince)/i.test(f) && !GRIP_FIELDS.includes(f)
  );
  if (unknown.length) {
    throw new Error("makePlayer() has new grip-related fields the fixture ignores: " +
                    unknown.join(", "));
  }
}

/** A player whose grip reading is driven by fn(t) -> raw value (null = no data at all). */
function playerDrivenBy(fn, baseline = REST) {
  const player = {
    playerId: 0, grip: null, lastGripAt: 0, baseline,
    gripNoise: 0, holding: true, holdSince: 1, gripLog: [1, 2], zeroLog: [],
  };
  mod.reset();
  const apply = (t) => {
    const value = fn(t);
    if (value == null) return;
    player.grip = value;
    player.lastGripAt = t;   // always fresh, so gripIsLive() is true
  };
  apply(0);
  mod.setTrace(apply);
  return player;
}

/** Deterministic pseudo-noise, so the test can never flake. */
const wobble = (t, amp) => ((Math.sin(t * 0.37) + Math.sin(t * 1.13)) / 2) * amp;

/**
 * The trace that broke calibration: released at t=0 from a hard squeeze, decaying back
 * towards rest with a ~2.5s time constant. Always moving, never flat.
 */
const creepAfterSqueeze = (t) => REST + 900 * Math.exp(-t / 2500) + wobble(t, 5);

/** A well-behaved ball sitting still. */
const restingSteady = (t) => REST + wobble(t, 6);

/** Squeezed and simply never let go. */
const heldDown = (t) => REST + 700 + wobble(t, 6);

async function main() {
  // The old gate needed 30 consecutive samples (~750ms) to span no more than 24 counts.
  // Two independent things can stop that from ever happening: creep steep enough that
  // 750ms of it spans more than 24, and plain sensor noise wider than 24. Sweep both,
  // because which one bites depends on the ball and on how hard it was squeezed - which is
  // exactly the reported symptom of calibration passing some times and not others.
  console.log("\nThe bug: when the OLD flat-only gate could not be satisfied");
  {
    const CASES = [
      {label: "gentle squeeze, quiet ball", amp: 900, tau: 2500, noise: 5},
      {label: "gentle squeeze, slow creep ", amp: 900, tau: 9000, noise: 5},
      {label: "hard squeeze, slow creep  ", amp: 2600, tau: 9000, noise: 5},
      {label: "hard squeeze, long tail   ", amp: 3200, tau: 12000, noise: 5},
      {label: "noisy ball (noise > 24)   ", amp: 900, tau: 2500, noise: 30},
    ];
    const results = [];
    for (const c of CASES) {
      const trace = (t) => REST + c.amp * Math.exp(-t / c.tau) + wobble(t, c.noise);
      const player = playerDrivenBy(trace);
      let threw = null;
      try { await mod.oldCaptureRestBaseline(player); }
      catch (error) { threw = error; }
      results.push(Object.assign({}, c, {trace, ms: mod.now(), threw: Boolean(threw)}));
      console.log(`       ${c.label} -> ` +
                  (threw ? "TIMED OUT - calibration aborts" : `passed after ${mod.now()}ms`));
    }
    const summary = results
      .map((r) => `${r.label.trim()}:${r.threw ? "timeout" : r.ms}`).join(" | ");
    check("a hard squeeze times the old gate out and aborts the whole calibration",
          results.some((r) => r.threw && r.noise <= 5), summary);
    check("a noisy ball can never satisfy it at all",
          results.find((r) => r.noise > 5).threw, summary);
    check("but a gentle squeeze on a quiet ball passes - hence the intermittency",
          results.some((r) => !r.threw), summary);
    check("and even when it passed it cost seconds, on all four captures per player",
          results.filter((r) => !r.threw).every((r) => r.ms > 3000), summary);
    const oldTimes = results;

    // The capture is deliberately allowed to return while the reading is still a little
    // high - waiting out a slow creep would cost ten seconds per round. What must hold is
    // that it returns promptly, does not throw, and that autoZeroDown() then walks the
    // residual error off. So each case is checked end to end: capture, then a couple of
    // seconds of the player getting ready, and only then is the baseline judged.
    console.log("\nThe fix: every one of those settles, then auto-zeroes to true rest");
    for (const {label, trace, ms: oldMs, threw: oldThrew} of oldTimes) {
      const player = playerDrivenBy(trace);
      let threw = null;
      try { await mod.captureRestBaseline(player, "", 0); }
      catch (error) { threw = error; }
      const settleMs = mod.now();
      const atCapture = player.baseline - REST;
      const name = label.trim();
      check(`${name}: settles without throwing`, !threw, threw && threw.message);
      check(`${name}: no slower than the old gate`,
            settleMs <= (oldThrew ? constant("REST_TIMEOUT_MS") : oldMs),
            `new ${settleMs}ms vs old ${oldThrew ? "timeout" : oldMs + "ms"}`);

      // Two more seconds of readings, as happens while the "PRESS" prompt is up.
      let t = settleMs;
      const advance = (untilMs) => {
        for (; t < untilMs; t += 25) {
          player.grip = trace(t);
          player.lastGripAt = mod.now();   // keep it fresh for gripIsLive()
          mod.autoZeroDown(player);
        }
      };
      advance(settleMs + 2000);

      // What actually decides whether calibration passes is not how close the baseline is
      // to the sensor's eventual rest - while the sensor is still creeping, nothing can be,
      // because it has not got there yet. It is whether an un-pressed ball reads ~zero
      // force. A baseline lagging above the reading makes presses read weaker than they
      // were, which is the "按壓不足" failure; lagging below invents a phantom press.
      const phantom = player.grip - player.baseline;
      check(`${name}: an un-pressed ball reads ~no force`,
            Math.abs(phantom) < constant("CALIBRATION_MIN_PRESS_FORCE") * 0.5,
            `force=${Math.round(phantom)} vs threshold ` +
            `${constant("CALIBRATION_MIN_PRESS_FORCE")}`);
      check(`${name}: baseline tracked downward, never up`,
            player.baseline - REST <= atCapture,
            `${Math.round(atCapture)} -> ${Math.round(player.baseline - REST)}`);
      check(`${name}: baseline never dips below true rest`,
            player.baseline >= REST - 10, "baseline=" + Math.round(player.baseline));

      // Given long enough the baseline stays locked to the signal all the way down. Compare
      // against the trace rather than against REST: on the slowest case the sensor itself
      // has not finished decaying by 45s, so the trace is the only honest reference.
      advance(45000);
      const signal = trace(45000);
      check(`${name}: stays locked to the sensor as the creep dies out`,
            Math.abs(player.baseline - signal) < 20,
            `baseline=${Math.round(player.baseline)} vs signal ${Math.round(signal)}`);
      console.log(`       ${label} -> settled ${settleMs}ms, resting force ` +
                  `${Math.round(phantom)}, baseline ${Math.round(player.baseline)} vs ` +
                  `signal ${Math.round(signal)} at 45s (rest ${REST})`);
    }
  }

  // Pan measured that a released ball settles ~1000 counts above baseline, so the release
  // bar is generous. The hazard that creates: if a released ball's residual is itself above
  // the press bar, round N+1's press check passes instantly on creep and records the
  // residual as the peak. So the two bars must never invert, at any ball range.
  console.log("\nThe release bar never rises to meet the press bar");
  {
    const MIN = constant("REST_RELEASE_MIN");
    check("cold start (no press measured yet) uses the absolute allowance",
          mod.releaseForceFor(0) === MIN, String(mod.releaseForceFor(0)));
    check("...which matches the ~1000 Pan measured on real hardware", MIN >= 800 && MIN <= 1200,
          "REST_RELEASE_MIN=" + MIN);

    // Sweep the whole plausible hardware range, including balls far weaker and far stronger
    // than the one this was tuned on.
    const RANGES = [300, 700, 1400, 2500, 4000, 8000];
    let worstGap = Infinity;
    for (const magnitude of RANGES) {
      const release = mod.releaseForceFor(magnitude);
      const press = mod.pressBarFor(magnitude, constant("CALIBRATION_MAX_PRESS_FORCE"));
      const gap = press / release;
      worstGap = Math.min(worstGap, gap);
      check(`press magnitude ${magnitude}: press bar stays above the release bar`,
            press > release, `press=${Math.round(press)} release=${Math.round(release)}`);
      check(`press magnitude ${magnitude}: a real press still clears the press bar`,
            magnitude >= press, `press=${Math.round(press)} vs squeeze ${magnitude}`);
      console.log(`       squeeze ${String(magnitude).padStart(4)} -> release bar ` +
                  `${String(Math.round(release)).padStart(4)}, press bar ` +
                  `${String(Math.round(press)).padStart(4)} (x${gap.toFixed(2)})`);
    }
    // The floor is the ratio between the two constants; above that range the release bar is
    // pinned to its absolute allowance and the gap only widens.
    const designGap = constant("CALIBRATION_PRESS_RATIO") / constant("REST_RELEASE_RATIO");
    check("the margin between the bars holds across every range",
          worstGap >= designGap - 0.01,
          `worst ratio ${worstGap.toFixed(2)}, design ratio ${designGap.toFixed(2)}`);
    check("and that margin is a real separation, not a rounding accident", designGap >= 1.4,
          "design ratio " + designGap.toFixed(2));
  }

  console.log("\nA released-but-creeping ball cannot pass the press check on residual alone");
  {
    // The exact failure the two-bar scaling exists to prevent: ball released, still sitting
    // high, walking into the next round's press check.
    const MAGNITUDE = 1400;                       // full squeeze
    const release = mod.releaseForceFor(MAGNITUDE);
    const press = mod.pressBarFor(MAGNITUDE, constant("CALIBRATION_MAX_PRESS_FORCE"));
    // Worst case: released exactly at the bar, so the residual is as large as allowed.
    check("the largest residual we call 'released' is still under the press bar",
          release < press, `residual ${Math.round(release)} vs press bar ${Math.round(press)}`);
    check("with the OLD fixed 220 cap it would NOT have been",
          release >= constant("CALIBRATION_MAX_PRESS_FORCE"),
          `residual ${Math.round(release)} vs old cap ${constant("CALIBRATION_MAX_PRESS_FORCE")}`);
    console.log(`       residual ${Math.round(release)} would sail past the old 220 bar, ` +
                `but sits under the scaled bar ${Math.round(press)}`);
  }

  // The reason for the generous bar: with a strict one, waitForRelease() sat there while the
  // sensor crept, and the round did not start until it had crept most of the way back.
  console.log("\nThe generous release bar is what makes the next round start promptly");
  {
    const MAGNITUDE = 1400;
    // Ball released from a full squeeze, creeping back with a realistic time constant.
    const trace = (t) => REST + MAGNITUDE * Math.exp(-t / 4000) + wobble(t, 5);
    const timeToRelease = async (bar) => {
      const player = playerDrivenBy(trace);
      await mod.waitForRelease(player, "", 0, bar);
      return mod.now();
    };
    const strict = await timeToRelease(30);                        // roughly the old bar
    const generous = await timeToRelease(mod.releaseForceFor(MAGNITUDE));
    check("the generous bar clears sooner than a strict one", generous < strict,
          `${generous}ms vs ${strict}ms`);
    check("and it clears fast enough not to stall the sequence", generous < 3000,
          generous + "ms");
    console.log(`       strict bar 30 -> ${strict}ms, ` +
                `bar ${Math.round(mod.releaseForceFor(MAGNITUDE))} -> ${generous}ms ` +
                `(x${(strict / Math.max(1, generous)).toFixed(1)} faster), ` +
                `and this happens twice per player`);
  }

  console.log("\nautoZeroDown only ever moves the baseline down");
  {
    // It needs a full window before it will act, so feed samples rather than one reading.
    const feed = (player, value, n = constant("REST_MIN_SAMPLES")) => {
      let moved = false;
      for (let i = 0; i < n; i += 1) {
        player.grip = value;
        player.lastGripAt = mod.now();
        moved = mod.autoZeroDown(player) || moved;
      }
      return moved;
    };
    const player = playerDrivenBy(restingSteady);
    player.baseline = REST;
    player.zeroLog = [];
    check("a press does not move the baseline", feed(player, REST + 400) === false &&
          player.baseline === REST, "baseline=" + player.baseline);
    check("a lower rest is adopted", feed(player, REST - 30) === true &&
          Math.abs(player.baseline - (REST - 30)) < 1, "baseline=" + player.baseline);
    player.grip = 0;                  // absurdly low, but stale
    player.lastGripAt = mod.now() - constant("GRIP_STALE_MS") - 1;
    check("stale readings are ignored", mod.autoZeroDown(player) === false &&
          Math.abs(player.baseline - (REST - 30)) < 1, "baseline=" + player.baseline);
  }

  console.log("\nautoZeroDown settles in the noise band, not at the bottom of it");
  {
    // A quiet resting ball: the baseline must not drift down to the noise floor, or the
    // sensor would read a constant phantom force and the game would think a grip is held.
    const NOISE = 6;
    const player = playerDrivenBy(restingSteady);
    player.baseline = REST + 200;   // start high, as after a creepy capture
    player.zeroLog = [];
    for (let t = 0; t < 6000; t += 25) {
      player.grip = restingSteady(t);
      player.lastGripAt = mod.now();
      mod.autoZeroDown(player);
    }
    const offset = player.baseline - REST;
    check("converges onto true rest", Math.abs(offset) <= NOISE,
          `baseline=${player.baseline.toFixed(1)} (off by ${offset.toFixed(1)})`);
    check("does not sink to the bottom of the noise band", offset > -NOISE,
          "offset=" + offset.toFixed(1));
  }

  console.log("\nThe creeping capture keeps hold state clean");
  {
    const player = playerDrivenBy(creepAfterSqueeze);
    await mod.captureRestBaseline(player, "", 0);
    check("noise estimate is not inflated by the creep itself",
          player.gripNoise < 40, "noise=" + Math.round(player.gripNoise));
    check("clears stale hold state", player.holding === false && player.gripLog.length === 0);
  }

  console.log("\nA genuinely still ball still takes the fast path (no added latency)");
  {
    const player = playerDrivenBy(restingSteady);
    await mod.captureRestBaseline(player, "", 0);
    check("settles on the flat path, before the patience window",
          mod.now() < constant("REST_PATIENT_MS"), mod.now() + "ms");
    check("baseline lands on the true rest value", Math.abs(player.baseline - REST) < 12,
          "baseline=" + Math.round(player.baseline));
  }

  console.log("\nNoise is measured on a short recent window, so the threshold stays sane");
  {
    const player = playerDrivenBy(creepAfterSqueeze);
    await mod.captureRestBaseline(player, "", 0);
    const threshold = Math.min(
      constant("CALIBRATION_MAX_PRESS_FORCE"),
      Math.max(constant("CALIBRATION_MIN_PRESS_FORCE"), (player.gripNoise || 0) * 8 + 55)
    );
    check("press threshold is not pinned to the 220 ceiling", threshold < 220,
          "threshold=" + Math.round(threshold));
    check("press threshold stays above the noise floor",
          threshold >= constant("CALIBRATION_MIN_PRESS_FORCE"), String(threshold));
    check("gripNoise is capped so it can never pin the threshold",
          player.gripNoise <= constant("CALIBRATION_MAX_PRESS_FORCE") / 8,
          "noise=" + player.gripNoise);
    console.log(`       threshold=${Math.round(threshold)} ` +
                `(ceiling ${constant("CALIBRATION_MAX_PRESS_FORCE")})`);
  }

  console.log("\nNo data at all is still an error (asleep/disconnected ball)");
  {
    const player = playerDrivenBy(() => null);
    player.grip = null;
    let threw = null;
    try { await mod.captureRestBaseline(player, "", 0); }
    catch (error) { threw = error; }
    check("throws when there are no readings", Boolean(threw), threw && threw.message);
    check("the message tells the player to wake the ball",
          threw && /喚醒/.test(threw.message), threw && threw.message);
  }

  console.log("\nStale data is an error too (stream died mid-calibration)");
  {
    // Readings stop arriving after 300ms: grip holds its last value but lastGripAt goes
    // stale, so gripIsLive() turns false and the sample buffer is cleared.
    const player = playerDrivenBy((t) => (t <= 300 ? restingSteady(t) : null));
    let threw = null;
    try { await mod.captureRestBaseline(player, "", 0); }
    catch (error) { threw = error; }
    check("a stream that dies early does not silently yield a baseline", Boolean(threw),
          threw ? threw.message : "baseline=" + player.baseline);
  }

  console.log("\nwaitForRelease: between rounds, only the release matters");
  {
    const player = playerDrivenBy(creepAfterSqueeze);
    const released = await mod.waitForRelease(player, "", 0, 60);
    check("detects the release", released === true);
    check("returns promptly once force drops under the threshold",
          mod.now() < constant("REST_TIMEOUT_MS"), mod.now() + "ms");
    check("baseline is not ratcheted upward", player.baseline <= REST,
          "baseline=" + Math.round(player.baseline));
    console.log(`       released at t=${mod.now()}ms, baseline=${Math.round(player.baseline)}`);
  }

  console.log("\nwaitForRelease: baseline tracks a ball that rests lower than assumed");
  {
    // Ball resting well BELOW the assumed baseline - e.g. the first capture landed high
    // because of creep. The baseline should follow it all the way down, not crawl.
    const LOW = 200;
    const player = playerDrivenBy((t) => LOW + wobble(t, 4), REST);
    await mod.waitForRelease(player, "", 0, 60);
    check("baseline moves down to the true lower rest", Math.abs(player.baseline - LOW) < 10,
          `baseline=${Math.round(player.baseline)} (rest ${LOW})`);
    check("baseline does not overshoot below the readings", player.baseline >= LOW - 10,
          "baseline=" + Math.round(player.baseline));
  }

  console.log("\nwaitForRelease: a ball that is never released cannot poison the next round");
  {
    const player = playerDrivenBy(heldDown);
    const released = await mod.waitForRelease(player, "", 0, 60);
    check("reports that no release happened", released === false);
    const residual = player.grip - player.baseline;
    check("adopts the plateau, so residual force is ~0 rather than a few hundred",
          Math.abs(residual) < 30, "residual=" + Math.round(residual));
    check("says so in the log rather than failing silently",
          mod.warnings().some((w) => /never released/.test(w)), mod.warnings().join(" | "));
    console.log(`       held at ${Math.round(player.grip)}, baseline adopted ` +
                `${Math.round(player.baseline)}, residual ${Math.round(residual)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
