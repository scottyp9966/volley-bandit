import React, { useMemo, useState } from "react";
import { Undo2, X } from "lucide-react";
import { SCALES, SKILL_KEYS, byPlayer, countOf, dayOf, defaultMatchId, fmtAvg, newRatingId, summarize, todayISO } from "./liveRatings.js";

// The Live tab: rate each pass (0–3) or serve (0–4) as it happens. Tap a
// player, tap a number. Built to be run one-handed from the bench, or by an
// assistant coach on a second device while the head coach runs Volley Bandit.
//
// Each rating is tagged with the match Volley Bandit has active (or
// "Practice", grouped by day) and the set, so the numbers can be read per
// set, per match and across the season.

const C = {
  bg: "#12161c",
  card: "#1a2029",
  line: "#2c3542",
  text: "#eef0f3",
  dim: "#6b7383",
  mid: "#9aa3b2",
  accent: "#e8622c",
  accentSoft: "#3a2013",
  green: "#4fae6f",
  gold: "#d9a43a",
  red: "#e2504f",
};

// Colour by how good the number is relative to the scale, so 3 on a pass and
// 4 on a serve are both green, and 0 is always red.
function valueColor(v, max) {
  if (v === 0) return C.red;
  if (v === max) return C.green;
  return v / max >= 0.5 ? C.gold : C.mid;
}

function DistBar({ dist, max, count, height = 6 }) {
  if (!count) return null;
  const order = [...Array(max + 1).keys()].reverse();
  return (
    <div style={{ display: "flex", height, borderRadius: 3, overflow: "hidden", background: C.card }}>
      {order.map((v) =>
        dist[v] ? <div key={v} title={`${v}: ${dist[v]}`} style={{ width: `${(dist[v] / count) * 100}%`, background: valueColor(v, max) }} /> : null
      )}
    </div>
  );
}

const chip = (on) => ({
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 700,
  border: `1px solid ${on ? C.accent : C.line}`,
  background: on ? C.accentSoft : C.card,
  color: on ? C.accent : C.mid,
  cursor: "pointer",
});

const PRACTICE = "practice";

// "2026-11-21" -> "Nov 21", read as a LOCAL date (new Date("2026-11-21")
// is UTC midnight, which is the evening before west of Greenwich).
function shortDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function LiveRate({ roster, courtIds, rotation, matches, activeMatchId, setNumber, ratings, ops, displayName }) {
  const today = todayISO();
  const [matchSel, setMatchSel] = useState("auto");
  const [setOverride, setSetOverride] = useState(null);
  const [skill, setSkill] = useState("pass");
  const [selected, setSelected] = useState(null);
  const [hint, setHint] = useState("");
  const [myIds, setMyIds] = useState([]);
  const [scope, setScope] = useState("set"); // "set" | "session"
  const [showKey, setShowKey] = useState(false);

  const autoMatch = defaultMatchId(matches, activeMatchId, today);
  const matchId = matchSel === "auto" ? autoMatch : matchSel === PRACTICE ? null : matchSel;
  const match = matches.find((m) => m.id === matchId) || null;
  const setNo = setOverride ?? setNumber ?? 1;
  const scale = SCALES[skill];

  const sortedMatches = useMemo(
    () => [...matches].filter((m) => m && m.id != null).sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [matches]
  );

  // Everything recorded for this match (or today's practice), any device.
  const session = useMemo(
    () => ratings.filter((e) => (matchId != null ? e.matchId === matchId : e.matchId == null && dayOf(e.at) === today)),
    [ratings, matchId, today]
  );
  const scoped = scope === "set" ? session.filter((e) => e.setNumber === setNo) : session;
  const team = summarize(scoped, skill);
  const rows = byPlayer(scoped, skill);
  const rowById = new Map(rows.map((r) => [r.playerId, r]));

  const byId = new Map(roster.map((p) => [p.id, p]));
  const court = courtIds.map((id) => byId.get(id)).filter(Boolean);
  const bench = roster.filter((p) => !courtIds.includes(p.id));

  const record = (value) => {
    if (selected == null) {
      // never a dead tap — say why nothing happened
      setHint("Tap a player first, then the rating.");
      return;
    }
    const entry = {
      id: newRatingId(),
      playerId: selected,
      skill,
      value,
      matchId: matchId ?? null,
      setNumber: setNo,
      at: Date.now(),
    };
    ops.add(entry);
    setMyIds((prev) => [...prev.slice(-49), entry.id]);
    const p = byId.get(selected);
    setHint(`#${p?.num ?? "?"} ${displayName(p)} · ${scale.label} ${value}`);
    // A pass is usually a different player every time; a server serves
    // until the side-out, so keep her selected for the next one.
    if (skill === "pass") setSelected(null);
  };

  const present = new Set(ratings.map((e) => e.id));
  const undoId = [...myIds].reverse().find((id) => present.has(id));
  const undo = () => {
    if (!undoId) return;
    ops.remove(undoId);
    setMyIds((prev) => prev.filter((id) => id !== undoId));
    setHint("Undone.");
  };

  const recent = [...session].reverse().slice(0, 6);

  const tile = (p) => {
    const r = rowById.get(p.id);
    const on = selected === p.id;
    return (
      <button
        key={p.id}
        onClick={() => {
          setSelected(on ? null : p.id);
          setHint("");
        }}
        style={{
          minWidth: 0,
          padding: "8px 2px 6px",
          borderRadius: 8,
          border: `${on ? 2 : 1}px solid ${on ? C.accent : C.line}`,
          background: on ? C.accentSoft : C.card,
          color: C.text,
          cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 800, color: on ? C.accent : C.text, lineHeight: 1.1 }}>{p.num}</div>
        <div style={{ fontSize: 11, color: C.mid, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 2px" }}>
          {displayName(p)}
        </div>
        <div style={{ fontSize: 10, color: r ? C.accent : C.dim, marginTop: 2, fontWeight: 600 }}>
          {r ? `${fmtAvg(r.avg)} · ${r.count}` : "–"}
        </div>
      </button>
    );
  };
  const grid = { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 };
  const label = { fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: 0.5, margin: "12px 0 6px" };

  return (
    <div>
      {/* Match + set */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          value={matchSel === "auto" ? (autoMatch ?? PRACTICE) : matchSel}
          onChange={(e) => setMatchSel(e.target.value === PRACTICE ? PRACTICE : matches.find((m) => String(m.id) === e.target.value)?.id ?? PRACTICE)}
          style={{ flex: 1, minWidth: 0, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, color: C.text, padding: "8px 6px", fontSize: 13 }}
          aria-label="Match"
        >
          <option value={PRACTICE}>Practice · today</option>
          {sortedMatches.map((m) => (
            <option key={m.id} value={m.id}>
              vs {m.opponent || "?"}
              {m.date ? ` · ${shortDate(m.date)}` : ""}
              {m.id === activeMatchId ? " · live" : ""}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button aria-label="Previous set" onClick={() => setSetOverride(Math.max(1, setNo - 1))} style={{ ...chip(false), padding: "7px 10px" }}>
            −
          </button>
          <div style={{ fontSize: 13, fontWeight: 700, minWidth: 44, textAlign: "center" }}>Set {setNo}</div>
          <button aria-label="Next set" onClick={() => setSetOverride(Math.min(5, setNo + 1))} style={{ ...chip(false), padding: "7px 10px" }}>
            +
          </button>
        </div>
      </div>
      {matchId == null && (
        <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
          No match selected — these count as today's practice. Set the match active in Volley Bandit (or pick it above) to attach them to it.
        </div>
      )}

      {/* Skill */}
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        {SKILL_KEYS.map((k) => (
          <button key={k} onClick={() => setSkill(k)} style={{ ...chip(skill === k), flex: 1 }}>
            {SCALES[k].label} 0–{SCALES[k].max}
          </button>
        ))}
      </div>

      {/* Players */}
      {court.length > 0 && (
        <>
          <div style={label}>ON COURT{rotation ? ` · ROTATION ${rotation}` : ""}</div>
          <div style={grid}>{court.map(tile)}</div>
        </>
      )}
      <div style={label}>{court.length > 0 ? "BENCH" : "PLAYERS"}</div>
      <div style={grid}>{bench.map(tile)}</div>
      {roster.length === 0 && <div style={{ fontSize: 13, color: C.dim }}>Add players on the Roster tab first.</div>}

      {/* Rating buttons — sticky so they stay under the thumb on a long roster */}
      <div style={{ position: "sticky", bottom: 0, background: C.bg, paddingTop: 10, paddingBottom: 6, marginTop: 8 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {scale.values.map(({ v, short }) => (
            <button
              key={v}
              onClick={() => record(v)}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "10px 0 8px",
                borderRadius: 10,
                border: `1.5px solid ${valueColor(v, scale.max)}`,
                background: C.card,
                color: valueColor(v, scale.max),
                opacity: selected == null ? 0.55 : 1,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{v}</div>
              <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3, whiteSpace: "nowrap" }}>{short}</div>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, minHeight: 30 }}>
          <div style={{ fontSize: 12, color: hint.startsWith("Tap") ? C.gold : C.mid }}>{hint || " "}</div>
          <button onClick={undo} disabled={!undoId} style={{ ...chip(false), padding: "5px 10px", display: "flex", alignItems: "center", gap: 4, opacity: undoId ? 1 : 0.4 }}>
            <Undo2 size={14} /> Undo
          </button>
        </div>
      </div>

      <button onClick={() => setShowKey(!showKey)} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, padding: "4px 0", cursor: "pointer" }}>
        {showKey ? "Hide" : "What do the numbers mean?"}
      </button>
      {showKey && (
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, marginTop: 4 }}>
          {scale.values.map(({ v, short, detail }) => (
            <div key={v} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
              <b style={{ color: valueColor(v, scale.max), width: 14 }}>{v}</b>
              <span>
                <b>{short}</b> <span style={{ color: C.mid }}>— {detail}</span>
              </span>
            </div>
          ))}
          {skill === "pass" && <div style={{ color: C.dim, marginTop: 4 }}>A team pass average of about 2.0 or better is a solid high-school target.</div>}
        </div>
      )}

      {/* Summary */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>
          {scale.label.toUpperCase()} · {match ? `vs ${match.opponent || "?"}` : "PRACTICE"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setScope("set")} style={{ ...chip(scope === "set"), padding: "4px 8px", fontSize: 11 }}>
            Set {setNo}
          </button>
          <button onClick={() => setScope("session")} style={{ ...chip(scope === "session"), padding: "4px 8px", fontSize: 11 }}>
            {match ? "Match" : "Today"}
          </button>
        </div>
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginTop: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Team</span>
          <span style={{ fontSize: 13, color: C.mid }}>
            <b style={{ color: C.text, fontSize: 18 }}>{fmtAvg(team.avg)}</b> · {countOf(team.count, skill)}
          </span>
        </div>
        <DistBar {...team} height={8} />
        {rows.map((r) => {
          const p = byId.get(r.playerId);
          return (
            <div key={r.playerId} style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                <span>
                  #{p?.num ?? "?"} {p ? displayName(p) : "Removed player"}
                </span>
                <span style={{ color: C.mid }}>
                  <b style={{ color: C.accent }}>{fmtAvg(r.avg)}</b> · {r.count}
                </span>
              </div>
              <DistBar {...r} />
            </div>
          );
        })}
        {team.count === 0 && <div style={{ fontSize: 12, color: C.dim }}>Nothing rated yet{scope === "set" ? ` in set ${setNo}` : ""}.</div>}
      </div>

      {recent.length > 0 && (
        <>
          <div style={label}>RECENT</div>
          {recent.map((e) => {
            const p = byId.get(e.playerId);
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.card}` }}>
                <span>
                  #{p?.num ?? "?"} {p ? displayName(p) : "Removed player"} · {SCALES[e.skill].label}{" "}
                  <b style={{ color: valueColor(e.value, SCALES[e.skill].max) }}>{e.value}</b>
                  <span style={{ color: C.dim }}> · set {e.setNumber}</span>
                </span>
                <button onClick={() => ops.remove(e.id)} aria-label="Delete rating" style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", padding: 4 }}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
