// Pure, framework-free logic for the "King & Queen of the Court" tournament
// generator (see the tournament-builder spec this was built from). Kept
// separate from TournamentBuilder.jsx so the scheduling math can be unit
// tested with a plain Node script, independent of React/Firestore.

// ---- Step 1: how many rounds fit in the practice window ----
export function computeRoundPlan(totalMinutes, targetRoundLength) {
  const roundBlock = targetRoundLength + 1; // 1 min buffer to reshuffle teams
  const numRounds = Math.max(0, Math.floor(totalMinutes / roundBlock));
  return { roundBlock, numRounds, totalTimeUsed: numRounds * roundBlock };
}

// ---- Step 2: how the headcount maps onto team size / court usage ----
// Returns the standard (perfect-fit) layout when one exists, otherwise a
// list of fallback strategies for the coach to choose between.
//
// `courtLayout`: "full" (default) — two groups per court, facing off, same
// as a real match. "half" — one group per court with no opponent, for
// running the same drill through different combinations of players (the
// group takes up only one side of the court, hence "half"). The two
// differ only in `teamsPerCourt` (2 vs 1) — every strategy below (standard
// fit, uneven, bye) already works off `desiredTeams = courts *
// teamsPerCourt` generically, so half-court reuses all of it unchanged
// except: no pairing-into-courts step (each group IS a court, not half of
// one), and no "single" option (that's specifically "one full match",
// which needs two sides).
export function planTeamLayout(playerCount, courts, teamSizePref, courtLayout = "full") {
  const teamsPerCourt = courtLayout === "half" ? 1 : 2;
  const desiredTeams = courts * teamsPerCourt;
  const sizesToTry = teamSizePref === "auto" ? [4, 3, 5, 6] : [teamSizePref];
  const standardFits = (numTeams) =>
    Number.isInteger(numTeams) && numTeams > 0 && numTeams <= desiredTeams && (teamsPerCourt === 1 || numTeams % 2 === 0);

  if (teamSizePref === "auto") {
    for (const size of sizesToTry) {
      const numTeams = playerCount / size;
      if (standardFits(numTeams)) return standardLayout(playerCount, size, courts, teamsPerCourt);
    }
  } else {
    const numTeams = playerCount / teamSizePref;
    if (standardFits(numTeams)) return standardLayout(playerCount, teamSizePref, courts, teamsPerCourt);
  }

  // No perfect fit at any size. Build fallback options.
  const sizesForFallbacks = teamSizePref === "auto" ? [3, 4, 5, 6] : [teamSizePref];
  const strategies = [];

  if (teamsPerCourt === 2 && playerCount % 2 === 0 && playerCount <= 12) {
    const half = playerCount / 2;
    strategies.push({
      key: "single",
      label: `One full match: ${half} v ${half} on Court 1`,
      detail: courts > 1 ? `Court${courts - 1 > 1 ? "s" : ""} 2${courts > 2 ? `-${courts}` : ""} will be open — use for a side drill.` : null,
      teamSize: half,
      courtsUsed: 1,
    });
  }

  // Uneven teams (sizes differ by at most 1, e.g. 5/5/4/4) — everyone
  // plays every round, all courts full every round, nothing rotates in or
  // out. Offered first: it's strictly simpler than subs (no one gets
  // shuffled onto a mid-round bench pairing that only sometimes lands
  // them a game) and strictly friendlier than byes (no one sits at all)
  // whenever the headcount can support it. Doesn't depend on teamSizePref
  // at all — "5/5/4/4" isn't any one size — so it's computed once here,
  // not per candidate size like the other fallbacks below.
  const evenBase = Math.floor(playerCount / desiredTeams);
  const evenRemainder = playerCount % desiredTeams;
  if (evenBase >= 2 && evenBase + (evenRemainder > 0 ? 1 : 0) <= 6) {
    const groupWord = teamsPerCourt === 1 ? "groups" : "teams";
    const sizesDesc =
      evenRemainder > 0
        ? `${evenRemainder} of ${desiredTeams} ${groupWord} at ${evenBase + 1}, the rest at ${evenBase}`
        : `all ${desiredTeams} ${groupWord} at ${evenBase}`;
    strategies.push({
      key: "uneven",
      label: `Uneven ${groupWord} (${sizesDesc})`,
      detail: `Every court full every round, nobody sits — ${groupWord.slice(0, -1)} sizes differ by at most one.`,
      courtsUsed: courts,
    });
  }

  // Byes: offered whenever there are more players than desiredTeams courts
  // can seat at this size at once — e.g. 1 full court seats desiredTeams(2)
  // * 6 = 12 players (6 v 6); a 14-player headcount on 1 court means 2
  // always sit, rotated fairly. generateSchedule's bye branch computes
  // byesNeeded directly from playerCount, so it needs no exact-multiple
  // relationship between playerCount and teamSize the way it briefly did —
  // don't reintroduce a `leftover === 0` condition here, that's what
  // silently left genuinely-oversized headcounts (like 14 on 1 court) with
  // no bye option offered at all despite the algorithm handling them fine.
  // Only the single LARGEST size in sizesForFallbacks that still needs
  // benching is offered — a smaller size benches strictly more players for
  // no benefit (desiredTeams*smallerSize < desiredTeams*largerSize), so
  // it's a strictly worse choice, not a genuinely different option.
  const byeTeamSize = [...sizesForFallbacks].sort((a, b) => b - a).find((size) => playerCount > desiredTeams * size);
  if (byeTeamSize != null) {
    const byesNeeded = playerCount - desiredTeams * byeTeamSize;
    const byeGroupWord = teamsPerCourt === 1 ? "group" : "team";
    const playDesc = teamsPerCourt === 1 ? `groups of ${byeTeamSize}` : `${byeTeamSize} v ${byeTeamSize} per court`;
    strategies.push({
      key: "bye",
      label: `${desiredTeams * byeTeamSize} play at ${playDesc}, ${byesNeeded} sit out on a rotation`,
      detail: `${desiredTeams} ${byeGroupWord}${desiredTeams > 1 ? "s" : ""} of ${byeTeamSize} play every round; who's out rotates fairly (never back-to-back when avoidable).`,
      teamSize: byeTeamSize,
      leftover: 0,
      courtsUsed: courts,
    });
  }

  return { fitsStandard: false, desiredTeams, teamSize: sizesForFallbacks[0], strategies };
}

function standardLayout(playerCount, teamSize, courts, teamsPerCourt = 2) {
  const numTeams = playerCount / teamSize;
  return {
    fitsStandard: true,
    desiredTeams: courts * teamsPerCourt,
    teamSize,
    numTeams,
    courtsUsed: numTeams / teamsPerCourt,
    strategies: [],
  };
}

// ---- Step 3: round-by-round team assignments ----

// GF(4) affine-plane construction — the one arrangement of 16 players into
// 5 rounds of 4 groups of 4 where every possible teammate pair occurs
// exactly once. Only valid for exactly 16 players / team size 4.
function perfectPlan16() {
  const logTab = { 1: 0, 2: 1, 3: 2 };
  const expTab = { 0: 1, 1: 2, 2: 3 };
  const mult = (a, b) => {
    if (a === 0 || b === 0) return 0;
    return expTab[(logTab[a] + logTab[b]) % 3];
  };
  const add = (a, b) => a ^ b;
  const GF4 = [0, 1, 2, 3];
  const idx = (x, y) => x * 4 + y;

  const parallelClassFiniteSlope = (m) => GF4.map((c) => GF4.map((x) => idx(x, add(mult(m, x), c))));
  const parallelClassVertical = () => GF4.map((c) => GF4.map((y) => idx(c, y)));

  return [
    parallelClassFiniteSlope(0),
    parallelClassFiniteSlope(1),
    parallelClassFiniteSlope(2),
    parallelClassFiniteSlope(3),
    parallelClassVertical(),
  ];
}

function scheduleCost(schedule) {
  const pairCount = {};
  for (const assignment of schedule) {
    const groups = {};
    assignment.forEach((g, p) => {
      (groups[g] ??= []).push(p);
    });
    for (const members of Object.values(groups)) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = Math.min(members[i], members[j]);
          const b = Math.max(members[i], members[j]);
          const key = `${a}-${b}`;
          pairCount[key] = (pairCount[key] || 0) + 1;
        }
      }
    }
  }
  let cost = 0;
  for (const k in pairCount) cost += pairCount[k] * pairCount[k];
  return { cost, pairCount };
}

// `groupSizes` is an array of this round's group sizes (e.g. [4,4,4,4], or
// [5,5,4,4] for uneven teams) — must sum to numPlayers. Assigning by
// slicing a shuffled player list into consecutive chunks of these sizes,
// then letting the SA below swap group labels between any two players,
// preserves each group's size through every swap without the SA needing
// to know or care that sizes differ.
function randomPartition(numPlayers, groupSizes, rng) {
  const players = Array.from({ length: numPlayers }, (_, i) => i);
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const assignment = new Array(numPlayers);
  let idx = 0;
  groupSizes.forEach((size, g) => {
    for (let k = 0; k < size; k++) assignment[players[idx++]] = g;
  });
  return assignment;
}

// Uniform-size convenience for call sites that just want N groups of the
// same size (everything except the "uneven teams" strategy).
const uniformSizes = (numPlayers, groupSize) => Array(numPlayers / groupSize).fill(groupSize);

// Simulated annealing: minimize repeated-teammate pairs across rounds via a
// sum-of-squares cost (spreads repeats evenly instead of stacking one pair
// together many times). Small search space (<=24 players, a handful of
// rounds), so a few thousand iterations across a few restarts runs well
// under a second — no web worker needed. `groupSizes` — see randomPartition.
export function optimizePartition(numPlayers, groupSizes, numRounds, rng = Math.random) {
  if (numRounds <= 0) return { schedule: [], stats: emptyStats(numPlayers, numRounds) };

  // A single group (everyone on the one court/group there is — half-court
  // mode with courts === 1 hits this on both the standard-fit and "uneven"
  // paths) has no second group to swap a player into, so there's nothing to
  // optimize: the same players are teammates every round regardless of
  // order. Without this early return, the swap-target pick below
  // (`while (p2 === p1 || schedule[r][p2] === schedule[r][p1])`) can never
  // find a player in a different group and spins forever — this was a
  // real, reproduced hang (see the matching guard in optimizeRoundGroups).
  if (groupSizes.length <= 1) {
    const schedule = Array.from({ length: numRounds }, () => new Array(numPlayers).fill(0));
    return { schedule, stats: computeStats(schedule, numPlayers) };
  }

  let best = null;
  let bestCost = Infinity;
  const restarts = 4;
  const iterationsPerRestart = 1500;

  for (let restart = 0; restart < restarts; restart++) {
    let schedule = Array.from({ length: numRounds }, () => randomPartition(numPlayers, groupSizes, rng));
    let { cost } = scheduleCost(schedule);
    let temp = 4;
    const cooling = 0.995;

    for (let iter = 0; iter < iterationsPerRestart; iter++) {
      const r = Math.floor(rng() * numRounds);
      const p1 = Math.floor(rng() * numPlayers);
      let p2 = Math.floor(rng() * numPlayers);
      while (p2 === p1 || schedule[r][p2] === schedule[r][p1]) {
        p2 = Math.floor(rng() * numPlayers);
      }
      const trial = schedule.map((row) => row.slice());
      const tmp = trial[r][p1];
      trial[r][p1] = trial[r][p2];
      trial[r][p2] = tmp;
      const { cost: trialCost } = scheduleCost(trial);
      const delta = trialCost - cost;
      if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
        schedule = trial;
        cost = trialCost;
      }
      temp *= cooling;
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = schedule;
    }
    if (bestCost === 0) break;
  }

  return { schedule: best, stats: computeStats(best, numPlayers) };
}

function emptyStats(numPlayers, numRounds) {
  return { distinctPairsCovered: 0, totalPossiblePairs: (numPlayers * (numPlayers - 1)) / 2, maxRepeat: 0, numRounds };
}

function computeStats(schedule, numPlayers) {
  const { pairCount } = scheduleCost(schedule);
  const counts = Object.values(pairCount);
  const totalPossiblePairs = (numPlayers * (numPlayers - 1)) / 2;
  return {
    distinctPairsCovered: counts.length,
    totalPossiblePairs,
    maxRepeat: counts.length ? Math.max(...counts) : 0,
  };
}

// Groups schedule rows into per-round arrays of player-index groups, e.g.
// [[0,1,2,3],[4,5,6,7],...] for round r.
function assignmentToGroups(assignment, numGroups) {
  const groups = Array.from({ length: numGroups }, () => []);
  assignment.forEach((g, p) => groups[g].push(p));
  return groups;
}

// Turns a flat list of groups into the `round.courts` shape, either pairing
// them up (full court — two groups face off) or one group per court (half
// court — a single drill group, no opponent; `teamB` stays empty so the
// data shape is identical either way and the UI/print code just renders
// nothing for an empty teamB instead of needing a whole separate shape).
function buildCourts(groups, teamsPerCourt) {
  const courtsArr = [];
  const numCourts = groups.length / teamsPerCourt;
  for (let c = 0; c < numCourts; c++) {
    if (teamsPerCourt === 1) {
      courtsArr.push({ court: c + 1, teamA: groups[c], teamB: [] });
    } else {
      courtsArr.push({ court: c + 1, teamA: groups[c * 2], teamB: groups[c * 2 + 1] });
    }
  }
  return courtsArr;
}

// ---- Bye-strategy helpers ----
// The bye strategy needs a different shape of optimization than the other
// three: WHICH players are even in the pool changes every round (whoever
// isn't sitting out), so it can't run one joint multi-round SA over a
// fixed player set the way optimizePartition does. Picking byes from a
// round's already-reshuffled groups (the original approach) turned out to
// be unable to reliably avoid back-to-back sits once the bye fraction got
// large — with e.g. 8 of 24 players benched a round, next round's groups
// are close to random, so the odds every one of them happens to dodge all
// 8 previously-benched players are low. Fixed by picking WHO sits out
// first (a hard, fairness + no-back-to-back-preferring choice over
// individual players), then only partitioning whoever's left playing.

// Cost added by using each intra-group pair in `groups` for the first time
// this round, given how many times each pair already appeared in earlier
// rounds (`pairCounts`). Sum-of-squares algebra: c² → (c+1)² adds 2c+1;
// summing that per pair approximates the same objective
// optimizePartition's joint SA minimizes, just greedily one round at a
// time (unavoidable here since the pool itself isn't fixed across rounds).
function marginalRoundCost(groups, pairCounts) {
  let cost = 0;
  for (const members of groups) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = Math.min(members[i], members[j]);
        const b = Math.max(members[i], members[j]);
        cost += 2 * (pairCounts[`${a}-${b}`] || 0) + 1;
      }
    }
  }
  return cost;
}

function optimizeRoundGroups(pool, groupSize, pairCounts, rng) {
  const numGroups = pool.length / groupSize;

  // A single group (half-court mode with only one court/group per round)
  // has no second group to swap a player with, so there's nothing to
  // optimize — every pool player is in the one group regardless of order.
  // Without this early return, the swap-target pick below
  // (`while (g2 === g1) g2 = ...`) can never find a second group index and
  // spins forever, freezing the tab — this was a real, reproduced hang.
  if (numGroups <= 1) return [pool.slice()];

  let best = null;
  let bestCost = Infinity;
  const perfectCost = numGroups * ((groupSize * (groupSize - 1)) / 2); // every pair brand new this round

  for (let restart = 0; restart < 3; restart++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let groups = Array.from({ length: numGroups }, (_, g) => shuffled.slice(g * groupSize, (g + 1) * groupSize));
    let cost = marginalRoundCost(groups, pairCounts);
    let temp = 4;
    const cooling = 0.99;

    for (let iter = 0; iter < 600; iter++) {
      const g1 = Math.floor(rng() * numGroups);
      let g2 = Math.floor(rng() * numGroups);
      while (g2 === g1) g2 = Math.floor(rng() * numGroups);
      const i1 = Math.floor(rng() * groupSize);
      const i2 = Math.floor(rng() * groupSize);
      const trial = groups.map((g) => g.slice());
      const tmp = trial[g1][i1];
      trial[g1][i1] = trial[g2][i2];
      trial[g2][i2] = tmp;
      const trialCost = marginalRoundCost(trial, pairCounts);
      const delta = trialCost - cost;
      if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
        groups = trial;
        cost = trialCost;
      }
      temp *= cooling;
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = groups;
    }
    if (bestCost === perfectCost) break;
  }

  return best;
}

// Top-level entry point: builds the full round-by-round plan given the
// chosen strategy from planTeamLayout(). playerCount here is the number of
// CHECKED-IN players (indices 0..playerCount-1); the caller maps indices
// back to real roster entries for display.
export function generateSchedule({ playerCount, teamSize, numRounds, courts, strategy, courtLayout = "full", rng = Math.random }) {
  const teamsPerCourt = courtLayout === "half" ? 1 : 2;

  if (strategy === "single") {
    const { schedule, stats } = optimizePartition(playerCount, uniformSizes(playerCount, teamSize), numRounds, rng);
    const rounds = schedule.map((assignment) => ({
      courts: [{ court: 1, teamA: assignmentToGroups(assignment, 2)[0], teamB: assignmentToGroups(assignment, 2)[1] }],
      idleCourts: Array.from({ length: Math.max(0, courts - 1) }, (_, i) => i + 2),
      byes: [],
    }));
    return { rounds, stats, strategy };
  }

  if (strategy === "uneven") {
    // Sizes differ by at most 1 (e.g. 5/5/4/4) so every court is full every
    // round and nobody ever sits out — see planTeamLayout for why this
    // replaced the old "subs" strategy (rotating leftover players into
    // teams turned out to have two separate back-to-back-bye-style bugs:
    // a sub could be silently dropped from playing entirely some rounds,
    // and an odd team count benched the same fixed team-index every round
    // with no fairness/no-repeat tracking at all).
    const desiredTeams = courts * teamsPerCourt;
    const base = Math.floor(playerCount / desiredTeams);
    const remainder = playerCount % desiredTeams;
    const groupSizes = Array.from({ length: desiredTeams }, (_, g) => base + (g < remainder ? 1 : 0));
    const { schedule, stats } = optimizePartition(playerCount, groupSizes, numRounds, rng);
    const rounds = schedule.map((assignment) => {
      const groups = assignmentToGroups(assignment, desiredTeams);
      const courtsArr = buildCourts(groups, teamsPerCourt);
      return { courts: courtsArr, idleCourts: [], byes: [] };
    });
    return { rounds, stats, strategy };
  }

  if (strategy === "bye") {
    const desiredTeams = courts * teamsPerCourt;
    const byesNeeded = playerCount - desiredTeams * teamSize;
    const byeCounts = new Array(playerCount).fill(0);
    // -2 (not -1) so round 0 never reads as "sat out the round before this one".
    const lastByeRound = new Array(playerCount).fill(-2);
    const allPlayers = Array.from({ length: playerCount }, (_, i) => i);
    const pairCounts = {};
    const rounds = [];

    for (let r = 0; r < numRounds; r++) {
      // Decide WHO sits out before deciding any teams: fewest byes so far,
      // strictly preferring anyone who didn't sit out last round, random
      // tiebreak so ties don't always resolve the same way round after
      // round. Doing this before team assignment (rather than reshuffling
      // teams first and picking byes after) is what actually guarantees no
      // back-to-back sit whenever it's mathematically possible — picking
      // from already-random teams can't, once byes are a large enough
      // share of the roster that "a team with zero recently-benched
      // players" stops reliably existing.
      const order = allPlayers
        .map((p) => ({ p, tiebreak: rng(), backToBack: lastByeRound[p] === r - 1, byeCount: byeCounts[p] }))
        .sort((a, b) =>
          a.backToBack !== b.backToBack ? (a.backToBack ? 1 : -1) : a.byeCount !== b.byeCount ? a.byeCount - b.byeCount : a.tiebreak - b.tiebreak
        );
      const byes = order.slice(0, byesNeeded).map((o) => o.p);
      const byeSet = new Set(byes);
      byes.forEach((p) => {
        byeCounts[p] += 1;
        lastByeRound[p] = r;
      });

      const pool = allPlayers.filter((p) => !byeSet.has(p));
      const groups = optimizeRoundGroups(pool, teamSize, pairCounts, rng);
      groups.forEach((members) => {
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const a = Math.min(members[i], members[j]);
            const b = Math.max(members[i], members[j]);
            const key = `${a}-${b}`;
            pairCounts[key] = (pairCounts[key] || 0) + 1;
          }
        }
      });

      rounds.push({ courts: buildCourts(groups, teamsPerCourt), idleCourts: [], byes });
    }

    const counts = Object.values(pairCounts);
    const stats = {
      distinctPairsCovered: counts.length,
      totalPossiblePairs: (playerCount * (playerCount - 1)) / 2,
      maxRepeat: counts.length ? Math.max(...counts) : 0,
    };
    return { rounds, stats, strategy };
  }

  // Standard perfect-fit layout.
  const numTeams = playerCount / teamSize;
  let schedule, stats;
  if (playerCount === 16 && teamSize === 4 && numRounds <= 5) {
    schedule = perfectPlan16().slice(0, numRounds).map((groups) => {
      const assignment = new Array(16);
      groups.forEach((group, g) => group.forEach((p) => (assignment[p] = g)));
      return assignment;
    });
    stats = computeStats(schedule, 16);
  } else {
    ({ schedule, stats } = optimizePartition(playerCount, uniformSizes(playerCount, teamSize), numRounds, rng));
  }

  const rounds = schedule.map((assignment) => {
    const groups = assignmentToGroups(assignment, numTeams);
    return { courts: buildCourts(groups, teamsPerCourt), idleCourts: [], byes: [] };
  });
  return { rounds, stats, strategy: "standard" };
}
