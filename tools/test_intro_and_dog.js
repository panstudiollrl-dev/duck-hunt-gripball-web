#!/usr/bin/env node
/**
 * Intro screen escape routes, and the dog retrieving the duck.
 *
 * Both of these are things Pan reported on 2026-08-05:
 *
 *   畫面卡在開頭打兩隻鴨子的地方 / 有一顆握力球做什麼都沒反應 進不了正式遊戲
 *   我記得 先前版本都把狗抓到鴨子的橋段刪掉了 但其實那很可愛
 *
 * The lock-up was structural rather than a slip. _show_intro_screen() awaited
 * intro_screen_continued, and that signal was emitted only when EVERY entry in
 * intro_players_hit was true. A grip ball counts as a player the moment it enrols, so a ball
 * that streams pressure but never crosses its engage bar still got an intro duck - and nobody
 * could shoot it. There was no timeout, no skip and no way back: the game was simply over
 * before it started. So what is asserted here is that a bare `await intro_screen_continued`
 * cannot come back, in any of the paths that reach the title card.
 *
 * main.gd only exists inside index.pck and cannot be executed here, so this reads the source.
 * That is a real limit - it checks that the escape routes are wired, not that Godot runs them -
 * which is why each check targets the specific shape that failed rather than merely the presence
 * of a keyword.
 *
 * Usage: node tools/test_intro_and_dog.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "main.gd.reference"), "utf8");
const input = fs.readFileSync(path.join(ROOT, "gripball_input.gd.reference"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "gripball_webhid.js"), "utf8");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? "  -> " + detail : ""}`); }
}

/** The body of a GDScript function, by indentation: from `func name` to the next `func` at col 0. */
function func(src, name) {
  const start = src.search(new RegExp(`^func ${name}\\(`, "m"));
  if (start < 0) return null;
  const rest = src.slice(start + 1);
  const end = rest.search(/^func /m);
  return end < 0 ? src.slice(start) : src.slice(start, start + 1 + end);
}

console.log("\nThe intro screen can always be left");
{
  const show = func(main, "_show_intro_screen");
  check("_show_intro_screen exists", Boolean(show));
  // The bug itself. In party mode the wait must go through the guarded helper; a bare await on
  // the signal is unrecoverable, because the only thing that emits it is the all-hit branch.
  check("party mode does not await the raw signal",
        /if party_mode:\s*\n(?:\s*#[^\n]*\n)*\s*await _await_intro_continue\(\)\s*\n\s*else:\s*\n\s*await intro_screen_continued/
          .test(show),
        "the party path must go through _await_intro_continue()");

  const wait = func(main, "_await_intro_continue");
  check("_await_intro_continue exists", Boolean(wait));
  check("it arms a timer alongside the signal",
        /create_timer\(INTRO_PARTY_TIMEOUT_SEC\)/.test(wait));
  check("it connects that timer to something that actually continues",
        /timeout\.connect\(_on_intro_party_timeout\)/.test(wait));
  // A single await would return on the first emission even if the game is not meant to continue
  // yet; the loop is what makes intro_continue_done the authority.
  check("it waits until the screen is really finished, not just for one emission",
        /while not intro_continue_done:\s*\n\s*await intro_screen_continued/.test(wait));

  const timeout = func(main, "_on_intro_party_timeout");
  check("the timeout handler finishes the screen rather than only printing",
        Boolean(timeout) && /_finish_intro_screen\(\)/.test(timeout),
        "this is the mistake _on_intro_screen_timeout() already makes");
  check("...and says why, so a stuck ball is diagnosable",
        /push_warning\(/.test(timeout) && /_intro_players_waiting\(\)/.test(timeout));

  // The old handler is still in the file and still only prints. That is fine - it belongs to the
  // pre-duck delay timer, not to the continue wait - but it must not be mistaken for the escape.
  const old = func(main, "_on_intro_screen_timeout");
  check("the pre-existing print-only timeout handler is a different timer",
        Boolean(old) && !/_finish_intro_screen/.test(old) &&
        /intro_screen_timer\.start\(\)/.test(func(main, "_show_intro_screen")));
}

console.log("\nOnly players who can actually shoot are waited for");
{
  const required = func(main, "_intro_required_players");
  check("_intro_required_players exists", Boolean(required));
  check("it asks GripballInput which balls have been proven",
        /GripballInput\.players_proven/.test(required));
  // The degenerate case matters as much as the main one: a moment after the screen appears
  // nobody has pressed anything, and dropping the requirement then would skip the intro instantly.
  check("with nobody proven yet it still requires everyone",
        /if proven\.is_empty\(\):\s*\n\s*return intro_players_hit\.keys\(\)/.test(required));

  const shot = func(main, "_on_gripball_player_shot");
  check("the all-hit gate iterates the required players, not every enrolled one",
        /for required_id in _intro_required_players\(\):\s*\n\s*if not bool\(intro_players_hit\.get\(required_id, false\)\):/
          .test(shot),
        "iterating intro_players_hit.values() is what waited on a dead ball");
  // Second backstop: one duck down proves the input path works, so anyone still missing after
  // that is hardware, not hesitation.
  check("a partial hit starts the grace period",
        /else:\s*\n(?:\s*#[^\n]*\n)*\s*_start_intro_grace\(\)/.test(shot));
  const grace = func(main, "_on_intro_grace_timeout");
  check("the grace period also finishes the screen",
        Boolean(grace) && /_finish_intro_screen\(\)/.test(grace));
  check("the grace period is shorter than the overall timeout",
        Number((main.match(/INTRO_PARTY_GRACE_SEC = ([\d.]+)/) || [])[1]) <
        Number((main.match(/INTRO_PARTY_TIMEOUT_SEC = ([\d.]+)/) || [])[1]),
        "a grace period longer than the timeout would never fire");
  const start = func(main, "_start_intro_grace");
  check("the grace timer is single-flight, so four players do not arm four of them",
        Boolean(start) && /if intro_continue_done or intro_grace_timer != null:\s*\n\s*return/.test(start));

  // And a human escape, because a player cannot know a timeout is coming.
  check("a key press skips the title card too",
        /is_action_pressed\("ui_accept"\)[\s\S]{0,200}_finish_intro_screen\(\)/.test(main));
}

console.log("\nContinuing is idempotent");
{
  // Three things can now reach the exit (last duck, grace timer, overall timeout) and any two
  // can be in flight at once. A second intro_screen_continued would land in the started game,
  // where _show_intro_screen() is no longer listening - so it would be silently lost, or worse,
  // caught by a later await.
  const finish = func(main, "_finish_intro_screen");
  check("_finish_intro_screen exists", Boolean(finish));
  check("it returns early once the screen has been left",
        /if intro_continue_done:\s*\n\s*return/.test(finish));
  check("...and sets the flag before emitting, not after",
        finish.indexOf("intro_continue_done = true") < finish.indexOf("intro_screen_continued.emit()"),
        "emitting first leaves a window for a re-entrant call");
  check("it is the only thing that emits the continue signal in the party path",
        (main.match(/intro_screen_continued\.emit\(\)/g) || []).length === 2,
        "one in _finish_intro_screen, one in the single-player _on_next_duck path");
  check("the guards use get_node_or_null, since the nodes may be gone by timeout",
        /get_node_or_null\("AnimationPlayer"\)/.test(finish) &&
        /get_node_or_null\("ContinueLabel"\)/.test(finish));
}

console.log("\nA grip ball is only counted once it has proven itself");
{
  // The JS side of the same story: enrolment is not evidence. player_proven is emitted on the
  // first press that crosses the (now per-ball) engage bar.
  check("estimateGrip announces the first real press",
        /if \(!player\.proven\) \{[\s\S]{0,300}emit\(\{type: "player_proven", player: player\.playerId\}\)/
          .test(js));
  check("...from inside the engage branch, not on any reading",
        /} else if \(force >= engageForce\) \{[\s\S]{0,400}player\.proven = true/.test(js));
  check("makePlayer starts a ball unproven", /proven: false,/.test(js));
  // The bar is per ball now, which is the actual fix for "one ball does nothing": a single fixed
  // bar is above what some balls can physically produce. test_quick_start.js asserts the
  // behaviour; this just checks the wiring is in the live path.
  check("the engage bar is resolved per ball", /const engageForce = engageForceFor\(player\);/.test(js));
  check("...and the release bar follows the bar in use, not the configured one",
        /engageForce \* QUICK_RELEASE_RATIO/.test(js),
        "a scaled-down bar under a fixed release value would release the instant it engaged");

  // Keyboard test players never reach estimateGrip, so they prove themselves on the track key.
  // Without that, holding A/K and shooting the intro duck would still hang the title card - the
  // same deadlock arriving by the other input path.
  check("keyboard players prove themselves too",
        /if \(pressed && !player\.proven\) \{[\s\S]{0,200}emit\(\{type: "player_proven", player: control\.player\}\)/
          .test(js));

  check("gripball_input relays player_proven", /message\.get\("type"\) == "player_proven"/.test(input));
  check("...into a dictionary main.gd can read", /players_proven\[proven_id\] = true/.test(input));
  check("...and declares the signal", /signal player_proven\(player_id: int\)/.test(input));
  check("...recording it only once per player",
        /if not players_proven\.has\(proven_id\):/.test(input));
  // The JS side re-indexes on every connect/disconnect, so a stored id means a different ball
  // afterwards. Stale flags would credit a fresh ball with proven-ness it has not earned.
  check("...and discarding the flags when the player count changes",
        /players_proven\.clear\(\)/.test(input));
}

console.log("\nThe dog still retrieves the duck");
{
  // Not deleted, just switched off: _ready() cleared present_hit_duck for the whole of party
  // mode, which is every Gripball game.
  const ready = func(main, "_ready");
  check("party mode no longer disables the retrieval",
        /if party_mode:[\s\S]{0,900}present_hit_duck = true/.test(ready),
        "present_hit_duck = false here is what removed the dog");
  // The pre-duck sniff-and-jump is a different thing and stays off: _ready() awaits it, so it
  // would hold four players on a static screen before anything happens.
  check("the pre-round dog intro stays off, since _ready awaits it",
        /if party_mode:[\s\S]{0,900}play_dog_intro = false/.test(ready));
  check("_dog_present_duck is still present", Boolean(func(main, "_dog_present_duck")));

  const next = func(main, "_on_next_duck");
  check("the party branch now calls it", /_present_hit_duck_async\(_duck_hit_position, _duck_type\)/.test(next),
        "the party branch returned before ever reaching the single-player call");
  check("...only for a duck that was actually hit",
        /if active_duck\.duck_hit:[\s\S]{0,400}_present_hit_duck_async/.test(next));
  check("...and gated on present_hit_duck, so the flag still means something",
        /if present_hit_duck:\s*\n\s*_present_hit_duck_async/.test(next));
  // The await is the trap here: in party mode each player has their own respawn clock, so
  // awaiting a ~1.7s animation would stall that player's next duck every single time.
  check("it is not awaited, so it cannot stall a player's next duck",
        !/await _present_hit_duck_async/.test(next),
        "awaiting this in party mode delays every respawn by the animation length");

  const async = func(main, "_present_hit_duck_async");
  check("_present_hit_duck_async exists", Boolean(async));
  check("it is single-flight, because there is only one dog",
        /if dog_presenting:\s*\n\s*return/.test(async),
        "two overlapping runs fight over dog_node.position and strand the dog");
  check("...and clears the flag afterwards, so the second duck gets a dog",
        /await _dog_present_duck\([\s\S]*?dog_presenting = false/.test(async));
  check("the flag is declared", /var dog_presenting := false/.test(main));
}

console.log("\nmain.gd and gripball_input.gd actually ship");
{
  const patch = fs.readFileSync(path.join(ROOT, "tools", "patch_pck.py"), "utf8");
  check("main.gd.reference is packed", /"main\.gd\.reference": "res:\/\/scenes\/main\.gd"/.test(patch));
  check("gripball_input.gd.reference is packed",
        /"gripball_input\.gd\.reference": "res:\/\/scenes\/gripball_input\.gd"/.test(patch));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
