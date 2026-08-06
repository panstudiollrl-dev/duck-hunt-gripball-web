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
  check("the party branch now calls it", /_queue_hit_duck_for_dog\(_duck_hit_position, _duck_type\)/.test(next),
        "the party branch returned before ever reaching the single-player call");
  check("...only for a duck that was actually hit",
        /if active_duck\.duck_hit:[\s\S]{0,600}_queue_hit_duck_for_dog/.test(next));
  check("...and gated on present_hit_duck, so the flag still means something",
        /if present_hit_duck:\s*\n\s*_queue_hit_duck_for_dog/.test(next));
  // The await is the trap here: in party mode each player has their own respawn clock, so
  // awaiting a ~1.7s animation would stall that player's next duck every single time.
  check("it is not awaited, so it cannot stall a player's next duck",
        !/await _queue_hit_duck_for_dog/.test(next),
        "awaiting this in party mode delays every respawn by the animation length");
  // Ordering: _increase_ducks_shot() awaits 0.5s (1s on a round's last duck), so queuing after
  // it pushes the dog that much further from the hit it is supposed to be answering.
  check("the dog is queued before the scoreboard delay, not after",
        next.indexOf("_queue_hit_duck_for_dog") < next.indexOf("await _increase_ducks_shot()"),
        "queuing after the await adds 0.5-1s of lag to a cue about a specific moment");

  const queue = func(main, "_queue_hit_duck_for_dog");
  check("_queue_hit_duck_for_dog exists", Boolean(queue));
  check("it records when the duck was hit",
        /"queued_at": Time\.get_ticks_msec\(\) \/ 1000\.0/.test(queue),
        "without a timestamp a backlog cannot be told from a fresh hit");
  check("...and does not start a second drain while one is running",
        /if dog_presenting:\s*\n\s*return\s*\n\s*_drain_dog_present_queue\(\)/.test(queue));
  // Pan, 2026-08-06: 狗太常出來了 可以隨機的間歇式的偶爾出現就好. Rolling at queue time rather
  // than in the drain means a declined duck never occupies the queue at all.
  check("most hits are declined before anything is queued",
        /if not _dog_should_present\(\):\s*\n\s*return\s*\n\s*dog_present_queue\.append/.test(queue),
        "rolling inside the drain would let declines still block the gap check");

  const should = func(main, "_dog_should_present");
  check("_dog_should_present exists", Boolean(should));
  check("it is an actual random roll, not every Nth duck",
        /return randf\(\) < DOG_PRESENT_CHANCE/.test(should));
  check("the chance is occasional rather than usual",
        Number((main.match(/DOG_PRESENT_CHANCE = ([\d.]+)/) || [])[1]) <= 0.35,
        "anything near 1.0 is the常態 Pan asked to get away from");
  // A plain roll clusters: at 0.22 a pair of back-to-back dogs is common enough to read as
  // broken rather than as random, which is what the gap floor is for.
  check("a minimum gap keeps two dogs from landing back to back",
        /now - dog_last_present_time < DOG_PRESENT_MIN_GAP_SEC/.test(should));
  check("...and the first hit of a game is eligible",
        /var dog_last_present_time := -1000\.0/.test(main),
        "starting at 0 would make the gap apply before any dog had appeared");
  // With four players several ducks land at once, so a win already queued has to close the gate
  // too - otherwise two ducks in the same instant both pass and the dog goes twice.
  check("a duck already queued blocks another from winning",
        /if not dog_present_queue\.is_empty\(\):\s*\n\s*return false/.test(should));
  check("...as does a retrieval already running", /if dog_presenting or/.test(should));

  const drain = func(main, "_drain_dog_present_queue");
  check("_drain_dog_present_queue exists", Boolean(drain));
  check("it is single-flight, because there is only one dog",
        /if dog_presenting:\s*\n\s*return/.test(drain),
        "two overlapping runs fight over dog_node.position and strand the dog");
  check("...and clears the flag afterwards, so the next duck gets a dog",
        /dog_presenting = false/.test(drain));
  check("the gap is counted from when a retrieval ended, not when it started",
        /dog_last_present_time = Time\.get_ticks_msec\(\) \/ 1000\.0/.test(drain) &&
        drain.indexOf("await _dog_present_duck") < drain.indexOf("dog_last_present_time ="),
        "stamping at the start would let the ~1.7s animation eat into the gap");
  // The actual complaint: a dog that arrives late is holding a duck the player has stopped
  // thinking about. Dropping the entry is the correct outcome, not deferring it further.
  check("a stale duck is skipped rather than shown late",
        /if age > DOG_PRESENT_MAX_AGE_SEC:[\s\S]{0,200}continue/.test(drain),
        "this is 狗都在不對的時間點爬出來");
  check("...with the age measured from the hit, not from reaching the queue front",
        /var age := \(Time\.get_ticks_msec\(\) \/ 1000\.0\) - float\(entry\.get\("queued_at"/.test(drain),
        "re-stamping on dequeue would let a backlog replay itself in slow motion");
  check("the max age is short enough to still read as 'the duck you just shot'",
        Number((main.match(/DOG_PRESENT_MAX_AGE_SEC = ([\d.]+)/) || [])[1]) <= 3.0);
  check("nothing is presented over the game over sign or the highscore screen",
        /if not game_over_timer\.is_stopped\(\) or intro_screen\.visible:/.test(drain));
  check("the queue is dropped when the game ends",
        /dog_present_queue\.clear\(\)/.test(func(main, "_game_over")) &&
        /dog_present_queue\.clear\(\)/.test(func(main, "_show_highscore_screen")),
        "a queued retrieval would fight _dog_laugh() for the same node");
  check("the flag and the queue are declared",
        /var dog_presenting := false/.test(main) && /var dog_present_queue: Array = \[\]/.test(main));
}

console.log("\nThe title card's ducks cannot score in the round that follows");
{
  // The root cause of the wrong-duck dog. intro_screen's children include the intro ducks, so
  // hide() trips each duck's VisibleOnScreenNotifier2D and emits next_duck one last time - after
  // intro_screen.visible has already gone false. Those emissions fell through into the gameplay
  // branch: points, ducks_shot, a respawn, and a dog holding a title-card duck.
  const next = func(main, "_on_next_duck");
  check("an intro duck emitting after the screen is hidden is ignored",
        /if active_duck\.has_meta\("intro_duck"\) and not intro_screen\.visible:[\s\S]{0,1400}\n\t\treturn\n/
          .test(next),
        "this is the dog that was 根本就不是我們打到的鴨子");
  check("...checked before anything reads the duck's hit position",
        next.indexOf('has_meta("intro_duck")') < next.indexOf("var _duck_hit_position"));
  check("the party intro ducks carry that mark",
        /set_meta\("intro_duck", true\)/.test(func(main, "_spawn_party_intro_ducks")));
  // Single player relies on the opposite behaviour: its intro duck falls off the bottom of the
  // screen while the card is still up, and that emission is what continues the game. A blanket
  // return would break the single-player intro, so the guard is conditional on visible.
  check("single player's intro duck still continues the game",
        /not intro_screen\.visible/.test(next) &&
        /elif intro_screen\.visible:/.test(next),
        "the guard must not fire while the card is still showing");
}

console.log("\nEvery player shoots at the same flock");
{
  // Pan, 2026-08-06: 如果2號鴨子被打到，1號會暫時無法發射，等新的2號鴨子出現才能再開槍 /
  // 我覺得這是嚴重的錯誤 - plus 目前有點太無聊 ... 讓遊戲比較有競爭.
  //
  // Both were the same line of code: party_ducks was keyed by PLAYER, so a shot was looked up as
  // "is your own duck alive". That made the ducks private (four parallel single-player games,
  // nothing to compete over) AND made one player's kill briefly erase another player's ability to
  // fire, because with two balls the player keys 0/1 collided with what are now slot keys.
  const shot = func(main, "_on_gripball_player_shot");
  check("firing does not depend on any duck existing",
        !/var target_duck = party_ducks\.get\(player_id\)/.test(shot),
        "this lookup IS the bug: another player's kill emptied the entry this one read");
  check("a shot is resolved against the whole flock",
        /var target_duck = _party_duck_at\(aim_position\)/.test(shot));
  check("the shot always fires before the flock is consulted",
        shot.indexOf("_play_shot_with_shell()") < shot.indexOf("_party_duck_at("),
        "no arrangement of ducks may turn a trigger pull into silence");

  const at = func(main, "_party_duck_at");
  check("_party_duck_at exists", Boolean(at));
  check("it iterates every slot rather than indexing by player",
        /for slot_id in party_ducks\.keys\(\)/.test(at));
  check("...and takes the nearest of overlapping ducks",
        /if distance < best_distance:/.test(at),
        "first-enumerated would hand the hit to whichever slot happened to come first");
  check("...skipping ducks that are not shootable",
        /not candidate\.get\("input_pickable"\)/.test(at));

  // The flock is a fixed size. Sizing it by player count is what made the ducks private.
  const spawnAll = func(main, "_spawn_party_ducks");
  check("the flock size is independent of how many people are playing",
        /for slot_id in range\(PARTY_SHARED_DUCK_COUNT\)/.test(spawnAll),
        "range(party_player_count) is one duck each, which is the design being replaced");
  check("there are fewer ducks than a full table of players",
        Number((main.match(/PARTY_SHARED_DUCK_COUNT = (\d+)/) || [])[1]) < 4,
        "one duck per player, by any other spelling, is not contested");
  const spawn = func(main, "_spawn_duck");
  check("the spawn band belongs to a slot, not a player",
        /if slot_id >= 0 and PARTY_SHARED_DUCK_COUNT > 1:/.test(spawn),
        "per-player lanes kept each player's duck inside their own strip of screen");
  check("ducks no longer wear an owner's number",
        !/_add_party_player_label\(new_duck/.test(spawn),
        "a number over a contested duck claims an ownership that no longer exists");

  // Tracking has to reach the whole flock too, or the scramble is unaimable.
  const target = func(main, "_get_gripball_player_target");
  check("tracking considers every duck in the flock",
        /for slot_id in party_ducks\.keys\(\)/.test(target));
  check("...choosing the one nearest that player's own crosshair",
        /GripballInput\.party_positions\.get\(/.test(target) && /if distance < nearest_distance:/.test(target),
        "this is the 'which duck do you go for' axis Pan asked about");
  check("the intro screen still gives each player their own duck",
        /if intro_screen\.visible:\s*\n\s*var intro_duck = intro_party_ducks\.get\(player_id\)/.test(target),
        "that is how a ball proves itself; sharing it would break _intro_required_players");
}

console.log("\nA contested duck can only be scored once");
{
  const shot = func(main, "_on_gripball_player_shot");
  // The race is the mechanic, so losing it has to be indistinguishable from missing.
  check("the loser of a race is treated as a miss",
        /if target_duck\.duck_hit:\s*\n(?:\s*#[^\n]*\n)*\s*_play_web_shot_miss\(aim_position, player_id\)\s*\n\s*_party_lock_player\(player_id\)/
          .test(shot),
        "a free shot at an already-dead duck is the mash strategy with extra steps");
  check("credit is only written for a duck that was still alive",
        shot.indexOf("if target_duck.duck_hit:") < shot.indexOf('set_meta("shot_by", player_id)'),
        "writing shot_by unconditionally hands the points to whoever fired LAST");

  const award = func(main, "_award_party_hit");
  check("_award_party_hit exists", Boolean(award));
  check("it pays the player the duck recorded, not the one respawning the slot",
        /var shooter := int\(hit_duck\.get_meta\("shot_by"\)\)/.test(award),
        "the payout happens ~1.1s after the shot, by which time player_id means a slot");
  check("...and still moves the shared total for the highscore board",
        /score_current \+= points_per_duck/.test(award));
  const next = func(main, "_on_next_duck");
  check("the party branch pays out through it exactly once",
        /_award_party_hit\(active_duck\)/.test(next) &&
        (next.match(/score_current \+= points_per_duck/g) || []).length === 1,
        "leaving the old score_current line beside the call would double every duck");
}

console.log("\nMissing costs the shooter their next shot");
{
  // Bullets are effectively infinite in party mode (max_bullets = party_player_count * 99), so
  // without a cost the optimal play is to flick as fast as the cooldown allows - which would
  // collapse the grip-strength, timing and target-choice axes into mashing.
  const shot = func(main, "_on_gripball_player_shot");
  check("a locked player's flick does nothing but click",
        /if _party_is_locked\(player_id\):\s*\n\s*shotgun_empty_player\.play\(\)\s*\n\s*return/.test(shot));
  check("the lock is checked before the shot is played, not after",
        shot.indexOf("_party_is_locked(player_id)") < shot.indexOf("_play_shot_with_shell()"),
        "a lock that still fires the gun is not a lock");
  check("an ordinary miss arms it",
        /_play_web_shot_miss\(aim_position, player_id\)\s*\n\s*_party_lock_player\(player_id\)/.test(shot));
  check("a hit does not", !/target_duck\.shoot\(\)\s*\n\s*_party_lock_player/.test(shot));

  const lock = func(main, "_party_lock_player");
  check("_party_lock_player exists", Boolean(lock));
  check("the lock is per player, not global",
        /party_locked_until\[player_id\] =/.test(lock),
        "a shared lock would recreate the bug this commit removes, on purpose");
  check("it is short enough to be a cost rather than a benching",
        Number((main.match(/PARTY_MISS_LOCK_SEC = ([\d.]+)/) || [])[1]) <= 2.0);
  check("it is long enough to outlast the shot cooldown it is meant to discourage",
        Number((main.match(/PARTY_MISS_LOCK_SEC = ([\d.]+)/) || [])[1]) >= 0.5);
  check("the penalty is shown, not just enforced",
        /GripballInput\.set_player_locked\(player_id, PARTY_MISS_LOCK_SEC\)/.test(lock),
        "an invisible lock reads as a broken ball, so players debug instead of adapting");

  const setLocked = func(input, "set_player_locked");
  check("gripball_input accepts the lock", Boolean(setLocked));
  const party = func(input, "_update_party_tracking");
  check("a locked crosshair dims", /sprite\.modulate\.a = 0\.35 if locked else 1\.0/.test(party));
  check("...and stops tracking, so the penalty is felt as well as seen",
        /if locked:\s*\n\s*party_positions\[player_id\] = current\s*\n\s*sprite\.position = current\s*\n\s*continue/
          .test(party));
  check("locks are dropped when the player count changes",
        /party_locked_until\.clear\(\)/.test(func(input, "_setup_party_crosshairs")),
        "player ids are re-indexed on connect, so a stale lock would hit the wrong ball");
}

console.log("\nThe aim trill re-arms when the crosshair is handed a new duck");
{
  // party_tone_spent makes arriving silent, so one hold cannot drone. With a shared flock the
  // target now changes WITHOUT a release - the player took that duck, or somebody else did - and
  // the trill would stay silent through the next approach, which is the approach that matters.
  const party = func(input, "_update_party_tracking");
  check("a change of target re-arms the tone mid-squeeze",
        /if target_key != int\(party_target_keys\.get\(player_id, 0\)\):\s*\n\s*party_target_keys\[player_id\] = target_key\s*\n\s*party_tone_spent\[player_id\] = false/
          .test(party));
  check("...before the arrival test, so arriving still silences it",
        party.indexOf("party_tone_spent[player_id] = false") <
        party.indexOf("if current.distance_to(target) <= TRACK_LOCK_RADIUS:"),
        "re-arming after would make a locked-on crosshair chirp every frame");
  check("release still re-arms it too",
        /if strength <= TRACK_PRESS_FLOOR:[\s\S]{0,400}party_tone_spent\[player_id\] = false/.test(party));
  check("main.gd reports which duck it steered them at",
        Boolean(func(main, "_get_gripball_player_target_key")) &&
        /party_target_keys\[player_id\] = nearest\.get_instance_id\(\)/
          .test(func(main, "_get_gripball_player_target")),
        "positions cannot stand in for identity: two ducks can pass through the same point");
  check("the call is guarded, so a scene without it still tracks",
        /if scene\.has_method\("_get_gripball_player_target_key"\)/.test(party));
}

console.log("\nEach player can see whether they are winning");
{
  // A scramble is only a contest if the standings are visible while it happens. The shared total
  // says nothing about who is ahead.
  const hud = func(main, "_create_party_score_hud");
  check("_create_party_score_hud exists", Boolean(hud));
  check("there is one label per player", /for player_id in range\(party_player_count\)/.test(hud));
  check("it is built in party mode only",
        /if party_mode:[\s\S]{0,1200}_create_party_score_hud\(\)/.test(func(main, "_ready")));
  check("it does not sit over the title card",
        /party_hud_layer\.visible = not intro_screen\.visible/.test(hud),
        "a row of zeroes before the round starts claims the game is already running");
  check("...and comes up with the rest of the HUD",
        /party_hud_layer\.show\(\)/.test(func(main, "_exit_intro_screen")));
  check("...and goes away with it",
        /party_hud_layer\.hide\(\)/.test(func(main, "_show_highscore_screen")),
        "the highscore screen shows a different number entirely");
  check("it is parented to main, not to current_scene",
        /\n\tadd_child\(party_hud_layer\)/.test(hud),
        "_ready() runs before current_scene is reliably set");

  const refresh = func(main, "_refresh_party_scores");
  check("a locked player is greyed out in the standings too", /if locked else Color\(1\.0, 0\.75, 0\.12\)/.test(refresh));
  check("an expired lock is un-greyed by _process, since nothing emits that",
        /if any_locked != party_scores_showing_lock:/.test(func(main, "_process")));
  check("...and only when it has actually changed",
        /party_scores_showing_lock = any_locked\s*\n\s*_refresh_party_scores\(\)/.test(func(main, "_process")),
        "re-applying theme overrides every frame for nothing");
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
