#!/usr/bin/env node
/**
 * Spatial-audio graph test.
 *
 * Runs the real spatialize()/connectHrir()/connectHrtf() against a stub Web Audio API and
 * traces the resulting node graph, checking that:
 *   - the measured-HRIR convolver path is used when an IR is decoded
 *   - it falls back to the browser HRTF panner when the IR is missing, without throwing
 *   - a missing/failed dataset degrades to the old behaviour instead of going silent
 *   - the air-absorption lowpass is in the chain and tracks distance
 *
 * Usage: node tools/test_spatial_graph.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "gripball_webhid.js"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error("could not find " + label);
  return m[0];
}

const pieces = [
  grab(/function nearestIn\(values, target\) \{[\s\S]*?\n    \}/, "nearestIn"),
  grab(/function nearestAzimuth\(azimuths, target\) \{[\s\S]*?\n    \}/, "nearestAzimuth"),
  grab(/function hrirNameFor\(vector\) \{[\s\S]*?\n    \}/, "hrirNameFor"),
  grab(/function sourceVector\(x, y, vw, vh\) \{[\s\S]*?\n    \}/, "sourceVector"),
  grab(/function makeAirFilter\(context, vector\) \{[\s\S]*?\n    \}/, "makeAirFilter"),
  grab(/function connectHrtf\(source, vector, options\) \{[\s\S]*?\n    \}/, "connectHrtf"),
  grab(/function connectHrir\(source, vector, options, irBuffer, irName\) \{[\s\S]*?\n    \}/, "connectHrir"),
  // Per-IR loudness compensation; test_hrir_loudness.js covers the arithmetic itself.
  grab(/function hrirGainFor\(name, buffer\) \{[\s\S]*?\n    \}/, "hrirGainFor"),
  grab(/function spatialize\(source, vector, options\) \{[\s\S]*?\n    \}/, "spatialize"),
];
const HRIR_MATCH = Number(grab(/const HRIR_MATCH = ([\d.]+);/, "HRIR_MATCH").match(/[\d.]+/)[0]);
const HRIR_MIN_NORM = Number(grab(/const HRIR_MIN_NORM = ([\d.]+);/, "HRIR_MIN_NORM").match(/[\d.]+/)[0]);

// Stub Web Audio: every node records its type and outgoing connections so we can walk the
// graph the code actually built.
const harness = `
  const HRIR_MATCH = ${HRIR_MATCH};
  const HRIR_MIN_NORM = ${HRIR_MIN_NORM};
  const hrirNorms = {};
  let nodes = [];
  let fetched = [];
  const master = {kind: "master", outputs: []};
  function node(kind, extra) {
    // The stub's own label lives in "kind", not "type": the code under test sets
    // airFilter.type = "lowpass", which would otherwise overwrite it.
    const n = Object.assign({kind, outputs: [], connect(target) { this.outputs.push(target); }}, extra || {});
    nodes.push(n);
    return n;
  }
  const context = {
    currentTime: 0,
    createPanner: () => node("panner", {
      panningModel: "", distanceModel: "", refDistance: 0, maxDistance: 0, rolloffFactor: 0,
      coneInnerAngle: 0, coneOuterAngle: 0, coneOuterGain: 0,
      positionX: {value: 0}, positionY: {value: 0}, positionZ: {value: 0},
    }),
    createConvolver: () => node("convolver", {normalize: true, buffer: null}),
    createGain: () => node("gain", {gain: {value: 0}}),
    createBiquadFilter: () => node("biquad", {
      type: "", frequency: {value: 0, setValueAtTime(v) { this.value = v; }},
    }),
  };
  function getContext() { return context; }
  const hrir = {ready: false, failed: false, grid: null, byKey: null, elevations: null,
                buffers: {}, pending: {}};
  function loadHrirBuffer(name) { fetched.push(name); return Promise.resolve(null); }
  ${pieces.join("\n")}
  return {
    hrir, spatialize, sourceVector,
    reset() { nodes = []; fetched = []; for (const k of Object.keys(hrirNorms)) delete hrirNorms[k]; },
    nodes: () => nodes,
    fetched: () => fetched,
    master,
    newSource: () => node("source"),
  };
`;
const mod = new Function(harness)();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

/** Walk from a node to the master gain, returning the chain of node types. */
function chainFrom(start, master) {
  const chain = [start.kind];
  let current = start;
  const guard = new Set();
  while (current && current !== master) {
    if (guard.has(current)) { chain.push("<cycle>"); break; }
    guard.add(current);
    const next = current.outputs[0];
    if (!next) break;
    chain.push(next === master ? "master" : next.kind);
    current = next;
  }
  return chain;
}

const VW = 1024, VH = 600;

// A realistic index, built the way loadHrirIndex() does.
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "assets", "hrir", "manifest.json"), "utf8")
);
function installIndex() {
  const grid = {};
  const byKey = {};
  for (const e of manifest) {
    (grid[e.ele] = grid[e.ele] || []).push(e.azi);
    byKey[`${e.azi},${e.ele}`] = e.name;
  }
  const elevations = Object.keys(grid).map(Number).sort((a, b) => a - b);
  for (const ele of elevations) grid[ele].sort((a, b) => a - b);
  Object.assign(mod.hrir, {ready: true, failed: false, grid, byKey, elevations, buffers: {}, pending: {}});
}

console.log("\nWith the dataset loaded, sounds go through the measured-HRIR convolver");
{
  installIndex();
  const vector = mod.sourceVector(900, 200, VW, VH);
  // Find out which IR the mapping asks for, then decode it and replay.
  const irName = (() => {
    mod.reset();
    const src2 = mod.newSource();
    mod.spatialize(src2, vector, {gain: 0.9});
    return mod.fetched()[0];
  })();
  check("first play with no decoded IR requests one in the background", Boolean(irName), String(irName));

  mod.hrir.buffers[irName] = {label: irName, length: 256};
  mod.reset();
  const source = mod.newSource();
  const envelope = mod.spatialize(source, vector, {gain: 0.9});
  const chain = chainFrom(source, mod.master);
  console.log("       graph: " + chain.join(" -> "));
  check("graph is source -> envelope -> lowpass -> convolver -> gain -> master",
        chain.join(",") === "source,gain,biquad,convolver,gain,master", chain.join(" -> "));
  const convolver = mod.nodes().find((n) => n.kind === "convolver");
  check("convolver got the IR buffer", convolver && convolver.buffer && convolver.buffer.label === irName);
  check("convolver.normalize is false (keeps the IR's own interaural level difference)",
        convolver.normalize === false);
  check("no second IR fetch once it is decoded", mod.fetched().length === 0, mod.fetched().join(","));
  check("spatialize returns the envelope gain for the caller to shape",
        envelope && envelope.kind === "gain");
  check("nothing bypasses master", mod.nodes().every((n) =>
    n === mod.master || n.kind === "source" || n.outputs.length > 0));
}

console.log("\nIt falls back to the browser HRTF panner when the IR is not decoded yet");
{
  installIndex(); // empties buffers
  mod.reset();
  const source = mod.newSource();
  mod.spatialize(source, mod.sourceVector(100, 300, VW, VH), {gain: 0.9});
  const chain = chainFrom(source, mod.master);
  console.log("       graph: " + chain.join(" -> "));
  check("falls back to panner rather than dropping the sound",
        chain.includes("panner"), chain.join(" -> "));
  check("fallback still passes through the air-absorption lowpass", chain.includes("biquad"));
  check("fallback kicks off a background IR load for next time", mod.fetched().length === 1,
        mod.fetched().join(","));
  const panner = mod.nodes().find((n) => n.kind === "panner");
  check("panner uses HRTF", panner.panningModel === "HRTF");
  check("panner rolloff is the tuned 0.45, not the old 0.22", panner.rolloffFactor === 0.45,
        String(panner.rolloffFactor));
}

console.log("\nA missing dataset degrades to the old behaviour, never to silence");
{
  Object.assign(mod.hrir, {ready: false, failed: true, buffers: {}, pending: {}});
  mod.reset();
  const source = mod.newSource();
  let threw = null;
  try {
    mod.spatialize(source, mod.sourceVector(512, 300, VW, VH), {gain: 0.9});
  } catch (error) { threw = error; }
  check("does not throw when the dataset failed to load", !threw, threw && threw.message);
  const chain = chainFrom(source, mod.master);
  check("still reaches master through the panner", chain.includes("panner") && chain.includes("master"),
        chain.join(" -> "));
  check("makes no IR requests when the dataset is known-bad", mod.fetched().length === 0);
}

console.log("\nAir absorption tracks distance");
{
  installIndex();
  const freqFor = (x, y) => {
    mod.reset();
    mod.spatialize(mod.newSource(), mod.sourceVector(x, y, VW, VH), {gain: 0.9});
    return mod.nodes().find((n) => n.kind === "biquad").frequency.value;
  };
  const centre = freqFor(VW / 2, VH / 2);   // dist ~0 -> nearest
  const corner = freqFor(0, 0);             // dist largest -> furthest
  console.log(`       centre ${centre}Hz vs corner ${corner}Hz`);
  check("a near sound keeps its high end", centre > 12000, centre + "Hz");
  check("a far sound is duller", corner < centre, `${corner} vs ${centre}`);
  check("never filters below the 1200Hz floor (stays audible)", corner >= 1200, corner + "Hz");
  const filter = mod.nodes().find((n) => n.kind === "biquad");
  check("filter is a lowpass", filter.type === "lowpass");  // real .type, set by the code
}

console.log("\nLoudness is matched between the two paths so the fallback is not a jump");
{
  installIndex();
  const vector = mod.sourceVector(900, 200, VW, VH);
  mod.reset();
  mod.spatialize(mod.newSource(), vector, {gain: 0.9});
  const irName = mod.fetched()[0];
  // A stub IR with real samples, scaled to a norm typical of the shipped dataset (~0.08).
  // The old version of this test used a buffer with no samples at all, which is precisely why
  // it could not notice that the compensation was ~13dB short: with nothing to measure, any
  // constant looked as good as any other.
  const NORM = 0.08;
  const taps = new Float32Array(256);
  taps[0] = NORM;                       // one impulse, so the L2 norm is exactly NORM
  mod.hrir.buffers[irName] = {
    label: irName, length: 256, numberOfChannels: 1, getChannelData: () => taps,
  };

  mod.reset();
  mod.spatialize(mod.newSource(), vector, {gain: 0.9});
  const hrirGain = mod.nodes().filter((n) => n.kind === "gain").map((n) => n.gain.value)
    .find((v) => v !== 1);

  // Convolving by an IR of norm N multiplies the signal by roughly N, so the compensation
  // has to be proportional to 1/N. Anything that ignores N - any fixed constant - fails.
  const expected = 0.9 * (HRIR_MATCH / NORM);
  check("the convolver path compensates for the IR's own quietness",
        hrirGain > expected * 0.5 && hrirGain <= expected * 1.01,
        `gain=${hrirGain}, expected ~${expected.toFixed(2)} before rolloff`);
  check("...so the level after convolution lands near unity, not tens of dB down",
        Math.abs(20 * Math.log10(hrirGain * NORM / 0.9)) < 6,
        `${(20 * Math.log10(hrirGain * NORM / 0.9)).toFixed(1)}dB relative to the dry source`);
  // The gain is legitimately ~10x now, so the old "<= 2" ceiling would be wrong. Bound it by
  // what the quietest allowed IR can ask for instead.
  check("gain stays bounded even for a pathologically quiet IR",
        hrirGain > 0 && hrirGain <= 0.9 * (HRIR_MATCH / HRIR_MIN_NORM),
        String(hrirGain));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
