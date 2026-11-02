// Libero tracking (the MIAA "Volleyball Libero Tracking Sheet") on top of
// the score sheet's replay.
//
//   node test/libero.test.mjs
import { newSet, replay, backRowRows, liberoWarnings, marksText, sidesSwitch } from "../src/engine.js";

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
const fresh = () => {
  const s = newSet(1, { left: "V", firstServe: "V", target: 25 });
  s.teams.V = { lineup: ["1", "2", "3", "4", "5", "6"], libero: "9", libero2: "19", noLibero: false, captain: "1" };
  s.teams.H = { lineup: ["11", "12", "13", "14", "15", "16"], libero: "10", libero2: "", noLibero: false, captain: "11" };
  return s;
};
const R = (s, w) => s.events.push({ type: "rally", winner: w });
const L = (s, team, dir, player, libero) => s.events.push({ type: "libero", team, dir, player, libero });

// Back row: the receiving team's position 1 is the player who'll serve LAST.
let s = fresh();
eq(backRowRows(replay(s), "V"), [0, 4, 5], "serving team: back row is I (server), V, VI");
eq(backRowRows(replay(s), "H"), [5, 3, 4], "receiving team at the start: back row is VI, IV, V (I is right front)");

// A clean replacement and return.
L(s, "H", "in", "16", "10");
let st = replay(s);
eq(st.libWarnings, [], "libero in for #16 (back row): no warnings");
eq(st.lib.H, { libero: "10", row: 5, player: "16" }, "tracker knows the libero is in for #16 in VI");
eq(liberoWarnings(st, "H", { dir: "out", player: "16" }), ["There must be a completed rally between libero replacements."], "straight back out with no rally between: flagged");
R(s, "V");
L(s, "H", "out", "16");
st = replay(s);
eq(st.track.H[5].map((e) => e.v), ["16", "L", "16"], "current-players column: 16, L, 16 (cross out, L, cross out)");
eq(st.lib.H, null, "libero off");
eq(st.subs.H, 0, "libero replacements don't count as substitutions");

// Front-row player can't be replaced; two liberos can't be on together.
eq(liberoWarnings(st, "H", { dir: "in", player: "12" }).some((w) => /front row/.test(w)), true, "replacing a front-row player is flagged");
s = fresh();
L(s, "V", "in", "1", "9");
st = replay(s);
eq(liberoWarnings(st, "V", { dir: "in", player: "5", libero: "19" }).some((w) => /two liberos/.test(w)), true, "second libero onto the court is flagged");
eq(liberoWarnings(st, "V", { dir: "out", player: "4" }).some((w) => /Only #1/.test(w)), true, "only the replaced player may come back for her");

// She serves when she's in the serving position — no extra tap needed.
s = fresh();
L(s, "V", "in", "1", "9"); // V is serving, #1 is the server: the libero serves for #1
R(s, "V"); R(s, "V"); R(s, "H");
st = replay(s);
eq(marksText(st.rows.V[0].marks), "<1> <2> <-|>", "libero serve recorded automatically as triangles");
eq(st.rows.V[0].liberoTri, true, "position I triangled on the score sheet");
eq(st.run.V[1], "tri", "running score triangled");
eq(st.liberoServeRow.V, 0, "her serving position is now I for the set");

// She has to leave when her position rotates to the front row.
s = fresh();
L(s, "H", "in", "16", "10"); // VI, back row while H receives
R(s, "H"); // H sideout: I serves, back row I, V, VI
st = replay(s);
eq(st.libPrompts, [], "still back row after the first rotation");
R(s, "V"); R(s, "H"); // II serves
R(s, "V"); R(s, "H"); // III serves -> VI is now left front
st = replay(s);
eq(st.libPrompts.map((p) => p.kind), ["frontRow"], "prompt: libero rotated to the front row");
eq(/#16 must come back in/.test(st.libPrompts[0].text), true, "...naming #16");
L(s, "H", "out", "16");
eq(replay(s).libPrompts, [], "prompt clears once #16 is back");

// One serving position per set.
s = fresh();
L(s, "V", "in", "1", "9"); R(s, "V"); R(s, "H"); // served in I, sideout
R(s, "V"); // V back: II now serving, #1 rotated to VI... (back row)
L(s, "V", "out", "1"); R(s, "H"); R(s, "V"); // III? no — V regains serve with III
st = replay(s);
const serverRow = st.nextRow.V;
L(s, "V", "in", st.rows.V[serverRow].numbers.at(-1), "9");
st = replay(s);
eq(st.libPrompts.map((p) => p.kind), ["serve"], `prompt: she can't serve in ${["I","II","III","IV","V","VI"][serverRow]} too`);
R(s, "V");
eq(replay(s).libWarnings.some((w) => /already served in I/.test(w.text)), true, "serving anyway is recorded as a warning");

// Service tallies: one per term of service, however many points it lasts.
s = fresh();
R(s, "V"); R(s, "V"); R(s, "H"); R(s, "V");
st = replay(s);
eq(st.termAt.V.map((a) => a.length), [1, 1, 0, 0, 0, 0], "V: I served once (3 points = one tally), II once");
eq(st.termAt.H.map((a) => a.length), [1, 0, 0, 0, 0, 0], "H: I served once");

// Regular subs go in the current-players column too.
s.events.push({ type: "sub", team: "H", pairs: [{ in: "21", out: "13" }] });
eq(replay(s).track.H[2].map((e) => e.v), ["13", "21"], "sub: 13 crossed out, 21 written in");

// Deciding set: the side switch at 8.
const d = newSet(5, { left: "V", firstServe: "V", target: 15 });
d.teams = fresh().teams;
for (let i = 0; i < 7; i++) { R(d, "V"); R(d, "H"); }
eq(replay(d).switchAt, null, "7 - 7: no switch yet");
R(d, "H");
eq(replay(d).switchAt, d.events.length - 1, "first to 8: the switch is marked at that rally");

const m5 = { bestOf: 5 };
eq(sidesSwitch(m5, d), true, "deciding set to 15: switch at 8 applies by default");
eq(sidesSwitch({ ...m5, switchAt8: false }, d), false, "match option off: no switch");
eq(sidesSwitch(m5, { ...d, noSwitch: true }), false, "scorer marked the teams didn't switch: no switch");
eq(sidesSwitch(m5, { ...d, number: 4 }), false, "not the deciding set: no switch");
eq(sidesSwitch({ bestOf: 3 }, { ...d, number: 3, target: 25 }), false, "deciding set to 25: no switch");

console.log(fails ? `\n${fails} FAILURES` : "\nall checks passed");
process.exit(fails ? 1 : 0);
