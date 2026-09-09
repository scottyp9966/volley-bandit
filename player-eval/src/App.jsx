import React, { useState, useMemo, useEffect, useRef } from "react";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { Users, ClipboardList, TrendingUp, Wand2, Plus, Trash2, X, ChevronRight, Pencil } from "lucide-react";

// ---- Shared team-code data model -------------------------------------
//
// Player Eval intentionally reuses the SAME Firestore "teams/{code}/data/*"
// layout as the companion Volley Bandit (lineup) app, so the two can work as
// standalone apps or as add-ons to each other, per the coach's choice:
//   - teams/{code}/data/main   -> Volley Bandit's doc. We only ever touch
//     its `roster` field, and always with `merge: true`, so we never
//     overwrite lineups/matches/score/etc. that Volley Bandit owns there.
//   - teams/{code}/data/playerEval -> this app's own doc (evaluations),
//     which Volley Bandit never reads or writes.
// A coach already using Volley Bandit just enters the same team code here
// and their roster shows up immediately — no re-entry, no screenshot
// import needed. A coach using Player Eval on its own can create a fresh
// team code and manage a roster right here.

const POSITIONS = [
  { value: "S", label: "Setter" },
  { value: "OH", label: "Outside Hitter" },
  { value: "MB", label: "Middle Blocker" },
  { value: "OPP", label: "Opposite" },
  { value: "L", label: "Libero" },
  { value: "DS", label: "Defensive Specialist" },
];

const SKILLS = [
  { key: "serve", label: "Serve" },
  { key: "pass", label: "Pass" },
  { key: "hit", label: "Hit" },
  { key: "block", label: "Block" },
  { key: "defense", label: "Defense" },
];

const INTANGIBLES = [
  { key: "hustle", label: "Hustle" },
  { key: "attitude", label: "Attitude" },
  { key: "communication", label: "Communication" },
  { key: "coachability", label: "Coachability" },
];

const ALL_CATEGORIES = [...SKILLS, ...INTANGIBLES];

const TEAM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateTeamCode() {
  let code = "";
  for (let i = 0; i < 7; i++) {
    if (i === 3) code += "-";
    code += TEAM_CODE_CHARS[Math.floor(Math.random() * TEAM_CODE_CHARS.length)];
  }
  return code;
}

function usePersisted(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or unavailable — app keeps working in-memory for this session
    }
  }, [key, value]);
  return [value, setValue];
}

// Reads/writes only the `roster` field of Volley Bandit's shared "main" doc.
// `merge: true` on every write is what keeps this safe to share with a doc
// the lineup app also owns — it only ever touches the one field.
function useSharedRoster(teamCode) {
  const [roster, setRosterState] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;

  useEffect(() => {
    if (!teamCode) {
      setRosterState([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    const ref = doc(db, "teams", teamCode, "data", "main");
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setRosterState(snap.exists() ? snap.data().roster || [] : []);
        setLoaded(true);
        setError(null);
      },
      (err) => {
        console.warn("Roster sync error:", err);
        setLoaded(true);
        setError("Couldn't load the roster — check your connection.");
      }
    );
    return () => unsub();
  }, [teamCode]);

  const update = (updater) => {
    const next = typeof updater === "function" ? updater(rosterRef.current) : updater;
    rosterRef.current = next;
    setRosterState(next);
    if (teamCode) {
      const ref = doc(db, "teams", teamCode, "data", "main");
      setDoc(ref, { roster: next }, { merge: true }).catch((err) => {
        console.warn("Roster save error:", err);
        setError("Couldn't save that change to the roster — check your connection.");
      });
    }
  };

  return [roster, update, loaded, error];
}

// This app's own doc — exclusively owned by Player Eval, so a plain
// whole-document sync (same pattern the lineup app uses for its own docs).
function useEvaluations(teamCode) {
  const [evaluations, setEvaluationsState] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const evalRef = useRef(evaluations);
  evalRef.current = evaluations;

  useEffect(() => {
    if (!teamCode) {
      setEvaluationsState([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    const ref = doc(db, "teams", teamCode, "data", "playerEval");
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setEvaluationsState(snap.exists() ? snap.data().evaluations || [] : []);
        setLoaded(true);
        setError(null);
      },
      (err) => {
        console.warn("Evaluation sync error:", err);
        setLoaded(true);
        setError("Couldn't load evaluations — check your connection.");
      }
    );
    return () => unsub();
  }, [teamCode]);

  const update = (updater) => {
    const next = typeof updater === "function" ? updater(evalRef.current) : updater;
    evalRef.current = next;
    setEvaluationsState(next);
    if (teamCode) {
      const ref = doc(db, "teams", teamCode, "data", "playerEval");
      setDoc(ref, { evaluations: next }, { merge: true }).catch((err) => {
        console.warn("Evaluation save error:", err);
        setError("Couldn't save that evaluation — check your connection.");
      });
    }
  };

  return [evaluations, update, loaded, error];
}

function avgOf(obj) {
  const vals = Object.values(obj).filter((v) => typeof v === "number");
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function playerAverages(playerId, evaluations) {
  const evals = evaluations.filter((e) => e.playerId === playerId);
  if (!evals.length) return null;
  const sums = {};
  const counts = {};
  ALL_CATEGORIES.forEach((c) => {
    sums[c.key] = 0;
    counts[c.key] = 0;
  });
  evals.forEach((e) => {
    ALL_CATEGORIES.forEach((c) => {
      const v = e.ratings[c.key];
      if (typeof v === "number") {
        sums[c.key] += v;
        counts[c.key] += 1;
      }
    });
  });
  const avgs = {};
  ALL_CATEGORIES.forEach((c) => {
    avgs[c.key] = counts[c.key] ? sums[c.key] / counts[c.key] : null;
  });
  return { avgs, overall: avgOf(avgs), count: evals.length };
}

function displayName(p) {
  if (!p) return "";
  const last = (p.lastName || "").trim();
  return last ? `${p.firstName} ${last.charAt(0).toUpperCase()}.` : p.firstName || "";
}

function RatingRow({ label, value, onChange }) {
  const isNA = value === "NA";
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
          fontSize: 13,
          color: "#9aa3b2",
        }}
      >
        <span>{label}</span>
        <span style={{ color: value ? (isNA ? "#9aa3b2" : "#e8622c") : "#6b7383", fontWeight: 600 }}>
          {value ? (isNA ? "N/A" : value) : "–"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => onChange(n)}
            style={{
              flex: 1,
              height: 34,
              borderRadius: 6,
              border: value === n ? "1px solid #e8622c" : "1px solid #2c3542",
              background: value === n ? "#3a2013" : "#1a2029",
              color: value === n ? "#e8622c" : "#6b7383",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => onChange("NA")}
          style={{
            flex: 1.4,
            height: 34,
            borderRadius: 6,
            border: isNA ? "1px solid #9aa3b2" : "1px solid #2c3542",
            background: isNA ? "#232a35" : "#1a2029",
            color: isNA ? "#eef0f3" : "#6b7383",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          N/A
        </button>
      </div>
    </div>
  );
}

function PosTag({ pos, dashed }) {
  if (!pos) return null;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "#e8622c",
        border: `1px ${dashed ? "dashed" : "solid"} #e8622c`,
        borderRadius: 5,
        padding: "1px 6px",
        marginRight: 6,
      }}
    >
      {pos}
    </span>
  );
}

const inputStyle = {
  background: "#12161c",
  border: "1px solid #2c3542",
  borderRadius: 6,
  color: "#eef0f3",
  padding: "8px 10px",
  fontSize: 13,
};

const primaryBtn = {
  background: "#e8622c",
  border: "none",
  color: "#12161c",
  borderRadius: 8,
  padding: "9px 14px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const ghostBtn = {
  background: "none",
  border: "1px solid #2c3542",
  color: "#9aa3b2",
  borderRadius: 8,
  padding: "9px 10px",
  cursor: "pointer",
};

// ---- Team gate: create a fresh team code, or join one already in use
// (typically the same code the coach set up in Volley Bandit) --------------
function TeamGate({ onLinked }) {
  const [mode, setMode] = useState("choice"); // "choice" | "create" | "join"
  const [codeInput, setCodeInput] = useState(() => generateTeamCode());
  const [joinInput, setJoinInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [createError, setCreateError] = useState("");
  const [joinError, setJoinError] = useState("");

  const normalizeCode = (raw) => raw.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);

  const teamExists = async (code) => {
    const mainSnap = await getDoc(doc(db, "teams", code, "data", "main"));
    if (mainSnap.exists()) return true;
    const evalSnap = await getDoc(doc(db, "teams", code, "data", "playerEval"));
    return evalSnap.exists();
  };

  const checkAndCreate = async () => {
    const code = codeInput.trim();
    if (!code) return;
    setChecking(true);
    setCreateError("");
    try {
      if (await teamExists(code)) {
        setCreateError("That code's already in use — try a different one or join it instead.");
        setChecking(false);
        return;
      }
      onLinked(code);
    } catch {
      setCreateError("Couldn't check that code — check your connection and try again.");
      setChecking(false);
    }
  };

  const checkAndJoin = async () => {
    const code = joinInput.trim();
    if (!code) return;
    setChecking(true);
    setJoinError("");
    try {
      if (!(await teamExists(code))) {
        setJoinError("Couldn't find a team with that code.");
        setChecking(false);
        return;
      }
      onLinked(code);
    } catch {
      setJoinError("Couldn't check that code — check your connection and try again.");
      setChecking(false);
    }
  };

  const wrap = {
    minHeight: "100vh",
    background: "#0B0D10",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  };
  const card = { width: 300 };
  const title = {
    fontSize: 20,
    fontWeight: 700,
    color: "#eef0f3",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
    textAlign: "center",
  };
  const sub = { fontSize: 12, color: "#6b7383", textAlign: "center", marginBottom: 20, lineHeight: 1.5 };
  const bigBtn = {
    width: "100%",
    padding: "13px",
    marginBottom: 10,
    borderRadius: 8,
    border: "1.5px solid #e8622c",
    background: "rgba(232,98,44,0.12)",
    color: "#eef0f3",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  };
  const backBtn = {
    display: "block",
    margin: "16px auto 0",
    background: "none",
    border: "none",
    color: "#6b7383",
    fontSize: 12,
    cursor: "pointer",
  };

  if (mode === "choice") {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Player Eval</div>
          <div style={sub}>
            Uses the same team code as Volley Bandit, if you're already on that — your
            roster shows up automatically. Or start fresh here on its own.
          </div>
          <button style={bigBtn} onClick={() => setMode("join")}>Join a team code</button>
          <button style={bigBtn} onClick={() => setMode("create")}>Create new team code</button>
        </div>
      </div>
    );
  }

  if (mode === "join") {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Join team</div>
          <div style={sub}>Enter the team code from Volley Bandit (or one you created here before).</div>
          <input
            value={joinInput}
            onChange={(e) => setJoinInput(normalizeCode(e.target.value))}
            placeholder="e.g. GRF-4X29"
            style={{ ...inputStyle, width: "100%", marginBottom: 12, textAlign: "center", fontSize: 16, letterSpacing: 1 }}
          />
          {joinError && <div style={{ color: "#e2504f", fontSize: 12, marginBottom: 10 }}>{joinError}</div>}
          <button style={{ ...primaryBtn, width: "100%" }} disabled={checking} onClick={checkAndJoin}>
            {checking ? "Checking…" : "Join"}
          </button>
          <button style={backBtn} onClick={() => setMode("choice")}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={title}>Create team</div>
        <div style={sub}>
          This code is how every device finds the same data. Write it down — you'll need
          it to join from another device, or to use this same team in Volley Bandit later.
        </div>
        <input
          value={codeInput}
          onChange={(e) => setCodeInput(normalizeCode(e.target.value))}
          style={{ ...inputStyle, width: "100%", marginBottom: 12, textAlign: "center", fontSize: 16, letterSpacing: 1 }}
        />
        {createError && <div style={{ color: "#e2504f", fontSize: 12, marginBottom: 10 }}>{createError}</div>}
        <button style={{ ...primaryBtn, width: "100%" }} disabled={checking} onClick={checkAndCreate}>
          {checking ? "Checking…" : "Create & continue"}
        </button>
        <button style={backBtn} onClick={() => setMode("choice")}>Back</button>
      </div>
    </div>
  );
}

function PlayerForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(
    initial || { number: "", firstName: "", lastName: "", position: "OH", position2: "" }
  );
  return (
    <div style={{ background: "#1a2029", border: "1px solid #2c3542", borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          placeholder="#"
          value={form.number}
          onChange={(e) => setForm({ ...form, number: e.target.value.replace(/\D/g, "") })}
          style={{ width: 56, ...inputStyle }}
        />
        <input
          placeholder="First name"
          value={form.firstName}
          onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          style={{ flex: 1, ...inputStyle }}
        />
        <input
          placeholder="Last name"
          value={form.lastName}
          onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          style={{ flex: 1, ...inputStyle }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select
          value={form.position}
          onChange={(e) => setForm({ ...form, position: e.target.value })}
          style={{ flex: 1, ...inputStyle }}
        >
          {POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.value} (primary)</option>
          ))}
        </select>
        <select
          value={form.position2}
          onChange={(e) => setForm({ ...form, position2: e.target.value })}
          style={{ flex: 1, ...inputStyle }}
        >
          <option value="">No secondary</option>
          {POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.value} (secondary)</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => {
            if (!form.number || !form.firstName.trim()) return;
            onSave(form);
          }}
          style={primaryBtn}
        >
          Save player
        </button>
        <button onClick={onCancel} style={ghostBtn}><X size={14} /></button>
      </div>
    </div>
  );
}

function AppShell({ teamCode, onSwitchTeam }) {
  const [roster, updateRoster, rosterLoaded, rosterError] = useSharedRoster(teamCode);
  const [evaluations, updateEvaluations, evalLoaded, evalError] = useEvaluations(teamCode);

  const [tab, setTab] = useState("roster");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [evalPlayerId, setEvalPlayerId] = useState(null);
  const [draftRatings, setDraftRatings] = useState({});
  const [note, setNote] = useState("");
  const [recFilter, setRecFilter] = useState("OH");

  const sortedPlayers = useMemo(
    () => [...roster].sort((a, b) => Number(a.num) - Number(b.num)),
    [roster]
  );

  function removePlayer(id) {
    updateRoster((prev) => prev.filter((p) => p.id !== id));
  }

  function addPlayer(form) {
    updateRoster((prev) => [
      ...prev,
      {
        id: Date.now(),
        num: form.number,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        position: form.position,
        position2: form.position2 || "",
      },
    ]);
    setShowAdd(false);
  }

  function saveEdit(id, form) {
    updateRoster((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              num: form.number,
              firstName: form.firstName.trim(),
              lastName: form.lastName.trim(),
              position: form.position,
              position2: form.position2 || "",
            }
          : p
      )
    );
    setEditingId(null);
  }

  function startEval(playerId) {
    setEvalPlayerId(playerId);
    setDraftRatings({});
    setNote("");
  }

  function saveEval() {
    const missing = ALL_CATEGORIES.some((c) => !draftRatings[c.key]);
    if (missing) return;
    updateEvaluations((ev) => [
      ...ev,
      {
        id: "e" + Date.now(),
        playerId: evalPlayerId,
        date: new Date().toISOString(),
        ratings: { ...draftRatings },
        note,
      },
    ]);
    setEvalPlayerId(null);
  }

  const evalPlayer = roster.find((p) => p.id === evalPlayerId);
  const draftComplete = ALL_CATEGORIES.every((c) => draftRatings[c.key]);

  const trendData = useMemo(() => {
    return sortedPlayers
      .map((p) => ({ player: p, stats: playerAverages(p.id, evaluations) }))
      .filter((x) => x.stats)
      .sort((a, b) => b.stats.overall - a.stats.overall);
  }, [sortedPlayers, evaluations]);

  const recGroup = useMemo(() => {
    return sortedPlayers
      .filter((p) => p.position === recFilter || p.position2 === recFilter)
      .map((p) => ({ player: p, stats: playerAverages(p.id, evaluations) }))
      .sort((a, b) => (b.stats?.overall || 0) - (a.stats?.overall || 0));
  }, [sortedPlayers, evaluations, recFilter]);

  const loading = !rosterLoaded || !evalLoaded;

  return (
    <div
      style={{
        maxWidth: 420,
        margin: "0 auto",
        background: "#12161c",
        color: "#eef0f3",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        minHeight: "100vh",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid #232a35" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: "#1f3d2b",
                color: "#4fae6f",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              PE
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 0.2 }}>PLAYER EVAL</div>
              <div style={{ fontSize: 12, color: "#6b7383" }}>Team code: {teamCode}</div>
            </div>
          </div>
          <button onClick={onSwitchTeam} style={{ ...ghostBtn, fontSize: 11, padding: "6px 8px" }}>
            Switch
          </button>
        </div>
        {(rosterError || evalError) && (
          <div style={{ fontSize: 11, color: "#e2504f", marginTop: 10 }}>{rosterError || evalError}</div>
        )}
      </div>

      <div style={{ padding: 20, minHeight: 420 }}>
        {loading && <div style={{ fontSize: 13, color: "#6b7383" }}>Loading…</div>}

        {!loading && tab === "roster" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 13, color: "#6b7383" }}>
                {roster.length} players
                {roster.length > 0 && " · synced with Volley Bandit"}
              </div>
              <button
                onClick={() => {
                  setShowAdd(true);
                  setEditingId(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "#3a2013",
                  border: "1px solid #e8622c",
                  color: "#e8622c",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <Plus size={14} /> Add player
              </button>
            </div>

            {showAdd && (
              <PlayerForm onSave={addPlayer} onCancel={() => setShowAdd(false)} />
            )}

            {sortedPlayers.map((p) =>
              editingId === p.id ? (
                <PlayerForm
                  key={p.id}
                  initial={{ number: String(p.num), firstName: p.firstName, lastName: p.lastName, position: p.position, position2: p.position2 || "" }}
                  onSave={(form) => saveEdit(p.id, form)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    background: "#1a2029",
                    border: "1px solid #2c3542",
                    borderRadius: 10,
                    padding: "12px 14px",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, color: "#e8622c", fontWeight: 700 }}>#{p.num}</div>
                    <div style={{ fontSize: 15, fontWeight: 500, margin: "2px 0 4px" }}>
                      {p.firstName} {p.lastName}
                    </div>
                    <div>
                      <PosTag pos={p.position} />
                      {p.position2 && <PosTag pos={p.position2} dashed />}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={() => {
                        setEditingId(p.id);
                        setShowAdd(false);
                      }}
                      style={{ background: "none", border: "none", color: "#6b7383", cursor: "pointer", padding: 6 }}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => removePlayer(p.id)}
                      style={{ background: "none", border: "none", color: "#6b7383", cursor: "pointer", padding: 6 }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              )
            )}

            {roster.length === 0 && !showAdd && (
              <div style={{ fontSize: 13, color: "#6b7383" }}>
                No players yet. Add one above, or if this team code is also used in
                Volley Bandit, add players there and they'll show up here.
              </div>
            )}
          </div>
        )}

        {!loading && tab === "evaluate" && !evalPlayer && (
          <div>
            <div style={{ fontSize: 13, color: "#6b7383", marginBottom: 14 }}>
              Tap a player to enter a post-match evaluation
            </div>
            {sortedPlayers.map((p) => {
              const stats = playerAverages(p.id, evaluations);
              return (
                <button
                  key={p.id}
                  onClick={() => startEval(p.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    background: "#1a2029",
                    border: "1px solid #2c3542",
                    borderRadius: 10,
                    padding: "12px 14px",
                    marginBottom: 8,
                    cursor: "pointer",
                    color: "#eef0f3",
                  }}
                >
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontSize: 15, fontWeight: 500 }}>#{p.num} {displayName(p)}</div>
                    <div style={{ fontSize: 12, color: "#6b7383", marginTop: 2 }}>
                      {stats ? `${stats.count} eval${stats.count > 1 ? "s" : ""} · avg ${stats.overall.toFixed(1)}` : "No evaluations yet"}
                    </div>
                  </div>
                  <ChevronRight size={18} color="#6b7383" />
                </button>
              );
            })}
            {sortedPlayers.length === 0 && (
              <div style={{ fontSize: 13, color: "#6b7383" }}>Add players on the Roster tab first.</div>
            )}
          </div>
        )}

        {!loading && tab === "evaluate" && evalPlayer && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>#{evalPlayer.num} {displayName(evalPlayer)}</div>
                <div style={{ fontSize: 12, color: "#6b7383" }}>{new Date().toLocaleDateString()}</div>
              </div>
              <button onClick={() => setEvalPlayerId(null)} style={ghostBtn}><X size={14} /></button>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, color: "#e8622c", marginBottom: 10 }}>CORE SKILLS</div>
            {SKILLS.map((s) => (
              <RatingRow
                key={s.key}
                label={s.label}
                value={draftRatings[s.key]}
                onChange={(v) => setDraftRatings({ ...draftRatings, [s.key]: v })}
              />
            ))}

            <div style={{ fontSize: 12, fontWeight: 600, color: "#e8622c", margin: "14px 0 10px" }}>INTANGIBLES</div>
            {INTANGIBLES.map((s) => (
              <RatingRow
                key={s.key}
                label={s.label}
                value={draftRatings[s.key]}
                onChange={(v) => setDraftRatings({ ...draftRatings, [s.key]: v })}
              />
            ))}

            <textarea
              placeholder="Notes (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ ...inputStyle, width: "100%", height: 60, marginTop: 8, marginBottom: 14, resize: "none" }}
            />

            {!draftComplete && (
              <div style={{ fontSize: 12, color: "#e2504f", marginBottom: 8 }}>
                Rate every category before saving.
              </div>
            )}
            <button onClick={saveEval} style={{ ...primaryBtn, width: "100%", opacity: draftComplete ? 1 : 0.5 }}>
              Save evaluation
            </button>
          </div>
        )}

        {!loading && tab === "trends" && (
          <div>
            <div style={{ fontSize: 13, color: "#6b7383", marginBottom: 14 }}>
              Season averages, highest first
            </div>
            {trendData.length === 0 && (
              <div style={{ fontSize: 13, color: "#6b7383" }}>No evaluations logged yet.</div>
            )}
            {trendData.map(({ player, stats }) => (
              <div key={player.id} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span>#{player.num} {displayName(player)}</span>
                  <span style={{ color: "#e8622c", fontWeight: 600 }}>{stats.overall.toFixed(1)}</span>
                </div>
                <div style={{ background: "#1a2029", borderRadius: 6, height: 8, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${(stats.overall / 5) * 100}%`,
                      background: "#e8622c",
                      height: "100%",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === "recommend" && (
          <div>
            <div style={{ fontSize: 13, color: "#6b7383", marginBottom: 10 }}>
              Compare players by position
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
              {POSITIONS.map((pos) => (
                <button
                  key={pos.value}
                  onClick={() => setRecFilter(pos.value)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    border: recFilter === pos.value ? "1px solid #e8622c" : "1px solid #2c3542",
                    background: recFilter === pos.value ? "#3a2013" : "#1a2029",
                    color: recFilter === pos.value ? "#e8622c" : "#9aa3b2",
                    cursor: "pointer",
                  }}
                >
                  {pos.value}
                </button>
              ))}
            </div>

            {recGroup.length === 0 && (
              <div style={{ fontSize: 13, color: "#6b7383" }}>No players tagged for this position.</div>
            )}

            {recGroup.map(({ player, stats }, i) => (
              <div
                key={player.id}
                style={{
                  background: i === 0 && stats ? "#1f2a1f" : "#1a2029",
                  border: i === 0 && stats ? "1px solid #4fae6f" : "1px solid #2c3542",
                  borderRadius: 10,
                  padding: "12px 14px",
                  marginBottom: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 500 }}>
                      #{player.num} {displayName(player)}
                      {i === 0 && stats && (
                        <span style={{ fontSize: 11, color: "#4fae6f", marginLeft: 8, fontWeight: 600 }}>TOP RATED</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7383", marginTop: 2 }}>
                      {player.position === recFilter ? "Primary" : "Secondary"} · {player.position2 || "no backup listed"}
                    </div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: stats ? "#e8622c" : "#6b7383" }}>
                    {stats ? stats.overall.toFixed(1) : "–"}
                  </div>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "#6b7383", marginTop: 8 }}>
              Ranking is based on average rating across all logged evaluations for this position group. Add match evaluations to sharpen these picks.
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", borderTop: "1px solid #232a35" }}>
        {[
          { id: "roster", label: "Roster", icon: Users },
          { id: "evaluate", label: "Evaluate", icon: ClipboardList },
          { id: "trends", label: "Trends", icon: TrendingUp },
          { id: "recommend", label: "Recommend", icon: Wand2 },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              if (id !== "evaluate") setEvalPlayerId(null);
              setShowAdd(false);
              setEditingId(null);
            }}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              padding: "10px 0",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              color: tab === id ? "#e8622c" : "#6b7383",
              cursor: "pointer",
            }}
          >
            <Icon size={18} />
            <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PlayerEvalApp() {
  const [teamCode, setTeamCode] = usePersisted("pe-team-code", "");

  if (!teamCode) {
    return <TeamGate onLinked={setTeamCode} />;
  }

  return <AppShell teamCode={teamCode} onSwitchTeam={() => setTeamCode("")} />;
}
