#!/usr/bin/env node
/**
 * Positional-audio mapping test.
 *
 * Pulls the real sourceVector()/connectHrtf() out of gripball_webhid.js and checks that
 * a duck's Godot viewport position maps to the correct left/right pan - including the
 * letterbox / devicePixelRatio cases that the old window.innerWidth divisor got wrong.
 *
 * Usage: node tools/test_source_vector.js
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "gripball_webhid.js");
const src = fs.readFileSync(SRC, "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error("could not find " + label);
  return m[0];
}

const sourceVectorSrc = grab(/function sourceVector\(x, y, vw, vh\) \{[\s\S]*?\n    \}/, "sourceVector");
const connectHrtfSrc = grab(/function connectHrtf\(source, vector, options\) \{[\s\S]*?\n    \}/, "connectHrtf");
const makeAirFilterSrc = grab(/function makeAirFilter\(context, vector\) \{[\s\S]*?\n    \}/, "makeAirFilter");

// Minimal Web Audio stand-ins: we only care about the panner position that gets set.
const harness = `
let lastPanner = null;
const master = {};
function getContext() {
  return {
    currentTime: 0,
    createPanner() {
      const p = {
        panningModel: "", distanceModel: "", refDistance: 0, maxDistance: 0,
        rolloffFactor: 0, coneInnerAngle: 0, coneOuterAngle: 0, coneOuterGain: 0,
        positionX: {value: 0}, positionY: {value: 0}, positionZ: {value: 0},
        connect() {},
      };
      lastPanner = p;
      return p;
    },
    createGain() { return {gain: {value: 0}, connect() {}}; },
    createBiquadFilter() {
      return {
        type: "", connect() {},
        frequency: {value: 0, setValueAtTime(v) { this.value = v; }},
      };
    },
  };
}
${sourceVectorSrc}
${makeAirFilterSrc}
${connectHrtfSrc}
return {
  sourceVector,
  panFor(x, y, vw, vh) {
    const v = sourceVector(x, y, vw, vh);
    connectHrtf({connect(){}}, v, {gain: 0.9});
    return {vector: v, x: lastPanner.positionX.value, y: lastPanner.positionY.value, z: lastPanner.positionZ.value};
  },
};
`;
const mod = new Function(harness)();

// The old, buggy mapping, for comparison.
function oldSourceVector(x, y, winW, winH) {
  const width = Math.max(1, winW || 1);
  const height = Math.max(1, winH || 1);
  const lateral = Math.max(-1, Math.min(1, (x / width) * 2 - 1));
  const vertical = Math.max(-1, Math.min(1, 1 - (y / height) * 2));
  return {lateral, vertical};
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Godot's design viewport for this game.
const VW = 1024, VH = 600;

console.log("\nBasic mapping (viewport size supplied)");
{
  const left = mod.panFor(0, VH / 2, VW, VH);
  const mid = mod.panFor(VW / 2, VH / 2, VW, VH);
  const right = mod.panFor(VW, VH / 2, VW, VH);
  check("far left  -> lateral -1", near(left.vector.lateral, -1), "got " + left.vector.lateral);
  check("center    -> lateral  0", near(mid.vector.lateral, 0), "got " + mid.vector.lateral);
  check("far right -> lateral +1", near(right.vector.lateral, 1), "got " + right.vector.lateral);
  check("panner x is negative on the left", left.x < 0, "x=" + left.x);
  check("panner x is positive on the right", right.x > 0, "x=" + right.x);
  check("panner x is 0 at center", near(mid.x, 0), "x=" + mid.x);
  check("sound stays in front (z < 0)", left.z < 0 && mid.z < 0 && right.z < 0);
}

console.log("\nVertical mapping");
{
  const top = mod.panFor(VW / 2, 0, VW, VH);
  const bottom = mod.panFor(VW / 2, VH, VW, VH);
  check("top of screen    -> vertical +1", near(top.vector.vertical, 1), "got " + top.vector.vertical);
  check("bottom of screen -> vertical -1", near(bottom.vector.vertical, -1), "got " + bottom.vector.vertical);
  check("high duck sounds higher than low duck", top.y > bottom.y, `${top.y} vs ${bottom.y}`);
}

console.log("\nThe actual bug: letterboxed canvas (window wider than the game viewport)");
{
  // Browser window 1920x1080, game viewport 1024x600 -> canvas letterboxed.
  const WIN_W = 1920, WIN_H = 1080;
  const duckAtRightEdge = VW;             // duck is at the right edge of the GAME
  const fixed = mod.sourceVector(duckAtRightEdge, VH / 2, VW, VH);
  const old = oldSourceVector(duckAtRightEdge, VH / 2, WIN_W, WIN_H);
  check("fixed: right edge reads as hard right (+1)", near(fixed.lateral, 1), "got " + fixed.lateral);
  check("old code got this wrong (not +1)", !near(old.lateral, 1), "old lateral=" + old.lateral.toFixed(3));
  console.log(`       old lateral=${old.lateral.toFixed(3)} vs fixed=${fixed.lateral.toFixed(3)}` +
              `  (old placed a right-edge duck near the centre)`);
}

console.log("\nThe actual bug: centre of the game is not the centre of the window");
{
  const WIN_W = 1920;
  const centre = VW / 2;
  const fixed = mod.sourceVector(centre, VH / 2, VW, VH);
  const old = oldSourceVector(centre, VH / 2, WIN_W, 1080);
  check("fixed: game centre is dead centre", near(fixed.lateral, 0), "got " + fixed.lateral);
  check("old code pushed centre off to one side", Math.abs(old.lateral) > 0.4,
        "old lateral=" + old.lateral.toFixed(3));
  console.log(`       a duck dead-centre used to be panned ${old.lateral < 0 ? "LEFT" : "RIGHT"}` +
              ` by ${Math.abs(old.lateral).toFixed(3)}`);
}

// This file only ever runs in a browser, so window always exists; define it for the
// fallback paths that read window.innerWidth.
global.window = {innerWidth: VW, innerHeight: VH};

console.log("\nFallback: no viewport supplied (older pck) must still work");
{
  const v = mod.sourceVector(VW, VH / 2, undefined, undefined);
  check("falls back to window and still maps to +1", near(v.lateral, 1), "got " + v.lateral);
}

console.log("\nDegenerate input is clamped, not NaN");
{
  const zero = mod.sourceVector(500, 300, 0, 0);
  check("zero viewport does not produce NaN", Number.isFinite(zero.lateral), "got " + zero.lateral);
  const off = mod.sourceVector(-500, -100, VW, VH);
  check("off-screen left clamps to -1", near(off.lateral, -1), "got " + off.lateral);
  const off2 = mod.sourceVector(99999, 99999, VW, VH);
  check("off-screen right clamps to +1", near(off2.lateral, 1), "got " + off2.lateral);
  check("off-screen bottom clamps to -1", near(off2.vertical, -1), "got " + off2.vertical);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
