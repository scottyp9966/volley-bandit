# Player Eval

Post-match player evaluations for a volleyball coach: rate players 1-5 on
core skills and intangibles (with an N/A option), track season trends, and
get lineup-aware swap suggestions. Companion to the Volley Bandit lineup app
in this same repo — kept as its own app rather than bolted onto that one,
but able to work as an add-on to it: point it at the same team code and it
reads that team's roster (and, for the Recommend tab, its active lineup)
live, no re-entry needed.

## Running it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173` (or another port if 5173 is taken by the
main app). Both apps can run at once during development.

```bash
npm run build
npm run preview
```

## How it shares data with Volley Bandit

Both apps point at the same Firebase project and the same
`teams/{code}/data/*` Firestore layout:

- `teams/{code}/data/main` — owned by Volley Bandit. Player Eval reads its
  `roster` and `lineups`/`activeLineupId` fields, but only ever *writes*
  the `roster` field, and always with a `merge: true` write, so it can
  never clobber lineups, matches, or anything else Volley Bandit keeps in
  that document.
- `teams/{code}/data/playerEval` — owned entirely by this app (the
  evaluations log). Volley Bandit never touches it.

Practically: a coach already using Volley Bandit enters that same team code
here and the roster just shows up. A coach who only wants Player Eval can
create a fresh team code and manage a small roster right here — and if they
later start using Volley Bandit too, entering that same code there picks up
the roster this app already built.

See the root README for the one-time Firebase project setup — both apps use
the same config.

## Rotation-aware Recommend

The Recommend tab's "Current lineup" view reads Volley Bandit's active
lineup (read-only), works out who's actually on court right now by
applying that lineup's `currentRotation` to its base slot assignment (the
same rotation math Volley Bandit itself uses), and compares each starter —
plus both libero slots — against bench players who share that starter's
position tag. Ratings here use a recency-weighted average (half-life ~3
weeks, in `RECENCY_HALF_LIFE_DAYS`) rather than a flat season average, so a
player's last few games count for more than one from two months ago. A
bench player rated at least `SWAP_SUGGESTION_THRESHOLD` (0.4) higher than
the starter gets flagged as "Consider" — both constants live at the top of
`buildLineupSuggestions`'s section in `src/App.jsx` and are meant to be
tuned once you've seen it suggest a few real swaps.

If no active lineup exists yet for the team code (or the team only uses
Player Eval), Recommend falls back to the flat by-position ranking.

## What's not built yet

Carried over from the original project brief:

- **Per-set evaluation granularity** — one evaluation per player per
  session for now.
- **Trend recency** — the Trends tab still shows a flat season average by
  design (it's meant to show the whole season); only Recommend uses the
  recency-weighted score.
