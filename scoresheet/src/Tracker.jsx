import React from "react";
import { ROMAN, SUB_LIMIT, other, replay } from "./engine.js";

// The libero tracking sheet, laid out like the MIAA form (VB Form #3): every
// set of the match on one portrait page, each team a block of six serving
// positions with
//   Service — a tally each time that position STARTS a term of service
//             (one tally per term, however many points it lasts)
//   SP      — the starting player
//   CP      — current players: every change in order, all but the last
//             crossed out. "L" when a libero replaces her; the player's
//             number again when she returns; a sub's number on a sub.
// plus the libero numbers (L1/L2), an S box for the team serving first, and
// the 18 substitutions. Libero replacements never touch the sub count.
//
// The deciding set has three blocks: the side switch at 8 moves the left
// team's positions across to the third block, starting from whoever was on
// the court at the switch.
//
// Everything here is derived from the same replay as the score sheet, so the
// two can't disagree. Black on white with blue "ink" for the same reason as
// the score sheet: it's a paper record.

export const TRACK_W = 816;
export const TRACK_H = 1056;
const BLUE = "#1d3f9a";
const INK = "#111";
const RULE = "#222";
const FAINT = "#888";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function Struck({ children, on }) {
  return (
    <span style={{ position: "relative", color: BLUE, fontWeight: 700, fontSize: 11 }}>
      {children}
      {on && (
        <svg viewBox="0 0 10 10" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <line x1="9" y1="1.5" x2="1" y2="8.5" stroke={BLUE} strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </span>
  );
}

const tally = (n) => (n ? "|".repeat(n) : "");

// One team's block. `entries(r)` gives that row's player entries, `tallies(r)`
// its service count, `subs` the substitutions used.
function Block({ name, l1, l2, servesFirst, entries, tallies, subs, compact }) {
  const cell = { borderRight: `1px solid ${RULE}`, display: "flex", alignItems: "center", padding: "0 3px" };
  return (
    <div style={{ flex: 1, minWidth: 0, border: `1.5px solid ${RULE}`, display: "flex", flexDirection: "column", fontSize: 9 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${RULE}`, height: 17, alignItems: "center", fontWeight: 700 }}>
        <span style={{ width: 16, textAlign: "center", borderRight: `1px solid ${RULE}`, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {servesFirst ? (
            <span style={{ color: BLUE, fontSize: 9, border: `1.4px solid ${BLUE}`, borderRadius: 999, width: 13, height: 13, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>S</span>
          ) : (
            "S"
          )}
        </span>
        <span style={{ flex: 1, padding: "0 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          TEAM: <span style={{ color: BLUE, fontSize: 10 }}>{name}</span>
        </span>
        <span style={{ width: compact ? 34 : 44 }}>
          L1: <span style={{ color: BLUE }}>{l1}</span>
        </span>
        <span style={{ width: compact ? 34 : 44 }}>
          L2: <span style={{ color: BLUE }}>{l2}</span>
        </span>
      </div>
      <div style={{ display: "flex", borderBottom: `1px solid ${RULE}`, height: 20, fontSize: 8 }}>
        <span style={{ ...cell, width: 30, lineHeight: 1 }}>Serve Order</span>
        <span style={{ ...cell, width: compact ? 34 : 44, justifyContent: "center" }}>Service</span>
        <span style={{ ...cell, width: 24, justifyContent: "center" }}>SP</span>
        <span style={{ ...cell, flex: 1, borderRight: "none" }}>CP</span>
      </div>
      {ROMAN.map((rn, r) => {
        const list = entries ? entries(r) : [];
        const last = list.length - 1;
        return (
          <div key={rn} style={{ display: "flex", minHeight: 19, borderBottom: `1px solid ${RULE}` }}>
            <span style={{ ...cell, width: 30, justifyContent: "center", fontWeight: 800, fontFamily: "Georgia, serif", fontSize: 10 }}>{rn}</span>
            <span style={{ ...cell, width: compact ? 34 : 44, color: BLUE, fontWeight: 700, letterSpacing: 1, overflow: "hidden" }}>{tallies ? tally(tallies(r)) : ""}</span>
            <span style={{ ...cell, width: 24, justifyContent: "center" }}>{list[0] && <Struck on={last > 0}>{list[0].v}</Struck>}</span>
            <span style={{ flex: 1, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0 5px", padding: "1px 4px" }}>
              {list.slice(1).map((e, k) => (
                <Struck key={k} on={k + 1 < last}>
                  {e.v}
                </Struck>
              ))}
            </span>
          </div>
        );
      })}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0 3px", padding: "2px 3px", fontSize: 8, alignItems: "center" }}>
        <b>Subs</b>
        {Array.from({ length: SUB_LIMIT }, (_, i) => (
          <span key={i} style={{ position: "relative", minWidth: 10, textAlign: "center", color: i < (subs || 0) ? INK : FAINT }}>
            {i + 1}
            {i < (subs || 0) && (
              <svg viewBox="0 0 10 10" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
                <line x1="9" y1="1" x2="1" y2="9" stroke={BLUE} strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function teamProps(match, set, st, t, { from = -Infinity, to = Infinity, spFrom } = {}) {
  const team = set.teams[t];
  const name = (t === "H" ? match.header.home : match.header.visitor) || (t === "H" ? "Home" : "Visitor");
  const libs = st.liberos[t];
  return {
    name,
    l1: team.noLibero ? "X" : libs.length > 1 ? libs.join("→") : libs[0] || "",
    l2: team.noLibero ? "" : team.libero2 || "",
    servesFirst: set.firstServe === t,
    entries: (r) => {
      const all = st.track[t][r];
      if (from === -Infinity && to === Infinity) return all;
      const inRange = all.filter((e) => e.at > from && e.at <= to);
      if (spFrom == null) return [all[0], ...inRange.filter((e) => e.at > -1)];
      const before = all.filter((e) => e.at <= spFrom);
      return [before[before.length - 1], ...inRange];
    },
    tallies: (r) => st.termAt[t][r].filter((a) => a > from && a <= to).length,
    subs: st.subs[t],
  };
}

function SetRow({ match, idx }) {
  const set = match.sets[idx];
  const n = idx + 1;
  // Three blocks only for a deciding set to 15 — that's the one with the
  // side switch at 8. A best-of-3's third set to 25 is laid out like the rest.
  const deciding = n === (match.bestOf || 5) && (set ? set.target : match.decidingTarget) === 15;
  const st = set && set.startTime ? replay(set, match.sets.slice(0, idx)) : null;
  const L = set ? set.left : null;
  const R = L ? other(L) : null;

  if (deciding) {
    let blocks = [{}, {}, {}];
    if (st) {
      const sw = match.switchAt8 !== false ? st.switchAt : null;
      if (sw == null) {
        blocks = [teamProps(match, set, st, L), teamProps(match, set, st, R), { name: "" }];
      } else {
        const pre = replay({ ...set, events: set.events.slice(0, sw + 1) }, match.sets.slice(0, idx));
        const left = teamProps(match, set, st, L, { to: sw });
        left.subs = pre.subs[L];
        left.tallies = (r) => st.termAt[L][r].filter((a) => a <= sw).length;
        const after = teamProps(match, set, st, L, { from: sw, spFrom: sw });
        after.servesFirst = false;
        blocks = [left, teamProps(match, set, st, R), after];
      }
    }
    return (
      <div style={{ border: `1.5px solid ${RULE}`, marginTop: 6 }}>
        <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, borderBottom: `1.5px solid ${RULE}`, padding: 2 }}>
          SET {n}
          {st && match.switchAt8 !== false && st.switchAt != null && <span style={{ fontSize: 10, fontWeight: 600, color: BLUE }}> · sides switched at 8</span>}
        </div>
        <div style={{ display: "flex", gap: 0 }}>
          {blocks.map((b, i) => (
            <Block key={i} {...b} compact />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 0, marginTop: idx ? 8 : 0 }}>
      <Block {...(st ? teamProps(match, set, st, L) : {})} />
      <div style={{ width: 70, border: `1.5px solid ${RULE}`, borderLeft: "none", borderRight: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ fontSize: 10, fontWeight: 700, borderBottom: `1px solid ${RULE}`, width: "100%", textAlign: "center", padding: 2 }}>SET</div>
        <div style={{ fontSize: 50, fontWeight: 800, flex: 1, display: "flex", alignItems: "center" }}>{n}</div>
      </div>
      <Block {...(st ? teamProps(match, set, st, R) : {})} />
    </div>
  );
}

export default function TrackerSheet({ match }) {
  const count = Math.max(match.bestOf || 5, match.sets.length);
  return (
    <div className="sheet-page" data-orient="p" style={{ width: TRACK_W, minHeight: TRACK_H, background: "#fff", color: INK, fontFamily: FONT, padding: "18px 22px" }}>
      <div style={{ textAlign: "center", fontSize: 20, fontWeight: 800 }}>Volleyball Libero Tracking Sheet</div>
      <div style={{ textAlign: "center", fontSize: 10, marginBottom: 2 }}>
        SP = Starting Players &nbsp;&nbsp; CP = Current Players &nbsp;&nbsp; L = Libero &nbsp;&nbsp; Ⓢ = served first &nbsp;&nbsp; Service: one tally per term of service
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: BLUE, marginBottom: 8 }}>
        {match.header.visitor || "Visitor"} at {match.header.home || "Home"} · {match.header.date}
      </div>
      {Array.from({ length: count }, (_, i) => (
        <SetRow key={i} match={match} idx={i} />
      ))}
    </div>
  );
}
