// The contract between Volley Bandit and the Score Sheet: the link Volley
// Bandit builds (src/scoreSheetLink.js) must give the scorer the right
// serving order, and must carry nothing but jersey numbers and a team name.
//
//   node scoresheet/test/link.test.mjs
import { buildScoreSheetPayload, scoreSheetUrl, servingOrder } from "../../src/scoreSheetLink.js";
import { jerseyFor } from "../../src/shared.js";

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};

const slots = { P1: "a", P2: "b", P3: "c", P4: "d", P5: "e", P6: "f" };
eq(servingOrder(slots, "us"), ["a", "b", "c", "d", "e", "f"], "serving first: P1 serves, then P2 (who rotates into P1)");
eq(servingOrder(slots, undefined), ["a", "b", "c", "d", "e", "f"], "unset servesFirst means we serve");
eq(servingOrder(slots, "opp"), ["b", "c", "d", "e", "f", "a"], "receiving first: right front (P2) is server I");

const roster = [
  { id: 1, firstName: "Joy", lastName: "Bennett", num: 32 },
  { id: 2, firstName: "Ava", lastName: "Cole", num: 7 },
  { id: 3, firstName: "Mia", lastName: "Diaz", num: 12 },
  { id: 4, firstName: "Kai", lastName: "Ellis", num: 4 },
  { id: 5, firstName: "Liv", lastName: "Ford", num: 18 },
  { id: 6, firstName: "Zoe", lastName: "Gray", num: 22 },
  { id: 7, firstName: "Ren", lastName: "Hart", num: 51, liberoNum: 1 },
];
const lineups = [
  { id: "L2", setNumber: 2, servesFirst: "opp", slots: { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6 }, liberos: [7] },
  { id: "L1", setNumber: 1, servesFirst: "us", slots: { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6 }, liberos: [7, null] },
];
const payload = buildScoreSheetPayload({
  teamName: "Grafton High School JV1",
  match: { opponent: "Shrewsbury - JV", date: "2026-11-04", homeAway: "Away", location: "Shrewsbury HS" },
  lineups,
  roster,
  captainIds: [3],
  rawSlots: (l) => l.slots,
  jersey: jerseyFor,
});
eq(payload.lineups.map((l) => l.set), [1, 2], "lineups sorted by set");
eq(payload.lineups[0].order, ["32", "7", "12", "4", "18", "22"], "set 1 (we serve): jersey numbers in serving order");
eq(payload.lineups[1].order, ["7", "12", "4", "18", "22", "32"], "set 2 (we receive): order starts at right front");
eq(payload.lineups[0].libero, "1", "the libero shows her LIBERO jersey, not her DS number");
eq(payload.lineups[0].captain, "12", "captain carried as a jersey number");
eq(payload.homeAway, "Away", "home/away carried");

const url = scoreSheetUrl(payload, "https://example.test");
const frag = url.split("#import=")[1];
const decoded = JSON.parse(Buffer.from(frag, "base64url").toString("utf8"));
eq(decoded, payload, "the link round-trips");
eq(url.includes("?"), false, "payload rides in the #fragment, never the query string a server would see");
const flat = JSON.stringify(decoded);
for (const p of roster) {
  eq(flat.includes(p.firstName) || flat.includes(p.lastName), false, `no name for #${p.num}`);
}
const allowed = new Set(["v", "team", "opponent", "date", "homeAway", "location", "lineups", "set", "order", "libero", "captain"]);
const keys = [];
const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") Object.entries(o).forEach(([k, v]) => { keys.push(k); walk(v); }); };
walk(decoded);
eq(keys.filter((k) => !allowed.has(k)), [], "only allow-listed keys in the link (no team code, no ids, no names)");

console.log(fails ? `\n${fails} FAILURES` : "\nall checks passed");
process.exit(fails ? 1 : 0);
