#!/usr/bin/env node
/**
 * Aim-tracking tone test.
 *
 * Pulls the real syncTracking()/updateVoice()/setVoicePosition()/makeTrackingVoice() out of
 * gripball_webhid.js and runs them against a stub Web Audio API, checking that:
 *   - pitch rises as the crosshair closes on the duck (the aiming cue)
 *   - the tone falls silent at lock-on, and comes back when the aim drifts off
 *   - each player gets a different FM timbre, held steady across the pitch sweep
 *   - the voice is spatialized at the crosshair's own screen position
 *   - a moving source crossfades between two convolvers instead of switching IRs abruptly
 *   - several Party Mode voices share gain rather than piling up
 *   - a crosshair dropping out of the payload fades its voice out
 *
 * Also checks the exact JS expression gripball_input.gd builds, since a quoting mistake
 * there fails silently inside JavaScriptBridge.eval.
 *
 * Usage: node tools/test_tracking_tone.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "gripball_webhid.js"), "utf8");
const gd = fs.readFileSync(path.join(__dirname, "..", "gripball_input.gd.reference"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error("could not find " + label);
  return m[0];
}
function constant(name) {
  const m = src.match(new RegExp("const " + name + " = ([\\d.]+);"));
  if (!m) throw new Error("could not find constant " + name);
  return Number(m[1]);
}

const pieces = [
  grab(/function nearestIn\(values, target\) \{[\s\S]*?\n    \}/, "nearestIn"),
  grab(/function nearestAzimuth\(azimuths, target\) \{[\s\S]*?\n    \}/, "nearestAzimuth"),
  grab(/function hrirNameFor\(vector\) \{[\s\S]*?\n    \}/, "hrirNameFor"),
  grab(/function sourceVector\(x, y, vw, vh\) \{[\s\S]*?\n    \}/, "sourceVector"),
  grab(/const TRILL_TABLE_SAMPLES = [\s\S]*?function getTrillTable\(\) \{[\s\S]*?\n    \}/,
       "getTrillTable"),
  grab(/function trillRate\(context, hz\) \{[\s\S]*?\n    \}/, "trillRate"),
  grab(/const TONE_TIMBRES = \[[\s\S]*?\n    \];/, "TONE_TIMBRES"),
  grab(/function timbreFor\(id\) \{[\s\S]*?\n    \}/, "timbreFor"),
  grab(/function trillTiltRatio\(lowHz, highHz\) \{[\s\S]*?\n    \}/, "trillTiltRatio"),
  grab(/function lockEnvelope\(closeness, locked\) \{[\s\S]*?\n    \}/, "lockEnvelope"),
  // Compensates the IRs' weak low end; test_hrir_loudness.js checks the dB arithmetic.
  grab(/function tiltCompensation\(hz\) \{[\s\S]*?\n    \}/, "tiltCompensation"),
  grab(/function shareOfGain\(count\) \{[\s\S]*?\n    \}/, "shareOfGain"),
  grab(/function hrirGainFor\(name, buffer\) \{[\s\S]*?\n    \}/, "hrirGainFor"),
  grab(/function makeTrackingVoice\(id\) \{[\s\S]*?\n    \}/, "makeTrackingVoice"),
  grab(/function setVoicePosition\(voice, vector\) \{[\s\S]*?\n    \}/, "setVoicePosition"),
  grab(/function updateVoice\(voice, closeness, vector, share, locked\) \{[\s\S]*?\n    \}/,
       "updateVoice"),
  grab(/function stopVoice\(voice\) \{[\s\S]*?\n    \}/, "stopVoice"),
  grab(/function syncTracking\(payload, vw, vh\) \{[\s\S]*?\n    \}/, "syncTracking"),
];

const CONSTANTS = ["TONE_MIN_HZ", "TONE_MAX_HZ", "TONE_PEAK_GAIN", "TONE_FADE_MS",
                   "TONE_GLIDE_MS", "TONE_LOCK_START", "TONE_LOCK_SILENT", "TONE_LOCK_MS",
                   "TONE_TILT_DB_PER_OCT", "TONE_TILT_REF_HZ", "HRIR_MATCH", "HRIR_MIN_NORM",
                   "TONE_TRILL_MIN_HZ", "TONE_TRILL_MAX_HZ", "TRILL_LOW_GAIN"];

// Stub Web Audio. Every node records its kind and outgoing connections; AudioParams record
// every scheduled change so ramps can be inspected. The stub's label is "kind", not "type",
// because the code under test legitimately sets airFilter.type = "lowpass".
const harness = `
  ${CONSTANTS.map((c) => `const ${c} = ${constant(c)};`).join("\n  ")}
  let nodes = [];
  let now = 0;
  const hrirNorms = {};
  const master = {kind: "master", outputs: []};
  function param(value) {
    return {
      value, events: [],
      setValueAtTime(v, t) { this.value = v; this.events.push(["set", v, t]); },
      setTargetAtTime(v, t) { this.value = v; this.events.push(["target", v, t]); },
      linearRampToValueAtTime(v, t) { this.value = v; this.events.push(["ramp", v, t]); },
      cancelScheduledValues(t) { this.events.push(["cancel", null, t]); },
    };
  }
  function node(kind, extra) {
    const n = Object.assign({
      kind, outputs: [], connect(target) { this.outputs.push(target); },
    }, extra || {});
    nodes.push(n);
    return n;
  }
  const context = {
    get currentTime() { return now; },
    sampleRate: 48000,
    createOscillator: () => node("osc", {
      type: "", frequency: param(440), detune: param(0),
      started: null, stopped: null,
      start(t) { this.started = t === undefined ? 0 : t; },
      stop(t) { this.stopped = t; },
    }),
    // The trill square is a looping AudioBufferSourceNode rather than an oscillator, so the
    // stub has to be able to hand out a buffer and a source that plays it.
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels, length, sampleRate,
      _data: Array.from({length: channels}, () => new Float32Array(length)),
      getChannelData(i) { return this._data[i]; },
    }),
    createBufferSource: () => node("bufferSource", {
      buffer: null, loop: false, playbackRate: param(1),
      started: null, stopped: null,
      start(t) { this.started = t === undefined ? 0 : t; },
      stop(t) { this.stopped = t; },
    }),
    createGain: () => node("gain", {gain: param(1)}),
    createBiquadFilter: () => node("biquad", {type: "", frequency: param(350)}),
    createConvolver: () => node("convolver", {normalize: true, buffer: null}),
    createPanner: () => node("panner", {
      panningModel: "", distanceModel: "", refDistance: 0, maxDistance: 0, rolloffFactor: 0,
      positionX: param(0), positionY: param(0), positionZ: param(0),
    }),
  };
  function getContext() { return context; }
  const hrir = {ready: false, failed: false, grid: null, byKey: null, elevations: null,
                buffers: {}, pending: {}};
  let fetched = [];
  function loadHrirBuffer(name) { fetched.push(name); return Promise.resolve(null); }
  const voices = new Map();
  ${pieces.join("\n")}
  return {
    hrir, voices, syncTracking, shareOfGain, lockEnvelope, timbreFor, TONE_TIMBRES,
    master, context,
    nodes: () => nodes,
    fetched: () => fetched,
    reset() { nodes = []; fetched = []; voices.clear(); },
    hrirGainFor, tiltCompensation, trillTiltRatio, trillRate, getTrillTable,
    TRILL_TABLE_SAMPLES,
    advance(dt) { now += dt; },
    time: () => now,
  };
`;
const mod = new Function(harness)();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const VW = 1024, VH = 600;

// Install a realistic HRIR index, the way loadHrirIndex() does.
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "assets", "hrir", "manifest.json"), "utf8")
);
function installIndex(withBuffers) {
  const grid = {};
  const byKey = {};
  for (const e of manifest) {
    (grid[e.ele] = grid[e.ele] || []).push(e.azi);
    byKey[`${e.azi},${e.ele}`] = e.name;
  }
  const elevations = Object.keys(grid).map(Number).sort((a, b) => a - b);
  for (const ele of elevations) grid[ele].sort((a, b) => a - b);
  const buffers = {};
  if (withBuffers) {
    for (const e of manifest) {
      const taps = new Float32Array(256);
      taps[0] = 0.08;   // a norm typical of the shipped IRs, so gains come out realistic
      buffers[e.name] = {
        label: e.name, length: 256, numberOfChannels: 1, getChannelData: () => taps,
      };
    }
  }
  Object.assign(mod.hrir, {ready: true, failed: false, grid, byKey, elevations, buffers,
                           pending: {}});
}

/** Build the payload gripball_input.gd sends. */
const entry = (id, x, y, closeness, locked) => ({id, x, y, closeness, locked: Boolean(locked)});

const oscsOf = (voice) => [voice.carrier, voice.mod];
const pitchOf = (voice) => voice.carrier.frequency.value;
const gainOf = (voice) => voice.tone.gain.value;

console.log("\nPitch rises as the crosshair closes on the duck");
{
  installIndex(true);
  mod.reset();
  const pitches = [];
  for (const closeness of [0, 0.25, 0.5, 0.75, 1]) {
    mod.syncTracking([entry(0, VW / 2, VH / 2, closeness)], VW, VH);
    pitches.push(pitchOf(mod.voices.get(0)));
    mod.advance(0.05);
  }
  console.log("       " + pitches.map((p) => Math.round(p) + "Hz").join(" -> "));
  check("pitch increases monotonically with closeness",
        pitches.every((p, i) => i === 0 || p > pitches[i - 1]), pitches.join(","));
  check("far from the duck sits at the low end",
        Math.abs(pitches[0] - constant("TONE_MIN_HZ")) < 1, pitches[0] + "Hz");
  check("right on the duck reaches the top of the range",
        Math.abs(pitches[4] - constant("TONE_MAX_HZ")) < 1, pitches[4] + "Hz");
  // Even spacing in pitch space is the point of the log mapping: a linear Hz ramp would
  // bunch all the perceptible movement into the top of the range.
  const ratios = pitches.slice(1).map((p, i) => p / pitches[i]);
  const spread = Math.max(...ratios) - Math.min(...ratios);
  check("steps are evenly spaced by ear (equal ratios, not equal Hz)", spread < 0.01,
        "ratios " + ratios.map((r) => r.toFixed(3)).join(","));

  // Now that a press builds a fresh voice, the first update matters on its own. An unplayed
  // OscillatorNode sits at the Web Audio default 440Hz, so gliding into the first target
  // would swoop down from A4 at the start of every single press.
  mod.reset();
  mod.syncTracking([entry(0, VW / 2, VH / 2, 0)], VW, VH);
  const fresh = mod.voices.get(0);
  const firstPitch = fresh.carrier.frequency.events.filter((e) => e[0] !== "cancel");
  check("a new voice's first pitch is set outright, not glided into from 440Hz",
        firstPitch.length > 0 && firstPitch[0][0] === "set",
        JSON.stringify(firstPitch.slice(0, 2)));
  check("...for the modulator and its depth too, or the timbre swoops instead",
        fresh.mod.frequency.events[0][0] === "set" &&
        fresh.modDepth.gain.events.filter((e) => e[1] > 0)[0][0] === "set");
  check("...but the gain still fades in, because it starts from zero and would click",
        fresh.tone.gain.events.filter((e) => e[1] > 0)[0][0] === "target",
        JSON.stringify(fresh.tone.gain.events));
  mod.advance(0.05);
  mod.syncTracking([entry(0, VW / 2, VH / 2, 0.4)], VW, VH);
  check("the second update glides, so the sweep itself stays smooth",
        fresh.carrier.frequency.events.slice(firstPitch.length).some((e) => e[0] === "target"),
        JSON.stringify(fresh.carrier.frequency.events));
}

console.log("\nThe tone falls silent at lock-on, and returns when the aim drifts off");
{
  installIndex(true);
  mod.reset();
  // Sampled relative to the real thresholds, so retuning the fade does not silently turn
  // these into assertions about a band that no longer exists.
  // Same octave interpolation updateVoice uses, needed to undo the pitch-dependent tilt.
  const pitchAt = (c) => constant("TONE_MIN_HZ") *
    Math.pow(2, Math.log2(constant("TONE_MAX_HZ") / constant("TONE_MIN_HZ")) *
                Math.max(0, Math.min(1, c)));
  const START = constant("TONE_LOCK_START");
  const SILENT = constant("TONE_LOCK_SILENT");
  const MID = (START + SILENT) / 2;
  const probes = [START * 0.5, START, MID, SILENT - (SILENT - MID) / 2, 1];
  const levels = [];
  for (const closeness of probes) {
    mod.syncTracking([entry(0, VW / 2, VH / 2, closeness)], VW, VH);
    levels.push(gainOf(mod.voices.get(0)));
    mod.advance(0.05);
  }
  console.log("       closeness " + probes.map((c) => c.toFixed(2)).join("/") + " -> " +
              levels.map((g) => g.toFixed(4)).join(" "));
  check("audible while the aim is still off the duck", levels[0] > 0.001 && levels[1] > 0.001,
        levels.slice(0, 2).join(","));
  check("fully silent once aimed at the duck", levels[4] === 0, String(levels[4]));
  // The requested gain is no longer a stand-in for loudness: it now carries the low-end tilt
  // correction, which *falls* as the pitch rises (on purpose - that is what keeps the
  // delivered level flat). So divide the tilt back out to see the swell on its own, the way
  // the ear hears it. Comparing raw gains here would read the correction as a fade-out.
  const swellOnly = probes.map((c, i) =>
    levels[i] / mod.tiltCompensation(pitchAt(c)));
  console.log("       swell alone: " + swellOnly.map((g) => g.toFixed(4)).join(" "));
  check("the swell itself rises towards the duck, before lock-out takes over",
        swellOnly[1] > swellOnly[0], swellOnly.slice(0, 2).join(","));
  check("the swell peaks before lock-out, not at closeness 1",
        Math.max(...levels) > levels[4], levels.join(","));
  // What the ear actually gets: flat enough that the far end of a sweep is not the inaudible
  // part. Measured against the real IRs in test_hrir_loudness.js; here we only check that the
  // correction is wired in at all and pulls in the right direction.
  // Guard the call site, not just the function: deleting the correction from updateVoice must
  // fail a *behavioural* assertion, not only a regex on the source. If the tilt were dropped,
  // the requested gain would follow the swell and rise with closeness; with it in place the
  // far/low end asks for more gain than the near/high end.
  check("the tilt is actually applied to the level, so a far crosshair asks for more gain",
        levels[0] > levels[1], `${levels[0].toFixed(4)} vs ${levels[1].toFixed(4)}`);
  check("the correction boosts the low (far) end more than the high (near) end",
        mod.tiltCompensation(constant("TONE_MIN_HZ")) >
        mod.tiltCompensation(constant("TONE_MAX_HZ")),
        `${mod.tiltCompensation(constant("TONE_MIN_HZ")).toFixed(2)} vs ` +
        `${mod.tiltCompensation(constant("TONE_MAX_HZ")).toFixed(2)}`);
  check("ducks out through the middle rather than cutting",
        levels[2] > 0 && levels[2] < levels[1] && levels[3] < levels[2],
        levels.slice(1).join(","));

  // Drifting off the duck must bring the tone back - the voice is silenced, not stopped.
  const voice = mod.voices.get(0);
  mod.advance(0.05);
  mod.syncTracking([entry(0, VW / 2, VH / 2, START * 0.5)], VW, VH);
  check("drifting off the duck brings the tone back", gainOf(voice) > 0.001,
        String(gainOf(voice)));
  check("...on the same voice, not a rebuilt one", mod.voices.get(0) === voice);
  check("its oscillators were never stopped",
        oscsOf(voice).every((o) => o.stopped === null));

  // The envelope itself, independent of gain sharing and the swell.
  check("lockEnvelope is 1 below the lock threshold",
        mod.lockEnvelope(0) === 1 && mod.lockEnvelope(constant("TONE_LOCK_START")) === 1);
  check("lockEnvelope is 0 at and above the silent threshold",
        mod.lockEnvelope(constant("TONE_LOCK_SILENT")) === 0 && mod.lockEnvelope(1) === 0);
  check("lockEnvelope falls monotonically in between", (() => {
    let prev = 1;
    for (let i = 0; i <= 20; i += 1) {
      const v = mod.lockEnvelope(i / 20);
      if (v > prev + 1e-12) return false;
      prev = v;
    }
    return true;
  })());
  check("it has no corner to click on (smooth at both ends)",
        mod.lockEnvelope(constant("TONE_LOCK_START") + 0.001) > 0.999 &&
        mod.lockEnvelope(constant("TONE_LOCK_SILENT") - 0.001) < 0.001);
  check("the lock-out is faster than the pitch glide, so it reads as an event",
        constant("TONE_LOCK_MS") < constant("TONE_GLIDE_MS"),
        `${constant("TONE_LOCK_MS")}ms vs ${constant("TONE_GLIDE_MS")}ms`);
  const lockEvents = voice.tone.gain.events.filter((e) => e[0] === "target");
  check("gain changes are smoothed rather than set instantly", lockEvents.length > 0);
}

console.log("\nSilence tracks the game's own hit test, not a closeness guess");
{
  // The duck's hitbox is many pixels wide, but TONE_LOCK_SILENT works out to only a few, so
  // without the flag the tone would still sound at positions where a shot already hits.
  installIndex(true);
  mod.reset();
  // A closeness the fade alone would leave audible, so the flag is doing the work here.
  const OPEN = constant("TONE_LOCK_START") * 0.75;
  mod.syncTracking([entry(0, VW / 2, VH / 2, OPEN, true)], VW, VH);
  check("locked silences the tone even at mid closeness", gainOf(mod.voices.get(0)) === 0,
        String(gainOf(mod.voices.get(0))));
  check("lockEnvelope honours locked at any closeness",
        mod.lockEnvelope(0, true) === 0 && mod.lockEnvelope(0.5, true) === 0);
  check("unlocked at the same closeness still sounds",
        (mod.reset(), mod.syncTracking([entry(0, VW / 2, VH / 2, OPEN, false)], VW, VH),
         gainOf(mod.voices.get(0)) > 0.001),
        String(gainOf(mod.voices.get(0))));

  // Leaving the hitbox must restore the tone on the same voice.
  const voice = mod.voices.get(0);
  mod.advance(0.05);
  mod.syncTracking([entry(0, VW / 2, VH / 2, OPEN, true)], VW, VH);
  check("entering the hitbox silences it", gainOf(voice) === 0);
  mod.advance(0.05);
  mod.syncTracking([entry(0, VW / 2, VH / 2, OPEN, false)], VW, VH);
  check("leaving it again brings the tone back", gainOf(voice) > 0.001, String(gainOf(voice)));
  check("...without rebuilding the voice", mod.voices.get(0) === voice);

  // The bug this section exists for: the fade must FINISH at or before the hitbox edge. If
  // TONE_LOCK_SILENT sits inside the lock radius, the tone is at full volume right up to the
  // moment `locked` cuts it, and then stays silent for most of the hold - which sounds like
  // "the tracking tone doesn't work" rather than like a lock cue. The game viewport is
  // 256x240, so the hitbox is a large fraction of the screen and this is easy to get wrong.
  const GAME_VW = 256, GAME_VH = 240;
  const DIAG = Math.hypot(GAME_VW, GAME_VH);
  const RANGE = Number((gd.match(/TRACK_TONE_RANGE := ([\d.]+)/) || [])[1]);
  const LOCK_RADIUS = Number((gd.match(/TRACK_LOCK_RADIUS := ([\d.]+)/) || [])[1]);
  check("the Godot constants the geometry depends on are readable",
        Number.isFinite(RANGE) && Number.isFinite(LOCK_RADIUS),
        `range ${RANGE}, radius ${LOCK_RADIUS}`);
  const pxAt = (closeness) => DIAG * RANGE * (1 - closeness);
  const silentPx = pxAt(constant("TONE_LOCK_SILENT"));
  const startPx = pxAt(constant("TONE_LOCK_START"));
  console.log(`       fade ${startPx.toFixed(0)}px -> silent ${silentPx.toFixed(0)}px,` +
              ` hitbox ${LOCK_RADIUS}px (viewport ${GAME_VW}x${GAME_VH})`);
  check("the fade completes outside the hitbox, not inside it", silentPx >= LOCK_RADIUS,
        `silent at ${silentPx.toFixed(1)}px but locked from ${LOCK_RADIUS}px`);
  check("the fade has room to be heard before the hitbox",
        startPx - Math.max(silentPx, LOCK_RADIUS) >= 10,
        `only ${(startPx - Math.max(silentPx, LOCK_RADIUS)).toFixed(1)}px of fade`);
  check("but the tone is still audible over most of the tracking range",
        startPx < DIAG * RANGE * 0.45,
        `fade starts ${startPx.toFixed(0)}px into a ${(DIAG * RANGE).toFixed(0)}px range`);

  // A payload with no flag at all (an older build) must still fade out on closeness alone.
  mod.reset();
  mod.syncTracking([{id: 0, x: VW / 2, y: VH / 2, closeness: 1}], VW, VH);
  check("a payload with no locked flag still falls silent on closeness",
        gainOf(mod.voices.get(0)) === 0, String(gainOf(mod.voices.get(0))));

  // A silent voice must not take headroom from the ones still sounding.
  const levelOf = (payload) => {
    mod.reset();
    mod.syncTracking(payload, VW, VH);
    return gainOf(mod.voices.get(0));
  };
  const alone = levelOf([entry(0, 300, VH / 2, 0.5, false)]);
  const withLocked = levelOf([entry(0, 300, VH / 2, 0.5, false),
                              entry(1, 700, VH / 2, 0.99, true)]);
  const withAudible = levelOf([entry(0, 300, VH / 2, 0.5, false),
                               entry(1, 700, VH / 2, 0.5, false)]);
  console.log(`       alone ${alone.toFixed(4)} | +locked ${withLocked.toFixed(4)}` +
              ` | +audible ${withAudible.toFixed(4)}`);
  check("a locked (silent) voice does not duck the players still hunting",
        Math.abs(withLocked - alone) < 1e-9, `${withLocked} vs ${alone}`);
  check("but a second audible voice still shares gain", withAudible < alone,
        `${withAudible} vs ${alone}`);
}

console.log("\nEach player gets their own FM timbre");
{
  installIndex(true);
  mod.reset();
  const payload = [];
  for (let i = 0; i < 4; i += 1) payload.push(entry(i, 200 + i * 150, VH / 2, 0.5));
  mod.syncTracking(payload, VW, VH);
  const voices = [0, 1, 2, 3].map((i) => mod.voices.get(i));
  check("every voice is an FM pair (carrier + modulator)",
        voices.every((v) => v.carrier && v.mod && v.modDepth));
  check("the modulator feeds the carrier's frequency, not the output",
        voices.every((v) => v.mod.outputs.includes(v.modDepth) &&
                            v.modDepth.outputs.includes(v.carrier.frequency)));
  check("the modulator is not audible directly",
        voices.every((v) => !v.mod.outputs.includes(v.tone)));
  const fingerprint = (v) => `${v.timbre.ratio}:${v.timbre.index}:${v.timbre.carrier}`;
  const prints = voices.map(fingerprint);
  console.log("       " + prints.map((p, i) => `P${i + 1} ${p}`).join(" | "));
  check("P1 and P2 have different timbres", prints[0] !== prints[1],
        `${prints[0]} vs ${prints[1]}`);
  check("all four players are distinguishable", new Set(prints).size === 4, prints.join(" "));
  check("P1 and P2 differ in the harmonicity ratio, not just loudness",
        voices[0].timbre.ratio !== voices[1].timbre.ratio,
        `${voices[0].timbre.ratio} vs ${voices[1].timbre.ratio}`);
  check("modulation depths differ between P1 and P2",
        voices[0].modDepth.gain.value !== voices[1].modDepth.gain.value,
        `${voices[0].modDepth.gain.value} vs ${voices[1].modDepth.gain.value}`);
  check("timbres do not depend on the tone being loud (same pitch for all)",
        new Set(voices.map((v) => Math.round(pitchOf(v)))).size === 1,
        voices.map((v) => Math.round(pitchOf(v))).join(","));

  // The FM index must stay constant as the pitch sweeps, otherwise each voice changes
  // character on the way up and stops being a recognisable player identity.
  mod.reset();
  const indices = [];
  const ratios = [];
  for (const closeness of [0.1, 0.4, 0.7]) {
    mod.syncTracking([entry(1, VW / 2, VH / 2, closeness)], VW, VH);
    const v = mod.voices.get(1);
    indices.push(v.modDepth.gain.value / v.mod.frequency.value);
    ratios.push(v.mod.frequency.value / v.carrier.frequency.value);
    mod.advance(0.05);
  }
  check("modulation index is held constant while the pitch sweeps",
        Math.max(...indices) - Math.min(...indices) < 1e-9,
        indices.map((i) => i.toFixed(4)).join(","));
  check("the modulator tracks the carrier at a fixed ratio",
        Math.max(...ratios) - Math.min(...ratios) < 1e-9,
        ratios.map((r) => r.toFixed(4)).join(","));
  check("the index matches the configured timbre",
        Math.abs(indices[0] - mod.timbreFor(1).index) < 1e-9,
        `${indices[0]} vs ${mod.timbreFor(1).index}`);

  check("player ids beyond the table wrap instead of crashing",
        mod.timbreFor(9) === mod.TONE_TIMBRES[9 % mod.TONE_TIMBRES.length]);
  check("a negative id still lands on a real timbre",
        Boolean(mod.timbreFor(-1) && mod.timbreFor(-1).ratio));
}

console.log("\nThe voice is a synth, started once, and routed to master");
{
  installIndex(true);
  mod.reset();
  mod.syncTracking([entry(0, VW / 2, VH / 2, 0.5)], VW, VH);
  const voice = mod.voices.get(0);
  check("uses oscillators rather than a sample", oscsOf(voice).every((o) => o.kind === "osc"));
  check("oscillators are started", oscsOf(voice).every((o) => o.started !== null));
  const startedAt = voice.carrier.started;
  for (let i = 0; i < 5; i += 1) {
    mod.advance(0.05);
    mod.syncTracking([entry(0, VW / 2, VH / 2, 0.5)], VW, VH);
  }
  check("not restarted on every update", voice.carrier.started === startedAt);
  check("only one voice exists for one crosshair", mod.voices.size === 1);
  const chain = [];
  let n = voice.airFilter;
  while (n && n !== mod.master && chain.length < 8) { chain.push(n.kind); n = n.outputs[0]; }
  check("air-absorption lowpass is in the chain", voice.airFilter.type === "lowpass");
  check("reaches master", chain.length > 0 && n === mod.master, chain.join(" -> "));
}

console.log("\nA moving source crossfades between two convolvers (no IR switching clicks)");
{
  installIndex(true);
  mod.reset();
  mod.syncTracking([entry(0, 100, VH / 2, 0.5)], VW, VH);   // hard left
  const voice = mod.voices.get(0);
  check("built the A/B convolver pair", Boolean(voice.convA && voice.convB));
  check("convolvers keep the IR's own interaural level difference",
        voice.convA.normalize === false && voice.convB.normalize === false);
  const firstIr = voice.irName;
  const firstActive = voice.activeConv;
  // The live side now carries this IR's own loudness compensation rather than a bare 1,
  // because each IR needs a different amount (see test_hrir_loudness.js).
  const startGain = mod.hrirGainFor(voice.irName, mod.hrir.buffers[voice.irName]);
  // Which of A/B is live depends on how many swaps have happened, so ask the voice.
  const liveGain = voice.activeConv === "A" ? voice.gainA : voice.gainB;
  const idleGain = voice.activeConv === "A" ? voice.gainB : voice.gainA;
  check("one side is live at that IR's gain and the other is silent",
        Math.abs(liveGain.gain.value - startGain) < 1e-9 && idleGain.gain.value === 0,
        `live=${liveGain.gain.value} idle=${idleGain.gain.value} expected ${startGain}`);
  check("...and that gain is a real boost, not a pass-through", startGain > 2,
        String(startGain));

  mod.advance(0.1);
  mod.syncTracking([entry(0, VW - 100, VH / 2, 0.5)], VW, VH);   // sweep to hard right
  check("selected a different IR for the new position", voice.irName !== firstIr,
        `${firstIr} -> ${voice.irName}`);
  check("handed over to the other convolver", voice.activeConv !== firstActive,
        `${firstActive} -> ${voice.activeConv}`);
  const ramps = [...voice.gainA.gain.events, ...voice.gainB.gain.events]
    .filter((e) => e[0] === "ramp");
  check("crossfaded with ramps rather than jumping", ramps.length >= 2,
        JSON.stringify(ramps));
  const fade = constant("TONE_FADE_MS") / 1000;
  check("the crossfade is short but audible-safe (SonicSquid uses 0.05-0.1s)",
        fade >= 0.04 && fade <= 0.12, fade + "s");
  // The incoming side must ramp to the NEW IR's gain. Ramping to 1 (or to the old IR's
  // gain) would step the loudness in the middle of the crossfade.
  const wantedGain = mod.hrirGainFor(voice.irName, mod.hrir.buffers[voice.irName]);
  const target = ramps.map((e) => e[1]).sort((a, b) => a - b);
  check("one side ramps to silence and the other up to the new IR's gain",
        target[0] === 0 && Math.abs(target[target.length - 1] - wantedGain) < 1e-9,
        JSON.stringify(target) + " expected top " + wantedGain);
  check("no new convolver nodes are built while moving",
        mod.nodes().filter((n) => n.kind === "convolver").length === 2,
        String(mod.nodes().filter((n) => n.kind === "convolver").length));
}

console.log("\nAzimuth follows the crosshair, not the duck");
{
  installIndex(true);
  const irFor = (x) => {
    mod.reset();
    mod.syncTracking([entry(0, x, VH / 2, 0.5)], VW, VH);
    return mod.voices.get(0).irName;
  };
  const left = irFor(40);
  const centre = irFor(VW / 2);
  const right = irFor(VW - 40);
  console.log(`       left ${left} | centre ${centre} | right ${right}`);
  check("left, centre and right pick different IRs",
        new Set([left, centre, right]).size === 3, [left, centre, right].join(" "));
  // The dataset's azimuths increase anticlockwise, so screen-right maps above 180.
  const aziOf = (name) => Number(name.match(/azi(\d+)/)[1]);
  check("screen-left maps to a left-ear azimuth (0 < azi < 180)",
        aziOf(left) > 0 && aziOf(left) < 180, left);
  check("screen-right maps to a right-ear azimuth (azi > 180)", aziOf(right) > 180, right);
  check("centre maps to straight ahead", aziOf(centre) === 0 || aziOf(centre) >= 358, centre);
}

console.log("\nParty Mode: several voices share gain instead of piling up");
{
  installIndex(true);
  mod.reset();
  const gainFor = (count) => {
    mod.reset();
    const payload = [];
    for (let i = 0; i < count; i += 1) {
      payload.push(entry(i, 200 + i * 120, VH / 2, 0.8));
    }
    mod.syncTracking(payload, VW, VH);
    return [...mod.voices.values()].map((v) => v.tone.gain.value);
  };
  const one = gainFor(1);
  const four = gainFor(4);
  check("one crosshair -> one voice", one.length === 1);
  check("four crosshairs -> four voices", four.length === 4);
  check("each voice is quieter when several sound at once", four[0] < one[0],
        `${four[0].toFixed(4)} vs ${one[0].toFixed(4)}`);
  // Equal-power sharing: total power stays roughly constant, but no single voice vanishes.
  const totalPower = (gains) => gains.reduce((sum, g) => sum + g * g, 0);
  const ratio = totalPower(four) / totalPower(one);
  check("combined loudness stays roughly constant (equal-power sharing)",
        Math.abs(ratio - 1) < 0.05, "power ratio " + ratio.toFixed(3));
  check("but an individual voice does not become inaudible", four[0] > one[0] * 0.4,
        `${four[0].toFixed(4)} vs ${one[0].toFixed(4)}`);
  check("each Party voice is positioned at its own crosshair",
        new Set([...mod.voices.values()].map((v) => v.irName)).size === 4,
        [...mod.voices.values()].map((v) => v.irName).join(" "));
  console.log(`       1 voice ${one[0].toFixed(4)} | 4 voices ${four[0].toFixed(4)} each`);
}

console.log("\nA crosshair dropping out of the payload fades its voice out");
{
  installIndex(true);
  mod.reset();
  mod.syncTracking([entry(0, 300, VH / 2, 0.6), entry(1, 700, VH / 2, 0.6)], VW, VH);
  check("two voices sounding", mod.voices.size === 2);
  const dropped = mod.voices.get(1);
  mod.advance(0.1);
  mod.syncTracking([entry(0, 300, VH / 2, 0.6)], VW, VH);   // player 1 stops tracking
  check("the absent crosshair's voice is released", mod.voices.size === 1 && mod.voices.has(0));
  check("it faded rather than cut", dropped.tone.gain.events.some((e) => e[0] === "ramp"),
        JSON.stringify(dropped.tone.gain.events));
  check("its oscillators are scheduled to stop",
        oscsOf(dropped).every((o) => o.stopped !== null));
  check("...after the fade completes, not during it",
        oscsOf(dropped).every((o) => o.stopped >= mod.time() + constant("TONE_FADE_MS") / 1000),
        `stop at ${dropped.carrier.stopped}, now ${mod.time()}`);

  mod.advance(0.1);
  mod.syncTracking([], VW, VH);          // everyone stops
  check("an empty payload stops everything", mod.voices.size === 0);
}

console.log("\nIt degrades instead of going silent");
{
  // Dataset never loaded: must still make a sound, via the browser's own HRTF panner.
  Object.assign(mod.hrir, {ready: false, failed: true, buffers: {}, pending: {}});
  mod.reset();
  let threw = null;
  try { mod.syncTracking([entry(0, 800, 200, 0.7)], VW, VH); }
  catch (error) { threw = error; }
  check("does not throw without the HRIR dataset", !threw, threw && threw.message);
  const voice = mod.voices.get(0);
  check("falls back to the browser HRTF panner", Boolean(voice && voice.panner));
  check("panner uses HRTF", voice.panner.panningModel === "HRTF");
  const beforeX = voice.panner.positionX.value;
  mod.advance(0.1);
  mod.syncTracking([entry(0, 200, 200, 0.7)], VW, VH);
  check("the fallback still pans as the crosshair moves",
        voice.panner.positionX.value !== beforeX,
        `${beforeX} -> ${voice.panner.positionX.value}`);

  // Index present but nothing decoded yet: must keep sounding and fetch in the background.
  installIndex(false);
  mod.reset();
  mod.syncTracking([entry(0, 800, 200, 0.7)], VW, VH);
  check("with no decoded IR it still starts a voice", mod.voices.size === 1);
  check("...and requests IRs in the background", mod.fetched().length > 0,
        mod.fetched().join(","));
}

console.log("\nBad input is ignored rather than throwing into JavaScriptBridge");
{
  installIndex(true);
  mod.reset();
  check("a non-array payload returns false", mod.syncTracking({}, VW, VH) === false);
  check("malformed JSON returns false", mod.syncTracking("{not json", VW, VH) === false);
  check("a JSON string payload is parsed",
        mod.syncTracking(JSON.stringify([entry(0, 500, 300, 0.5)]), VW, VH) === true);
  mod.reset();
  check("null entries are skipped", mod.syncTracking([null, entry(0, 500, 300, 0.5)], VW, VH) === true);
  check("missing fields do not produce NaN pitch",
        (mod.syncTracking([{id: 0}], VW, VH), Number.isFinite(pitchOf(mod.voices.get(0)))),
        String(pitchOf(mod.voices.get(0))));
}

console.log("\nOne press, one sweep: Godot stops sending, and the next press starts fresh");
{
  // Godot now ends a segment by dropping the entry from the list (an arrived crosshair stops
  // being sent at all), and starts the next one by sending it again after release. So the
  // JS side has to handle a voice that goes away and comes back mid-game.
  installIndex(true);
  mod.reset();
  mod.syncTracking([entry(0, VW / 2, VH * 0.8, 0.2)], VW, VH);
  const firstPress = mod.voices.get(0);
  check("the press starts a voice", Boolean(firstPress) && gainOf(firstPress) > 0.001);
  mod.advance(0.05);
  mod.syncTracking([entry(0, VW / 2, VH * 0.6, 0.6)], VW, VH);
  check("...which sweeps up while it is still being sent",
        pitchOf(firstPress) > constant("TONE_MIN_HZ") * 1.5, pitchOf(firstPress) + "Hz");

  // Arrival: Godot sends an empty list rather than locked:true.
  mod.syncTracking([], VW, VH);
  check("dropping the entry fades the voice out", firstPress.stopping === true);
  check("...and releases the id, so it cannot be resumed later",
        mod.voices.has(0) === false);
  check("...stopping the oscillators rather than leaving them running",
        oscsOf(firstPress).every((o) => o.stopped !== null));
  mod.advance(0.5);

  // The next press. This must be a genuinely new sweep from the bottom, not a continuation.
  mod.syncTracking([entry(0, VW / 2, VH * 0.8, 0.2)], VW, VH);
  const secondPress = mod.voices.get(0);
  check("the next press builds a new voice", Boolean(secondPress) &&
        secondPress !== firstPress);
  check("...audible again from the start", gainOf(secondPress) > 0.001,
        String(gainOf(secondPress)));
  check("...starting low rather than resuming the pitch it ended on",
        Math.abs(pitchOf(secondPress) - pitchOf(firstPress)) > 50,
        `${Math.round(pitchOf(secondPress))}Hz vs ${Math.round(pitchOf(firstPress))}Hz`);
  check("...and keeping the same player's timbre",
        secondPress.timbre.ratio === firstPress.timbre.ratio &&
        secondPress.timbre.index === firstPress.timbre.index);
  // Repeated empty lists are the steady state while nobody is pressing, so they must be
  // cheap and must not resurrect anything.
  mod.syncTracking([], VW, VH);
  mod.syncTracking([], VW, VH);
  check("idle empty lists leave no voices behind", mod.voices.size === 0,
        String(mod.voices.size));
}

console.log("\nThe Godot side sends what the JS side expects");
{
  check("gripball_input.gd calls syncTracking", /duckHuntSpatialAudio\.syncTracking/.test(gd));
  check("it guards on the function existing, for older builds",
        /duckHuntSpatialAudio && window\.duckHuntSpatialAudio\.syncTracking/.test(gd));
  check("it sends the game viewport size, not window.innerWidth",
        /get_visible_rect\(\)\.size/.test(gd) && /syncTracking\(%s, %f, %f\)/.test(gd));
  check("single-player tracking sends a tone", /_send_track_tones\(\[\{/.test(gd));
  check("Party Mode collects one entry per player and sends them together",
        /tones\.append\(\{/.test(gd) && /_send_track_tones\(tones\)/.test(gd));
  check("Party Mode measures closeness to the duck itself",
        /_closeness_to\(current, target\)/.test(gd));
  check("the crosshair wobble is gone entirely",
        !/wobble/i.test(gd), (gd.match(/.*wobble.*/i) || [""])[0].trim());
  check("tracking stops are sent as an empty list",
        (gd.match(/_send_track_tones\(\[\]\)/g) || []).length >= 2,
        String((gd.match(/_send_track_tones\(\[\]\)/g) || []).length));
  check("updates are throttled, but far faster than the 0.22s proximity feedback",
        /TRACK_TONE_INTERVAL := 1\.0 \/ 30\.0/.test(gd));
  check("single player ends the tone from the duck's real hitbox",
        /if _is_on_duck\(virtual_position, duck\):\s*\n\s*tone_spent = true/.test(gd));
  check("_is_on_duck uses the same geometry as the shot test",
        /func _is_on_duck/.test(gd) &&
        /collision\.shape\.get_rect\(\)\.has_point\(collision\.to_local\(point\)\)/.test(gd));
  check("...and the shot test itself still uses that geometry, so they cannot diverge",
        /collision\.shape\.get_rect\(\)\.has_point\(collision\.to_local\(virtual_position\)\)/
          .test(gd));
  check("a missing or unpickable duck counts as not locked",
        /func _is_on_duck[\s\S]*?input_pickable[\s\S]*?return false/.test(gd));
  check("Party Mode ends the tone too (by radius, having only a position to work from)",
        /distance_to\(target\) <= TRACK_LOCK_RADIUS:\s*\n\s*party_tone_spent\[player_id\] = true/
          .test(gd));

  // One press -> one sweep. The flag has to be set on arrival and cleared ONLY on release;
  // anything else clearing it (a new duck, a frame tick) would let a single hold re-trigger.
  check("the spent flags are declared before use",
        /var tone_spent := false/.test(gd) && /var party_tone_spent := \{\}/.test(gd));
  check("single player re-arms on release, and only on release",
        /if tracking_strength <= TRACK_PRESS_FLOOR:[\s\S]{0,220}?tone_spent = false/.test(gd) &&
        (gd.match(/\btone_spent = false/g) || []).length === 1,
        String((gd.match(/\btone_spent = false/g) || []).length) + " reset site(s)");
  // Ordering matters as much as the flag: if the arrival test ran while released, the flag
  // would be re-armed the instant the next press began (the crosshair is still parked on the
  // duck from last time) and that press would be silent. Both modes must leave the loop
  // before testing arrival - single player by returning, Party Mode by continuing.
  // Matched on the release branch's own body (comments and indented statements only, no
  // blank line and no dedent), so a `return` anywhere further down the function cannot
  // stand in for the one that has to be right here.
  const releaseBody = (gd.match(
    /if tracking_strength <= TRACK_PRESS_FLOOR:\n((?:\t\t(?:#.*|\S.*)\n)+)/
  ) || [])[1] || "";
  check("the release branch returns, so the arrival test cannot re-arm it",
        /^\t\treturn$/m.test(releaseBody), JSON.stringify(releaseBody));
  const partyReleaseBody = (gd.match(
    /if strength <= TRACK_PRESS_FLOOR:\n((?:\t\t\t(?:#.*|\S.*)\n)+)/
  ) || [])[1] || "";
  check("...and Party Mode's release branch continues, for the same reason",
        /^\t\t\tcontinue$/m.test(partyReleaseBody), JSON.stringify(partyReleaseBody));
  check("Party Mode re-arms per player on release",
        /if strength <= TRACK_PRESS_FLOOR:[\s\S]{0,260}?party_tone_spent\[player_id\] = false/
          .test(gd));
  check("a spent press sends silence rather than a tone",
        /if tone_spent:\n(?:\s*#.*\n)*\s*_send_track_tones\(\[\]\)/.test(gd) &&
        /if not bool\(party_tone_spent\.get\(player_id, false\)\):/.test(gd));
  check("party spent flags are cleared when the crosshairs are rebuilt",
        /func _setup_party_crosshairs[\s\S]*?party_tone_spent\.clear\(\)/.test(gd));
  check("release is the same threshold the crosshair texture already switches on",
        /const TRACK_PRESS_FLOOR := 0\.01/.test(gd) &&
        /strength > 0\.01 else crosshair_white/.test(gd));
  // The tone now stops on arrival rather than being ducked to silence, so nothing should be
  // sending locked:true any more - it would double up with the press gate.
  check("no live entry claims locked, now that arrival ends the segment instead",
        !/"locked": (?!false)/.test(gd),
        (gd.match(/"locked": .*/g) || []).join(" | "));
  check("the disabled haptics path was not re-enabled",
        !/gripballBridge\.proximity/.test(gd) || /web_mode/.test(gd));

  // Reproduce the exact expression GDScript builds and confirm the JS side parses it.
  const entries = [entry(0, 812.5, 233, 0.7431)];
  const inner = JSON.stringify(entries);
  const expression =
    "window.duckHuntSpatialAudio && window.duckHuntSpatialAudio.syncTracking " +
    `? window.duckHuntSpatialAudio.syncTracking(${JSON.stringify(inner)}, ` +
    `${(1024).toFixed(6)}, ${(600).toFixed(6)}) : false`;
  let parsed = null;
  try {
    parsed = new Function("window", "return " + expression.replace(/^.*\? /, "").replace(/ : false$/, ""))(
      {duckHuntSpatialAudio: {syncTracking: (p, w, h) => mod.syncTracking(p, w, h)}}
    );
  } catch (error) { parsed = error; }
  check("the built expression is valid JS and reaches syncTracking", parsed === true,
        String(parsed && parsed.message ? parsed.message : parsed));
  console.log("       " + expression.slice(0, 150));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
