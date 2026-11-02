// Replays the worked example from the NFHS scoring handbook (Washington
// Central at Holy Angels, set 1) through the engine and checks the finished
// sheet row by row against the handbook's completed score sheet.
//
//   node scoresheet/test/engine.test.mjs
//
// The example is deliberately crammed with rare events — a charged sub for
// an illegal lineup, a concussion, a red card, an exceptional sub, a
// redesignated libero, a libero serve, a double re-serve, two delay
// penalties — so passing it covers far more than a normal match would.
import { newSet, replay, marksText, subWarnings, lineupCheck, lineupProblems } from "../src/engine.js";

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};

import { handbookSet } from "./handbookExample.mjs";
const set = handbookSet();

const st = replay(set);
const rows = (t) => st.rows[t].map((r) => marksText(r.marks));
const nums = (t) => st.rows[t].map((r) => r.numbers.join(" "));

eq(st.score, { H: 24, V: 26 }, "final score WC 26 - HA 24");
eq(st.setOver, "V", "set over, won by Washington Central");
eq(rows("V"), [
  "1 2 3 -| [20] -|",
  "[4] 5 6 7 Tx -| [21] 22 23 24 (25) 26",
  "[8] <-|>",
  "[9] 10 11 12 (13) 14 -|",
  "[15] Sx1/7 16 17 18 Tx -|",
  "[19] -|",
], "Washington Central's individual scoring, all six rows");
eq(rows("H"), [
  "[1] S5/1 2 3 4 5 Sx45/16 6 7 -| (24) -|",
  "[8] 9 R S9/2 RS 10 RS -|",
  "[11] S3/6 12 13 14 Tx -|",
  "[15] 16 17 18 -|",
  "[19] 20 21 -|",
  "[22] Sx7/5 S6/3 23 Tx -|",
], "Holy Angels' individual scoring, all six rows");
eq(nums("V"), ["00", "15", "5 7", "13", "16 45", "21"], "WC player numbers column");
eq(nums("H"), ["4", "2 9", "6 3 6", "1 5", "8", "7 1"], "HA player numbers column");
eq(st.rows.V.map((r) => r.liberoTri), [false, false, true, false, false, false], "libero-serve triangle on WC position III only");
eq(st.subs, { H: 5, V: 3 }, "substitution counts (charged sub and exceptional sub both counted)");
eq(st.timeouts, { H: ["7 - 7", "18 - 18"], V: ["8 - 14", "19 - 23"] }, "time-out boxes, requesting team first");
eq(st.comments.V.map((c) => c.text), ["Charged sub for illegal lineup (0 - 0)", "YUD (7 - 7)", "RL #33 (18 - 20)", "RUD (20 - 23)"], "WC comments");
eq(st.comments.H.map((c) => c.text), ["CM #2 (9 - 7)", "RC #8 (14 - 12)", "ES #7 (18 - 15)", "YUD (18 - 18)", "RUD (24 - 24)"], "HA comments");
eq(st.liberos.V, ["33", "12"], "libero box: 33 slashed, 12 written in");
eq(st.run.V[13], "circle", "running score: WC 13 circled (penalty)");
eq(st.run.H[24], "circle", "running score: HA 24 circled (penalty)");
eq(st.run.V[25], "circle", "running score: WC 25 circled (penalty)");
eq(st.run.V[20], "box", "running score: WC 20 boxed (sideout)");
eq(st.run.V[2], "slash", "running score: WC 2 slashed");
eq(st.run.H[11], "box", "running score: HA 11 boxed — the libero's lost serve");
// ink rounds: WC's position I starts its SECOND term at 20 — the handbook's red ink
eq(st.rows.V[0].marks.map((m) => m.round), [1, 1, 1, 1, 2, 2], "WC position I: second term marked as round 2 (red ink)");

// Rules checks the scorer is supposed to raise with the R2.
const mid = newSet(1, { firstServe: "V" });
mid.teams = JSON.parse(JSON.stringify(set.teams));
mid.events = set.events.slice(0, 14); // through HA #4's term (incl. Sx45/16) and its loss of rally
const m = replay(mid);
eq(subWarnings(m, "V", [{ in: "16", out: "13" }]).some((w) => /second service position/.test(w)), true, "re-entry into a different position is flagged (#16 is locked to V)");
eq(subWarnings(m, "V", [{ in: "16", out: "45" }]), [], "re-entry into the same position is clean");
eq(subWarnings(m, "V", [{ in: "15", out: "13" }]).some((w) => /already on the court/.test(w)), true, "subbing in a player already on court is flagged");
eq(subWarnings(m, "V", [{ in: "33", out: "13" }]).some((w) => /libero/.test(w)), true, "the libero as a sub is flagged");
const end = replay(set);
eq(subWarnings(end, "H", [{ in: "2", out: "9" }]).some((w) => /out for the match/.test(w)), true, "the concussed #2 re-entering is flagged");
eq(subWarnings(end, "H", [{ in: "7", out: "1" }]).some((w) => /exceptionally substituted/.test(w)), true, "the exceptionally subbed #7 re-entering is flagged");
eq(lineupCheck(replay(mid), "H").order, ["2", "6", "5", "8", "7", "4"], "lineup check for the receiving team starts at the NEXT server");

// Carry-over: cards, DQ and concussion appear on later sets' sheets.
const set2 = newSet(2, { left: "H", firstServe: "H" });
set2.teams = JSON.parse(JSON.stringify(set.teams));
const s2 = replay(set2, [set]);
eq(s2.comments.H.map((c) => c.text), ["CM #2 (9 - 7), Set 1", "RC #8 (14 - 12), Set 1"], "set 2 carries HA's concussion and red card, not delays or ES");
eq(subWarnings(s2, "H", [{ in: "2", out: "4" }]).some((w) => /out for the match/.test(w)), true, "concussion still blocks #2 in set 2");

// Lineup checklist.
eq(lineupProblems({ lineup: ["1", "2", "3", "13", "16", "13"], libero: "", noLibero: false, captain: "" }).length, 3, "lineup checklist: duplicate, no libero, no captain");
eq(lineupProblems(set.teams.V), [], "a good lineup has no problems");

// A deciding set to 15 ends at 15 with a two-point lead, not before.
const d = newSet(5, { firstServe: "H", target: 15 });
d.teams = JSON.parse(JSON.stringify(set.teams));
for (let i = 0; i < 14; i++) d.events.push({ type: "rally", winner: "H" }, { type: "rally", winner: "V" });
eq(replay(d).setOver, null, "14 - 14 in a set to 15 is not over");
d.events.push({ type: "rally", winner: "H" });
eq(replay(d).setOver, null, "15 - 14 is not over (win by two)");
d.events.push({ type: "rally", winner: "H" });
eq(replay(d).setOver, "H", "16 - 14 ends it");

console.log(fails ? `\n${fails} FAILURES` : "\nall checks passed");
process.exit(fails ? 1 : 0);
