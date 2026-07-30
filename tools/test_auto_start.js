#!/usr/bin/env node
/**
 * Auto-start and HUD-visibility test.
 *
 * Pan's decision (2026-07-30): once balls are connected there is nothing left to ask, so the
 * game starts itself - nobody presses 開始遊戲. And when a button IS the only way forward, the
 * control row has to be visible rather than hidden behind a button labelled 「數值」.
 *
 * Both are small state machines with real races in them, which is the reason for this file:
 *   - players connect one at a time, so starting on the first ball would drop the second player
 *   - a pending countdown must not start a ball game underneath 鍵盤測試
 *   - an auto-start and an impatient click can both pass the `phase === "connect"` check,
 *     because phase only changes after the first await
 *   - a failed auto-start must not retry every 2.5s forever, burying its own error message
 *   - hiding the row is a preference, and a preference must not be silently overwritten by the
 *     code that reveals the row
 *
 * The real functions are pulled out of gripball_webhid.js and run against a fake clock and a
 * fake DOM, so the timers cost microseconds.
 *
 * Usage: node tools/test_auto_start.js
 */
"use strict";
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

const AUTO_START_QUIET_MS = constant("AUTO_START_QUIET_MS");

const pieces = [
  grab(/function needsButtons\(\) \{[\s\S]*?\n  \}/, "needsButtons"),
  grab(/function applyHudVisibility\(\) \{[\s\S]*?\n  \}/, "applyHudVisibility"),
  grab(/function setHudHidden\(hidden\) \{[\s\S]*?\n  \}/, "setHudHidden"),
  grab(/function refreshUi\(\) \{[\s\S]*?\n  \}/, "refreshUi"),
  grab(/function cancelAutoStart\(\) \{[\s\S]*?\n  \}/, "cancelAutoStart"),
  grab(/function scheduleAutoStart\(\) \{[\s\S]*?\n  \}/, "scheduleAutoStart"),
  grab(/function setConnectedStatus\(prefix = "已連接"\) \{[\s\S]*?\n  \}/, "setConnectedStatus"),
];

// A fake DOM that records only what these functions touch, plus a fake clock so setTimeout is
// deterministic. startGame() is stubbed to a recorder: what is under test is *when* and *how
// often* it is called, not what it does once called (test_quick_start.js covers that).
const harness = `
  const AUTO_START_QUIET_MS = ${AUTO_START_QUIET_MS};
  const HUD_KEY = "gripball-hud-hidden";
  let clock = 0;
  let timers = [];
  let nextTimerId = 1;
  const starts = [];
  const store = {};
  const console = {warn() {}, error() {}};
  function setTimeout(fn, ms) {
    const id = nextTimerId++;
    timers.push({id, at: clock + ms, fn});
    return id;
  }
  function clearTimeout(id) { timers = timers.filter((t) => t.id !== id); }
  const window = {localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  }};
  const elements = {};
  function el(id) {
    if (!elements[id]) elements[id] = {id, style: {display: ""}, disabled: false, dataset: {},
                                      textContent: ""};
    return elements[id];
  }
  const document = {getElementById: (id) => el(id)};
  const state = {players: [], phase: "connect", keyboardMode: false, startFailed: false};
  let hudHiddenPreference = false;
  let autoStartTimer = null;
  let starting = false;
  function setStatus(text, kind) {
    const node = el("gripball-status");
    node.textContent = text;
    node.dataset.kind = kind || "";
  }
  // Stubbed: records the call instead of running the real start.
  function startGame(withCalibration) {
    starts.push({withCalibration, at: clock, players: state.players.length});
  }
  ${pieces.join("\n")}
  return {
    state, setConnectedStatus, scheduleAutoStart, cancelAutoStart, refreshUi, setHudHidden,
    needsButtons, startGame,
    el,
    starts: () => starts.slice(),
    status: () => el("gripball-status").textContent,
    statusKind: () => el("gripball-status").dataset.kind,
    hudShown: () => el("gripball-webhid").style.display !== "none",
    dotShown: () => el("gripball-show").style.display !== "none",
    preference: () => hudHiddenPreference,
    saved: () => store[HUD_KEY],
    pending: () => timers.length,
    now: () => clock,
    /** Run the clock forward, firing timers in order. */
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock = due.at;
        due.fn();
      }
      clock = target;
    },
    setStarting(v) { starting = v; },
    reset(opts) {
      clock = 0; timers = []; starts.length = 0;
      for (const k of Object.keys(store)) delete store[k];
      for (const k of Object.keys(elements)) delete elements[k];
      state.players = []; state.phase = "connect"; state.keyboardMode = false;
      state.startFailed = false;
      hudHiddenPreference = (opts && opts.hidden) || false;
      autoStartTimer = null; starting = false;
    },
  };
`;
const mod = new Function(harness)();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

/** Simulate connecting a ball, the way enrollDevice -> setConnectedStatus does. */
function connectBall(mod) {
  mod.state.players.push({playerId: mod.state.players.length});
  mod.setConnectedStatus("已連接");
}

console.log("\nConnecting a ball starts the game with no button press");
{
  mod.reset();
  connectBall(mod);
  check("nothing starts immediately - there is a window to add a second ball",
        mod.starts().length === 0, JSON.stringify(mod.starts()));
  check("a countdown is armed", mod.pending() === 1, String(mod.pending()));
  mod.advance(AUTO_START_QUIET_MS + 1);
  check("it starts on its own once the window passes", mod.starts().length === 1,
        JSON.stringify(mod.starts()));
  check("...and it takes the quick path, not the old calibration",
        mod.starts()[0] && mod.starts()[0].withCalibration === false,
        JSON.stringify(mod.starts()[0]));
  console.log(`       started at ${mod.starts()[0].at}ms with ${mod.starts()[0].players} ball(s)`);
}

console.log("\nA second ball joins the same game instead of being left out");
{
  // The reason for the delay. Two Gripballs are two separate enrolments a second or two apart;
  // starting on the first would put P2 out of the game with no way back in.
  mod.reset();
  connectBall(mod);
  mod.advance(AUTO_START_QUIET_MS - 600);      // second ball arrives late but inside the window
  connectBall(mod);
  check("the pending start has not fired yet", mod.starts().length === 0,
        JSON.stringify(mod.starts()));
  mod.advance(AUTO_START_QUIET_MS - 600);      // would have been enough for the FIRST timer
  check("the countdown restarted, so it is still waiting", mod.starts().length === 0,
        `started at ${JSON.stringify(mod.starts())}`);
  mod.advance(700);
  check("it eventually starts", mod.starts().length === 1, JSON.stringify(mod.starts()));
  check("both balls are in the game", mod.starts()[0].players === 2,
        String(mod.starts()[0].players));
  check("only one start happens, not one per ball", mod.starts().length === 1,
        String(mod.starts().length));
  console.log(`       2 balls, single start at ${mod.starts()[0].at}ms`);

  // A slow human adding a third ball much later must still get it in.
  mod.reset();
  connectBall(mod);
  for (let i = 0; i < 6; i += 1) { mod.advance(AUTO_START_QUIET_MS - 400); connectBall(mod); }
  check("repeatedly adding balls keeps deferring the start", mod.starts().length === 0,
        JSON.stringify(mod.starts()));
  mod.advance(AUTO_START_QUIET_MS + 1);
  check("...and when they stop arriving, all of them are in", mod.starts()[0].players === 7,
        String(mod.starts()[0].players));
}

console.log("\nIt does not start a game nobody is in");
{
  mod.reset();
  mod.setConnectedStatus("已連接");    // restoreAuthorizedDevices found nothing
  check("no countdown with zero balls", mod.pending() === 0, String(mod.pending()));
  mod.advance(AUTO_START_QUIET_MS * 3);
  check("...and nothing starts", mod.starts().length === 0, JSON.stringify(mod.starts()));

  // The last ball unplugs during the countdown.
  mod.reset();
  connectBall(mod);
  mod.state.players.pop();
  mod.setConnectedStatus("已連接");    // the disconnect handler's call
  mod.advance(AUTO_START_QUIET_MS * 3);
  check("a ball unplugged during the countdown cancels the start",
        mod.starts().length === 0, JSON.stringify(mod.starts()));
}

console.log("\nThe keyboard test is not hijacked by a pending auto-start");
{
  mod.reset();
  connectBall(mod);
  // startKeyboardTest() sets keyboardMode and cancels before its await; both are checked.
  mod.state.keyboardMode = true;
  mod.cancelAutoStart();
  mod.advance(AUTO_START_QUIET_MS * 3);
  check("no ball game starts under the keyboard test", mod.starts().length === 0,
        JSON.stringify(mod.starts()));

  // Belt and braces: even if the timer somehow survived, the callback re-checks.
  mod.reset();
  connectBall(mod);
  mod.state.keyboardMode = true;      // set WITHOUT cancelling, simulating the timer surviving
  mod.advance(AUTO_START_QUIET_MS * 3);
  check("the timer callback re-checks keyboardMode rather than trusting the cancel",
        mod.starts().length === 0, JSON.stringify(mod.starts()));
  check("cancelAutoStart is called before the await in startKeyboardTest",
        /cancelAutoStart\(\);\s*\n\s*state\.keyboardMode = true;\s*\n\s*await resumeAudioAndFocusCanvas\(\)/
          .test(src));
}

console.log("\nA start already under way is not started twice");
{
  // phase only changes after the first await, so the phase check alone lets an auto-start and
  // a click through together. The real guard is the `starting` flag.
  check("startGame has a re-entrancy flag", /if \(starting\) return;\s*\n\s*starting = true;/
        .test(src));
  check("the flag is cleared on both exits, so a failure does not wedge the button",
        /\n    starting = false;\n    refreshUi\(\);/.test(src));
  check("startGame cancels any pending countdown when it runs",
        /starting = true;[\s\S]{0,200}cancelAutoStart\(\);/.test(src));

  mod.reset();
  connectBall(mod);
  mod.setStarting(true);              // pretend a click already began a start
  mod.advance(AUTO_START_QUIET_MS * 2);
  // The stub cannot exercise the flag itself (it is inside the real startGame), so this checks
  // the other half: the countdown is only ever armed from scheduleAutoStart, and phase leaving
  // "connect" stops it.
  mod.state.phase = "starting";
  mod.scheduleAutoStart();
  check("no countdown is armed once the phase has left connect", mod.pending() === 0,
        String(mod.pending()));
}

console.log("\nA failed auto-start does not loop, and leaves the retry visible");
{
  check("failure does not re-arm the countdown",
        !/catch \(error\) \{[\s\S]*?scheduleAutoStart\(\)[\s\S]*?\n    \}/.test(
          grab(/async function startGame\(withCalibration\)[\s\S]*?\n  \}/, "startGame")),
        "scheduleAutoStart must not be called from the catch branch");
  check("failure is recorded so the row stays visible", /state\.startFailed = true;/.test(src));
  check("...and cleared on the next attempt", /state\.startFailed = false;/.test(src));
  check("the message says which button to press, since nobody pressed one to get here",
        /無法自動開始[\s\S]{0,60}開始遊戲/.test(src));

  // With startFailed set, the row must be up even if the preference says hidden.
  mod.reset({hidden: true});
  mod.state.players.push({playerId: 0});
  mod.state.startFailed = true;
  mod.refreshUi();
  check("a failed start shows the row despite a saved hidden preference", mod.hudShown(),
        "row hidden");
  check("...without overwriting the preference", mod.preference() === true,
        String(mod.preference()));
}

console.log("\nThe control row is visible when a button is the only way forward");
{
  // Pan's report: with the row hidden, the only way to connect was a small button labelled
  // 「數值」, which reads as a diagnostics toggle.
  mod.reset({hidden: true});
  mod.refreshUi();
  check("with nothing connected, the row is shown even if hidden was saved", mod.hudShown(),
        "row hidden with no way to connect");
  check("the 'show' button is not also on screen at the same time", !mod.dotShown(),
        "both shown");
  check("the connect button is actually visible in that row",
        mod.el("gripball-connect").style.display !== "none");

  // Once a ball is connected the preference is honoured again - it was remembered, not lost.
  connectBall(mod);
  check("once connected, the saved preference takes effect again", !mod.hudShown(),
        "row still shown");
  check("...and the way back in is on screen", mod.dotShown(), "no way to reopen");
  check("the preference survived being overridden", mod.preference() === true,
        String(mod.preference()));
}

console.log("\nHiding is still a real preference");
{
  mod.reset();
  connectBall(mod);                    // so needsButtons() is false and hiding can take effect
  mod.setHudHidden(true);
  check("hiding hides", !mod.hudShown());
  check("hiding is persisted", mod.saved() === "1", String(mod.saved()));
  mod.setHudHidden(false);
  check("showing shows", mod.hudShown());
  check("showing is persisted", mod.saved() === "0", String(mod.saved()));

  // Boot must not write the preference back, or the reveal would overwrite it.
  check("boot loads the preference without calling setHudHidden",
        /hudHiddenPreference = window\.localStorage\.getItem\(HUD_KEY\) === "1";/.test(src));
  check("...and refreshUi decides what is actually shown",
        /function refreshUi\(\)[\s\S]*?applyHudVisibility\(\);\n  \}/.test(src));
}

console.log("\nThe reopen button says what is behind it");
{
  // "數值" gave no hint that the connect and start buttons were in there.
  const label = (src.match(/dot\.textContent = "([^"]+)"/) || [])[1];
  check("the reopen button is no longer labelled just 數值", label !== "數值", String(label));
  check("its label mentions the ball, not only readouts", /握力球/.test(label), String(label));
  console.log(`       reopen button reads 「${label}」`);
}

console.log("\nThe status text tells the player what is about to happen");
{
  mod.reset();
  connectBall(mod);
  check("it says the game is about to start rather than 'press start'",
        /馬上開始/.test(mod.status()), mod.status());
  check("...and says how to add another ball, since waiting is the only chance to",
        /新增/.test(mod.status()), mod.status());
  console.log(`       "${mod.status()}"`);

  // Not in play: the "about to start" wording must not persist once started.
  mod.state.phase = "play";
  mod.setConnectedStatus("已連接");
  check("that wording is gone once the game is running", !/馬上開始/.test(mod.status()),
        mod.status());
}

console.log("\nRemoving the click did not take audio unlocking with it");
{
  // The subtle regression auto-start introduces. Browsers only start an AudioContext from
  // inside a user gesture; 開始遊戲 used to be that gesture. A returning player's balls are
  // already authorized, so restoreAuthorizedDevices() enrols them with no click, and the game
  // can reach play having never seen one - correct graph, no sound. Squeezing the ball cannot
  // fix it: a HID input report is not a user gesture.
  const unlockSrc = grab(/function unlockAudioOnFirstGesture\(\) \{[\s\S]*?\n  \}/,
                         "unlockAudioOnFirstGesture");
  check("there is a first-gesture audio unlock at all", Boolean(unlockSrc));
  check("it is installed at boot, not only from a button",
        /installTuningUi\(\);\s*\n\s*unlockAudioOnFirstGesture\(\);/.test(src));
  for (const evt of ["pointerdown", "keydown"]) {
    check(`it listens for ${evt}, so any interaction unlocks`, unlockSrc.includes(evt));
  }
  check("it listens in capture phase and passively, so game input is unaffected",
        /capture: true, passive: true/.test(unlockSrc));
  check("it only stops listening once a context is actually running",
        /ctx && ctx\.state === "running"[\s\S]*?removeEventListener/.test(unlockSrc),
        "must not unhook on the first click if Godot has no context yet");
  check("a rejected resume() cannot throw out of the listener", /\.catch\(/.test(unlockSrc));

  // And the player is told, rather than being left with a silent game that looks broken.
  const startSrc = grab(/async function startGame\(withCalibration\)[\s\S]*?\n  \}/, "startGame");
  check("the ready message warns when audio is still blocked",
        /audioIsBlocked\(\)/.test(startSrc), "no audio check in startGame");
  check("...and says what to do about it", /點一下畫面開聲音/.test(startSrc));
  check("audioIsBlocked only reports 'blocked' for a genuinely suspended context",
        /ctx\.state === "suspended"/.test(
          grab(/function audioIsBlocked\(\) \{[\s\S]*?\n  \}/, "audioIsBlocked")));
}

console.log("\nThe window is long enough to plug in a second ball, short enough to feel automatic");
{
  check("the quiet window is at least 1.5s", AUTO_START_QUIET_MS >= 1500,
        String(AUTO_START_QUIET_MS));
  check("...and no more than 5s", AUTO_START_QUIET_MS <= 5000, String(AUTO_START_QUIET_MS));
  console.log(`       AUTO_START_QUIET_MS = ${AUTO_START_QUIET_MS}ms`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
