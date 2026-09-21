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
export function planTeamLayout(playerCount, courts, teamSizePref) {
  const desiredTeams = courts * 2;
  const sizesToTry = teamSizePref === "auto" ? [4, 3, 5, 6] : [teamSizePref];

  if (teamSizePref === "auto") {
    for (const size of sizesToTry) {
      const numTeams = playerCount / size;
      if (Number.isInteger(numTeams) && numTeams > 0 && numTeams <= desiredTeams && numTeams % 2 === 0) {
        return standardLayout(playerCount, size, courts);
      }
    }
  } else {
    const numTeams = playerCount / teamSizePref;
    if (Number.isInteger(numTeams) && numTeams > 0 && numTeams <= desiredTeams && numTeams % 2 === 0) {
      return standardLayout(playerCount, teamSizePref, courts);
    }
  }

  // No perfect fit — build fallback options at a chosen team size (the
  // coach's explicit choice, or 4 as the default when left on auto).
  const teamSize = teamSizePref === "auto" ? 4 : teamSizePref;
  const strategies = [];

  if (playerCount % 2 === 0 && playerCount <= 12) {
    const half = playerCount / 2;
    strategies.push({
      key: "single",
      label: `One full match: ${half} v ${half} on Court 1`,
      detail: courts > 1 ? `Court${courts - 1 > 1 ? "s" : ""} 2${courts > 2 ? `-${courts}` : ""} will be open — use for a side drill.` : null,
      teamSize: half,
      courtsUsed: 1,
    });
  }

  const numFullTeams = Math.floor(playerCount / teamSize);
  const leftover = playerCount - numFullTeams * teamSize;
  if (numFullTeams >= 2 && leftover > 0) {
    strategies.push({
      key: "subs",
      label: `${numFullTeams} teams of ${teamSize}, ${leftover} rotating sub${leftover > 1 ? "s" : ""}`,
      detail: `Leftover player${leftover > 1 ? "s" : ""} join a different team each round.`,
      teamSize,
      numFullTeams,
      leftover,
      courtsUsed: Math.min(Math.floor(numFullTeams / 2), courts),
    });
  }

  if (numFullTeams > desiredTeams && leftover === 0) {
    strategies.push({
      key: "bye",
      label: `${numFullTeams} teams of ${teamSize}, rotating byes`,
      detail: `Only ${desiredTeams} teams play each round; the rest sit out on a fair rotation.`,
      teamSize,
      numFullTeams,
      leftover: 0,
      courtsUsed: courts,
    });
  }

  return { fitsStandard: false, desiredTeams, teamSize, strategies };
}

function standardLayout(playerCount, teamSize, courts) {
  const numTeams = playerCount / teamSize;
  return {
    fitsStandard: true,
    desiredTeams: courts * 2,
    teamSize,
    numTeams,
    courtsUsed: numTeams / 2,
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

function randomPartition(numPlayers, groupSize, rng) {
  const players = Array.from({ length: numPlayers }, (_, i) => i);
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const assignment = new Array(numPlayers);
  players.forEach((p, i) => {
    assignment[p] = Math.floor(i / groupSize);
  });
  return assignment;
}

// Simulated annealing: minimize repeated-teammate pairs across rounds via a
// sum-of-squares cost (spreads repeats evenly instead of stacking one pair
// together many times). Small search space (<=24 players, a handful of
// rounds), so a few thousand iterations across a few restarts runs well
// under a second — no web worker needed.
export function optimizePartition(numPlayers, groupSize, numRounds, rng = Math.random) {
  if (numRounds <= 0) return { schedule: [], stats: emptyStats(numPlayers, groupSize, numRounds) };

  let best = null;
  let bestCost = Infinity;
  const restarts = 4;
  const iterationsPerRestart = 1500;

  for (let restart = 0; restart < restarts; restart++) {
    let schedule = Array.from({ length: numRounds }, () => randomPartition(numPlayers, groupSize, rng));
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

  return { schedule: best, stats: computeStats(best, numPlayers, groupSize) };
}

function emptyStats(numPlayers, groupSize, numRounds) {
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

// Top-level entry point: builds the full round-by-round plan given the
// chosen strategy from planTeamLayout(). playerCount here is the number of
// CHECKED-IN players (indices 0..playerCount-1); the caller maps indices
// back to real roster entries for display.
export function generateSchedule({ playerCount, teamSize, numRounds, courts, strategy, rng = Math.random }) {
  if (strategy === "single") {
    const { schedule, stats } = optimizePartition(playerCount, teamSize, numRounds, rng);
    const rounds = schedule.map((assignment) => ({
      courts: [{ court: 1, teamA: assignmentToGroups(assignment, 2)[0], teamB: assignmentToGroups(assignment, 2)[1] }],
      idleCourts: Array.from({ length: Math.max(0, courts - 1) }, (_, i) => i + 2),
      byes: [],
    }));
    return { rounds, stats, strategy };
  }

  if (strategy === "subs") {
    const numFullTeams = Math.floor(playerCount / teamSize);
    const basePlayers = numFullTeams * teamSize;
    const leftover = playerCount - basePlayers;
    const { schedule, stats } = optimizePartition(basePlayers, teamSize, numRounds, rng);
    const courtsUsed = Math.floor(numFullTeams / 2);
    const oddTeamOut = numFullTeams % 2 === 1 ? numFullTeams - 1 : null; // sits idle if teams don't pair evenly

    const rounds = schedule.map((assignment, r) => {
      const groups = assignmentToGroups(assignment, numFullTeams).map((g) => g.slice());
      // Rotate the leftover (sub-pool) players onto a different team each round.
      for (let i = 0; i < leftover; i++) {
        const subPlayerIndex = basePlayers + i;
        const targetTeam = (r + i) % numFullTeams;
        if (targetTeam !== oddTeamOut) groups[targetTeam].push(subPlayerIndex);
      }
      const courtsArr = [];
      for (let c = 0; c < courtsUsed; c++) {
        const teamA = groups[c * 2];
        const teamB = groups[c * 2 + 1];
        if (oddTeamOut !== c * 2 && oddTeamOut !== c * 2 + 1) {
          courtsArr.push({ court: c + 1, teamA, teamB });
        }
      }
      return {
        courts: courtsArr,
        idleCourts: Array.from({ length: Math.max(0, courts - courtsUsed) }, (_, i) => courtsUsed + i + 1),
        byes: oddTeamOut != null ? groups[oddTeamOut] : [],
      };
    });
    return { rounds, stats, strategy };
  }

  if (strategy === "bye") {
    const numFullTeams = Math.floor(playerCount / teamSize);
    const desiredTeams = courts * 2;
    const { schedule, stats } = optimizePartition(playerCount, teamSize, numRounds, rng);
    const byeCounts = new Array(playerCount).fill(0);

    const rounds = schedule.map((assignment) => {
      const groups = assignmentToGroups(assignment, numFullTeams);
      const teamsToBye = numFullTeams - desiredTeams;
      // Sit out the groups whose members have banked the fewest byes so far,
      // so everyone's bye count converges to equal over the tournament.
      const order = groups
        .map((members, teamIdx) => ({ teamIdx, avgByes: members.reduce((s, p) => s + byeCounts[p], 0) / members.length }))
        .sort((a, b) => a.avgByes - b.avgByes);
      const byeTeamIdx = new Set(order.slice(0, teamsToBye).map((o) => o.teamIdx));
      const playingTeams = groups.filter((_, i) => !byeTeamIdx.has(i));
      const byes = groups.filter((_, i) => byeTeamIdx.has(i)).flat();
      byes.forEach((p) => {
        byeCounts[p] += 1;
      });

      const courtsArr = [];
      for (let c = 0; c < playingTeams.length / 2; c++) {
        courtsArr.push({ court: c + 1, teamA: playingTeams[c * 2], teamB: playingTeams[c * 2 + 1] });
      }
      return { courts: courtsArr, idleCourts: [], byes };
    });
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
    ({ schedule, stats } = optimizePartition(playerCount, teamSize, numRounds, rng));
  }

  const rounds = schedule.map((assignment) => {
    const groups = assignmentToGroups(assignment, numTeams);
    const courtsArr = [];
    for (let c = 0; c < numTeams / 2; c++) {
      courtsArr.push({ court: c + 1, teamA: groups[c * 2], teamB: groups[c * 2 + 1] });
    }
    return { courts: courtsArr, idleCourts: [], byes: [] };
  });
  return { rounds, stats, strategy: "standard" };
}
