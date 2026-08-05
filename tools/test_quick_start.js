#!/usr/bin/env node
/**
 * No-calibration start test.
 *
 * Pan's decision (2026-07-30): skip calibration entirely and treat "more than a fixed number
 * of counts above the baseline" as on. This drives the real quickStartPlayer() and the real
 * estimateGrip() from gripball_webhid.js against simulated sensor traces.
 *
 * The point of this file is the reachability question, which was the one real risk in the
 * change: the bar is a fixed number, but each ball has its own range, so a bar above what a
 * ball can produce means the grip simply never registers. This file printed that warning for a
 * week and then it happened in play - Pan, 2026-08-05: 有一顆握力球做什麼都沒反應 進不了正式遊戲.
 *
 * So the bar is now per ball (engageForceFor), scaled to the largest press that ball has been
 * seen to produce, and reachability is a hard assertion rather than a printed warning: the ball
 * measured at ~1400 counts (see test_calibration_release.js, MAGNITUDE = 1400) must engage, and
 * so must one at a quarter of that, without a strong ball engaging on a resting hand.
 *
 * The clock and sleep() are faked, so waiting costs microseconds.
 *
 * Usage: node tools/test_quick_start.js
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
/** Reads a TUNING_DEFAULTS entry, which may be an expression rather than a literal. */
function tuningDefault(name) {
  const body = grab(/const TUNING_DEFAULTS = \{[\s\S]*?\n  \};/, "TUNING_DEFAULTS");
  const m = body.match(new RegExp(name + ":\\s*([^,\\n]+),"));
  if (!m) throw new Error("could not find TUNING_DEFAULTS." + name);
  return new Function(
    `const QUICK_ENGAGE_FORCE = ${constant("QUICK_ENGAGE_FORCE")};` +
    `const QUICK_RELEASE_RATIO = ${constant("QUICK_RELEASE_RATIO")};` +
    `return (${m[1]});`
  )();
}

const CONSTANTS = [
  "GRIP_STALE_MS", "AUTOZERO_WINDOW_MS",
  "QUICK_ENGAGE_FORCE", "QUICK_RELEASE_RATIO", "QUICK_BASELINE_MS", "QUICK_WAKE_MS",
  "ADAPTIVE_ENGAGE_RATIO", "ADAPTIVE_ENGAGE_FLOOR",
];

const pieces = [
  grab(/function median\(values\) \{[\s\S]*?\n  \}/, "median"),
  grab(/function gripIsLive\(player\) \{[\s\S]*?\n  \}/, "gripIsLive"),
  grab(/function engageForceFor\(player\) \{[\s\S]*?\n  \}/, "engageForceFor"),
  grab(/function estimateGrip\(player, grip\) \{[\s\S]*?\n  \}/, "estimateGrip"),
  grab(/async function quickStartPlayer\(player\) \{[\s\S]*?\n  \}/, "quickStartPlayer"),
];

// The weakest ball's first press has to clear the cold-start bar, and that press is at most its
// own full squeeze. Expressed as a fraction so the assertion below states the requirement rather
// than a magic number: a bar over ~45% of a 1400-count ball's range is asking for most of it.
const ADAPTIVE_RATIO_FLOOR_CHECK = 0.45;

const ENGAGE = tuningDefault("engageForce");
const RELEASE = tuningDefault("releaseForce");
const FULL = tuningDefault("fullForce");

const harness = `
  ${CONSTANTS.map((c) => `const ${c} = ${constant(c)};`).join("\n  ")}
  let clock = 0;
  let trace = null;
  const emitted = [];
  const performance = {now: () => clock};
  const console = {warn() {}};
  const tuning = {engageForce: ${ENGAGE}, releaseForce: ${RELEASE}, fullForce: ${FULL}};
  const state = {phase: "play", players: []};
  function sleep(ms) {
    clock += ms;
    if (trace) trace(clock);
    return Promise.resolve();
  }
  function emitCalibration(player, text, progress, peak) {
    emitted.push({text, progress, peak});
  }
  function emit(message) { emitted.push(message); }
  ${pieces.join("\n")}
  return {
    quickStartPlayer, estimateGrip, engageForceFor, tuning, state,
    setTrace(fn) { trace = fn; },
    now: () => clock,
    advance(ms) { clock += ms; },
    emitted: () => emitted.slice(),
    setPhase(p) { state.phase = p; },
    reset() { clock = 0; trace = null; emitted.length = 0; state.phase = "play"; },
  };
`;
const mod = new Function(harness)();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const REST = 500;
const wobble = (t, amp) => ((Math.sin(t * 0.37) + Math.sin(t * 1.13)) / 2) * amp;

/** Every field makePlayer() sets that the code under test touches. */
function makeFixture() {
  return {
    playerId: 0, grip: null, baseline: null, peak: null, travel: 900, tracking: -1,
    holding: false, holdSince: 0, gripLog: [], zeroLog: [], gripNoise: 0, lastGripAt: 0,
    pressPeak: 0, proven: false,
  };
}

/** A player whose reading is driven by fn(t) -> raw value (null = no data at all). */
function playerDrivenBy(fn) {
  const player = makeFixture();
  mod.reset();
  const apply = (t) => {
    const value = fn(t);
    if (value == null) return;
    player.grip = value;
    player.lastGripAt = t;
  };
  apply(0);
  mod.setTrace(apply);
  return player;
}

/** Feed a raw reading through the real estimateGrip() and report whether it is "on". */
function press(player, raw) {
  player.lastGripAt = mod.now();
  mod.estimateGrip(player, raw);
  return player.holding;
}

// Guard the fixture against drift in makePlayer(), the way test_calibration_release.js does:
// a field appearing there but missing here is how a crash slips into a passing test.
{
  const body = grab(/function makePlayer\(device, playerId\) \{[\s\S]*?\n  \}/, "makePlayer");
  const needed = ["grip", "baseline", "gripLog", "zeroLog", "holding", "holdSince",
                  "lastGripAt", "travel", "tracking", "peak", "pressPeak", "proven"];
  const missing = needed.filter((f) => !new RegExp(`\\b${f}:`).test(body));
  if (missing.length) {
    throw new Error("fixture out of date; makePlayer() no longer sets: " + missing.join(", "));
  }
}

async function main() {
  console.log("\nThe bars are consistent with each other at whatever threshold is chosen");
  {
    console.log(`       engage ${ENGAGE}, release ${RELEASE}, full ${FULL}`);
    // These are bugs at ANY threshold, so they are hard assertions.
    check("release sits below engage, so a held grip cannot chatter off",
          RELEASE < ENGAGE, `${RELEASE} vs ${ENGAGE}`);
    check("release is not so far below engage that a let-go reads as held",
          RELEASE > ENGAGE * 0.25, `${RELEASE} vs engage ${ENGAGE}`);
    check("full-speed force is above the engage bar",
          FULL > ENGAGE, `full ${FULL} vs engage ${ENGAGE}`);
    // estimateGrip() clamps release to engage * 0.9; if the default were above that the
    // configured value would be silently ignored, which is worse than being wrong.
    check("the configured release bar is not silently clamped away",
          RELEASE <= ENGAGE * 0.9, `${RELEASE} vs cap ${ENGAGE * 0.9}`);
  }

  console.log("\nquickStartPlayer takes a baseline and nothing else");
  {
    const player = playerDrivenBy((t) => REST + wobble(t, 6));
    await mod.quickStartPlayer(player);
    check("baseline lands on the resting value", Math.abs(player.baseline - REST) < 12,
          `baseline=${Math.round(player.baseline)} (rest ${REST})`);
    check("it is quick - no three rounds of pressing", mod.now() < 2000,
          mod.now() + "ms");
    check("travel falls back to the tuning value rather than being measured",
          player.travel === FULL, String(player.travel));
    check("no peak is recorded, because nothing was pressed", player.peak === null,
          String(player.peak));
    check("tracking is armed for the first real reading", player.tracking === -1);
    check("it reports READY so the HUD does not look stuck",
          mod.emitted().some((e) => e.text === "READY"),
          JSON.stringify(mod.emitted().slice(-2)));
  }

  console.log("\nIt never fails on a bad reading - only on no reading at all");
  {
    // Still creeping down from a squeeze: an imperfect moment to sample, which is exactly why
    // the old calibration stalled here. This path must accept it and move on.
    const player = playerDrivenBy((t) => REST + 900 * Math.exp(-t / 2500) + wobble(t, 5));
    let threw = null;
    try { await mod.quickStartPlayer(player); } catch (error) { threw = error; }
    check("a still-creeping sensor does not stall or throw", !threw,
          threw && threw.message);
    check("...and yields a usable, if high, baseline", player.baseline > REST,
          `baseline=${Math.round(player.baseline)}`);
    // The residual error is why this is acceptable: it is walked off in play by the auto-zero
    // in estimateGrip(), so a rough start is self-correcting.
    console.log(`       baseline ${Math.round(player.baseline)} vs true rest ${REST} ` +
                `(error ${Math.round(player.baseline - REST)}, corrected in play)`);

    const dead = playerDrivenBy(() => null);
    let deadThrew = null;
    try { await mod.quickStartPlayer(dead); } catch (error) { deadThrew = error; }
    check("a ball sending nothing at all is reported", Boolean(deadThrew),
          String(deadThrew && deadThrew.message));
    check("...and says to press the ball to wake it",
          deadThrew && /喚醒/.test(deadThrew.message), deadThrew && deadThrew.message);
    check("it gives up waiting rather than hanging forever",
          mod.now() >= constant("QUICK_WAKE_MS") && mod.now() < constant("QUICK_WAKE_MS") * 1.5,
          mod.now() + "ms");
  }

  console.log("\nCrossing the bar turns tracking on, and hysteresis keeps it steady");
  {
    const player = playerDrivenBy((t) => REST + wobble(t, 4));
    await mod.quickStartPlayer(player);
    const base = player.baseline;
    mod.setTrace(null);   // drive estimateGrip() by hand from here

    // Read the bar off the code rather than assuming the configured number: it is now per ball,
    // and a fresh ball with no press history is deliberately held at the floor so that even the
    // weakest ball's first press can register (that press is the only evidence of its range).
    const bar = mod.engageForceFor(player);
    console.log(`       a ball with no press history uses a bar of ${Math.round(bar)} ` +
                `(configured ceiling ${ENGAGE})`);
    check("a fresh ball's bar is low enough for a weak ball's first press",
          bar <= 1400 * ADAPTIVE_RATIO_FLOOR_CHECK, `${Math.round(bar)}`);
    check("resting is off", press(player, base) === false);
    check("just under the bar is still off", press(player, base + bar - 1) === false,
          `force ${Math.round(bar - 1)} vs bar ${Math.round(bar)}`);
    check("reaching the bar turns it on", press(player, base + bar) === true);
    // Hysteresis: between the two bars it must stay on, or a hand holding steady near the
    // threshold would flicker the crosshair. The release bar is a fraction of the bar in use,
    // not of the configured one - on a scaled-down bar the configured release value can sit
    // ABOVE the engage bar, which would release the instant it engaged.
    const release = Math.min(RELEASE, bar * constant("QUICK_RELEASE_RATIO"), bar * 0.9);
    check("the release bar is below the bar actually in use",
          release < bar, `release ${Math.round(release)} vs bar ${Math.round(bar)}`);
    const mid = Math.round((bar + release) / 2);
    check("easing off but staying above the release bar keeps it on",
          press(player, base + mid) === true, `force ${mid}`);
    check("dropping below the release bar turns it off",
          press(player, base + release - 1) === false, `force ${Math.round(release - 1)}`);
    // Against the CURRENT baseline, not the one recorded before the release: sitting at rest is
    // exactly when the auto-zero drift runs, so a few counts of movement here is the drift
    // working, not the bar failing.
    check("and it can be turned on again",
          press(player, player.baseline + mod.engageForceFor(player)) === true);
  }

  console.log("\nA slow squeeze is not penalised by the resting auto-zero");
  {
    // The bug this section exists for. The play-phase drift pulls the baseline towards the
    // current reading while not holding; if it runs for anything below the engage bar, then
    // approaching a bar of thousands slowly makes the bar retreat, because every sample spent
    // below it raises "rest". Measured before the fix: a 1.5s squeeze towards 3000 had to
    // reach ~3579 counts, and a 3s one ~4019.
    // Ramp from rest up to 1.3x the bar over `seconds` at ~60Hz, and report the force the
    // player actually had to produce to engage. With no drift that is the bar itself.
    const squeezeOver = async (seconds) => {
      const player = playerDrivenBy((t) => REST + wobble(t, 4));
      await mod.quickStartPlayer(player);
      const base = player.baseline;
      mod.setTrace(null);
      const samples = Math.max(1, Math.round(seconds * 60));
      const top = ENGAGE * 1.3;
      for (let i = 1; i <= samples; i += 1) {
        mod.advance(1000 / 60);              // a real ramp in time, not one instant
        const force = (top * i) / samples;
        if (press(player, base + force)) {
          return {on: true, needed: force, drift: player.baseline - base};
        }
      }
      return {on: false, needed: null, drift: player.baseline - base};
    };

    for (const seconds of [0.15, 0.6, 1.5, 3]) {
      const {on, needed, drift} = await squeezeOver(seconds);
      console.log(`       ${seconds}s ramp: ${on ? "engaged once force reached " + Math.round(needed) : "NEVER engaged"}` +
                  ` (bar ${ENGAGE}), baseline drifted ${drift >= 0 ? "+" : ""}${Math.round(drift)}`);
      check(`a ${seconds}s squeeze does engage`, on,
            on ? "" : "never crossed even at 1.3x the bar");
      // The real property: approaching slowly must not cost extra force. Before the fix a 3s
      // ramp needed ~4019 counts against a 3000 bar; anything beyond a few percent means the
      // baseline is chasing the hand again.
      check(`...without needing meaningfully more force than the bar (${seconds}s)`,
            on && needed < ENGAGE * 1.05,
            on ? `needed ${Math.round(needed)} vs bar ${ENGAGE}` : "did not engage");
    }
  }

  console.log("\nThe auto-zero still works when the ball really is at rest");
  {
    // The fix must not disable creep correction, which is the whole reason a rough start-up
    // baseline is acceptable. A ball sitting a little above the recorded rest must be walked
    // back down.
    const player = playerDrivenBy((t) => REST + wobble(t, 4));
    await mod.quickStartPlayer(player);
    mod.setTrace(null);
    const stale = player.baseline - 60;      // pretend rest was recorded 60 counts too low
    player.baseline = stale;
    for (let i = 0; i < 600; i += 1) press(player, REST);
    check("a baseline recorded below true rest is corrected upwards",
          player.baseline > stale + 30, `${Math.round(stale)} -> ${Math.round(player.baseline)}`);
    check("...and settles at rest rather than overshooting",
          Math.abs(player.baseline - REST) < 20, String(Math.round(player.baseline)));
    console.log(`       ${Math.round(stale)} -> ${Math.round(player.baseline)} (true rest ${REST})`);
  }

  console.log("\nTracking strength spans the range instead of pinning at full");
  {
    const player = playerDrivenBy((t) => REST + wobble(t, 4));
    await mod.quickStartPlayer(player);
    const base = player.baseline;
    mod.setTrace(null);
    const strengthAt = (force) => {
      press(player, base + force);
      return player.tracking;
    };
    const atEngage = strengthAt(ENGAGE);
    const atFull = strengthAt(FULL);
    console.log(`       strength at engage ${atEngage.toFixed(2)}, at full ${atFull.toFixed(2)}`);
    check("engaging does not immediately mean full speed", atEngage < 0.95,
          String(atEngage));
    check("squeezing harder tracks faster", atFull > atEngage,
          `${atEngage.toFixed(2)} -> ${atFull.toFixed(2)}`);
    check("full force reaches the top of the range", atFull > 0.95, String(atFull));
  }

  console.log("\nREACHABILITY: every ball must be able to turn its own grip on");
  {
    // This is the section that used to print a warning instead of failing, and the thing it
    // warned about is what Pan hit: 有一顆握力球做什麼都沒反應 進不了正式遊戲. A ball that cannot
    // engage cannot track, cannot shoot, and (before the intro-screen fix) took the whole game
    // down with it. So it is asserted now, across a range of hardware, not printed.
    //
    // The three squeezes below are: the one ball actually measured (~1400 counts, in step with
    // test_calibration_release.js), a much weaker one, and one strong enough to reach the
    // configured bar. All three must work with no per-device configuration.
    const squeezeTest = async (fullSqueeze, label) => {
      const player = playerDrivenBy((t) => REST + wobble(t, 4));
      await mod.quickStartPlayer(player);
      mod.setTrace(null);
      const base = player.baseline;
      // A press at the ball's own maximum, held for a few samples the way a real hand would be.
      // The first press is what teaches the code this ball's range, so what matters is that it
      // engages during that press and not several presses later.
      let engagedOnFirstPress = false;
      for (let i = 0; i < 6; i += 1) {
        mod.advance(16);
        if (press(player, base + fullSqueeze)) { engagedOnFirstPress = true; break; }
      }
      // Releasing must still read as released, or the crosshair would stick on.
      mod.advance(16);
      const releases = press(player, base) === false;
      // And it must engage again on the next press, now that its range is known.
      mod.advance(16);
      const again = press(player, base + fullSqueeze) === true;
      const bar = mod.engageForceFor(player);
      console.log(`       ${label} (full squeeze ${fullSqueeze}): bar settled at ` +
                  `${Math.round(bar)} => ${engagedOnFirstPress ? "engages" : "NEVER ENGAGES"}`);
      check(`a ball topping out at ${fullSqueeze} counts can turn its grip on`,
            engagedOnFirstPress, "never crossed its own bar at full squeeze");
      check(`...and letting go of it reads as released (${fullSqueeze})`, releases);
      check(`...and it engages again on the next press (${fullSqueeze})`, again);
      return {player, bar};
    };

    await squeezeTest(1400, "the measured ball");
    await squeezeTest(350, "a much weaker ball");
    const strong = await squeezeTest(6000, "a ball that can reach the configured bar");
    // The other half of the requirement. Adapting the bar downward must not become "engages on
    // anything": a strong ball's bar has to stay up at the configured one, so the weight of a
    // hand resting on it is nowhere near enough.
    check("a strong ball still uses the full configured bar, not a scaled-down one",
          Math.abs(strong.bar - ENGAGE) < 1, `${Math.round(strong.bar)} vs ${ENGAGE}`);
    const resting = press(strong.player, strong.player.baseline + 120);
    check("...so a hand merely resting on a strong ball does not engage it", resting === false);
    // A bar that even a very strong ball cannot reach is almost certainly a typo, so guard
    // that outer bound too.
    check("the configured ceiling is within the plausible hardware range",
          ENGAGE <= 8000, `${ENGAGE} vs 8000`);
  }

  console.log("\nA ball is only 'proven' once it has really been pressed");
  {
    // What the intro screen waits on. An enrolled ball is not a working ball: it can be
    // authorized, opened and streaming and still never engage, and requiring it to shoot a duck
    // is requiring something impossible - which is exactly how the title card locked up.
    const player = playerDrivenBy((t) => REST + wobble(t, 4));
    await mod.quickStartPlayer(player);
    mod.setTrace(null);
    const base = player.baseline;
    check("a ball that has only ever idled is not proven", player.proven === false);
    for (let i = 0; i < 40; i += 1) { mod.advance(16); press(player, base + 30); }
    check("...and light contact does not prove it either", player.proven === false,
          `pressPeak ${Math.round(player.pressPeak)}`);
    mod.advance(16);
    press(player, base + 1400);
    check("a real press proves it", player.proven === true);
    check("...and says so once, with the player id",
          mod.emitted().filter((e) => e && e.type === "player_proven").length === 1,
          JSON.stringify(mod.emitted().filter((e) => e && e.type === "player_proven")));
    mod.advance(16);
    press(player, base);
    mod.advance(16);
    press(player, base + 1400);
    check("...and does not re-announce on every later press",
          mod.emitted().filter((e) => e && e.type === "player_proven").length === 1);
  }

  console.log("\nThe tuning panel can express the configured bars");
  {
    // A slider whose max is below the default silently clamps what it shows, so the readout
    // would disagree with the value actually in use.
    const fields = grab(/const TUNING_FIELDS = \[[\s\S]*?\n  \];/, "TUNING_FIELDS");
    const rangeFor = (key) => {
      const m = fields.match(new RegExp(`key: "${key}"[^}]*min: (\\d+), max: (\\d+)`));
      if (!m) throw new Error("no slider range for " + key);
      return {min: Number(m[1]), max: Number(m[2])};
    };
    for (const [key, value] of [["engageForce", ENGAGE], ["releaseForce", RELEASE],
                                ["fullForce", FULL]]) {
      const {min, max} = rangeFor(key);
      check(`the ${key} slider can reach its own default`,
            value >= min && value <= max, `${value} not in ${min}..${max}`);
    }
  }

  console.log("\nOld saved tuning cannot silently override the new bars");
  {
    // loadTuning() treats any saved number as authoritative, so a browser that played before
    // would keep engageForce ~60 and the change would look like it did nothing.
    const key = (src.match(/const TUNING_KEY = "([^"]+)"/) || [])[1];
    check("the localStorage key was bumped, discarding pre-change values",
          key === "gripball-tuning-v3", String(key));
  }

  console.log("\nThe old calibration is still reachable as a fallback");
  {
    check("startGame takes a flag rather than the sequence being deleted",
          /async function startGame\(withCalibration\)/.test(src));
    check("the default path is the quick one",
          /startGame\(false\)/.test(src) && /quickStartAllPlayers\(\)/.test(src));
    check("a button still runs the full calibration",
          /startGame\(true\)/.test(src) && /gripball-calibrate/.test(src));
    // Passing startGame straight to addEventListener would hand it an Event - truthy - and
    // every start would run the old calibration.
    check("the start button is wrapped, so the click event is not read as the flag",
          !/getElementById\("gripball-start"\)\s*\.?\s*\n?\s*\.addEventListener\("click", startGame\)/
            .test(src));
    check("calibrateAllPlayers is still defined", /async function calibrateAllPlayers\(\)/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
