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
  here, no component splitting yet)
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
