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
  **What this does NOT fix: concurrent edits to the SAME field.** Two
  devices both recording stats still both write `log`, and the later write
  wins. That needs per-entry documents or `arrayUnion`; until then live
  stat entry belongs on one device. If you touch this, the Firestore stub
  now models merge semantics properly (`merge:false` replaces) and records
  every write's payload on `window.__writes` — the old stub merged either
  way, which is precisely what hid this bug.
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

The sharper version of that warning: a *stub* standing in for Firestore
only catches what it models. A session built one to test in the browser
without real network access, and it happily accepted a nested array —
so a change that broke every write in production passed every test here.
If you build such a stub, make it enforce the real service's constraints
(nested arrays, field-name rules, document size), not just its shape.
Anything the stub doesn't enforce, you haven't actually tested.

## Workflow note

The user bounces between chat-based Claude sessions and Claude Code on the
same repo — sometimes literally pasting files (like this one) from one
into the other. Don't assume you're the only thing editing this codebase;
check `git log` / recent commits for context before assuming the last
thing you see reflects the full picture, especially right after a handoff
like this one. Nothing about this project lives only in one conversation's
memory — the repo (code, commit messages, this file) is the actual source
of truth; keep it that way by writing down here whatever the next session
would otherwise have to rediscover the hard way.
