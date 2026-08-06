#!/usr/bin/env node
/**
 * Miss-sound test.
 *
 * The aim tone tells the player they are getting closer and then goes silent at lock-on.
 * shot_miss is the other half of that conversation: it answers a shot that found nothing.
 * Modelled on Duck_Sound_Deisgn/Didn't_Hit_00.wav.
 *
 * Three things are checked, because each has its own way of failing silently:
 *   1. the JS side  - the sound is registered, has a gain, and is spatialized like the
 *                     duck sounds rather than played flat
 *   2. the asset    - assets/sfx/shot_miss.mp3 exists, is short, is mono, and is NOT
 *                     silent (an earlier cut came out at -91dB because a single-pass
 *                     loudnorm on a 0.27s clip has no idea what to normalise to, and
 *                     nothing in the build would have noticed)
 *   3. the GD side  - a miss fires the cue in single player, party mode and the intro
 *                     screen, and a HIT does not
 *
 * Usage: node tools/test_shot_miss.js
 */
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");

const ROOT = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(ROOT, "gripball_webhid.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "main.gd.reference"), "utf8");
const MP3 = path.join(ROOT, "assets", "sfx", "shot_miss.mp3");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? "  -> " + detail : ""}`); }
}

console.log("\nThe sound is wired into the spatial audio bridge");
{
  check("shot_miss has a URL", /shot_miss: "assets\/sfx\/shot_miss\.mp3"/.test(js));
  const gains = js.match(/const SOUND_GAINS = \{[\s\S]*?\};/);
  check("SOUND_GAINS exists", Boolean(gains));
  // Every named sound needs an entry, or play() silently falls back to the default and the
  // mix balance quietly stops being what the table says it is.
  const urls = [...js.matchAll(/^\s{6}(\w+): "assets\/sfx\/[\w.]+",$/gm)].map((m) => m[1]);
  check("every sound in SOUND_URLS has a gain",
        urls.length >= 5 && urls.every((n) => new RegExp(`\\b${n}: [\\d.]+,`).test(gains[0])),
        urls.filter((n) => !new RegExp(`\\b${n}: [\\d.]+,`).test(gains[0])).join(",") || `${urls.length} sounds`);
  const missGain = Number((gains[0].match(/shot_miss: ([\d.]+)/) || [])[1]);
  const quackGain = Number((gains[0].match(/quack: ([\d.]+)/) || [])[1]);
  // It fires in the same frame as the (unspatialized, full-level) shotgun blast, so it
  // cannot be mixed as the incidental sound it dramatically is.
  check("shot_miss sits near a quack in the mix, not below it",
        missGain >= quackGain * 0.9 && missGain <= 1,
        `miss ${missGain} vs quack ${quackGain}`);

  // The whole point of the request is that the miss comes from where the player aimed.
  // play() spatializes everything it plays, so what matters is that shot_miss goes through
  // play() and is not special-cased out of it.
  check("play() spatializes whatever it is given",
        /const envelope = spatialize\(source, vector, options\);/.test(js));
  check("shot_miss is not routed around the spatializer",
        !/shot_miss[\s\S]{0,200}master\.connect|connect\(master\)[\s\S]{0,80}shot_miss/.test(js));

  // Party Mode: four players, one sample, simultaneous shots.
  const rates = js.match(/const MISS_RATES = \[([^\]]*)\]/);
  check("MISS_RATES gives each player their own pitch", Boolean(rates));
  const values = rates[1].split(",").map((s) => Number(s.trim()));
  check("there is one rate per party player", values.length === 4, values.join(","));
  check("the rates are all distinct", new Set(values).size === values.length, values.join(","));
  check("...and stay within a musical semitone or two of the recording",
        values.every((v) => v > 0.85 && v < 1.2), values.join(","));
  // A variant index out of range must wrap rather than yield undefined - playbackRate
  // rejects undefined, which would throw inside play() and take the sound out entirely.
  check("the variant index is wrapped, not indexed raw",
        /% MISS_RATES\.length\) \+\s*\n?\s*MISS_RATES\.length\) % MISS_RATES\.length/.test(js) ||
        /MISS_RATES\.length\) \+[\s\S]{0,60}\) % MISS_RATES\.length/.test(js));
  check("a non-numeric variant falls back rather than producing NaN",
        /Number\.isFinite\(index\)/.test(js));
  check("play() takes the variant as a parameter",
        /async function play\(name, x, y, vw, vh, variant\)/.test(js));
}

console.log("\nThe asset is present, short, and actually audible");
{
  check("assets/sfx/shot_miss.mp3 exists", fs.existsSync(MP3));
  if (fs.existsSync(MP3)) {
    const size = fs.statSync(MP3).size;
    check("it is a real file, not a stub", size > 1000, `${size} bytes`);
    let ffmpeg = true;
    try { execFileSync("ffprobe", ["-version"], {stdio: "ignore"}); }
    catch { ffmpeg = false; }
    if (!ffmpeg) {
      console.log("       (ffprobe not on PATH - skipping the audio content checks)");
    } else {
      const probe = (args) =>
        execFileSync("ffprobe", ["-v", "error", ...args, "-of", "default=nw=1:nk=1", MP3])
          .toString().trim().split("\n");
      const duration = Number(probe(["-show_entries", "format=duration"])[0]);
      const channels = Number(probe(["-show_entries", "stream=channels"])[0]);
      // A one-shot cue that fires on every miss: any longer and consecutive shots overlap
      // into a smear rather than reading as one answer per trigger.
      check("it is a short one-shot", duration > 0.15 && duration < 0.5,
            `${duration.toFixed(3)}s`);
      // The HRIR path takes the mean of the channels anyway (makeMonoBuffer), so a stereo
      // file would just be wasted bytes - and the reference take's own L/R differ (corr
      // 0.827), which is a stereo image that would fight the HRIR's.
      check("it is mono, as the convolver path wants", channels === 1, `${channels}ch`);

      // The regression that motivated this file: loudnorm on a sub-second clip produced a
      // -91dB "sound". Decode and measure rather than trusting the encode.
      const raw = execFileSync("ffmpeg",
        ["-v", "error", "-i", MP3, "-ac", "1", "-f", "f32le", "-ar", "44100", "-"],
        {maxBuffer: 1 << 26});
      const pcm = new Float32Array(raw.buffer, raw.byteOffset,
                                   Math.floor(raw.length / 4));
      let peak = 0, sum = 0;
      for (let i = 0; i < pcm.length; i += 1) {
        const a = Math.abs(pcm[i]);
        if (a > peak) peak = a;
        sum += pcm[i] * pcm[i];
      }
      const rms = Math.sqrt(sum / pcm.length);
      const db = (v) => 20 * Math.log10(v);
      console.log(`       peak ${peak.toFixed(3)} (${db(peak).toFixed(1)}dB)  ` +
                  `rms ${rms.toFixed(4)} (${db(rms).toFixed(1)}dB)`);
      check("it is not the silent cut that loudnorm produced", db(rms) > -30,
            `${db(rms).toFixed(1)}dB rms`);
      check("...and it uses the available headroom", db(peak) > -3,
            `${db(peak).toFixed(1)}dB peak`);

      // The reference take's shape: an instantaneous attack, then down 20dB by ~130ms.
      // That collapse is what makes it read as a negative answer, so it has to survive
      // the cut - a clip that decays slowly sounds like a hit.
      const at = (t) => Math.min(pcm.length - 1, Math.round(t * 44100));
      const window = (t0, t1) => {
        let s = 0, n = 0;
        for (let i = at(t0); i < at(t1); i += 1) { s += pcm[i] * pcm[i]; n += 1; }
        return n ? Math.sqrt(s / n) : 0;
      };
      // Leading silence is latency on a cue that answers a trigger pull, and it is easy to
      // introduce by cutting from the wrong place: the transient in Didn't_Hit_00.wav starts
      // at 0.3579s, not at the 0.330s the waveform overview suggests, and an -ss of 0.330
      // put 36ms of dead air in front of the attack.
      let onset = pcm.length;
      for (let i = 0; i < pcm.length; i += 1) {
        if (Math.abs(pcm[i]) > 0.05) { onset = i; break; }
      }
      const onsetMs = (onset / 44100) * 1000;
      console.log(`       onset ${onsetMs.toFixed(1)}ms into the clip`);
      check("there is no leading silence to delay the cue", onsetMs < 8,
            `${onsetMs.toFixed(1)}ms of dead air before the attack`);

      const head = window(0, 0.02);
      const tail = window(0.15, 0.22);
      check("the attack is at the very front of the clip", head > rms * 0.8,
            `first 20ms ${db(head).toFixed(1)}dB vs whole ${db(rms).toFixed(1)}dB`);
      check("it decays hard, the way the reference does", db(head / tail) > 8,
            `${db(head / tail).toFixed(1)}dB down by 150-220ms`);
    }
  }
}

console.log("\nA miss triggers it; a hit does not");
{
  const helper = main.match(/func _play_web_shot_miss\([\s\S]*?\n\n/);
  check("_play_web_shot_miss exists", Boolean(helper));
  check("it goes through the same bridge as the duck sounds",
        /window\.duckHuntSpatialAudio\.play\(\\"shot_miss\\"/.test(helper[0]));
  check("it sends the viewport size, not window.innerWidth",
        /get_viewport\(\)\.get_visible_rect\(\)\.size/.test(helper[0]));
  check("it passes the player id through as the pitch variant",
        /maxi\(player_id, 0\)/.test(helper[0]));
  check("it is web-only, like the aim tone it answers",
        /if not OS\.has_feature\("web"\):\s*\n\s*return false/.test(helper[0]));

  // Single player. The subtle part: duck_hit stays true for the rest of the round and is
  // also forced true when the duck node has gone, so "not duck_hit" is NOT the miss test.
  // A shot only connected if it flipped the flag itself.
  check("single player captures the hit state BEFORE the shot resolves",
        /var _was_hit := false[\s\S]{0,200}_was_hit = duck\.duck_hit[\s\S]{0,400}create_timer\(0\.01\)/.test(main));
  check("...and only treats a flag it flipped itself as a hit",
        /if not \(_duck_alive and _duck_hit and not _was_hit\):\s*\n\s*_play_web_shot_miss\(_shot_at\)/.test(main));
  check("...capturing the aim position before the await too",
        /var _shot_at := _shot_position\(event\)[\s\S]{0,300}create_timer\(0\.01\)/.test(main));

  // Position. Gripball shots arrive as synthetic mouse events carrying virtual_position,
  // so the event is the right source for both input paths.
  const shotPos = main.match(/func _shot_position\([\s\S]*?\n\n/);
  check("_shot_position exists", Boolean(shotPos));
  check("it reads the event, so Gripball and mouse both work",
        /event is InputEventMouse/.test(shotPos[0]));
  check("it has a fallback for events with no position",
        /get_viewport\(\)\.get_mouse_position\(\)/.test(shotPos[0]));

  // Party Mode: the miss is placed at the crosshair, not at the duck. The hitbox test itself has
  // moved into _party_duck_at(), which sweeps the whole shared flock - a shot is no longer looked
  // up by the shooter at all (that gate was a bug; see test_intro_and_dog.js). So what matters
  // here is that finding nothing still answers, and answers at the crosshair.
  check("party mode plays the miss when nothing was under the crosshair",
        /func _party_duck_at\([\s\S]*?has_point\(collision\.to_local\(aim_position\)\)/.test(main) &&
        /var target_duck = _party_duck_at\(aim_position\)\s*\n\s*if target_duck:[\s\S]{0,900}\n\telse:\s*\n(?:\s*#[^\n]*\n)*\s*_play_web_shot_miss\(aim_position, player_id\)/
          .test(main));
  // Losing the race to another player is a miss as far as this cue goes: the shot did travel and
  // did land on nothing scoreable, and silence there would read as a hit that failed to register.
  check("...and when another player got to that duck first",
        /if target_duck\.duck_hit:\s*\n(?:\s*#[^\n]*\n)*\s*_play_web_shot_miss\(aim_position, player_id\)/
          .test(main));
  // Intro screen: where the aim tone is heard for the first time.
  check("the intro screen answers misses too",
        /var intro_landed := false/.test(main) &&
        /if not intro_landed:\s*\n\s*_play_web_shot_miss\(aim_position, player_id\)/.test(main));
  check("...and marks the hit case so it stays quiet",
        /intro_landed = true\s*\n\s*intro_players_hit\[player_id\] = true/.test(main));

  // main.gd only exists inside index.pck, so it has to be a patchable source or none of
  // the above ships.
  const patch = fs.readFileSync(path.join(ROOT, "tools", "patch_pck.py"), "utf8");
  check("main.gd.reference is in patch_pck.py's replacement list",
        /"main\.gd\.reference": "res:\/\/scenes\/main\.gd"/.test(patch));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
