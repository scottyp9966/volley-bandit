# My Volleyball Stats (`player-stats`)

The player-facing half of Volley Bandit's **Player Access** feature: one URL
for everybody, where a player types the code her coach gave her and sees her
own season stats first, then the same numbers broken down match by match,
with the team's totals beside her own.

Deployed as its own Vercel project (root directory `player-stats`), the same
way `player-eval/` is. It shares the Firebase project with Volley Bandit —
that is what lets it read what the coach publishes — but it is deliberately a
separate app with its own bundle.

## The data contract (read this before adding a read)

This app reads **exactly one document**: `playerAccess/{code}`, a top-level
collection the coach's app writes when she taps *Publish Stats For Players*
(see `src/playerAccess.js` in the main app, which builds these documents and
documents the shape). It never touches `teams/{code}/…`, and it never writes
anything.

A published document holds:

- `player: { name, num }` — a short name only (`"Joy B."`). The players are
  minors and this is the one artefact here a stranger might hold, so there is
  no full name in it.
- `season` — that player's season tally, `{ statKey: count }`.
- `teamSeason` — the team's tally in the same shape.
- `matches[]` — `{ date, opponent, stats }`, most recent first, only matches
  that actually have a record.
- `statKeys`, `teamName`, `publishedAt`, `v`.

It deliberately does **not** hold the team code (the writable key to
everything), the roster, lineups, the schedule, or any other player's line.
If you add a field, ask what a stranger holding one leaked code learns from
it — and keep the Node test in the main repo passing.

## Codes

Issued by the coach in Volley Bandit → Settings → Player Access, in one of
three styles (`random`, `hybrid`, `jersey`). Codes are **global names**,
because one URL serves every organisation.

Two accommodations live in `codeCandidates()`:

- Codes are issued uppercase, so typed input is folded up.
- A `hybrid` code (`32JB-K4P`) is also tried **with a hyphen inserted** before
  the last three characters when the player typed it without one — otherwise
  `32JB8TY` reads as a wrong code when it is the right one typed plainly.

`?code=32JB-K4P` is a deep link, so a coach can text the code instead of
asking a 14-year-old to type it. It is stripped from the URL once used.

## No sign-in yet

There is no Firebase Auth anywhere in this project (see the main repo's
`CLAUDE.md`, *"Player Access, and the seams left for charging money"*). The
Firestore rule is still `allow read, write: if true`, so the **code is the
credential**, and a published document is technically writable by anyone who
finds it. That is a staged decision, not an oversight: player access was
built against current rules first, with a coach sign-in to follow as its own
change. Revoking in the coach app deletes the documents and drops the codes,
so a handed-out code stops working rather than reviving at the next publish.

## Running it

```
npm install
npm run dev
npm run build
```

Deploy on Vercel as a separate project with **root directory `player-stats`**,
then set `PLAYER_STATS_URL` in the main app's `src/App.jsx` to the deployment
URL so the coach's Settings screen tells players where to go.
