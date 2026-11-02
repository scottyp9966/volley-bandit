import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  COMMENT_CODES,
  ROMAN,
  SUB_LIMIT,
  TIMEOUT_LIMIT,
  backRowRows,
  liberoWarnings,
  lineupCheck,
  lineupProblems,
  sidesSwitch,
  currentNumber,
  matchTally,
  newSet,
  num,
  other,
  replay,
  subWarnings,
} from "./engine.js";
import Sheet, { SHEET_H, SHEET_W, fmtTime } from "./Sheet.jsx";
import TrackerSheet, { TRACK_W } from "./Tracker.jsx";
import { exportPdf } from "./pdf.js";

// ─────────────────────────────────────────────────────────────────────────────
// Volley Bandit Score Sheet — an interactive NFHS score sheet for the
// scorer's table. A separate app from Volley Bandit on purpose: the scorer is
// usually a volunteer, often from the other school, so it needs no team code
// and no sign-in, and it can score any match.
//
// Everything lives on this device (localStorage) and the app works with no
// signal at all. The official record is the PDF it produces — one page per
// set in the NFHS layout — which the R2 checks and the scorer can share.
//
// Volley Bandit can hand over a team's lineups through a link
// (`#import=…`, see readImport). That link carries jersey NUMBERS and a team
// name only — never the team code, never a player's name — because it is
// exactly the kind of thing that gets forwarded to a parent volunteer.
//
// The rules live in engine.js; this file is screens.
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION = "2026.11.02c";
const STORE_KEY = "vbs-matches-v1";

const C = {
  bg: "#12161c",
  card: "#1a2029",
  card2: "#212936",
  line: "#2c3542",
  text: "#e8edf4",
  dim: "#8c9aad",
  accent: "#e8577a",
  accentSoft: "rgba(232,87,122,0.16)",
  green: "#3fbf6f",
  red: "#e5564a",
  blue: "#4a9fe5",
  gold: "#e0b23a",
  goldSoft: "rgba(224,178,58,0.14)",
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const LEVEL_FORMAT = {
  Varsity: { bestOf: 5, decidingTarget: 15 },
  JV: { bestOf: 3, decidingTarget: 25 },
  Freshman: { bestOf: 3, decidingTarget: 25 },
  "Middle School": { bestOf: 3, decidingTarget: 25 },
};

function guessLevel(name = "") {
  if (/\bJ\.?V(\d|\b)|junior varsity/i.test(name)) return "JV"; // "JV", "JV1", "J.V."
  if (/fresh/i.test(name)) return "Freshman";
  if (/middle|\b[78]th\b/i.test(name)) return "Middle School";
  return "Varsity";
}

function makeMatch(init = {}) {
  const level = init.level || "Varsity";
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    header: { date: todayISO(), home: "", visitor: "", site: "", level, gender: "Girls", r1: "", r2: "", scorer: "", ...(init.header || {}) },
    ...LEVEL_FORMAT[level],
    sets: [],
    vb: init.vb || null,
  };
}

// ── storage ─────────────────────────────────────────────────────────────────
function loadStore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.matches)) return d;
  } catch {
    /* fall through */
  }
  return { matches: [] };
}
function useStore() {
  const [data, setData] = useState(loadStore);
  const update = useCallback((fn) => {
    setData((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* storage full or blocked — keep going in memory */
      }
      return next;
    });
  }, []);
  return [data, update];
}

// ── import from Volley Bandit ───────────────────────────────────────────────
// `#import=<base64url(JSON)>`:
//   { v: 1, team, opponent, date, homeAway, location,
//     lineups: [{ set, order: [6 numbers, serve order I..VI], libero, captain }] }
function readImport() {
  try {
    const m = window.location.hash.match(/import=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const d = JSON.parse(new TextDecoder().decode(bytes));
    if (!d || d.v !== 1 || !Array.isArray(d.lineups)) return null;
    const lineups = d.lineups
      .filter((l) => Array.isArray(l.order) && l.order.length === 6)
      .map((l) => ({ set: Number(l.set) || 1, order: l.order.map((n) => num(n)), libero: num(l.libero), captain: num(l.captain) }));
    return { team: String(d.team || ""), opponent: String(d.opponent || ""), date: String(d.date || ""), homeAway: d.homeAway === "Away" ? "Away" : "Home", location: String(d.location || ""), lineups };
  } catch {
    return null;
  }
}

// ── small UI pieces ─────────────────────────────────────────────────────────
const btn = (bg = C.card2, color = C.text, extra = {}) => ({
  background: bg,
  color,
  border: `1px solid ${bg === C.card2 ? C.line : bg}`,
  borderRadius: 10,
  padding: "11px 12px",
  fontSize: 14,
  fontWeight: 700,
  ...extra,
});
const input = { background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 10px", fontSize: 15, width: "100%" };
const label = { fontSize: 11, color: C.dim, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 4, display: "block" };

function ConfirmButton({ children, armedLabel, onConfirm, style }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      style={{ ...style, ...(armed ? { background: C.red, color: "#fff", borderColor: C.red } : {}) }}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? armedLabel : children}
    </button>
  );
}

function Panel({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, width: "100%", maxWidth: 560, maxHeight: "88dvh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "16px 16px calc(16px + env(safe-area-inset-bottom))", border: `1px solid ${C.line}` }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 800, flex: 1 }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.dim, fontSize: 22, padding: 4 }} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Warnings({ list, tone = "gold" }) {
  if (!list.length) return null;
  const col = tone === "red" ? C.red : C.gold;
  return (
    <div style={{ background: tone === "red" ? "rgba(229,86,74,0.14)" : C.goldSoft, border: `1px solid ${col}`, borderRadius: 10, padding: "8px 10px", margin: "10px 0", fontSize: 13, lineHeight: 1.4 }}>
      {list.map((w, i) => (
        <div key={i} style={{ color: col }}>• {w}</div>
      ))}
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} style={btn(value === v ? C.accentSoft : C.card2, value === v ? C.accent : C.text, { flex: 1, borderColor: value === v ? C.accent : C.line, padding: "9px 6px", fontSize: 13 })}>
          {l}
        </button>
      ))}
    </div>
  );
}

// Scales the paper sheet down to the width it's given. Tap to see it at
// full size (scrolls sideways on a phone), tap again to fit.
function ScaledSheet({ pageWidth = SHEET_W, children, ...props }) {
  const ref = useRef(null);
  const inner = useRef(null);
  const [w, setW] = useState(360);
  const [h, setH] = useState(SHEET_H);
  const [zoom, setZoom] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth);
      if (inner.current) setH(inner.current.offsetHeight);
    });
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const k = zoom ? 1 : Math.min(1, w / pageWidth);
  return (
    <>
      <div style={{ fontSize: 11, color: C.dim, margin: "0 0 4px" }}>{k < 1 ? "Tap the sheet to see it full size" : zoom ? "Tap to fit the screen" : ""}</div>
      <div ref={ref} onClick={() => setZoom((z) => !z)} style={{ width: "100%", height: h * k, overflowX: zoom ? "auto" : "hidden", overflowY: "hidden", borderRadius: 6, cursor: "zoom-in" }}>
        <div ref={inner} style={{ transform: `scale(${k})`, transformOrigin: "top left", width: pageWidth }}>
          {children || <Sheet {...props} />}
        </div>
      </div>
    </>
  );
}

// ── the app ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data, update] = useStore();
  const [view, setView] = useState({ name: "home" });
  const [pendingImport, setPendingImport] = useState(readImport);
  const [printing, setPrinting] = useState(null); // match being exported
  const [printError, setPrintError] = useState("");

  useEffect(() => {
    if (window.location.hash.includes("import=")) {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const match = view.matchId ? data.matches.find((m) => m.id === view.matchId) : null;
  const updateMatch = useCallback(
    (id, fn) => update((d) => ({ ...d, matches: d.matches.map((m) => (m.id === id ? fn(m) : m)) })),
    [update]
  );

  const startImport = () => {
    const imp = pendingImport;
    const home = imp.homeAway === "Home";
    const level = guessLevel(imp.team);
    const m = makeMatch({
      level,
      header: { date: imp.date || todayISO(), home: home ? imp.team : imp.opponent, visitor: home ? imp.opponent : imp.team, site: imp.location },
      vb: { side: home ? "H" : "V", lineups: imp.lineups },
    });
    update((d) => ({ ...d, matches: [m, ...d.matches] }));
    setPendingImport(null);
    setView({ name: "match", matchId: m.id });
  };

  const runExport = async (m) => {
    setPrintError("");
    setPrinting(m);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await exportPdf(document.getElementById("print-root"), m);
    } catch (err) {
      setPrintError(err?.message || String(err));
    } finally {
      setPrinting(null);
    }
  };

  let body;
  if (view.name === "match" && match) {
    body = <MatchScreen match={match} updateMatch={updateMatch} setView={setView} onExport={() => runExport(match)} exporting={!!printing} />;
  } else if (view.name === "setup" && match) {
    body = <SetupScreen match={match} idx={view.setIdx} updateMatch={updateMatch} setView={setView} />;
  } else if (view.name === "live" && match) {
    body = <LiveScreen match={match} idx={view.setIdx} updateMatch={updateMatch} setView={setView} onExport={() => runExport(match)} exporting={!!printing} />;
  } else {
    body = (
      <HomeScreen
        data={data}
        update={update}
        setView={setView}
        pendingImport={pendingImport}
        onImport={startImport}
        onDismissImport={() => setPendingImport(null)}
      />
    );
  }

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT }}>
      {printError && (
        <div style={{ background: C.red, color: "#fff", padding: "10px 14px", fontSize: 13, display: "flex", gap: 10 }}>
          <span style={{ flex: 1 }}>Couldn't make the PDF: {printError}</span>
          <button onClick={() => setPrintError("")} style={{ background: "none", border: "none", color: "#fff", fontWeight: 800 }}>
            Dismiss
          </button>
        </div>
      )}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "14px 14px calc(30px + env(safe-area-inset-bottom))" }}>{body}</div>
      {printing && (
        <div id="print-root" style={{ position: "fixed", left: -30000, top: 0 }}>
          {printing.sets.map((s, i) =>
            s.startTime ? <Sheet key={i} match={printing} set={s} st={replay(s, printing.sets.slice(0, i))} /> : null
          )}
          <TrackerSheet match={printing} />
        </div>
      )}
    </div>
  );
}

// ── home ────────────────────────────────────────────────────────────────────
function HomeScreen({ data, update, setView, pendingImport, onImport, onDismissImport }) {
  const create = () => {
    const m = makeMatch();
    update((d) => ({ ...d, matches: [m, ...d.matches] }));
    setView({ name: "match", matchId: m.id });
  };
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Score Sheet</h1>
        <span style={{ color: C.dim, fontSize: 12 }}>v{APP_VERSION}</span>
      </div>
      <div style={{ color: C.dim, fontSize: 13, marginBottom: 16 }}>
        NFHS volleyball score sheet for the scorer's table. Works with no signal — everything stays on this device.
      </div>
      {pendingImport && (
        <div style={{ background: C.accentSoft, border: `1px solid ${C.accent}`, borderRadius: 12, padding: 12, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>Lineups from Volley Bandit</div>
          <div style={{ fontSize: 13, color: C.text, marginBottom: 10 }}>
            {pendingImport.team}
            {pendingImport.opponent ? ` vs. ${pendingImport.opponent}` : ""}
            {pendingImport.date ? ` · ${pendingImport.date}` : ""} — {pendingImport.lineups.length} set lineup{pendingImport.lineups.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(C.accent, "#1a0a0f", { flex: 1 })} onClick={onImport}>
              Start this match
            </button>
            <button style={btn()} onClick={onDismissImport}>
              Not now
            </button>
          </div>
        </div>
      )}
      <button style={btn(C.accent, "#1a0a0f", { width: "100%", padding: 14, fontSize: 16, marginBottom: 18 })} onClick={create}>
        + New match
      </button>
      {data.matches.length === 0 && <div style={{ color: C.dim, textAlign: "center", marginTop: 30 }}>No matches yet.</div>}
      {data.matches.map((m) => {
        const won = matchTally(m);
        const live = m.sets.some((s) => s.startTime && !s.ended);
        return (
          <div key={m.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }} onClick={() => setView({ name: "match", matchId: m.id })}>
              <div style={{ fontSize: 12, color: C.dim }}>
                {m.header.date} · {m.header.level}
                {live && <span style={{ color: C.gold, fontWeight: 700 }}> · IN PROGRESS</span>}
              </div>
              <div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {m.header.visitor || "Visitor"} at {m.header.home || "Home"}
              </div>
              {m.sets.some((s) => s.ended) && (
                <div style={{ fontSize: 12, color: C.dim }}>
                  Sets: {m.header.home || "Home"} {won.H} – {won.V} {m.header.visitor || "Visitor"}
                </div>
              )}
            </div>
            <ConfirmButton
              style={btn(C.card2, C.dim, { padding: "7px 10px", fontSize: 12 })}
              armedLabel="Delete?"
              onConfirm={() => update((d) => ({ ...d, matches: d.matches.filter((x) => x.id !== m.id) }))}
            >
              Delete
            </ConfirmButton>
          </div>
        );
      })}
    </>
  );
}

// ── match: header and sets ──────────────────────────────────────────────────
function MatchScreen({ match, updateMatch, setView, onExport, exporting }) {
  const h = match.header;
  const setH = (k, v) => updateMatch(match.id, (m) => ({ ...m, header: { ...m.header, [k]: v } }));
  const won = matchTally(match);
  const need = Math.floor((match.bestOf || 5) / 2) + 1;
  const decided = won.H >= need || won.V >= need;
  const last = match.sets[match.sets.length - 1];
  const name = (t) => (t === "H" ? h.home || "Home" : h.visitor || "Visitor");

  const addSet = () => {
    const n = match.sets.length + 1;
    const prev = match.sets[match.sets.length - 1];
    const deciding = n === (match.bestOf || 5);
    const s = newSet(n, {
      left: prev ? other(prev.left) : "V",
      firstServe: prev ? other(prev.firstServe) : "V",
      target: deciding ? match.decidingTarget || 15 : 25,
    });
    updateMatch(match.id, (m) => ({ ...m, sets: [...m.sets, s] }));
    setView({ name: "setup", matchId: match.id, setIdx: n - 1 });
  };

  return (
    <>
      <button style={btn(C.card2, C.dim, { padding: "7px 10px", fontSize: 13, marginBottom: 12 })} onClick={() => setView({ name: "home" })}>
        ‹ All matches
      </button>
      <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>
        {h.visitor || "Visitor"} at {h.home || "Home"}
      </h2>

      {match.sets.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {match.sets.map((s, i) => {
            const st = replay(s, match.sets.slice(0, i));
            const status = s.ended ? "Final" : s.startTime ? "In progress" : "Setting up";
            return (
              <button
                key={i}
                onClick={() => setView({ name: s.startTime ? "live" : "setup", matchId: match.id, setIdx: i })}
                style={{ ...btn(C.card), width: "100%", display: "flex", alignItems: "center", marginBottom: 8, textAlign: "left", padding: 12 }}
              >
                <span style={{ width: 54, color: C.dim }}>Set {s.number}</span>
                <span style={{ flex: 1 }}>
                  {name("H")} {st.score.H} – {st.score.V} {name("V")}
                </span>
                <span style={{ fontSize: 12, color: s.ended ? C.green : C.gold }}>{status}</span>
              </button>
            );
          })}
          <div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
            Sets won: {name("H")} {won.H} – {won.V} {name("V")}
            {decided && <b style={{ color: C.green }}> · Match over</b>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        {(!last || last.ended) && !decided && (
          <button style={btn(C.accent, "#1a0a0f", { flex: 1, padding: 14 })} onClick={addSet}>
            Set up set {match.sets.length + 1}
          </button>
        )}
        {last && !last.ended && (
          <button style={btn(C.accent, "#1a0a0f", { flex: 1, padding: 14 })} onClick={() => setView({ name: last.startTime ? "live" : "setup", matchId: match.id, setIdx: match.sets.length - 1 })}>
            {last.startTime ? `Back to set ${last.number}` : `Continue setting up set ${last.number}`}
          </button>
        )}
        {match.sets.some((s) => s.startTime) && (
          <button style={btn(C.card2, C.text, { flex: 1, padding: 14 })} onClick={onExport} disabled={exporting}>
            {exporting ? "Making PDF…" : "Save score sheets (PDF)"}
          </button>
        )}
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Header</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {[
            ["date", "Date", "date"],
            ["home", "Home team"],
            ["visitor", "Visitor"],
            ["site", "Site"],
            ["r1", "R1 (first referee)"],
            ["r2", "R2 (second referee)"],
            ["scorer", "Scorekeeper"],
          ].map(([k, l, type]) => (
            <label key={k}>
              <span style={label}>{l}</span>
              <input style={input} type={type || "text"} value={h[k] || ""} onChange={(e) => setH(k, e.target.value)} />
            </label>
          ))}
          <label>
            <span style={label}>Level</span>
            <select
              style={input}
              value={h.level}
              onChange={(e) => {
                const level = e.target.value;
                updateMatch(match.id, (m) => ({ ...m, header: { ...m.header, level }, ...(m.sets.length ? {} : LEVEL_FORMAT[level]) }));
              }}
            >
              {Object.keys(LEVEL_FORMAT).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            <span style={label}>Boys / Girls</span>
            <select style={input} value={h.gender} onChange={(e) => setH("gender", e.target.value)}>
              <option>Girls</option>
              <option>Boys</option>
            </select>
          </label>
          <label>
            <span style={label}>Format</span>
            <select
              style={input}
              value={`${match.bestOf}-${match.decidingTarget}`}
              onChange={(e) => {
                const [b, t] = e.target.value.split("-").map(Number);
                updateMatch(match.id, (m) => ({ ...m, bestOf: b, decidingTarget: t }));
              }}
            >
              <option value="5-15">Best of 5, 5th set to 15</option>
              <option value="3-25">Best of 3, 3rd set to 25</option>
              <option value="3-15">Best of 3, 3rd set to 15</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: C.dim, gridColumn: "1 / -1" }}>
            <input
              type="checkbox"
              checked={match.switchAt8 !== false}
              onChange={(e) => updateMatch(match.id, (m) => ({ ...m, switchAt8: e.target.checked }))}
            />
            Deciding set to 15: teams switch sides at 8 (MIAA)
          </label>
        </div>
      </div>
    </>
  );
}

// ── set setup: sides, first serve, lineups ──────────────────────────────────
function SetupScreen({ match, idx, updateMatch, setView }) {
  const set = match.sets[idx];
  if (!set) return null;
  const prev = match.sets[idx - 1];
  const name = (t) => (t === "H" ? match.header.home || "Home" : match.header.visitor || "Visitor");
  const patch = (fn) => updateMatch(match.id, (m) => ({ ...m, sets: m.sets.map((s, i) => (i === idx ? fn(s) : s)) }));
  const setTeam = (t, fn) => patch((s) => ({ ...s, teams: { ...s.teams, [t]: fn(s.teams[t]) } }));
  const problems = ["H", "V"].flatMap((t) => lineupProblems(set.teams[t], `${name(t)}: `));
  const incomplete = ["H", "V"].some((t) => set.teams[t].lineup.some((n) => !num(n)));
  const vbLineup =
    match.vb && (match.vb.lineups.find((l) => l.set === set.number) || match.vb.lineups[0]);

  const start = () => {
    patch((s) => ({ ...s, startTime: Date.now() }));
    setView({ name: "live", matchId: match.id, setIdx: idx });
  };

  const teamCard = (t) => {
    const team = set.teams[t];
    return (
      <div key={t} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, flex: "1 1 300px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ fontWeight: 800, flex: 1 }}>
            {name(t)}
            <span style={{ color: C.dim, fontWeight: 500, fontSize: 12 }}> · {set.left === t ? "left" : "right"} side{set.firstServe === t ? " · serves first" : ""}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {vbLineup && match.vb.side === t && (
            <button
              style={btn(C.accentSoft, C.accent, { padding: "7px 10px", fontSize: 12, borderColor: C.accent })}
              onClick={() => setTeam(t, (x) => ({ ...x, lineup: vbLineup.order.slice(), libero: vbLineup.libero || "", noLibero: !vbLineup.libero, captain: vbLineup.captain || "" }))}
            >
              Fill from Volley Bandit
            </button>
          )}
          {prev && (
            <button style={btn(C.card2, C.text, { padding: "7px 10px", fontSize: 12 })} onClick={() => setTeam(t, () => JSON.parse(JSON.stringify(prev.teams[t])))}>
              Copy set {prev.number}
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>Serving order from the coach's lineup sheet. Tap c for the playing captain.</div>
        {team.lineup.map((n, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 30, fontWeight: 800, fontFamily: "Georgia, serif", color: C.dim }}>{ROMAN[i]}</span>
            <input
              style={{ ...input, flex: 1 }}
              inputMode="numeric"
              value={n}
              placeholder="#"
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
                setTeam(t, (x) => ({ ...x, lineup: x.lineup.map((y, k) => (k === i ? v : y)) }));
              }}
            />
            <button
              onClick={() => setTeam(t, (x) => ({ ...x, captain: num(n) && x.captain !== num(n) ? num(n) : "" }))}
              style={btn(team.captain && team.captain === num(n) ? C.accent : C.card2, team.captain && team.captain === num(n) ? "#1a0a0f" : C.dim, { padding: "8px 12px" })}
            >
              c
            </button>
          </div>
        ))}
        {[
          ["libero", "L1", "Libero #"],
          ["libero2", "L2", "Second libero (optional)"],
        ].map(([key, tag, ph]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: key === "libero" ? 10 : 6 }}>
            <span style={{ width: 30, fontSize: 11, color: C.dim, fontWeight: 700 }}>{tag}</span>
            <input
              style={{ ...input, flex: 1, opacity: team.noLibero ? 0.4 : 1 }}
              inputMode="numeric"
              value={team[key] || ""}
              placeholder={ph}
              disabled={team.noLibero}
              onChange={(e) => setTeam(t, (x) => ({ ...x, [key]: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) }))}
            />
            <button
              onClick={() => setTeam(t, (x) => ({ ...x, captain: num(x[key]) && x.captain !== num(x[key]) ? num(x[key]) : "" }))}
              style={btn(team.captain && team.captain === num(team[key]) ? C.accent : C.card2, team.captain && team.captain === num(team[key]) ? "#1a0a0f" : C.dim, { padding: "8px 12px" })}
            >
              c
            </button>
          </div>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 13, color: C.dim }}>
          <input type="checkbox" checked={team.noLibero} onChange={(e) => setTeam(t, (x) => ({ ...x, noLibero: e.target.checked, libero: e.target.checked ? "" : x.libero, libero2: e.target.checked ? "" : x.libero2 }))} />
          Coach marked X — not playing with a libero this set
        </label>
      </div>
    );
  };

  return (
    <>
      <button style={btn(C.card2, C.dim, { padding: "7px 10px", fontSize: 13, marginBottom: 12 })} onClick={() => setView({ name: "match", matchId: match.id })}>
        ‹ Match
      </button>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Set {set.number} — before the set</h2>
      <div style={{ color: C.dim, fontSize: 13, marginBottom: 14 }}>
        {set.number === 1 || set.number === match.bestOf
          ? "Coin toss: the R2 tells you who serves first and which side each team takes."
          : "Teams switch sides and first serve alternates — check with the R2."}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 14 }}>
        <div>
          <span style={label}>On the LEFT (as you face the court)</span>
          <Seg options={[["V", name("V")], ["H", name("H")]]} value={set.left} onChange={(v) => patch((s) => ({ ...s, left: v }))} />
        </div>
        <div>
          <span style={label}>Serves first</span>
          <Seg options={[[set.left, name(set.left)], [other(set.left), name(other(set.left))]]} value={set.firstServe} onChange={(v) => patch((s) => ({ ...s, firstServe: v }))} />
        </div>
        <div>
          <span style={label}>Set played to</span>
          <Seg options={[[25, "25"], [15, "15"]]} value={set.target} onChange={(v) => patch((s) => ({ ...s, target: v }))} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{[set.left, other(set.left)].map(teamCard)}</div>
      <Warnings list={problems} />
      <button disabled={incomplete} style={btn(incomplete ? C.card2 : C.accent, incomplete ? C.dim : "#1a0a0f", { width: "100%", padding: 15, fontSize: 16, marginTop: 6 })} onClick={start}>
        {incomplete ? "Enter all six for both teams" : problems.length ? "Start the set anyway" : "Start the set (first serve)"}
      </button>
      <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>Starting records the start time. Penalties before the set (late lineup, etc.) go in as comments once it's open, at 0 – 0.</div>
    </>
  );
}

// ── live scoring ────────────────────────────────────────────────────────────
function describe(ev, name) {
  switch (ev.type) {
    case "rally":
      return `Point ${name(ev.winner)}`;
    case "sub":
      return `${ev.exceptional ? "Exceptional sub" : "Sub"} ${name(ev.team)} ${ev.pairs.map((p) => `#${p.in} for #${p.out}`).join(", ")}`;
    case "timeout":
      return `Time-out ${name(ev.team)}`;
    case "reserve":
      return ev.lost ? "Second re-serve (loss of rally)" : "Re-serve";
    case "replay":
      return "Replay";
    case "liberoServe":
      return "Libero serving";
    case "libero":
      return ev.dir === "in" ? `Libero #${ev.libero} in for #${ev.player}` : ev.dir === "out" ? `#${ev.player} back for the libero` : `Libero exchange #${ev.libero}`;
    case "comment":
      return `${ev.code === "NOTE" ? ev.text || "Comment" : ev.code} ${name(ev.team)}`;
    default:
      return ev.type;
  }
}

function useWakeLock(on) {
  useEffect(() => {
    if (!on || !navigator.wakeLock?.request) return undefined;
    let lock = null;
    let dead = false;
    const get = () =>
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (dead) l.release().catch(() => {});
          else lock = l;
        })
        .catch(() => {});
    get();
    const onVis = () => document.visibilityState === "visible" && get();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [on]);
}

function LiveScreen({ match, idx, updateMatch, setView, onExport, exporting }) {
  const set = match.sets[idx];
  const prior = useMemo(() => match.sets.slice(0, idx), [match.sets, idx]);
  const st = useMemo(() => (set ? replay(set, prior) : null), [set, prior]);
  const [panel, setPanel] = useState(null);
  // What fills the screen: the scoring controls, or the live paper sheets
  // full size — for showing the officials what's actually on the record.
  const [mode, setMode] = useState("controls"); // "controls" | "score" | "libero"
  useWakeLock(!!set && !set.ended);
  if (!set || !st) return null;

  const name = (t) => (t === "H" ? match.header.home || "Home" : match.header.visitor || "Visitor");
  // Deciding set: from the first 8 the teams have switched sides, so the
  // screen swaps too (the paper score sheet doesn't — it's by team).
  const deciding = set.number === (match.bestOf || 5);
  const switchRule = deciding && set.target === 15 && match.switchAt8 !== false;
  const switched = sidesSwitch(match, set) && st.switchAt != null;
  const justSwitched = switched && st.switchAt === set.events.length - 1;
  const L = switched ? other(set.left) : set.left;
  const R = other(L);
  const patch = (fn) => updateMatch(match.id, (m) => ({ ...m, sets: m.sets.map((s, i) => (i === idx ? fn(s) : s)) }));
  const push = (ev) => patch((s) => ({ ...s, events: [...s.events, { ...ev, at: Date.now() }] }));
  const undo = () => patch((s) => ({ ...s, events: s.events.slice(0, -1) }));
  const last = set.events[set.events.length - 1];
  const s = st.serving;
  const liberosOf = (t) => (set.teams[t].noLibero ? [] : [st.liberos[t][st.liberos[t].length - 1], num(set.teams[t].libero2)].filter(Boolean));
  const hasLibero = (t) => liberosOf(t).length > 0;
  // A libero replacement records straight away when it's clean, and opens a
  // panel to confirm when the tracker should tell the R2 something first.
  const liberoAct = (ev) => {
    const w = liberoWarnings(st, ev.team, ev);
    if (w.length) setPanel({ kind: "liberoWarn", ev, warnings: w });
    else push(ev);
  };
  const over = !!st.setOver;
  const locked = set.ended;

  const endSet = () => {
    patch((x) => ({ ...x, ended: true, endTime: Date.now() }));
    setView({ name: "match", matchId: match.id });
  };

  const teamHead = (t) => {
    const chk = lineupCheck(st, t);
    const serving = s === t;
    return (
      <div style={{ flex: 1, minWidth: 0, background: serving ? C.accentSoft : C.card, border: `1px solid ${serving ? C.accent : C.line}`, borderRadius: 12, padding: "10px 10px 8px", textAlign: "center" }}>
        <div style={{ fontWeight: 800, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name(t)}</div>
        <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{st.score[t]}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: serving ? C.accent : C.dim, minHeight: 18 }}>
          {serving ? (st.liberoServing ? `Libero for #${chk.order[0]}` : `Serving #${chk.order[0]}`) : `Next #${chk.order[0]}`}{" "}
          <span style={{ fontFamily: "Georgia, serif" }}>({ROMAN[st.nextRow[t]]})</span>
        </div>
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>
          T/O {st.timeouts[t].length}/{TIMEOUT_LIMIT} · Subs {st.subs[t]}/{SUB_LIMIT}
        </div>
      </div>
    );
  };

  const small = { padding: "11px 6px", fontSize: 13 };
  const act = (labelText, onClick, opts = {}) => (
    <button disabled={opts.disabled} onClick={onClick} style={btn(opts.on ? C.accentSoft : C.card2, opts.disabled ? C.dim : opts.on ? C.accent : C.text, { ...small, borderColor: opts.on ? C.accent : C.line, opacity: opts.disabled ? 0.5 : 1 })}>
      {labelText}
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <button style={btn(C.card2, C.dim, { padding: "7px 10px", fontSize: 13 })} onClick={() => setView({ name: "match", matchId: match.id })}>
          ‹ Match
        </button>
        <div style={{ flex: 1, fontWeight: 800 }}>
          Set {set.number} <span style={{ color: C.dim, fontWeight: 500, fontSize: 13 }}>· to {set.target} · started {fmtTime(set.startTime)}</span>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <Seg options={[["controls", "Scoring"], ["score", "Score sheet"], ["libero", "Libero sheet"]]} value={mode} onChange={setMode} />
      </div>

      {mode !== "controls" ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", gap: 14, fontWeight: 800, fontSize: 16, marginBottom: 8 }}>
            <span>{name(L)} {st.score[L]}</span>
            <span style={{ color: C.dim }}>–</span>
            <span>{st.score[R]} {name(R)}</span>
          </div>
          {mode === "score" ? (
            <ScaledSheet match={match} set={set} st={st} />
          ) : (
            <ScaledSheet pageWidth={TRACK_W}>
              <TrackerSheet match={match} />
            </ScaledSheet>
          )}
        </>
      ) : (
      <>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {teamHead(L)}
        {teamHead(R)}
      </div>
      {switchRule && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: C.dim, marginBottom: 10 }}>
          <input type="checkbox" checked={!!set.noSwitch} onChange={(e) => patch((x) => ({ ...x, noSwitch: e.target.checked }))} />
          Teams did not switch sides at 8 this set
        </label>
      )}

      {locked ? (
        <div style={{ background: C.card, border: `1px solid ${C.green}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, color: C.green }}>Set {set.number} final — ended {fmtTime(set.endTime)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btn(C.card2, C.text, { flex: 1 })} onClick={onExport} disabled={exporting}>
              {exporting ? "Making PDF…" : "Save score sheets (PDF)"}
            </button>
            <ConfirmButton style={btn(C.card2, C.dim)} armedLabel="Reopen it?" onConfirm={() => patch((x) => ({ ...x, ended: false, endTime: null }))}>
              Reopen set
            </ConfirmButton>
          </div>
        </div>
      ) : over ? (
        <div style={{ background: C.card, border: `1px solid ${C.green}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, color: C.green, marginBottom: 8 }}>
            Set point won — {name(st.setOver)} {st.score[st.setOver]} – {st.score[other(st.setOver)]}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(C.green, "#06180d", { flex: 1, padding: 14 })} onClick={endSet}>
              End set {set.number} (records end time)
            </button>
            <button style={btn()} onClick={undo}>
              Undo last
            </button>
          </div>
        </div>
      ) : (
        <>
          {justSwitched && (
            <div style={{ background: C.goldSoft, border: `1px solid ${C.gold}`, borderRadius: 12, padding: 10, marginBottom: 8, fontWeight: 800, color: C.gold, textAlign: "center" }}>
              8 points — teams switch sides. The screen has switched with them.
              <button style={btn(C.card2, C.text, { width: "100%", marginTop: 8, fontSize: 13 })} onClick={() => patch((x) => ({ ...x, noSwitch: true }))}>
                The teams did NOT switch
              </button>
            </div>
          )}
          {st.libPrompts.map((p, i) => (
            <div key={i} style={{ background: C.goldSoft, border: `1px solid ${C.gold}`, borderRadius: 12, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: C.gold, fontWeight: 700, marginBottom: 8 }}>
                {name(p.team)}: {p.text}
              </div>
              <button style={btn(C.gold, "#1a1406", { width: "100%" })} onClick={() => push({ type: "libero", team: p.team, dir: "out", player: currentNumber(st, p.team, st.lib[p.team].row) })}>
                Record #{currentNumber(st, p.team, st.lib[p.team].row)} back in for the libero
              </button>
            </div>
          ))}
          <div style={{ fontSize: 11, color: C.dim, textAlign: "center", marginBottom: 4 }}>RALLY WON BY</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            {[L, R].map((t) => (
              <button key={t} onClick={() => push({ type: "rally", winner: t })} style={btn(t === s ? C.accent : C.blue, "#0b0f14", { flex: 1, padding: "22px 8px", fontSize: 18, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })}>
                {name(t)}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 6 }}>
            {act(`Sub ${name(L).slice(0, 10)}`, () => setPanel({ kind: "sub", team: L }))}
            {act(`Sub ${name(R).slice(0, 10)}`, () => setPanel({ kind: "sub", team: R }))}
            {act(`T/O ${name(L).slice(0, 10)}`, () => (st.timeouts[L].length >= TIMEOUT_LIMIT ? setPanel({ kind: "timeout", team: L }) : push({ type: "timeout", team: L })))}
            {act(`T/O ${name(R).slice(0, 10)}`, () => (st.timeouts[R].length >= TIMEOUT_LIMIT ? setPanel({ kind: "timeout", team: R }) : push({ type: "timeout", team: R })))}
            {act("Re-serve", () => (st.reservesThisTerm >= 1 ? setPanel({ kind: "reserve" }) : push({ type: "reserve" })))}
            {act("Replay", () => push({ type: "replay" }))}
            {act(st.liberoServing ? "Libero serving ✓" : "Libero serves", () => push({ type: "liberoServe" }), { disabled: st.liberoServing || !hasLibero(s), on: st.liberoServing })}
            {act("Card / comment", () => setPanel({ kind: "comment", team: L }))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
            {[L, R].map((t) => {
              const on = st.lib[t];
              if (!hasLibero(t)) return <div key={t} style={{ fontSize: 11, color: C.dim, textAlign: "center", alignSelf: "center" }}>{name(t).slice(0, 14)}: no libero</div>;
              if (!on) return <React.Fragment key={t}>{act(`Libero in · ${name(t).slice(0, 10)}`, () => setPanel({ kind: "liberoIn", team: t }))}</React.Fragment>;
              const back = currentNumber(st, t, on.row);
              const other2 = liberosOf(t).find((x) => x !== on.libero);
              return (
                <div key={t} style={{ display: "flex", gap: 4 }}>
                  <button style={btn(C.accentSoft, C.accent, { flex: 1, padding: "9px 4px", fontSize: 12, borderColor: C.accent })} onClick={() => liberoAct({ type: "libero", team: t, dir: "out", player: back })}>
                    L{on.libero} out · #{back} in
                  </button>
                  {other2 && (
                    <button style={btn(C.card2, C.text, { padding: "9px 6px", fontSize: 12 })} onClick={() => push({ type: "libero", team: t, dir: "swap", libero: other2 })} title={`Libero exchange: #${other2} for #${on.libero}`}>
                      ⇄{other2}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button style={btn(C.card2, C.text, { flex: 1, ...small })} onClick={() => setPanel({ kind: "check" })}>
          Lineup check
        </button>
        <button disabled={!last || locked} style={btn(C.card2, last && !locked ? C.text : C.dim, { flex: 2, ...small, opacity: last && !locked ? 1 : 0.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })} onClick={undo}>
          ↶ Undo{last ? `: ${describe(last, name)}` : ""}
        </button>
      </div>

      <ScaledSheet match={match} set={set} st={st} />
      </>
      )}

      {panel?.kind === "liberoIn" && (
        <LiberoInPanel st={st} team={panel.team} liberos={liberosOf(panel.team)} name={name} onClose={() => setPanel(null)} onRecord={(ev) => { push(ev); setPanel(null); }} />
      )}
      {panel?.kind === "liberoWarn" && (
        <Panel title="Libero replacement" onClose={() => setPanel(null)}>
          <Warnings list={panel.warnings} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(C.card2, C.text, { flex: 1 })} onClick={() => setPanel(null)}>
              Don't record
            </button>
            <button style={btn(C.card2, C.gold)} onClick={() => { push(panel.ev); setPanel(null); }}>
              Record anyway
            </button>
          </div>
        </Panel>
      )}

      {panel?.kind === "sub" && <SubPanel st={st} team={panel.team} name={name} onClose={() => setPanel(null)} onRecord={(ev) => { push(ev); setPanel(null); }} />}
      {panel?.kind === "comment" && <CommentPanel match={match} idx={idx} st={st} first={panel.team} L={L} name={name} onClose={() => setPanel(null)} onRecord={(ev) => { push(ev); setPanel(null); }} />}
      {panel?.kind === "timeout" && (
        <Panel title={`Third time-out — ${name(panel.team)}`} onClose={() => setPanel(null)}>
          <Warnings tone="red" list={[`${name(panel.team)} has already used both time-outs (${st.timeouts[panel.team].join(", ")}). Alert the R2 — a third request isn't granted.`]} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(C.card2, C.text, { flex: 1 })} onClick={() => setPanel(null)}>
              Don't record
            </button>
            <button style={btn(C.card2, C.gold)} onClick={() => { push({ type: "timeout", team: panel.team }); setPanel(null); }}>
              Record anyway
            </button>
          </div>
        </Panel>
      )}
      {panel?.kind === "reserve" && (
        <Panel title="Second re-serve this term" onClose={() => setPanel(null)}>
          <div style={{ fontSize: 14, marginBottom: 12, lineHeight: 1.4 }}>
            A server gets one re-serve per term of service. A second one is an illegal hit — loss of rally, point to {name(other(s))}. Check with the R2 what to record.
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <button style={btn(C.accent, "#1a0a0f")} onClick={() => { push({ type: "reserve", lost: true }); setPanel(null); }}>
              RS and loss of rally (point {name(other(s))})
            </button>
            <button style={btn()} onClick={() => { push({ type: "reserve" }); setPanel(null); }}>
              Just record RS
            </button>
          </div>
        </Panel>
      )}
      {panel?.kind === "check" && (
        <Panel title="Lineup check" onClose={() => setPanel(null)}>
          {[L, R].map((t) => {
            const chk = lineupCheck(st, t);
            return (
              <div key={t} style={{ background: C.bg, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>
                  {name(t)} <span style={{ color: C.dim, fontWeight: 500 }}>· {s === t ? "serving" : "receiving"}</span>
                </div>
                <div style={{ fontSize: 15, lineHeight: 1.5 }}>
                  "{chk.lead} is <b>#{chk.order[0]}</b>, followed by {chk.order.slice(1).map((n) => `#${n}`).join(", ")}."
                </div>
                <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>
                  Libero: {set.teams[t].noLibero ? "none" : liberosOf(t).length ? liberosOf(t).map((x) => `#${x}`).join(" / ") : "not listed"}
                  {st.lib[t] && ` — #${st.lib[t].libero} on court for #${currentNumber(st, t, st.lib[t].row)} (${ROMAN[st.lib[t].row]})`}
                </div>
              </div>
            );
          })}
        </Panel>
      )}
    </>
  );
}

function SubPanel({ st, team, name, onClose, onRecord }) {
  const court = st.rows[team].map((r) => r.numbers[r.numbers.length - 1]);
  const [pairs, setPairs] = useState([{ in: "", out: "" }]);
  const [exceptional, setExceptional] = useState(false);
  const [active, setActive] = useState(0);
  const ready = pairs.filter((p) => num(p.in) && num(p.out));
  const warnings = subWarnings(st, team, ready, { exceptional });
  const setPair = (i, k, v) => setPairs((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const taken = new Set(pairs.map((p) => p.out));
  return (
    <Panel title={`Substitution — ${name(team)}`} onClose={onClose}>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>
        Written in the current server's row as {st.serving === team ? "S" : "Sx"} in/out. {st.subs[team]} of {SUB_LIMIT} used.
      </div>
      {pairs.map((p, i) => (
        <div key={i} onClick={() => setActive(i)} style={{ background: C.bg, border: `1px solid ${active === i ? C.accent : C.line}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
          <span style={label}>Leaving the court</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6, marginBottom: 10 }}>
            {court.map((n, k) => (
              <button
                key={k}
                disabled={taken.has(n) && p.out !== n}
                onClick={() => setPair(i, "out", n)}
                style={btn(p.out === n ? C.accent : C.card2, p.out === n ? "#1a0a0f" : C.text, { padding: "10px 0", opacity: taken.has(n) && p.out !== n ? 0.35 : 1 })}
              >
                <div style={{ fontSize: 9, fontFamily: "Georgia, serif", opacity: 0.7 }}>{ROMAN[k]}</div>#{n}
              </button>
            ))}
          </div>
          <span style={label}>Entering</span>
          <input
            style={input}
            inputMode="numeric"
            placeholder="Jersey #"
            value={p.in}
            onChange={(e) => setPair(i, "in", e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          />
        </div>
      ))}
      <button style={btn(C.card2, C.dim, { width: "100%", marginBottom: 8, fontSize: 13 })} onClick={() => { setPairs((ps) => [...ps, { in: "", out: "" }]); setActive(pairs.length); }}>
        + Another pair in the same dead ball
      </button>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: C.dim, marginBottom: 4 }}>
        <input type="checkbox" checked={exceptional} onChange={(e) => setExceptional(e.target.checked)} />
        <span>
          Exceptional substitution — injured/ill player and no legal sub. Adds <b>ES #{ready[0]?.out || "…"}</b> to comments; that player can't come back this set.
        </span>
      </label>
      <Warnings list={warnings} />
      <button disabled={!ready.length} style={btn(ready.length ? (warnings.length ? C.gold : C.accent) : C.card2, ready.length ? "#1a0a0f" : C.dim, { width: "100%", padding: 14, marginTop: 6 })} onClick={() => onRecord({ type: "sub", team, pairs: ready, exceptional })}>
        {warnings.length ? "Record anyway (tell the R2)" : `Record substitution${ready.length > 1 ? "s" : ""}`}
      </button>
    </Panel>
  );
}

function LiberoInPanel({ st, team, liberos, name, onClose, onRecord }) {
  const back = backRowRows(st, team);
  const [player, setPlayer] = useState("");
  const [libero, setLibero] = useState(liberos[0] || "");
  const ev = { type: "libero", team, dir: "in", player, libero };
  const warnings = player ? liberoWarnings(st, team, ev) : [];
  return (
    <Panel title={`Libero in — ${name(team)}`} onClose={onClose}>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>
        Not a substitution — it doesn't count toward the 18. On the tracking sheet the player is crossed out and an L written in.
      </div>
      {liberos.length > 1 && (
        <>
          <span style={label}>Which libero</span>
          <Seg options={liberos.map((l, i) => [l, `L${i + 1} #${l}`])} value={libero} onChange={setLibero} />
        </>
      )}
      <span style={{ ...label, marginTop: 10 }}>Replacing (back row)</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {back.map((r) => {
          const n = currentNumber(st, team, r);
          return (
            <button key={r} onClick={() => setPlayer(n)} style={btn(player === n ? C.accent : C.card2, player === n ? "#1a0a0f" : C.text, { padding: "12px 0" })}>
              <div style={{ fontSize: 9, fontFamily: "Georgia, serif", opacity: 0.7 }}>{ROMAN[r]}</div>#{n}
            </button>
          );
        })}
      </div>
      <Warnings list={warnings} />
      <button
        disabled={!player || !libero}
        style={btn(player ? (warnings.length ? C.gold : C.accent) : C.card2, player ? "#1a0a0f" : C.dim, { width: "100%", padding: 14, marginTop: 10 })}
        onClick={() => onRecord(ev)}
      >
        {warnings.length ? "Record anyway (tell the R2)" : player ? `Libero #${libero} in for #${player}` : "Pick the player she replaces"}
      </button>
    </Panel>
  );
}

const NOTE_PRESETS = [
  { text: "Late lineup", point: true },
  { text: "Late roster", point: true },
  { text: "Inaccurate roster", point: true },
  { text: "Charged sub for illegal lineup", chargeSub: true },
];

function CommentPanel({ match, idx, st, first, L, name, onClose, onRecord }) {
  const [team, setTeam] = useState(first);
  const [code, setCode] = useState("YUD");
  const [member, setMember] = useState("");
  const [newLibero, setNewLibero] = useState("");
  const [text, setText] = useState("");
  const [point, setPoint] = useState(false);
  const [chargeSub, setChargeSub] = useState(false);
  const def = COMMENT_CODES[code];
  const awards = def.point || (code === "NOTE" && point);
  // Earlier delay sanctions for this team in the match — the R1 decides
  // warning or penalty, but the scorer should know what's already on record.
  const priorDelays = [];
  match.sets.slice(0, idx + 1).forEach((s, i) => {
    const r = i === idx ? st : replay(s, match.sets.slice(0, i));
    r.comments[team].forEach((c) => {
      if ((c.code === "YUD" || c.code === "RUD") && !c.carried) priorDelays.push(`${c.text}${i === idx ? "" : `, Set ${s.number}`}`);
    });
  });
  const curLib = st.liberos[team][st.liberos[team].length - 1] || "";
  const needMember = def.member;
  const ok = (!needMember || num(member) || /^(C|AC)$/i.test(member)) && (code !== "RL" || num(newLibero)) && (code !== "NOTE" || text.trim());
  const preview =
    code === "NOTE"
      ? `${text || "…"} (${st.score[team]} - ${st.score[other(team)]})`
      : `${code}${member ? ` ${/^(C|AC)$/i.test(member) ? member.toUpperCase() : `#${num(member)}`}` : ""} (${st.score[team]} - ${st.score[other(team)]})`;
  return (
    <Panel title="Card / comment" onClose={onClose}>
      <span style={label}>Team at fault (or referred to)</span>
      <Seg options={[[L, name(L)], [other(L), name(other(L))]]} value={team} onChange={(v) => { setTeam(v); if (code === "RL") setMember(""); }} />
      <span style={{ ...label, marginTop: 12 }}>What happened</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
        {Object.entries(COMMENT_CODES).map(([k, d]) => (
          <button
            key={k}
            onClick={() => {
              setCode(k);
              if (k === "RL") setMember(curLib);
            }}
            style={btn(code === k ? C.accentSoft : C.card2, code === k ? C.accent : C.text, { borderColor: code === k ? C.accent : C.line, textAlign: "left", padding: "8px 10px", fontSize: 12 })}
          >
            <b>{k === "NOTE" ? "Note" : k}</b> <span style={{ fontWeight: 500, color: C.dim }}>{d.label}</span>
          </button>
        ))}
      </div>
      {(code === "YUD" || code === "RUD") && priorDelays.length > 0 && (
        <div style={{ fontSize: 12, color: C.gold, marginTop: 8 }}>Already on record for {name(team)}: {priorDelays.join("; ")}</div>
      )}
      {needMember && (
        <div style={{ marginTop: 12 }}>
          <span style={label}>{code === "RL" ? "Libero being replaced" : "Who — jersey #, or C / AC for coach"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input style={{ ...input, flex: 1 }} value={member} onChange={(e) => setMember(e.target.value.replace(/[^0-9A-Za-z]/g, "").slice(0, 3))} placeholder="#" />
            {code !== "RL" &&
              ["C", "AC"].map((x) => (
                <button key={x} style={btn(member === x ? C.accent : C.card2, member === x ? "#1a0a0f" : C.text)} onClick={() => setMember(x)}>
                  {x}
                </button>
              ))}
          </div>
        </div>
      )}
      {code === "RL" && (
        <div style={{ marginTop: 10 }}>
          <span style={label}>New libero</span>
          <input style={input} inputMode="numeric" value={newLibero} onChange={(e) => setNewLibero(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} placeholder="#" />
        </div>
      )}
      {code === "NOTE" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {NOTE_PRESETS.map((p) => (
              <button
                key={p.text}
                style={btn(C.card2, C.text, { padding: "7px 10px", fontSize: 12 })}
                onClick={() => {
                  setText(p.text);
                  setPoint(!!p.point);
                  setChargeSub(!!p.chargeSub);
                }}
              >
                {p.text}
              </button>
            ))}
          </div>
          <input style={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment text" />
          <label style={{ display: "flex", gap: 8, fontSize: 13, color: C.dim, marginTop: 8 }}>
            <input type="checkbox" checked={point} onChange={(e) => setPoint(e.target.checked)} /> Awards a penalty point to {name(other(team))}
          </label>
          <label style={{ display: "flex", gap: 8, fontSize: 13, color: C.dim, marginTop: 6 }}>
            <input type="checkbox" checked={chargeSub} onChange={(e) => setChargeSub(e.target.checked)} /> Charged substitution (counts toward the 18)
          </label>
        </div>
      )}
      <div style={{ background: C.bg, borderRadius: 10, padding: 10, marginTop: 12, fontSize: 14 }}>
        <span style={{ color: C.dim, fontSize: 12 }}>Writes in {name(team)}'s comments: </span>
        <b>{preview}</b>
        {awards && <div style={{ color: C.gold, fontSize: 13, marginTop: 4 }}>and a penalty point (circled) to {name(other(team))}</div>}
        {def.carries && <div style={{ color: C.dim, fontSize: 12, marginTop: 4 }}>Carried onto every later set's sheet.</div>}
      </div>
      <button
        disabled={!ok}
        style={btn(ok ? C.accent : C.card2, ok ? "#1a0a0f" : C.dim, { width: "100%", padding: 14, marginTop: 10 })}
        onClick={() => onRecord({ type: "comment", team, code, member, newLibero, text: text.trim(), point: code === "NOTE" ? point : undefined, chargeSub: code === "NOTE" ? chargeSub : undefined })}
      >
        Record
      </button>
    </Panel>
  );
}

// ── crash screen ────────────────────────────────────────────────────────────
// Scores are saved on every tap, so reloading loses nothing — say so.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, padding: 20, fontFamily: FONT }}>
        <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
        <p style={{ color: C.dim }}>Every tap is saved on this device, so reloading won't lose the match.</p>
        <pre style={{ whiteSpace: "pre-wrap", color: C.dim, fontSize: 13 }}>{String(this.state.error?.message || this.state.error)}</pre>
        <div style={{ color: C.dim, fontSize: 12 }}>v{APP_VERSION}</div>
        <button onClick={() => window.location.reload()} style={{ marginTop: 14, padding: "12px 16px", borderRadius: 10, border: "none", background: C.accent, color: "#1a0a0f", fontWeight: 700 }}>
          Reload
        </button>
      </div>
    );
  }
}
