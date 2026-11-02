// The score sheet's rules, with no React and no storage — testable with
// plain Node (see test/engine.test.mjs, which replays the NFHS handbook's
// worked example and checks every row of the finished sheet).
//
// A set is a SETUP (lineups, libero, who serves first) plus an append-only
// list of EVENTS — a rally won, a substitution, a time-out, a card. Every
// mark on the paper sheet is derived by replaying those events from the
// start, so:
//   - Undo is "drop the last event", and can never leave the sheet in a
//     state no sequence of real events could produce;
//   - the screen, the running score and the printed sheet can never
//     disagree, because they are all the same replay.
//
// Notation follows the NFHS score sheet:
//   1 2 3      points scored by the server        (running score: slashed)
//   [4]        point won on a sideout — written   (running score: boxed)
//              in a box at the start of the new
//              server's term
//   -|         end of a term of service (loss of rally)
//   (13)       penalty point                      (running score: circled)
//   <9> <-|>   libero serve: point / loss         (running score: triangle)
//   S 3/10     serving team substitution, in/out — written in the CURRENT
//   Sx 14/8    SERVER's row; Sx when the receiving team made it
//   T / Tx     time-out by the serving / receiving team
//   RS / R     re-serve / replay
// Comments carry the score of the team at fault first: "YUD (10 - 8)".

export const SUB_LIMIT = 18;
export const TIMEOUT_LIMIT = 2;
export const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

// Comment codes. `point`: whether it awards a penalty point to the opponent.
// `carries`: written again on every later set's sheet ("…, Set 2").
export const COMMENT_CODES = {
  YUD: { label: "Delay — warning (yellow)", point: false, member: false },
  RUD: { label: "Delay — penalty point (red)", point: true, member: false },
  YC: { label: "Yellow card (misconduct)", point: false, member: true, carries: true },
  RC: { label: "Red card — penalty point", point: true, member: true, carries: true },
  DQ: { label: "Disqualification", point: false, member: true, carries: true },
  CM: { label: "Concussion — out for the match", point: false, member: true, carries: true },
  RL: { label: "Redesignated libero", point: false, member: true },
  E: { label: "Uniform/equipment — penalty point", point: true, member: false },
  NOTE: { label: "Other comment", point: false, member: false },
};

export const other = (t) => (t === "H" ? "V" : "H");
export const num = (s) => String(s ?? "").trim().replace(/^#/, "");

export function newSet(number, { left = "V", firstServe = "V", target = 25 } = {}) {
  return {
    number,
    left,
    firstServe,
    target,
    teams: {
      H: { lineup: ["", "", "", "", "", ""], libero: "", noLibero: false, captain: "" },
      V: { lineup: ["", "", "", "", "", ""], libero: "", noLibero: false, captain: "" },
    },
    events: [],
    startTime: null,
    endTime: null,
    ended: false,
  };
}

// Problems with a lineup before the set starts — the scorer's pre-set
// checklist from the handbook. Returns a list of strings; empty is good.
export function lineupProblems(team, label = "") {
  const out = [];
  const nums = team.lineup.map(num);
  if (nums.some((n) => !n)) out.push(`${label}fill in all six serving positions`);
  const seen = new Set();
  nums.forEach((n) => {
    if (!n) return;
    if (seen.has(n)) out.push(`${label}#${n} is listed twice`);
    seen.add(n);
  });
  const lib = num(team.libero);
  if (lib && nums.includes(lib)) out.push(`${label}the libero #${lib} is also in the six`);
  if (!lib && !team.noLibero) out.push(`${label}no libero listed — ask the coach (mark "no libero" if they aren't using one)`);
  if (!num(team.captain)) out.push(`${label}no captain marked`);
  return out;
}

// Replays a set. `prior` is the match's earlier sets, for match-wide facts:
// disqualified and concussed players, and comments that carry over.
export function replay(set, prior = []) {
  const teamKeys = ["H", "V"];
  const st = {
    score: { H: 0, V: 0 },
    serving: set.firstServe,
    nextRow: { H: 0, V: 0 },
    rows: {},
    run: { H: {}, V: {} }, // point number -> "slash" | "box" | "circle" | "tri" | "tri-circle"
    runRound: { H: {}, V: {} }, // point number -> ink round of the term it was scored in
    subs: { H: 0, V: 0 },
    timeouts: { H: [], V: [] },
    comments: { H: [], V: [] },
    liberos: { H: [], V: [] },
    liberoServing: false,
    reservesThisTerm: 0,
    boundRow: { H: {}, V: {} }, // player number -> serving-order row they're locked into
    exceptional: { H: new Set(), V: new Set() }, // players exceptionally subbed out this set
    out: { H: new Map(), V: new Map() }, // DQ / concussed this match: number -> reason
    setOver: null,
    lastEvent: set.events[set.events.length - 1] || null,
  };
  for (const t of teamKeys) {
    const team = set.teams[t];
    st.rows[t] = team.lineup.map((n) => ({ numbers: [num(n)], marks: [], liberoTri: false, terms: 0 }));
    team.lineup.forEach((n, i) => {
      if (num(n)) st.boundRow[t][num(n)] = i;
    });
    const lib = num(team.libero);
    if (lib) st.liberos[t].push(lib);
  }
  st.rows[set.firstServe][0].terms = 1;

  // Match-wide carry-overs from earlier sets.
  const carried = { H: [], V: [] };
  prior.forEach((ps) => {
    const pst = replay(ps);
    for (const t of teamKeys) {
      pst.comments[t].forEach((c) => {
        const def = COMMENT_CODES[c.code];
        if (def?.carries && !c.carried) carried[t].push({ ...c, carried: true, text: `${c.text}, Set ${ps.number}` });
      });
      pst.out[t].forEach((reason, n) => st.out[t].set(n, reason));
    }
  });
  for (const t of teamKeys) st.comments[t].push(...carried[t]);

  const roundOf = (t, r) => Math.max(1, st.rows[t][r].terms);
  const write = (t, r, mark) => st.rows[t][r].marks.push({ ...mark, round: roundOf(t, r) });
  const serverRow = () => st.nextRow[st.serving];
  const scoreText = (t) => `${st.score[t]} - ${st.score[other(t)]}`;

  const mark = (t, n, type, r) => {
    st.run[t][n] = type;
    st.runRound[t][n] = roundOf(t, r);
  };
  const rally = (winner, penalty = false) => {
    const s = st.serving;
    const r = serverRow();
    const lib = st.liberoServing;
    if (winner === s) {
      const n = ++st.score[s];
      if (lib) {
        write(s, r, { k: "tri", n, circle: penalty });
        mark(s, n, penalty ? "tri-circle" : "tri", r);
      } else {
        write(s, r, { k: penalty ? "circle" : "pt", n });
        mark(s, n, penalty ? "circle" : "slash", r);
      }
    } else {
      if (lib) write(s, r, { k: "tri", lor: true, circle: penalty });
      else write(s, r, { k: "lor" });
      st.nextRow[s] = (r + 1) % 6;
      st.serving = winner;
      st.liberoServing = false;
      st.reservesThisTerm = 0;
      const nr = st.nextRow[winner];
      st.rows[winner][nr].terms += 1;
      const n = ++st.score[winner];
      write(winner, nr, { k: penalty ? "circle" : "box", n });
      mark(winner, n, penalty ? "circle" : "box", nr);
    }
  };

  for (const ev of set.events) {
    if (st.setOver && ev.type !== "note") continue;
    const s = st.serving;
    switch (ev.type) {
      case "rally":
        rally(ev.winner);
        break;
      case "liberoServe":
        st.liberoServing = true;
        st.rows[s][serverRow()].liberoTri = true;
        break;
      case "sub": {
        const t = ev.team;
        const pairs = [];
        for (const p of ev.pairs) {
          const i = st.rows[t].findIndex((row) => row.numbers[row.numbers.length - 1] === num(p.out));
          if (i < 0) continue;
          st.rows[t][i].numbers.push(num(p.in));
          if (st.boundRow[t][num(p.in)] === undefined) st.boundRow[t][num(p.in)] = i;
          pairs.push({ in: num(p.in), out: num(p.out) });
          if (!(ev.exceptional && st.subs[t] >= SUB_LIMIT)) st.subs[t] += 1;
          if (ev.exceptional) {
            st.exceptional[t].add(num(p.out));
            st.comments[t].push({ code: "ES", member: `#${num(p.out)}`, text: `ES #${num(p.out)} (${scoreText(t)})` });
          }
        }
        if (pairs.length) write(s, serverRow(), { k: "sub", x: t !== s, pairs });
        break;
      }
      case "timeout":
        st.timeouts[ev.team].push(scoreText(ev.team));
        write(s, serverRow(), { k: "to", x: ev.team !== s });
        break;
      case "reserve":
        write(s, serverRow(), { k: "rs" });
        st.reservesThisTerm += 1;
        if (ev.lost) rally(other(s));
        break;
      case "replay":
        write(s, serverRow(), { k: "r" });
        break;
      case "comment": {
        const t = ev.team;
        const def = COMMENT_CODES[ev.code] || COMMENT_CODES.NOTE;
        const member = ev.member ? (/^(C|AC)$/i.test(ev.member) ? ev.member.toUpperCase() : `#${num(ev.member)}`) : "";
        const head = ev.code === "NOTE" ? ev.text || "Note" : `${ev.code}${member ? " " + member : ""}`;
        st.comments[t].push({ code: ev.code, member, text: `${head} (${scoreText(t)})` });
        if (ev.chargeSub) st.subs[t] += 1;
        if (ev.code === "DQ" && member.startsWith("#")) st.out[t].set(member.slice(1), "disqualified");
        if (ev.code === "CM" && member.startsWith("#")) st.out[t].set(member.slice(1), "concussion");
        if (ev.code === "RL" && num(ev.newLibero)) st.liberos[t].push(num(ev.newLibero));
        // A note can award a point too — late lineup, late or inaccurate
        // roster — which is why `point` is on the event and not only the code.
        if (def.point || ev.point) rally(other(t), true);
        break;
      }
      default:
        break;
    }
    const lead = st.score.H - st.score.V;
    if (Math.max(st.score.H, st.score.V) >= set.target && Math.abs(lead) >= 2) st.setOver = lead > 0 ? "H" : "V";
  }

  st.server = {
    team: st.serving,
    row: serverRow(),
    number: currentNumber(st, st.serving, serverRow()),
  };
  return st;
}

export function currentNumber(st, t, r) {
  const row = st.rows[t][r];
  return row ? row.numbers[row.numbers.length - 1] : "";
}

export function onCourt(st, t) {
  return st.rows[t].map((row) => row.numbers[row.numbers.length - 1]);
}

// What the scorer reads out for a lineup check (handbook p.7): the serving
// team from its current server, the receiving team from its next server.
export function lineupCheck(st, t) {
  const start = st.nextRow[t];
  const order = [0, 1, 2, 3, 4, 5].map((k) => currentNumber(st, t, (start + k) % 6));
  return st.serving === t
    ? { lead: "Current server (right back)", order }
    : { lead: "Next server (right front)", order };
}

// Everything the scorer should tell the R2 about a proposed substitution.
// Warnings, not refusals: the officials decide, and the scorer records what
// actually happened — a rule this app got wrong must never stop a match.
export function subWarnings(st, t, pairs, { exceptional = false, roster = null } = {}) {
  const w = [];
  const court = onCourt(st, t);
  const libs = st.liberos[t];
  const count = st.subs[t];
  pairs.forEach((p, k) => {
    const pin = num(p.in);
    const pout = num(p.out);
    if (!pin || !pout) return;
    if (!court.includes(pout)) w.push(`#${pout} is not on the court for this team.`);
    if (court.includes(pin)) w.push(`#${pin} is already on the court.`);
    if (libs.includes(pin) || libs.includes(pout)) w.push(`#${libs.includes(pin) ? pin : pout} is the libero — a libero replacement isn't a substitution.`);
    const bound = st.boundRow[t][pin];
    const outRow = court.indexOf(pout);
    if (!exceptional && bound !== undefined && outRow >= 0 && bound !== outRow)
      w.push(`#${pin} already played in position ${ROMAN[bound]} — re-entry into a second service position. Tell the R2.`);
    if (st.out[t].has(pin)) w.push(`#${pin} is out for the match (${st.out[t].get(pin)}). Tell the R2.`);
    if (!exceptional && st.exceptional[t].has(pin)) w.push(`#${pin} was exceptionally substituted this set and may not re-enter. Tell the R2.`);
    if (roster && roster.length && !roster.includes(pin)) w.push(`#${pin} is not on the roster. Tell the R2.`);
    const nth = count + k + 1;
    if (!exceptional && nth > SUB_LIMIT) w.push(`This would be substitution ${nth} — the limit is ${SUB_LIMIT}. Tell the R2.`);
    else if (!exceptional && nth >= 15) w.push(`Substitution ${nth} of ${SUB_LIMIT} — the R2 should tell the coach.`);
  });
  return w;
}

// Sets won so far in a match, from each set's replay.
export function matchTally(match) {
  const won = { H: 0, V: 0 };
  match.sets.forEach((s, i) => {
    if (!s.ended) return;
    const r = replay(s, match.sets.slice(0, i));
    const w = r.score.H > r.score.V ? "H" : r.score.V > r.score.H ? "V" : null;
    if (w) won[w] += 1;
  });
  return won;
}

// Plain-text rendering of a row's marks — what the paper sheet shows,
// e.g. "[1] S5/1 2 3 4 5 Sx45/16 6 7 -|". Used by the tests, and handy for
// reading a row aloud.
export function marksText(marks) {
  return marks
    .map((m) => {
      switch (m.k) {
        case "pt":
          return String(m.n);
        case "box":
          return `[${m.n}]`;
        case "circle":
          return `(${m.n})`;
        case "lor":
          return "-|";
        case "tri":
          return `<${m.lor ? "-|" : m.n}>${m.circle ? "o" : ""}`;
        case "sub":
          return `${m.x ? "Sx" : "S"}${m.pairs.map((p) => `${p.in}/${p.out}`).join(" ")}`;
        case "to":
          return m.x ? "Tx" : "T";
        case "rs":
          return "RS";
        case "r":
          return "R";
        default:
          return "?";
      }
    })
    .join(" ");
}
