# Volley Bandit Score Sheet

An interactive NFHS volleyball score sheet for the scorer's table — the fourth
app in the Volley Bandit family (`/` Volley Bandit, `player-eval/`,
`player-stats/`, and this one).

- **No sign-in, no team code, no server.** The scorer is usually a volunteer,
  often from the other school, so anyone can open it and score any match.
  Every match is saved on the device (localStorage) on every tap, and the app
  is fully precached, so it works with no signal.
- **The record is the PDF**: one landscape letter page per set in the NFHS
  layout — boxed sideout points, circled penalty points, libero-serve
  triangles, S / Sx substitutions, T / Tx time-outs, the running score and the
  comments — with the handbook's blue/red ink by round of service.
- **Volley Bandit can hand over a team's lineups** with a link
  (Settings → "Open Score Sheet with our lineups"). The link carries jersey
  numbers and a team name only, in the URL `#fragment`.

## Develop

    npm install
    npm run dev
    npm test          # replays the NFHS handbook's worked example

`test/engine.test.mjs` scores the handbook's example set (Washington Central
at Holy Angels) through the engine and checks every row of the finished sheet
against the handbook's own. `test/link.test.mjs` checks the Volley Bandit link
contract (serving order, libero jersey, nothing but numbers).

## Deploy

Its own Vercel project, like Player Eval and My Stats: import the same GitHub
repo, set **Root Directory** to `scoresheet`, framework Vite. Name the project
`volley-bandit-scoresheet` so it lands at
`volley-bandit-scoresheet.vercel.app` — that's the URL Volley Bandit's link
points at (`SCORE_SHEET_URL` in `src/scoreSheetLink.js` at the repo root). If
Vercel gives it a different address, change that constant to match.

## Libero tracking

The same app keeps the libero tracking sheet (laid out like the MIAA form):
tap "Libero in" / "L out" as replacements happen, and the PDF gets a portrait
tracking page after the score sheets. `test/libero.test.mjs` covers the rules.
