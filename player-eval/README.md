# Player Eval

Post-match player evaluations for a volleyball coach: rate players 1-5 on
core skills and intangibles (with an N/A option), track season trends, and
compare players within a position group. Companion to the Volley Bandit
lineup app in this same repo — kept as its own app rather than bolted onto
that one, but able to work as an add-on to it: point it at the same team
code and it reads that team's roster live, no re-entry needed.

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

- `teams/{code}/data/main` — owned by Volley Bandit. Player Eval only ever
  reads/writes the `roster` field there, and always with a `merge: true`
  write, so it can never clobber lineups, matches, or anything else Volley
  Bandit keeps in that document.
- `teams/{code}/data/playerEval` — owned entirely by this app (the
  evaluations log). Volley Bandit never touches it.

Practically: a coach already using Volley Bandit enters that same team code
here and the roster just shows up. A coach who only wants Player Eval can
create a fresh team code and manage a small roster right here — and if they
later start using Volley Bandit too, entering that same code there picks up
the roster this app already built.

See the root README for the one-time Firebase project setup — both apps use
the same config.

## What's not built yet

Carried over from the original project brief:

- **Rotation-aware Recommend** — comparing the *current lineup's* starter in
  a position against bench options, rather than a flat position-group
  ranking. Needs Volley Bandit's lineup data, not just its roster.
- **Recency weighting** — trends and recommendations currently weight every
  evaluation equally regardless of age.
- **Per-set evaluation granularity** — one evaluation per player per
  session for now.
