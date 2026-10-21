# Rotation analysis — a sketch

Status: **sketch**, 2026-10-21. Nothing built. Written up because a working
session produced the whole method by hand and it shouldn't have to be
re-derived. Decisions still open are marked **OPEN**.

---

## 1. Where this came from

A session spent an afternoon doing, by hand, what this would automate: taking
a real lineup and working out, rotation by rotation, who receives, who owns
each seam, who serves, and which arrangement is least bad. It found real
things — a serving turn being wasted on the 9th-best server when the 2nd was
standing next to her, a start rotation that opened sets in the weakest
passing alignment, a pairing swap that improved both at once.

All of it was arithmetic over data the apps already hold. That's the case for
building it: it isn't insight, it's bookkeeping a coach shouldn't be doing in
his head between matches.

## 2. The data already exists

`player-eval/src/App.jsx` rates five skills — **serve**, **pass**, hit,
block, defense — plus four intangibles, and averages them per player across
evaluations, carrying a `count`. Those live in
`teams/{code}/data/playerEval`, Player Eval's own document.

The two this needs, serve and pass, are already there. **No new rating UI, no
new data entry.** That is most of the reason this is worth doing.

## 3. Architecture

```
player-eval  ──writes──>  teams/{code}/data/playerEval   (already)
volley-bandit ──reads───>  teams/{code}/data/playerEval   (NEW, read-only)
volley-bandit ──owns────>  lineups, pairings, roster      (already)
src/rotationAnalysis.js   pure math, no React, no Firestore
```

- **The maths lives in Volley Bandit**, because that is where lineups,
  pairings, the libero rules and the serve-receive sheet already are. Player
  Eval supplies numbers and nothing else.
- **A new module, `src/rotationAnalysis.js`**, pure and framework-free, the
  same shape as `tournamentLogic.js` — testable with a plain Node script,
  which is how the Tournament Builder maths was actually verified. No React,
  no Firestore, no `COLORS`.
- **Volley Bandit reading `playerEval` is a change to the documented
  data-sharing contract** (today Player Eval reads `main` and writes
  `roster`; Volley Bandit touches `playerEval` only in `mergePlayers`). It is
  one-directional and read-only, so it is safe — but CLAUDE.md's Player Eval
  section needs updating to say so, or the next session will read the
  contract and believe this can't happen.

## 4. Ratings: computed, but the coach overrules

**OPEN, and it is the most important decision here.** The coach who prompted
this ranked his passers and servers from memory, in seconds, with confidence.
Player Eval's averages may not agree.

Proposed: the evaluation average is the **default**, a coach-set order is an
**override that always wins**, and where they disagree the UI says so rather
than silently preferring one. The override lives on the team doc
(`mainDoc.passOrder`, `mainDoc.serveOrder` — arrays of player ids), because
it is a coaching judgement about this team, not an evaluation.

Also open: **how many evaluations before an average is trustworthy?** A
player with one rating and a player with eight should not carry the same
weight. At minimum show the count; possibly shrink sparse averages toward the
team mean. Don't present a single evaluation as a rating.

## 5. What the module computes

Input: a lineup (slots, liberos, pairings, `roleSystem`), the roster, and a
rating lookup. Output, for each of the six rotations:

- **Who is actually on court** — pairings and the libero applied, not the
  slots as written.
- **Front row / back row**, left to right.
- **The server at P1**, and the alternative if the sub is delayed (the
  front-row half of that pair), with both ratings.
- **Seam assignment**: left seam and right seam each go to the better of the
  two passers flanking it.
- **Who owns neither seam** — the player to hide, and where she can legally
  stand (behind her front-row counterpart, in left-right order).
- **Whether the front row has to switch at all.** In a 4-2 with the setter to
  right front, a rotation where the setter is already at P2, the middle at P3
  and the pin at P4 needs no switching — two of the six are like this, and
  they are materially easier to receive in.

And across the six:

- The serve order with ratings, and which turns are being wasted.
- Receive strength per rotation, and **how evenly it is spread** — a flat
  distribution is harder to attack than three strong and three weak.
- A recommended start rotation for serving and, separately, for receiving.
  These are different questions and the answer is usually a different
  rotation.

## 6. Rules it has to encode

These were verified during the session and the sources are in the transcript;
they are the non-obvious part and the reason a coach can't eyeball it.

- **Overlap applies only at the instant of service contact**, and only
  against adjacent players — left-right order within your row, front-back
  against your paired player. Everything else is free, and after contact all
  of it is.
- **The server is exempt** (NFHS: "overlapping by adjacent players other than
  the server"). Every constraint *involving* the server drops out, so the
  other two back-row players can spread into the space she vacates.
  **FIVB 2025–2028 goes further and frees the entire serving team** — so this
  is rule-set dependent and must not be hardcoded to one book. **OPEN:**
  which rule set to model, and whether to make it a setting.
- **A substitute is locked to one position in the serving order for the
  set** (re-entry). This is the real constraint on serving specialists, not
  the sub count — you cannot borrow a good server from another slot. It is
  also why the pairings *are* the serving plan.
- **The libero may serve in one rotational position only**, which makes
  "which pairing is marked SERVES HERE" a real optimisation: spend it where
  the alternative server is worst.
- **Seam goes to the better passer**; the best passer should cover the most
  area. Where she is the middle-back player she takes both seams and roughly
  half the court.

## 7. Where it surfaces

- **A per-rotation card on the Lineup tab** — the rotation picker is already
  there. For the selected rotation: back row with ratings, seam calls, who to
  hide, the server, and whether the front row switches.
- **On the serve-receive print sheet**, which already draws all six
  rotations. Marking seam ownership and the hidden passer on the existing
  courts is the natural home and costs no new sheet. It would also give the
  coach the card he'd otherwise write out by hand.
- **A summary strip**: serve order with ratings, receive strength per
  rotation, and the two recommended start rotations.

## 8. Phase 2 — the arrangement search

The free variables are small enough to enumerate exhaustively:

- which DS pairs with which front-row-only player (3! = 6 with the libero on
  the two middles),
- which libero pairing serves (2),
- which rotation to start in, serving and receiving (6 each),
- whether each sub is delayed so the front-row half serves.

That is tens of combinations, not millions. **No annealing needed** — unlike
`tournamentLogic.js`, this one can be solved by brute force and should be.
Report the best few against two objectives the coach can weigh himself
(serve order quality, receive balance) rather than collapsing them into one
score.

## 9. What it must not do

- **Not reorder anything by itself.** It reports; the coach decides. Every
  finding in the session that mattered needed a judgement the numbers
  couldn't make — whether a flat receive beats a peaked one, whether a clean
  front row is worth a rank of passing.
- **Not present the index as truth.** Adding three ranks together is a crude
  proxy and should be labelled as one. It is useful for comparing rotations
  against each other and for nothing else.
- **Not hide the overlap constraints.** Half of what the session found was
  "you can't put her there" — the tool's job is to show which options are
  legal, not to quietly drop the illegal ones.
- **Not replace the coach's ranking with the evaluation average.** See §4.

## 10. Why this might not be worth building

The honest case against: the analysis is most valuable once, when you set a
lineup, and a coach sets a lineup a handful of times a season. An afternoon
of conversation produced the answer; a feature would save that afternoon and
not much else.

The case for is that it compounds — every roster change, every injury, every
new opponent re-opens the same arithmetic, and it is exactly the kind of
bookkeeping that gets skipped when there isn't time. It is also the first
thing that would make Player Eval's ratings *do* something rather than just
be recorded, which is a real gap in that app today.

It is also a credible paid-upgrade candidate alongside Player Eval — see
`entitlementsOf` in `src/playerAccess.js`, which is the seam for that.
