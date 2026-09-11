import React, { useState, useMemo, useRef, useEffect } from "react";
import { Undo2, Plus, Minus, Check, X, Users, Activity, ClipboardList, Circle, Calendar, Copy, Trash2, ClipboardPaste, Pencil, ChevronsRight, LayoutGrid, Printer, Image as ImageIcon, HelpCircle, Settings as SettingsIcon, Repeat } from "lucide-react";
import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// ---- Design tokens ----
// Court charcoal / chalk / volleyball orange / court blue / kill green / error red
// ---- App passcode ----
// This is the ONE global password gating the whole app, the same for every
// device and every visitor — not something set per-device inside the app.
// To set, change, or reset it: edit the value below, then commit and push.
// Vercel redeploys automatically, and every device — including ones that
// were already unlocked with the old password — will be asked for the new
// one the next time they open the app. Leave it as "" to disable the lock
// entirely (the app opens with no passcode screen at all).
const APP_PASSCODE = "volley26";

// ---- Build version ----
// A quick way to confirm a device is actually running the latest code,
// rather than a stale cached build — shown at the bottom of Settings. Bumped
// with each shipped change; the date is what actually matters (compare it to
// "today" to know whether an update has really landed on that device yet).
const APP_VERSION = "2026.09.11-freesub";

// Two palettes, switched via a Settings toggle. COLORS itself stays a
// mutable object (not reassigned, just its properties updated in place) so
// every existing style in the app — which reads COLORS.xxx directly — picks
// up the new values automatically on the next render, without needing every
// single component rewritten to consume a theme prop or context.
const DARK_COLORS = {
  bg: "#1C2128",
  bgRaised: "#242A33",
  chalk: "#F5F3EE",
  chalkDim: "#A8ADB5",
  orange: "#FF6B35",
  blue: "#3E7CA6",
  green: "#4C9A63",
  red: "#C1443C",
  line: "#333B46",
  gold: "#FFC857",
};
const LIGHT_COLORS = {
  bg: "#E8E8E6",
  bgRaised: "#FFFFFF",
  chalk: "#12261A",
  chalkDim: "#42604C",
  orange: "#155C2E", // primary accent — key name kept as "orange" everywhere it's referenced, value repurposed to green for this theme
  blue: "#3E7CA6",
  green: "#4C9A63",
  red: "#C1443C",
  line: "#CBD1CA",
  gold: "#B8860B", // deepened from the dark theme's pale gold for contrast on a light background
};
let COLORS = { ...DARK_COLORS };


// Persist state to localStorage so nothing is lost when the tab closes or
// the phone loses signal — this is what makes the app actually offline-safe,
// not just offline-tolerant during a single session.
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

// Random Team Code — the "address" a team's whole dataset lives under in
// Firestore. Avoids visually similar characters (0/O, 1/I/L) since it has
// to be read off one screen and typed into another.
const TEAM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateTeamCode() {
  let code = "";
  for (let i = 0; i < 7; i++) {
    if (i === 3) code += "-";
    code += TEAM_CODE_CHARS[Math.floor(Math.random() * TEAM_CODE_CHARS.length)];
  }
  return code;
}

// Syncs one Firestore document (as a whole JS object) across every device
// linked to the same team code — this is what replaces per-device
// localStorage for anything that needs to be shared. Firestore's own
// offline cache (enabled in firebase.js) is what keeps this working with
// no signal: reads come from the local cache instantly, writes queue up
// and sync automatically once a connection is back.
function useTeamDoc(teamCode, docName, defaultValue) {
  const [value, setValue] = useState(defaultValue);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!teamCode) {
      setValue(defaultValue);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    const ref = doc(db, "teams", teamCode, "data", docName);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setValue(snap.exists() ? { ...defaultValue, ...snap.data() } : defaultValue);
        setLoaded(true);
        setError(null);
      },
      (err) => {
        console.warn(`Sync error on ${docName}:`, err);
        setLoaded(true);
        setError(`Couldn't load ${docName} — check your connection.`);
      }
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCode, docName]);

  const update = (updater) => {
    const next = typeof updater === "function" ? updater(valueRef.current) : updater;
    valueRef.current = next;
    setValue(next);
    if (teamCode) {
      const ref = doc(db, "teams", teamCode, "data", docName);
      setDoc(ref, next, { merge: false })
        .then(() => setError(null))
        .catch((err) => {
          console.warn(`Save error on ${docName}:`, err);
          setError(`Couldn't save your last change to ${docName} — check your connection.`);
        });
    }
  };

  return [value, update, loaded, error];
}

// Short display form used everywhere except the roster add/edit form itself —
// "First L." rather than the full last name, to keep lists and slots compact.
const displayName = (p) => {
  if (!p) return "";
  const last = (p.lastName || "").trim();
  return last ? `${p.firstName} ${last.charAt(0).toUpperCase()}.` : p.firstName || "";
};

const fullName = (p) => (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "");

// Build and download a CSV file client-side — no library needed for this.
function downloadCSV(filename, headerRow, rows) {
  const escape = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headerRow, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const POSITIONS = [
  { value: "S", label: "Setter" },
  { value: "OH", label: "Outside Hitter" },
  { value: "MB", label: "Middle Blocker" },
  { value: "OPP", label: "Opposite" },
  { value: "L", label: "Libero" },
  { value: "DS", label: "Defensive Specialist" },
];

// Rotation positions arranged as coaches see them on a court diagram
// P4 P3 P2  (front row, net at top)
// P5 P6 P1  (back row)
const COURT_LAYOUT = [
  { slot: "P4", area: "front", gridArea: "p4" },
  { slot: "P3", area: "front", gridArea: "p3" },
  { slot: "P2", area: "front", gridArea: "p2" },
  { slot: "P5", area: "back", gridArea: "p5" },
  { slot: "P6", area: "back", gridArea: "p6" },
  { slot: "P1", area: "back", gridArea: "p1" },
];

// ---- Offensive systems (5-1 / 6-2 / 4-2) — used only by the Serve-Receive
// reference view. Roles are never manually assigned or stored: they're
// derived fresh from whoever's actually placed on court in a lineup, using
// each player's existing roster position tag (S/OPP/OH/MB). That keeps this
// automatically correct after any substitution, with nothing to keep in sync.
const OFFENSIVE_SYSTEMS = [
  { key: "5-1", label: "5-1" },
  { key: "6-2", label: "6-2" },
  { key: "4-2", label: "4-2" },
];

// Same clockwise shift Advance Rotation already uses on the Live screen —
// reused here to preview "N rotations from now" without needing any
// separate abstract role-numbering system.
function shiftSlotsClockwise(slots, times) {
  let s = { ...slots };
  for (let i = 0; i < times; i++) {
    s = { P1: s.P2, P2: s.P3, P3: s.P4, P4: s.P5, P5: s.P6, P6: s.P1 };
  }
  return s;
}

// Applies the coach's own Substitution Pairings on top of a (possibly
// shifted) set of slots. Only one player in a pairing is ever actually
// placed in the lineup diagram — the other is the bench substitute — and
// which one that is determines which direction triggers the swap:
//   - If the player placed on court is tagged "frontId" and their slot has
//     rotated to the BACK row, sub in "backId" (e.g., an OH subbed off for
//     a passing specialist once their spot cycles back).
//   - If the player placed on court is tagged "backId" and their slot has
//     rotated to the FRONT row, sub in "frontId" instead (e.g., a DS who
//     started back row getting subbed out for a hitter once their spot
//     cycles forward). Without this second direction, a pairing built the
//     second way never triggers at all.
function applySubPairings(slots, pairings) {
  const result = { ...slots };
  (pairings || []).forEach(({ frontId, backId }) => {
    const frontPos = Object.keys(result).find((p) => result[p] === frontId);
    const backPos = Object.keys(result).find((p) => result[p] === backId);
    if (frontPos && BACK_ROW_SLOTS.includes(frontPos)) {
      result[frontPos] = backId;
    } else if (backPos && FRONT_ROW_SLOTS.includes(backPos)) {
      result[backPos] = frontId;
    }
  });
  return result;
}

// Computes the true, absolute arrangement for a given rotation number (1-6),
// with substitutions applied — regardless of which rotation the lineup is
// currently actually sitting at. Reconstructs true Rotation 1 first (same
// reverse-shift math Duplicate Lineup uses), then shifts forward from that
// known baseline. Shifting directly from whatever's currently on court would
// only be correct when the lineup happens to already be at Rotation 1 —
// this is what makes it correct no matter where it currently sits.
function computeRotationSlots(lineup, targetRotation) {
  const currentRotation = lineup.currentRotation || 1;
  const rotation1Slots = shiftSlotsClockwise(lineup.slots, 7 - currentRotation);
  const targetSlots = shiftSlotsClockwise(rotation1Slots, targetRotation - 1);
  return applySubPairings(targetSlots, lineup.pairings);
}

// For the player-facing sub sheet: computes all 6 rotations starting from
// true Rotation 1, then figures out exactly which rotation/position combos
// are a real transition (a swap actually happening right then) versus just
// "the sub is still in from before." Only transitions get flagged — every
// other rotation just shows whoever's currently in as a single number, so
// the sheet doesn't repeat the same dual-circle for rotations where nothing
// changed. leaving/entering are which player is going out vs coming in.
function computeSubTransitions(lineup) {
  const rotation1Slots = shiftSlotsClockwise(lineup.slots, 7 - (lineup.currentRotation || 1));
  const pairings = lineup.pairings || [];
  const rotations = [];
  for (let r = 1; r <= 6; r++) {
    const shifted = shiftSlotsClockwise(rotation1Slots, r - 1);
    const withSubs = applySubPairings(shifted, pairings);
    rotations.push({ shifted, withSubs });
  }

  const transitions = {}; // "r-pos" -> { leaving, entering }
  pairings.forEach(({ frontId, backId }) => {
    const inDiagram = Object.values(rotation1Slots).includes(frontId) ? frontId : backId;
    let prevOccupant = null;
    for (let r = 1; r <= 6; r++) {
      const { shifted, withSubs } = rotations[r - 1];
      const pos = Object.keys(shifted).find((p) => shifted[p] === inDiagram);
      if (!pos) continue;
      const occupant = withSubs[pos];
      if (r === 1) {
        if (shifted[pos] !== occupant) transitions[`${r}-${pos}`] = { leaving: shifted[pos], entering: occupant };
      } else if (occupant !== prevOccupant) {
        transitions[`${r}-${pos}`] = { leaving: prevOccupant, entering: occupant };
      }
      prevOccupant = occupant;
    }
  });

  return { rotations, transitions };
}

// Serve-receive layout: who passes, who's the active setter, and which
// back-row Middle is actually the libero on court — all derived directly
// from the given slots (already shifted for whichever rotation is being
// previewed) plus each on-court player's roster position tag.
function deriveServeReceive(system, slots, roster, liberoIds, isAlternate) {
  const positions = ["P1", "P2", "P3", "P4", "P5", "P6"];
  const playerAt = {};
  positions.forEach((pos) => {
    playerAt[pos] = slots[pos] ? roster.find((p) => p.id === slots[pos]) || null : null;
  });

  const isBack = (pos) => BACK_ROW_SLOTS.includes(pos);
  const isFront = (pos) => FRONT_ROW_SLOTS.includes(pos);
  const taggedPositions = (tag) => positions.filter((pos) => playerAt[pos]?.position === tag);

  const sPositions = taggedPositions("S");
  const oppPositions = taggedPositions("OPP");
  const ohPositions = taggedPositions("OH");
  const mbPositions = taggedPositions("MB");
  const dsPositions = taggedPositions("DS"); // defensive specialist — a real passer, wasn't recognized before

  let activeSetterPos = null;
  if (system === "5-1") activeSetterPos = sPositions[0] || null;
  else if (system === "6-2") activeSetterPos = sPositions.find(isBack) || sPositions[0] || null;
  else activeSetterPos = sPositions.find(isFront) || sPositions[0] || null; // 4-2

  // Whichever Middle is back row is shown as the libero, if this lineup has
  // one designated — same rule regardless of system.
  const backMBPos = mbPositions.find(isBack) || null;
  const liberoId = (liberoIds || []).find(Boolean) || null;
  const liberoPlayer = liberoId ? roster.find((p) => p.id === liberoId) : null;

  let passerPositions = [];
  let backRowAttackPositions = [];
  // A DS on court is always a passer when they're back row — 4-2 already
  // captures this (every back-row player passes there), so this only needs
  // adding for 5-1/6-2's fixed passer trio.
  const backRowDS = dsPositions.filter(isBack);

  if (system === "4-2") {
    passerPositions = positions.filter(isBack);
  } else if (isAlternate) {
    // 5-1 alternate: front-row Outside stays at the net, Opposite drops back to pass
    const backOHPos = ohPositions.find(isBack);
    const oppPos = oppPositions[0];
    passerPositions = [backOHPos, oppPos, backMBPos, ...backRowDS].filter(Boolean);
    if (oppPos) backRowAttackPositions = [oppPos];
  } else {
    passerPositions = [...ohPositions, backMBPos, ...backRowDS].filter(Boolean);
    const backOHPos = ohPositions.find(isBack);
    if (backOHPos) backRowAttackPositions = [backOHPos];
  }

  return { playerAt, activeSetterPos, backMBPos, liberoPlayer, passerPositions, backRowAttackPositions };
}

const STAT_BUTTONS = [
  { key: "ace", label: "Ace", group: "Serve", color: COLORS.green },
  { key: "serviceAtt", label: "Service Att.", group: "Serve", color: COLORS.blue },
  { key: "serveErr", label: "Serve Err", group: "Serve", color: COLORS.red },
  { key: "kill", label: "Kill", group: "Attack", color: COLORS.green },
  { key: "assist", label: "Assist", group: "Attack", color: COLORS.green },
  { key: "attackErr", label: "Attack Err", group: "Attack", color: COLORS.red },
  { key: "dig", label: "Dig", group: "Reception", color: COLORS.green },
  { key: "recErr", label: "Rec Err", group: "Reception", color: COLORS.red },
  { key: "passingErr", label: "Passing Err", group: "Reception", color: COLORS.red },
  { key: "blockSolo", label: "Block Solo", group: "Block", color: COLORS.green },
  { key: "blockAst", label: "Block Ast", group: "Block", color: COLORS.green },
  { key: "blockErr", label: "Block Err", group: "Block", color: COLORS.red },
];

const STAT_LABELS = Object.fromEntries(STAT_BUTTONS.map((s) => [s.key, s.label]));

// Definitions for the "?" info button on the Stats tab — plain-language
// reference for what each button actually counts.
const STAT_DEFINITIONS = {
  ace: "A serve that lands in the opponent's court without being touched, winning the point outright.",
  serviceAtt: "The total number of serves made by a player — used together with Aces and Serve Errors to gauge serving performance.",
  serveErr: "A mistake made while serving, such as a fault, that gives the point to the opponent.",
  kill: "A successful attack that results directly in a point for the team.",
  assist: "A set made by a player that leads directly to a kill.",
  attackErr: "A mistake made during an attack, whether forced by the opponent's defense or unforced.",
  dig: "A successful defensive play that keeps the ball from hitting the ground.",
  recErr: "A mistake made while receiving a serve or an attack.",
  passingErr: "A mistake made while attempting to pass the ball, such as a mishandle.",
  blockSolo: "A block made by a single player, without help from a teammate, that stops the opponent's attack.",
  blockAst: "A block made together with one or more teammates that stops the opponent's attack.",
  blockErr: "A blocking attempt that faults (such as a net touch) or fails to stop the attack, giving the opponent the point.",
};

function PhoneFrame({ children }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%", // fills its parent (already sized to the viewport) rather than
        // re-declaring its own 100dvh — nesting two independent viewport-relative
        // heights was coming out slightly taller than the visible screen on some
        // devices, clipping the tab bar off the bottom with no way to reach it.
        background: COLORS.bg,
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Inter', system-ui, sans-serif",
        color: COLORS.chalk,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function TopBar({ title, sub, onPrint, printing, teamLogo, onInfo, onSettings }) {
  return (
    <div
      style={{
        padding: "22px 20px 14px",
        borderBottom: `1px solid ${COLORS.line}`,
        flexShrink: 0,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {teamLogo && (
          <img
            src={teamLogo}
            alt="Team logo"
            style={{ width: 32, height: 32, borderRadius: 7, objectFit: "cover", flexShrink: 0 }}
          />
        )}
        <div>
          <div
            style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            {title}
          </div>
          {sub && (
            <div style={{ fontSize: 12, color: COLORS.chalkDim, marginTop: 2 }}>
              {sub}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {onSettings && (
          <button
            onClick={onSettings}
            title="Settings"
            style={{
              background: "none",
              border: `1px solid ${COLORS.line}`,
              borderRadius: 8,
              padding: 8,
              color: COLORS.chalkDim,
              display: "flex",
              marginTop: 2,
              flexShrink: 0,
            }}
          >
            <SettingsIcon size={16} />
          </button>
        )}
        {onInfo && (
          <button
            onClick={onInfo}
            title="Stat definitions"
            style={{
              background: "none",
              border: `1px solid ${COLORS.line}`,
              borderRadius: 8,
              padding: 8,
              color: COLORS.chalkDim,
              display: "flex",
              marginTop: 2,
              flexShrink: 0,
            }}
          >
            <HelpCircle size={16} />
          </button>
        )}
        {onPrint && (
          <button
            onClick={onPrint}
            disabled={printing}
            title={printing ? "Generating PDF…" : "Print / Export PDF"}
            style={{
              background: printing ? "rgba(255,107,53,0.15)" : "none",
              border: `1px solid ${printing ? COLORS.orange : COLORS.line}`,
              borderRadius: 8,
              padding: 8,
              color: printing ? COLORS.orange : COLORS.chalkDim,
              display: "flex",
              marginTop: 2,
              flexShrink: 0,
              opacity: printing ? 0.7 : 1,
            }}
          >
            <Printer size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }) {
  const tabs = [
    { key: "roster", label: "Roster", icon: Users },
    { key: "lineup", label: "Lineup", icon: LayoutGrid },
    { key: "live", label: "Live", icon: Activity },
    { key: "box", label: "Stats", icon: ClipboardList },
    { key: "schedule", label: "Schedule", icon: Calendar },
  ];
  return (
    <div
      style={{
        display: "flex",
        borderTop: `1px solid ${COLORS.line}`,
        background: COLORS.bgRaised,
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              padding: "12px 0 14px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
              color: active ? COLORS.orange : COLORS.chalkDim,
            }}
          >
            <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
            <span
              style={{
                fontSize: 10,
                fontWeight: active ? 700 : 500,
                letterSpacing: 0.3,
                textTransform: "uppercase",
              }}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- Lineup screen: rotation dial court diagram, multi-lineup support ----
function LineupScreen({ lineups, setLineups, activeLineupId, roster, setRoster, captainId, setCaptainId, roleSystem, setRoleSystem }) {
  const [picking, setPicking] = useState(null); // { type: 'court'|'libero', slot } | null
  const [renaming, setRenaming] = useState(false);
  const [playerSheet, setPlayerSheet] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [playerForm, setPlayerForm] = useState({ num: "", firstName: "", lastName: "", position: "", position2: "" });
  const [addingPairing, setAddingPairing] = useState(false);
  const [pairingForm, setPairingForm] = useState({ frontId: "", backId: "", isLibero: false });
  const [systemSheetOpen, setSystemSheetOpen] = useState(false);
  const [serveReceiveOpen, setServeReceiveOpen] = useState(false);
  const [isAlternate, setIsAlternate] = useState(false);
  // Which lineup this SCREEN is showing/editing — deliberately separate from
  // activeLineupId (the one actually live on the Live screen). Browsing or
  // prepping any lineup here must never affect what's currently being played;
  // only "Start Next Set" on Live changes which lineup is truly active. This
  // does follow along automatically when the active lineup genuinely changes
  // (Start Next Set, End Match), so navigating here normally shows what's live.
  const [viewingLineupId, setViewingLineupId] = useState(activeLineupId);
  useEffect(() => {
    setViewingLineupId(activeLineupId);
  }, [activeLineupId]);

  const activeLineup = lineups.find((l) => l.id === viewingLineupId) || lineups[0];
  const liberos = activeLineup.liberos || [null, null];

  // Starts already matching the lineup's real rotation (a lazy initializer,
  // computed once at mount from data already available) rather than
  // hardcoding 1 and correcting a moment later via an effect — this tab
  // unmounts and remounts every time you switch away and back, so that lag
  // window was real and was blocking editing whenever a lineup's actual
  // rotation wasn't 1 at the moment this screen mounted.
  const [previewRotation, setPreviewRotation] = useState(() => activeLineup.currentRotation || 1);
  // Still re-syncs later if the real rotation changes while this screen
  // stays mounted (a live rotation advance, Start This Rotation, etc).
  useEffect(() => {
    setPreviewRotation(activeLineup.currentRotation || 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLineup.id, activeLineup.currentRotation]);

  // The court diagram (and Serve-Receive reference) always display this —
  // the true, correctly-computed arrangement for whichever rotation is
  // being previewed, substitutions included. It matches the real committed
  // slots exactly when previewRotation equals the lineup's actual current
  // rotation, and shows a hypothetical otherwise.
  const isPreviewing = previewRotation !== (activeLineup.currentRotation || 1);
  const slots = isPreviewing ? computeRotationSlots(activeLineup, previewRotation) : activeLineup.slots;
  const assignedIds = new Set(Object.values(activeLineup.slots).filter(Boolean));

  const startThisRotation = () => {
    const newSlots = computeRotationSlots(activeLineup, previewRotation);
    setLineups((prev) =>
      prev.map((l) => (l.id === activeLineup.id ? { ...l, slots: newSlots, currentRotation: previewRotation } : l))
    );
  };

  const updateActiveSlots = (updater) => {
    setLineups((prev) =>
      prev.map((l) => (l.id === activeLineup.id ? { ...l, slots: updater(l.slots) } : l))
    );
  };

  const updateActiveLiberos = (updater) => {
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id ? { ...l, liberos: updater(l.liberos || [null, null]) } : l
      )
    );
  };

  const assign = (playerId) => {
    if (!picking) return;
    if (picking.type === "court") {
      updateActiveSlots((s) => ({ ...s, [picking.slot]: playerId }));
    } else {
      updateActiveLiberos((libs) => {
        const next = [...libs];
        next[picking.slot] = playerId;
        return next;
      });
    }
    setPicking(null);
  };

  const clearCourt = (slot) => updateActiveSlots((s) => ({ ...s, [slot]: null }));
  const clearLibero = (idx) =>
    updateActiveLiberos((libs) => {
      const next = [...libs];
      next[idx] = null;
      return next;
    });

  const addLineup = (fromDuplicate) => {
    const newId = Date.now();
    const nextSetNumber = Math.max(0, ...lineups.map((l) => l.setNumber || 0)) + 1;
    // Duplicating always reconstructs the true Rotation 1 of the source
    // lineup, not wherever live rotation left it — otherwise a copy made
    // mid-match would carry over whatever drift had already happened.
    const sourceRotation = activeLineup.currentRotation || 1;
    const baseSlots = fromDuplicate
      ? shiftSlotsClockwise(activeLineup.slots, 7 - sourceRotation)
      : { P1: null, P2: null, P3: null, P4: null, P5: null, P6: null };
    const baseLiberos = fromDuplicate ? [...(activeLineup.liberos || [null, null])] : [null, null];
    const basePairings = fromDuplicate ? [...(activeLineup.pairings || [])] : [];
    const name = `Set ${nextSetNumber}`;
    setLineups((prev) => [
      ...prev,
      { id: newId, name, slots: baseSlots, liberos: baseLiberos, pairings: basePairings, currentRotation: 1, setNumber: nextSetNumber },
    ]);
    setViewingLineupId(newId);
  };

  const deleteLineup = (id) => {
    if (lineups.length === 1) return;
    const remaining = lineups.filter((l) => l.id !== id);
    setLineups(remaining);
    if (viewingLineupId === id) setViewingLineupId(remaining[0].id);
  };

  const renameLineup = (name) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, name } : l)));
  };

  const pairings = activeLineup.pairings || [];

  // A pairing only makes sense as a substitute relationship: exactly one of the
  // two players may be on the court right now, the other must be on the bench.
  const pairingValidationError = (frontId, backId) => {
    if (!frontId || !backId) return null;
    if (frontId === backId) return "Pick two different players.";
    const frontOnCourt = assignedIds.has(frontId);
    const backOnCourt = assignedIds.has(backId);
    if (frontOnCourt && backOnCourt) {
      return "Both players are currently on the court — one needs to be on the bench to pair as a substitute.";
    }
    if (!frontOnCourt && !backOnCourt) {
      return "Neither player is on the court right now — one of them needs to be in the lineup for this pairing.";
    }
    // A player can only be tied to one substitute relationship at a time for this lineup.
    const existingFor = (playerId) =>
      pairings.find((p) => p.frontId === playerId || p.backId === playerId);
    const frontExisting = existingFor(frontId);
    if (frontExisting) {
      const other = playerFor(frontExisting.frontId === frontId ? frontExisting.backId : frontExisting.frontId);
      return `${displayName(playerFor(frontId))} is already paired with ${displayName(other)} for this lineup — remove that pairing first.`;
    }
    const backExisting = existingFor(backId);
    if (backExisting) {
      const other = playerFor(backExisting.frontId === backId ? backExisting.backId : backExisting.frontId);
      return `${displayName(playerFor(backId))} is already paired with ${displayName(other)} for this lineup — remove that pairing first.`;
    }
    return null;
  };

  const addPairing = (frontId, backId, isLibero) => {
    if (pairingValidationError(frontId, backId)) return;
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id
          ? { ...l, pairings: [...(l.pairings || []), { id: Date.now(), frontId, backId, isLibero }] }
          : l
      )
    );
  };

  const deletePairing = (id) => {
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id ? { ...l, pairings: (l.pairings || []).filter((p) => p.id !== id) } : l
      )
    );
  };

  const togglePairingLibero = (id) => {
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id
          ? { ...l, pairings: (l.pairings || []).map((p) => (p.id === id ? { ...p, isLibero: !p.isLibero } : p)) }
          : l
      )
    );
  };

  const setServesFirst = (val) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, servesFirst: val } : l)));
  };

  const playerFor = (id) => roster.find((p) => p.id === id);
  const filled = Object.values(slots).filter(Boolean).length;
  const servesFirst = activeLineup.servesFirst || "us";

  const openAddPlayer = () => {
    setPlayerForm({ num: "", firstName: "", lastName: "", position: "", position2: "" });
    setPlayerSheet({ mode: "add" });
  };

  const openEditPlayer = (p) => {
    setPlayerForm({ num: String(p.num), firstName: p.firstName || "", lastName: p.lastName || "", position: p.position || "", position2: p.position2 || "" });
    setPlayerSheet({ mode: "edit", id: p.id });
  };

  const savePlayer = () => {
    if (!playerForm.firstName.trim()) return;
    if (playerSheet?.mode === "edit") {
      setRoster((prev) =>
        prev.map((p) =>
          p.id === playerSheet.id
            ? {
                ...p,
                num: playerForm.num.trim() || "-",
                firstName: playerForm.firstName.trim(),
                lastName: playerForm.lastName.trim(),
                position: playerForm.position,
                position2: playerForm.position2 || "",
              }
            : p
        )
      );
    } else {
      const id = Date.now();
      setRoster((prev) => [
        ...prev,
        {
          id,
          num: playerForm.num.trim() || "-",
          firstName: playerForm.firstName.trim(),
          lastName: playerForm.lastName.trim(),
          position: playerForm.position,
          position2: playerForm.position2 || "",
        },
      ]);
    }
    setPlayerSheet(null);
  };

  return (
    <div style={{ padding: "16px 20px 20px", overflowY: "auto", flex: 1 }}>
      {/* Lineup switcher — browsing here is just viewing/editing, never
          changes which lineup is actually live. A small dot marks whichever
          one really is live, separate from whichever one you're looking at. */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 2 }}>
        {lineups.map((l) => (
          <button
            key={l.id}
            onClick={() => setViewingLineupId(l.id)}
            style={{
              flexShrink: 0,
              padding: "7px 12px",
              borderRadius: 8,
              border: `1.5px solid ${l.id === viewingLineupId ? COLORS.orange : COLORS.line}`,
              background: l.id === viewingLineupId ? "rgba(255,107,53,0.15)" : "transparent",
              color: COLORS.chalk,
              fontSize: 12,
              fontWeight: l.id === viewingLineupId ? 700 : 500,
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {l.id === activeLineupId && (
              <span
                title="Currently live"
                style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.green, display: "inline-block" }}
              />
            )}
            {l.name}
          </button>
        ))}
        <button
          onClick={() => addLineup(false)}
          title="New lineup"
          style={{
            flexShrink: 0,
            width: 32,
            borderRadius: 8,
            border: `1.5px dashed ${COLORS.line}`,
            background: "transparent",
            color: COLORS.chalkDim,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Active lineup name + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        {renaming ? (
          <input
            autoFocus
            defaultValue={activeLineup.name}
            onBlur={(e) => {
              renameLineup(e.target.value || activeLineup.name);
              setRenaming(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
            style={{
              background: COLORS.bgRaised,
              border: `1px solid ${COLORS.orange}`,
              borderRadius: 6,
              color: COLORS.chalk,
              fontFamily: "'Oswald', sans-serif",
              fontSize: 15,
              padding: "4px 8px",
              flex: 1,
            }}
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            style={{
              background: "none",
              border: "none",
              color: COLORS.chalk,
              fontFamily: "'Oswald', sans-serif",
              fontSize: 15,
              fontWeight: 600,
              padding: 0,
            }}
          >
            {activeLineup.name}
          </button>
        )}
        <button
          onClick={() => addLineup(true)}
          title="Duplicate lineup"
          style={{ background: "none", border: "none", color: COLORS.chalkDim, display: "flex" }}
        >
          <Copy size={15} />
        </button>
        {lineups.length > 1 && (
          <button
            onClick={() => deleteLineup(activeLineup.id)}
            title="Delete lineup"
            style={{ background: "none", border: "none", color: COLORS.red, display: "flex" }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div
        style={{
          fontSize: 11,
          color: filled === 6 ? COLORS.green : COLORS.orange,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 14,
        }}
      >
        {filled}/6 positions set {filled === 6 ? "· ready" : ""}
      </div>

      {/* Serve-Receive reference — pure reference tool, fully derived from
          whoever's actually on court plus their roster position tag. Nothing
          here edits the court diagram above; editing who's on court always
          happens there, including substitutions. */}
      <div style={{ marginBottom: 16 }}>
        {filled === 6 ? (
          <>
            <div
              style={{
                fontSize: 11,
                color: COLORS.chalkDim,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 8,
              }}
            >
              Rotation — also previews on the court diagram above
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {[1, 2, 3, 4, 5, 6].map((r) => (
                <button
                  key={r}
                  onClick={() => setPreviewRotation(r)}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: `1.5px solid ${previewRotation === r ? COLORS.orange : COLORS.line}`,
                    background: previewRotation === r ? "rgba(255,107,53,0.15)" : "transparent",
                    color: COLORS.chalk,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
            <button
              onClick={() => setServeReceiveOpen(true)}
              style={{
                width: "100%",
                padding: "9px",
                borderRadius: 8,
                border: `1.5px solid ${COLORS.green}`,
                background: "rgba(76,154,99,0.15)",
                color: COLORS.chalk,
                fontSize: 12,
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              View Serve-Receive — Rotation {previewRotation}
            </button>
            <button
              onClick={() => setSystemSheetOpen(true)}
              style={{ background: "none", border: "none", color: COLORS.chalkDim, fontSize: 11, padding: 0 }}
            >
              Serve-Receive Settings
            </button>
          </>
        ) : (
          <div style={{ fontSize: 11, color: COLORS.chalkDim, textAlign: "center" }}>
            Fill all 6 positions above to enable the Serve-Receive reference.
          </div>
        )}
      </div>

      {/* First serve toggle - coin toss result varies set to set */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 11,
            color: COLORS.chalkDim,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          First Serve
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { key: "us", label: "We Serve" },
            { key: "opp", label: "We Receive" },
          ].map((opt) => (
            <button
              key={opt.key}
              onClick={() => setServesFirst(opt.key)}
              style={{
                flex: 1,
                padding: "9px",
                borderRadius: 8,
                border: `1.5px solid ${servesFirst === opt.key ? COLORS.orange : COLORS.line}`,
                background: servesFirst === opt.key ? "rgba(255,107,53,0.15)" : "transparent",
                color: COLORS.chalk,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {servesFirst === "opp" && (
          <div style={{ fontSize: 11, color: COLORS.chalkDim, marginTop: 6 }}>
            Opponent serves first — your team rotates before its first serve,
            so P2 serves first once you side out.
          </div>
        )}
      </div>

      {/* Compact preview banner — only takes screen space when it's actually
          relevant (previewing a rotation other than what's really committed).
          One line, one action, nothing extra. */}
      {isPreviewing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 10px",
            marginBottom: 8,
            borderRadius: 8,
            border: `1.5px solid ${COLORS.gold}`,
            background: "rgba(255,200,87,0.12)",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.chalk }}>
            Previewing Rotation {previewRotation} — not yet set
          </span>
          <button
            onClick={startThisRotation}
            style={{
              flexShrink: 0,
              padding: "5px 10px",
              borderRadius: 6,
              border: `1.5px solid ${COLORS.gold}`,
              background: COLORS.gold,
              color: "#1C2128",
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            Start This Rotation
          </button>
        </div>
      )}

      {/* Net indicator */}
      <div
        style={{
          textAlign: "center",
          fontSize: 10,
          letterSpacing: 2,
          color: COLORS.chalkDim,
          marginBottom: 8,
          textTransform: "uppercase",
        }}
      >
        — net —
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateAreas: `"p4 p3 p2" "p5 p6 p1"`,
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 10,
          marginBottom: 20,
        }}
      >
        {COURT_LAYOUT.map(({ slot, gridArea }) => {
          const pid = slots[slot];
          const player = pid ? playerFor(pid) : null;
          const serverSlot = servesFirst === "us" ? "P1" : "P2";
          const isServer = slot === serverSlot;
          return (
            <button
              key={slot}
              onClick={() => !isPreviewing && setPicking({ type: "court", slot })}
              style={{
                gridArea,
                aspectRatio: "1",
                background: player ? "rgba(255,107,53,0.12)" : COLORS.bgRaised,
                border: `2px solid ${isServer ? COLORS.gold : player ? COLORS.orange : COLORS.line}`,
                borderRadius: 12,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                color: COLORS.chalk,
                position: "relative",
                padding: 4,
                paddingTop: isServer ? 16 : 4,
              }}
            >
              {isServer && (
                <span
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 14,
                    background: COLORS.gold,
                    borderRadius: "10px 10px 0 0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 7,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    color: "#1C2128",
                    textTransform: "uppercase",
                  }}
                >
                  1st Server
                </span>
              )}
              <span
                style={{
                  position: "absolute",
                  top: isServer ? 18 : 6,
                  left: 8,
                  fontSize: 9,
                  color: COLORS.chalkDim,
                  fontWeight: 700,
                }}
              >
                {slot}
              </span>
              {player && player.id === captainId && (
                <span
                  style={{
                    position: "absolute",
                    top: isServer ? 18 : 6,
                    right: 6,
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#1C2128",
                    background: COLORS.chalk,
                    borderRadius: "50%",
                    width: 14,
                    height: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  C
                </span>
              )}
              {player ? (
                <>
                  <span
                    style={{
                      fontFamily: "'Oswald', sans-serif",
                      fontSize: 24,
                      fontWeight: 600,
                      lineHeight: 1,
                    }}
                  >
                    #{player.num}
                  </span>
                  <span style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 2 }}>
                    {displayName(player)}
                  </span>
                  {player.position && (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 700,
                        color: COLORS.orange,
                        border: `1px solid ${COLORS.orange}`,
                        borderRadius: 3,
                        padding: "0px 3px",
                        marginTop: 2,
                      }}
                    >
                      {player.position}
                    </span>
                  )}
                </>
              ) : (
                <Plus size={20} color={COLORS.chalkDim} />
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{
          fontSize: 11,
          color: COLORS.chalkDim,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 10,
        }}
      >
        Liberos <span style={{ color: COLORS.chalkDim, fontWeight: 500, textTransform: "none" }}>(up to 2)</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[0, 1].map((idx) => {
          const pid = liberos[idx];
          const player = pid ? playerFor(pid) : null;
          return (
            <button
              key={idx}
              onClick={() => setPicking({ type: "libero", slot: idx })}
              style={{
                flex: 1,
                minHeight: 56,
                background: player ? "rgba(62,124,166,0.14)" : COLORS.bgRaised,
                border: `2px solid ${player ? COLORS.blue : COLORS.line}`,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                color: COLORS.chalk,
                padding: "6px 10px",
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: COLORS.blue,
                  border: `1px solid ${COLORS.blue}`,
                  borderRadius: 4,
                  padding: "1px 4px",
                }}
              >
                L{idx + 1}
              </span>
              {player ? (
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 600 }}>
                    #{player.num}
                  </span>{" "}
                  <span style={{ color: COLORS.chalkDim }}>{displayName(player)}</span>
                  {player.id === captainId && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: "#1C2128",
                        background: COLORS.chalk,
                        borderRadius: "50%",
                        width: 14,
                        height: 14,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      C
                    </span>
                  )}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: COLORS.chalkDim, display: "flex", alignItems: "center", gap: 4 }}>
                  <Plus size={14} /> Assign
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Substitution pairings - front row / back row swap tied to a roster spot */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: COLORS.chalkDim,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Substitution Pairings
        </div>
        <button
          onClick={() => setAddingPairing(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "none",
            border: `1px solid ${COLORS.line}`,
            borderRadius: 6,
            padding: "4px 8px",
            color: COLORS.orange,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          <Plus size={12} /> Add Pairing
        </button>
      </div>
      {pairings.length === 0 ? (
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 20 }}>
          None set. Pair a front-row player with their back-row (or libero) replacement,
          and the Live tab will suggest the swap when the rotation calls for it.
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          {pairings.map((pr) => {
            const front = playerFor(pr.frontId);
            const back = playerFor(pr.backId);
            const involvesLibero = liberos.includes(pr.frontId) || liberos.includes(pr.backId);
            const mismatch = involvesLibero && !pr.isLibero;
            return (
              <div key={pr.id} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: COLORS.bgRaised,
                    border: `1px solid ${mismatch ? COLORS.red : COLORS.line}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                >
                  {pr.isLibero && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: COLORS.blue,
                        border: `1px solid ${COLORS.blue}`,
                        borderRadius: 4,
                        padding: "1px 4px",
                        flexShrink: 0,
                      }}
                    >
                      LIBERO
                    </span>
                  )}
                  <span style={{ color: COLORS.chalk }}>
                    Front: <b>#{front?.num} {displayName(front)}</b>
                  </span>
                  <span style={{ color: COLORS.chalkDim }}>↔</span>
                  <span style={{ color: COLORS.chalk }}>
                    Back: <b>#{back?.num} {displayName(back)}</b>
                  </span>
                  <button
                    onClick={() => deletePairing(pr.id)}
                    style={{ marginLeft: "auto", background: "none", border: "none", color: COLORS.chalkDim }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {mismatch && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 10,
                      color: COLORS.red,
                      padding: "4px 4px 0",
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      Involves your designated libero but isn't marked as a libero swap — it'll count
                      against your regular sub total.
                    </span>
                    <button
                      onClick={() => togglePairingLibero(pr.id)}
                      style={{
                        background: "none",
                        border: `1px solid ${COLORS.red}`,
                        borderRadius: 5,
                        padding: "2px 6px",
                        color: COLORS.red,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      Fix
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: COLORS.chalkDim,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Bench
        </div>
        <button
          onClick={openAddPlayer}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "none",
            border: `1px solid ${COLORS.line}`,
            borderRadius: 6,
            padding: "4px 8px",
            color: COLORS.orange,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          <Plus size={12} /> Add Player
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {roster
          .filter((p) => !assignedIds.has(p.id))
          .map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: COLORS.bgRaised,
                border: `1px solid ${p.id === captainId ? COLORS.gold : COLORS.line}`,
                borderRadius: 8,
                padding: "4px 4px 4px 10px",
                fontSize: 12,
                color: COLORS.chalkDim,
              }}
            >
              <button
                onClick={() => setCaptainId((cur) => (cur === p.id ? null : p.id))}
                title="Tap to toggle captain"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "none",
                  border: "none",
                  color: "inherit",
                  fontSize: 12,
                  padding: "2px 0",
                }}
              >
                #{p.num} {displayName(p)}
                {p.position && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: COLORS.chalkDim,
                      border: `1px solid ${COLORS.line}`,
                      borderRadius: 4,
                      padding: "1px 4px",
                    }}
                  >
                    {p.position}
                  </span>
                )}
                {p.id === captainId && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: "#1C2128",
                      background: COLORS.chalk,
                      borderRadius: "50%",
                      width: 14,
                      height: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    C
                  </span>
                )}
              </button>
              <button
                onClick={() => openEditPlayer(p)}
                title="Edit player"
                style={{
                  background: "none",
                  border: "none",
                  color: COLORS.chalkDim,
                  display: "flex",
                  padding: 4,
                }}
              >
                <Pencil size={11} />
              </button>
            </div>
          ))}
      </div>
      <div style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 6 }}>
        Tap a bench player above, or the C toggle in the player picker, to set the team captain.
        Tap the pencil to edit a player's number, name, or position.
      </div>

      {systemSheetOpen && (
        <div
          onClick={() => setSystemSheetOpen(false)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
              maxHeight: "80%",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase" }}>
                Serve-Receive Settings
              </div>
              <button
                onClick={() => setSystemSheetOpen(false)}
                style={{ background: "none", border: "none", color: COLORS.chalkDim }}
              >
                <X size={20} />
              </button>
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 14 }}>
              Who plays what is figured out automatically from each on-court player's
              position tag (S/OPP/OH/MB) and this lineup's designated libero — nothing to
              set up here beyond your offensive system.
            </div>

            <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", marginBottom: 6 }}>
              Offensive System
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: roleSystem?.system === "5-1" ? 16 : 4 }}>
              {OFFENSIVE_SYSTEMS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setRoleSystem((prev) => ({ ...(prev || {}), system: s.key }))}
                  style={{
                    flex: 1,
                    padding: "9px 0",
                    borderRadius: 8,
                    border: `1.5px solid ${roleSystem?.system === s.key ? COLORS.orange : COLORS.line}`,
                    background: roleSystem?.system === s.key ? "rgba(255,107,53,0.15)" : "transparent",
                    color: COLORS.chalk,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {roleSystem?.system === "5-1" && (
              <button
                onClick={() => setIsAlternate((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px",
                  marginBottom: 6,
                  borderRadius: 8,
                  border: `1px solid ${COLORS.line}`,
                  background: "none",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: `1.5px solid ${isAlternate ? COLORS.orange : COLORS.line}`,
                    background: isAlternate ? COLORS.orange : "transparent",
                    flexShrink: 0,
                  }}
                />
                <div style={{ fontSize: 12, color: COLORS.chalk }}>
                  Alternate pattern
                  <div style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 2 }}>
                    Front-row Outside stays at the net; Opposite drops back to pass instead.
                  </div>
                </div>
              </button>
            )}

            <button
              onClick={() => setSystemSheetOpen(false)}
              style={{
                width: "100%",
                padding: "11px",
                marginTop: 8,
                borderRadius: 8,
                border: "none",
                background: COLORS.orange,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {serveReceiveOpen && (() => {
        const system = roleSystem?.system || "5-1";
        // Reuses the same correctly-computed slots already driving the court
        // diagram above — no separate shift math needed here anymore.
        const shiftedSlots = slots;
        const layout = deriveServeReceive(system, shiftedSlots, roster, liberos, isAlternate);

        // Rough real-court coordinates per position (0-100, y=0 at the net)
        // — this is what actually shows alignment, unlike 6 equal boxes.
        const BASE_COORD = {
          P4: { x: 16, y: 14 },
          P3: { x: 50, y: 10 },
          P2: { x: 84, y: 14 },
          P5: { x: 16, y: 58 },
          P6: { x: 50, y: 62 },
          P1: { x: 84, y: 58 },
        };
        const NET_TARGET = { x: 80, y: 24 }; // where the setter releases to

        const positions = ["P1", "P2", "P3", "P4", "P5", "P6"];
        // Passers cluster into a receive line, ordered left-to-right by their
        // natural court position, regardless of whether that spot is
        // currently front or back row.
        const passersSorted = [...layout.passerPositions].sort((a, b) => BASE_COORD[a].x - BASE_COORD[b].x);
        const RECEIVE_Y = 78;
        const RECEIVE_X = [22, 50, 78];

        const markers = positions.map((pos) => {
          const isLiberoSlot = pos === layout.backMBPos;
          const player = isLiberoSlot && layout.liberoPlayer ? layout.liberoPlayer : layout.playerAt[pos];
          const isPasser = layout.passerPositions.includes(pos);
          const isSetter = pos === layout.activeSetterPos;
          const isBackAttack = layout.backRowAttackPositions.includes(pos);
          let coord = BASE_COORD[pos];
          if (isPasser) {
            const idx = passersSorted.indexOf(pos);
            coord = { x: RECEIVE_X[idx], y: RECEIVE_Y };
          } else if (isSetter) {
            coord = NET_TARGET;
          }
          return { pos, player, isLiberoSlot, isPasser, isSetter, isBackAttack, coord, baseCoord: BASE_COORD[pos] };
        });

        return (
          <div
            onClick={() => setServeReceiveOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-end",
              zIndex: 10,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.bgRaised,
                width: "100%",
                borderRadius: "20px 20px 0 0",
                padding: 18,
                maxHeight: "85%",
                overflowY: "auto",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase" }}>
                  Serve-Receive — Rotation {previewRotation}
                </div>
                <button onClick={() => setServeReceiveOpen(false)} style={{ background: "none", border: "none", color: COLORS.chalkDim }}>
                  <X size={20} />
                </button>
              </div>
              <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 6 }}>
                {system}
                {isAlternate ? " · alternate pattern" : ""}
              </div>
              <div style={{ display: "flex", gap: 10, fontSize: 10, color: COLORS.chalkDim, marginBottom: 10 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.blue, display: "inline-block" }} />
                  Passer
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.gold, display: "inline-block" }} />
                  Setter (moves to net)
                </span>
              </div>

              <div
                style={{
                  position: "relative",
                  width: "100%",
                  aspectRatio: "0.82",
                  border: `1.5px solid ${COLORS.line}`,
                  borderRadius: 10,
                  background: COLORS.bg,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    borderTop: `3px solid ${COLORS.chalkDim}`,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    top: -14,
                    left: "50%",
                    transform: "translateX(-50%)",
                    fontSize: 8,
                    letterSpacing: 2,
                    color: COLORS.chalkDim,
                    textTransform: "uppercase",
                  }}
                >
                  Net
                </div>

                {/* Movement line: setter's rotational spot → net target */}
                {markers
                  .filter((m) => m.isSetter)
                  .map((m) => (
                    <svg key={`line-${m.pos}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                      <line
                        x1={`${m.baseCoord.x}%`}
                        y1={`${m.baseCoord.y}%`}
                        x2={`${m.coord.x}%`}
                        y2={`${m.coord.y}%`}
                        stroke={COLORS.gold}
                        strokeWidth="2"
                        strokeDasharray="4 3"
                      />
                    </svg>
                  ))}

                {markers.map((m) => {
                  const borderColor = m.isSetter ? COLORS.gold : m.isPasser ? COLORS.blue : COLORS.line;
                  const bg = m.isSetter ? "rgba(255,200,87,0.15)" : m.isPasser ? "rgba(62,124,166,0.15)" : COLORS.bgRaised;
                  return (
                    <div
                      key={m.pos}
                      style={{
                        position: "absolute",
                        left: `${m.coord.x}%`,
                        top: `${m.coord.y}%`,
                        transform: "translate(-50%, -50%)",
                        width: 62,
                        height: 62,
                        borderRadius: "50%",
                        border: `2px solid ${borderColor}`,
                        background: bg,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        textAlign: "center",
                      }}
                    >
                      {m.player ? (
                        <>
                          <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, fontWeight: 600, lineHeight: 1 }}>
                            #{m.player.num}
                          </span>
                          <span style={{ fontSize: 7, color: COLORS.chalkDim, marginTop: 1 }}>
                            {displayName(m.player)}
                          </span>
                          <span style={{ fontSize: 7, fontWeight: 700, color: borderColor, marginTop: 1 }}>
                            {m.isLiberoSlot ? "L" : m.player.position || ""}
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, color: COLORS.chalkDim }}>—</span>
                      )}
                      {m.isBackAttack && (
                        <span
                          style={{
                            position: "absolute",
                            top: -6,
                            right: -6,
                            fontSize: 7,
                            fontWeight: 700,
                            color: "#1C2128",
                            background: COLORS.green,
                            borderRadius: 4,
                            padding: "1px 3px",
                          }}
                        >
                          {system === "5-1" && m.player?.position === "OPP" ? "D" : "PIPE"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 10, color: COLORS.chalkDim, lineHeight: 1.5 }}>
                Setter releases to the net near position 2 after passing (dashed line shows the move).{" "}
                {isAlternate
                  ? "Alternate pattern: the front-row Outside stays at the net, and the Opposite drops back to pass instead."
                  : "The back-row Outside can hit a pipe."}
                {system === "5-1" && !isAlternate ? " If the Opposite is back row, that's a \"D\" ball." : ""}
              </div>
            </div>
          </div>
        );
      })()}

      {addingPairing && (
        <div
          onClick={() => setAddingPairing(false)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
            }}
          >
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 16,
                textTransform: "uppercase",
                marginBottom: 4,
              }}
            >
              Add Substitution Pairing
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 12 }}>
              Same roster spot, two players — one for front row, one for back row.
              One of them needs to currently be on the court, the other on the bench.
            </div>

            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Front-row player
            </label>
            <select
              value={pairingForm.frontId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setPairingForm((s) => ({ ...s, frontId: id, isLibero: liberos.includes(id) || liberos.includes(s.backId) }));
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 10,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">Select player…</option>
              {roster.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.num} {displayName(p)}{p.position ? ` (${p.position})` : ""}{liberos.includes(p.id) ? " · Libero" : ""} — {assignedIds.has(p.id) ? "On Court" : "Bench"}
                </option>
              ))}
            </select>

            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Back-row player {pairingForm.isLibero ? "(libero)" : ""}
            </label>
            <select
              value={pairingForm.backId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setPairingForm((s) => ({ ...s, backId: id, isLibero: liberos.includes(id) || liberos.includes(s.frontId) }));
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 10,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">Select player…</option>
              {roster.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.num} {displayName(p)}{p.position ? ` (${p.position})` : ""}{liberos.includes(p.id) ? " · Libero" : ""} — {assignedIds.has(p.id) ? "On Court" : "Bench"}
                </option>
              ))}
            </select>

            <button
              onClick={() => setPairingForm((s) => ({ ...s, isLibero: !s.isLibero }))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "none",
                border: "none",
                padding: 0,
                marginBottom: 14,
                color: COLORS.chalk,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: `1.5px solid ${pairingForm.isLibero ? COLORS.blue : COLORS.line}`,
                  background: pairingForm.isLibero ? COLORS.blue : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {pairingForm.isLibero && <Check size={11} color={COLORS.chalk} />}
              </span>
              This is a libero swap
            </button>

            {(() => {
              const err = pairingValidationError(pairingForm.frontId, pairingForm.backId);
              return err ? (
                <div style={{ fontSize: 11, color: COLORS.red, marginBottom: 10, marginTop: -4 }}>
                  {err}
                </div>
              ) : null;
            })()}

            <button
              onClick={() => {
                if (pairingValidationError(pairingForm.frontId, pairingForm.backId)) return;
                addPairing(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero);
                setPairingForm({ frontId: "", backId: "", isLibero: false });
                setAddingPairing(false);
              }}
              disabled={!!pairingValidationError(pairingForm.frontId, pairingForm.backId) || !pairingForm.frontId || !pairingForm.backId}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background:
                  pairingForm.frontId && pairingForm.backId && !pairingValidationError(pairingForm.frontId, pairingForm.backId)
                    ? COLORS.orange
                    : COLORS.line,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              Save Pairing
            </button>
          </div>
        </div>
      )}

      {playerSheet && (
        <div
          onClick={() => setPlayerSheet(null)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
            }}
          >
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 16,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              {playerSheet.mode === "edit" ? "Edit Player" : "Add Player to Roster"}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                placeholder="#"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                value={playerForm.num}
                onChange={(e) => setPlayerForm((s) => ({ ...s, num: e.target.value.replace(/[^0-9]/g, "") }))}
                style={{
                  width: 56,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
              <input
                placeholder="First name"
                value={playerForm.firstName}
                onChange={(e) => setPlayerForm((s) => ({ ...s, firstName: e.target.value }))}
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
              <input
                placeholder="Last name"
                value={playerForm.lastName}
                onChange={(e) => setPlayerForm((s) => ({ ...s, lastName: e.target.value }))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
            </div>
            {(() => {
              const trimmed = playerForm.num.trim();
              if (!trimmed) return null;
              const conflict = roster.find(
                (p) => String(p.num) === trimmed && (playerSheet.mode !== "edit" || p.id !== playerSheet.id)
              );
              return conflict ? (
                <div style={{ fontSize: 11, color: COLORS.gold, marginTop: -6, marginBottom: 10 }}>
                  ⚠ #{trimmed} is already used by {displayName(conflict)}. You can still save, but two
                  players with the same number can cause confusion at the scorer's table.
                </div>
              ) : null;
            })()}
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Position
            </label>
            <select
              value={playerForm.position}
              onChange={(e) => setPlayerForm((s) => ({ ...s, position: e.target.value }))}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 14,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">No position set</option>
              {POSITIONS.map((pos) => (
                <option key={pos.value} value={pos.value}>
                  {pos.label}
                </option>
              ))}
            </select>
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Secondary Position (optional)
            </label>
            <select
              value={playerForm.position2 || ""}
              onChange={(e) => setPlayerForm((s) => ({ ...s, position2: e.target.value }))}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 14,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">None</option>
              {POSITIONS.map((pos) => (
                <option key={pos.value} value={pos.value}>
                  {pos.label}
                </option>
              ))}
            </select>
            <button
              onClick={savePlayer}
              disabled={!playerForm.firstName.trim()}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background: playerForm.firstName.trim() ? COLORS.orange : COLORS.line,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {playerSheet.mode === "edit" ? "Save Changes" : "Add to Roster"}
            </button>
          </div>
        </div>
      )}

      {picking && (
        <div
          onClick={() => setPicking(null)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
              maxHeight: "60%",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontFamily: "'Oswald', sans-serif",
                  fontSize: 16,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {picking.type === "court" ? `Assign ${picking.slot}` : `Assign Libero ${picking.slot + 1}`}
              </span>
              <button
                onClick={() => setPicking(null)}
                style={{ background: "none", border: "none", color: COLORS.chalkDim }}
              >
                <X size={20} />
              </button>
            </div>
            {(picking.type === "court" ? slots[picking.slot] : liberos[picking.slot]) && (
              <button
                onClick={() => {
                  if (picking.type === "court") clearCourt(picking.slot);
                  else clearLibero(picking.slot);
                  setPicking(null);
                }}
                style={{
                  width: "100%",
                  padding: "10px",
                  marginBottom: 8,
                  background: "none",
                  border: `1px solid ${COLORS.red}`,
                  color: COLORS.red,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Clear position
              </button>
            )}
            {roster
              .filter((p) => {
                if (picking.type === "court") {
                  return !assignedIds.has(p.id) || slots[picking.slot] === p.id;
                }
                // Liberos are picked from the full roster, independent of court assignment
                return true;
              })
              .map((p) => {
                const isCurrent =
                  picking.type === "court"
                    ? slots[picking.slot] === p.id
                    : liberos[picking.slot] === p.id;
                const isCaptain = p.id === captainId;
                return (
                  <div
                    key={p.id}
                    onClick={() => assign(p.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 8px",
                      borderBottom: `1px solid ${COLORS.line}`,
                      color: COLORS.chalk,
                      fontSize: 14,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 600,
                        color: COLORS.orange,
                        width: 32,
                      }}
                    >
                      #{p.num}
                    </span>
                    <span style={{ flex: 1 }}>
                      {displayName(p)}
                      {p.position && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            color: COLORS.chalkDim,
                            border: `1px solid ${COLORS.line}`,
                            borderRadius: 4,
                            padding: "1px 4px",
                            marginLeft: 6,
                          }}
                        >
                          {p.position}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setCaptainId((cur) => (cur === p.id ? null : p.id));
                      }}
                      title="Toggle captain"
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        fontWeight: 700,
                        color: isCaptain ? "#1C2128" : COLORS.chalkDim,
                        background: isCaptain ? COLORS.gold : "transparent",
                        border: `1px solid ${isCaptain ? COLORS.gold : COLORS.line}`,
                        borderRadius: "50%",
                        width: 22,
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      C
                    </button>
                    {isCurrent && <Check size={16} color={COLORS.green} />}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Live stat entry screen ----
const FRONT_ROW_SLOTS = ["P2", "P3", "P4"];
const BACK_ROW_SLOTS = ["P1", "P5", "P6"];
const SUB_LIMIT = 18; // Massachusetts high school rule; NFHS default elsewhere is commonly 12

function LiveScreen({
  lineups,
  setLineups,
  activeLineupId,
  setActiveLineupId,
  roster,
  log,
  setLog,
  score,
  setScore,
  subCount,
  setSubCount,
  liberoSubCount,
  setLiberoSubCount,
  injuredPlayerIds,
  setInjuredPlayerIds,
  activeMatchId,
  pointLog,
  setPointLog,
  onStartNextSet,
  setTab,
}) {
  const [selectedSlot, setSelectedSlot] = useState("P1");
  const [subSheet, setSubSheet] = useState(null); // { slot, playerId } | null — free substitution sheet
  const [subReplacementId, setSubReplacementId] = useState("");
  const [markInjured, setMarkInjured] = useState(false);
  const [subSuggestions, setSubSuggestions] = useState([]);
  const [matchHistory, setMatchHistory] = useState([]); // stack of {slots, subCount, liberoSubCount, pairings, injuredPlayerIds, label} — undo for rotation/subs
  const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0];
  const setNumber = activeLineup.setNumber || 1;
  const slots = activeLineup.slots;
  const pairings = activeLineup.pairings || [];
  const playerFor = (id) => roster.find((p) => p.id === id);
  const currentPlayerId = slots[selectedSlot];
  const currentPlayer = currentPlayerId ? playerFor(currentPlayerId) : null;

  const recordStat = (statKey) => {
    if (!currentPlayerId) return;
    setLog((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        playerId: currentPlayerId,
        slot: selectedSlot,
        stat: statKey,
        matchId: activeMatchId ?? null,
        lineupId: activeLineup.id,
        setNumber,
      },
    ]);
  };

  const undoEntry = (entryId) => {
    setLog((prev) => prev.filter((e) => e.id !== entryId));
  };

  // Every point scored gets tagged with the rotation on the court at that
  // moment (identified by who's serving/P1, the standard convention), so
  // scoring can later be broken down by rotation, not just totaled up.
  // A decrement (correcting a mis-tap) removes the most recent matching
  // point for that team in this match rather than leaving a phantom entry.
  const recordPoint = (team, delta) => {
    if (delta > 0) {
      setPointLog((prev) => [
        ...prev,
        {
          id: Date.now() + Math.random(),
          matchId: activeMatchId ?? null,
          team,
          lineupId: activeLineup.id,
          serverPlayerId: activeLineup.slots.P1,
          setNumber,
        },
      ]);
    } else {
      setPointLog((prev) => {
        const idx = [...prev].reverse().findIndex((e) => e.team === team && (e.matchId ?? null) === (activeMatchId ?? null));
        if (idx === -1) return prev;
        const removeAt = prev.length - 1 - idx;
        return prev.filter((_, i) => i !== removeAt);
      });
    }
  };

  const setActiveSlots = (newSlots) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, slots: newSlots } : l)));
  };

  // Tracks which of the 6 rotations this lineup is currently sitting in, so
  // the Serve-Receive reference on the Lineup screen can automatically
  // highlight the right one instead of needing to be set by hand.
  const setActiveRotation = (n) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, currentRotation: n } : l)));
  };

  // Snapshot current match state before a rotation/sub/substitution action,
  // so it can be stepped back afterward — not just a single "undo last," but
  // a real stack. Includes pairings and injured status too, since a free
  // substitution (unlike a normal rotation or sub) can change both of those.
  const pushHistory = (label) => {
    setMatchHistory((prev) =>
      [
        ...prev,
        {
          slots,
          subCount,
          liberoSubCount,
          currentRotation: activeLineup.currentRotation || 1,
          pairings: activeLineup.pairings || [],
          injuredPlayerIds,
          label,
        },
      ].slice(-10)
    );
  };

  const undoMatchAction = () => {
    setMatchHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setActiveSlots(last.slots);
      setSubCount(last.subCount);
      setLiberoSubCount(last.liberoSubCount);
      setActiveRotation(last.currentRotation || 1);
      if (last.pairings) {
        setLineups((prev2) => prev2.map((l) => (l.id === activeLineup.id ? { ...l, pairings: last.pairings } : l)));
      }
      if (last.injuredPlayerIds) setInjuredPlayerIds(last.injuredPlayerIds);
      setSubSuggestions([]); // pending suggestions were computed against state that no longer applies
      return prev.slice(0, -1);
    });
  };

  // Free substitution — any bench player in for any on-court player, for any
  // reason (injury, a short serve-specialist swap, anything else), unlike
  // the pairing-suggested subs which only fire when a specific rotation is
  // reached. Doesn't count against the normal sub limit. The replacement
  // fully takes over the outgoing player's role in any pairing they were
  // part of (either side — starter or sub), so future rotations keep working
  // correctly without needing the pairing rebuilt by hand. Subbing a player
  // back in this same way automatically clears their injured tag, since
  // that's literally the "they've recovered" action.
  const confirmFreeSubstitution = () => {
    if (!subSheet || !subReplacementId) return;
    const outgoingId = subSheet.playerId;
    const incomingId = subReplacementId;
    pushHistory(`Sub: #${playerFor(outgoingId)?.num} out, #${playerFor(incomingId)?.num} in`);
    setActiveSlots({ ...slots, [subSheet.slot]: incomingId });
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id
          ? {
              ...l,
              pairings: (l.pairings || []).map((pr) => ({
                ...pr,
                frontId: pr.frontId === outgoingId ? incomingId : pr.frontId,
                backId: pr.backId === outgoingId ? incomingId : pr.backId,
              })),
            }
          : l
      )
    );
    setInjuredPlayerIds((prev) => {
      let next = prev.filter((id) => id !== incomingId); // coming back in clears their injured tag
      if (markInjured && !next.includes(outgoingId)) next = [...next, outgoingId];
      return next;
    });
    setSubSheet(null);
    setSubReplacementId("");
    setMarkInjured(false);
  };

  // Rotate all 6 court positions one clockwise step: P1<-P2, P2<-P3, P3<-P4, P4<-P5, P5<-P6, P6<-P1
  const advanceRotation = () => {
    pushHistory("Rotation advanced");
    const rotated = {
      P1: slots.P2,
      P2: slots.P3,
      P3: slots.P4,
      P4: slots.P5,
      P5: slots.P6,
      P6: slots.P1,
    };
    setActiveSlots(rotated);
    setActiveRotation(((activeLineup.currentRotation || 1) % 6) + 1);

    // Check pairings against the new rotation: anyone in the wrong row for their designated role?
    const suggestions = [];
    pairings.forEach((pr) => {
      const frontSlot = Object.keys(rotated).find((s) => rotated[s] === pr.frontId);
      const backSlot = Object.keys(rotated).find((s) => rotated[s] === pr.backId);
      if (frontSlot && BACK_ROW_SLOTS.includes(frontSlot)) {
        suggestions.push({
          id: Date.now() + Math.random(),
          slot: frontSlot,
          outId: pr.frontId,
          inId: pr.backId,
          isLibero: pr.isLibero,
        });
      } else if (backSlot && FRONT_ROW_SLOTS.includes(backSlot)) {
        suggestions.push({
          id: Date.now() + Math.random(),
          slot: backSlot,
          outId: pr.backId,
          inId: pr.frontId,
          isLibero: pr.isLibero,
        });
      }
    });
    setSubSuggestions(suggestions);
  };

  const confirmSuggestion = (sug) => {
    const out = playerFor(sug.outId);
    const inP = playerFor(sug.inId);
    pushHistory(`Sub: ${displayName(inP)} in for ${displayName(out)} (${sug.slot})`);
    setActiveSlots({ ...slots, [sug.slot]: sug.inId });
    setSubSuggestions((prev) => prev.filter((s) => s.id !== sug.id));
    if (sug.isLibero) {
      setLiberoSubCount((c) => c + 1);
    } else {
      setSubCount((c) => c + 1);
    }
  };

  const dismissSuggestion = (id) => {
    setSubSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  const recent = [...log].slice(-5).reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Score bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 20px",
          background: COLORS.bgRaised,
          borderBottom: `1px solid ${COLORS.line}`,
        }}
      >
        <ScoreCounter
          label="US"
          value={score.us}
          onChange={(d) => {
            setScore((s) => ({ ...s, us: Math.max(0, s.us + d) }));
            recordPoint("us", d);
          }}
          color={COLORS.orange}
        />
        <div style={{ fontSize: 11, color: COLORS.chalkDim, textAlign: "center" }}>
          SET {setNumber}
        </div>
        <ScoreCounter
          label="OPP"
          value={score.opp}
          onChange={(d) => {
            setScore((s) => ({ ...s, opp: Math.max(0, s.opp + d) }));
            recordPoint("opp", d);
          }}
          color={COLORS.blue}
        />
      </div>

      {/* Sub counter */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 20px 0",
          fontSize: 11,
        }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          <span
            style={{
              color:
                subCount >= SUB_LIMIT ? COLORS.red : subCount >= SUB_LIMIT - 4 ? COLORS.gold : COLORS.chalkDim,
              fontWeight: subCount >= SUB_LIMIT - 4 ? 700 : 500,
            }}
          >
            Subs: {subCount}/{SUB_LIMIT}
          </span>
          <span style={{ color: COLORS.chalkDim }}>Libero swaps: {liberoSubCount}</span>
        </div>
      </div>
      {subCount >= SUB_LIMIT && (
        <div style={{ padding: "4px 20px 0", fontSize: 10, color: COLORS.red }}>
          Sub limit reached for this set — confirming another sub will flag it as over the limit.
        </div>
      )}

      {/* Advance rotation - swipe (capped at 2/3 screen width, not full-width)
          to avoid a mid-play accidental tap - undo sits right-justified in
          the same row instead of taking its own row below. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 20px 0",
        }}
      >
        <div style={{ width: "66%" }}>
          <SwipeConfirm label="Swipe to Advance Rotation" color={COLORS.blue} onConfirm={advanceRotation} height={30} />
        </div>
        <button
          onClick={undoMatchAction}
          disabled={matchHistory.length === 0}
          title={matchHistory.length > 0 ? `Undo: ${matchHistory[matchHistory.length - 1].label}` : "Nothing to undo"}
          style={{
            width: 58,
            height: 26,
            borderRadius: 10,
            border: `1.5px solid ${COLORS.line}`,
            background: "none",
            color: COLORS.chalkDim,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: matchHistory.length === 0 ? 0.35 : 1,
          }}
        >
          <Undo2 size={16} />
        </button>
      </div>

      {/* Start Next Set — a direct swipe like Advance Rotation, deliberately
          grouped down here rather than up near the score buttons, since a
          mis-tap there was landing dangerously close to resetting the set. */}
      <div style={{ padding: "8px 20px 0" }}>
        <SwipeConfirm
          label={`Swipe to Start Set ${(activeLineup.setNumber || 1) + 1}`}
          color={COLORS.red}
          height={30}
          onConfirm={() => {
            const nextSetNumber = (activeLineup.setNumber || 1) + 1;
            const nextLineup = lineups.find((l) => l.setNumber === nextSetNumber);
            if (!nextLineup) {
              alert(`The lineup for Set ${nextSetNumber} needs to be created — create or duplicate a lineup on the Lineup screen first.`);
              return;
            }
            onStartNextSet();
          }}
        />
      </div>

      {/* Suggested substitutions from pairings, tied to the new rotation */}
      {subSuggestions.length > 0 && (
        <div style={{ padding: "8px 20px 0" }}>
          {subSuggestions.map((sug) => {
            const out = playerFor(sug.outId);
            const inP = playerFor(sug.inId);
            const overLimit = !sug.isLibero && subCount >= SUB_LIMIT;
            return (
              <div
                key={sug.id}
                style={{
                  background: "rgba(255,200,87,0.10)",
                  border: `1.5px solid ${overLimit ? COLORS.red : COLORS.gold}`,
                  borderRadius: 10,
                  padding: "10px 10px",
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
                  {sug.isLibero && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: COLORS.gold,
                        border: `1px solid ${COLORS.gold}`,
                        borderRadius: 4,
                        padding: "1px 4px",
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      LIBERO
                    </span>
                  )}
                  {/* Each player's info kept together on its own line, not
                      run together mid-sentence with the other player's. */}
                  <div style={{ color: COLORS.chalk, flex: 1, lineHeight: 1.5 }}>
                    <div>
                      Sub in: <b>#{inP?.num} {displayName(inP)}</b>
                    </div>
                    <div>
                      For: <b>#{out?.num} {displayName(out)}</b> ({sug.slot})
                    </div>
                    {overLimit && <div style={{ color: COLORS.red, fontWeight: 700 }}>Over sub limit</div>}
                  </div>
                  <button
                    onClick={() => dismissSuggestion(sug.id)}
                    style={{ background: "none", border: "none", color: COLORS.chalkDim, flexShrink: 0 }}
                  >
                    <X size={14} />
                  </button>
                </div>
                {/* Checkbox instead of swipe — swipes were hard to trigger
                    reliably on a phone for this smaller, secondary action. */}
                <button
                  onClick={() => confirmSuggestion(sug)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1.5px solid ${overLimit ? COLORS.red : COLORS.gold}`,
                    background: "none",
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `1.5px solid ${overLimit ? COLORS.red : COLORS.gold}`,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: COLORS.chalk, fontSize: 12, fontWeight: 700 }}>
                    {overLimit ? "Confirm Sub (Over Limit)" : "Confirm Sub"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Active lineup — read-only here. Switching which lineup is active
          only ever happens on the Lineup screen now, so a stray tap during
          play can't silently move stats onto the wrong set. */}
      <button
        onClick={() => setTab("lineup")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "8px 20px",
          background: "none",
          border: "none",
          borderBottom: `1px solid ${COLORS.line}`,
        }}
      >
        <span style={{ fontSize: 12, color: COLORS.chalkDim }}>
          Lineup: <b style={{ color: COLORS.chalk }}>{activeLineup.name}</b>
        </span>
        <span style={{ fontSize: 11, color: COLORS.chalkDim }}>Change on Lineup screen →</span>
      </button>

      {/* Rotation strip - tap to select who the next stat belongs to.
          Same 2-row court arrangement as the Lineup screen's diagram, so the
          layout reads the same in both places instead of a flat scrolling row. */}
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `"p4 p3 p2" "p5 p6 p1"`,
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 6,
          padding: "8px 20px",
          borderBottom: `1px solid ${COLORS.line}`,
        }}
      >
        {COURT_LAYOUT.map(({ slot, gridArea }) => {
          const pid = slots[slot];
          const p = pid ? playerFor(pid) : null;
          const active = selectedSlot === slot;
          return (
            <div
              key={slot}
              onClick={() => setSelectedSlot(slot)}
              style={{
                gridArea,
                position: "relative",
                padding: "5px 8px",
                borderRadius: 8,
                border: `1.5px solid ${active ? COLORS.orange : COLORS.line}`,
                background: active ? "rgba(255,107,53,0.15)" : "transparent",
                color: COLORS.chalk,
                display: "flex",
                alignItems: "center",
              }}
            >
              <span style={{ flex: "0 0 14px", fontSize: 8, color: COLORS.chalkDim, textAlign: "left" }}>
                {slot}
              </span>
              <span style={{ flex: 1, textAlign: "center", fontFamily: "'Oswald', sans-serif", fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
                {p ? `#${p.num}` : "—"}
              </span>
              <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "flex-end", textAlign: "right" }}>
                {p && (
                  <span style={{ fontSize: 8, color: COLORS.chalkDim, whiteSpace: "nowrap" }}>
                    {displayName(p)}
                  </span>
                )}
                {p?.position && (
                  <span style={{ fontSize: 7, fontWeight: 700, color: active ? COLORS.orange : COLORS.chalkDim }}>
                    {p.position}
                  </span>
                )}
              </div>
              {p && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSubSheet({ slot, playerId: pid });
                    setSubReplacementId("");
                    setMarkInjured(false);
                  }}
                  title="Substitute this player"
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    border: `1px solid ${COLORS.line}`,
                    background: COLORS.bgRaised,
                    color: COLORS.chalkDim,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                  }}
                >
                  <Repeat size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Selected player banner */}
      <div
        style={{
          padding: "6px 20px",
          fontSize: 13,
          color: COLORS.chalkDim,
        }}
      >
        Recording for{" "}
        <span style={{ color: COLORS.chalk, fontWeight: 700 }}>
          {currentPlayer
            ? `#${currentPlayer.num} ${displayName(currentPlayer)}${currentPlayer.position ? ` (${currentPlayer.position})` : ""}`
            : "no one assigned"}
        </span>
      </div>

      {/* Stat buttons - 3 columns, grouped by action (Serve/Attack/Reception/
          Block) via STAT_BUTTONS order rather than by outcome, so related
          buttons for the same play sit together */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 20px 10px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          rowGap: 12,
          columnGap: 8,
          alignContent: "start",
        }}
      >
        {STAT_BUTTONS.map((s) => (
          <button
            key={s.key}
            disabled={!currentPlayerId}
            onClick={() => recordStat(s.key)}
            style={{
              padding: "12px 4px",
              borderRadius: 10,
              border: `1.5px solid ${s.color}`,
              background: `${s.color}22`,
              color: COLORS.chalk,
              fontSize: 11,
              fontWeight: 700,
              textAlign: "center",
              opacity: currentPlayerId ? 1 : 0.4,
              cursor: currentPlayerId ? "pointer" : "not-allowed",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Undo tray - always visible, last 5 entries individually reversible */}
      <div
        style={{
          borderTop: `1px solid ${COLORS.line}`,
          background: COLORS.bgRaised,
          padding: "10px 16px 14px",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: COLORS.chalkDim,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Undo2 size={12} /> Recent entries — tap to undo
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {recent.length === 0 && (
            <span style={{ fontSize: 11, color: COLORS.chalkDim }}>No entries yet</span>
          )}
          {recent.map((e) => {
            const p = playerFor(e.playerId);
            return (
              <button
                key={e.id}
                onClick={() => undoEntry(e.id)}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: `1px solid ${COLORS.line}`,
                  background: COLORS.bg,
                  color: COLORS.chalk,
                  fontSize: 11,
                }}
              >
                <span style={{ color: COLORS.chalkDim }}>#{p?.num}</span>
                {STAT_LABELS[e.stat]}
                <X size={12} color={COLORS.red} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Free substitution — any bench player in for any on-court player,
          any reason. Reached via the small swap icon on each court position. */}
      {subSheet && (() => {
        const outgoing = playerFor(subSheet.playerId);
        const onCourtIds = new Set(Object.values(slots).filter(Boolean));
        const liberoIds = (activeLineup.liberos || []).filter(Boolean);
        const bench = roster.filter((p) => !onCourtIds.has(p.id) && !liberoIds.includes(p.id));
        return (
          <div
            onClick={() => setSubSheet(null)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-end",
              zIndex: 10,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.bgRaised,
                width: "100%",
                borderRadius: "20px 20px 0 0",
                padding: 18,
                maxHeight: "80%",
                overflowY: "auto",
              }}
            >
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase", marginBottom: 4 }}>
                Substitute
              </div>
              <div style={{ fontSize: 12, color: COLORS.chalkDim, marginBottom: 14 }}>
                Out: #{outgoing?.num} {displayName(outgoing)} · doesn't count against your sub limit
              </div>
              <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Bringing In
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {bench.length === 0 && (
                  <div style={{ fontSize: 12, color: COLORS.chalkDim }}>No bench players available.</div>
                )}
                {bench.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSubReplacementId(p.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 10px",
                      borderRadius: 8,
                      border: `1.5px solid ${subReplacementId === p.id ? COLORS.orange : COLORS.line}`,
                      background: subReplacementId === p.id ? "rgba(255,107,53,0.15)" : "transparent",
                      color: COLORS.chalk,
                      fontSize: 13,
                    }}
                  >
                    <span>
                      #{p.num} {displayName(p)} {p.position ? `(${p.position})` : ""}
                    </span>
                    {injuredPlayerIds.includes(p.id) && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 4, padding: "1px 5px" }}>
                        OUT
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setMarkInjured((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  background: "none",
                  border: "none",
                  padding: "6px 0",
                  marginBottom: 14,
                  color: COLORS.chalkDim,
                  fontSize: 12,
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1.5px solid ${markInjured ? COLORS.red : COLORS.line}`,
                    background: markInjured ? COLORS.red : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {markInjured && <Check size={11} color={COLORS.chalk} />}
                </span>
                Mark #{outgoing?.num} {displayName(outgoing)} as injured (just a visual reminder — doesn't block them from returning)
              </button>
              <button
                onClick={confirmFreeSubstitution}
                disabled={!subReplacementId}
                style={{
                  width: "100%",
                  padding: "11px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.green}`,
                  background: subReplacementId ? "rgba(76,154,99,0.15)" : "transparent",
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  opacity: subReplacementId ? 1 : 0.5,
                }}
              >
                Confirm Substitution
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Full-width swipe-to-confirm control, for state-changing actions during live play
// (rotation, substitution, new set) that would be a real nuisance if mid-tapped.
function SwipeConfirm({ label, color, onConfirm, disabled, height = 20 }) {
  const trackRef = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const knobSize = height - 4;

  const handlePointerDown = (e) => {
    if (disabled) return;
    setDragging(true);
    e.target.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!dragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const maxDrag = rect.width - knobSize - 4;
    const delta = e.clientX - rect.left - knobSize / 2 - 2;
    setDragX(Math.max(0, Math.min(delta, maxDrag)));
  };

  const finishDrag = () => {
    if (!dragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const maxDrag = rect.width - knobSize - 4;
    setDragging(false);
    if (dragX >= maxDrag * 0.75) {
      onConfirm();
    }
    setDragX(0);
  };

  const progress = trackRef.current
    ? dragX / Math.max(1, trackRef.current.getBoundingClientRect().width - knobSize - 4)
    : 0;

  return (
    <div
      ref={trackRef}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
      style={{
        position: "relative",
        height,
        borderRadius: height / 2,
        background: `rgba(${color === COLORS.gold ? "255,200,87" : color === COLORS.red ? "193,68,60" : "62,124,166"},${0.1 + progress * 0.2})`,
        border: `1.5px solid ${color}`,
        overflow: "hidden",
        opacity: disabled ? 0.4 : 1,
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          fontSize: 10,
          fontWeight: 700,
          color: COLORS.chalk,
          pointerEvents: "none",
        }}
      >
        {label}
      </div>
      <div
        onPointerDown={handlePointerDown}
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          width: knobSize,
          height: knobSize,
          borderRadius: "50%",
          background: color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateX(${dragX}px)`,
          transition: dragging ? "none" : "transform 0.18s ease-out",
          cursor: disabled ? "default" : "grab",
        }}
      >
        <ChevronsRight size={Math.max(14, knobSize - 20)} color="#1C2128" />
      </div>
    </div>
  );
}

function ScoreCounter({ label, value, onChange, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 10, color: COLORS.chalkDim, letterSpacing: 0.5 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={() => onChange(-1)}
          style={{
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${COLORS.line}`,
            borderRadius: "50%",
            color: COLORS.chalk,
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Minus size={20} />
        </button>
        <span
          style={{
            fontFamily: "'Oswald', sans-serif",
            fontSize: 30,
            fontWeight: 700,
            color,
            minWidth: 36,
            textAlign: "center",
          }}
        >
          {value}
        </span>
        <button
          onClick={() => onChange(1)}
          style={{
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${COLORS.line}`,
            borderRadius: "50%",
            color: COLORS.chalk,
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Plus size={20} />
        </button>
      </div>
    </div>
  );
}

// ---- Box score screen: current match, a specific past match, or full season ----
function BoxScoreScreen({ log, setLog, roster, matches, lineups, activeMatchId, statsView, setStatsView, pointLog, trendSubject, setTrendSubject, onEndMatch }) {
  const section = statsView?.section || "boxscore";
  const insightsMatchId = statsView?.insightsMatchId ?? null;
  const [editMode, setEditMode] = useState(false);

  const setSection = (s) => setStatsView((prev) => ({ ...(prev || {}), section: s }));
  const selectInsightsMatch = (matchId) => setStatsView((prev) => ({ ...(prev || {}), section: "insights", insightsMatchId: matchId }));
  const backToInsightsList = () => setStatsView((prev) => ({ ...(prev || {}), insightsMatchId: null }));

  const groupByPlayer = (entries) => {
    const byPlayer = {};
    for (const e of entries) {
      if (!byPlayer[e.playerId]) byPlayer[e.playerId] = {};
      byPlayer[e.playerId][e.stat] = (byPlayer[e.playerId][e.stat] || 0) + 1;
    }
    return Object.entries(byPlayer)
      .map(([pid, stats]) => ({ player: roster.find((p) => p.id === Number(pid)), stats }))
      .filter((r) => r.player);
  };

  // --- Box Score: current match only, kept simple — the plain per-player table ---
  const activeMatch = activeMatchId != null ? matches.find((m) => m.id === activeMatchId) : null;
  const boxLog = useMemo(
    () => log.filter((e) => (e.matchId ?? null) === (activeMatchId ?? null)),
    [log, activeMatchId]
  );
  const boxRows = useMemo(() => groupByPlayer(boxLog), [boxLog, roster]);

  // --- Insights: pick any match (current or past) for its breakdowns ---
  const insightsMatch = insightsMatchId != null ? matches.find((m) => m.id === insightsMatchId) : null;
  const insightsLog = useMemo(
    () => (insightsMatchId == null ? [] : log.filter((e) => (e.matchId ?? null) === insightsMatchId)),
    [log, insightsMatchId]
  );
  const insightsRows = useMemo(() => groupByPlayer(insightsLog), [insightsLog, roster]);

  const matchInsights = useMemo(() => {
    if (insightsRows.length === 0) return null;
    const totals = {};
    insightsRows.forEach((r) => Object.entries(r.stats).forEach(([k, v]) => (totals[k] = (totals[k] || 0) + v)));
    const leaders = {};
    ["kill", "dig", "ace", "assist"].forEach((key) => {
      let best = null;
      insightsRows.forEach((r) => {
        const v = r.stats[key] || 0;
        if (v > 0 && (!best || v > best.value)) best = { player: r.player, value: v };
      });
      if (best) leaders[key] = best;
    });
    return { totals, leaders };
  }, [insightsRows]);

  const lineupBreakdown = useMemo(() => {
    if (insightsLog.length === 0) return [];
    const byLineup = {};
    insightsLog.forEach((e) => {
      const key = e.lineupId ?? "unknown";
      if (!byLineup[key]) byLineup[key] = {};
      byLineup[key][e.stat] = (byLineup[key][e.stat] || 0) + 1;
    });
    return Object.entries(byLineup).map(([lineupId, stats]) => {
      const lineup = lineups.find((l) => l.id === Number(lineupId));
      const kills = stats.kill || 0;
      const errors = (stats.attackErr || 0) + (stats.serveErr || 0) + (stats.recErr || 0) + (stats.blockErr || 0) + (stats.passingErr || 0);
      return { name: lineup ? lineup.name : "Before tracking (no lineup tagged)", stats, kills, errors };
    });
  }, [insightsLog, lineups]);

  const rotationBreakdown = useMemo(() => {
    if (insightsMatchId == null) return [];
    const relevant = pointLog.filter((e) => (e.matchId ?? null) === insightsMatchId);
    if (relevant.length === 0) return [];
    const byServer = {};
    relevant.forEach((e) => {
      const key = e.serverPlayerId ?? "unknown";
      if (!byServer[key]) byServer[key] = { us: 0, opp: 0 };
      byServer[key][e.team] += 1;
    });
    return Object.entries(byServer)
      .map(([playerId, counts]) => {
        const player = playerId !== "unknown" ? roster.find((p) => p.id === Number(playerId)) : null;
        return { player, ...counts, diff: counts.us - counts.opp };
      })
      .sort((a, b) => b.diff - a.diff);
  }, [pointLog, insightsMatchId, roster]);

  // Matches available to pick in Insights: anything with recorded stats or
  // points, plus the active match even before it has any data yet.
  const insightsMatchList = useMemo(() => {
    const withData = new Set(log.map((e) => e.matchId).filter((id) => id != null));
    pointLog.forEach((e) => {
      if (e.matchId != null) withData.add(e.matchId);
    });
    if (activeMatchId != null) withData.add(activeMatchId);
    return matches.filter((m) => withData.has(m.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [matches, log, pointLog, activeMatchId]);

  // --- Trends: every match with data, filtered to team/player/lineup, over time ---
  const trendMatches = useMemo(() => {
    const withData = matches.filter((m) => log.some((e) => e.matchId === m.id));
    return [...withData].sort((a, b) => (a.date > b.date ? 1 : -1));
  }, [matches, log]);

  const trendData = useMemo(() => {
    return trendMatches.map((m) => {
      const entries = log.filter((e) => {
        if (e.matchId !== m.id) return false;
        if (trendSubject === "team") return true;
        if (trendSubject.startsWith("player:")) return e.playerId === Number(trendSubject.slice(7));
        if (trendSubject.startsWith("lineup:")) return e.lineupId === Number(trendSubject.slice(7));
        return true;
      });
      const stats = {};
      entries.forEach((e) => (stats[e.stat] = (stats[e.stat] || 0) + 1));
      return { match: m, stats };
    });
  }, [trendMatches, log, trendSubject]);

  // --- Season to date: everything, all matches combined ---
  const seasonRows = useMemo(() => groupByPlayer(log), [log, roster]);

  const exportCSV = (rowsToExport, filename) => {
    const statKeys = STAT_BUTTONS.map((s) => s.key);
    const header = ["Number", "Name", ...STAT_BUTTONS.map((s) => s.label)];
    const csvRows = rowsToExport.map(({ player, stats }) => [
      player.num,
      fullName(player),
      ...statKeys.map((k) => stats[k] || 0),
    ]);
    downloadCSV(filename.replace(/\s+/g, "-").toLowerCase(), header, csvRows);
  };

  const sectionBtn = (key, label) => (
    <button
      onClick={() => setSection(key)}
      style={{
        padding: "9px 4px",
        borderRadius: 8,
        border: `1.5px solid ${section === key ? COLORS.orange : COLORS.line}`,
        background: section === key ? "rgba(255,107,53,0.15)" : "transparent",
        color: COLORS.chalk,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {label}
    </button>
  );

  const removeStatEntry = (playerId, statKey) => {
    setLog((prev) => {
      const idx = prev.findIndex((e) => e.playerId === playerId && e.stat === statKey && (e.matchId ?? null) === (activeMatchId ?? null));
      if (idx === -1) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
  };

  const RawTable = ({ rows, exportName, editable, editMode }) => (
    <>
      {rows.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button
            onClick={() => exportCSV(rows, exportName)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: `1px solid ${COLORS.line}`,
              borderRadius: 6,
              padding: "4px 8px",
              color: COLORS.chalkDim,
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            <ClipboardPaste size={11} /> Export CSV
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
          No stats recorded yet.
        </div>
      ) : (
        rows.map(({ player, stats }) => (
          <div
            key={player.id}
            style={{
              background: COLORS.bgRaised,
              border: `1px solid ${COLORS.line}`,
              borderRadius: 10,
              padding: 12,
              marginBottom: 10,
            }}
          >
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              #{player.num} {displayName(player)}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(stats).map(([key, count]) =>
                editable && editMode ? (
                  <button
                    key={key}
                    onClick={() => removeStatEntry(player.id, key)}
                    title="Tap to remove one"
                    style={{
                      fontSize: 11,
                      padding: "3px 8px",
                      borderRadius: 6,
                      background: "rgba(193,68,60,0.15)",
                      border: `1px solid ${COLORS.red}`,
                      color: COLORS.chalk,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {STAT_LABELS[key]} <b>{count}</b>
                    <X size={10} />
                  </button>
                ) : (
                  <span
                    key={key}
                    style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: COLORS.bg, color: COLORS.chalkDim }}
                  >
                    {STAT_LABELS[key]} <b style={{ color: COLORS.chalk }}>{count}</b>
                  </span>
                )
              )}
            </div>
          </div>
        ))
      )}
    </>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, marginBottom: 16 }}>
        {sectionBtn("boxscore", "Box Score")}
        {sectionBtn("insights", "Insights")}
        {sectionBtn("trends", "Trends")}
        {sectionBtn("season", "Season to Date")}
      </div>

      {section === "boxscore" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
              {activeMatch ? `vs. ${activeMatch.opponent}${activeMatch.date ? ` · ${activeMatch.date}` : ""}` : "Current match"}
            </div>
            <button
              onClick={() => setEditMode((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: editMode ? "rgba(255,107,53,0.15)" : "none",
                border: `1px solid ${editMode ? COLORS.orange : COLORS.line}`,
                borderRadius: 6,
                padding: "4px 8px",
                color: COLORS.chalk,
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              <Pencil size={11} /> {editMode ? "Done Editing" : "Edit"}
            </button>
          </div>
          {editMode && (
            <div style={{ fontSize: 10, color: COLORS.chalkDim, marginBottom: 10 }}>
              Tap a stat to remove one instance of it for that player.
            </div>
          )}
          <RawTable
            rows={boxRows}
            exportName={`box-score-${activeMatch ? activeMatch.opponent : "current"}.csv`}
            editable
            editMode={editMode}
          />
          {activeMatchId && (
            <button
              onClick={() => {
                if (window.confirm("End this match? Resets the live scoreboard, sub counts, and every lineup's rotation back to 1 for whatever comes next. Stats already recorded stay exactly as they are.")) {
                  onEndMatch();
                }
              }}
              style={{
                width: "100%",
                marginTop: 14,
                padding: "10px",
                borderRadius: 8,
                border: `1.5px solid ${COLORS.red}`,
                background: "rgba(193,68,60,0.12)",
                color: COLORS.chalk,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              End Match
            </button>
          )}
        </>
      )}

      {section === "insights" && insightsMatchId == null && (
        <>
          {insightsMatchList.length === 0 ? (
            <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
              No matches with recorded stats yet.
            </div>
          ) : (
            insightsMatchList.map((m) => (
              <button
                key={m.id}
                onClick={() => selectInsightsMatch(m.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: COLORS.bgRaised,
                  border: `1px solid ${m.id === activeMatchId ? COLORS.gold : COLORS.line}`,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 8,
                  color: COLORS.chalk,
                }}
              >
                {m.id === activeMatchId && (
                  <div style={{ fontSize: 9, fontWeight: 700, color: COLORS.gold, marginBottom: 2 }}>ACTIVE MATCH</div>
                )}
                <div style={{ fontSize: 11, color: COLORS.chalkDim }}>{m.date || "No date"}</div>
                <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 600 }}>vs. {m.opponent}</div>
              </button>
            ))
          )}
        </>
      )}

      {section === "insights" && insightsMatchId != null && (
        <>
          <button
            onClick={backToInsightsList}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: "none",
              color: COLORS.chalkDim,
              fontSize: 12,
              fontWeight: 700,
              marginBottom: 10,
              padding: 0,
            }}
          >
            <Undo2 size={13} /> All Matches
          </button>
          <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
            vs. {insightsMatch?.opponent}
            {insightsMatch?.date ? ` · ${insightsMatch.date}` : ""}
          </div>

          {matchInsights ? (
            <div
              style={{
                background: COLORS.bgRaised,
                border: `1px solid ${COLORS.gold}`,
                borderRadius: 10,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.gold, letterSpacing: 0.5, marginBottom: 8 }}>
                MATCH INSIGHTS
              </div>
              <div style={{ fontSize: 12, color: COLORS.chalk, marginBottom: 8 }}>
                {STAT_BUTTONS.filter((s) => matchInsights.totals[s.key]).map((s) => (
                  <span key={s.key} style={{ marginRight: 12 }}>
                    {s.label}: <b>{matchInsights.totals[s.key]}</b>
                  </span>
                ))}
              </div>
              {Object.keys(matchInsights.leaders).length > 0 && (
                <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
                  {Object.entries(matchInsights.leaders).map(([key, l]) => (
                    <div key={key}>
                      {STAT_LABELS[key]} leader: #{l.player.num} {displayName(l.player)} ({l.value})
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 20, marginBottom: 20 }}>
              No stats recorded for this match yet.
            </div>
          )}

          {lineupBreakdown.length > 0 && (
            <div
              style={{
                background: COLORS.bgRaised,
                border: `1px solid ${COLORS.blue}`,
                borderRadius: 10,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.blue, letterSpacing: 0.5, marginBottom: 8 }}>
                BY LINEUP
              </div>
              {lineupBreakdown.map((lb, i) => (
                <div key={i} style={{ marginBottom: i < lineupBreakdown.length - 1 ? 8 : 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.chalk }}>{lb.name}</div>
                  <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
                    Kills: <b style={{ color: COLORS.chalk }}>{lb.kills}</b> · Errors:{" "}
                    <b style={{ color: COLORS.chalk }}>{lb.errors}</b> · Diff:{" "}
                    <b style={{ color: lb.kills - lb.errors >= 0 ? COLORS.green : COLORS.red }}>
                      {lb.kills - lb.errors >= 0 ? "+" : ""}
                      {lb.kills - lb.errors}
                    </b>
                  </div>
                </div>
              ))}
            </div>
          )}

          {rotationBreakdown.length > 0 && (
            <div
              style={{
                background: COLORS.bgRaised,
                border: `1px solid ${COLORS.green}`,
                borderRadius: 10,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.green, letterSpacing: 0.5, marginBottom: 8 }}>
                BY ROTATION (SERVER)
              </div>
              {rotationBreakdown.map((rb, i) => (
                <div key={i} style={{ marginBottom: i < rotationBreakdown.length - 1 ? 6 : 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.chalk }}>
                    {rb.player ? `#${rb.player.num} ${displayName(rb.player)}` : "Before tracking"}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
                    Us: <b style={{ color: COLORS.chalk }}>{rb.us}</b> · Opp:{" "}
                    <b style={{ color: COLORS.chalk }}>{rb.opp}</b> · Diff:{" "}
                    <b style={{ color: rb.diff >= 0 ? COLORS.green : COLORS.red }}>
                      {rb.diff >= 0 ? "+" : ""}
                      {rb.diff}
                    </b>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {section === "trends" && (
        <>
          <select
            value={trendSubject}
            onChange={(e) => setTrendSubject(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              marginBottom: 16,
              background: COLORS.bgRaised,
              border: `1px solid ${COLORS.line}`,
              borderRadius: 8,
              color: COLORS.chalk,
              fontSize: 13,
            }}
          >
            <option value="team">Team Totals</option>
            <optgroup label="Players">
              {roster.map((p) => (
                <option key={p.id} value={`player:${p.id}`}>
                  #{p.num} {displayName(p)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Lineups">
              {lineups.map((l) => (
                <option key={l.id} value={`lineup:${l.id}`}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          </select>

          {trendMatches.length === 0 ? (
            <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
              No matches with recorded stats yet — trends will show up here once you've logged a
              few matches.
            </div>
          ) : (
            STAT_BUTTONS.map((s) => {
              const values = trendData.map((d) => d.stats[s.key] || 0);
              const max = Math.max(1, ...values);
              if (values.every((v) => v === 0)) return null;
              return (
                <div key={s.key} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.chalkDim, marginBottom: 6 }}>
                    {s.label}
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 56 }}>
                    {trendData.map((d, i) => (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <div style={{ fontSize: 10, color: COLORS.chalk, marginBottom: 3 }}>{values[i] || ""}</div>
                        <div
                          style={{
                            width: "100%",
                            height: Math.max(3, (values[i] / max) * 40),
                            background: s.color,
                            borderRadius: 3,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    {trendData.map((d, i) => (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          fontSize: 8,
                          color: COLORS.chalkDim,
                          textAlign: "center",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {d.match.opponent}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      {section === "season" && (
        <>
          <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
            All matches · {matches.length} scheduled
          </div>
          <RawTable rows={seasonRows} exportName="season-stats.csv" />
        </>
      )}
    </div>
  );
}

// ---- Roster screen: full team, independent of any single lineup ----
function RosterScreen({ roster, setRoster, captainId, setCaptainId, lineups, setLineups, teamName, setTeamName, coachName, setCoachName, teamLogo, updateTeamLogo, log, setLog }) {
  const [playerSheet, setPlayerSheet] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [playerForm, setPlayerForm] = useState({ num: "", firstName: "", lastName: "", position: "", position2: "" });
  const [sortBy, setSortBy] = useState("number"); // "number" | "position" — display order only, never touches roster's actual stored order

  const openAddPlayer = () => {
    setPlayerForm({ num: "", firstName: "", lastName: "", position: "", position2: "" });
    setPlayerSheet({ mode: "add" });
  };

  const openEditPlayer = (p) => {
    setPlayerForm({ num: String(p.num), firstName: p.firstName || "", lastName: p.lastName || "", position: p.position || "", position2: p.position2 || "" });
    setPlayerSheet({ mode: "edit", id: p.id });
  };

  const savePlayer = () => {
    if (!playerForm.firstName.trim()) return;
    if (playerSheet?.mode === "edit") {
      setRoster((prev) =>
        prev.map((p) =>
          p.id === playerSheet.id
            ? {
                ...p,
                num: playerForm.num.trim() || "-",
                firstName: playerForm.firstName.trim(),
                lastName: playerForm.lastName.trim(),
                position: playerForm.position,
                position2: playerForm.position2 || "",
              }
            : p
        )
      );
    } else {
      const id = Date.now();
      setRoster((prev) => [
        ...prev,
        {
          id,
          num: playerForm.num.trim() || "-",
          firstName: playerForm.firstName.trim(),
          lastName: playerForm.lastName.trim(),
          position: playerForm.position,
          position2: playerForm.position2 || "",
        },
      ]);
    }
    setPlayerSheet(null);
  };

  // Removing a player cleans up every place they're referenced, so nothing
  // dangling is left in a lineup, a libero slot, or a pairing. If they have
  // stat entries recorded, that's called out explicitly rather than left to
  // silently render as broken rows in the box score.
  const deletePlayer = (id) => {
    const hasStats = log.some((e) => e.playerId === id);
    if (hasStats) {
      const player = roster.find((p) => p.id === id);
      const confirmed = window.confirm(
        `${displayName(player)} has recorded stat entries in the current match. Deleting them will remove those stats from the box score too. Continue?`
      );
      if (!confirmed) return;
      setLog((prev) => prev.filter((e) => e.playerId !== id));
    }
    setRoster((prev) => prev.filter((p) => p.id !== id));
    setLineups((prev) =>
      prev.map((l) => ({
        ...l,
        slots: Object.fromEntries(Object.entries(l.slots).map(([k, v]) => [k, v === id ? null : v])),
        liberos: (l.liberos || [null, null]).map((v) => (v === id ? null : v)),
        pairings: (l.pairings || []).filter((p) => p.frontId !== id && p.backId !== id),
      }))
    );
    if (captainId === id) setCaptainId(null);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", position: "relative" }}>
      {/* Team info - feeds the Team/Coach fields on printed sheets */}
      <div
        style={{
          background: COLORS.bgRaised,
          border: `1px solid ${COLORS.line}`,
          borderRadius: 10,
          padding: 12,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: COLORS.chalkDim,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          Team Info
        </div>
        <input
          placeholder="Team name"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            marginBottom: 8,
            background: COLORS.bg,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 8,
            color: COLORS.chalk,
            fontSize: 13,
          }}
        />
        <input
          placeholder="Coach name"
          value={coachName}
          onChange={(e) => setCoachName(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            marginBottom: 10,
            background: COLORS.bg,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 8,
            color: COLORS.chalk,
            fontSize: 13,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {teamLogo ? (
            <img
              src={teamLogo}
              alt="Team logo"
              style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", border: `1px solid ${COLORS.line}` }}
            />
          ) : (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                border: `1px dashed ${COLORS.line}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: COLORS.chalkDim,
                flexShrink: 0,
              }}
            >
              <ImageIcon size={16} />
            </div>
          )}
          <label
            style={{
              flex: 1,
              textAlign: "center",
              padding: "7px 8px",
              borderRadius: 8,
              border: `1px solid ${COLORS.line}`,
              color: COLORS.chalkDim,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {teamLogo ? "Change Logo" : "Add Team Logo"}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => updateTeamLogo(reader.result);
                reader.readAsDataURL(file);
                e.target.value = "";
              }}
              style={{ display: "none" }}
            />
          </label>
          {teamLogo && (
            <button
              onClick={() => updateTeamLogo(null)}
              title="Remove logo"
              style={{ background: "none", border: "none", color: COLORS.chalkDim, flexShrink: 0 }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button
          onClick={openAddPlayer}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.orange}`,
            background: "rgba(255,107,53,0.12)",
            color: COLORS.chalk,
            fontSize: 12,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <Plus size={14} /> Add Player
        </button>
        {roster.length > 0 && (
          <button
            onClick={() =>
              downloadCSV(
                "roster.csv",
                ["Number", "First Name", "Last Name", "Position", "Captain"],
                roster.map((p) => [p.num, p.firstName, p.lastName, p.position || "", p.id === captainId ? "C" : ""])
              )
            }
            title="Export roster as CSV"
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${COLORS.line}`,
              background: "transparent",
              color: COLORS.chalkDim,
              fontSize: 12,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <ClipboardPaste size={14} />
          </button>
        )}
      </div>

      {roster.length === 0 && (
        <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
          No players yet. Add your first one above.
        </div>
      )}

      {roster.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: COLORS.chalkDim, alignSelf: "center", marginRight: 2 }}>Sort:</span>
          {[
            { key: "number", label: "Number" },
            { key: "position", label: "Position" },
          ].map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${sortBy === opt.key ? COLORS.orange : COLORS.line}`,
                background: sortBy === opt.key ? "rgba(255,107,53,0.15)" : "transparent",
                color: COLORS.chalk,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {(() => {
        const posOrder = POSITIONS.map((p) => p.value);
        const sortedRoster = [...roster].sort((a, b) => {
          if (sortBy === "position") {
            const ai = a.position ? posOrder.indexOf(a.position) : posOrder.length;
            const bi = b.position ? posOrder.indexOf(b.position) : posOrder.length;
            if (ai !== bi) return ai - bi;
            return (parseInt(a.num) || 0) - (parseInt(b.num) || 0);
          }
          return (parseInt(a.num) || 0) - (parseInt(b.num) || 0);
        });
        return sortedRoster.map((p) => (
        <div
          key={p.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: COLORS.bgRaised,
            border: `1px solid ${p.id === captainId ? COLORS.gold : COLORS.line}`,
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 600,
              fontSize: 18,
              color: COLORS.orange,
              width: 34,
              flexShrink: 0,
            }}
          >
            #{p.num}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14, color: COLORS.chalk, fontWeight: 600 }}>{displayName(p)}</span>
              {p.id === captainId && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#1C2128",
                    background: COLORS.gold,
                    borderRadius: "50%",
                    width: 15,
                    height: 15,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  C
                </span>
              )}
            </div>
            {p.position && (
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.chalkDim,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                  marginTop: 3,
                  display: "inline-block",
                }}
              >
                {p.position}
              </span>
            )}
            {p.position2 && (
              <span
                style={{
                  fontSize: 10,
                  color: COLORS.chalkDim,
                  border: `1px dashed ${COLORS.line}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                  marginTop: 3,
                  marginLeft: 4,
                  display: "inline-block",
                }}
                title="Secondary position"
              >
                {p.position2}
              </span>
            )}
          </div>
          <button
            onClick={() => setCaptainId((cur) => (cur === p.id ? null : p.id))}
            title="Toggle captain"
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 700,
              color: p.id === captainId ? "#1C2128" : COLORS.chalkDim,
              background: p.id === captainId ? COLORS.gold : "transparent",
              border: `1px solid ${p.id === captainId ? COLORS.gold : COLORS.line}`,
              borderRadius: "50%",
              width: 26,
              height: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            C
          </button>
          <button
            onClick={() => openEditPlayer(p)}
            title="Edit player"
            style={{ flexShrink: 0, background: "none", border: "none", color: COLORS.chalkDim }}
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => deletePlayer(p.id)}
            title="Remove from roster"
            style={{ flexShrink: 0, background: "none", border: "none", color: COLORS.chalkDim }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        ));
      })()}

      {playerSheet && (
        <div
          onClick={() => setPlayerSheet(null)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
            zIndex: 10,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
            }}
          >
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 16,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              {playerSheet.mode === "edit" ? "Edit Player" : "Add Player to Roster"}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                placeholder="#"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                value={playerForm.num}
                onChange={(e) => setPlayerForm((s) => ({ ...s, num: e.target.value.replace(/[^0-9]/g, "") }))}
                style={{
                  width: 56,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
              <input
                placeholder="First name"
                value={playerForm.firstName}
                onChange={(e) => setPlayerForm((s) => ({ ...s, firstName: e.target.value }))}
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
              <input
                placeholder="Last name"
                value={playerForm.lastName}
                onChange={(e) => setPlayerForm((s) => ({ ...s, lastName: e.target.value }))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 10px",
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
            </div>
            {(() => {
              const trimmed = playerForm.num.trim();
              if (!trimmed) return null;
              const conflict = roster.find(
                (p) => String(p.num) === trimmed && (playerSheet.mode !== "edit" || p.id !== playerSheet.id)
              );
              return conflict ? (
                <div style={{ fontSize: 11, color: COLORS.gold, marginTop: -6, marginBottom: 10 }}>
                  ⚠ #{trimmed} is already used by {displayName(conflict)}. You can still save, but two
                  players with the same number can cause confusion at the scorer's table.
                </div>
              ) : null;
            })()}
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Position
            </label>
            <select
              value={playerForm.position}
              onChange={(e) => setPlayerForm((s) => ({ ...s, position: e.target.value }))}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 14,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">No position set</option>
              {POSITIONS.map((pos) => (
                <option key={pos.value} value={pos.value}>
                  {pos.label}
                </option>
              ))}
            </select>
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Secondary Position (optional)
            </label>
            <select
              value={playerForm.position2 || ""}
              onChange={(e) => setPlayerForm((s) => ({ ...s, position2: e.target.value }))}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 14,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              <option value="">None</option>
              {POSITIONS.map((pos) => (
                <option key={pos.value} value={pos.value}>
                  {pos.label}
                </option>
              ))}
            </select>
            <button
              onClick={savePlayer}
              disabled={!playerForm.firstName.trim()}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background: playerForm.firstName.trim() ? COLORS.orange : COLORS.line,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {playerSheet.mode === "edit" ? "Save Changes" : "Add to Roster"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Schedule screen: manual add + edit + paste import ----
function ScheduleScreen({ matches, setMatches, activeMatchId, setActiveMatchId, setTab, setStatsView }) {
  const [matchSheet, setMatchSheet] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({ date: "", opponent: "", location: "", homeAway: "Home" });
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState(null);

  const sorted = [...matches].sort((a, b) => (a.date > b.date ? 1 : -1));

  const openAddMatch = () => {
    setForm({ date: "", opponent: "", location: "", homeAway: "Home" });
    setMatchSheet({ mode: "add" });
  };

  const openEditMatch = (m) => {
    setForm({ date: m.date || "", opponent: m.opponent || "", location: m.location || "", homeAway: m.homeAway || "Home" });
    setMatchSheet({ mode: "edit", id: m.id });
  };

  const saveMatch = () => {
    if (!form.opponent || !form.date) return;
    if (matchSheet?.mode === "edit") {
      setMatches((prev) => prev.map((m) => (m.id === matchSheet.id ? { ...m, ...form } : m)));
    } else {
      setMatches((prev) => [...prev, { id: Date.now(), ...form }]);
    }
    setForm({ date: "", opponent: "", location: "", homeAway: "Home" });
    setMatchSheet(null);
  };

  const deleteMatch = (id) => {
    setMatches((prev) => prev.filter((m) => m.id !== id));
    if (activeMatchId === id) setActiveMatchId(null);
  };

  // Tap a match to jump straight to the right place: an upcoming match sets
  // it active and opens Lineup for prep; a past match opens its Insights.
  const goToMatch = (m) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const isPast = m.date && m.date < todayStr;
    if (isPast) {
      setStatsView({ section: "insights", insightsMatchId: m.id });
      setTab("box");
    } else {
      setActiveMatchId(m.id);
      setTab("lineup");
    }
  };

  // Parse pasted lines like: "2026-09-12, Lincoln, Home Gym, Home"
  const parseImport = () => {
    const rows = importText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        return {
          id: Date.now() + Math.random(),
          date: parts[0] || "",
          opponent: parts[1] || "Unknown",
          location: parts[2] || "",
          homeAway: parts[3] || "Home",
        };
      });
    setImportPreview(rows);
  };

  const confirmImport = () => {
    setMatches((prev) => [...prev, ...importPreview]);
    setImportText("");
    setImportPreview(null);
    setShowImport(false);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", position: "relative" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button
          onClick={openAddMatch}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.orange}`,
            background: "rgba(255,107,53,0.12)",
            color: COLORS.chalk,
            fontSize: 12,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <Plus size={14} /> Add Match
        </button>
        <button
          onClick={() => setShowImport(true)}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.line}`,
            background: "transparent",
            color: COLORS.chalkDim,
            fontSize: 12,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <ClipboardPaste size={14} /> Import
        </button>
        {matches.length > 0 && (
          <button
            onClick={() =>
              downloadCSV(
                "schedule.csv",
                ["Date", "Opponent", "Location", "Home/Away"],
                sorted.map((m) => [m.date, m.opponent, m.location, m.homeAway])
              )
            }
            title="Export schedule as CSV"
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${COLORS.line}`,
              background: "transparent",
              color: COLORS.chalkDim,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            CSV
          </button>
        )}
      </div>

      {sorted.length === 0 && (
        <div style={{ color: COLORS.chalkDim, fontSize: 13, textAlign: "center", marginTop: 40 }}>
          No matches yet. Add one or paste in a schedule.
        </div>
      )}

      {sorted.map((m) => {
        const isActive = m.id === activeMatchId;
        return (
          <div
            key={m.id}
            style={{
              background: COLORS.bgRaised,
              border: `1px solid ${isActive ? COLORS.gold : COLORS.line}`,
              borderRadius: 10,
              padding: 12,
              marginBottom: 8,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div onClick={() => goToMatch(m)} style={{ cursor: "pointer", flex: 1 }} title="Tap for lineup prep or box score">
              {isActive && (
                <div style={{ fontSize: 9, fontWeight: 700, color: COLORS.gold, letterSpacing: 0.5, marginBottom: 2 }}>
                  ACTIVE MATCH
                </div>
              )}
              <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
                {m.date || "No date"} · {m.homeAway}
              </div>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 600 }}>
                vs. {m.opponent}
              </div>
              {m.location && (
                <div style={{ fontSize: 11, color: COLORS.chalkDim }}>{m.location}</div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={() => setActiveMatchId(isActive ? null : m.id)}
                title="Set as active match for printed sheets"
                style={{
                  background: isActive ? COLORS.gold : "none",
                  border: `1px solid ${isActive ? COLORS.gold : COLORS.line}`,
                  borderRadius: 6,
                  padding: "4px 8px",
                  color: isActive ? "#1C2128" : COLORS.chalkDim,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {isActive ? "Active" : "Set Active"}
              </button>
              <button
                onClick={() => openEditMatch(m)}
                title="Edit match"
                style={{ background: "none", border: "none", color: COLORS.chalkDim }}
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => deleteMatch(m.id)}
                style={{ background: "none", border: "none", color: COLORS.chalkDim }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        );
      })}

      {/* Add/edit match sheet */}
      {matchSheet && (
        <div
          onClick={() => setMatchSheet(null)}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
            }}
          >
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 16,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              {matchSheet.mode === "edit" ? "Edit Match" : "Add Match"}
            </div>
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Date
            </label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
              style={{
                width: "100%",
                padding: "9px 10px",
                marginTop: 4,
                marginBottom: 8,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
                colorScheme: "dark",
              }}
            />
            {[
              { key: "opponent", ph: "Opponent" },
              { key: "location", ph: "Location" },
            ].map((f) => (
              <input
                key={f.key}
                placeholder={f.ph}
                value={form[f.key]}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  marginBottom: 8,
                  background: COLORS.bg,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 13,
                }}
              />
            ))}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {["Home", "Away"].map((ha) => (
                <button
                  key={ha}
                  onClick={() => setForm((s) => ({ ...s, homeAway: ha }))}
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: 8,
                    border: `1.5px solid ${form.homeAway === ha ? COLORS.orange : COLORS.line}`,
                    background: form.homeAway === ha ? "rgba(255,107,53,0.15)" : "transparent",
                    color: COLORS.chalk,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {ha}
                </button>
              ))}
            </div>
            <button
              onClick={saveMatch}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background: COLORS.orange,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {matchSheet.mode === "edit" ? "Save Changes" : "Save Match"}
            </button>
          </div>
        </div>
      )}

      {/* Import sheet */}
      {showImport && (
        <div
          onClick={() => {
            setShowImport(false);
            setImportPreview(null);
          }}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: COLORS.bgRaised,
              width: "100%",
              borderRadius: "20px 20px 0 0",
              padding: 18,
              maxHeight: "75%",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 16,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Import Schedule
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
              Paste one match per line, or upload a CSV: Date, Opponent, Location, Home/Away
            </div>
            {!importPreview ? (
              <>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={"2026-09-12, Lincoln, Home Gym, Home\n2026-09-19, Central, Away Gym, Away"}
                  rows={6}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    marginBottom: 10,
                    background: COLORS.bg,
                    border: `1px solid ${COLORS.line}`,
                    borderRadius: 8,
                    color: COLORS.chalk,
                    fontSize: 12,
                    fontFamily: "monospace",
                    resize: "vertical",
                  }}
                />
                <button
                  onClick={parseImport}
                  disabled={!importText.trim()}
                  style={{
                    width: "100%",
                    padding: "11px",
                    borderRadius: 8,
                    border: "none",
                    background: importText.trim() ? COLORS.orange : COLORS.line,
                    color: "#1C2128",
                    fontWeight: 700,
                    fontSize: 13,
                    marginBottom: 10,
                  }}
                >
                  Preview Import
                </button>
                <label
                  style={{
                    display: "block",
                    textAlign: "center",
                    padding: "9px 8px",
                    borderRadius: 8,
                    border: `1px solid ${COLORS.line}`,
                    color: COLORS.chalkDim,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Or Upload CSV File
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => setImportText(String(reader.result || ""));
                      reader.readAsText(file);
                      e.target.value = "";
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
                  {importPreview.length} match{importPreview.length !== 1 ? "es" : ""} found —
                  review before saving
                </div>
                {importPreview.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 12,
                      padding: "6px 8px",
                      background: COLORS.bg,
                      borderRadius: 6,
                      marginBottom: 5,
                      color: COLORS.chalk,
                    }}
                  >
                    {m.date || "—"} · vs. {m.opponent} · {m.location || "—"} · {m.homeAway}
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => setImportPreview(null)}
                    style={{
                      flex: 1,
                      padding: "10px",
                      borderRadius: 8,
                      border: `1px solid ${COLORS.line}`,
                      background: "transparent",
                      color: COLORS.chalkDim,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Back
                  </button>
                  <button
                    onClick={confirmImport}
                    style={{
                      flex: 1,
                      padding: "10px",
                      borderRadius: 8,
                      border: "none",
                      background: COLORS.orange,
                      color: "#1C2128",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Confirm Import
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Print area: standard black-on-white formats, one per document type.
// Hidden on screen; shown via @media print CSS with everything else hidden.
function PrintArea({ target, roster, lineups, activeLineupId, log, score, matches, captainId, teamName, coachName, activeMatchId, teamLogo, statsView, trendSubject, pointLog, includePairingsRoster, includePairingsLineup }) {
  const activeLineupForPrint = lineups.find((l) => l.id === activeLineupId) || lineups[0];
  const setNumber = activeLineupForPrint?.setNumber || 1;
  const activeMatch = matches.find((m) => m.id === activeMatchId) || null;
  const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0];
  const playerFor = (id) => roster.find((p) => p.id === id);

  const boxSection = statsView?.section || "boxscore";
  const boxLog = log.filter((e) => (e.matchId ?? null) === (activeMatchId ?? null));

  const boxRows = (() => {
    const byPlayer = {};
    for (const e of boxLog) {
      if (!byPlayer[e.playerId]) byPlayer[e.playerId] = {};
      byPlayer[e.playerId][e.stat] = (byPlayer[e.playerId][e.stat] || 0) + 1;
    }
    return Object.entries(byPlayer).map(([pid, stats]) => ({ player: playerFor(Number(pid)), stats })).filter((r) => r.player);
  })();

  const seasonRows = (() => {
    const byPlayer = {};
    for (const e of log) {
      if (!byPlayer[e.playerId]) byPlayer[e.playerId] = {};
      byPlayer[e.playerId][e.stat] = (byPlayer[e.playerId][e.stat] || 0) + 1;
    }
    return Object.entries(byPlayer).map(([pid, stats]) => ({ player: playerFor(Number(pid)), stats })).filter((r) => r.player);
  })();

  // Insights print data — for whichever match is currently selected in the
  // app's Insights view (current or past).
  const insightsMatchId = statsView?.insightsMatchId ?? null;
  const insightsMatch = insightsMatchId != null ? matches.find((m) => m.id === insightsMatchId) : null;
  const insightsLog = insightsMatchId == null ? [] : log.filter((e) => (e.matchId ?? null) === insightsMatchId);
  const insightsRows = (() => {
    const byPlayer = {};
    for (const e of insightsLog) {
      if (!byPlayer[e.playerId]) byPlayer[e.playerId] = {};
      byPlayer[e.playerId][e.stat] = (byPlayer[e.playerId][e.stat] || 0) + 1;
    }
    return Object.entries(byPlayer).map(([pid, stats]) => ({ player: playerFor(Number(pid)), stats })).filter((r) => r.player);
  })();
  const insightsTotals = {};
  insightsRows.forEach((r) => Object.entries(r.stats).forEach(([k, v]) => (insightsTotals[k] = (insightsTotals[k] || 0) + v)));
  const insightsLeaders = {};
  ["kill", "dig", "ace", "assist"].forEach((key) => {
    let best = null;
    insightsRows.forEach((r) => {
      const v = r.stats[key] || 0;
      if (v > 0 && (!best || v > best.value)) best = { player: r.player, value: v };
    });
    if (best) insightsLeaders[key] = best;
  });
  const insightsByLineup = (() => {
    const byLineup = {};
    insightsLog.forEach((e) => {
      const key = e.lineupId ?? "unknown";
      if (!byLineup[key]) byLineup[key] = {};
      byLineup[key][e.stat] = (byLineup[key][e.stat] || 0) + 1;
    });
    return Object.entries(byLineup).map(([lineupId, stats]) => {
      const lineup = lineups.find((l) => l.id === Number(lineupId));
      const kills = stats.kill || 0;
      const errors = (stats.attackErr || 0) + (stats.serveErr || 0) + (stats.recErr || 0) + (stats.blockErr || 0) + (stats.passingErr || 0);
      return { name: lineup ? lineup.name : "Before tracking", kills, errors };
    });
  })();
  const insightsByRotation = (() => {
    if (insightsMatchId == null) return [];
    const relevant = pointLog.filter((e) => (e.matchId ?? null) === insightsMatchId);
    const byServer = {};
    relevant.forEach((e) => {
      const key = e.serverPlayerId ?? "unknown";
      if (!byServer[key]) byServer[key] = { us: 0, opp: 0 };
      byServer[key][e.team] += 1;
    });
    return Object.entries(byServer)
      .map(([playerId, counts]) => {
        const player = playerId !== "unknown" ? playerFor(Number(playerId)) : null;
        return { player, ...counts, diff: counts.us - counts.opp };
      })
      .sort((a, b) => b.diff - a.diff);
  })();

  // Trends print data — a separate document from the Box Score sheet above,
  // one row per match (chronological), for whichever subject (team/player/
  // lineup) is currently selected in the app's Trends view.
  const trendMatches = matches
    .filter((m) => log.some((e) => e.matchId === m.id))
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  const trendSubjectLabel = (() => {
    if (!trendSubject || trendSubject === "team") return "Team Totals";
    if (trendSubject.startsWith("player:")) {
      const p = playerFor(Number(trendSubject.slice(7)));
      return p ? `#${p.num} ${fullName(p)}` : "Player";
    }
    if (trendSubject.startsWith("lineup:")) {
      const l = lineups.find((l) => l.id === Number(trendSubject.slice(7)));
      return l ? l.name : "Lineup";
    }
    return "Team Totals";
  })();
  const trendRows = trendMatches.map((m) => {
    const entries = log.filter((e) => {
      if (e.matchId !== m.id) return false;
      if (!trendSubject || trendSubject === "team") return true;
      if (trendSubject.startsWith("player:")) return e.playerId === Number(trendSubject.slice(7));
      if (trendSubject.startsWith("lineup:")) return e.lineupId === Number(trendSubject.slice(7));
      return true;
    });
    const stats = {};
    entries.forEach((e) => (stats[e.stat] = (stats[e.stat] || 0) + 1));
    return { match: m, stats };
  });

  const th = { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid #000", fontSize: 11, textTransform: "uppercase" };
  const td = { padding: "6px 8px", borderBottom: "1px solid #999", fontSize: 12 };
  const h1 = { fontSize: 20, fontWeight: 700, marginBottom: 2 };
  const h2 = { fontSize: 12, color: "#444", marginBottom: 16 };

  const PrintHeader = ({ title, subtitle }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 2 }}>
      {teamLogo && (
        <img src={teamLogo} alt="Team logo" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
      )}
      <div>
        <div style={h1}>
          {teamName ? `${teamName} — ` : ""}
          {title}
        </div>
        {subtitle && <div style={h2}>{subtitle}</div>}
      </div>
    </div>
  );

  // Small, deliberately unobtrusive mark at the bottom of every printed page.
  const PrintFooter = () => (
    <div style={{ marginTop: 28, fontSize: 9, color: "#999", textAlign: "center" }}>
      Made with Volley Bandit
    </div>
  );

  return (
    <div id="print-root">
      {/* ROSTER */}
      <div className={`print-section${target === "roster" ? " active" : ""}`}>
        <PrintHeader title="Team Roster" subtitle={`${roster.length} players`} />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              <th style={th}>Position</th>
              <th style={th}>Captain</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((p) => (
              <tr key={p.id}>
                <td style={{ ...td, fontWeight: 700, color: "#000" }}>{p.num}</td>
                <td style={{ ...td, color: "#000" }}>{`${p.firstName || ""} ${p.lastName || ""}`.trim() || "—"}</td>
                <td style={{ ...td, color: "#000" }}>{p.position || "—"}</td>
                <td style={{ ...td, color: "#000" }}>{p.id === captainId ? "C" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Substitution pairings, per set — reference info for the coach, kept off
            the Lineup sheet since that one doubles as the in-game scoresheet. */}
        {includePairingsRoster && lineups.some((l) => (l.pairings || []).length > 0) && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Substitution Pairings</div>
            {lineups
              .filter((l) => (l.pairings || []).length > 0)
              .map((l) => (
                <div key={l.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{l.name}</div>
                  {l.pairings.map((pr) => {
                    const front = playerFor(pr.frontId);
                    const back = playerFor(pr.backId);
                    return (
                      <div key={pr.id} style={{ fontSize: 12, marginLeft: 8, marginBottom: 2 }}>
                        Front: #{front?.num} {fullName(front)} &nbsp;↔&nbsp; Back: #{back?.num} {fullName(back)}
                        {pr.isLibero ? "  (Libero)" : ""}
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
        )}
        <PrintFooter />
      </div>

      {/* LINEUP — matches a standard printed volleyball lineup sheet */}
      <div className={`print-section${target === "lineup" ? " active" : ""}`}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            marginBottom: 28,
          }}
        >
          {teamLogo && (
            <img src={teamLogo} alt="Team logo" style={{ width: 46, height: 46, borderRadius: 8, objectFit: "cover" }} />
          )}
          <div style={{ textAlign: "center", fontSize: 24, fontWeight: 700, letterSpacing: 1 }}>
            VOLLEYBALL LINEUP SHEET
          </div>
        </div>
        <div style={{ display: "flex", gap: 24 }}>
          {/* Left column: team info + roster — true 50/50 split with the diagrams */}
          <div style={{ flex: 1 }}>
            {[
              { label: "Team", value: teamName },
              { label: "Coach", value: coachName },
              { label: "Date", value: activeMatch?.date },
              { label: "Opponent", value: activeMatch?.opponent },
              { label: "Match Winner", value: "" },
            ].map(({ label, value }) => (
              <div key={label} style={{ marginBottom: 12, fontSize: 14, fontWeight: 700 }}>
                {label}:
                {value ? (
                  <div style={{ fontWeight: 400, fontSize: 14 }}>{value}</div>
                ) : (
                  <div style={{ borderBottom: "1px solid #000", height: 18 }}>&nbsp;</div>
                )}
              </div>
            ))}
            <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 5px" }}>Roster:</div>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #000" }}>
              <thead>
                <tr>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", width: 36, fontSize: 12, padding: "4px 5px" }}>No.</th>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", fontSize: 12, padding: "4px 5px" }}>Name</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((p) => (
                  <tr key={p.id}>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 12, padding: "3px 5px" }}>{p.num}</td>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 12, padding: "3px 5px" }}>{fullName(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pairings, broken down per set — optional, shown under the roster
                list on this same left column when the coach wants the reference.
                Sized as large as the page allows, since these are the numbers
                actually being read mid-match, not just a reference list. */}
            {includePairingsLineup && lineups.slice(0, 5).some((l) => (l.pairings || []).length > 0) && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 5 }}>Pairings</div>
                {lineups.slice(0, 5).map((l, i) => {
                  const prs = l.pairings || [];
                  if (prs.length === 0) return null;
                  return (
                    <div key={l.id} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{l.name}</div>
                      {prs.map((pr) => {
                        const front = playerFor(pr.frontId);
                        const back = playerFor(pr.backId);
                        return (
                          <div key={pr.id} style={{ fontSize: 12, fontWeight: 600, marginLeft: 5, lineHeight: 1.35 }}>
                            #{front?.num} {fullName(front)} ↔ #{back?.num} {fullName(back)}
                            {pr.isLibero ? " (L)" : ""}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right column: one net diagram per saved lineup, up to 5 (best-of-5 max).
              Sizing scales down automatically as more sets are added, so 3-set JV
              lineups stay large while a 5-set varsity sheet still fits the page. */}
          <div style={{ flex: 1 }}>
            {(() => {
              const numDiagrams = Math.min(Math.max(lineups.length, 1), 5);
              const sizing = {
                1: { circle: 88, gap: 18, pad: 18, setFont: 17, netFont: 11, border: 4, marginBottom: 24 },
                2: { circle: 76, gap: 15, pad: 15, setFont: 16, netFont: 11, border: 4, marginBottom: 20 },
                3: { circle: 66, gap: 13, pad: 13, setFont: 15, netFont: 10, border: 3, marginBottom: 16 },
                4: { circle: 54, gap: 10, pad: 10, setFont: 13, netFont: 9, border: 3, marginBottom: 13 },
                5: { circle: 46, gap: 8, pad: 9, setFont: 12, netFont: 8, border: 3, marginBottom: 10 },
              }[numDiagrams];
              return [...Array(numDiagrams)].map((_, i) => {
                const l = lineups[i];
                const serverSlot = l ? ((l.servesFirst || "us") === "us" ? "P1" : "P2") : null;
                return (
                  <div key={i} style={{ marginBottom: sizing.marginBottom }}>
                    <div style={{ textAlign: "center", fontSize: sizing.setFont, fontWeight: 700 }}>
                      {l ? l.name : `Set ${i + 1}`}
                    </div>
                    <div style={{ textAlign: "center", fontSize: sizing.netFont, fontWeight: 700, marginBottom: sizing.gap / 2 }}>
                      NET
                    </div>
                    <div
                      style={{
                        border: "1px solid #000",
                        padding: sizing.pad,
                        display: "grid",
                        gridTemplateColumns: "repeat(3, 1fr)",
                        gap: sizing.gap,
                        justifyItems: "center",
                        alignItems: "center",
                      }}
                    >
                      {["P4", "P3", "P2", "P5", "P6", "P1"].map((slot) => {
                        const p = l ? playerFor(l.slots?.[slot]) : null;
                        const isServer = slot === serverSlot;
                        const isCap = p && p.id === captainId;
                        return (
                          <div
                            key={slot}
                            style={{
                              width: sizing.circle,
                              height: sizing.circle,
                              borderRadius: "50%",
                              border: isServer ? `${sizing.border}px solid #000` : "1.5px solid #000",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: Math.round(sizing.circle * 0.28),
                              fontWeight: 700,
                              position: "relative",
                            }}
                          >
                            {p ? p.num : ""}
                            {p && isCap && (
                              <span
                                style={{
                                  position: "absolute",
                                  top: -Math.round(sizing.circle * 0.14),
                                  right: -Math.round(sizing.circle * 0.14),
                                  fontSize: Math.round(sizing.circle * 0.22),
                                  fontWeight: 700,
                                  lineHeight: 1,
                                }}
                              >
                                C
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>

        <div style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
          <b>Please note:</b> Write only the player's number in the positions in which they will START.
          Indicate captain with a 'C' next to the number and the player serving first with a circle
          around the number.
        </div>
        <PrintFooter />
      </div>

      {/* BOX SCORE — current match only, kept simple */}
      <div className={`print-section${target === "box" && boxSection === "boxscore" ? " active" : ""}`}>
        <PrintHeader
          title="Box Score"
          subtitle={
            activeMatch
              ? `vs. ${activeMatch.opponent}${activeMatch.date ? ` · ${activeMatch.date}` : ""}`
              : `Set ${setNumber} · Us ${score.us} – ${score.opp} Opponent`
          }
        />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              {STAT_BUTTONS.map((s) => (
                <th key={s.key} style={{ ...th, textAlign: "center" }}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {boxRows.map(({ player, stats }, idx) => (
              <tr key={player.id} style={{ background: idx % 2 === 1 ? "#cfcfcf" : "transparent" }}>
                <td style={{ ...td, fontWeight: 700 }}>{player.num}</td>
                <td style={td}>{fullName(player)}</td>
                {STAT_BUTTONS.map((s) => (
                  <td key={s.key} style={{ ...td, textAlign: "center" }}>
                    {stats[s.key] || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <PrintFooter />
      </div>

      {/* INSIGHTS — whichever match is currently selected in the app's Insights view */}
      <div className={`print-section${target === "box" && boxSection === "insights" ? " active" : ""}`}>
        <PrintHeader
          title="Match Insights"
          subtitle={insightsMatch ? `vs. ${insightsMatch.opponent}${insightsMatch.date ? ` · ${insightsMatch.date}` : ""}` : "No match selected"}
        />
        {insightsRows.length === 0 ? (
          <div style={{ fontSize: 12, color: "#444" }}>No stats recorded for this match.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              {STAT_BUTTONS.filter((s) => insightsTotals[s.key]).map((s) => (
                <span key={s.key} style={{ marginRight: 14 }}>
                  {s.label}: <b>{insightsTotals[s.key]}</b>
                </span>
              ))}
            </div>
            {Object.keys(insightsLeaders).length > 0 && (
              <div style={{ fontSize: 12, marginBottom: 16 }}>
                {Object.entries(insightsLeaders).map(([key, l]) => (
                  <div key={key}>
                    {STAT_LABELS[key]} leader: #{l.player.num} {fullName(l.player)} ({l.value})
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {insightsByLineup.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>By Lineup</div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
              <thead>
                <tr>
                  <th style={th}>Lineup</th>
                  <th style={{ ...th, textAlign: "center" }}>Kills</th>
                  <th style={{ ...th, textAlign: "center" }}>Errors</th>
                  <th style={{ ...th, textAlign: "center" }}>Diff</th>
                </tr>
              </thead>
              <tbody>
                {insightsByLineup.map((lb, i) => (
                  <tr key={i}>
                    <td style={td}>{lb.name}</td>
                    <td style={{ ...td, textAlign: "center" }}>{lb.kills}</td>
                    <td style={{ ...td, textAlign: "center" }}>{lb.errors}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {lb.kills - lb.errors >= 0 ? "+" : ""}
                      {lb.kills - lb.errors}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {insightsByRotation.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>By Rotation (Server)</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Server</th>
                  <th style={{ ...th, textAlign: "center" }}>Us</th>
                  <th style={{ ...th, textAlign: "center" }}>Opp</th>
                  <th style={{ ...th, textAlign: "center" }}>Diff</th>
                </tr>
              </thead>
              <tbody>
                {insightsByRotation.map((rb, i) => (
                  <tr key={i}>
                    <td style={td}>{rb.player ? `#${rb.player.num} ${fullName(rb.player)}` : "Before tracking"}</td>
                    <td style={{ ...td, textAlign: "center" }}>{rb.us}</td>
                    <td style={{ ...td, textAlign: "center" }}>{rb.opp}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {rb.diff >= 0 ? "+" : ""}
                      {rb.diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <PrintFooter />
      </div>

      {/* TRENDS — separate sheet: one row per match, for the currently selected subject */}
      <div className={`print-section${target === "box" && boxSection === "trends" ? " active" : ""}`}>
        <PrintHeader title="Stat Trends" subtitle={trendSubjectLabel} />
        {trendRows.length === 0 ? (
          <div style={{ fontSize: 12, color: "#444" }}>No matches with recorded stats yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Opponent</th>
                {STAT_BUTTONS.map((s) => (
                  <th key={s.key} style={{ ...th, textAlign: "center" }}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trendRows.map((r, idx) => (
                <tr key={r.match.id} style={{ background: idx % 2 === 1 ? "#cfcfcf" : "transparent" }}>
                  <td style={td}>{r.match.date || "—"}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.match.opponent}</td>
                  {STAT_BUTTONS.map((s) => (
                    <td key={s.key} style={{ ...td, textAlign: "center" }}>
                      {r.stats[s.key] || ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PrintFooter />
      </div>

      {/* SEASON TO DATE */}
      <div className={`print-section${target === "box" && boxSection === "season" ? " active" : ""}`}>
        <PrintHeader title="Season to Date" subtitle={`All matches · ${matches.length} scheduled`} />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              {STAT_BUTTONS.map((s) => (
                <th key={s.key} style={{ ...th, textAlign: "center" }}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {seasonRows.map(({ player, stats }, idx) => (
              <tr key={player.id} style={{ background: idx % 2 === 1 ? "#cfcfcf" : "transparent" }}>
                <td style={{ ...td, fontWeight: 700 }}>{player.num}</td>
                <td style={td}>{fullName(player)}</td>
                {STAT_BUTTONS.map((s) => (
                  <td key={s.key} style={{ ...td, textAlign: "center" }}>
                    {stats[s.key] || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <PrintFooter />
      </div>

      {/* PLAYER SUB SHEET — hand this to players, not coaches. Six small
          court diagrams per set, one per rotation, with a dual circle only
          at the exact rotation a substitution actually happens — everything
          else is a single number. Deliberately minimal: no names, no prose,
          just numbers a player can find and follow. */}
      <div className={`print-section${target === "subsheet" ? " active" : ""}`}>
        <PrintHeader title="Substitution Guide" subtitle="Find your number, follow it by rotation" />
        {lineups.slice(0, 5).map((l) => {
          const filledCount = Object.values(l.slots).filter(Boolean).length;
          const pairings = l.pairings || [];
          if (filledCount < 6 || pairings.length === 0) return null;
          const { rotations, transitions } = computeSubTransitions(l);
          const order = ["P4", "P3", "P2", "P5", "P6", "P1"];
          const size = 46;
          return (
            <div key={l.id} style={{ marginBottom: 28, pageBreakInside: "avoid" }}>
              <div style={{ fontSize: 18, fontWeight: 700, textAlign: "center", marginBottom: 3 }}>{l.name}</div>
              <div style={{ fontSize: 10, color: "#555", textAlign: "center", marginBottom: 10 }}>
                Dual circle = a sub happens right here · struck-through = leaving · L = libero
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {rotations.map((_, i) => {
                  const r = i + 1;
                  const { withSubs } = rotations[i];
                  return (
                    <div key={r} style={{ border: "1px solid #999", borderRadius: 8, padding: 7 }}>
                      <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                        Rotation {r}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, justifyItems: "center" }}>
                        {order.map((pos) => {
                          const t = transitions[`${r}-${pos}`];
                          if (t) {
                            const isLib = (l.liberos || []).includes(t.entering);
                            return (
                              <div
                                key={pos}
                                style={{
                                  width: size,
                                  height: size,
                                  borderRadius: "50%",
                                  border: "2.5px solid #FF6B35",
                                  display: "flex",
                                  flexDirection: "column",
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  style={{
                                    flex: 1,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    background: "#f2f2f2",
                                    textDecoration: "line-through",
                                    opacity: 0.65,
                                  }}
                                >
                                  <span style={{ fontSize: 15, fontWeight: 700 }}>{playerFor(t.leaving)?.num}</span>
                                </div>
                                <div style={{ height: 1.5, background: "#FF6B35" }} />
                                <div
                                  style={{
                                    flex: 1,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    background: "#fff3ec",
                                  }}
                                >
                                  <span style={{ fontSize: 17, fontWeight: 800 }}>
                                    {playerFor(t.entering)?.num}
                                    {isLib ? "L" : ""}
                                  </span>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div
                              key={pos}
                              style={{
                                width: size,
                                height: size,
                                borderRadius: "50%",
                                border: "1.5px solid #000",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <span style={{ fontSize: 19, fontWeight: 800 }}>{playerFor(withSubs[pos])?.num}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <PrintFooter />
      </div>

      {/* SCHEDULE */}
      <div className={`print-section${target === "schedule" ? " active" : ""}`}>
        <PrintHeader title="Schedule" subtitle={`${matches.length} matches`} />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Opponent</th>
              <th style={th}>Location</th>
              <th style={th}>Home/Away</th>
            </tr>
          </thead>
          <tbody>
            {[...matches]
              .sort((a, b) => (a.date > b.date ? 1 : -1))
              .map((m) => (
                <tr key={m.id}>
                  <td style={td}>{m.date || "—"}</td>
                  <td style={td}>{m.opponent}</td>
                  <td style={td}>{m.location || "—"}</td>
                  <td style={td}>{m.homeAway}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <PrintFooter />
      </div>
    </div>
  );
}

// ---- Team Gate: shown once, before any team data loads, on any device
// that hasn't been linked to a team yet ----
function TeamGate({ onLinked }) {
  const [mode, setMode] = useState("choice"); // "choice" | "create" | "join"
  const [codeInput, setCodeInput] = useState(() => generateTeamCode());
  const [joinInput, setJoinInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [codeTaken, setCodeTaken] = useState(false);
  const [createError, setCreateError] = useState("");
  const [joinError, setJoinError] = useState("");

  const wrap = {
    minHeight: "100vh",
    background: "#0B0D10",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: "'Inter', system-ui, sans-serif",
  };
  const card = { width: 300 };
  const title = {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 20,
    fontWeight: 700,
    color: COLORS.chalk,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
    textAlign: "center",
  };
  const sub = { fontSize: 12, color: COLORS.chalkDim, textAlign: "center", marginBottom: 20, lineHeight: 1.5 };
  const bigBtn = {
    width: "100%",
    padding: "13px",
    marginBottom: 10,
    borderRadius: 8,
    border: `1.5px solid ${COLORS.orange}`,
    background: "rgba(255,107,53,0.12)",
    color: COLORS.chalk,
    fontWeight: 700,
    fontSize: 14,
  };
  const backBtn = {
    display: "block",
    margin: "16px auto 0",
    background: "none",
    border: "none",
    color: COLORS.chalkDim,
    fontSize: 12,
  };

  // A code someone can actually remember beats a random one — but two teams
  // can't share a code, so this checks Firestore before letting them continue.
  const normalizeCode = (raw) =>
    raw
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, 24);

  const checkAndCreate = async () => {
    const code = codeInput.trim();
    if (!code) return;
    setChecking(true);
    setCreateError("");
    setCodeTaken(false);
    try {
      const ref = doc(db, "teams", code, "data", "main");
      const snap = await getDoc(ref);
      if (snap.exists()) {
        setCodeTaken(true);
        setChecking(false);
        return;
      }
      onLinked(code);
    } catch (err) {
      setCreateError("Couldn't check that code — check your connection and try again.");
      setChecking(false);
    }
  };

  // Join has to verify the team actually exists first — otherwise a typo'd
  // code would silently start a brand-new blank team instead of telling the
  // coach it couldn't find the one they meant to join.
  const checkAndJoin = async () => {
    const code = joinInput.trim();
    if (!code) return;
    setChecking(true);
    setJoinError("");
    try {
      const ref = doc(db, "teams", code, "data", "main");
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        setJoinError("No team found with that code — double-check it and try again.");
        setChecking(false);
        return;
      }
      onLinked(code);
    } catch (err) {
      setJoinError("Couldn't check that code — check your connection and try again.");
      setChecking(false);
    }
  };

  return (
    <div style={wrap}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Inter:wght@400;600;700&display=swap');`}</style>
      <div style={card}>
        <div style={title}>Volley Bandit</div>

        {mode === "choice" && (
          <>
            <div style={sub}>Link this device to a team to get started.</div>
            <button style={bigBtn} onClick={() => setMode("create")}>
              Create New Team
            </button>
            <button style={{ ...bigBtn, border: `1.5px solid ${COLORS.line}`, background: "none" }} onClick={() => { setJoinInput(""); setJoinError(""); setMode("join"); }}>
              Join Existing Team
            </button>
          </>
        )}

        {mode === "create" && (
          <>
            <div style={sub}>
              Pick something you'll actually remember — a team name works well (like
              GRAFTON-JV2). We've started you off with a random one below; feel free to
              replace it. You'll need this code to link any other device to this same data.
            </div>
            <input
              autoFocus
              value={codeInput}
              onChange={(e) => {
                setCodeInput(normalizeCode(e.target.value));
                setCodeTaken(false);
                setCreateError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && !checking && checkAndCreate()}
              style={{
                width: "100%",
                padding: "14px 10px",
                marginBottom: 8,
                background: COLORS.bgRaised,
                border: `1.5px solid ${codeTaken ? COLORS.red : COLORS.line}`,
                borderRadius: 10,
                color: COLORS.orange,
                fontSize: 22,
                fontFamily: "'Oswald', sans-serif",
                fontWeight: 700,
                letterSpacing: 1.5,
                textAlign: "center",
              }}
            />
            {codeTaken && (
              <div style={{ color: COLORS.red, fontSize: 11, marginBottom: 10, textAlign: "center" }}>
                That code's already taken — try another.
              </div>
            )}
            {createError && (
              <div style={{ color: COLORS.red, fontSize: 11, marginBottom: 10, textAlign: "center" }}>
                {createError}
              </div>
            )}
            <button
              onClick={() => {
                navigator.clipboard?.writeText(codeInput);
                setCopied(true);
              }}
              style={{ ...bigBtn, border: `1.5px solid ${COLORS.line}`, background: "none", marginTop: codeTaken || createError ? 0 : 4, marginBottom: 16 }}
            >
              {copied ? "Copied!" : "Copy Code"}
            </button>
            <button style={bigBtn} disabled={checking || !codeInput.trim()} onClick={checkAndCreate}>
              {checking ? "Checking…" : "Continue"}
            </button>
            <button style={backBtn} onClick={() => setMode("choice")}>
              Back
            </button>
          </>
        )}

        {mode === "join" && (
          <>
            <div style={sub}>Enter the team code from your other device.</div>
            <input
              autoFocus
              value={joinInput}
              onChange={(e) => {
                setJoinInput(e.target.value.toUpperCase());
                setJoinError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && !checking && joinInput.trim() && checkAndJoin()}
              placeholder="ABC-1234"
              style={{
                width: "100%",
                padding: "13px 14px",
                marginBottom: 8,
                background: COLORS.bgRaised,
                border: `1.5px solid ${joinError ? COLORS.red : COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 18,
                fontFamily: "'Oswald', sans-serif",
                letterSpacing: 1,
                textAlign: "center",
              }}
            />
            {joinError && (
              <div style={{ color: COLORS.red, fontSize: 11, marginBottom: 10, textAlign: "center" }}>
                {joinError}
              </div>
            )}
            <button
              style={{ ...bigBtn, marginTop: joinError ? 0 : 4 }}
              disabled={checking || !joinInput.trim()}
              onClick={checkAndJoin}
            >
              {checking ? "Checking…" : "Join"}
            </button>
            <button style={backBtn} onClick={() => setMode("choice")}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Stat definitions sheet, opened from the "?" button on the Stats tab ----
function StatInfoSheet({ onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.bgRaised,
          width: "100%",
          borderRadius: "20px 20px 0 0",
          padding: 18,
          maxHeight: "80%",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase" }}>
            Stat Definitions
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.chalkDim }}>
            <X size={20} />
          </button>
        </div>
        {STAT_BUTTONS.map((s) => (
          <div key={s.key} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: s.color, marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 12, color: COLORS.chalkDim, lineHeight: 1.4 }}>
              {STAT_DEFINITIONS[s.key]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Settings sheet — theme, print preferences, and account/team actions
// consolidated in one place instead of scattered across Roster and Lineup ----
function SettingsSheet({
  onClose,
  theme,
  setTheme,
  includePairingsRoster,
  setIncludePairingsRoster,
  includePairingsLineup,
  setIncludePairingsLineup,
  teamCode,
  setTeamCode,
  setUnlockedWith,
  exportAllData,
}) {
  const checkboxRow = (checked, onToggle, label) => (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        background: "none",
        border: "none",
        padding: "6px 0",
        color: COLORS.chalkDim,
        fontSize: 12,
        textAlign: "left",
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: `1.5px solid ${checked ? COLORS.orange : COLORS.line}`,
          background: checked ? COLORS.orange : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {checked && <Check size={11} color={COLORS.bg} />}
      </span>
      {label}
    </button>
  );

  const actionBtn = (onClick, label, style = {}) => (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "9px",
        marginBottom: 8,
        borderRadius: 8,
        border: `1px solid ${COLORS.line}`,
        background: "none",
        color: COLORS.chalk,
        fontSize: 12,
        fontWeight: 700,
        ...style,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.bgRaised,
          width: "100%",
          borderRadius: "20px 20px 0 0",
          padding: 18,
          maxHeight: "85%",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase" }}>
            Settings
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.chalkDim }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Appearance
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {["light", "dark"].map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 8,
                border: `1.5px solid ${theme === t ? COLORS.orange : COLORS.line}`,
                background: theme === t ? "rgba(255,107,53,0.12)" : "transparent",
                color: COLORS.chalk,
                fontWeight: 700,
                fontSize: 13,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
          Printing
        </div>
        <div style={{ marginBottom: 18 }}>
          {checkboxRow(includePairingsRoster, () => setIncludePairingsRoster((v) => !v), "Include pairings when printing roster")}
          {checkboxRow(includePairingsLineup, () => setIncludePairingsLineup((v) => !v), "Include pairings when printing lineup sheet")}
        </div>

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Team
        </div>
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
          Team code: <b style={{ color: COLORS.chalk }}>{teamCode}</b>
        </div>
        {actionBtn(() => setUnlockedWith(""), "Lock This Device Now")}
        {actionBtn(() => {
          if (window.confirm("Unlink this device from its current team? You'll be asked to create or join a team again.")) {
            setTeamCode("");
          }
        }, "Switch Team")}
        {actionBtn(exportAllData, "Export All Data (Backup)", {
          border: `1px solid ${COLORS.blue}`,
          background: "rgba(62,124,166,0.1)",
        })}
        <div style={{ textAlign: "center", fontSize: 10, color: COLORS.chalkDim, marginTop: 10 }}>
          Volley Bandit · Build {APP_VERSION}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("roster");
  const [showStatInfo, setShowStatInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Theme is a per-device display preference, not team data — stays local,
  // not synced through Firestore, so each device can pick its own.
  const [theme, setTheme] = usePersisted("vb-theme", "dark");
  Object.assign(COLORS, theme === "light" ? LIGHT_COLORS : DARK_COLORS);

  // Persist which passcode this specific device last unlocked with — if
  // APP_PASSCODE (below) changes, this stops matching and the device
  // re-locks automatically, even if it was already unlocked before.
  const [unlockedWith, setUnlockedWith] = usePersisted("vb-unlocked-with", "");
  const locked = APP_PASSCODE.trim() !== "" && unlockedWith !== APP_PASSCODE;

  // Which team's data this device is linked to — stays local per device on
  // purpose, since it's literally "which team is this device pointing at."
  // Everything the team code unlocks below is what actually syncs.
  const [teamCode, setTeamCode] = usePersisted("vb-team-code", "");

  const MAIN_DEFAULT = {
    roster: [],
    captainId: null,
    lineups: [
      {
        id: 1,
        name: "Set 1",
        slots: { P1: null, P2: null, P3: null, P4: null, P5: null, P6: null },
        liberos: [null, null],
        pairings: [],
        currentRotation: 1,
        setNumber: 1,
      },
    ],
    activeLineupId: 1,
    score: { us: 0, opp: 0 },
    subCount: 0,
    liberoSubCount: 0,
    injuredPlayerIds: [],
    matches: [],
    activeMatchId: null,
    statsView: { section: "boxscore", insightsMatchId: null },
    trendSubject: "team",
    teamName: "",
    coachName: "",
    includePairingsRoster: false,
    includePairingsLineup: false,
    roleSystem: { system: "5-1" },
  };
  const LOGS_DEFAULT = { log: [], pointLog: [] };
  const BRANDING_DEFAULT = { teamLogo: null };

  const [mainDoc, setMainDoc, mainLoaded, mainError] = useTeamDoc(teamCode, "main", MAIN_DEFAULT);
  const [logsDoc, setLogsDoc, logsLoaded, logsError] = useTeamDoc(teamCode, "logs", LOGS_DEFAULT);
  const [brandingDoc, setBrandingDoc, brandingLoaded, brandingError] = useTeamDoc(teamCode, "branding", BRANDING_DEFAULT);
  const syncError = mainError || logsError || brandingError;

  // Small helper: makes `const setX = fieldSetter(setMainDoc, "x")` behave
  // exactly like the old per-field useState setters — including functional
  // updates like setX(prev => ...) — so every screen below needed zero changes.
  const fieldSetter = (setDocFn, key) => (updater) =>
    setDocFn((prev) => ({ ...prev, [key]: typeof updater === "function" ? updater(prev[key]) : updater }));

  const roster = mainDoc.roster;
  const setRoster = fieldSetter(setMainDoc, "roster");
  const captainId = mainDoc.captainId;
  const setCaptainId = fieldSetter(setMainDoc, "captainId");
  const lineups = mainDoc.lineups;
  const setLineups = fieldSetter(setMainDoc, "lineups");
  const activeLineupId = mainDoc.activeLineupId;
  const setActiveLineupId = fieldSetter(setMainDoc, "activeLineupId");
  const score = mainDoc.score;
  const setScore = fieldSetter(setMainDoc, "score");
  const subCount = mainDoc.subCount;
  const setSubCount = fieldSetter(setMainDoc, "subCount");
  const liberoSubCount = mainDoc.liberoSubCount;
  const setLiberoSubCount = fieldSetter(setMainDoc, "liberoSubCount");
  const injuredPlayerIds = mainDoc.injuredPlayerIds || [];
  const setInjuredPlayerIds = fieldSetter(setMainDoc, "injuredPlayerIds");
  const matches = mainDoc.matches;
  const setMatches = fieldSetter(setMainDoc, "matches");
  const activeMatchId = mainDoc.activeMatchId;
  const setActiveMatchId = fieldSetter(setMainDoc, "activeMatchId");
  const statsView = mainDoc.statsView;
  const setStatsView = fieldSetter(setMainDoc, "statsView");
  const trendSubject = mainDoc.trendSubject;
  const setTrendSubject = fieldSetter(setMainDoc, "trendSubject");
  const teamName = mainDoc.teamName;
  const setTeamName = fieldSetter(setMainDoc, "teamName");
  const coachName = mainDoc.coachName;
  const setCoachName = fieldSetter(setMainDoc, "coachName");
  const includePairingsRoster = mainDoc.includePairingsRoster;
  const setIncludePairingsRoster = fieldSetter(setMainDoc, "includePairingsRoster");
  const includePairingsLineup = mainDoc.includePairingsLineup;
  const setIncludePairingsLineup = fieldSetter(setMainDoc, "includePairingsLineup");
  const roleSystem = mainDoc.roleSystem || { system: "5-1" };
  const setRoleSystem = fieldSetter(setMainDoc, "roleSystem");

  const log = logsDoc.log;
  const setLog = fieldSetter(setLogsDoc, "log");
  const pointLog = logsDoc.pointLog;
  const setPointLog = fieldSetter(setLogsDoc, "pointLog");

  const teamLogo = brandingDoc.teamLogo;
  const updateTeamLogo = (dataUrl) => setBrandingDoc((prev) => ({ ...prev, teamLogo: dataUrl }));

  const dataLoaded = mainLoaded && logsLoaded && brandingLoaded;

  // A full backup of everything this team's data actually is — the one
  // recovery path if a team code ever got lost or something went wrong,
  // since there's no other way to pull this back out of Firestore.
  const exportAllData = () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadJSON(`volley-bandit-backup-${teamCode}-${dateStr}.json`, {
      teamCode,
      exportedAt: new Date().toISOString(),
      main: mainDoc,
      logs: logsDoc,
      branding: brandingDoc,
    });
  };

  // Advances to the next set: requires that set's lineup already exists
  // (created or duplicated on the Lineup screen) — blocks with a clear
  // message rather than silently guessing which lineup to use. Resets the
  // scoreboard and switches to that lineup, freshly at Rotation 1.
  const startNextSet = () => {
    const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0];
    const nextSetNumber = (activeLineup.setNumber || 1) + 1;
    const nextLineup = lineups.find((l) => l.setNumber === nextSetNumber);
    if (!nextLineup) {
      alert(`The lineup for Set ${nextSetNumber} needs to be created — create or duplicate a lineup on the Lineup screen first.`);
      return;
    }
    setScore({ us: 0, opp: 0 });
    setSubCount(0);
    setLiberoSubCount(0);
    setLineups((prev) => prev.map((l) => (l.id === nextLineup.id ? { ...l, currentRotation: 1 } : l)));
    setActiveLineupId(nextLineup.id);
  };

  // Ends the active match: resets the live scoreboard, returns to Set 1's
  // lineup (freshly at Rotation 1) so the next match starts clean, and
  // clears which match is active so new stat entries don't accidentally get
  // logged against a match that's already finished. Stats already recorded
  // stay exactly where they are — this only resets live-tracking state.
  const endMatch = () => {
    const setOneLineup = lineups.find((l) => l.setNumber === 1) || lineups[0];
    setScore({ us: 0, opp: 0 });
    setSubCount(0);
    setLiberoSubCount(0);
    setInjuredPlayerIds([]);
    setLineups((prev) => prev.map((l) => ({ ...l, currentRotation: 1 })));
    setActiveLineupId(setOneLineup.id);
    setActiveMatchId(null);
  };

  const titles = {
    roster: { title: "Roster", sub: "Your full team" },
    lineup: { title: "Lineup", sub: "Tap a slot to assign a player" },
    live: { title: "Live Stats", sub: "Riverside High vs. Lincoln" },
    box: { title: "Stats", sub: "Box score, insights, trends & season" },
    schedule: { title: "Schedule", sub: "Upcoming and past matches" },
  };

  // Only these four have a standard printable format; Live has no print action.
  const PRINTABLE_TABS = { roster: "roster", lineup: "lineup", box: "box", schedule: "schedule" };

  // Generates a real PDF from the active print section and hands it to the
  // OS share sheet (Print, Save to Files, AirDrop, Mail — whatever the
  // device offers) instead of calling window.print() directly. This is the
  // actual fix for iOS's well-documented unreliability with print() inside
  // an installed home-screen PWA: it sidesteps that API entirely rather than
  // trying to work around it, using the same file-sharing path any other app
  // uses. Falls back to a plain file download on browsers that don't support
  // sharing files (most desktop browsers).
  const [printing, setPrinting] = useState(false);
  const [printChoiceOpen, setPrintChoiceOpen] = useState(false);
  const [printTarget, setPrintTarget] = useState(null); // null = use the current tab's default target
  const handlePrint = async () => {
    if (printing) return;
    setPrinting(true);
    const root = document.getElementById("print-root");
    try {
      // Make the print sheet capturable only for this moment — it's
      // display:none the rest of the time, so no ongoing background
      // rendering work happens while the app is just sitting there in
      // normal use.
      root.classList.add("print-root-capturing");
      // Give the browser a real layout+paint cycle before capturing —
      // double rAF is the standard reliable way to wait for an actual paint,
      // not just the next event loop tick.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const activeSection = root?.querySelector(".print-section.active");
      if (!activeSection) return;

      const canvas = await html2canvas(activeSection, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });

      const pdf = new jsPDF("p", "pt", "letter");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const MARGIN = 36; // half-inch margin on all sides
      const contentWidth = pageWidth - MARGIN * 2;
      const contentHeight = pageHeight - MARGIN * 2;

      // Slice the source canvas into separate per-page images sized to
      // exactly fit inside the margin box, rather than positioning one huge
      // image and hoping the page edge clips it — that's what was causing
      // content to run edge-to-edge with no margin. This also keeps each
      // individual image small (helps avoid hitting canvas/memory limits on
      // iOS specifically, and JPEG compression here cuts file size a lot
      // versus the uncompressed PNG this used before).
      const scaleFactor = contentWidth / canvas.width;
      const sliceHeightPx = contentHeight / scaleFactor;
      let renderedPx = 0;
      let pageIndex = 0;
      while (renderedPx < canvas.height) {
        const thisSliceHeightPx = Math.min(sliceHeightPx, canvas.height - renderedPx);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = thisSliceHeightPx;
        const ctx = sliceCanvas.getContext("2d");
        ctx.drawImage(canvas, 0, renderedPx, canvas.width, thisSliceHeightPx, 0, 0, canvas.width, thisSliceHeightPx);
        const sliceData = sliceCanvas.toDataURL("image/jpeg", 0.85);
        if (pageIndex > 0) pdf.addPage();
        pdf.addImage(sliceData, "JPEG", MARGIN, MARGIN, contentWidth, thisSliceHeightPx * scaleFactor);
        renderedPx += thisSliceHeightPx;
        pageIndex++;
      }

      const blob = pdf.output("blob");
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `volley-bandit-${printTarget || tab}-${dateStr}.pdf`;
      const file = new File([blob], filename, { type: "application/pdf" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
        } catch (shareErr) {
          // The user closing the share sheet counts as "AbortError" — that's
          // normal, not a failure, so only real errors get the alert below.
          if (shareErr.name !== "AbortError") throw shareErr;
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      // Include the actual error message directly in the alert — mobile
      // Safari's console isn't reachable without a Mac plugged in via cable,
      // so this is the only practical way to see what actually went wrong.
      console.warn("PDF export failed:", err);
      alert(`Couldn't generate the PDF: ${err?.message || err}`);
    } finally {
      root.classList.remove("print-root-capturing"); // always hide it again, success or failure
      setPrinting(false);
      setPrintTarget(null); // don't let a sub-sheet choice leak into the next unrelated print
    }
  };

  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState(false);

  const tryUnlock = () => {
    if (passcodeInput === APP_PASSCODE) {
      setUnlockedWith(APP_PASSCODE);
      setPasscodeInput("");
      setPasscodeError(false);
    } else {
      setPasscodeError(true);
    }
  };

  if (locked) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0B0D10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Inter:wght@400;600;700&display=swap');`}</style>
        <div style={{ width: 300, textAlign: "center" }}>
          {teamLogo && (
            <img src={teamLogo} alt="" style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover", marginBottom: 12 }} />
          )}
          <div
            style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: 20,
              fontWeight: 700,
              color: COLORS.chalk,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 20,
            }}
          >
            Volley Bandit
          </div>
          <input
            type="password"
            autoFocus
            value={passcodeInput}
            onChange={(e) => {
              setPasscodeInput(e.target.value);
              setPasscodeError(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
            placeholder="Enter passcode"
            style={{
              width: "100%",
              padding: "12px 14px",
              marginBottom: 10,
              background: COLORS.bgRaised,
              border: `1.5px solid ${passcodeError ? COLORS.red : COLORS.line}`,
              borderRadius: 8,
              color: COLORS.chalk,
              fontSize: 15,
              textAlign: "center",
            }}
          />
          {passcodeError && (
            <div style={{ color: COLORS.red, fontSize: 12, marginBottom: 10 }}>Wrong passcode — try again.</div>
          )}
          <button
            onClick={tryUnlock}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: 8,
              border: "none",
              background: COLORS.orange,
              color: "#1C2128",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Unlock
          </button>
        </div>
      </div>
    );
  }

  if (!teamCode) {
    return <TeamGate onLinked={setTeamCode} />;
  }

  if (!dataLoaded) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0B0D10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: COLORS.chalkDim,
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 13,
        }}
      >
        Loading team data…
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      style={{
        width: "100%",
        background: "#0B0D10",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');
        html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
        * { box-sizing: border-box; }
        button { font-family: inherit; }
        /* 100vh first as a fallback for older browsers that don't recognize
           dvh at all (they'll just ignore the second, unrecognized line and
           keep using the first) — dvh overrides it where it's supported and
           correctly accounts for mobile browser chrome. */
        .app-shell { height: 100vh; height: 100dvh; }
        /* print-root stays fully display:none by default — same as before
           the PDF feature — so the browser does zero ongoing work on it.
           It only gets toggled visible for the brief moment a PDF is being
           captured (see handlePrint), never left rendered in the background.
           Leaving it permanently off-screen-but-rendered (an earlier version
           of this fix) forced constant layout/paint work that was busy
           enough to make Firestore's persistent connection look "offline"
           even on a fine network — this is the actual fix for that. */
        #print-root { display: none; }
        #print-root.print-root-capturing {
          display: block;
          position: fixed;
          top: 0;
          left: -9999px;
          width: 816px;
          background: #fff;
          color: #000;
          padding: 32px;
          font-family: 'Inter', system-ui, sans-serif;
        }
        .print-section { display: none; }
        .print-section.active { display: block; }
        @media print {
          body * { visibility: hidden !important; }
          #print-root, #print-root * { visibility: visible !important; }
          #print-root {
            display: block;
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
          }
        }
      `}</style>
      <PrintArea
        target={printTarget || PRINTABLE_TABS[tab] || null}
        roster={roster}
        lineups={lineups}
        activeLineupId={activeLineupId}
        log={log}
        score={score}
        matches={matches}
        captainId={captainId}
        teamName={teamName}
        coachName={coachName}
        activeMatchId={activeMatchId}
        teamLogo={teamLogo}
        statsView={statsView}
        trendSubject={trendSubject}
        pointLog={pointLog}
        includePairingsRoster={includePairingsRoster}
        includePairingsLineup={includePairingsLineup}
      />
      <PhoneFrame>
        {syncError && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 20,
              background: COLORS.red,
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              textAlign: "center",
              padding: "6px 10px",
            }}
          >
            {syncError}
          </div>
        )}
        <TopBar
          title={titles[tab].title}
          sub={titles[tab].sub}
          onPrint={PRINTABLE_TABS[tab] ? (tab === "lineup" ? () => setPrintChoiceOpen(true) : handlePrint) : null}
          printing={printing}
          teamLogo={teamLogo}
          onInfo={tab === "box" ? () => setShowStatInfo(true) : null}
          onSettings={() => setShowSettings(true)}
        />
        {printChoiceOpen && (
          <div
            onClick={() => setPrintChoiceOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-end",
              zIndex: 10,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.bgRaised,
                width: "100%",
                borderRadius: "20px 20px 0 0",
                padding: 18,
              }}
            >
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase", marginBottom: 14 }}>
                What to Print
              </div>
              <button
                onClick={() => {
                  setPrintChoiceOpen(false);
                  setPrintTarget(null);
                  handlePrint();
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginBottom: 8,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.orange}`,
                  background: "rgba(255,107,53,0.12)",
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Lineup Sheet
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  Coach reference — roster, court diagrams, pairings list
                </div>
              </button>
              <button
                onClick={() => {
                  setPrintChoiceOpen(false);
                  setPrintTarget("subsheet");
                  handlePrint();
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.green}`,
                  background: "rgba(76,154,99,0.12)",
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Player Sub Sheet
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  Hand to players — numbers only, by rotation
                </div>
              </button>
            </div>
          </div>
        )}
        {showStatInfo && <StatInfoSheet onClose={() => setShowStatInfo(false)} />}
        {showSettings && (
          <SettingsSheet
            onClose={() => setShowSettings(false)}
            theme={theme}
            setTheme={setTheme}
            includePairingsRoster={includePairingsRoster}
            setIncludePairingsRoster={setIncludePairingsRoster}
            includePairingsLineup={includePairingsLineup}
            setIncludePairingsLineup={setIncludePairingsLineup}
            teamCode={teamCode}
            setTeamCode={setTeamCode}
            setUnlockedWith={setUnlockedWith}
            exportAllData={exportAllData}
          />
        )}
        {tab === "roster" && (
          <RosterScreen
            roster={roster}
            setRoster={setRoster}
            captainId={captainId}
            setCaptainId={setCaptainId}
            lineups={lineups}
            setLineups={setLineups}
            teamName={teamName}
            setTeamName={setTeamName}
            coachName={coachName}
            setCoachName={setCoachName}
            teamLogo={teamLogo}
            updateTeamLogo={updateTeamLogo}
            log={log}
            setLog={setLog}
          />
        )}
        {tab === "lineup" && (
          <LineupScreen
            lineups={lineups}
            setLineups={setLineups}
            activeLineupId={activeLineupId}
            roster={roster}
            setRoster={setRoster}
            captainId={captainId}
            setCaptainId={setCaptainId}
            roleSystem={roleSystem}
            setRoleSystem={setRoleSystem}
          />
        )}
        {tab === "live" && (
          <LiveScreen
            lineups={lineups}
            setLineups={setLineups}
            activeLineupId={activeLineupId}
            setActiveLineupId={setActiveLineupId}
            roster={roster}
            log={log}
            setLog={setLog}
            score={score}
            setScore={setScore}
            subCount={subCount}
            setSubCount={setSubCount}
            liberoSubCount={liberoSubCount}
            setLiberoSubCount={setLiberoSubCount}
            injuredPlayerIds={injuredPlayerIds}
            setInjuredPlayerIds={setInjuredPlayerIds}
            activeMatchId={activeMatchId}
            pointLog={pointLog}
            setPointLog={setPointLog}
            onStartNextSet={startNextSet}
            setTab={setTab}
          />
        )}
        {tab === "box" && (
          <BoxScoreScreen
            log={log}
            setLog={setLog}
            roster={roster}
            matches={matches}
            lineups={lineups}
            activeMatchId={activeMatchId}
            statsView={statsView}
            setStatsView={setStatsView}
            pointLog={pointLog}
            trendSubject={trendSubject}
            setTrendSubject={setTrendSubject}
            onEndMatch={endMatch}
          />
        )}
        {tab === "schedule" && (
          <ScheduleScreen
            matches={matches}
            setMatches={setMatches}
            activeMatchId={activeMatchId}
            setActiveMatchId={setActiveMatchId}
            setTab={setTab}
            setStatsView={setStatsView}
          />
        )}
        <TabBar tab={tab} setTab={setTab} />
      </PhoneFrame>
    </div>
  );
}
