# Volley Bandit — Project Notes

Volleyball coach's PWA: lineups, rotations, live stat entry, and print
sheets. Built to work offline in a gym with no signal, and synced across
devices via a team code (Firestore). This file is a handoff between
sessions — chat-based and Claude Code alike — working on this repo over
time; everything below is context a fresh session wouldn't otherwise have.
Keep it updated when you learn something the next session would want to
know, the same way past sessions did for you.

## Stack

- Vite + React, single file: `src/App.jsx` (~7,950 lines — everything lives
  here, no component splitting yet) plus two small extracted modules:
  `src/shared.js` (theme tokens/`COLORS`, `usePersisted`, `displayName`/
  `fullName` — pulled out of `App.jsx` solely so a second component file
  could reuse them without a circular import) and `src/tournamentLogic.js`
  (see Tournament Builder below).
- Firebase Firestore for sync (team code → 3 docs: `main`, `logs`,
  `branding`), offline persistence via IndexedDB
- `vite-plugin-pwa` for the offline app shell
- `jspdf` + `html2canvas` for the print/PDF feature
- Deployed on Vercel (`volley-bandit.vercel.app`), auto-deploys from GitHub
  `main`

## Companion app: Player Eval

`player-eval/` in this same repo is a separate Vite + React app — post-match
player skill ratings, trends, and lineup-aware swap suggestions — deployed
as its own Vercel project (`player-eval-three.vercel.app`, root directory
`player-eval`). It's intentionally a separate app, not a tab in this one,
but shares data with it:

- It reads this app's `teams/{code}/data/main` doc directly — specifically
  `roster`, `lineups`, and `activeLineupId` — and writes back only to the
  `roster` field, always with Firestore `merge: true`, so it can never
  touch lineups/matches/score/etc. See `player-eval/src/App.jsx`'s
  `useVolleyBanditData` hook and `player-eval/README.md` for the full
  data-sharing contract.
- Both apps support a `?code=GRF-4X29` deep link that auto-joins a team
  instead of making the coach retype the code — see `useDeepLinkJoin` in
  both apps' `App.jsx`, and the `PLAYER_EVAL_URL` / `VOLLEY_BANDIT_URL`
  constants that wire up the cross-links in each app's header/Settings.
- If you change the shape of `roster`, `lineups`, or `activeLineupId` here,
  Player Eval reads that same shape — check it doesn't break there too.

## Tournament Builder ("Tourney" tab)

A "King & Queen of the Court" generator: split checked-in players into
random teams each round, minimizing repeat teammates, with a live point
tally. Built from `tournament-builder-spec.md` (a spec drafted in a chat
session and handed to Claude Code — see that file's own history if it's
still around). Lives in its own files rather than inside `App.jsx`:

- `src/tournamentLogic.js` — pure, framework-free scheduling math (round
  count from practice time, team-size/court-fit planning with fallback
  strategies, the GF(4) affine-plane perfect schedule for the 16-player/
  team-size-4 special case, and simulated annealing for everything else).
  No React, no Firestore — testable with a plain Node script, which is how
  it was actually verified (see CLAUDE.md's "On testing" section on why
  that matters more than it sounds like it should).
  - **There is no `"subs"` strategy anymore — replaced by `"uneven"`.**
    Subs rotated leftover players into teams round to round to keep every
    team the same fixed size, and it shipped with two real, reported bugs
    that both come from the same root cause (an unrotated, fixed idle
    "team slot" — see the `bye` bullet below for the general shape of this
    class of bug): (1) a leftover sub could be silently dropped from
    playing at all for a round with no indication anywhere — not even
    counted as a "bye" — whenever their rotation math happened to land on
    the fixed idle team index that round; (2) when the team count was odd,
    the *same team index* (not the same players — team membership still
    reshuffled — but the same numbered slot) sat idle **every single
    round**, with zero tracking of who'd already sat there, so a player
    could easily land in that slot two rounds running. `"uneven"` sidesteps
    the whole bug class by not having an idle slot at all: it splits the
    headcount straight into `courts * 2` teams whose sizes differ by at
    most one (e.g. 18 players/2 courts → 5/5/4/4), so every court is full
    every round and nobody ever sits out or gets bumped in/out — same
    `optimizePartition` teammate-repeat minimization as everything else,
    just with a `groupSizes` array instead of one uniform size (see next
    bullet). Offered whenever the average team size would land in [2, 6]
    (`planTeamLayout`), listed **before** `bye` in the strategy picker —
    it's a strictly simpler result whenever it's available, since nothing
    rotates and nobody ever misses a round.
  - **`optimizePartition` takes a `groupSizes` array, not one `groupSize`
    number** — e.g. `[5,5,4,4]` for uneven teams, or `uniformSizes(n, s)`
    (`Array(n/s).fill(s)`) for every other strategy, which still wants N
    equal-size groups. The simulated annealing swaps which *group label*
    two players hold, never how many players are in a group, so it
    already worked correctly for unequal sizes with no other change to
    the search itself — only `randomPartition`'s initial assignment
    (slice a shuffled player list into the given sizes, in order) needed
    to change.
  - **The `bye` fallback is offered whenever `playerCount > desiredTeams *
    teamSize`** (desiredTeams = `courts * 2`) — NOT when `playerCount` is
    an exact multiple of some team size, which was a real bug: it briefly
    required `numFullTeams > desiredTeams && leftover === 0` (a leftover
    constraint from the old, since-rewritten implementation that grouped
    players into whole teams first), so a headcount like 14 players on 1
    court — more than the 12 a single 6v6 court can seat, but not a clean
    multiple of any tried size — got offered **no bye option at all**,
    even though `generateSchedule`'s bye branch (see below) handles any
    positive `byesNeeded = playerCount - desiredTeams * teamSize` just
    fine and always has. The real-world framing that exposed this: "1
    court seats max 12 (6 v 6), 2 courts max 24" — anything over that
    per-court cap of 6-a-side needs bye rotation, evenly divisible or not.
    Only the single **largest** size in `[3,4,5,6]` (or the coach's exact
    pick, if not "auto") that still needs benching is offered — a smaller
    size always benches strictly more players for the same court count
    (`desiredTeams * smallerSize < desiredTeams * largerSize`), so it's
    strictly worse, not a genuinely different choice, and offering it
    alongside the larger-size option would just be clutter.
  - **The `bye` strategy picks WHO sits out before deciding any teams**,
    not the other way around. The original approach reshuffled all
    players into random teams first and then benched whichever team(s)
    had banked the fewest byes — which turned out unable to reliably
    avoid benching the same player two rounds in a row once byes were a
    large enough fraction of the roster (e.g. 8 of 24 players out per
    round): next round's random teams are ~83% likely to contain at least
    one of last round's benched players in any given group, so a
    "clean" team often didn't exist to pick from. Fixed by choosing the
    bye set directly from individual players each round (fewest byes so
    far, strictly preferring anyone who didn't sit last round, random
    tiebreak) via `optimizeRoundGroups`/`marginalRoundCost`, and only
    partitioning whoever's left playing into teams — this makes
    zero-back-to-back-byes achievable whenever the bye fraction allows it
    at all (verified: 0 violations at 20 and 24 players over 8-10 rounds,
    where the old approach produced dozens). This also means the bye
    strategy no longer runs one joint multi-round `optimizePartition` up
    front — it can't, since which players are even in the pool changes
    every round — and instead minimizes repeat teammates round-by-round
    against a running pair-count table. Slightly less globally optimal
    than a joint solve, but the alternative (fixed pool) can't support
    per-round-varying byes at all.
  - **"Court layout" (`config.courtLayout`, `"full"` | `"half"`) reuses
    every strategy above unchanged via one parameter: `teamsPerCourt`**
    (2 for full court — two groups face off; 1 for half court — one group
    per court, no opponent, for cycling through drill combinations while
    the rest wait/rotate on the bye). Added so the tool doubles as a drill
    builder — same fairness math, just without a "match" on each court.
    `desiredTeams = courts * teamsPerCourt` was already the generic
    parameter every strategy (standard fit, `uneven`, `bye`) is built
    around, so nothing in the search/annealing/bye-selection logic needed
    to change — the only new code is `buildCourts(groups, teamsPerCourt)`,
    which packages the flat list of groups into `round.courts[]` entries
    either paired (`{teamA, teamB}`, full court) or solo (`{teamA,
    teamB: []}`, half court). Every caller that builds courts
    (`generateSchedule`'s standard/uneven/bye branches) goes through this
    one helper now. `planTeamLayout`'s `standardFits` check requires
    `numTeams % 2 === 0` only when `teamsPerCourt === 2` — half court has
    no pairing requirement, any group count up to `desiredTeams` fits. The
    `single`-court strategy (one big scrimmage, no split) only makes sense
    when there are two sides to put on it, so it's excluded entirely when
    `teamsPerCourt === 1`. Strategy wording (`uneven`'s and `bye`'s
    `detail` text) says "groups"/"group" for half court and
    "teams"/"team" for full court (`groupWord`/`byeGroupWord`), since
    "team" implies an opponent that doesn't exist in drill mode.
    `court.teamB.length === 0` is what both `TournamentBuilder.jsx`'s
    on-screen round rendering and its print sheet check to decide whether
    to draw a single group (no "vs", no tap-to-record-winner buttons —
    there's no winner to record) or the normal two-team matchup; if you
    add a third rendering site for `round.courts`, it needs the same
    check or it'll render a dangling "vs" against an empty team.
  - **"Nothing in the search/annealing logic needed to change" above was
    wrong — half court with `courts === 1` freezes the whole tab.** Real,
    user-reported: tapping the (only) strategy option on the strategy
    picker did nothing — no navigation, no error, just a dead tap. Root
    cause was an infinite loop, not a click-handler bug: both
    `optimizeRoundGroups` (the `bye` strategy's per-round group search)
    and `optimizePartition` (every other strategy's joint search) pick a
    *second* group to swap a player into via `while (g2 === g1) g2 =
    Math.floor(rng() * numGroups)` — and when `numGroups`/`groupSizes.length`
    is 1, there is no second group, so that loop can never find one and
    spins forever. This is unreachable in full-court mode (`desiredTeams =
    courts * 2` is always ≥ 2), but half court's `teamsPerCourt = 1` means
    `courts === 1` alone — the single most natural half-court setup, one
    court running a drill — produces `desiredTeams === 1`, hitting it on
    the `standard`, `uneven`, *and* `bye` paths alike (confirmed by
    reproducing the exact hang in a plain Node script — see CLAUDE.md's
    "On testing" section on why a synchronous infinite loop needs a
    `timeout` around the repro, not just staring at the code, and why a
    `git diff` alone would've missed this since neither of the touched
    functions' own code looked wrong in isolation). Fixed with an early
    return in each: a single group has nothing to optimize between groups
    (every player in the pool is teammates regardless of order/round), so
    `optimizeRoundGroups` returns `[pool.slice()]` and `optimizePartition`
    returns the trivial all-players-in-group-0 assignment for every round,
    both skipping the swap search entirely rather than guarding the
    `while` loop some other way. If you touch either function again, keep
    the `numGroups <= 1` / `groupSizes.length <= 1` guard at the top —
    it's not an optimization, it's what stops the tab from hanging.
- `src/TournamentBuilder.jsx` — the UI: attendance checklist → court/time/
  team-size form → (if the headcount doesn't divide evenly) a strategy
  picker → the round-by-round schedule with tap-to-record winners and a
  standings table.
  - **Two different reset actions on the schedule screen — don't merge
    them.** "New" (`startOver`) wipes everything back to
    `initialState` — a genuinely different tournament. "Edit"
    (`editSetup`) only sets `step: "setup"`, leaving `config` (attendance,
    guests, courts, time, team size) untouched, for the far more common
    case: the coach wants to add a late guest, adjust the headcount, or
    change the time, then regenerate, without re-doing attendance from
    scratch. This distinction exists because "New" used to be the only
    option, and it was wiping guests the coach had just added — the
    tap-to-return-to-setup coaches actually wanted was "keep what I
    entered, let me tweak it."
  - **Guests** (`config.guests`): the coach sometimes practices with
    another squad (JV2, varsity) whose players aren't on this team's
    roster. Typed into a plain text box, split naively on the first space
    into first/last name, given a negative id (`-Date.now()`, so it can't
    collide with a real roster id), and stored in the tournament's own
    local `config` — never written to the team's actual `roster`. They're
    auto-checked-in the moment they're added and removable with the ×.
    `playerById`/`buildLayout`/"Select all" all merge `roster` and
    `guests` — if you touch attendance logic, keep reading both, not just
    `roster`.
- `src/shared.js` — `COLORS`, `usePersisted`, `displayName`/`fullName`
  moved out of `App.jsx` so this new file could import them without
  `App.jsx` importing `TournamentBuilder.jsx` right back (a circular
  import). If you add a third module that needs these, put it here too
  rather than reaching into `App.jsx` directly.

Deliberately **local-only** (`usePersisted` → `localStorage`, key
`vb-tournament`), not synced through the team's Firestore `main` doc:

- It's a same-practice, same-device tool the coach runs live off one
  phone — there's no cross-device sync need the way there is for
  roster/lineups.
- The schedule data is arrays-of-arrays of player indices (round → court →
  team → player), which is exactly the shape that broke every write to
  `main` once already (see "nested arrays" under Data model gotchas). Never
  put this shape in Firestore without flattening it the way `ballots` had
  to be.
- If a future session wants this to sync (e.g. so an assistant coach's
  phone sees the same bracket), it needs its own Firestore doc, not a
  field bolted onto `main` — and the array-of-arrays shape still needs
  flattening first either way.

What's genuinely built vs. spec nice-to-haves still open: attendance
checkboxes (plus guests, see above), all three fallback strategies (single
match / rotating subs / bye rotation) with the coach choosing when it's
ambiguous, live tap-to-record winners with auto-tallied standings, a manual
+/- point adjustment per player for corrections/ties, and PDF export of the
bracket are all in. Not built: saving past tournament results, and roster
auto-sync of attendance state across sessions.

- **PDF export** (`handlePrintBracket` in `TournamentBuilder.jsx`) is a
  second, self-contained copy of the same jsPDF + html2canvas + share-sheet
  pattern `handlePrint`/`PrintArea` in `App.jsx` use (see "Read this before
  touching print/PDF code" below for why that pattern looks the way it
  does) — but **deliberately does NOT copy the one-page-per-repeating-
  section behavior** that pattern also uses. This sheet is meant to be a
  single reference card a coach can hold during practice, not a paginated
  document — the first version forced one PDF page per round (plus
  separate pages for a roster-key legend and standings), which for a
  5-round tournament produced 7 mostly-blank pages. Fixed: one continuous
  `html2canvas` capture of the whole sheet (no `.tourney-page-group`
  splitting), and **real player names inline in every matchup** instead of
  just the on-screen A/B/C letters — the letters are a fine shorthand for
  tapping winners live on a phone, but useless on a printed sheet meant to
  be read by someone who wasn't standing there.
  - **The results section is a blank grid, not the computed standings** —
    a `<table>` with one row per player (alphabetical, not letter/roster
    order — easier to find a name on paper), one column per round, and a
    Total column, every cell empty. This is deliberate: it's a paper
    scoresheet for the coach to mark up by hand during play, a
    replacement for (not a printout of) the live `points`/`winners`
    tally — don't wire it up to pre-fill from that state without checking
    that's actually what's being asked for, since the whole point was to
    get *away* from the on-screen tally for this one sheet.
  - **Auto-shrinks to fit one page, but text has a 14px floor** — past
    that, it falls back to two pages rather than keep shrinking illegible.
    Two size helpers in `TournamentBuilder.jsx`, both driven by
    `printScale` state: `px(n)` for layout (padding, margins, row
    height/width — shrinks all the way down, no floor) and `pxText(n)` for
    anything that's a font-size (`Math.max(PRINT_MIN_TEXT_PX=14,
    n * printScale)`). `handlePrintBracket` renders at `printScale: 1`
    first, measures `root.scrollHeight` against how tall one full letter
    page's worth of content is at the root's fixed width, and if it's
    taller, sets `printScale` to the ratio needed to fit (floor `0.4`,
    just a sanity clamp — `pxText`'s own floor is what actually protects
    legibility) and re-measures. If it *still* doesn't fit even then
    (`pxText` refusing to shrink text further is exactly why it might
    not) it captures `.tourney-print-matchups` and `.tourney-print-grid`
    — the sheet's two halves — as two separate PDF pages instead of one,
    each still auto-fit-shrunk (and each can in principle split further if
    even one half alone doesn't fit, via the same per-element slicing
    `captureElementToPdf` always did). Verified: 16 players/5 rounds fills
    one page at full size; 31 players/5 rounds/5 courts shrinks to fit one
    page; 30 players/8 rounds — enough that shrinking alone can't keep
    text ≥14px and still fit — correctly produces two pages with text
    still comfortably readable, not tiny. This replaced an earlier version
    with only a layout-wide scale and a much lower floor (0.55, applied to
    everything including text) that could still get too small to read
    before ever falling back to a second page. If you touch this sheet
    again, verify visually (render the actual PDF at a small, a
    one-page-after-shrink, and a two-page-fallback player/round count —
    don't just trust the JSX) rather than assuming any one fixed size or
    floor covers every tournament.
  It was built as its own copy rather than plugged into the main
  `PrintArea`, since this component's data (the generated schedule,
  points) has nothing to do with the roster/lineup/match print targets
  that component already handles, and because Tournament Builder is
  deliberately kept decoupled from `App.jsx` internals (see below). If the
  main print pattern changes, this needs the same fix applied twice —
  there's no shared helper between them (yet).
- **The print icon lives in the shared `TopBar`**, same spot as every
  other tab (next to Settings), not as a button inside
  `TournamentBuilder`'s own content — matching how print works everywhere
  else in the app. Since the print logic and its data (`schedule`,
  `points`) live inside `TournamentBuilder` while the button lives in
  `App.jsx`, the two talk through a `forwardRef`: `TournamentBuilder`
  exposes `{ print }` via `useImperativeHandle`, and reports state back up
  through two callback props — `onPrintingChange` (so the TopBar button
  shows the same spinner/disabled look every other print button does) and
  `onReadyChange` (so the icon is hidden entirely until a schedule exists
  — there's nothing to print on the setup/strategy screens). `App.jsx`
  holds `tourneyPrintRef`/`tourneyPrinting`/`tourneyReady` purely to wire
  this through; it never touches `TournamentBuilder`'s internal state
  directly.
- **Standings has two ways to change**, and both write into the same
  `points` computation: the tap-to-record winner buttons on each round
  (the primary path — awards the whole winning team +1) and a manual +/-
  stepper directly on each Standings row (`manualAdjustments`, a
  `playerId -> delta` map layered on top of the round tally). The stepper
  exists because a coach reading this one-handed during a match needs a
  way to fix a mis-tap or award a tie/forfeit without re-deciding who won
  an entire round. Both are additive — nothing about the round-winner
  buttons resets or is reset by a manual adjustment.

**Kept intentionally decoupled — this may become its own app someday.**
The user's actual use case splits in two: (1) a bit of competitive spice
during a normal team practice (today's use — Volley Bandit already has the
roster open), and (2) a standalone "King & Queen of the Court" event people
sign up for individually, with no pre-existing team/roster at all. That
second use is a genuinely different product (open signup, probably public,
not tied to a Volley Bandit team code) — closer to Player Eval's
separate-app precedent than to another tab. Decided to keep it as a tab
for now rather than pay for a second Firestore app/deploy before anyone's
asked for it, but the code is already split along the seam that split
would need:
- `tournamentLogic.js` has zero concept of "team" — it only takes a
  player count and returns index-based groupings. This part ports to a
  standalone app unchanged.
- `TournamentBuilder.jsx`'s `roster` prop is just an array of
  `{id, firstName, lastName, num}`-shaped objects; nothing about it
  requires those to come from Volley Bandit's Firestore team roster.
  The *only* place "existing team" is baked in is the attendance-checkbox
  screen (the `step === "setup"` render branch) — a standalone signup app
  would replace that one screen with an open "type your name to join" flow
  and feed the same shape into everything downstream (letters, schedule
  cards, tap-to-record, standings) untouched.
- If/when this splits out: it'd need `shared.js`'s bits either copied over
  or reimplemented (a separate app can't `import` from this repo's `src/`),
  same as Player Eval would if it didn't have its own copies already.
Don't let attendance-checkbox logic leak into the scheduling/display code
when touching this — that leak is the one thing that would make a future
split harder than it needs to be.

## Read this before touching print/PDF code

The print feature (`handlePrint` in `App.jsx`) went through many rounds of
real, user-reported bugs before landing on its current shape. Some
non-obvious things that look like they could be "simplified" but are load-bearing:

- **`handlePrint` takes its target as an explicit parameter, not from React
  state.** It used to read `printTarget` from state, and there's a real
  timing bug where `setPrintTarget(x); handlePrint();` back-to-back in the
  same event handler calls `handlePrint` with the *previous* render's
  closure — meaning it silently used the target from before the tap, not
  the one just selected. Every print call site passes the target directly
  now (`handlePrint("subsheet")`, etc.). Don't refactor this back to reading
  from state without fixing that timing problem again.
- **The print-root DOM node stays `display:none` except for the instant a
  PDF is actually being generated**, toggled via a `.print-root-capturing`
  class. This used to be left permanently rendered off-screen (needed for
  html2canvas to capture it), which caused constant background layout/paint
  work — busy enough that it once made Firestore's connection look offline
  even on a fine network. There's also a 20-second `setTimeout` safety net
  that force-clears this state if the async print flow gets suspended
  mid-flight (iOS does this when a tab backgrounds during a multi-page
  capture) — don't remove it without understanding why it's there.
- **Some print targets (`.subsheet-page-group`,
  `.playerguide-page-group`) force one real PDF page per group**, captured
  and added to the PDF individually, instead of one continuous capture
  sliced by pixel height. That's because plain height-based slicing doesn't
  know about content boundaries and was cutting a set's title from its own
  diagrams. If you add a new print sheet with multiple repeating sections,
  it likely needs the same treatment.
- **`PrintArea` is wrapped in `React.memo`.** It's unconditionally mounted
  (so print is instant) and computes every sheet's content, so without
  memoization it silently re-runs all of that work — including the
  rotation-transition math — on every render of the whole app, not just
  when printing. This was a real, confirmed performance drain, not a
  precaution.

## Data model gotchas

- **`useTeamDoc.update` writes only the fields a change actually touched,
  with `merge: true` — never the whole document.** It used to be
  `setDoc(ref, next, { merge: false })`, which replaces the entire document
  with whatever that one device holds. With two devices on a team code that
  is last-writer-wins across *everything*: a phone on stale state that
  changes the score — or that flushes a write queued while it was offline —
  overwrites the roster, lineups, matches and the whole stat log another
  device recorded an hour earlier. **This is not theoretical; it happened.**
  A match entered live on a tablet went missing, and the harness reproduces
  it exactly: 40 stats and a match on the server, one score tap on a stale
  device, and the server is left with 2 stats and the match gone.
  The diff is by reference equality, which is correct here because
  `fieldSetter` rebuilds the wrapper (`{ ...prev, [field]: v }`) and leaves
  every other field pointing at the same object, and a snapshot rebuilds
  them all together — so a changed field is exactly one whose reference
  moved. Writing a field that didn't need it is harmless; never sending
  untouched fields is the whole point.
  **What this does NOT fix: concurrent edits to the SAME field** — which
  is why the two logs stopped being fields at all; see the next bullet.
  If you touch this, the Firestore stub
  now models merge semantics properly (`merge:false` replaces) and records
  every write's payload on `window.__writes` — the old stub merged either
  way, which is precisely what hid this bug.
- **The stat log and the point log are Firestore COLLECTIONS — one document
  per entry — not arrays in the `logs` document** (`useTeamCollection`,
  next to `useTeamDoc`). Paths: `teams/{code}/stats/{entryId}` and
  `teams/{code}/points/{entryId}`, keyed by the entry's existing
  `Date.now() + Math.random()` id, which is also kept as a field.
  The field-level merge above stops two devices clobbering each other's
  *different* fields; it cannot help when both write the *same* field, and
  two devices recording the same match both write `log` in full, so the
  later one wins outright and everything the other recorded in between is
  gone. A document per entry has no conflict to resolve: a stat tapped on
  the tablet and a stat tapped on the phone are different documents, so
  both land in any order, online or flushed from offline, and a delete is a
  real document delete rather than "here is my whole array minus one" —
  so it can't resurrect entries the other device added or re-delete ones it
  removed. Verified in the harness: 40 entries from the other device
  survive a stat recorded here (the old shape dropped all 40), a score tap
  writes `main{score}` plus exactly one point document, and undo, the box
  score's edit mode and deleting a player with stats each delete exactly
  the documents they should.
  Things to keep if you touch this:
  - **Every screen still calls `setLog(prev => ...)` / `setPointLog(...)`.**
    `makeEntrySetter` in `AppInner` takes that same updater, diffs the
    result against the current entries by id, and turns it into per-document
    writes and deletes. Deliberate: the call sites already express exactly
    what changed, and none of them had to learn about collections. It is
    also strictly safer than the array write it replaces — two setters
    firing in one tick from the same `prev` used to mean the second
    overwrote the first, and now each only touches its own entry.
  - **Reads are a union of the legacy arrays and the collection**
    (`mergeEntries`), deduped by id, so the app is correct *during* the
    migration, not only after it. Removals prune the legacy side too
    (`pruneLegacy`), or a delete would be undone by the union.
  - **The migration is idempotent and clears the legacy arrays only once
    the writes land.** Two devices migrating at once write the same
    document ids with the same contents, so there's nothing to coordinate;
    if the writes fail (no signal) nothing is cleared and it retries on the
    next load.
  - **Export/Restore had to change with it.** `exportAllData` writes
    `logs: { log, pointLog }` built from the merged arrays rather than
    `logsDoc`, which is empty post-migration — the backup keeps the same
    shape so old and new backups restore identically. `restoreFromBackup`
    goes through `replaceAll`, which deletes documents the backup doesn't
    contain; a plain write would have merged the backup into whatever was
    already there, which is not what that button promises.
  - Bulk work (migration, restore, deleting a player's season) goes through
    `writeBatch` in chunks of `WRITE_BATCH_LIMIT` (450) — Firestore caps a
    batch at 500 operations.
  - The Firestore rule in README.md is `/{document=**}`, which already
    covers subcollections. Nothing to change there.
- **A player can have two jersey numbers: `num` and an optional `liberoNum`.**
  A libero who also plays DS wears a different, contrasting jersey in each
  role — a real rule, and one person legitimately has two numbers. Before
  this existed the only workaround was adding her to the roster twice, which
  the coach was actually doing; because everything keys off `playerId`, that
  splits her box score, her season totals, her Player Eval ratings and her
  sub/re-entry record into two half-players, permanently.
  - **Which number shows follows the libero DESIGNATION, not the position
    field.** `jerseyFor(player, liberoIds)` in `shared.js` returns
    `liberoNum` when the player is in that lineup's `liberos` array and
    `num` otherwise. The designation lives on the lineup and lineups are
    per set, which is exactly how designation works on a scoresheet: she is
    the libero for a set, or she isn't. Confirmed with the coach that it
    never changes mid-set, which is what makes this a pure function of the
    lineup rather than something needing live tracking.
  - **`jerseyLabel(player)` (`"51/32"`) is for anywhere there's no set to
    decide** — the roster list and its CSV, the box score, Season to Date,
    Insights, Trends, the printed roster sheet and the printed box scores.
    Don't guess a role where none is defined; show both.
  - `LineupScreen` and `LiveScreen` each define a local
    `jersey = (p) => jerseyFor(p, <that lineup's liberos>)` and every
    number they render goes through it. `PrintArea` is mixed on purpose:
    sheets that loop over a lineup (`l` in scope — the lineup sheet's
    grids and Lib 1/Lib 2 rows, the sub sheet, the player guide) use
    `jerseyFor(p, l?.liberos)`; season-wide sheets use `jerseyLabel`.
    **Verified by rendering the actual sheet, not by reading the JSX** —
    the printed lineup sheet shows `51/32` in the roster key (so the
    scorer can match either jersey) and the bare `32` in her court slot
    and Lib 1 row for a set where she's designated.
  - **The Lineup tab shows both numbers and both positions.** Two local
    helpers next to `jersey` in `LineupScreen`: `positionsOf(p)` joins
    `position` and `position2` (`"L · DS"`), and `altJersey(p)` returns the
    number she ISN'T wearing this set, rendered small and dim after the one
    she is (`#32/51`). Applied to the court slot cards, the LIBEROS row, the
    pairing rows, the player picker and the Add Pairing dropdowns — this is
    the screen where a coach matches the app against the actual floor, so
    both jerseys and both positions have to be readable without opening a
    player card.
    The LIBEROS row had to become **stacked full-width rows rather than two
    side-by-side buttons** to fit: at half width the L1 chip, both jerseys,
    the name and both positions wrapped the name onto a second line.
    Checked on a 390px screenshot, not just in the DOM text.
  - Form fields (`playerForm.num`), the duplicate-number warning, and the
    roster sort all still read `num` directly. Those are about identity and
    data entry, not about what she's wearing — don't route them through
    `jerseyFor`.
- **`mergePlayers(keepId, dropId, useDropAsLibero)` folds one roster entry
  into another** — Settings → Merge Duplicate Players. This is the repair
  for rosters that already carry the duplicate entries described above.
  It rewrites every place a player id can live, which is more places than
  you'd guess: `roster`, `captainId`, `injuredPlayerIds`, every lineup's
  `slots`/`liberos`/`pairings`, `subEntries`, every match's
  `lineupSnapshots`, `captainVote.candidateIds` and each ballot's `picks`,
  `trendSubject`, the `stats` collection's `playerId`, the `points`
  collection's `serverPlayerId`, **and Player Eval's own
  `teams/{code}/data/playerEval` doc** — which this app otherwise never
  touches, but leaving it out would strand every rating recorded against
  the duplicate.
  - `remapLineupPlayer` (module scope) does the lineup-shaped rewrite and is
    shared by real lineups and by frozen `lineupSnapshots`. It handles the
    three states that only exist because the ids used to be two people:
    both on court at once (the dropped one's slot is vacated rather than
    doubling the keeper up), both holding libero slots, and a pairing
    BETWEEN them (deleted — that was the coach pairing someone with
    herself in a different jersey). A self-referential `subEntries` row
    goes the same way.
  - There is **no undo**. The sheet says so and points at Export first.
    If you add anything else keyed by `playerId`, add it here too.
- **The app knows whether you're SERVING or RECEIVING, and two features hang
  off it.** `servingState(pointLog, matchId, setNumber, lineup)` (module
  scope) derives it: in rally scoring whoever won the last rally serves the
  next, so it falls out of the point log with nothing extra to tap, and
  before the first point of a set it's `lineup.servesFirst`.
  - It is only as good as the scoreboard, so the lineup also carries
    `servingOverride: { setNumber, at, serving }` — a tap on the WE SERVE /
    RECEIVING chip. **`at` is the point count when it was set, and that's
    what stops it going stale**: the override applies only while the count
    is unchanged, so the very next rally resolves possession for real and
    the override lapses on its own. Don't "simplify" it to a bare boolean.
  - **`possessionPrompts` in `LiveScreen` is DERIVED every render, not
    stored** the way `subSuggestions` is. A rotation happens once and can be
    captured; possession flips every rally, so a stored list would be stale
    the moment the score moved. Dismissals ("Not now") are keyed
    `${pointCount}:${key}` so they expire by themselves — no reset effect,
    and nothing to leave behind.
  - **Two liberos by possession.** `lineup.liberoRoles` is `["any"|"receive"
    |"serve", ...]` aligned with `lineup.liberos`, cycled by a chip on each
    LIBEROS row (the chip calls `stopPropagation` — the row itself opens the
    player picker). The role lives per libero SLOT, not per player, so
    changing who fills L1 keeps the plan. A prompt appears only when the
    libero wanted for the current possession is off court AND the other one
    is on, which is what stops it nagging every rally.
  - **Serving specialists** are `lineup.serveSubs: [{ id, forId, subId }]` —
    deliberately their own list rather than another flag on `pairings`,
    which is about front-row/back-row rotation and is the most bug-prone
    code in this file. Prompted in when we hold serve and `slots.P1 ===
    forId`; prompted back out at sideout. **Each turn costs two of the 18
    subs**, which the setup copy says out loud.
  - Both prompts check `!onCourt.has(...)` before offering anyone. That guard
    earned its place immediately: a test fixture that put one player in two
    slots correctly got no "bring them back in" prompt, and the fixture was
    the thing that was wrong.
  - Full mode only — Simple mode has no court to swap anyone on.
- **Captains are a list (`mainDoc.captainIds`), not one `captainId`.**
  Co-captains are normal and a team can name two or three. Every read goes
  through `captainIdList(doc)` (module scope), which falls back to
  `[captainId]` for a team whose data hasn't been rewritten since — same
  normalizer pattern as `ballotPicks`. `toggleCaptain(id)` adds or removes.
  `setCaptainIds` also writes `captainId: next[0] ?? null` as a mirror, so a
  device still on an older build, or an older backup restored later, shows a
  captain rather than none; nothing in this build reads it. `mergePlayers`
  remaps `captainIds` as well as the legacy field, and `deletePlayer` drops
  the player from the list. Every C badge, the roster CSV and both print
  sheets test membership, so all captains are marked, not just the first.
- **The live scoreboard is labelled with the two teams, not "US"/"OPP".**
  `scoreLabel(name, fallback)` (module scope) takes the first word of a name,
  strips punctuation and uppercases it, capped at 10 characters — "Grafton
  High School JV1 Volleyball" reads as GRAFTON, "Shrewsbury - JV" as
  SHREWSBURY. The opponent comes from the active match, so it follows
  whatever is on the Schedule with no extra typing; our own side can be
  overridden with `mainDoc.teamAbbr` (Roster → Team Info, "Scoreboard short
  name") for when the first word isn't the identifying one. Both fall back
  to US/OPP when there's nothing to use — no active match, no team name.
  The label is `text-overflow: ellipsis` at `maxWidth: 124`, which is what
  the column can hold beside a 46px stepper at 390px wide; if you enlarge
  the steppers again, re-check that width on a screenshot rather than
  assuming.
- **An assistant device is one that joined with an ASSISTANT CODE, not one
  with a switch flipped on it.** `src/teamAccess.js` holds the pure part. The
  join box takes either code: a team code links the device with full access,
  an assistant code (`assistantAccess/{code}` -> `{ teamCode }`, a top-level
  collection like `playerAccess`) links it to the same team with only what the
  coach allows. **The code IS the mode** — there is deliberately no "turn
  assistant mode off" anywhere.
  - **This replaced a design that was backwards in two ways**, and the reasons
    are worth keeping: the coach had to physically take the helper's device
    (usually the team's tablet, handed to whoever is free) and tap a switch on
    it, and the way OUT was a passcode while the way IN was a tap. Restricting
    yourself needs no permission; un-restricting yourself is the thing worth
    gating. And the old `assistantPasscode` couldn't be the app passcode,
    because the helper had to type that just to open the app — a whole
    bullet's worth of reasoning that evaporates once the code is the mode.
    `mainDoc.assistantPasscode` is now dead data; nothing reads it.
  - **`vb-access-mode` ("coach" | "assistant") and `vb-access-code` are
    per-device**, set by `TeamGate`'s `onLinked(teamCode, mode, typedCode)`.
    `vb-assistant` (the old switch) is still read as a fallback when
    `vb-access-mode` is empty, so a device someone put in assistant mode under
    the old build stays limited instead of silently gaining full access on
    update. That fallback is the one thing here that must not be dropped.
  - **Replacing or revoking the code evicts devices that joined with it.** An
    effect compares `vb-access-code` against `mainDoc.assistantCode` and
    unlinks on a mismatch — without it "revoke" would only stop NEW devices
    joining while every device already set up carried on, which is not what
    that word means. **It is gated on `mainLoaded`**: an unloaded document
    reads as the default (no code at all), and unlinking a helper mid-match
    because their phone hadn't synced yet is far worse than what this guards.
  - **The coach chooses which TABS an assistant sees** (`mainDoc.assistantAccess
    = { tabs, canScore }`, normalized by `assistantAccessOf`, which treats a
    missing field as the default pair and a present-but-empty list as the
    coach's actual choice). Live is not removable — a device with no Live tab
    has nothing to do. `TabBar` takes `allowedTabs`; an effect snaps the open
    tab back when it stops being allowed, which also covers first load, since
    `tab` starts at "roster".
  - **The write guard is unchanged and is still the half that actually holds.**
    `setMainDoc` filters an assistant device's writes down to
    `ASSISTANT_WRITABLE` (`statsView`, plus `score` when allowed); hiding tabs
    is presentation. A visible tab is still read-only.
  - **Nothing on an assistant device may show or carry the team code.** The
    Settings "Team code:" line reads "Joined as an assistant device" instead,
    and the Player Eval link is hidden there — it puts the team code in a URL,
    and Player Eval writes the roster. If you add anything else that renders
    or links `teamCode`, it needs the same treatment; that code is the whole
    app.
  - **"Switch Team" IS available on an assistant device**, and has to be:
    joining again with the team code is the only way to give that device full
    access now that there's no switch to turn off. It lands on the join
    screen, which needs a code, so it gives nothing away.
  - The score steppers dim but still fire, so the guard's notice explains the
    refusal — a dimmed control that does nothing at all is the "dead tap" this
    app has been bitten by before. `ScoreCounter` takes `disabled` as an
    opacity hint only and never sets the DOM attribute; keep it that way.
  - `snapshotLineupForMatch` still goes around the guard
    (`setMatchesUnguarded`): purely additive, first-write-wins, triggered by
    recording a stat, which is the whole point of the device.
  - Verified in the harness (`pwcheck/assistant.mjs`): a coach issues a code
    and `assistantAccess/{code}` points at the team; a second device joins by
    typing it in lowercase and comes up limited to the allowed tabs, on Live
    rather than Roster; that device shows no team code, no Player Eval link
    and no code controls, still records a stat, and is refused the score with
    a visible reason; replacing the code signs it out to the join screen; a
    device on the old `vb-assistant` switch stays limited and is NOT evicted;
    a wrong code still reports a wrong code.
  - Two harness traps found doing this, both worth not rediscovering: a
    `position: fixed` element (the assistant notice banner) has **no
    `offsetParent`**, so an "is it visible" helper written that way reports it
    as absent — measure `getBoundingClientRect()` instead; and the stub seeds
    documents per page, so a seed that assigns `teams/X/data/main` wholesale
    **replaces** the roster, lineups and schedule, and the app then renders an
    empty team that looks like a bug in the app. The stub merges per path now.
  - **Two holes an audit found, neither of them in use** (2026-10-18), both
    the same shape — a control nobody thought of as an exposure because it
    only READS:
    - **Export All Data was not gated.** Restore was, Export wasn't, and the
      backup file carries the TEAM CODE (in the JSON and in the filename),
      every player's stats access code, the assistant code and the whole
      roster. A device that can read everything can also save everything;
      read-only tabs were never the protection. Gated now, and the harness
      asserts both Export and Restore are absent.
    - **A `?code=` deep link didn't clear the device's access mode.** That
      path sets the team code directly and never goes through
      `TeamGate.onLinked`, so a phone that used to be an assistant, was
      unlinked, and then joined by link came up LIMITED while holding the
      team code — silently defeating the one documented way to hand a device
      full access. The deep-link join now marks the device "coach", and
      "Switch Team" clears the mode as well as the team.
    The lesson worth keeping: when auditing this, don't only ask what a
    device can CHANGE. Ask what it can carry away.
  - **A superseded assistant code is refused at the join screen.** Replacing
    a code writes the new `assistantAccess` document before deleting the old
    one, so a failed delete (no signal, a closed tab) leaves a stale document
    pointing at a live team. `checkAndJoin` therefore requires
    `teams/{code}/data/main.assistantCode === typedCode`, not merely that the
    `assistantAccess` document exists — otherwise a device could join on the
    stale code and be evicted a second later by the mismatch check, which
    looks like a bug and quietly undoes a revoke.
  - Still honest about what it is: guard rails against mis-taps, not access
    control. `assistantAccess/{code}` has to hold the team code or the code
    couldn't resolve to a team, so someone who opens devtools on the helper's
    device can recover it. Real sign-in is the fix, and it's its own project.
- **Export has a matching Restore** (`restoreFromBackup`, Settings). A
  backup nobody can reinstate isn't a backup, and for a long time the
  export was a file you could read but never restore. It writes whichever
  of the three docs the file contains, so an older backup missing
  `branding` leaves branding alone rather than blanking it, and it replaces
  rather than merges — half a restored roster inside a live one is worse
  than either state alone. Two-tap confirm, and it reports what it read.
- **Set number lives on the lineup, not as a separate global counter**
  (`lineup.setNumber`). This was a deliberate fix — there used to be two
  numbers that could drift out of sync (which lineup tab was active vs.
  which set was "current"). Don't reintroduce a separate global set counter.
- **`lineup.currentRotation`** tracks which of the 6 rotations a lineup is
  actually sitting at. Two related functions:
  - `computeRawRotationSlots(lineup, targetRotation)` — the pre-substitution
    arrangement (who's assigned to each spot, no subs applied). **This is
    the only thing that should ever get committed as a lineup's real
    starting data.**
  - `computeRotationSlots(lineup, targetRotation)` — the same thing with
    substitutions layered on top, for *display only* (court diagram
    preview, Serve-Receive reference).
  - Mixing these up caused a real data-corruption bug: committing the
    with-subs version as the real lineup baked a substitution permanently
    into the starting data instead of leaving it to be computed fresh each
    time. If you touch rotation logic, keep this split.
  - Related: `slots.P1` (the fixed grid position at back-right) is always
    the actual current server, live, at whatever rotation is showing —
    that's just what the rotation-shift math produces. Don't confuse this
    with the separate `servesFirst`/"1st Server" badge in the UI, which
    only marks who served the very first point of the set and is drawn at
    a fixed slot letter (P1 or P2) regardless of which rotation you're
    viewing — it's a historical/scoresheet marker, not a live indicator.
- **The Serve-Receive sheet draws where everyone STANDS AT THE SERVE, and
  arrows to where they go after it.** Two separate fixes, both from the same
  coach report ("the diagrams are a little confusing"), and the second one
  undid half of the first — read both before changing this sheet again.
  - **A marker is drawn at its at-contact position (`coord`), and `moveTo` is
    where it goes once the ball is away.** That one rule decides everything on
    the sheet. A passer gets no `moveTo` at all: the receive line *is* her
    alignment, not somewhere she travels to afterwards, and the lines this
    sheet used to draw from each passer's rotational zone implied a move that
    never happens. The 5-1/6-2 setter's `moveTo` is `NET_TARGET` and her
    `coord` is her rotational spot — she used to be drawn *at* the net, which
    was exactly the error the coach reported for the 4-2.
  - **`deriveServeReceive` returns a `frontSwitch` map** (`rotational slot ->
    played slot`), populated for the **4-2 only**; 5-1 and 6-2 get an empty map.
    Assignment is claim-based with a fallback loop, so a front-row player the
    position tags don't place (an Opposite, a DS pushed up, no `position` set)
    still gets a free spot instead of landing invisibly under someone else.
  - **There are two 4-2s and the team picks which** —
    `mainDoc.roleSystem.setterFront`, `"right"` (the default, and what this
    coach runs) or `"middle"`, chosen in Lineup → Serve-Receive Settings, which
    only shows that picker when the system is 4-2:
    - `"right"` — the advanced / "international" 4-2: setter to right front
      (P2), middle blocker to the middle (P3), outside to left front (P4).
    - `"middle"` — the classic beginner 4-2: setter sets from the middle (P3)
      and the two hitters take the pins, outside left (P4), the other hitter
      right (P2).
    Which one a squad runs cannot be inferred from the roster, which is why
    it's a setting rather than a guess. Both variants are the same two
    `assign` lines with the targets swapped; the stack, arrow and colour code
    below is entirely generic over the destinations and needed no change. Note
    the middle-front variant leaves rotations 2 and 5 with NOBODY switching —
    everyone is already in their played spot — which is correct, not a bug.
    The caption names the right destinations for whichever variant is on.
  - **STACKING is the whole point of the second pass.** The overlap rule
    (FIVB 7.4) is judged only at the instant of serve contact, and only against
    your neighbours in your own row and the player directly behind you — so a
    front-row player about to switch does NOT have to wait at her rotational
    zone. She may stand as close to where she's heading as the left-to-right
    order (4-3-2) allows. Drawing all three spread across their zones, which is
    what this sheet did first, shows a front row that never exists: when all
    three switch they bunch together and release on contact.
  - **A stack is a near-vertical COLUMN, not a row** — the coach's correction,
    and the thing to keep in mind if you ever re-lay this out. The sideways
    test needs only part of one foot: the player based front-right has to stay
    a sliver right of the one to her left, nothing more. Depth is free, because
    the front-to-back test is against the back-row player she's paired with and
    the passers are at the back of the court. So they wait almost on top of each
    other: `STACK_GAP` is a **7%** sideways step, with `STACK_DY = 16` of depth
    between them to keep the circles clear. A first pass laid them out in a row,
    which needed a 20% gap just to fit the circles and so drew a much looser
    front row than a stack really is.
  - **The sideways positions are solved, not hardcoded**: `stackXs` is a
    weighted isotonic regression (pool-adjacent-violators) over "everyone wants
    to be at her destination, subject to rotational order with `STACK_GAP`
    between neighbours", then shifted back inside the court. **The setter
    carries double weight** because hers is the run on a clock — she has to beat
    the pass to the net — which is also why coaches stack toward the setter's
    side. Change the weight and every rotation's picture changes; it is not a
    tuning knob to fiddle with casually.
  - **Depth is ordered by how far each player has to go**: longest trip starts
    deepest, so she runs *behind* her team-mates rather than through them, and
    whoever is barely moving stands where she'll play, at the net. Two players
    crossing are separated by a small bonus for travelling leftward, which puts
    the one sweeping left behind. Only players who actually move take a depth
    rank — counting a front-row player who is already home (she's drawn at the
    net, not in the column) pushed everyone else a row deeper than they needed.
  - **The stack sits OFF the net (`STACK_Y = 24`) and the destinations are at
    the net.** This is both true (a stacked front row needs room to approach)
    and the thing that makes the drawing work: with the stack and the
    destinations on one line at the net, the arrows came out shorter than the
    circles they joined and were swallowed whole. Markers were also shrunk
    62px -> 56px to fit three bunched circles at 390px.
  - **Arrows are solid, 4px, with a real polygon arrowhead** — the coach asked
    for "bold and obvious, not dashed lines". Each one's trims and head length
    are capped as a *fraction* of the trip, or a short slide gets eaten
    entirely by its own clearances (that bug shipped once in this session: a
    13%-long move rendered as a 2.7% stub). The destination is a dashed ring
    carrying the same jersey number, suppressed when another player is still
    standing on that spot — the arrow pointing at her says it better.
  - **Arrows BOW around anyone standing in the way** (`avoid`, `CLEAR_R`): a
    quadratic Bézier whose control point is pushed off the straight line by
    however much it takes to clear the obstructing circle, to whichever side has
    room. The arrowhead is pointed along the curve's tangent at the tip, which
    for a quadratic is just the direction from the control point. This is not
    decoration — markers paint on top of arrows, and the player sweeping across
    the whole front row passes right under her team-mates, so the straight
    version of her arrow was visible only as a stub either side of them.
  - **One colour per switching player, keyed by ROLE so a coach can learn it**
    (`moverColor`): setter gold, middle green, outside purple, anything else
    red. The marker, the arrow and the destination ring all carry it, which is
    what lets three paths crossing the front row be told apart — the coach asked
    for this directly. **`purple` was added to both palettes in `shared.js` for
    it**, because light mode's `orange` token is a dark *green* (see the palette
    note below), so green/orange is an illegible pair in one of the two themes.
    Verified by rendering both themes, not by reading the hex values. The legend
    only shows the Middle and Outside chips when such a player is actually
    moving, so 5-1/6-2 keeps its two-chip legend.
  - **The court box is taller than it is wide, so a y percent covers more
    pixels than an x percent.** `arrowGeom` builds the head in squared-up space
    (`Y_PER_X = 1 / 0.82`, matching the container's `aspectRatio`) and converts
    back, or the heads come out skewed. The arrow SVGs use
    `viewBox="0 0 100 100"` with `preserveAspectRatio="none"` and
    `vectorEffect="non-scaling-stroke"` so the shaft keeps an even width.
  - **The deadband that drops a pointless arrow is measured differently for
    the two cases**, and conflating them is a real bug that shipped mid-session:
    a stacked switcher is measured SIDEWAYS only (every one of them shares the
    same step up to the net, so across-court travel is what says whether she's
    switching), while anyone else is measured as a true distance. The 5-1
    setter releases almost straight up the court, and the x-only test cancelled
    her arrow entirely. She still takes part in the stack ordering even when
    she isn't moving, or a neighbour can be placed straight through her.
  - **The sheet PRINTS too: one page per SET, six rotations on each** — print
    target `"servereceive"`, offered in the Lineup print menu. It maps over
    every lineup, not just the active one — a coach prepping for a match wants
    the whole book, and the first version silently printed only set 1. Each set
    is a `.servereceive-page-group`, registered in `handlePrint`'s `PAGE_GROUPS`
    map so it is captured as its own PDF page; without that, height-based
    slicing cuts a set's courts away from its own heading, which is the same
    bug the sub sheet and player guide already had. Three things made that
    possible, and all three are load-bearing:
    - **`serveReceiveGeometry` (module scope) returns the whole picture as
      data** — markers, arrow paths, the lot — and both the screen overlay and
      `PrintArea` render from it. It had to be hoisted out of the overlay's
      render closure first: `PrintArea` is always mounted and anything it calls
      from another component's scope is a ReferenceError that blanks the app.
      `no-undef` caught the one dangling reference during the hoist, which is
      exactly what that lint pass is for.
    - **It returns colour KEYS (`"S"`/`"MB"`/`"OH"`), never resolved colours.**
      `PrintArea` uses zero `COLORS` tokens anywhere — every sheet is hardcoded
      black-on-white — because a sheet printed from dark mode would otherwise
      come out in dark-mode hues on white paper. The screen resolves the keys
      through `COLORS`, the sheet through its own print palette. Same lesson as
      `STAT_BUTTONS` storing a `colorKey`.
    - **`aspect` is a parameter, not a constant.** The arrowhead maths needs the
      container's width/height to build heads in squared-up space; the printed
      courts are taller than the screen's (0.68 vs 0.82) because three across is
      fixed by the page width, so the only room to give the stack is downwards.
    Circles carry the jersey number, with the **short name (`displayName`)
    printed just BELOW each circle** — at 34px a circle holds a number or a
    name, not both, but the court's dead space under each marker was free. The
    label is sized to its own text and centred by the transform: a fixed width
    with `overflow`/`textOverflow` clipped the names to "a S." the moment a
    background span went inside it. It carries an **opaque white background**,
    because the labels paint over the arrows but the bow maths only knows about
    circles, so an arrow ran straight through the words under every stacked
    front-row player; the background lets it pass behind the name instead. (A
    text-shadow halo would look better — html2canvas renders those unreliably.)
    Verified by measuring every label's rect in the DOM: no two overlap and none
    escape its court, even with first names as long as "Bartholomea" three
    abreast in the receive line. The ON COURT / LIBERO key underneath stays as
    the full-name reference, same convention as the lineup sheet's roster key. The legend only lists roles that actually move in some
    rotation, so a 5-1 sheet shows Passer and Setter rather than all four.
    Verified by rendering the real PDF (not the JSX, not a DOM screenshot):
    three sets produce a three-page letter PDF, each page naming its own set and
    showing its own starting six — asserted, because a sheet that silently
    reused the active lineup for every page would pass a page COUNT check. Each
    page group is measured on its own against a letter page's height (the
    section as a whole is now three pages tall, so measuring that overflows by
    design); 5-1, 6-2, the middle-front 4-2, a lineup with an empty slot, one
    with no libero, and a long team name all still fit a page each.
  - **DEFERRED, DO NOT "FIX" UNASKED — the 5-1's setter release.** Two things
    look off on the 5-1 and are deliberately untouched (see "Open — deferred"
    at the end of this file): on rotations 3 and 6 the setter is already at
    right front, so her destination ring lands almost on top of her own circle
    and the arrow is a stub; and `NET_TARGET` (80, 24) is further from the net
    than P2's own base (84, 14), so she appears to move backwards off the net
    to set. The coach has not reported either, and asked to look at the 5-1
    himself before anything changes. Flagging them is the point; changing them
    is his call.
  - **Anything that queries the DOM for diagram markers must scope to visible
    elements now.** The always-mounted print root holds six more courts, so an
    unscoped `querySelectorAll` sees 42 markers instead of 6 and reports every
    one as overlapping — which is how `sr42check.mjs` produced 506 failures the
    first time this sheet existed. Same family as the `textContent` trap below.
  - Verified in the harness at 390px across all six rotations, by assertion and
    by eye (`pwcheck/sr42check.mjs`): six live markers with no two overlapping,
    **the overlap rule checked against slot occupancy derived independently from
    the seed** (ring `P4->P3->P2->P1->P6->P5`, one step per rotation) rather than
    read back out of the app, every front-row role either standing at or ringed
    at its played spot, no two movers sharing an arrow colour, and an arrowhead
    for every mover — plus screenshots of the 4-2 in both themes and of the 5-1.
    **Run it for both 4-2 variants** (`VARIANT=right` / `VARIANT=middle`); the
    middle run flips the setting through the real picker rather than poking
    state, so it covers the UI too. Per this file's standing rule for diagrams:
    don't trust the JSX.
- **Substitution pairings** (`{ frontId, backId, isLibero, liberoServes }`)
  are bidirectional — either player could be the one actually placed on
  court, and `applySubPairings` has to check both directions (which one is
  on court determines which way the swap triggers). This wasn't obvious and
  took a real bug report to catch.
  - A libero can have more than one pairing (e.g. subbing for two different
    middles who alternate which is back row) — `pairingValidationError`
    specifically allows a libero to be double-booked as the back-row player
    across pairings, unlike a regular player. Real volleyball rule: the
    libero is only allowed to actually *serve* in one of those rotational
    turns, not both — `liberoServes` marks which pairing that is (enforced
    to be exclusive per libero in `toggleLiberoServes`), and
    `findActiveLiberoPairing` + the cue banners in `LineupScreen`/
    `LiveScreen` surface whether the libero is currently allowed to serve
    or the real player needs to sub in just for that turn.
- **`setActiveSlots` must be given an updater function, not a prebuilt
  object**, for anything that changes one slot. It replaces the lineup's
  whole `slots` object, so `setActiveSlots({ ...slots, [x]: y })` built
  from a render-captured `slots` silently loses any other change made in
  the same tick. That was a real, reproduced bug: a rotation can produce
  two suggested subs at once (the libero criss-cross — one middle
  rotating front as the other rotates back), and tapping both quickly
  applied only the second. Both suggestions still vanished from the list,
  so nothing showed a sub hadn't happened, and the app's court then
  disagreed with the real court for the rest of the set — corrupting
  later rotations and attributing stats to the wrong players. Fixed by
  making `setActiveSlots` accept an updater that derives from the
  lineup's current `slots`; `confirmSuggestion` and
  `confirmFreeSubstitution` both use that form. `advanceRotation` still
  passes a plain object, which is fine — it's one wholesale write per
  swipe gesture and can't double-fire in a tick.
- **The free-substitution sheet offers a libero for back-row slots only.**
  It used to exclude designated liberos from the bench list entirely, on
  the theory that liberos should only ever come on via pairing-driven
  swaps. That was wrong in practice: a coach who hasn't set up pairings
  runs the whole match off this sheet, and it meant the libero could never
  be put on court at all. Now `bench` keeps liberos when
  `BACK_ROW_SLOTS.includes(subSheet.slot)` and still drops them for P2/P3/P4,
  where a libero would be illegal. Three things follow in
  `confirmFreeSubstitution`:
  - The swap increments `liberoSubCount`, not `subCount` — by rule it's a
    libero replacement, not a substitution. The sheet's caption switches to
    say so as soon as a libero is the selected incoming player.
  - Bringing a libero on **records the pairing it implies**
    (`{frontId: outgoing, backId: libero, isLibero: true}`, appended only if
    that exact pair isn't already there). Without it, nothing would prompt
    to take the libero back off before they rotate to the front row — the
    manual sub teaches the app the pairing it wasn't given.
  - Taking a libero **off** this way deliberately skips the pairing rewrite
    that a regular free sub does. Mapping the libero's id onto a regular
    player would leave a pairing flagged `isLibero` with no libero in it.
- **A free substitution counts against `SUB_LIMIT`** unless "mark injured"
  is checked or a libero is involved. It used to count against nothing at
  all — the sheet said so outright — on the reasoning that pairing-driven
  subs were the "real" ones. In practice a coach without pairings set up
  runs the entire match off this sheet, so `Subs: 0/18` sat there all night
  while real substitutions were being spent. The three cases, all in
  `confirmFreeSubstitution`: libero involved → `liberoSubCount` only;
  `markInjured` → neither counter (an injury sub isn't charged, which is
  now what that checkbox is *for*, not just a visual tag); otherwise →
  `subCount`. The sheet's caption names which of the three is about to
  happen, and going over the limit warns rather than blocks, matching how
  `overLimit` already behaves on the suggestion cards.
- **`mainDoc.subEntries` is the per-set record of who went in for whom**
  (`{ playerId, forPlayerId, slot, at }`, appended by both sub paths, reset
  alongside `subCount` at every set boundary, and snapshotted by
  `pushHistory` so Undo rolls it back). It exists for one reason: NFHS
  re-entry has to be back into the same spot in the serving order, so once
  #37 goes out for #20 those two are bound to each other for the set, in
  **both** directions — hence `boundCounterpart(playerId)`, which matches a
  player on either side of the first entry they appear in. The free-sub
  sheet renders it in two places: a second line on each bench row (`back in
  for #20` dim, or `tied to #20 this set — different spot in the order` in
  gold) and a `Tied to #N` clause under the outgoing player. Both are
  reminders only — nothing is disabled and nothing blocks, deliberately,
  because this is read one-handed during a live match. Liberos are never
  recorded here; a libero replacement isn't a substitution and carries no
  re-entry rule.
- **"Make this a pair"** is a checkbox in the free-sub sheet that turns the
  substitution being made into a standing pairing on the lineup, so later
  rotations suggest it on their own — the point being that a coach who
  never set pairings up can build them from the bench as the match happens.
  It's only offered when it would be a valid new pairing (a real sub, and
  neither player already in one — `canPair`), and `confirmFreeSubstitution`
  re-checks that before writing. Which side is which comes from the slot:
  subbing into a back-row slot makes the incoming player the `backId` half,
  a front-row slot makes them `frontId`.
- **Simple mode can advance the set, and creates the next lineup itself.**
  `startNextSet({ autoCreate })` returns `null` on success or a message
  string when it can't proceed — it no longer calls `alert()`, which was
  the exact iOS-standalone-PWA hazard documented further down this file
  (there were two such calls, one here and one at the Full-mode swipe's
  call site). Full mode still blocks on a missing lineup for the next set
  and shows that message in-app, since that mode is built around per-set
  lineups. Simple mode passes `autoCreate: true` and duplicates the current
  lineup instead, because Simple mode manages no lineups at all and a coach
  who only wanted the score cleared would otherwise dead-end. Both modes
  use a `SwipeConfirm`, not a tap — it wipes the scoreboard.
- **`advanceRotation` never suggests bringing in a player who is already on
  court.** A libero with more than one pairing otherwise gets suggested "in"
  for a second player while standing on court — easy to hit now that a
  libero can reach the court from the free-sub sheet too. The guard is
  `onCourtAfterRotation` (computed from `rotated`) on both suggestion
  branches.
- **A captain-vote ballot holds up to `VOTES_PER_BALLOT` (2) picks, wrapped
  in an object: `{ picks: [id, id] }`.** The wrapper is load-bearing.
  `ballots` was briefly an array of arrays, and **Firestore rejects nested
  arrays outright** — the resulting `setDoc` error failed every write to the
  entire `main` doc, not just the vote, and took the app to the
  `ErrorBoundary`. An array of maps is legal and a map may hold an array, so
  this shape is fine; don't flatten it back. The same rule applies to any
  new field: an array may never directly contain another array.
  Ballots cast under the old one-pick shape are bare ids, so every read goes
  through `ballotPicks(b)` — an election already part-way through when the
  app updates still tallies correctly instead of counting those as zero.
  Keep that normalizer if you touch the vote. Submitting needs at least one
  pick, not two ("up to 2"), and tapping a third candidate is a no-op rather
  than dropping an earlier pick — a player passing the device should never
  have a choice vanish without tapping it off. The results view counts
  ballots and votes separately, since they're no longer the same number.
- **Never call another component's setter inside a `setState` updater.**
  `undoMatchAction` restored the score, counters, rotation, pairings and
  injured list from inside `setMatchHistory((prev) => ...)`. React runs
  updaters during the render phase and requires them to be pure, so every
  one of those was a setState fired mid-render (React's warning names it:
  "Cannot update a component (`AppInner`) while rendering a different
  component (`LiveScreen`)"), and an updater React chooses to re-run would
  fire them all again. It reads the last history entry from current state
  and pops it in a separate, pure updater now. Worth knowing the smell:
  a `set…` call inside another `set…`'s callback is always this bug.
- **Use `todayISO()` (in `shared.js`) for a calendar date, never
  `new Date().toISOString().slice(0, 10)`.** `toISOString` is UTC. West of
  UTC — where this app is actually used — it rolls over to tomorrow at 8pm
  local (UTC-4) or 7pm (UTC-5), which is prime match-and-print time. A real
  report: a box score saved on the evening of the 22nd downloaded named
  `...-2026-09-23.pdf`. Filenames were the visible half; the comparisons
  were the harmful half, because a match's `date` is a local calendar date
  the coach typed into the form, so comparing it against a UTC "today" made
  tonight's match read as already played from 8pm onwards — `goToMatch`
  then opened Insights instead of lineup prep for a match about to start.
  Four call sites in `App.jsx` plus the Tournament Builder's PDF filename
  all had it. Keep `toISOString()` for an actual instant (`exportedAt`, a
  crash's `at`) — those are timestamps and UTC is right for them.
- **`activeLineupId` can go stale.** It's only ever updated by
  `startNextSet()`/`endMatch()` on the Live screen — deleting a lineup on
  the Lineup screen didn't used to check whether it was the active one, so
  it could end up pointing at an id that no longer exists in `lineups`.
  Every reader already falls back to `lineups[0]` when that happens (so it
  was never visibly broken in this app), but `deleteLineup` now repoints it
  immediately instead of leaving it dangling — keep that fix if you touch
  lineup deletion.
- **`endMatch()` resets every lineup's rotation to 1** and returns to the
  Set-1 lineup — lineups are persistent templates reused match to match,
  not per-match data.
- **`match.lineupSnapshots` is the only per-match record of who actually
  played.** Because lineups are reused templates, a past match had no
  history of its own: its stats carry a `lineupId` pointing at a template
  that has since been edited, so opening a played match showed today's
  lineup as though it were that match's. `snapshotLineupForMatch` (in
  `AppInner`, called from `recordStat`) freezes the set's lineup onto the
  match the first time a stat lands in that set — keyed by set number, first
  write wins, never updated afterwards. It stores
  `computeRawRotationSlots(lineup, 1)`, i.e. the starting six, not whatever
  is on court at that moment, and the raw form for the usual reason (subs
  are display-only and must never be committed as real lineup data).
  **`endMatch()` is what locks a match in**: it backfills a snapshot for any
  set that has points but no stats (and the set in progress when the match
  ended), derives `setScores` per set from `pointLog`, and stamps
  `completedAt`. A snapshot taken during play always wins over the backfill.
  `LineupScreen` renders `MatchLineupRecord` — read-only, with an "Edit
  current lineups instead" escape hatch — whenever the active match has
  `completedAt`. **Not** a date test: an earlier pass used "dated before
  today", which was wrong in both directions (a match ended this evening
  isn't before today and stayed unlocked; a passed date that was never
  played locked for no reason). The date test survives only as a fallback
  for matches that have snapshots but predate `completedAt`.
  Matches played before any of this existed have neither and fall back to
  the old behavior; there's no way to reconstruct them.
  Shape note: snapshots are a map keyed by set number, holding `slots` (a
  map), `liberos` and `pairings` (arrays). No array ever directly contains
  another array, which Firestore would reject.
- **Deleting a match from the Schedule does NOT delete its stats, but does
  lose its record.** Stat entries live in the `logs` doc keyed by `matchId`;
  `deleteMatch` only filters `main.matches`, so the numbers survive and
  Season to Date (which reads the whole `log` with no match filter) keeps
  counting them. What dies with the match is everything stored *on* the
  match object — `lineupSnapshots`, `setScores`, `completedAt` — and the
  surviving stats become unreachable per-match, since the box score picker,
  the Insights list and Trends all build their lists from `matches`. That
  made a mis-tap expensive, and the trash icon had **no confirmation at
  all** — one tap, gone. It's a `ConfirmButton` now, reading "Delete
  record?" rather than "Delete?" when the match carries stats or a
  completed record (`hasRecord`, fed by `matchIdsWithStats` from `AppInner`).
  **Deleting one is recoverable**, and it happened for real, so it's built:
  `orphanedMatches` (in `AppInner`) finds every `matchId` in `log`/`pointLog`
  with no match on the schedule, and `recoverOrphanedMatch` rebuilds that
  match **reusing the same id**, which is what relinks the stats, the point
  log and every per-match view at once. The date is inferred from the
  earliest entry's `id` (stat ids are `Date.now() + Math.random()`, so
  `Math.floor(id)` is when it was recorded, i.e. the evening it was played),
  and `setScores` is recomputed from `pointLog`. `lineupSnapshots` genuinely
  cannot be rebuilt — it lived on the match object — so the record comes
  back without them rather than with invented ones. Surfaced both in
  Settings → Recover Deleted Matches and as a banner on the Schedule screen,
  since that's where the deletion happens and where a coach looks first.
- **Stats recorded with NO match selected are a separate loss from a deleted
  match, and need a separate repair.** An orphan (above) still carries a
  `matchId` whose match was deleted, so rebuilding that match with the same id
  relinks everything. These carry no id at all — they were tapped while the
  Live screen said "No active match" — so they count in Season to Date and are
  invisible in the box score, Insights and Trends, and `orphanedMatches`
  explicitly skips them (`if (matchId == null) return`). This happened for
  real, for a whole match. Two halves, both needed:
  - **Prevention: a loud banner on the Live screen** (`activeMatchId == null`),
    right above the stat buttons, tapping through to the Schedule. The header
    already said "No active match" in a dim subtitle — far too quiet to notice
    mid-rally, which is exactly how an evening's stats got stranded. Shared by
    Simple and Full mode, since it sits with the "Recording for" banner.
  - **Repair: `unassignedEntries` + `assignUnassignedTo`** (both in `AppInner`,
    below `log`/`pointLog` — see the temporal-dead-zone warning), surfaced in
    Settings → Stats Not Attached To A Match and as a Schedule banner beside
    the orphan one. Entries are grouped by the LOCAL calendar day they were
    recorded (`Math.floor(entry.id)` is the timestamp), because that's what a
    coach can recognise. Attaching stamps the `matchId` and **rebuilds that
    match's `setScores` from the point log**, the same way `endMatch` and the
    orphan recovery do, or the box score would show stats with no set scores.
    `setScores` is computed from what the point log is ABOUT to be, not from
    state, since `setPointLog` hasn't applied yet in that tick.
  - The match defaults to one played on the same calendar day when the
    schedule has one, which is the overwhelmingly common case. It's a
    `ConfirmButton`: picking the wrong match moves a whole evening onto it and
    there is no undo.
  - **The Settings section stays rendered while `assignReport` is set**, not
    only while something is unassigned. Attaching empties
    `unassignedEntries`, so a section gated purely on that vanished the
    instant you tapped it and took the only confirmation with it — caught in
    the harness, not by reading the JSX.
  - Verified end to end in the harness: the Live banner shows in both modes
    and clears when a match is made active, the Schedule banner appears and
    clears, the picker defaults to the same-day match, and attaching moves
    exactly the right 12 stats and 8 points, leaves an already-attached entry
    alone, and rebuilds per-set scores. One trap worth knowing for any future
    harness assertion: **`textContent` on `body` (or any visible ancestor)
    includes the hidden print root**, which carries its own "No match
    selected" text — a check that the banner is gone has to look at visible
    leaf elements, or it reports a false failure.
- **`EMPTY_LINEUP` (module scope) is the fallback when `lineups` is empty.**
  Every screen resolved its lineup as `lineups.find(...) || lineups[0]`,
  which is `undefined` for an empty array, and the next line reads
  `.setNumber` off it — a render crash on the Live screen, caught by the
  `ErrorBoundary`. `deleteLineup` refuses to remove the last lineup so the
  app can't normally produce this, but it can arrive from outside: the
  snapshot handler merges `{ ...defaultValue, ...snap.data() }`, and a
  stored `lineups: []` **overrides** the default rather than falling back
  to it. Found by fuzzing the real team doc with mutated shapes (deleted
  player still referenced by a stat, missing lineup id, empty slots, empty
  roster, ghost pairings, ghost snapshots, odd point log) — that sweep is
  worth repeating after data-shape changes; only the empty-lineups case
  crashed, and it now renders an empty court instead.
- **The box score has its own match picker (`statsView.boxMatchId`), not
  `activeMatchId`.** It used to filter on `activeMatchId` directly, which
  made a just-finished match unreachable: `endMatch()` clears
  `activeMatchId` on purpose (new stats must never land on a closed match),
  so the box score fell through to entries with no match at all and read
  "No stats recorded yet" while the stats sat there intact. Resolution order
  is explicit pick → active match → most recent match with stats. `PrintArea`
  reads the same `statsView.boxMatchId`, or printing a finished match's
  sheet silently prints the live one. The End Match button only renders when
  the box score is actually showing the active match, so it can't end one
  match while you're looking at another.
- **The Live screen has a Simple/Full toggle** (`vb-live-simple`, a
  per-device localStorage preference, not team data). Full is the original
  match-management surface; Simple hides rotation, subs, sub counters and
  the court, and shows the entire roster as tappable numbers — tap a
  player, tap a stat. It exists because running the full screen solo
  during a live match was too much to manage. Both modes share the score
  bar, the "Recording for" banner, the stat buttons and the undo tray;
  the only thing they disagree on is `currentPlayerId` (court slot vs.
  the simple-mode selection). Stat entries carry a `slot` field that
  **nothing in the app ever reads**, so Simple mode writes `slot: null`
  with no downstream effect — box score, season stats and Player Eval all
  key off `playerId`/`matchId`/`setNumber`.
- **The Live screen's stat buttons are 16px in a 40px block, and the size was
  measured rather than chosen.** The coach asked for bigger type without bigger
  blocks. At the narrowest phone that matters (375px) each button has 100px of
  text room once the side padding is 2px, and the longest label
  ("Service Att." — "Passing Err" is a close second, so shortening one wouldn't
  buy much) needs 91.8px at 16px bold: an 8px margin. 17px fits a 390px screen
  with 3px to spare, which is not enough to trust on a device nobody measured.
  Checked with the webfont BLOCKED too, since uncached Google Fonts is the
  normal offline state in a gym. Vertical padding dropped 12px -> 9px to hold
  the block at the 40px it always was, and `whiteSpace: nowrap` makes it
  impossible for a wrapped label to grow the block on some font stack we
  haven't seen. Verified at 375/390/414px, both Simple and Full mode, with and
  without the webfont: every block still 40px, nothing clipped.
- **Two separate stat lists**, both team data in `mainDoc`, edited through
  one Settings section ("Stats") with a Track/Print toggle:
  - `trackStatKeys` → which stat buttons appear on the Live screen (both
    Simple and Full).
  - `printStatKeys` → which columns appear on printed box scores.
  They were briefly merged into one list, then split again on the
  realization that what you record live and what you hand to parents are
  different decisions (track block errors for yourself, leave them off the
  sheet). The Print list flags any stat that's printed but not tracked
  with "not tracked, will print empty", since that combination always
  yields a blank column. Unchecking a stat only hides it — nothing
  already recorded is deleted. An empty `trackStatKeys` deliberately
  falls back to showing all stats rather than leaving a Live screen with
  nothing to tap; note `mainDoc.trackStatKeys || [...]` does NOT cover
  that case, since `[]` is truthy — the fallback is in
  `visibleStatButtons` in `LiveScreen`.

- **Translucent fills are palette tokens (`accentSoft`, `greenSoft`,
  `redSoft`, `blueSoft`, `goldSoft`, `tintHex`), never inline `rgba()`.**
  Every tint in the app used to be a hardcoded literal of a *dark-theme*
  hue, so light mode drew a salmon-orange "selected" fill everywhere while
  its accent is actually dark green, and the fills were pale enough on white
  to read as washed out. Light mode now carries both deeper hues
  (green/blue/red/gold) and stronger alpha. If you add a colored fill, use a
  token; a new inline `rgba()` silently reintroduces the bug in one theme
  only, which is easy to miss when you develop in the other.
  **Light mode's `orange` is a dark GREEN** (the key name was kept because
  everything references it; only the value was repurposed as that theme's
  accent). So `orange` and `green` are two greens in light mode and cannot be
  used as a contrasting pair — that is why the Serve-Receive sheet's third
  track colour is the `purple` token rather than one of those. Check any new
  multi-colour encoding in BOTH themes by rendering it.
  Two specific traps this uncovered, both fixed, both worth not repeating:
  - `STAT_BUTTONS` held `color: COLORS.green` at module scope. That module
    is evaluated once, while `COLORS` is still the dark palette, so it froze
    the dark green permanently. It stores a `colorKey` now and resolves
    through `COLORS` at render. **Anything at module scope that reads
    `COLORS` captures the dark theme forever** — `COLORS` is reassigned by
    `Object.assign` per render, so only render-time reads are theme-aware.
  - `SwipeConfirm` built its fill from hardcoded RGB triplets picked by
    comparing the passed color against `COLORS.gold`/`COLORS.red`. It
    derives the triplet from whatever color it's given now
    (`hexToRgbTriplet`), so it tracks the live palette.

## Things that broke for reasons outside the app's own code

Worth knowing about even though they're not code issues:

- `src/firebase.js` got overwritten with placeholder values once, after a
  `git init` recovery (fresh git history force-pushed over the real repo,
  taking a stale local copy of this specific file with it). If Firebase
  ever stops connecting with no code-level explanation, check this file
  for literal `"YOUR_API_KEY"`-style placeholders before assuming it's
  something else.
- `main.jsx` used to force an immediate, unannounced page reload the
  moment it detected a new deployment (checked every 30 min). This was
  first fixed to ask via `window.confirm` — **but that turned out to be
  its own real bug**: `window.confirm`/`alert` are documented as
  unreliable inside an installed, standalone-mode PWA on iOS — the
  dialog can fail to actually render at all while still blocking the
  page's JS thread waiting for a response that never comes, which looks
  exactly like "the app is frozen" or "blank white screen." This is a
  very plausible explanation for a real report of the installed PWA
  going dark/unresponsive on the home-screen icon specifically (a browser
  tab and a home-screen PWA are separate contexts, each running this
  check independently). Fixed again: the update-check now lives in
  `useSWUpdate` inside `App.jsx` itself (not `main.jsx`) and surfaces as
  a plain in-app banner (state + a fixed bar with Reload/Later) instead
  of any native dialog or auto-reload. If you're debugging something
  that looks like "the app randomly reset mid-use" or "went blank/froze,"
  check this hasn't regressed back to `window.confirm`/`alert`/an
  unconditional reload.
- **`ConfirmButton` (module scope, near `SwipeConfirm`) is the replacement
  for `window.confirm` on a destructive action** — first tap arms it and
  swaps the label, second tap fires, and it disarms itself after
  `CONFIRM_ARM_TIMEOUT` so a forgotten armed button can't go off on a stray
  tap later. The captain vote's "Reset Votes" and "Start a New Election"
  use it — that sheet is handed around a locker room on the installed PWA,
  which is the worst possible place for a dialog that can fail to render —
  and so does **End Match** (Stats → Box Score), which locks the match in.
  The **PDF-failure `alert()` in `handlePrint` is gone too** — it needed an
  in-app error line rather than a `ConfirmButton`, and it was the
  worst-placed of the lot: it sat on the failure path of the feature most
  likely to fail on a phone, so a failed print could wedge the whole app.
  It's `printError` state now, rendered as a dismissible banner at the top
  of `AppInner`, and the error is also written to the crash log with
  `handlePrint(<target>)` as its component, so a print that fails courtside
  survives the walk back to the bench.
  **Two native calls remain**, both `window.confirm`, both far from any
  live-match path: the roster delete confirm and `Unlink this device from
  its current team?` (Settings).
- **Don't code-split this app.** `jspdf`/`html2canvas` (Print-only, and
  roughly a third of the bundle) were briefly switched to dynamic
  `await import(...)` to shrink the initial load. That was reverted the
  same day: it introduces runtime chunk fetching into an app that
  redeploys constantly, and every deploy changes the hashed chunk
  filenames, so a device still running an older build that then
  lazy-loads a chunk requests a file that no longer exists on the
  deployment. A single self-contained bundle simply cannot fail that
  way, which matters more here than initial-load size — this thing runs
  courtside on gym wifi. If bundle size ever genuinely needs solving,
  it needs a stale-client recovery story first.
- **`PrintArea` is always mounted, so a crash in it takes down the whole
  app.** A real instance: the "Box Score — By Set" sheet called
  `groupByPlayer`, which was a local `const` inside `BoxScoreScreen` — a
  ReferenceError from a different component's scope. It stayed invisible
  for a while because that sheet's own early return skips the call while
  the stat log is empty; the moment any stat existed for the active match
  it crashed the entire app to a blank screen, at sign-in, before the
  coach could reach any tab. The fix was hoisting it to module scope as
  `groupStatsByPlayer(entries, roster)`. Two lessons: anything `PrintArea`
  calls must be module-scope or passed in as a prop, and a bug behind a
  "only when there's data" guard can lie dormant through plenty of
  testing. A quick `eslint --rule no-undef` pass over `src/App.jsx` and
  `player-eval/src/App.jsx` catches this entire class in seconds and was
  clean as of build 2026.09.17c — worth re-running after any large
  paste-in of code from another session.
  **`no-undef` does NOT catch the other half of this class: a temporal dead
  zone.** `AppInner` is one enormous function body of `const` declarations,
  so a `useMemo` that reads a `const` declared further down throws "Cannot
  access 'X' before initialization" on every render and takes the whole app
  to the `ErrorBoundary` at load. It is valid, lint-clean, builds fine, and
  is invisible in a diff — both times it happened the memo looked perfectly
  correct in isolation. Two separate instances in one session
  (`matchIdsWithStats` above `log`, `orphanedMatches` above `pointLog`).
  When adding a derived value to `AppInner`, put it *below* every `const` it
  reads, and load the app once before believing it works — `npm run build`
  will not tell you.
- **There is an `ErrorBoundary`** wrapping the whole app (bottom of
  `App.jsx`, same in `player-eval/`). It catches render crashes *and*
  window-level `error`/`unhandledrejection` events, and replaces the
  blank screen with the actual error text, the build version, and a
  "Clear cached app & reload" button (unregisters service workers and
  deletes their caches, deliberately leaving localStorage/team code
  intact). This exists because the app is used on phones where there's
  no console to open — a blank screen previously gave the coach nothing
  to report and no way back in. Keep it, and keep it dependency-free
  enough that it can't itself be the thing that crashes.
  **Crashes are also written to `localStorage` (`vb-crash-log`, last 5) by
  `recordCrash`**, and read back in Settings → Recent Errors with a Copy
  button. That exists because the error text used to live *only* on the
  crash screen: a coach mid-match hits Reload — rightly, it gets them back
  to the bench — and the only record of what went wrong is gone. That
  happened for real, twice in one match, leaving nothing to diagnose.
  `recordCrash` is dependency-free and try/caught at every step: it runs
  when the app is already broken and must never be the thing that throws.
  **A window-level `error`/`unhandledrejection` is recorded but does NOT
  take the app down — only a real React render crash
  (`componentDidCatch`) shows the crash screen.** This distinction is the
  whole answer to "it crashed on me mid-match, I hit reload and it was
  fine." The crash log, once it existed, showed five entries all reading
  `Script https://volley-bandit.vercel.app/sw.js load failed`, spaced about
  32 minutes apart: `useSWUpdate`'s 30-minute `registration.update()`
  rejecting on gym wifi. Nothing was broken — a background housekeeping
  fetch failed, the rejection went unhandled, the boundary treated it as
  fatal, and a coach lost their live match screen. Reload "fixed" it
  because there was nothing to fix. `useSWUpdate` now catches at every
  level (`update()`, `onRegisterError`, `registerSW` itself, `applyUpdate`)
  — a failed update check is normal offline and must never surface — and
  the boundary only nukes the UI when the UI is genuinely broken. Keep both
  halves: catching at the source stops the noise, and the boundary's
  restraint stops the next unhandled rejection from doing the same thing.
- The user has hit real iOS-vs-other-browser inconsistencies (Chrome for
  iOS doesn't support the same file-sharing API Safari does, for example).
  The print flow has fallbacks for this; be careful not to remove them
  without testing on Chrome-iOS specifically.
- The `main` branch's git history has been rewritten/replaced at least
  once already (a phone-based "upload files" commit that has no common
  ancestor with older local clones or branches). If a `git push`/`git
  merge` reports unrelated histories or a rejected non-fast-forward push,
  don't force through it blindly — check whether `origin/main` actually
  has newer real work (it has, before) before deciding which side wins.

- **Google Fonts are loaded from the network and nothing caches them.**
  The service worker's `globPatterns` only covers the build output, so
  `fonts.googleapis.com`/`fonts.gstatic.com` are uncached: offline, the app
  renders in fallback system fonts. This was investigated as a suspect for
  "the screen freezes with no service" and **disproved** — with both font
  hosts stalled indefinitely (Playwright route that never resolves, which is
  what no signal actually does, unlike a fast failure), a print still
  completed in 0.9s versus 0.8s with fonts served instantly. So it's a
  cosmetic gap, not a hang. If you want the app fully self-contained
  offline, it wants `workbox.runtimeCaching` for those two hosts
  (CacheFirst, long expiry) — but don't sell it as a fix for a freeze.

## On testing

Whichever session (chat-based or Claude Code) built a given feature without
the ability to render or visually verify it had to rely on a real
round-trip of "ship it → user screenshots the actual output → diagnose from
the screenshot → fix → repeat," sometimes 3-4 times for one sheet. If you
have the ability to actually run this, view rendered output, or catch
errors before handing something back — use it. That's a real, structural
advantage, not a nice-to-have. Note the actual constraint even then: a
sandboxed dev-server/headless-browser session may still be unable to reach
Firestore directly (network policy) — in that case, verify pure logic with
a standalone Node script against the same data shapes, and be explicit
with the user about what was and wasn't actually verified end-to-end.

A stub that models documents only is not enough any more: the stat and point
logs are collections, so a stub whose collection listener never fires lets the
migration clear the legacy arrays and the entries simply vanish mid-test. The
stub must track docs by full path, fire the parent collection's listeners on
every write (latency compensation), and reject nested arrays.

The harness stub is now one shared core (`harness/firestore-stub-core.js`)
that each `firestore-stub-*.js` seeds with a different team document, and
it models collections as well as documents — including **latency
compensation**, where a local write fires the collection listener straight
away. That last part isn't a detail: it's what makes a tapped stat appear
instantly with no network, and a stub that only echoed server state would
have shown the whole feature as broken. `window.__stubColls` is the
collection store and `window.__stubPush(name, entries)` stands in for "the
other device wrote these", snapshot included. One more harness note worth
not rediscovering: a `vite.harness.*.js` config has to sit in the repo
root, not in the scratchpad — Vite resolves `vite` and the React plugin
relative to the config file, so a config outside the project can't load
them. Name it `vite.harness.<variant>.tmp.js`: that pattern is gitignored,
so a leftover one doesn't show up as an untracked file at the end of a
session.

The sharper version of that warning: a *stub* standing in for Firestore
only catches what it models. A session built one to test in the browser
without real network access, and it happily accepted a nested array —
so a change that broke every write in production passed every test here.
If you build such a stub, make it enforce the real service's constraints
(nested arrays, field-name rules, document size), not just its shape.
Anything the stub doesn't enforce, you haven't actually tested. It happened again,
in the worst way, with `codes: undefined` (see Player Access): a bug that
broke the feature 100% of the time in production while every check here
passed. Where a write's validity is what's in question, don't model
Firestore — hand the real SDK the real payload and let its own client-side
validation answer. `nodecheck/firestorewrite.mjs` is the pattern, and it
needs no network.

**An audit pass is worth running after a burst of feature work**, and the
first one (2026-10-18, after player access, `player-stats/` and the assistant
rework) is the template. What it covered, in the order that found things:

- **Exposure first, since that's what was new.** `nodecheck/exposure.mjs`
  checks a published player document against an ALLOWLIST of keys at every
  depth, rather than asserting the absence of fields someone thought of —
  that inversion is the point, because the first test can only catch what its
  author imagined. It also sweeps for values that must never appear at all
  (the team code, a full last name, a phone number, another player's code,
  the app passcode) and asserts a benched player's card leaks no fixture
  list. Clean.
- **The UI surface, by grepping every use of `teamCode` above the component
  layer** and asking which are reachable on an assistant device. That is what
  turned up Export — not a test, a grep.
- **Mechanical: `no-undef` over all three apps, every harness script
  re-run, and the data-shape fuzz sweep** (`pwcheck/fuzzshapes.mjs`, 15
  malformed shapes of the five fields added since the last sweep ×
  coach/assistant, asserting no crash and no `ErrorBoundary`). All clean,
  which is the useful half of a result like this.
- **Pass 3, the adversarial read of the new modules**, found three things,
  none of them reachable by a user today but all cheap to close: the code
  generators used `Math.random` (see the randomness bullet under Player
  Access); a superseded assistant code could still be joined with; and
  `player-stats`'s `codeCandidates` didn't strip the characters a code can't
  contain, so a typed code became a Firestore path SEGMENT that could address
  a deeper path. That last one can't escape the `playerAccess` collection it
  is nested under, so nothing of the team's was reachable — it is tidiness
  with a sharp edge, not a hole, and it's worth being precise about which it
  was rather than inflating it.
- Watch for the harness scripts drifting apart on PORTS (some point at 5185,
  the newer ones at 5188) — run two dev servers from the one config rather
  than editing the scripts.

## Player Access, and the seams left for charging money

The coach wants to sell this eventually — one-time fee or subscription, with
Player Eval, player access and other extras as paid upgrades, and more than
one organisation using it. Two decisions were made with that in mind, and
they are cheap now and expensive later, so don't undo them casually.

- **`entitlementsOf(mainDoc)` in `src/playerAccess.js` is the gate.** Nothing
  is gated today — every feature reads as on — but each paid-upgrade candidate
  reads through this one normalizer, so switching billing on is a change here
  plus a field on the team doc, not a hunt through a 12,000-line file. It
  treats a missing field as ON, never OFF: a team whose document predates
  billing must not silently lose a feature it has been using, and a failed
  read must never lock a coach out mid-match.
- **Published player docs are a TOP-LEVEL collection, `playerAccess/{code}`,
  not a subcollection of the team.** Three reasons and the third is the
  commercial one: a player app can resolve a code with one read and no idea
  which team she's on; security rules can make this path world-readable
  without exposing any team data; and it can be billed, gated or revoked on
  its own.
- **A published document must never carry the team code.** The team code is
  the writable key to everything, so it can't travel into something handed to
  a teenager. Same for the roster, lineups, schedule and any other player's
  line. A published doc holds one player's numbers, team TOTALS, and a short
  name ("Joy B.") — not a full name, because this is the one artefact here a
  stranger might hold and the players are minors. There is a Node test
  asserting exactly this; keep it passing if you add a field.
- **Every code comes from WebCrypto, not `Math.random`** —
  `src/randomCode.js`, shared by `playerAccess.js` and `teamAccess.js`. These
  codes ARE the credential, and V8's `Math.random` is xorshift128+: a handful
  of consecutive outputs is enough to recover the state and predict the rest.
  That matters here specifically because `generateCodes` mints a whole
  roster's worth in one pass from one generator and hands every one of them to
  a teenager — a player holding two or three team-mates' codes is exactly the
  input that attack wants, and the app already warns that the `jersey` style
  is teammate-derivable. It would be a poor joke if `random` and `hybrid` were
  too, just less visibly. `makePicker` also rejects the tail of the byte range
  rather than taking a modulo, because neither alphabet (30 and 31) divides
  256 and a plain `% n` would favour the first few letters. Every generator
  still accepts an explicit `rng` so tests can pin output;
  `nodecheck/randomness.mjs` asserts that stubbing `Math.random` does NOT
  change what comes out, which is what actually holds this in place.
- **Codes are global names** because one URL serves every organisation, so
  `generateCodes` is handed the codes already taken and never reissues one. It
  also never re-rolls an existing code: reissuing would silently kill a code a
  player already has, with no sign anything changed. Six characters, not four
  — four is ~1M combinations, fine for one team, collision-prone across many.
  Three styles, and the trade-off is surfaced in the UI rather than buried:
  `jersey` ("32JB") is derivable from the roster by ANY TEAMMATE, which is
  arithmetic, not a subtle risk; `hybrid` ("32JB-K4P") keeps it derivable for
  the coach and unguessable for a team-mate, and is the default.
- **Publishing is explicit, never automatic** — a half-finished match must not
  appear on a player's phone. Revoking deletes the published documents AND
  drops the codes, so a handed-out code stops working rather than going quiet
  and reviving at the next publish.
- **Each code row in Settings has its own Send/Copy button**, which hands the
  share sheet (or the clipboard, where there isn't one) that player's whole
  message — built by `playerInviteMessage` in `playerAccess.js`, not typed out
  per player. It leads with the `?code=` DEEP LINK, because the code a player
  retypes from memory is the one she gets wrong (the hyphen in a `hybrid` code
  is exactly what gets dropped — `codeCandidates` in `player-stats/` exists to
  forgive that), and repeats the site and the bare code underneath for a thread
  that mangles links. It carries no team name and no last name: this is the one
  message here that gets forwarded.
  - A cancelled share (`AbortError`) reads as nothing happening; a refused
    clipboard reads "Failed" on the row. Neither may be a silent no-op — see
    the dead-tap history in this file.
  - Verified in the harness (`pwcheck/invite.mjs`), with the share sheet
    present and absent and with the clipboard refusing: tapping the SECOND row
    produces a message addressed to that player, carrying her deep link and no
    other player's code, no team code and no full last name.
- **Never write a field as `codes: undefined` to say it is absent** —
  Firestore rejects an undefined field value outright (`Unsupported field
  value: undefined (found in field codes)`), and one such field fails the
  whole `set`, which fails the whole batch. `buildPublishedDoc` ended its
  return object with exactly that, as a piece of documentation, so **Player
  Access never published at all** — the coach got "Could not publish" every
  time, for as long as the feature existed, and it was reported from the field
  rather than caught here (2026-10-21). What is absent is now said in a
  comment above the return, where it cannot be sent anywhere. Three things
  let it through, all closed now, and all worth keeping closed:
  - the harness Firestore stub accepted an undefined value (it now rejects
    one the same way it rejects a nested array — `assertWritable`);
  - `nodecheck/exposure.mjs`'s allowlist walk had `if (v === undefined)
    return;`, so it skipped the one property that mattered. It collects them
    and asserts there are none;
  - nothing ever handed the REAL SDK a real published document.
    `nodecheck/firestorewrite.mjs` does: it runs `buildPublishedSet`'s output
    through the actual `writeBatch(...).set()` the app calls, for all three
    code styles and for an empty season / no stat list / no jersey number / a
    deleted match, and asserts the SDK still refuses an undefined field. No
    network is needed — `set()` validates client-side before sending. Prefer
    this shape of test to any stub when a write's VALIDITY is the question.

**STILL OPEN — the lock-down.** With no authentication anywhere (confirmed:
neither app imports `firebase/auth`), Firestore rules CANNOT distinguish the
coach from a player — both are anonymous clients — so there is no rule that
says "coach writes, players read". The current rule is
`allow read, write: if true`. The coach chose to stage it: build player
access first against current rules, add sign-in as its own change afterwards.
Until that second step, a published doc is technically writable by anyone who
finds it, and the team's own data stays exactly as exposed as it has always
been. Doing it properly means adding a coach sign-in (and the same to Player
Eval, which writes `roster`) — and note the real cost that buys the risk: a
sign-in introduces a new way to be locked out courtside, which nothing can do
today.

## The player-facing app (`player-stats/`)

`player-stats/` is a third Vite + React app in this repo — the only one
players themselves open. One URL for everybody; a player types the code her
coach issued and sees her season totals first, then the same numbers match by
match, with team totals in a column beside her own. Its own Vercel project
(root directory `player-stats`), same Firebase project as the other two, its
own copies of the palette and the stat labels — a separate app can't import
from this repo's `src/`, same as Player Eval.

- **It reads exactly one document, `playerAccess/{code}`, and writes
  nothing.** It never touches `teams/{code}/…`. If you add a read here, keep
  it inside that one document — the published shape is built and documented
  in `src/playerAccess.js`, and the Node test asserting what must never be in
  it is the thing to keep passing.
- **`codeCandidates()` tries the typed code and, if it has no hyphen, the
  same characters WITH one inserted before the last three.** A `hybrid` code
  (`32JB-K4P`) is the one a player retypes from memory, and the hyphen is
  what she leaves out; without this, the right code typed plainly reads as
  wrong. Input is also folded to uppercase, since codes are issued uppercase.
- **The season tally and the per-match list legitimately disagree**, and the
  app says so rather than hiding it. `season` counts every stat recorded
  against her (same as the coach's Season to Date), while `matches[]` can
  only hold matches that still exist on the schedule and that the stats were
  actually attached to — so stats tapped with no active match (see
  "Stats recorded with NO match selected") are in the first and not the
  second. The dim line under *By match* appears only when the two differ.
  Don't "fix" it by dropping unattached stats from the season total; that
  would make her card disagree with the coach's own screen instead.
- **Live at `volley-bandit-my-stats.vercel.app`** (`PLAYER_STATS_URL` in
  `src/App.jsx`), its own Vercel project, root directory `player-stats`,
  created by the coach — this environment has no `vercel` CLI and no token,
  and cannot even reach the deployed host to check it (egress policy), so
  anything about what is actually live has to come from him. "my-stats"
  rather than "stats" is deliberate: it is one player's own card, not the
  team's numbers.
- Verified in a browser harness (`pwcheck/playerstats.mjs`) against documents
  built by the REAL `buildPublishedSet`, not hand-written fixtures: wrong
  code, lowercase hyphen-less code, season-before-matches ordering, per-match
  rows for only the matches with her stats, the local-date rendering (a match
  on the 22nd must not read as the 21st), the remembered-code path, the
  `?code=` deep link and its stripping from the URL, a revoked code, a player
  with no last name, and an unreachable read reporting a network problem
  rather than "wrong code". The harness stubs `firebase/app` and
  `firebase/firestore` with one module so the app's real `firebase.js` runs
  unchanged; its Vite config has to live in `player-stats/` (Vite resolves
  plugins relative to the config file), named `vite.harness.*.tmp.js` so it
  stays gitignored.

## Open — deferred, not bugs to fix unasked

Things a session has noticed, raised with the coach, and been asked to leave
alone. They are written down so the next session doesn't "discover" them and
quietly change behaviour nobody asked to change. Raise them, don't fix them,
unless the coach says so.

- **The 5-1 serve-receive setter release** (asked to defer, 2026-10-17). Two
  separate observations, both pre-existing and neither reported as a problem:
  - On rotations 3 and 6 the setter already stands at right front, so her
    destination ring overlaps her own circle and the arrow is a short stub.
    Visible on screen, more obviously cluttered on the printed sheet.
  - `NET_TARGET` is `(80, 24)` while P2's base is `(84, 14)`, so a setter at
    P2 is drawn moving *away* from the net to reach her setting spot, which
    looks backwards. It may well be intentional (a setter does set off the
    net), which is exactly why it needs the coach's eye rather than a guess.
  The 4-2 work this session deliberately did not touch either. The coach is
  reviewing the 5-1 himself first.
- **Google Fonts are uncached offline** (see the bullet under "Things that
  broke…"). Cosmetic only — investigated and disproved as a cause of freezing.
  It wants `workbox.runtimeCaching`; never been asked for.
- **Two `window.confirm` calls remain** — the roster delete and "Unlink this
  device". Both far from any live-match path, which is why they survived the
  sweep that replaced the rest.

## App icons

All three apps share one mark — the Thrift Bandit raccoon over a volleyball —
and **the background colour is what says which app it is**: Volley Bandit
`#255E42` (green), Player Eval `#1F4E79` (blue), Player Stats `#5D3A7A`
(plum). That rule comes from Thrift Bandit, the coach's other app, which is
the same raccoon on orange. Before this they all shipped the *identical* "VB"
tile, so two of them installed on one phone were indistinguishable.

- The ball's seam lines take the background colour too, so each tile is one
  colour plus bone (`#F5F3EE`) and nothing looks pasted on.
- Player Stats deliberately does NOT use its own accent (`#ff7a3d`) — that is
  the same orange family as Thrift Bandit and the two tiles would be hard to
  tell apart. It is also the only app a player opens, so it is the one worth
  making unmistakable.
- **The PNGs are full-bleed squares with no alpha.** The manifest declares
  `icon-512` as `purpose: maskable` as well as `any`, and a maskable icon must
  fill the square — the platform applies its own mask. Baked-in rounded
  corners get clipped twice and leave artefacts. `favicon.svg` IS rounded,
  because nothing masks a favicon for us; it wraps a 64px PNG as a data URI so
  the tab matches without needing an index.html change.
- **Quantise to 128 colours.** Straight out of the compositor the 512 was
  147KB of 16-bit PNG; at 128 colours it is 35KB and measurably identical
  (RMSE 0.66%, checked rather than assumed). This app must not get heavier —
  it loads on gym wifi and is deliberately not code-split.
- The raccoon was lifted from a **screenshot** of the Thrift Bandit icon (~168
  px of real artwork, upscaled ~2x), so it is slightly soft at 512 with a faint
  orange fringe on its outline. The ball came from a 771px source and is sharp.
  If the original raccoon asset ever turns up it is a drop-in replacement —
  re-run the compositing with the same geometry, nothing else changes.
- **The volleyball came from a Vecteezy stock image** the coach supplied. It
  was raised with him that Vecteezy's licence restricts commercial use and
  that he intends to sell this; he chose to proceed. If this ever ships
  commercially, that licence needs settling or the ball needs replacing.
  Hand-drawn SVG volleyballs were tried first and all read as beach balls or
  globes — see the git history of this change if tempted to try again.
- All three apps use the same three filenames (`icon-512.png`, `icon-192.png`,
  `favicon.svg`) in their own `public/`, so changing an icon is a file swap
  with no config or HTML edit.

## Workflow note

**When walking the coach through something outside the codebase** (a Vercel
setup, a Firebase console change, anything done by hand in someone else's
UI): give ONE step, then wait for him to report back. He asked for this
directly — a numbered list of ten steps gets skimmed, and a wrong turn at
step 3 isn't noticed until step 9. One step, confirm, next step.


The user bounces between chat-based Claude sessions and Claude Code on the
same repo — sometimes literally pasting files (like this one) from one
into the other. Don't assume you're the only thing editing this codebase;
check `git log` / recent commits for context before assuming the last
thing you see reflects the full picture, especially right after a handoff
like this one. Nothing about this project lives only in one conversation's
memory — the repo (code, commit messages, this file) is the actual source
of truth; keep it that way by writing down here whatever the next session
would otherwise have to rediscover the hard way.
