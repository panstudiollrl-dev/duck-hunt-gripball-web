#!/usr/bin/env node
/**
 * HRIR convolution mapping test.
 *
 * Pulls the real angle-selection code out of gripball_webhid.js and checks it against the
 * IRs actually shipped in assets/hrir/ - including the part that is easy to get silently
 * backwards: which azimuth is the left ear. The dataset's own measured ITD/ILD is used as
 * ground truth, so this fails if the convention is inverted.
 *
 * Usage: node tools/test_hrir_mapping.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "gripball_webhid.js"), "utf8");
const HRIR_DIR = path.join(ROOT, "assets", "hrir");

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
];

// Build the hrir index the same way loadHrirIndex() does, from the real manifest.
const manifest = JSON.parse(fs.readFileSync(path.join(HRIR_DIR, "manifest.json"), "utf8"));
const grid = {};
const byKey = {};
for (const entry of manifest) {
  (grid[entry.ele] = grid[entry.ele] || []).push(entry.azi);
  byKey[`${entry.azi},${entry.ele}`] = entry.name;
}
const elevations = Object.keys(grid).map(Number).sort((a, b) => a - b);
for (const ele of elevations) grid[ele].sort((a, b) => a - b);

const mod = new Function(`
  const hrir = ${JSON.stringify({ready: true, grid, byKey, elevations})};
  ${pieces.join("\n")}
  return {hrirNameFor, sourceVector, nearestAzimuth, nearestIn};
`)();

/** Decode a 48k float32 stereo wav and measure which ear leads/dominates. */
function measure(name) {
  const buf = fs.readFileSync(path.join(HRIR_DIR, name));
  if (buf.toString("latin1", 0, 4) !== "RIFF") throw new Error(name + " not RIFF");
  let pos = 12;
  let channels = 0, bits = 0, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === "fmt ") { channels = buf.readUInt16LE(pos + 2); bits = buf.readUInt16LE(pos + 14); }
    else if (id === "data") data = buf.subarray(pos, pos + size);
    pos += size + (size % 2);
  }
  if (channels !== 2 || bits !== 32) throw new Error(`${name}: expected stereo float32`);
  const frames = data.length / 8;
  let peakL = 0, peakR = 0, idxL = 0, idxR = 0, sumL = 0, sumR = 0;
  for (let i = 0; i < frames; i += 1) {
    const l = data.readFloatLE(i * 8);
    const r = data.readFloatLE(i * 8 + 4);
    if (Math.abs(l) > peakL) { peakL = Math.abs(l); idxL = i; }
    if (Math.abs(r) > peakR) { peakR = Math.abs(r); idxR = i; }
    sumL += l * l; sumR += r * r;
  }
  const rmsL = Math.sqrt(sumL / frames), rmsR = Math.sqrt(sumR / frames);
  return {itd: idxL - idxR, ild: 20 * Math.log10(rmsL / rmsR), frames};
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}

const VW = 1024, VH = 600;
const vecFor = (x, y) => mod.sourceVector(x, y, VW, VH);

console.log("\nThe dataset's own convention (measured, not assumed)");
{
  const left = measure("ir_azi090_ele000.wav");
  const right = measure("ir_azi270_ele000.wav");
  check("azi 90 is the LEFT ear (leads and is louder)", left.itd < 0 && left.ild > 6,
        `itd=${left.itd} ild=${left.ild.toFixed(1)}dB`);
  check("azi 270 is the RIGHT ear", right.itd > 0 && right.ild < -6,
        `itd=${right.itd} ild=${right.ild.toFixed(1)}dB`);
  const centre = measure("ir_azi000_ele000.wav");
  check("azi 0 is roughly centred", Math.abs(centre.itd) <= 2 && Math.abs(centre.ild) < 4,
        `itd=${centre.itd} ild=${centre.ild.toFixed(1)}dB`);
}

console.log("\nA duck on screen picks the IR for the ear it should be heard in");
{
  const leftDuck = mod.hrirNameFor(vecFor(0, VH / 2));
  const rightDuck = mod.hrirNameFor(vecFor(VW, VH / 2));
  const centreDuck = mod.hrirNameFor(vecFor(VW / 2, VH / 2));
  console.log(`       left duck -> ${leftDuck}, centre -> ${centreDuck}, right -> ${rightDuck}`);

  const l = measure(leftDuck), r = measure(rightDuck), c = measure(centreDuck);
  check("duck on the LEFT of the screen is louder in the left ear", l.ild > 6,
        `${leftDuck} ild=${l.ild.toFixed(1)}dB`);
  check("duck on the LEFT arrives at the left ear first", l.itd < 0, `itd=${l.itd}`);
  check("duck on the RIGHT of the screen is louder in the right ear", r.ild < -6,
        `${rightDuck} ild=${r.ild.toFixed(1)}dB`);
  check("duck on the RIGHT arrives at the right ear first", r.itd > 0, `itd=${r.itd}`);
  check("duck in the CENTRE is not pulled to one side", Math.abs(c.ild) < 4,
        `${centreDuck} ild=${c.ild.toFixed(1)}dB`);
  check("left and right pick different IRs", leftDuck !== rightDuck);
}

console.log("\nPan sweeps cleanly across the screen");
{
  const azimuthOf = (name) => Number(name.match(/^ir_azi(\d+)_/)[1]);
  const sweep = [];
  for (let i = 0; i <= 20; i += 1) {
    const name = mod.hrirNameFor(vecFor((VW * i) / 20, VH / 2));
    sweep.push({at: i / 20, name, azi: azimuthOf(name), ild: measure(name).ild});
  }

  // The chosen angle IS required to move strictly one way: screen-left picks azimuths
  // descending 90 -> 0, then screen-right continues 358 -> 270. Unwrap to check that.
  const unwrapped = sweep.map((e) => (e.azi > 180 ? e.azi - 360 : e.azi));
  let angleMonotonic = true;
  for (let i = 1; i < unwrapped.length; i += 1) {
    if (unwrapped[i] > unwrapped[i - 1]) angleMonotonic = false;
  }
  check("chosen azimuth moves strictly left-to-right with the duck", angleMonotonic,
        unwrapped.join(" "));

  // The measured ILD, however, is NOT monotonic and must not be asserted to be: in real
  // HRIRs peak |ILD| sits near azi 105/290 rather than exactly 90/270, because of pinna
  // and head asymmetry. What must hold is that the ear the sound favours is always the
  // correct one.
  const wrongSign = sweep.filter((e) => {
    const lateral = e.at * 2 - 1;
    if (lateral < -0.05) return !(e.ild > 0);
    if (lateral > 0.05) return !(e.ild < 0);
    return Math.abs(e.ild) > 5;
  });
  check("every position favours the correct ear", wrongSign.length === 0,
        wrongSign.map((e) => `${e.at}:${e.ild.toFixed(1)}`).join(" "));

  const leftHalf = sweep.filter((e) => e.at < 0.5).reduce((a, e) => a + e.ild, 0);
  const rightHalf = sweep.filter((e) => e.at > 0.5).reduce((a, e) => a + e.ild, 0);
  check("screen-left half is left-dominant overall, right half right-dominant",
        leftHalf > 0 && rightHalf < 0, `${leftHalf.toFixed(1)} vs ${rightHalf.toFixed(1)}`);
  check("full-screen sweep spans a wide ILD range",
        sweep[0].ild - sweep[sweep.length - 1].ild > 20,
        `${sweep[0].ild.toFixed(1)}dB .. ${sweep[sweep.length - 1].ild.toFixed(1)}dB`);
  const distinct = new Set(sweep.map((e) => e.name)).size;
  check("sweep uses many distinct IRs, not 2-3", distinct >= 8, `${distinct} distinct`);
}

console.log("\nAzimuth wrap-around near straight ahead");
{
  // Just left of centre must land near 0/002/005, not 355 - and vice versa. A naive
  // nearest search over a 0..358 list would pick the wrong side of the head here.
  const azis = grid[0];
  check("target 359 wraps to 0 or 358, not 355", [0, 358].includes(mod.nearestAzimuth(azis, 359)),
        "got " + mod.nearestAzimuth(azis, 359));
  check("target 1 wraps to 0 or 002", [0, 2].includes(mod.nearestAzimuth(azis, 1)),
        "got " + mod.nearestAzimuth(azis, 1));
  check("target 180 stays at 180", mod.nearestAzimuth(azis, 180) === 180,
        "got " + mod.nearestAzimuth(azis, 180));
  const nearCentreLeft = mod.hrirNameFor({lateral: -0.02, vertical: 0, dist: 0});
  const nearCentreRight = mod.hrirNameFor({lateral: 0.02, vertical: 0, dist: 0});
  const nl = measure(nearCentreLeft), nr = measure(nearCentreRight);
  check("a hair left of centre is not hard-panned", Math.abs(nl.ild) < 6,
        `${nearCentreLeft} ild=${nl.ild.toFixed(1)}dB`);
  check("a hair right of centre is not hard-panned", Math.abs(nr.ild) < 6,
        `${nearCentreRight} ild=${nr.ild.toFixed(1)}dB`);
}

console.log("\nElevation follows screen height");
{
  const high = mod.hrirNameFor(vecFor(VW / 2, 0));
  const mid = mod.hrirNameFor(vecFor(VW / 2, VH / 2));
  const low = mod.hrirNameFor(vecFor(VW / 2, VH));
  const eleOf = (name) => {
    const m = name.match(/_ele(M?)(\d+)\.wav$/);
    return (m[1] === "M" ? -1 : 1) * Number(m[2]);
  };
  console.log(`       top -> ${high} (${eleOf(high)}), mid -> ${mid} (${eleOf(mid)}), bottom -> ${low} (${eleOf(low)})`);
  check("duck at the top of the screen uses a positive elevation", eleOf(high) > 0);
  check("duck at mid-height uses elevation 0", eleOf(mid) === 0);
  check("duck at the bottom uses a negative elevation", eleOf(low) < 0);
  check("elevation is ordered top > mid > bottom", eleOf(high) > eleOf(mid) && eleOf(mid) > eleOf(low));
}

console.log("\nEvery IR the mapping can ever ask for actually exists on disk");
{
  const missing = [];
  const seen = new Set();
  for (let i = 0; i <= 40; i += 1) {
    for (let j = 0; j <= 40; j += 1) {
      const name = mod.hrirNameFor(vecFor((VW * i) / 40, (VH * j) / 40));
      if (!name) { missing.push(`(${i},${j}) -> null`); continue; }
      seen.add(name);
      if (!fs.existsSync(path.join(HRIR_DIR, name))) missing.push(name);
    }
  }
  check("no lookup returns a missing or null IR", missing.length === 0, missing.slice(0, 5).join(", "));
  console.log(`       ${seen.size} distinct IRs reachable from a 41x41 sweep of the screen`);
  check("off-screen coordinates still resolve to a real IR",
        [[-9999, -9999], [99999, 99999], [0, 99999]].every(([x, y]) => {
          const name = mod.hrirNameFor(vecFor(x, y));
          return name && fs.existsSync(path.join(HRIR_DIR, name));
        }));
}

console.log("\nShipped IRs are all well-formed");
{
  let bad = 0;
  for (const entry of manifest) {
    const file = path.join(HRIR_DIR, entry.name);
    if (!fs.existsSync(file)) { bad += 1; continue; }
    if (fs.statSync(file).size < 512) bad += 1;
  }
  check(`all ${manifest.length} manifest entries exist and look like IRs`, bad === 0, bad + " bad");
  const frames = measure(manifest[0].name).frames;
  check("IRs are short enough for per-sound convolution (<=1024 taps)", frames <= 1024,
        frames + " taps");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
