// The NFHS handbook's worked example (Washington Central at Holy Angels,
// set 1), as events. Shared by the engine test and the browser check.
import { newSet } from "../src/engine.js";

export function handbookSet() {
  // H = Holy Angels (home), V = Washington Central (visitor, serves first).
  const set = newSet(1, { left: "V", firstServe: "V", target: 25 });
  set.teams.V = { lineup: ["00", "15", "5", "13", "16", "21"], libero: "33", noLibero: false, captain: "00" };
  set.teams.H = { lineup: ["4", "2", "6", "1", "8", "7"], libero: "10", noLibero: false, captain: "10" };
  const E = set.events;
  const rally = (w, n = 1) => { for (let i = 0; i < n; i++) E.push({ type: "rally", winner: w }); };
  const sub = (team, pin, pout, extra = {}) => E.push({ type: "sub", team, pairs: [{ in: pin, out: pout }], ...extra });
  const note = (team, code, extra = {}) => E.push({ type: "comment", team, code, ...extra });

  note("V", "NOTE", { text: "Charged sub for illegal lineup", chargeSub: true });
  rally("V", 3); rally("H");                                   // 1. WC 3 - HA 1
  sub("H", "5", "1"); rally("H", 4); sub("V", "45", "16"); rally("H", 2); rally("V"); // 2. WC 4 - HA 7
  rally("V", 3); E.push({ type: "timeout", team: "H" }); note("V", "YUD"); rally("H"); // 3. WC 7 - HA 8
  rally("H"); E.push({ type: "replay" }); note("H", "CM", { member: "2" }); sub("H", "9", "2");
  E.push({ type: "reserve" }); rally("H"); E.push({ type: "reserve", lost: true });    // 4. WC 8 - HA 10
  E.push({ type: "liberoServe" }); rally("H");                 // 5. WC 8 - HA 11
  sub("H", "3", "6"); rally("H", 3); E.push({ type: "timeout", team: "V" }); rally("V"); // 6. WC 9 - HA 14
  rally("V", 3); note("H", "RC", { member: "8" }); rally("V"); rally("H");             // 7. WC 14 - HA 15
  rally("H", 3); rally("V");                                   // 8. WC 15 - HA 18
  sub("H", "1", "7", { exceptional: true }); rally("V", 3); E.push({ type: "timeout", team: "H" });
  note("H", "YUD"); rally("H");                                // 9. WC 18 - HA 19
  rally("H"); note("V", "RL", { member: "33", newLibero: "12" }); rally("H"); rally("V"); // 10. WC 19 - HA 21
  rally("H");                                                  // 11. WC 19 - HA 22
  sub("V", "7", "5"); sub("H", "6", "3"); rally("H"); E.push({ type: "timeout", team: "V" }); rally("V"); // 12. WC 20 - HA 23
  note("V", "RUD"); rally("V");                                // 13. WC 21 - HA 24
  rally("V", 3); note("H", "RUD"); rally("V");                 // 14. WC 26 - HA 24
  return set;
}
