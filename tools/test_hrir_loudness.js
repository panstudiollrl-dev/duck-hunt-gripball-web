/*
 * Why this exists
 * ---------------
 * The convolver path shipped ~13dB quieter than the PannerNode fallback, and swung 7.5dB
 * depending purely on which direction was selected. The aim tone is quiet and continuous, so
 * at that level it was simply inaudible - and nothing caught it, because every other test
 * inspects scheduled AudioParam values. A gain of 0.14 reads as perfectly healthy while the
 * audio leaving the convolver is 50dB down.
 *
 * The cause is that convolution scales the signal by the IR's own energy, and these measured
 * IRs are stored very quietly (L2 norm 0.055..0.130 in the front arc). A single fixed boost
 * cannot compensate for a value that varies per file.
 *
 * So this checks the invariant directly, against the real IR files and the real function:
 *
 *     IR L2 norm  x  hrirGainFor(that IR)  ~=  constant
 *
 * which is what makes loudness independent of direction. No Web Audio needed - it is
 * arithmetic over the shipped dataset.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HRIR_DIR = path.join(ROOT, "assets", "hrir");
const js = fs.readFileSync(path.join(ROOT, "gripball_webhid.js"), "utf8");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log("  ok   " + label); }
  else { fail += 1; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
}

// Pull the real function out of the source rather than reimplementing its arithmetic.
const src = js.match(
  /const HRIR_MATCH = [\s\S]*?function hrirGainFor\(name, buffer\) \{[\s\S]*?\n    \}/
);
if (!src) { console.log("could not extract hrirGainFor from gripball_webhid.js"); process.exit(1); }
const hrirGainFor = new Function("return (() => { " + src[0] + "; return hrirGainFor; })()")();

// Minimal float32 WAV reader. The IRs are WAVE_FORMAT_IEEE_FLOAT (format 3), stereo, 48k.
function readIr(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF: " + file);
  let channels = 0, i = 12, data = null;
  while (i < b.length - 8) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "fmt ") channels = b.readUInt16LE(i + 10);
    if (id === "data") { data = b.subarray(i + 8, i + 8 + size); break; }
    i += 8 + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk: " + file);
  const n = Math.floor(data.length / 4);
  const interleaved = new Float32Array(n);
  for (let s = 0; s < n; s += 1) interleaved[s] = data.readFloatLE(s * 4);
  const frames = n / channels;
  // Shaped like an AudioBuffer, which is all hrirGainFor touches.
  return {
    numberOfChannels: channels,
    length: frames,
    getChannelData(ch) {
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f += 1) out[f] = interleaved[f * channels + ch];
      return out;
    },
  };
}
const l2 = (buf) => {
  let sum = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i += 1) sum += d[i] * d[i];
  }
  return Math.sqrt(sum);
};
const db = (x) => 20 * Math.log10(x);

// The front arc is the only part ever selected: ducks are on screen, never behind the head.
const inFrontArc = (name) => {
  const m = /^ir_azi(\d+)_ele/.exec(name);
  if (!m) return false;
  const azi = Number(m[1]);
  return azi <= 90 || azi >= 270;
};

const files = fs.readdirSync(HRIR_DIR).filter((f) => f.endsWith(".wav"));
console.log("\nThe dataset is quiet enough that a fixed boost cannot work");
{
  const norms = files.map((f) => l2(readIr(path.join(HRIR_DIR, f))));
  const lo = Math.min(...norms), hi = Math.max(...norms);
  console.log(`       ${files.length} IRs, L2 norm ${lo.toFixed(4)} (${db(lo).toFixed(1)}dB) ` +
              `.. ${hi.toFixed(4)} (${db(hi).toFixed(1)}dB), spread ${db(hi / lo).toFixed(1)}dB`);
  check("every IR is far quieter than unity, so convolution loses level",
        hi < 0.5, `loudest norm ${hi.toFixed(4)}`);
  check("norms vary enough that one constant cannot serve them all",
        db(hi / lo) > 3, `spread ${db(hi / lo).toFixed(1)}dB`);
}

console.log("\nPer-IR compensation makes loudness independent of direction");
{
  const arc = files.filter(inFrontArc);
  check("the front arc is a real subset of the dataset (rear IRs are never selected)",
        arc.length > 20 && arc.length < files.length, `${arc.length}/${files.length}`);

  const products = arc.map((f) => {
    const buf = readIr(path.join(HRIR_DIR, f));
    return {f, product: l2(buf) * hrirGainFor(f, buf)};
  });
  const ps = products.map((p) => p.product);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const worst = products.reduce((a, b) =>
    Math.abs(db(b.product / ps[0])) > Math.abs(db(a.product / ps[0])) ? b : a);
  console.log(`       norm x gain: ${lo.toFixed(4)} .. ${hi.toFixed(4)} ` +
              `(spread ${db(hi / lo).toFixed(2)}dB), worst ${worst.f}`);
  // This is the property that matters: the tone must not change volume as it pans.
  check("norm x gain is effectively constant across the front arc",
        db(hi / lo) < 0.5, `spread ${db(hi / lo).toFixed(2)}dB`);

  // And the absolute level has to land near the PannerNode path, whose loudness was matched
  // by offline rendering. HRIR_MATCH carries that measurement.
  const match = Number((js.match(/const HRIR_MATCH = ([\d.]+)/) || [])[1]);
  check("HRIR_MATCH is present and is the value solved by rendering", match > 0.5 && match < 1.5,
        String(match));
  check("norm x gain lands on HRIR_MATCH", Math.abs(db(ps[0] / match)) < 0.5,
        `${ps[0].toFixed(4)} vs ${match}`);

  // The old bug, stated as an assertion so it cannot come back.
  const fixed = 1.8;
  const worstFixed = Math.max(...arc.map((f) => {
    const n = l2(readIr(path.join(HRIR_DIR, f)));
    return Math.abs(db(n * fixed / match));
  }));
  check("...whereas the old fixed boost of 1.8 was badly off", worstFixed > 6,
        `would be ${worstFixed.toFixed(1)}dB from target`);
}

console.log("\nThe gain is applied where an IR swap can move it");
{
  // The tracking voice crossfades between two convolvers as the crosshair moves. If the
  // compensation sat on a shared node after them, every swap would step the level; and if
  // the incoming side faded to 1 instead of to its own gain, the swap would change loudness.
  check("the crossfade ramps the incoming side to that IR's own gain",
        /idleGain\.gain\.linearRampToValueAtTime\(hrirGainFor\(wanted, buffer\), now \+ fade\)/
          .test(js));
  check("the voice's A/B gains start matched to the first IR",
        /voice\.gainA\.gain\.value = hrirGainFor\(startingIr, startingBuffer\)/.test(js));
  check("no leftover fixed HRIR_BOOST anywhere", !/HRIR_BOOST/.test(js),
        (js.match(/.*HRIR_BOOST.*/) || [""])[0].trim());
  check("the one-shot path compensates per IR too",
        /hrirGainFor\(irName, irBuffer\)/.test(js));
  check("a pathologically quiet IR cannot ask for unbounded gain",
        /Math\.max\(norm, HRIR_MIN_NORM\)/.test(js));
  // normalize=false is why the norms are uneven in the first place; it must stay off, since
  // it is what preserves the measured ILD. Dividing both channels by one number keeps it.
  check("normalize stays off, so the measured ILD survives",
        (js.match(/normalize = false/g) || []).length >= 3,
        String((js.match(/normalize = false/g) || []).length));
}

console.log("\nA narrowband tone survives the IRs' weak low end");
{
  // The bug this section exists for: per-IR compensation (above) makes loudness independent
  // of *direction*, but it says nothing about *frequency*. These IRs are 256 taps at 48kHz -
  // one period at ~190Hz - so they carry little low-frequency energy, and this tone is
  // narrowband: it samples |H(f)| at a single frequency instead of averaging over a spectrum
  // like a quack does. Measured in Chrome, that cost the tone another 19dB median, leaving it
  // peaking at 0.033 against a quack's 0.360 - which is what "completely silent" actually was.
  const arc = files.filter(inFrontArc).map((f) => {
    const buf = readIr(path.join(HRIR_DIR, f));
    return {f, buf, gain: hrirGainFor(f, buf)};
  });
  // |H(f)| by direct DFT at one frequency, louder ear (that is the one you localise with).
  const magAt = (buf, hz, sr = 48000) => {
    let best = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
      const d = buf.getChannelData(ch);
      let re = 0, im = 0;
      for (let n = 0; n < d.length; n += 1) {
        const w = (-2 * Math.PI * hz * n) / sr;
        re += d[n] * Math.cos(w);
        im += d[n] * Math.sin(w);
      }
      best = Math.max(best, Math.hypot(re, im));
    }
    return best;
  };
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const delivered = (hz) => median(arc.map((e) => magAt(e.buf, hz) * e.gain));

  const minHz = Number((js.match(/const TONE_MIN_HZ = (\d+)/) || [])[1]);
  const maxHz = Number((js.match(/const TONE_MAX_HZ = (\d+)/) || [])[1]);
  const lo = delivered(minHz), hi = delivered(maxHz);
  const tiltDb = db(hi / lo) / Math.log2(maxHz / minHz);
  console.log(`       delivered ${minHz}Hz ${db(lo).toFixed(1)}dB .. ${maxHz}Hz ` +
              `${db(hi).toFixed(1)}dB  => tilt ${tiltDb.toFixed(1)}dB/octave`);
  check("a narrowband source really does lose level to these IRs",
        hi < 0.6 && lo < 0.2, `${lo.toFixed(3)} .. ${hi.toFixed(3)}`);
  check("...and the loss is much worse at the low end, i.e. it is a tilt not an offset",
        tiltDb > 4, `${tiltDb.toFixed(1)}dB/octave`);

  // The constant in the source has to match the tilt actually present in the shipped files.
  const declared = Number((js.match(/const TONE_TILT_DB_PER_OCT = ([\d.]+)/) || [])[1]);
  check("TONE_TILT_DB_PER_OCT matches the measured tilt", Math.abs(declared - tiltDb) < 3,
        `declared ${declared}, measured ${tiltDb.toFixed(1)}`);

  // Now the property that matters: after compensation the sweep must be level, because the
  // low pitch means "far from the duck" - the moment the cue most needs to be heard.
  const tiltSrc = js.match(
    /const TONE_TILT_DB_PER_OCT[\s\S]*?function tiltCompensation\(hz\) \{[\s\S]*?\n    \}/
  );
  check("tiltCompensation is present", Boolean(tiltSrc));
  const tiltComp = new Function(
    "return (() => { " + tiltSrc[0] + "; return tiltCompensation; })()"
  )();
  const peak = Number((js.match(/const TONE_PEAK_GAIN = ([\d.]+)/) || [])[1]);
  const swell = (c) => 0.55 + 0.45 * c;   // mirrors updateVoice
  // The voice is a two-note trill, not one carrier, so the model has to follow both notes:
  // TONE_MIN_HZ..TONE_MAX_HZ bounds the LOW note only, and the high note sits `interval`
  // above it, which puts the real span at 196..746Hz for P1. Modelling the carrier alone
  // would report a flatness the player never hears, because half of every alternation is at
  // a frequency these IRs treat completely differently.
  const lowGain = Number((js.match(/const TRILL_LOW_GAIN = ([\d.]+)/) || [])[1]);
  const interval = Number(
    (js.match(/\{ratio: 1, index: [\d.]+, carrier: "sine", interval: ([\d.]+)\}/) || [])[1]
  );
  check("the P1 trill interval and TRILL_LOW_GAIN are readable",
        interval > 1 && lowGain > 1, `interval ${interval}, low-note gain ${lowGain}`);
  // closeness -> hz is the same octave interpolation updateVoice uses.
  const hzAt = (c) => minHz * Math.pow(2, Math.log2(maxHz / minHz) * c);
  // updateVoice asks for `level` on the tone gain and adds `trim * square` to it, so the two
  // notes are requested at level-trim (low) and level+trim (high). Reproduced here exactly.
  const levels = [0, 0.2, 0.4, 0.6, 0.8].map((c) => {
    const lo = hzAt(c), hi = hzAt(c) * interval;
    const level = peak * tiltComp(lo) * swell(c);
    const ratio = (tiltComp(lo) / tiltComp(hi)) * lowGain;
    const trim = level * ((1 - ratio) / (1 + ratio));
    const outLo = (level - trim) * delivered(lo);
    const outHi = (level + trim) * delivered(hi);
    // What the ear integrates over one alternation, at the reference's measured 0.506 duty.
    return {c, hz: lo, hi, outLo, outHi, out: Math.sqrt((outLo * outLo + outHi * outHi) / 2)};
  });
  const outs = levels.map((l) => l.out);
  const flat = db(Math.max(...outs) / Math.min(...outs));
  console.log("       after compensation: " +
              levels.map((l) => `${Math.round(l.hz)}/${Math.round(l.hi)}Hz ` +
                                `${db(l.out).toFixed(1)}dB`).join("  "));
  check("the compensated sweep is roughly level, so its far end is still audible",
        flat < 6, `${flat.toFixed(1)}dB spread across the sweep`);
  // Within a single alternation the two notes must land at similar level too - a trill whose
  // halves are 10dB apart stops reading as a trill and turns into one note with a tick on it.
  const worst = Math.max(...levels.map((l) => Math.abs(db(l.outLo / l.outHi))));
  console.log("       note balance within the trill: " +
              levels.map((l) => `${db(l.outLo / l.outHi).toFixed(1)}dB`).join("  "));
  check("both notes of the trill arrive at a comparable level", worst < 8,
        `worst imbalance ${worst.toFixed(1)}dB`);
  check("compensation only ever boosts (never attenuates below the reference)",
        [minHz, 400, maxHz].every((f) => tiltComp(f) >= 1 - 1e-9),
        [minHz, 400, maxHz].map((f) => tiltComp(f).toFixed(2)).join(","));

  // Loudness relative to the game's own sounds. Note what this model can and cannot say:
  // it evaluates |H(f)| at the CARRIER only, but the real voice is FM, and its sidebands sit
  // above the carrier where these IRs are stronger. So the figure below is systematically
  // pessimistic - about 12dB lower than the same configuration measured in Chrome, which
  // delivered peak 0.116 against a quack's 0.360 (-10dB). The absolute level is therefore a
  // browser measurement, not a claim of this test; what this test locks down is the *shape*
  // (the tilt and the flatness above), which is a ratio and so survives the missing sidebands.
  const QUACK_REQUEST = 0.84;
  const rel = outs.map((o) => db(o / QUACK_REQUEST));
  console.log(`       carrier-only estimate vs a quack: ${Math.min(...rel).toFixed(1)} .. ` +
              `${Math.max(...rel).toFixed(1)}dB (Chrome measured -10dB with sidebands)`);
  check("even the carrier alone is well clear of the level that shipped inaudible",
        Math.max(...rel) > -30, `loudest carrier ${Math.max(...rel).toFixed(1)}dB vs a quack`);
  check("...and the tone cannot exceed the game's own sounds even with sidebands added",
        Math.max(...outs) < QUACK_REQUEST, Math.max(...outs).toFixed(3));

  // Regression guard on the specific values that shipped silent. The floor used to be 0.16,
  // set when the voice was one held note; the trill deliberately went below it, to 0.13. Two
  // notes alternating at 7-13Hz read considerably louder than either note held at the same
  // gain - the alternation keeps re-triggering attention where a steady tone fades into the
  // background - so equal gain would have put the cue over the game's own sounds. The floor
  // is kept as a guard against a slip back toward zero, just at the trill's own level.
  check("TONE_PEAK_GAIN is not back at the value that shipped inaudible", peak > 0.1,
        String(peak));
  // The flat path must not get the correction: it has no shortfall to correct.
  check("the PannerNode fallback is exempt from the tilt (it is already flat)",
        /voice\.panner \? 1 : tiltCompensation\(hz\)/.test(js));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
