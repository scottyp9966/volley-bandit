import React, { useState, useMemo, useRef, useEffect } from "react";
import { Undo2, Plus, Minus, Check, X, Users, Activity, ClipboardList, Circle, Calendar, Copy, Trash2, ClipboardPaste, Pencil, ChevronsRight, LayoutGrid, Printer, Image as ImageIcon, HelpCircle, Settings as SettingsIcon, Repeat } from "lucide-react";
import { doc, collection, onSnapshot, setDoc, getDoc, deleteDoc, writeBatch } from "firebase/firestore";
import { db } from "./firebase.js";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import { registerSW } from "virtual:pwa-register";
import TournamentBuilder from "./TournamentBuilder.jsx";
import { Trophy } from "lucide-react";
import { COLORS, DARK_COLORS, LIGHT_COLORS, usePersisted, displayName, fullName, todayISO, jerseyFor, jerseyLabel } from "./shared.js";
import { generateCodes, buildPublishedSet, entitlementsOf, playerInviteMessage, CODE_STYLES, CODE_STYLE_NOTES } from "./playerAccess.js";
import {
  generateAssistantCode,
  assistantAccessOf,
  orderTabs,
  ASSISTANT_TABS,
} from "./teamAccess.js";

// NOTE: these are deliberately STATIC imports, even though jsPDF and
// html2canvas are only used by Print and are a large share of the bundle.
// They were briefly made dynamic (`await import(...)`) to shrink the
// initial load — but that introduced runtime chunk fetching into an app
// that redeploys constantly, and every deploy changes the hashed chunk
// filenames. A device still running an older build that then tries to
// lazy-load a chunk gets a 404 for a file that no longer exists on the
// deployment, which is a failure mode a single self-contained bundle
// simply cannot have. For a PWA used courtside on flaky gym wifi, "always
// works offline from one bundle" beats "loads slightly less JS up front."
// Don't reintroduce dynamic imports here without a cache-busting/recovery
// story for stale clients.

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
const APP_VERSION = "2026.10.24a";

// Two palettes, switched via a Settings toggle. COLORS itself stays a
// mutable object (not reassigned, just its properties updated in place) so
// every existing style in the app — which reads COLORS.xxx directly — picks
// up the new values automatically on the next render, without needing every
// single component rewritten to consume a theme prop or context.
// The *Soft keys are the translucent fills behind a colored button or a
// selected row. They're palette entries rather than inline rgba() literals
// because every one of those literals was a dark-theme hue: in light mode
// the whole app drew a salmon-orange tint for "selected" while the light
// accent is actually dark green, and the fills were so pale they read as
// washed out. Light mode uses both darker hues and stronger alpha.
// tintHex is the same idea as an 8-digit hex suffix, for the stat buttons
// which tint from their own per-stat color rather than a fixed one.
// DARK_COLORS/LIGHT_COLORS/COLORS and usePersisted now live in shared.js so
// TournamentBuilder.jsx can reuse them without a circular import with this
// file.

// The companion Player Eval app's deployed URL — used for the "Open Player
// Eval" link in Settings, carrying the current team code as a `?code=` deep
// link so the coach doesn't have to retype it over there.
const PLAYER_EVAL_URL = "https://player-eval-three.vercel.app";
// The one URL every player uses, whatever team or organisation she's on — she
// types her own code there. Live: its own Vercel project, root directory
// `player-stats`. "my-stats" rather than "stats" on purpose — it's one
// player's own card, not the team's numbers.
const PLAYER_STATS_URL = "https://volley-bandit-my-stats.vercel.app";

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

const normalizeTeamCode = (raw) => raw.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);

// Used only by the `?code=` deep-link auto-join below (see App()) — a
// team code created only in the companion Player Eval app has no "main"
// doc yet, so a plain Volley Bandit join (checkAndJoin, which only checks
// "main") would wrongly report it as not found. This checks both apps'
// docs so a link from Player Eval still lands successfully.
async function teamCodeExistsAnywhere(code) {
  const mainSnap = await getDoc(doc(db, "teams", code, "data", "main"));
  if (mainSnap.exists()) return true;
  const evalSnap = await getDoc(doc(db, "teams", code, "data", "playerEval"));
  return evalSnap.exists();
}

// Shared shape with Player Eval's identical hook — see that app's App.jsx
// for the fuller explanation. Reads `?code=` once on mount, verifies it,
// and either joins automatically or reports why not so TeamGate can show
// the coach a join screen pre-filled with the code and the real reason.
function useDeepLinkJoin(teamCode, setTeamCode) {
  const [state, setState] = useState(() => {
    const code = normalizeTeamCode(new URLSearchParams(window.location.search).get("code") || "");
    return code && !teamCode ? { status: "checking", code } : { status: "none" };
  });

  useEffect(() => {
    if (state.status !== "checking") return;
    let cancelled = false;
    teamCodeExistsAnywhere(state.code)
      .then((exists) => {
        if (cancelled) return;
        window.history.replaceState(null, "", window.location.pathname);
        if (exists) {
          setTeamCode(state.code);
          setState({ status: "none" });
        } else {
          setState({ status: "failed", code: state.code });
        }
      })
      .catch(() => {
        if (cancelled) return;
        window.history.replaceState(null, "", window.location.pathname);
        setState({ status: "failed", code: state.code, error: "Couldn't check that code — check your connection and try again." });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  return state;
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

  // Writes ONLY the top-level fields this change actually touched, merged
  // into the server's document — not the whole document.
  //
  // This used to be `setDoc(ref, next, { merge: false })`, which replaces
  // the entire document with whatever that one device happens to hold. With
  // two devices on the same team code that is last-writer-wins across
  // *everything*: a phone sitting on stale state that changes the score —
  // or that flushes a write queued while it was offline — overwrites the
  // roster, the lineups, the matches and the whole stat log that a tablet
  // recorded an hour earlier. That is a real data-loss shape, not a
  // theoretical one, and it's why a match entered on one device could go
  // missing.
  //
  // Reference equality is the right diff here: state updates go through
  // `fieldSetter`, which rebuilds the wrapper (`{ ...prev, [field]: v }`)
  // and leaves every other field pointing at the same object, and a
  // snapshot rebuilds all of them together. So a changed field is exactly a
  // field whose reference moved. Worst case a field is written that didn't
  // need to be, which is harmless; the point is that fields nobody touched
  // are never sent at all, so they can't be clobbered.
  //
  // This does NOT make concurrent edits to the SAME field safe — two
  // devices both recording stats still both write `log`, and the later
  // write wins. Fixing that properly needs per-entry documents or
  // arrayUnion; until then, live stat entry belongs on one device.
  const update = (updater) => {
    const prev = valueRef.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    valueRef.current = next;
    setValue(next);
    if (!teamCode) return;
    const changed = {};
    for (const key of Object.keys(next)) {
      if (!Object.is(next[key], prev?.[key])) changed[key] = next[key];
    }
    if (Object.keys(changed).length === 0) return;
    const ref = doc(db, "teams", teamCode, "data", docName);
    setDoc(ref, changed, { merge: true })
      .then(() => setError(null))
      .catch((err) => {
        console.warn(`Save error on ${docName}:`, err);
        setError(`Couldn't save your last change to ${docName} — check your connection.`);
      });
  };

  return [value, update, loaded, error];
}

// Firestore caps a single batched write at 500 operations, so anything
// bulk (the one-time migration below, a restore, deleting a player who has
// a season of stats) is committed in chunks of this size.
const WRITE_BATCH_LIMIT = 450;

// Syncs a COLLECTION — one Firestore document per entry — rather than one
// document holding an array of them. This is what the stat log and the
// point log use.
//
// They used to be two arrays (`log`, `pointLog`) inside the `logs`
// document, and that shape cannot survive two devices recording at once.
// Writing one array is a whole-field write: a tablet and a phone both
// recording the same match each send their own complete copy of `log`, and
// the later one wins outright — every stat the other device recorded in
// between is gone. The field-level merge in `useTeamDoc` above fixed
// devices clobbering each OTHER'S fields; it can't fix two devices writing
// the SAME field, which is exactly what live stat entry is.
//
// One document per entry has no such conflict: a stat recorded on the
// tablet and a stat recorded on the phone are different documents, so both
// land, in any order, online or queued from offline. A delete is a real
// document delete rather than "here is my idea of the whole array minus
// one", so it can't resurrect entries another device added or re-delete
// entries another device removed.
//
// Entries keep their existing numeric `id` (`Date.now() + Math.random()`)
// as both a field and the document id, which is what makes the migration
// idempotent — two devices migrating the same legacy array simply write
// the same documents twice.
function useTeamCollection(teamCode, collName) {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    if (!teamCode) {
      setEntries([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    const unsub = onSnapshot(
      collection(db, "teams", teamCode, collName),
      (snap) => {
        const next = [];
        snap.forEach((d) => next.push(d.data()));
        // Ids are timestamps, so this is chronological — the order every
        // reader (the undo tray, the box score, Insights) assumes.
        next.sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
        setEntries(next);
        setLoaded(true);
        setError(null);
      },
      (err) => {
        console.warn(`Sync error on ${collName}:`, err);
        setLoaded(true);
        setError(`Couldn't load ${collName} — check your connection.`);
      }
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCode, collName]);

  const entryRef = (id) => doc(db, "teams", teamCode, collName, String(id));

  // Every op resolves to true/false rather than rejecting, so a caller can
  // branch on success (the migration does) without leaving an unhandled
  // rejection behind for callers that don't care.
  const settle = (promise) =>
    promise.then(
      () => {
        setError(null);
        return true;
      },
      (err) => {
        console.warn(`Save error on ${collName}:`, err);
        setError(`Couldn't save your last change to ${collName} — check your connection.`);
        return false;
      }
    );

  const runBatches = (items, apply) => {
    if (!teamCode || items.length === 0) return Promise.resolve(true);
    const chunks = [];
    for (let i = 0; i < items.length; i += WRITE_BATCH_LIMIT) chunks.push(items.slice(i, i + WRITE_BATCH_LIMIT));
    return settle(
      Promise.all(
        chunks.map((chunk) => {
          const batch = writeBatch(db);
          chunk.forEach((item) => apply(batch, item));
          return batch.commit();
        })
      )
    );
  };

  const ops = {
    put(entry) {
      if (!teamCode || entry?.id == null) return Promise.resolve(false);
      return settle(setDoc(entryRef(entry.id), entry));
    },
    putMany(list) {
      const valid = (list || []).filter((e) => e?.id != null);
      return runBatches(valid, (batch, entry) => batch.set(entryRef(entry.id), entry));
    },
    remove(id) {
      if (!teamCode || id == null) return Promise.resolve(false);
      return settle(deleteDoc(entryRef(id)));
    },
    removeMany(ids) {
      const valid = (ids || []).filter((id) => id != null);
      return runBatches(valid, (batch, id) => batch.delete(entryRef(id)));
    },
    // Used by Restore From Backup, which deliberately replaces rather than
    // merges — see restoreFromBackup. Everything currently here goes,
    // including entries this device hasn't got round to rendering.
    replaceAll(list) {
      const keep = new Set((list || []).map((e) => String(e?.id)));
      const stale = entriesRef.current.map((e) => e.id).filter((id) => !keep.has(String(id)));
      return ops.removeMany(stale).then(() => ops.putMany(list));
    },
  };

  return [entries, ops, loaded, error];
}

// Unions the legacy in-document array half of a log with its collection
// half. Deduped by id with the collection winning, since that's the side
// that gets edited once an entry has been migrated, and sorted by id
// (a timestamp) so the result is chronological either way.
function mergeEntries(legacy, fromCollection) {
  const legacyArr = Array.isArray(legacy) ? legacy : [];
  if (legacyArr.length === 0) return fromCollection;
  const byId = new Map();
  for (const e of legacyArr) if (e?.id != null) byId.set(String(e.id), e);
  for (const e of fromCollection) if (e?.id != null) byId.set(String(e.id), e);
  return [...byId.values()].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
}

// Rewrites every reference to `dropId` into `keepId` inside one lineup-shaped
// object — used for real lineups and for a match's frozen lineupSnapshots,
// which hold the same three fields.
//
// The awkward cases are the ones that only exist because the two ids used to
// be two different people: both of them on court at once (impossible for one
// player, so the dropped one's slot is vacated rather than doubling the keeper
// up), both listed as liberos, and a pairing BETWEEN them — which was the
// coach pairing someone with herself in different jerseys, and is simply
// deleted.
function remapLineupPlayer(lineup, dropId, keepId) {
  if (!lineup) return lineup;
  const slots = { ...(lineup.slots || {}) };
  const keepAlreadyOnCourt = Object.values(slots).some((v) => v === keepId);
  for (const [slot, v] of Object.entries(slots)) {
    if (v === dropId) slots[slot] = keepAlreadyOnCourt ? null : keepId;
  }
  const liberos = (lineup.liberos || [null, null]).map((v) => (v === dropId ? keepId : v));
  // one player can't hold both libero slots
  if (liberos[0] === keepId && liberos[1] === keepId) liberos[1] = null;
  const seen = new Set();
  const pairings = (lineup.pairings || [])
    .map((pr) => ({
      ...pr,
      frontId: pr.frontId === dropId ? keepId : pr.frontId,
      backId: pr.backId === dropId ? keepId : pr.backId,
    }))
    .filter((pr) => pr.frontId !== pr.backId)
    .filter((pr) => {
      const key = `${pr.frontId}-${pr.backId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { ...lineup, slots, liberos, pairings };
}

// Short label for the live scoreboard. A full team name won't fit above a
// 40px stepper on a phone, so take the first word — "Grafton High School JV1
// Volleyball" reads as GRAFTON, "Shrewsbury - JV" as SHREWSBURY. The coach can
// override their own side with `teamAbbr` when the first word isn't the one
// that identifies the team.
function scoreLabel(name, fallback) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const clean = first.replace(/[^A-Za-z0-9'-]/g, "");
  return clean ? clean.slice(0, 10).toUpperCase() : fallback;
}

const LIBERO_ROLE_LABEL = { any: "ANY", receive: "RECEIVE", serve: "SERVE" };

// Who is serving RIGHT NOW. In rally scoring whoever won the last rally
// serves the next one, so this falls out of the point log with nothing extra
// for the coach to tap; before the first point of a set it's whatever the
// lineup says about who served first.
//
// The catch is that it's only as good as the scoreboard. A coach who stops
// tapping points mid-set would silently get the wrong answer, so the lineup
// can also carry a one-rally override (`servingOverride`) — see
// `servingState`. The override is pinned to the point count it was set at,
// which is what stops it going stale: the very next point resolves
// possession for real and the override stops applying on its own.
function pointsThisSet(pointLog, matchId, setNumber) {
  return (pointLog || []).filter(
    (e) => (e.matchId ?? null) === (matchId ?? null) && (e.setNumber || 1) === setNumber
  );
}

function servingState(pointLog, matchId, setNumber, lineup) {
  const pts = pointsThisSet(pointLog, matchId, setNumber);
  const last = pts[pts.length - 1];
  const derived = last ? last.team === "us" : (lineup?.servesFirst || "us") === "us";
  const o = lineup?.servingOverride;
  const overridden =
    o && o.setNumber === setNumber && o.at === pts.length && typeof o.serving === "boolean";
  return {
    serving: overridden ? o.serving : derived,
    derived,
    overridden: !!overridden,
    pointCount: pts.length,
  };
}

// Captains are a LIST — co-captains are normal, and a team can name two or
// three. The field used to be a single `captainId`, so every read goes through
// here: a team whose data hasn't been written since still shows its captain
// instead of suddenly having none.
function captainIdList(doc) {
  if (Array.isArray(doc?.captainIds)) return doc.captainIds;
  return doc?.captainId != null ? [doc.captainId] : [];
}

// displayName/fullName now live in shared.js alongside COLORS/usePersisted.

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

// Real volleyball rule this app didn't previously encode: a libero can
// come in for more than one back-row player over the course of a set (the
// common case being two middles who alternate which one is back row), but
// is only ever allowed to serve in ONE of those rotational turns — not
// both. So among any pairings sharing the same libero, exactly one can be
// flagged `liberoServes: true` (enforced in toggleLiberoServes below);
// this finds whichever pairing is the one actually substituted in right
// now — matched on "this libero is in the true server slot (P1 — the
// rotation math above keeps that always correct, live, regardless of
// which rotation is showing) AND the player they're subbed for isn't on
// court anywhere else" — so callers can show whether serving is currently
// allowed or the real player needs to swap in just to serve.
function findActiveLiberoPairing(slots, pairings) {
  return (
    (pairings || []).find(
      (pr) => pr.isLibero && slots.P1 === pr.backId && !Object.values(slots).includes(pr.frontId)
    ) || null
  );
}

// Computes the true, absolute arrangement for a given rotation number (1-6),
// with substitutions applied — regardless of which rotation the lineup is
// currently actually sitting at. Reconstructs true Rotation 1 first (same
// reverse-shift math Duplicate Lineup uses), then shifts forward from that
// known baseline. Shifting directly from whatever's currently on court would
// only be correct when the lineup happens to already be at Rotation 1 —
// this is what makes it correct no matter where it currently sits.
// The raw, pre-substitution arrangement for a given rotation — who's
// actually assigned to each rotational slot, before any pairing-driven sub
// is layered on top. This is what should ever get committed as a lineup's
// real starting data, since "Rotation 1" has always meant the pre-sub
// assignment, with pairings computing subs dynamically from that baseline
// as rotations progress — never something with a sub already baked in.
function computeRawRotationSlots(lineup, targetRotation) {
  const currentRotation = lineup.currentRotation || 1;
  const rotation1Slots = shiftSlotsClockwise(lineup.slots, 7 - currentRotation);
  return shiftSlotsClockwise(rotation1Slots, targetRotation - 1);
}

// For display/preview only (the court diagram, Serve-Receive) — the raw
// arrangement above with substitutions layered on top, showing who's
// actually on court right now including any active sub.
// One set's lineup, frozen for a match record: the STARTING six (rotation-1
// raw slots — raw because substitutions are layered on for display only and
// must never be committed as real lineup data), plus who was libero, the
// pairings in force, and who served first.
function buildLineupSnapshot(lineup, setNumber) {
  return {
    name: lineup.name,
    setNumber,
    slots: computeRawRotationSlots(lineup, 1),
    liberos: (lineup.liberos || []).filter(Boolean),
    pairings: lineup.pairings || [],
    servesFirst: lineup.servesFirst || null,
    capturedAt: Date.now(),
  };
}

function computeRotationSlots(lineup, targetRotation) {
  return applySubPairings(computeRawRotationSlots(lineup, targetRotation), lineup.pairings);
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
function deriveServeReceive(system, slots, roster, liberoIds, isAlternate, setterFront) {
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

  // Where each FRONT-ROW player ends up once the switch happens after the
  // serve is away. Rotational order only decides who is legally where at
  // contact; the moment the ball is served everyone slides to the spot they
  // actually play. Showing only the rotational spots — which this diagram
  // used to do, moving nothing but the setter — draws a front row nobody
  // ever stands in, with the middle out wide and the setter overlapping
  // whoever is really at right front.
  //
  // Two 4-2s, picked per team in the Offensive System sheet
  // (`roleSystem.setterFront`), because which one a squad runs changes the
  // whole front row and there is no way to infer it from the roster:
  //   "right"  — the advanced / "international" 4-2 this coach runs: setter
  //              sets from right front, middle blocker takes the middle,
  //              outside takes left front.
  //   "middle" — the classic beginner 4-2: setter sets from the middle
  //              (zone 3) and the two hitters take the pins, outside on the
  //              left, whoever else is up on the right.
  const frontSwitch = {};
  if (system === "4-2") {
    const middleSetter = setterFront === "middle";
    const claimed = new Set();
    const assign = (pos, target) => {
      if (!pos || claimed.has(target)) return;
      frontSwitch[pos] = target;
      claimed.add(target);
    };
    assign(sPositions.find(isFront), middleSetter ? "P3" : "P2");
    assign(ohPositions.find(isFront), "P4");
    // With the setter in the middle the other hitter takes the right pin; with
    // the setter on the right she takes the middle. Either way she gets
    // whichever of the two spots the setter didn't claim, so this is the same
    // line for both variants — it only reads differently.
    assign(mbPositions.find(isFront), middleSetter ? "P2" : "P3");
    // Anyone front row the tags didn't place — an Opposite, a DS pushed up,
    // a player with no position set — fills whatever front spot is left, so
    // nobody is silently stacked on top of someone else.
    positions
      .filter((pos) => isFront(pos) && playerAt[pos] && !frontSwitch[pos])
      .forEach((pos) => {
        const target = ["P2", "P3", "P4"].find((t) => !claimed.has(t));
        if (target) assign(pos, target);
      });
  }

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

  return { playerAt, activeSetterPos, backMBPos, liberoPlayer, passerPositions, backRowAttackPositions, frontSwitch };
}

// The whole Serve-Receive picture as data: where every player stands at the
// serve, where she goes after it, and the arrow path between. Module scope on
// purpose — `PrintArea` renders this too, and anything PrintArea calls must be
// module-scope or it is a ReferenceError that blanks the entire app (see
// CLAUDE.md). It reads `COLORS` only inside the call, never at module
// evaluation, so it stays theme-aware.
//
// `aspect` is the court box's width/height, which the arrowhead maths needs:
// a y percent covers more pixels than an x percent, so heads are built in
// squared-up space and converted back, or they come out skewed. Pass whatever
// the container actually uses.
function serveReceiveGeometry(system, slots, roster, liberos, isAlternate, setterFront, aspect = 0.82) {
  const layout = deriveServeReceive(system, slots, roster, liberos, isAlternate, setterFront);
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

  // STACKING. The overlap rule is judged only at the instant the server
  // contacts the ball, and only against the neighbours in your own row
  // (front row reads 4-3-2 left to right) and the player directly behind
  // you. So a front-row player who is about to switch doesn't have to
  // wait at her rotational spot — she may stand as close to where she's
  // heading as that left-to-right order allows. Bunching the front row
  // that way is exactly what coaches call stacking, and when all three
  // have to switch, that's what the front row actually looks like: three
  // players crowded together at the net, not spread across three zones.
  // Drawing them spread out was the real complaint about this sheet.
  //
  // Finding the stack is a least-squares fit: each player wants to be at
  // her destination, subject to staying in rotational order with a
  // visible gap between neighbours. That's isotonic regression, solved
  // by pool-adjacent-violators. The setter carries double weight because
  // hers is the run on a clock — she has to beat the pass to the net —
  // which is the same reason coaches stack toward the setter's side.
  // A REAL stack is a near-vertical column, not a row. The left-to-right
  // test needs only part of one foot: the player based front-right has to
  // stay a sliver right of the one to her left, nothing more. The
  // front-to-back test is against the back-row player she's paired with,
  // and the passers are at the back of the court, so depth is free. So
  // the three of them line up almost on top of each other, each a step
  // right of the last, staggered in depth. Spreading them across the
  // front the way an earlier pass did needed a 20% gap just to fit the
  // circles, which drew a much looser front row than a stack really is.
  const STACK_GAP = 7; // sideways step between neighbours: "slightly right"
  const STACK_Y = 24; // the shallowest of the column, off the net
  const STACK_DY = 16; // depth between stacked players, enough to clear the circles
  const STACK_MIN_X = 15;
  const STACK_MAX_X = 85;
  const STACK_DEADBAND = 5; // sideways travel below this isn't a switch at all
  const stackXs = (wants, weights) => {
    const blocks = [];
    wants.forEach((w, i) => {
      blocks.push({ sum: (w - i * STACK_GAP) * weights[i], wt: weights[i], n: 1, start: i });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1];
        const a = blocks[blocks.length - 2];
        if (a.sum / a.wt <= b.sum / b.wt) break;
        blocks.pop();
        blocks.pop();
        blocks.push({ sum: a.sum + b.sum, wt: a.wt + b.wt, n: a.n + b.n, start: a.start });
      }
    });
    const flat = [];
    blocks.forEach((b) => {
      for (let k = 0; k < b.n; k += 1) flat[b.start + k] = b.sum / b.wt;
    });
    const xs = flat.map((v, i) => v + i * STACK_GAP);
    // Slide the whole stack back inside the court if the fit pushed it out.
    let shift = 0;
    if (xs[0] < STACK_MIN_X) shift = STACK_MIN_X - xs[0];
    if (xs[xs.length - 1] + shift > STACK_MAX_X) shift = STACK_MAX_X - xs[xs.length - 1];
    return xs.map((v) => v + shift);
  };

  // Front-row slots in rotational left-to-right order, keeping only the
  // ones that are both occupied and actually switching somewhere.
  const stackSlots = ["P4", "P3", "P2"].filter(
    (pos) => layout.playerAt[pos] && layout.frontSwitch?.[pos]
  );
  const stackStart = {};
  if (stackSlots.length) {
    const xs = stackXs(
      stackSlots.map((pos) => BASE_COORD[layout.frontSwitch[pos]].x),
      stackSlots.map((pos) => (pos === layout.activeSetterPos ? 2 : 1))
    );
    // Depth: whoever has the farthest to go starts deepest, so she runs
    // behind the others rather than through them, and whoever is
    // basically staying put stands where she'll play — at the net. Two
    // players crossing get the leftward one behind, which is the tiebreak
    // the small bonus buys.
    // Only players who are really going somewhere take up a depth. A
    // front-row player already standing where she plays is drawn at the
    // net, not in the column, so counting her here just pushed everyone
    // else a row deeper than they needed to be.
    const rank = stackSlots
      .map((pos, i) => {
        const dx = BASE_COORD[layout.frontSwitch[pos]].x - xs[i];
        return { i, dx, score: Math.abs(dx) + (dx < 0 ? 2 : 0) };
      })
      .filter((r) => Math.abs(r.dx) >= STACK_DEADBAND)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.i);
    stackSlots.forEach((pos, i) => {
      const depth = rank.indexOf(i);
      stackStart[pos] = {
        x: xs[i],
        y: STACK_Y + (depth < 0 ? 0 : rank.length - 1 - depth) * STACK_DY,
      };
    });
  }

  // One track per switching player, so three arrows crossing the front row
  // can be told apart. Keyed by ROLE rather than by slot, so a coach can
  // learn it: the setter's track is always the setter's colour.
  //
  // Returns a KEY, not a colour. The screen resolves it through `COLORS` and
  // the printed sheet through its own black-on-white palette — `PrintArea`
  // deliberately uses no theme token anywhere, or a sheet printed in dark
  // mode would come out in dark-mode hues on white paper. Same lesson as
  // `STAT_BUTTONS` storing a `colorKey`; see CLAUDE.md.
  const moverRole = (m) => {
    if (m.isSetter) return "S";
    if (m.player?.position === "MB") return "MB";
    if (m.player?.position === "OH") return "OH";
    return "other";
  };

  // Each marker is drawn where that player stands AT THE SERVE — which
  // for a passer is already her spot in the receive pattern, and for a
  // switching front-row player is her place in the stack. `moveTo` is
  // where she goes once the ball is away, and is what the arrows show.
  // Passers deliberately get no arrow: the receive line IS their
  // alignment, not somewhere they travel to afterwards.
  const markers = positions.map((pos) => {
    const isLiberoSlot = pos === layout.backMBPos;
    const player = isLiberoSlot && layout.liberoPlayer ? layout.liberoPlayer : layout.playerAt[pos];
    const isPasser = layout.passerPositions.includes(pos);
    const isSetter = pos === layout.activeSetterPos;
    const isBackAttack = layout.backRowAttackPositions.includes(pos);
    const switchTarget = !isPasser ? layout.frontSwitch?.[pos] : null;
    let coord = BASE_COORD[pos];
    let moveTo = null;
    if (isPasser) {
      const idx = passersSorted.indexOf(pos);
      coord = { x: RECEIVE_X[idx], y: RECEIVE_Y };
    } else if (switchTarget) {
      coord = stackStart[pos] || BASE_COORD[pos];
      moveTo = BASE_COORD[switchTarget];
    } else if (isSetter) {
      moveTo = NET_TARGET;
    }
    // A player already standing where she's going doesn't need an arrow
    // pointing at her own feet. For a stacked switcher that's measured
    // SIDEWAYS only, because every one of them shares the same step up to
    // the net, so it's the across-court travel that says whether she is
    // really switching or already home; she still takes part in the stack
    // ordering above, or a neighbour could be placed straight through
    // her. Anyone else is measured as a real distance — the 5-1 setter
    // releases from the back row almost straight up the court, and an
    // x-only test cancelled that move entirely.
    const travel = switchTarget
      ? Math.abs(moveTo ? moveTo.x - coord.x : 0)
      : moveTo
        ? Math.hypot(moveTo.x - coord.x, moveTo.y - coord.y)
        : 0;
    if (moveTo && player && travel < STACK_DEADBAND) {
      coord = moveTo;
      moveTo = null;
    }
    if (!player) moveTo = null;
    const m = { pos, player, isLiberoSlot, isPasser, isSetter, isBackAttack, coord, moveTo, isSwitch: !!switchTarget };
    m.colorKey = moveTo ? moverRole(m) : null;
    return m;
  });

  // Arrow geometry. The court box is taller than it is wide, so a y
  // percent covers more pixels than an x percent — the arrowheads are
  // built in that squared-up space and converted back, or they come out
  // skewed. Both ends are trimmed so the shaft starts clear of the
  // marker it leaves and stops short of the ring it points at.
  const Y_PER_X = 1 / aspect; // a y percent covers more pixels than an x percent
  const MARKER_R = 8; // a 56px circle on a ~355px-wide court, in percent
  const DEST_R = 6; // the smaller destination ring
  const HEAD_LEN = 7;
  const CLEAR_R = 10; // how far an arrow keeps off another player's circle
  const arrowGeom = (from, to, avoid = []) => {
    // Everything here is computed in "squared-up" space, where one unit
    // is the same number of pixels on both axes, then divided back out.
    const ax = from.x;
    const ay = from.y * Y_PER_X;
    const dx = to.x - ax;
    const dy = to.y * Y_PER_X - ay;
    const len = Math.hypot(dx, dy);
    if (len < 4) return null;
    const ux = dx / len;
    const uy = dy / len;
    // Both trims and the head are capped as a fraction of the trip, so a
    // short slide still draws as a visible arrow instead of being eaten
    // entirely by its own clearances.
    const startAt = Math.min(MARKER_R, len * 0.3);
    const endAt = len - Math.min(DEST_R, len * 0.18);
    // Bow around anyone standing in the way. A player crossing the whole
    // front row runs behind her team-mates, and a straight shaft drawn
    // under their circles vanishes for most of its length — the sheet had
    // exactly that, an arrow visible only as a stub either side of the
    // middle. The curve bends to whichever side of the obstruction has
    // room, by however much it takes to clear it.
    let bow = 0;
    avoid.forEach((o) => {
      const ox = o.x - ax;
      const oy = o.y * Y_PER_X - ay;
      const along = ox * ux + oy * uy;
      if (along <= startAt || along >= endAt) return;
      const side = ox * -uy + oy * ux; // signed perpendicular distance
      if (Math.abs(side) >= CLEAR_R) return;
      const push = (CLEAR_R - Math.abs(side)) * 2 * (side >= 0 ? -1 : 1);
      if (Math.abs(push) > Math.abs(bow)) bow = push;
    });
    const sq = (x, y) => ({ x, y: y / Y_PER_X });
    const p0 = sq(ax + ux * startAt, ay + uy * startAt);
    const tipS = { x: ax + ux * endAt, y: ay + uy * endAt };
    const mid = (startAt + endAt) / 2;
    const ctrlS = { x: ax + ux * mid - uy * bow, y: ay + uy * mid + ux * bow };
    // The head sits at the tip, pointed along the curve's tangent there,
    // which for a quadratic is simply the direction from the control
    // point. It overlaps the last of the shaft, same colour, so there's
    // no need to shorten the curve to meet it.
    const tx = tipS.x - ctrlS.x;
    const ty = tipS.y - ctrlS.y;
    const tl = Math.hypot(tx, ty) || 1;
    const hx = tx / tl;
    const hy = ty / tl;
    const head = Math.min(HEAD_LEN, (endAt - startAt) * 0.6);
    const bx = tipS.x - hx * head;
    const by = tipS.y - hy * head;
    const wing = head * 0.45;
    const pts = [
      sq(tipS.x, tipS.y),
      sq(bx - -hy * wing, by - hx * wing),
      sq(bx + -hy * wing, by + hx * wing),
    ];
    const ctrl = sq(ctrlS.x, ctrlS.y);
    const tip = sq(tipS.x, tipS.y);
    return {
      d: `M ${p0.x} ${p0.y} Q ${ctrl.x} ${ctrl.y} ${tip.x} ${tip.y}`,
      points: pts.map((pt) => `${pt.x},${pt.y}`).join(" "),
    };
  };

  // Precompute each arrow's path, so a renderer only has to draw. Markers are
  // what an arrow has to bow around, which is why this runs after all of them.
  const arrows = markers
    .filter((m) => m.moveTo)
    .map((m) => {
      const g = arrowGeom(
        m.coord,
        m.moveTo,
        markers.filter((o) => o !== m && o.player).map((o) => o.coord)
      );
      return g ? { pos: m.pos, colorKey: m.colorKey, ...g } : null;
    })
    .filter(Boolean);

  return { layout, markers, arrows, system };
}

// Rolls a flat list of stat entries up into one row per player, with that
// player's stat counts. Lives at module scope specifically because BOTH the
// Stats screen and PrintArea need it: it used to be a local const inside
// BoxScoreScreen while PrintArea's "Box Score — By Set" sheet also called
// it by name, which is a ReferenceError that crashed the entire app to a
// blank screen the moment any stat existed for the active match (PrintArea
// is always mounted, and its own early return only skipped the call while
// the log was empty). Keep it module-scope; don't move it back inside a
// component.
// A lineup-shaped placeholder for the one case that otherwise takes the
// whole app down: `lineups` arriving empty. Every screen resolves its
// lineup as `lineups.find(...) || lineups[0]`, which is `undefined` for an
// empty array, and the very next line reads `.setNumber` off it — a crash
// at render, caught by the ErrorBoundary, on the Live screen mid-match.
//
// `deleteLineup` refuses to remove the last lineup, so the app can't
// normally produce this. It can still arrive from outside: the Firestore
// snapshot handler merges `{ ...defaultValue, ...snap.data() }`, and a
// stored `lineups: []` overrides the default rather than falling back to
// it. Whatever the route, a coach mid-match should get a screen telling
// them to make a lineup, not a crash.
const EMPTY_LINEUP = {
  id: 0,
  name: "Set 1",
  setNumber: 1,
  currentRotation: 1,
  slots: {},
  liberos: [],
  pairings: [],
  servesFirst: "us",
};

function groupStatsByPlayer(entries, roster) {
  const byPlayer = {};
  for (const e of entries) {
    if (!byPlayer[e.playerId]) byPlayer[e.playerId] = {};
    byPlayer[e.playerId][e.stat] = (byPlayer[e.playerId][e.stat] || 0) + 1;
  }
  return Object.entries(byPlayer)
    .map(([pid, stats]) => ({ player: roster.find((p) => p.id === Number(pid)), stats }))
    .filter((r) => r.player);
}

// Each entry names its palette KEY rather than holding a color value. This
// module is evaluated once, while COLORS is still the dark palette, so a
// literal `color: COLORS.green` here froze the dark theme's green forever —
// invisible while both themes shared those hues, a real bug the moment
// light mode deepened them. Resolve through COLORS at render instead.
const STAT_BUTTONS = [
  { key: "ace", label: "Ace", group: "Serve", colorKey: "green" },
  { key: "serviceAtt", label: "Service Att.", group: "Serve", colorKey: "blue" },
  { key: "serveErr", label: "Serve Err", group: "Serve", colorKey: "red" },
  { key: "kill", label: "Kill", group: "Attack", colorKey: "green" },
  { key: "assist", label: "Assist", group: "Attack", colorKey: "green" },
  { key: "attackErr", label: "Attack Err", group: "Attack", colorKey: "red" },
  { key: "dig", label: "Dig", group: "Reception", colorKey: "green" },
  { key: "recErr", label: "Rec Err", group: "Reception", colorKey: "red" },
  { key: "passingErr", label: "Passing Err", group: "Reception", colorKey: "red" },
  { key: "blockSolo", label: "Block Solo", group: "Block", colorKey: "green" },
  { key: "blockAst", label: "Block Ast", group: "Block", colorKey: "green" },
  { key: "blockErr", label: "Block Err", group: "Block", colorKey: "red" },
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
              background: printing ? COLORS.accentSoft : "none",
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

// `allowedTabs` is undefined on a coach device (every tab) and a list on an
// assistant device, whose tabs the coach chooses — see teamAccess.js. Hiding
// a tab is presentation only; what an assistant device may WRITE is enforced
// by the guard on setMainDoc, which is the half that actually holds.
function TabBar({ tab, setTab, allowedTabs }) {
  const all = [
    { key: "roster", label: "Roster", icon: Users },
    { key: "lineup", label: "Lineup", icon: LayoutGrid },
    { key: "live", label: "Live", icon: Activity },
    { key: "box", label: "Stats", icon: ClipboardList },
    { key: "schedule", label: "Schedule", icon: Calendar },
    { key: "tourney", label: "Tourney", icon: Trophy },
  ];
  const tabs = allowedTabs ? all.filter((t) => allowedTabs.includes(t.key)) : all;
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
// The lineup a past match was actually played with, read from the snapshot
// frozen onto that match when its first stat was recorded. Read-only on
// purpose: it's a record of what happened, not a template to edit. Module
// scope so it can't reach into LineupScreen's state by accident.
function MatchLineupRecord({ match, roster, onShowTemplates }) {
  const snapshots = Object.values(match.lineupSnapshots || {}).sort(
    (a, b) => (a.setNumber || 0) - (b.setNumber || 0)
  );
  const playerFor = (id) => roster.find((p) => p.id === id);
  const setScores = match.setScores || {};
  const setScoreLine = Object.keys(setScores)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${setScores[k].us}–${setScores[k].opp}`)
    .join(" · ");
  return (
    <div style={{ padding: "16px 20px 20px", overflowY: "auto", flex: 1 }}>
      <div
        style={{
          border: `1.5px solid ${COLORS.gold}`,
          background: COLORS.goldSoft,
          borderRadius: 10,
          padding: "10px 12px",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.chalk, marginBottom: 3 }}>
          Lineup that played vs. {match.opponent}
        </div>
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
          {match.date} ·{" "}
          {match.completedAt
            ? "locked in when the match was ended"
            : "a record of this match"}
          . Not editable — your lineups are templates you keep reusing, so this
          is the only trace of who actually played.
        </div>
        {setScoreLine && (
          <div style={{ fontSize: 12, color: COLORS.chalk, fontWeight: 700, marginBottom: 8 }}>
            {setScoreLine}
          </div>
        )}
        <button
          onClick={onShowTemplates}
          style={{
            padding: "7px 12px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.line}`,
            background: "none",
            color: COLORS.chalk,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Edit current lineups instead
        </button>
      </div>

      {snapshots.length === 0 && (
        <div style={{ fontSize: 12, color: COLORS.chalkDim }}>
          No lineup was recorded for this match — no stats were entered while it
          was the active match.
        </div>
      )}

      {snapshots.map((snap) => {
        const serverSlot = snap.servesFirst === "us" ? "P1" : "P2";
        return (
          <div key={snap.setNumber} style={{ marginBottom: 22 }}>
            <div
              style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: 14,
                textTransform: "uppercase",
                color: COLORS.chalk,
                marginBottom: 8,
              }}
            >
              {snap.name || `Set ${snap.setNumber}`}
              {setScores[snap.setNumber] && (
                <span style={{ color: COLORS.chalkDim, marginLeft: 8 }}>
                  {setScores[snap.setNumber].us}–{setScores[snap.setNumber].opp}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 9,
                color: COLORS.chalkDim,
                textAlign: "center",
                letterSpacing: 1,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              — net —
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateAreas: `"p4 p3 p2" "p5 p6 p1"`,
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
                marginBottom: 10,
              }}
            >
              {COURT_LAYOUT.map(({ slot, gridArea }) => {
                const player = playerFor(snap.slots?.[slot]);
                return (
                  <div
                    key={slot}
                    style={{
                      gridArea,
                      position: "relative",
                      padding: "10px 4px",
                      borderRadius: 10,
                      border: `1.5px solid ${slot === serverSlot ? COLORS.gold : COLORS.line}`,
                      background: COLORS.bgRaised,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 8, color: COLORS.chalkDim, textAlign: "left" }}>{slot}</div>
                    <div
                      style={{
                        fontFamily: "'Oswald', sans-serif",
                        fontSize: 20,
                        fontWeight: 700,
                        color: COLORS.chalk,
                        lineHeight: 1.1,
                      }}
                    >
                      {player ? `#${player.num}` : "—"}
                    </div>
                    <div style={{ fontSize: 9, color: COLORS.chalkDim }}>
                      {player ? displayName(player) : ""}
                    </div>
                    {slot === serverSlot && (
                      <div style={{ fontSize: 8, fontWeight: 700, color: COLORS.gold, marginTop: 2 }}>
                        1ST SERVER
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(snap.liberos || []).length > 0 && (
              <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
                Libero
                {snap.liberos.length === 1 ? "" : "s"}:{" "}
                {snap.liberos
                  .map((id) => {
                    const p = playerFor(id);
                    return p ? `#${p.num} ${displayName(p)}` : "—";
                  })
                  .join(" · ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LineupScreen({ lineups, setLineups, activeLineupId, setActiveLineupId, roster, setRoster, captainIds, toggleCaptain, roleSystem, setRoleSystem, matches, activeMatchId, assistant }) {
  const [picking, setPicking] = useState(null); // { type: 'court'|'libero', slot } | null
  const [renaming, setRenaming] = useState(false);
  const [playerSheet, setPlayerSheet] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [playerForm, setPlayerForm] = useState({ num: "", liberoNum: "", firstName: "", lastName: "", position: "", position2: "" });
  const [addingPairing, setAddingPairing] = useState(false);
  const [pairingForm, setPairingForm] = useState({ frontId: "", backId: "", isLibero: false });
  const [systemSheetOpen, setSystemSheetOpen] = useState(false);
  const [serveReceiveOpen, setServeReceiveOpen] = useState(false);
  const [addingServeSub, setAddingServeSub] = useState(false);
  const [serveSubForm, setServeSubForm] = useState({ forId: "", subId: "" });
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

  // If the active match is a closed one, this tab shows the lineup that
  // actually played it rather than today's templates — which is what it used
  // to do, silently, since lineups are reused match to match and carry no
  // history of their own. Escape hatch below for editing templates anyway.
  //
  // What makes a match closed is `completedAt`, set by End Match — not its
  // date. An earlier pass used "dated before today", which got it wrong in
  // both directions: a match ended this evening isn't "before today" and
  // would still show live templates, while a match whose date has passed but
  // was never played would lock for no reason. The date test survives only
  // as a fallback for matches that have snapshots but predate End Match
  // writing completedAt.
  const [ignoreMatchRecord, setIgnoreMatchRecord] = useState(false);
  useEffect(() => {
    setIgnoreMatchRecord(false);
  }, [activeMatchId]);
  const activeMatch = (matches || []).find((m) => m.id === activeMatchId) || null;
  const hasSnapshots =
    activeMatch && activeMatch.lineupSnapshots && Object.keys(activeMatch.lineupSnapshots).length > 0;
  const matchRecord =
    activeMatch &&
    (activeMatch.completedAt ||
      (hasSnapshots && activeMatch.date && activeMatch.date < todayISO()))
      ? activeMatch
      : null;

  const activeLineup = lineups.find((l) => l.id === viewingLineupId) || lineups[0] || EMPTY_LINEUP;
  const liberos = activeLineup.liberos || [null, null];
  // Which jersey she is actually wearing in this set — see jerseyFor.
  const jersey = (p) => jerseyFor(p, liberos);
  // Two-libero teams often run one for serve-receive and a different one when
  // they're serving. The role lives per libero SLOT (L1/L2) rather than per
  // player, so swapping who fills a slot keeps the plan intact.
  const liberoRole = (idx) => (activeLineup.liberoRoles || [])[idx] || "any";
  const serveSubs = activeLineup.serveSubs || [];
  const serveSubSelectStyle = {
    width: "100%",
    padding: "9px 10px",
    marginTop: 4,
    marginBottom: 10,
    background: COLORS.bg,
    border: `1px solid ${COLORS.line}`,
    borderRadius: 8,
    color: COLORS.chalk,
    fontSize: 13,
  };
  const serveSubError = (() => {
    const { forId, subId } = serveSubForm;
    if (!forId || !subId) return null;
    if (forId === subId) return "Pick two different players.";
    if (serveSubs.some((ss) => String(ss.forId) === forId)) return "That player already has a serving specialist.";
    return null;
  })();
  const addServeSub = () => {
    if (serveSubError || !serveSubForm.forId || !serveSubForm.subId) return;
    const entry = { id: Date.now(), forId: Number(serveSubForm.forId), subId: Number(serveSubForm.subId) };
    setLineups((prev) =>
      prev.map((l) => (l.id === activeLineup.id ? { ...l, serveSubs: [...(l.serveSubs || []), entry] } : l))
    );
    setServeSubForm({ forId: "", subId: "" });
    setAddingServeSub(false);
  };
  const deleteServeSub = (id) => {
    setLineups((prev) =>
      prev.map((l) => (l.id === activeLineup.id ? { ...l, serveSubs: (l.serveSubs || []).filter((ss) => ss.id !== id) } : l))
    );
  };
  const cycleLiberoRole = (idx) => {
    const order = ["any", "receive", "serve"];
    const next = order[(order.indexOf(liberoRole(idx)) + 1) % order.length];
    setLineups((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineup.id) return l;
        const roles = [...(l.liberoRoles || ["any", "any"])];
        while (roles.length < 2) roles.push("any");
        roles[idx] = next;
        return { ...l, liberoRoles: roles };
      })
    );
  };
  // Both positions, not just the primary. A player with two is exactly the
  // one this screen needs you to recognize at a glance — a libero who also
  // plays DS, a middle who swings outside — and showing only the first hides
  // the reason she's in the slot she's in.
  const positionsOf = (p) => [p?.position, p?.position2].filter(Boolean).join(" · ");
  // The number she ISN'T wearing this set, shown small beside the one she is,
  // so a coach reading the court against the actual floor can match either
  // jersey without opening her player card.
  const altJersey = (p) => {
    if (!p?.liberoNum) return null;
    const worn = String(jersey(p));
    const other = worn === String(p.liberoNum) ? String(p.num) : String(p.liberoNum);
    return other === worn ? null : other;
  };

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
    // Commits the RAW (pre-substitution) arrangement as the new starting
    // lineup, and resets to Rotation 1 — this rotation you're previewing
    // genuinely becomes your new starting point, exactly like building a
    // fresh lineup from scratch, with pairings still computing subs
    // dynamically from here rather than one being permanently baked in.
    const newSlots = computeRawRotationSlots(activeLineup, previewRotation);
    setLineups((prev) =>
      prev.map((l) => (l.id === activeLineup.id ? { ...l, slots: newSlots, currentRotation: 1 } : l))
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
    // Deleting the lineup that's currently marked active would otherwise
    // leave activeLineupId pointing at an id that no longer exists in
    // `lineups` — every reader of it already falls back to lineups[0]
    // when that happens, so nothing visibly breaks here, but the pointer
    // itself stays wrong until the coach happens to hit Start Next Set or
    // End Match. Repointing it immediately keeps the data itself honest.
    if (activeLineupId === id) setActiveLineupId(remaining[0].id);
  };

  const renameLineup = (name) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, name } : l)));
  };

  const pairings = activeLineup.pairings || [];

  // A pairing only makes sense as a substitute relationship: exactly one of the
  // two players may be on the court right now, the other must be on the bench.
  const pairingValidationError = (frontId, backId, isLibero) => {
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
    // A player can only be tied to one substitute relationship at a time for
    // this lineup — except a libero, who real volleyball rules allow to sub
    // in for more than one back-row player over a set (commonly two middles
    // who alternate which one is back row). Only relaxed when BOTH the new
    // and the existing pairing are libero swaps for that same libero, always
    // in the back-row (libero) slot of the pairing — a regular player still
    // can't be double-booked, and a libero still can't double-book a single
    // front-row spot either.
    const existingFor = (playerId) =>
      pairings.find((p) => p.frontId === playerId || p.backId === playerId);
    const frontExisting = existingFor(frontId);
    if (frontExisting) {
      const other = playerFor(frontExisting.frontId === frontId ? frontExisting.backId : frontExisting.frontId);
      return `${displayName(playerFor(frontId))} is already paired with ${displayName(other)} for this lineup — remove that pairing first.`;
    }
    const backExisting = existingFor(backId);
    if (backExisting && !(isLibero && backExisting.isLibero && backExisting.backId === backId)) {
      const other = playerFor(backExisting.frontId === backId ? backExisting.backId : backExisting.frontId);
      return `${displayName(playerFor(backId))} is already paired with ${displayName(other)} for this lineup — remove that pairing first.`;
    }
    return null;
  };

  const addPairing = (frontId, backId, isLibero) => {
    if (pairingValidationError(frontId, backId, isLibero)) return;
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

  // Marks which ONE pairing is the libero's designated serving turn, when
  // that libero also has another pairing (e.g. subbing for a second
  // middle). Turning this on for one pairing turns it off for any other
  // pairing sharing the same libero — only one can be true at a time,
  // matching the real rule that a libero only ever serves one position.
  const toggleLiberoServes = (id) => {
    setLineups((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineup.id) return l;
        const target = (l.pairings || []).find((p) => p.id === id);
        if (!target) return l;
        const nextVal = !target.liberoServes;
        return {
          ...l,
          pairings: (l.pairings || []).map((p) => {
            if (p.id === id) return { ...p, liberoServes: nextVal };
            if (nextVal && p.backId === target.backId) return { ...p, liberoServes: false };
            return p;
          }),
        };
      })
    );
  };

  const setServesFirst = (val) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, servesFirst: val } : l)));
  };

  const playerFor = (id) => roster.find((p) => p.id === id);
  const filled = Object.values(slots).filter(Boolean).length;
  const servesFirst = activeLineup.servesFirst || "us";

  const openAddPlayer = () => {
    setPlayerForm({ num: "", liberoNum: "", firstName: "", lastName: "", position: "", position2: "" });
    setPlayerSheet({ mode: "add" });
  };

  const openEditPlayer = (p) => {
    setPlayerForm({ num: String(p.num), liberoNum: p.liberoNum ? String(p.liberoNum) : "", firstName: p.firstName || "", lastName: p.lastName || "", position: p.position || "", position2: p.position2 || "" });
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
                liberoNum: playerForm.liberoNum.trim(),
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
          liberoNum: playerForm.liberoNum.trim(),
        },
      ]);
    }
    setPlayerSheet(null);
  };

  if (matchRecord && !ignoreMatchRecord) {
    return (
      <MatchLineupRecord
        match={matchRecord}
        roster={roster}
        onShowTemplates={() => setIgnoreMatchRecord(true)}
      />
    );
  }

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
              background: l.id === viewingLineupId ? COLORS.accentSoft : "transparent",
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
          onClick={() => !assistant && addLineup(false)}
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
            onClick={() => !assistant && setRenaming(true)}
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
          onClick={() => !assistant && addLineup(true)}
          title="Duplicate lineup"
          style={{ background: "none", border: "none", color: COLORS.chalkDim, display: "flex" }}
        >
          <Copy size={15} />
        </button>
        {lineups.length > 1 && (
          <button
            onClick={() => !assistant && deleteLineup(activeLineup.id)}
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
                    background: previewRotation === r ? COLORS.accentSoft : "transparent",
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
                background: COLORS.greenSoft,
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
              onClick={() => !assistant && setServesFirst(opt.key)}
              style={{
                flex: 1,
                padding: "9px",
                borderRadius: 8,
                border: `1.5px solid ${servesFirst === opt.key ? COLORS.orange : COLORS.line}`,
                background: servesFirst === opt.key ? COLORS.accentSoft : "transparent",
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
            background: COLORS.goldSoft,
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
              onClick={() => !isPreviewing && !assistant && setPicking({ type: "court", slot })}
              style={{
                gridArea,
                aspectRatio: "1",
                background: player ? COLORS.accentSoft : COLORS.bgRaised,
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
              {player && captainIds.includes(player.id) && (
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
                    #{jersey(player)}
                    {altJersey(player) && (
                      <span style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim }}>
                        /{altJersey(player)}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 2 }}>
                    {displayName(player)}
                  </span>
                  {positionsOf(player) && (
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
                      {positionsOf(player)}
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

      {/* Libero serving cue — see the matching one on the Live screen for
          the full rationale. Reflects whichever rotation is currently
          being previewed here, since `slots` already accounts for that. */}
      {(() => {
        const activePairing = findActiveLiberoPairing(slots, pairings);
        if (!activePairing) return null;
        const liberoPlayer = playerFor(activePairing.backId);
        const frontPlayer = playerFor(activePairing.frontId);
        return (
          <div
            style={{
              marginBottom: 16,
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 600,
              background: activePairing.liberoServes ? COLORS.greenSoft : COLORS.goldSoft,
              border: `1px solid ${activePairing.liberoServes ? COLORS.green : COLORS.gold}`,
              color: activePairing.liberoServes ? COLORS.green : COLORS.gold,
            }}
          >
            {activePairing.liberoServes
              ? `Libero (#${jersey(liberoPlayer)} ${displayName(liberoPlayer)}) serves this rotation.`
              : `Libero is on court here but not cleared to serve — sub #${jersey(frontPlayer)} ${displayName(frontPlayer)} in to serve.`}
          </div>
        );
      })()}

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
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
        {[0, 1].map((idx) => {
          const pid = liberos[idx];
          const player = pid ? playerFor(pid) : null;
          return (
            <button
              key={idx}
              onClick={() => !assistant && setPicking({ type: "libero", slot: idx })}
              style={{
                flex: 1,
                minHeight: 46,
                background: player ? COLORS.blueSoft : COLORS.bgRaised,
                border: `2px solid ${player ? COLORS.blue : COLORS.line}`,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
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
              {player && (
                <span
                  role="button"
                  title="When this libero plays"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!assistant) cycleLiberoRole(idx);
                  }}
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: liberoRole(idx) === "any" ? COLORS.chalkDim : COLORS.orange,
                    border: `1px solid ${liberoRole(idx) === "any" ? COLORS.line : COLORS.orange}`,
                    background: liberoRole(idx) === "any" ? "transparent" : COLORS.accentSoft,
                    borderRadius: 4,
                    padding: "1px 5px",
                    flexShrink: 0,
                  }}
                >
                  {LIBERO_ROLE_LABEL[liberoRole(idx)]}
                </span>
              )}
              {player ? (
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 600 }}>
                    #{jersey(player)}
                    {altJersey(player) && (
                      <span style={{ fontSize: 10, fontWeight: 400, color: COLORS.chalkDim }}>
                        /{altJersey(player)}
                      </span>
                    )}
                  </span>{" "}
                  <span style={{ color: COLORS.chalkDim, whiteSpace: "nowrap" }}>{displayName(player)}</span>
                  {positionsOf(player) && (
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
                      {positionsOf(player)}
                    </span>
                  )}
                  {captainIds.includes(player.id) && (
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
          onClick={() => !assistant && setAddingPairing(true)}
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
            // Only worth asking "which one serves" once this libero has more
            // than one pairing (e.g. subs for two different middles) — with
            // just one, it's trivially the only serving turn they have.
            const siblingLiberoPairings = pr.isLibero
              ? pairings.filter((p) => p.isLibero && p.backId === pr.backId)
              : [];
            const showsServesToggle = siblingLiberoPairings.length > 1;
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
                  {showsServesToggle && (
                    <button
                      onClick={() => !assistant && toggleLiberoServes(pr.id)}
                      title="A libero can sub in for more than one player, but real volleyball rules only let them serve in one of those rotational turns — mark which pairing that is."
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: pr.liberoServes ? COLORS.gold : COLORS.chalkDim,
                        border: `1px solid ${pr.liberoServes ? COLORS.gold : COLORS.line}`,
                        borderRadius: 4,
                        padding: "1px 4px",
                        flexShrink: 0,
                        background: "none",
                      }}
                    >
                      {pr.liberoServes ? "SERVES HERE" : "DOESN'T SERVE"}
                    </button>
                  )}
                  <span style={{ color: COLORS.chalk }}>
                    Front: <b>#{jersey(front)}{altJersey(front) ? `/${altJersey(front)}` : ""} {displayName(front)}</b>
                  </span>
                  <span style={{ color: COLORS.chalkDim }}>↔</span>
                  <span style={{ color: COLORS.chalk }}>
                    Back: <b>#{jersey(back)}{altJersey(back) ? `/${altJersey(back)}` : ""} {displayName(back)}</b>
                  </span>
                  <button
                    onClick={() => !assistant && deletePairing(pr.id)}
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
                      onClick={() => !assistant && togglePairingLibero(pr.id)}
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

      {/* Serving specialists — a player brought on purely to serve a run and
          taken straight back off at sideout. Kept as its own list rather than
          folded into `pairings`, which is about front-row/back-row rotation
          and is the most bug-prone code in this file; a serve sub has nothing
          to do with which row anyone is in. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: COLORS.chalkDim, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Serving Specialists
        </div>
        {!assistant && (
          <button
            onClick={() => setAddingServeSub((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: `1px solid ${COLORS.orange}`,
              borderRadius: 6,
              padding: "4px 8px",
              color: COLORS.orange,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <Plus size={12} /> Add
          </button>
        )}
      </div>
      {addingServeSub && !assistant && (
        <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8, lineHeight: 1.45 }}>
            When the first player rotates to serve and you win the serve, the app
            offers to bring the specialist on; it offers to put them back the
            moment you lose it. Each turn costs two of your {SUB_LIMIT} subs.
          </div>
          <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>Serves instead of</label>
          <select value={serveSubForm.forId} onChange={(e) => setServeSubForm((f) => ({ ...f, forId: e.target.value }))} style={serveSubSelectStyle}>
            <option value="">Select player…</option>
            {roster.map((p) => (
              <option key={p.id} value={p.id}>#{jersey(p)} {displayName(p)}</option>
            ))}
          </select>
          <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>Specialist coming in</label>
          <select value={serveSubForm.subId} onChange={(e) => setServeSubForm((f) => ({ ...f, subId: e.target.value }))} style={serveSubSelectStyle}>
            <option value="">Select player…</option>
            {roster.map((p) => (
              <option key={p.id} value={p.id}>#{jersey(p)} {displayName(p)}</option>
            ))}
          </select>
          {serveSubError && <div style={{ fontSize: 11, color: COLORS.red, marginBottom: 8 }}>{serveSubError}</div>}
          <button
            onClick={addServeSub}
            disabled={!serveSubForm.forId || !serveSubForm.subId || !!serveSubError}
            style={{
              width: "100%",
              padding: "9px",
              borderRadius: 8,
              border: "none",
              background: !serveSubForm.forId || !serveSubForm.subId || serveSubError ? COLORS.line : COLORS.orange,
              color: "#1C2128",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Save Serving Specialist
          </button>
        </div>
      )}
      {serveSubs.length === 0 ? (
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 16 }}>
          None set. Without one the app never prompts a serve sub — you can still
          make one by hand from the Live screen.
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          {serveSubs.map((ss) => {
            const forP = playerFor(ss.forId);
            const subP = playerFor(ss.subId);
            return (
              <div
                key={ss.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  background: COLORS.bgRaised,
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 6,
                }}
              >
                <span style={{ color: COLORS.chalk }}>
                  <b>#{jersey(subP)} {displayName(subP)}</b> serves for{" "}
                  <b>#{jersey(forP)} {displayName(forP)}</b>
                </span>
                <button
                  onClick={() => !assistant && deleteServeSub(ss.id)}
                  style={{ marginLeft: "auto", background: "none", border: "none", color: COLORS.chalkDim }}
                >
                  <Trash2 size={13} />
                </button>
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
        {!assistant && (
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
        )}
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
                border: `1px solid ${captainIds.includes(p.id) ? COLORS.gold : COLORS.line}`,
                borderRadius: 8,
                padding: "4px 4px 4px 10px",
                fontSize: 12,
                color: COLORS.chalkDim,
              }}
            >
              <button
                onClick={() => !assistant && toggleCaptain(p.id)}
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
                #{jersey(p)} {displayName(p)}
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
                {captainIds.includes(p.id) && (
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
                onClick={() => !assistant && openEditPlayer(p)}
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
                  onClick={() => !assistant && setRoleSystem((prev) => ({ ...(prev || {}), system: s.key }))}
                  style={{
                    flex: 1,
                    padding: "9px 0",
                    borderRadius: 8,
                    border: `1.5px solid ${roleSystem?.system === s.key ? COLORS.orange : COLORS.line}`,
                    background: roleSystem?.system === s.key ? COLORS.accentSoft : "transparent",
                    color: COLORS.chalk,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {roleSystem?.system === "4-2" && (
              <div style={{ marginTop: 12, marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", marginBottom: 6 }}>
                  Setter sets from
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    { key: "right", label: "Right front", hint: "Advanced / international 4-2" },
                    { key: "middle", label: "Middle front", hint: "Classic beginner 4-2" },
                  ].map((o) => {
                    const on = (roleSystem?.setterFront === "middle" ? "middle" : "right") === o.key;
                    return (
                      <button
                        key={o.key}
                        onClick={() => !assistant && setRoleSystem((prev) => ({ ...(prev || {}), setterFront: o.key }))}
                        style={{
                          flex: 1,
                          padding: "9px 6px",
                          borderRadius: 8,
                          border: `1.5px solid ${on ? COLORS.orange : COLORS.line}`,
                          background: on ? COLORS.accentSoft : "transparent",
                          color: COLORS.chalk,
                          textAlign: "center",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{o.label}</div>
                        <div style={{ fontSize: 9, color: COLORS.chalkDim, marginTop: 2 }}>{o.hint}</div>
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 6, lineHeight: 1.4 }}>
                  Changes the Serve-Receive diagram: where the setter ends up, and
                  which pin each hitter switches to.
                </div>
              </div>
            )}

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
        const setterFront = roleSystem?.setterFront === "middle" ? "middle" : "right";
        const layout = deriveServeReceive(system, shiftedSlots, roster, liberos, isAlternate, setterFront);

        const geo = serveReceiveGeometry(system, shiftedSlots, roster, liberos, isAlternate, setterFront);
        const { markers, arrows } = geo;
        const stackSlots = ["P4", "P3", "P2"].filter(
          (pos) => geo.layout.playerAt[pos] && geo.layout.frontSwitch?.[pos]
        );
        // Resolve the geometry's role keys through the live palette. Done here
        // rather than inside the geometry so the printed sheet can resolve the
        // same keys through its own black-on-white set instead.
        const trackColor = (key) =>
          key === "S" ? COLORS.gold : key === "MB" ? COLORS.green : key === "OH" ? COLORS.purple : COLORS.red;

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
                  Setter
                </span>
                {markers.some((m) => m.moveTo && m.player?.position === "MB") ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.green, display: "inline-block" }} />
                    Middle
                  </span>
                ) : null}
                {markers.some((m) => m.moveTo && m.player?.position === "OH") ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.purple, display: "inline-block" }} />
                    Outside
                  </span>
                ) : null}
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

                {/* Where each switching player ends up: a hollow ring with her
                    number, so the destination is readable without a second
                    diagram. Drawn under the arrows and the live markers. */}
                {markers
                  .filter((m) => m.moveTo)
                  // A destination that somebody else is still standing on gets
                  // no ring — the arrow already points at them, and that's the
                  // true picture: she takes the spot over as they leave it.
                  .filter((m) =>
                    !markers.some(
                      (o) => o !== m && o.player && Math.hypot(o.coord.x - m.moveTo.x, o.coord.y - m.moveTo.y) < 9
                    )
                  )
                  .map((m) => (
                    <div
                      key={`dest-${m.pos}`}
                      style={{
                        position: "absolute",
                        left: `${m.moveTo.x}%`,
                        top: `${m.moveTo.y}%`,
                        transform: "translate(-50%, -50%)",
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        border: `2px dashed ${trackColor(m.colorKey)}`,
                        opacity: 0.7,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: "'Oswald', sans-serif",
                        fontSize: 13,
                        color: trackColor(m.colorKey),
                      }}
                    >
                      #{jersey(m.player)}
                    </div>
                  ))}

                {/* Movement arrows — solid and heavy, with a real arrowhead, so
                    which way somebody is going reads at a glance from a phone
                    held courtside. Two players swapping spots don't collide
                    into one line the way they would along a single row: they
                    leave from different places in the stack and arrive at
                    different spots on the net, so the paths cross at an angle. */}
                {arrows.map((g) => (
                  <svg
                    key={`arrow-${g.pos}`}
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
                  >
                    <path
                      d={g.d}
                      fill="none"
                      stroke={trackColor(g.colorKey)}
                      strokeWidth="4"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    <polygon points={g.points} fill={trackColor(g.colorKey)} />
                  </svg>
                ))}

                {markers.map((m) => {
                  // A mover's circle, her arrow and her destination ring all
                  // carry the same colour — that's what lets three paths
                  // crossing the front row be told apart at a glance.
                  const borderColor = m.colorKey ? trackColor(m.colorKey) : m.isSetter ? COLORS.gold : m.isPasser ? COLORS.blue : COLORS.line;
                  const bg = m.isSetter ? COLORS.goldSoft : m.isPasser ? COLORS.blueSoft : COLORS.bgRaised;
                  return (
                    <div
                      key={m.pos}
                      style={{
                        position: "absolute",
                        left: `${m.coord.x}%`,
                        top: `${m.coord.y}%`,
                        transform: "translate(-50%, -50%)",
                        width: 56,
                        height: 56,
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
                            #{jersey(m.player)}
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
                Circles are where everyone stands at the moment of the serve.
                Arrows show who moves once the ball is away, and the dashed ring
                is where they finish.{" "}
                {system === "4-2" ? (
                  <>
                    {stackSlots.length > 1 ? (
                      <>
                        The front row stacks. Each one only has to stay a step to
                        the right of the player on her left — depth doesn't
                        matter — so they wait almost on top of each other and
                        release on contact:{" "}
                      </>
                    ) : (
                      <>Then: </>
                    )}
                    {setterFront === "middle"
                      ? "setter to the middle, outside to left front, the other hitter to right front."
                      : "setter to right front, middle to the middle, outside to left front."}{" "}
                    The setter is front row here and doesn't pass, so all three
                    back-row players receive.
                  </>
                ) : (
                  <>
                    The setter releases to the net near position 2 after passing.{" "}
                    {isAlternate
                      ? "Alternate pattern: the front-row Outside stays at the net, and the Opposite drops back to pass instead."
                      : "The back-row Outside can hit a pipe."}
                    {system === "5-1" && !isAlternate ? " If the Opposite is back row, that's a \"D\" ball." : ""}
                  </>
                )}
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
                  #{jersey(p)}{altJersey(p) ? `/${altJersey(p)}` : ""} {displayName(p)}{positionsOf(p) ? ` (${positionsOf(p)})` : ""}{liberos.includes(p.id) ? " · Libero" : ""} — {assignedIds.has(p.id) ? "On Court" : "Bench"}
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
                  #{jersey(p)}{altJersey(p) ? `/${altJersey(p)}` : ""} {displayName(p)}{positionsOf(p) ? ` (${positionsOf(p)})` : ""}{liberos.includes(p.id) ? " · Libero" : ""} — {assignedIds.has(p.id) ? "On Court" : "Bench"}
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
              const err = pairingValidationError(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero);
              return err ? (
                <div style={{ fontSize: 11, color: COLORS.red, marginBottom: 10, marginTop: -4 }}>
                  {err}
                </div>
              ) : null;
            })()}

            <button
              onClick={() => {
                if (pairingValidationError(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero)) return;
                addPairing(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero);
                setPairingForm({ frontId: "", backId: "", isLibero: false });
                setAddingPairing(false);
              }}
              disabled={!!pairingValidationError(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero) || !pairingForm.frontId || !pairingForm.backId}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background:
                  pairingForm.frontId && pairingForm.backId && !pairingValidationError(pairingForm.frontId, pairingForm.backId, pairingForm.isLibero)
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
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Libero Jersey # (optional)
            </label>
            <input
              placeholder="e.g. 32"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={playerForm.liberoNum}
              onChange={(e) => setPlayerForm((s) => ({ ...s, liberoNum: e.target.value.replace(/[^0-9]/g, "") }))}
              style={{
                width: 80,
                padding: "9px 10px",
                marginTop: 4,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            />
            <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "6px 0 14px" }}>
              Only if she wears a different jersey as libero. She stays one player —
              in a set where she's in the LIBEROS row she shows as this number, otherwise
              as #{playerForm.num || "—"}. Don't add her to the roster twice.
            </div>
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
                const isCaptain = captainIds.includes(p.id);
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
                        width: 48,
                      }}
                    >
                      #{jersey(p)}
                      {altJersey(p) && (
                        <span style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim }}>
                          /{altJersey(p)}
                        </span>
                      )}
                    </span>
                    <span style={{ flex: 1 }}>
                      {displayName(p)}
                      {positionsOf(p) && (
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
                          {positionsOf(p)}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCaptain(p.id);
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
// How many captains each player may vote for on one ballot.
const VOTES_PER_BALLOT = 2;
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
  subEntries,
  setSubEntries,
  injuredPlayerIds,
  setInjuredPlayerIds,
  activeMatchId,
  pointLog,
  setPointLog,
  onStartNextSet,
  onSnapshotLineup,
  setTab,
  trackStatKeys,
  assistant,
  assistantCanScore,
  usLabel,
  oppLabel,
}) {
  const [selectedSlot, setSelectedSlot] = useState("P1");
  const [subSheet, setSubSheet] = useState(null); // { slot, playerId } | null — free substitution sheet
  const [subReplacementId, setSubReplacementId] = useState("");
  const [markInjured, setMarkInjured] = useState(false);
  const [savePairing, setSavePairing] = useState(false);
  // Why a "start next set" attempt didn't go through, shown in-app. Never an
  // alert() — see startNextSet's comment and CLAUDE.md on why a native
  // dialog inside an installed iOS PWA can look exactly like a frozen app.
  const [setBlockedMsg, setSetBlockedMsg] = useState("");
  const [subSuggestions, setSubSuggestions] = useState([]);
  // Waving off a possession prompt lasts one rally: cleared whenever the
  // point count moves, which is the same thing that makes the prompt
  // re-evaluate in the first place.
  const [dismissedPrompts, setDismissedPrompts] = useState([]);
  const [matchHistory, setMatchHistory] = useState([]); // stack of {slots, subCount, liberoSubCount, pairings, injuredPlayerIds, label} — undo for rotation/subs
  // Simple mode: tap any roster number, tap a stat, done — no rotation, no
  // subs, no court. Running the full Live screen solo during a match turned
  // out to be too much to manage, so this is the stripped-down path for
  // when you just need the stats recorded. A per-device display preference
  // (like the theme), not team data — two people could be on the same team
  // code with one in each mode.
  const [simpleMode, setSimpleMode] = usePersisted("vb-live-simple", false);
  const [simplePlayerId, setSimplePlayerId] = useState(null);
  const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0] || EMPTY_LINEUP;
  const setNumber = activeLineup.setNumber || 1;
  const slots = activeLineup.slots;
  const pairings = activeLineup.pairings || [];
  // Which jersey each player is actually wearing this set — a libero who
  // also plays DS has a different number in each role. See jerseyFor.
  const liberoIdsForJersey = (activeLineup.liberos || []).filter(Boolean);
  const jersey = (p) => jerseyFor(p, liberoIdsForJersey);
  const playerFor = (id) => roster.find((p) => p.id === id);
  // The one thing the two modes disagree on: who a stat gets recorded
  // against. Everything downstream (the stat buttons, the "Recording for"
  // banner, the undo tray) reads this and doesn't care which mode set it.
  const currentPlayerId = simpleMode ? simplePlayerId : slots[selectedSlot];
  const currentPlayer = currentPlayerId ? playerFor(currentPlayerId) : null;
  // Which stat buttons to show, from Settings > Stats > Track. Kept
  // separate from the print list: what you record live and what you put on
  // a printed sheet are different decisions. An empty list falls back to
  // all of them rather than leaving a Live screen with nothing to tap —
  // unchecking everything shouldn't strand you mid-match unable to record.
  const visibleStatButtons = useMemo(() => {
    const keys = trackStatKeys || [];
    if (keys.length === 0) return STAT_BUTTONS;
    return STAT_BUTTONS.filter((s) => keys.includes(s.key));
  }, [trackStatKeys]);

  const simpleRoster = useMemo(() => {
    const numOf = (p) => {
      const n = Number(p.num);
      return Number.isFinite(n) ? n : Infinity;
    };
    return [...roster].sort((a, b) => numOf(a) - numOf(b));
  }, [roster]);

  const recordStat = (statKey) => {
    if (!currentPlayerId) return;
    // Freezes this set's starting lineup onto the match the first time a
    // stat lands. A no-op on every later stat in the same set.
    onSnapshotLineup?.(activeMatchId ?? null, setNumber, activeLineup);
    setLog((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        playerId: currentPlayerId,
        // No court position in simple mode — the player may not even be on
        // court. Nothing in the app reads this field back (it's written for
        // possible future use only), so leaving it null is safe: box score,
        // season stats and Player Eval all key off playerId/matchId/setNumber.
        slot: simpleMode ? null : selectedSlot,
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

  // Accepts either a plain slots object or an updater function. The updater
  // form matters: it derives from the lineup's CURRENT slots rather than
  // whatever `slots` happened to be when this render closed over it. A
  // rotation can produce two suggested subs at once (the libero
  // criss-cross — one middle rotating to the front as the other rotates to
  // the back), and tapping both quickly used to apply only the second: each
  // call rebuilt the whole slots object from the same stale snapshot, so
  // the first swap was silently overwritten. Both suggestions still
  // disappeared from the list, so nothing indicated a sub hadn't happened —
  // the app's idea of who was on court then disagreed with the actual court
  // for the rest of the set.
  const setActiveSlots = (updater) => {
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id
          ? { ...l, slots: typeof updater === "function" ? updater(l.slots) : updater }
          : l
      )
    );
  };

  // Tracks which of the 6 rotations this lineup is currently sitting in, so
  // the Serve-Receive reference on the Lineup screen can automatically
  // highlight the right one instead of needing to be set by hand.
  const setActiveRotation = (n) => {
    setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, currentRotation: n } : l)));
  };

  // Serving or receiving, derived from the score with a one-rally manual
  // correction. Everything possession-driven below — the two-libero swap and
  // the serving specialist — reads this and nothing else.
  const possession = servingState(pointLog, activeMatchId, setNumber, activeLineup);
  // Possession-driven prompts: the two-libero swap and the serving
  // specialist. Deliberately DERIVED every render rather than stored the way
  // `subSuggestions` is — a rotation happens once and is captured, but
  // possession flips every rally, and a stored list would go stale the moment
  // the score moved. Dismissals are keyed and cleared when the point count
  // changes, so waving one off lasts exactly one rally.
  const possessionPrompts = (() => {
    const out = [];
    const onCourt = new Set(Object.values(slots).filter(Boolean));
    const roles = activeLineup.liberoRoles || [];
    const liberoSlots = activeLineup.liberos || [];
    const wantedRole = possession.serving ? "serve" : "receive";
    const wantedIdx = [0, 1].find((i) => liberoSlots[i] && roles[i] === wantedRole);
    if (wantedIdx !== undefined) {
      const wantedId = liberoSlots[wantedIdx];
      const otherId = liberoSlots[wantedIdx === 0 ? 1 : 0];
      const otherSlot = otherId ? Object.keys(slots).find((k) => slots[k] === otherId) : null;
      if (!onCourt.has(wantedId) && otherSlot) {
        out.push({
          key: `libero-${wantedId}-${otherId}`,
          kind: "libero",
          slot: otherSlot,
          outId: otherId,
          inId: wantedId,
          note: possession.serving ? "We're serving" : "We're receiving",
        });
      }
    }
    (activeLineup.serveSubs || []).forEach((ss) => {
      if (possession.serving && slots.P1 === ss.forId && !onCourt.has(ss.subId)) {
        out.push({ key: `serve-in-${ss.id}`, kind: "serveIn", slot: "P1", outId: ss.forId, inId: ss.subId, note: "Our serve" });
      } else if (!possession.serving && slots.P1 === ss.subId && !onCourt.has(ss.forId)) {
        out.push({ key: `serve-out-${ss.id}`, kind: "serveOut", slot: "P1", outId: ss.subId, inId: ss.forId, note: "Serve lost" });
      }
    });
    // Dismissals are stamped with the point count they were made at, so they
    // expire on their own the moment the next rally lands. No reset effect,
    // and nothing to leave behind if the coach never dismisses anything.
    return out.filter((pr) => !dismissedPrompts.includes(`${possession.pointCount}:${pr.key}`));
  })();

  const confirmPossessionPrompt = (pr) => {
    const out = playerFor(pr.outId);
    const inP = playerFor(pr.inId);
    pushHistory(`${pr.kind === "libero" ? "Libero swap" : "Serve sub"}: ${displayName(inP)} in for ${displayName(out)}`);
    setActiveSlots((cur) => ({ ...cur, [pr.slot]: pr.inId }));
    if (pr.kind === "libero") {
      setLiberoSubCount((c) => c + 1);
    } else {
      setSubCount((c) => c + 1);
      recordSubEntry(pr.inId, pr.outId, pr.slot);
    }
  };

  const setServingOverride = (serving) => {
    setLineups((prev) =>
      prev.map((l) =>
        l.id === activeLineup.id
          ? { ...l, servingOverride: { setNumber, at: possession.pointCount, serving } }
          : l
      )
    );
  };

  // Snapshot current match state before a rotation/sub/substitution action,
  // so it can be stepped back afterward — not just a single "undo last," but
  // The player someone is tied to for the rest of the set, either direction:
  // whoever they went in for, or whoever went in for them. NFHS re-entry has
  // to be back into the same spot in the serving order, so both halves of a
  // swap are bound to each other from the moment it happens — #37 going out
  // for #20 means #37 can only come back in for #20, and vice versa. The
  // FIRST entry is the binding one; later ones are the same two players
  // trading places again. Liberos are never recorded here (a libero
  // replacement isn't a substitution and carries no such rule).
  const boundCounterpart = (playerId) => {
    const first = subEntries.find(
      (e) => e.playerId === playerId || e.forPlayerId === playerId
    );
    if (!first) return null;
    return first.playerId === playerId ? first.forPlayerId : first.playerId;
  };
  const recordSubEntry = (playerId, forPlayerId, slot) =>
    setSubEntries((prev) => [...(prev || []), { playerId, forPlayerId, slot, at: Date.now() }]);

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
          subEntries,
          currentRotation: activeLineup.currentRotation || 1,
          pairings: activeLineup.pairings || [],
          injuredPlayerIds,
          label,
        },
      ].slice(-10)
    );
  };

  // Every restore below used to live INSIDE the setMatchHistory updater.
  // React runs an updater during the render phase and requires it to be
  // pure, so each of those calls was a setState fired mid-render — React
  // warns "Cannot update a component (AppInner) while rendering a different
  // component (LiveScreen)" — and an updater React chooses to re-run would
  // fire every one of them again. Reading the last entry from the current
  // state and popping it separately keeps the updater pure. One tap per
  // gesture, so the render-captured value is the right one to read.
  const undoMatchAction = () => {
    const last = matchHistory[matchHistory.length - 1];
    if (!last) return;
    setMatchHistory((prev) => prev.slice(0, -1));
    setActiveSlots(last.slots);
    setSubCount(last.subCount);
    setLiberoSubCount(last.liberoSubCount);
    setSubEntries(last.subEntries || []);
    setActiveRotation(last.currentRotation || 1);
    if (last.pairings) {
      setLineups((prev) => prev.map((l) => (l.id === activeLineup.id ? { ...l, pairings: last.pairings } : l)));
    }
    if (last.injuredPlayerIds) setInjuredPlayerIds(last.injuredPlayerIds);
    setSubSuggestions([]); // pending suggestions were computed against state that no longer applies
  };

  // Free substitution — any bench player in for any on-court player, for any
  // reason (injury, a short serve-specialist swap, anything else), unlike
  // the pairing-suggested subs which only fire when a specific rotation is
  // reached. It DOES count against the sub limit, unless "mark injured" is
  // checked (an injury sub isn't charged) or a libero is involved (that's a
  // libero replacement, counted separately and not limited). This used to
  // count against nothing at all, which meant a coach running the match off
  // this sheet instead of pairings watched "Subs: 0/18" all night while
  // actually burning real substitutions. The replacement
  // fully takes over the outgoing player's role in any pairing they were
  // part of (either side — starter or sub), so future rotations keep working
  // correctly without needing the pairing rebuilt by hand. Subbing a player
  // back in this same way automatically clears their injured tag, since
  // that's literally the "they've recovered" action.
  //
  // Liberos are a special case in three ways, because a coach running a match
  // without any pairings configured has this sheet as their ONLY route to
  // getting the libero on court:
  //   1. They're only offered for back-row slots (see the bench filter in the
  //      sheet) — a libero in the front row is illegal.
  //   2. The swap counts as a libero replacement, not a substitution, which is
  //      what it actually is by rule.
  //   3. Bringing a libero on this way records the pairing it implies, so the
  //      rotation logic will prompt to swap them back out before they reach
  //      the front row. Taking a libero off does NOT rewrite pairings the way
  //      a regular sub does — mapping the libero's id onto a regular player
  //      would leave a pairing flagged isLibero with nobody's libero in it.
  const confirmFreeSubstitution = () => {
    if (!subSheet || !subReplacementId) return;
    const outgoingId = subSheet.playerId;
    const incomingId = subReplacementId;
    const liberoIds = (activeLineup.liberos || []).filter(Boolean);
    const incomingIsLibero = liberoIds.includes(incomingId);
    const outgoingIsLibero = liberoIds.includes(outgoingId);
    pushHistory(`Sub: #${jersey(playerFor(outgoingId))} out, #${jersey(playerFor(incomingId))} in`);
    setActiveSlots((cur) => ({ ...cur, [subSheet.slot]: incomingId }));
    setLineups((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineup.id) return l;
        const existing = l.pairings || [];
        if (outgoingIsLibero) return l; // see note 3 above — leave the libero's pairings intact
        if (incomingIsLibero) {
          const already = existing.some(
            (pr) => pr.backId === incomingId && pr.frontId === outgoingId
          );
          if (already) return l;
          return {
            ...l,
            pairings: [...existing, { frontId: outgoingId, backId: incomingId, isLibero: true }],
          };
        }
        const rewritten = existing.map((pr) => ({
          ...pr,
          frontId: pr.frontId === outgoingId ? incomingId : pr.frontId,
          backId: pr.backId === outgoingId ? incomingId : pr.backId,
        }));
        const alreadyPaired = existing.some(
          (pr) =>
            pr.frontId === outgoingId ||
            pr.backId === outgoingId ||
            pr.frontId === incomingId ||
            pr.backId === incomingId
        );
        if (!savePairing || alreadyPaired) return { ...l, pairings: rewritten };
        // "Make this a pair" — turn the sub just made into a standing pairing
        // so later rotations suggest it on their own. Which side is which
        // comes from the slot: subbing into a back-row slot means the player
        // coming on is the back-row half of the pair, and vice versa.
        const incomingIsBack = BACK_ROW_SLOTS.includes(subSheet.slot);
        return {
          ...l,
          pairings: [
            ...rewritten,
            {
              id: Date.now(),
              frontId: incomingIsBack ? outgoingId : incomingId,
              backId: incomingIsBack ? incomingId : outgoingId,
              isLibero: false,
            },
          ],
        };
      })
    );
    if (incomingIsLibero || outgoingIsLibero) {
      setLiberoSubCount((c) => c + 1);
    } else {
      if (!markInjured) setSubCount((c) => c + 1);
      // An injury sub isn't charged against the limit, but it's still an
      // entry — the returning player is still bound to this spot in the order.
      recordSubEntry(incomingId, outgoingId, subSheet.slot);
    }
    setInjuredPlayerIds((prev) => {
      let next = prev.filter((id) => id !== incomingId); // coming back in clears their injured tag
      if (markInjured && !next.includes(outgoingId)) next = [...next, outgoingId];
      return next;
    });
    setSubSheet(null);
    setSubReplacementId("");
    setMarkInjured(false);
    setSavePairing(false);
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
    // A pairing can only ever suggest bringing in someone who is actually on
    // the bench. Without this check, a libero with more than one pairing gets
    // suggested "in" for a second player while already standing on court —
    // easy to hit now that a libero can be put on court from the free-sub
    // sheet as well as from a pairing.
    const onCourtAfterRotation = new Set(Object.values(rotated).filter(Boolean));
    const suggestions = [];
    pairings.forEach((pr) => {
      const frontSlot = Object.keys(rotated).find((s) => rotated[s] === pr.frontId);
      const backSlot = Object.keys(rotated).find((s) => rotated[s] === pr.backId);
      if (frontSlot && BACK_ROW_SLOTS.includes(frontSlot) && !onCourtAfterRotation.has(pr.backId)) {
        suggestions.push({
          id: Date.now() + Math.random(),
          slot: frontSlot,
          outId: pr.frontId,
          inId: pr.backId,
          isLibero: pr.isLibero,
        });
      } else if (
        backSlot &&
        FRONT_ROW_SLOTS.includes(backSlot) &&
        !onCourtAfterRotation.has(pr.frontId)
      ) {
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
    setActiveSlots((cur) => ({ ...cur, [sug.slot]: sug.inId }));
    setSubSuggestions((prev) => prev.filter((s) => s.id !== sug.id));
    if (sug.isLibero) {
      setLiberoSubCount((c) => c + 1);
    } else {
      setSubCount((c) => c + 1);
      recordSubEntry(sug.inId, sug.outId, sug.slot);
    }
  };

  const dismissSuggestion = (id) => {
    setSubSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  // Simple mode manages no lineups, so it's allowed to create the next
  // set's lineup on the spot; Full mode still blocks and says why.
  const advanceSet = () => {
    setSetBlockedMsg(onStartNextSet({ autoCreate: simpleMode }) || "");
    setSimplePlayerId(null);
  };

  const recent = [...log].slice(-5).reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Simple / Full mode switch. Deliberately at the very top and always
          visible so you can flip to Full mid-match for a substitution and
          straight back, rather than committing to one mode for the game. */}
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 20px 0",
          flexShrink: 0,
        }}
      >
        {[
          { key: true, label: "Simple" },
          { key: false, label: "Full" },
        ].map((m) => {
          const on = simpleMode === m.key;
          return (
            <button
              key={m.label}
              onClick={() => setSimpleMode(m.key)}
              style={{
                flex: 1,
                padding: "7px 0",
                borderRadius: 8,
                border: `1.5px solid ${on ? COLORS.orange : COLORS.line}`,
                background: on ? COLORS.accentSoft : "none",
                color: on ? COLORS.orange : COLORS.chalkDim,
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Score bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "12px 14px",
          background: COLORS.bgRaised,
          borderBottom: `1px solid ${COLORS.line}`,
        }}
      >
        <ScoreCounter
          disabled={assistant && !assistantCanScore}
          label={usLabel}
          value={score.us}
          onChange={(d) => {
            setScore((s) => ({ ...s, us: Math.max(0, s.us + d) }));
            recordPoint("us", d);
          }}
          color={COLORS.orange}
        />
        <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.chalkDim, textAlign: "center", flexShrink: 0 }}>
          SET {setNumber}
        </div>
        <ScoreCounter
          disabled={assistant && !assistantCanScore}
          label={oppLabel}
          value={score.opp}
          onChange={(d) => {
            setScore((s) => ({ ...s, opp: Math.max(0, s.opp + d) }));
            recordPoint("opp", d);
          }}
          color={COLORS.blue}
        />
      </div>

      {/* Everything from here down to the rotation strip is the full
          match-management surface — sub counters, rotation advance, sub
          suggestions, the court. Simple mode hides all of it; the score
          bar above and the stat buttons / undo tray below are shared. */}
      {!simpleMode && (
        <>
      {/* Serving / receiving. Read from the score, tappable to correct when
          the scoreboard has drifted — the correction only has to survive one
          rally, because the next point settles it for real. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 20px 0" }}>
        <button
          onClick={() => setServingOverride(!possession.serving)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 999,
            border: `1.5px solid ${possession.serving ? COLORS.orange : COLORS.blue}`,
            background: possession.serving ? COLORS.accentSoft : COLORS.blueSoft,
            color: possession.serving ? COLORS.orange : COLORS.blue,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          {possession.serving ? "WE SERVE" : "RECEIVING"}
          <Repeat size={12} />
        </button>
        <span style={{ fontSize: 10, color: COLORS.chalkDim }}>
          {possession.overridden ? "set by hand — next point takes over" : "from the score · tap to correct"}
        </span>
      </div>

      {/* Possession-driven prompts — the libero swap and the serving
          specialist. Same shape as the rotation suggestions below, but these
          come and go with the serve rather than with a rotation. */}
      {possessionPrompts.length > 0 && (
        <div style={{ padding: "8px 20px 0" }}>
          {possessionPrompts.map((pr) => {
            const out = playerFor(pr.outId);
            const inP = playerFor(pr.inId);
            const isLibero = pr.kind === "libero";
            const overLimit = !isLibero && subCount >= SUB_LIMIT;
            return (
              <div
                key={pr.key}
                style={{
                  background: isLibero ? COLORS.blueSoft : COLORS.goldSoft,
                  border: `1.5px solid ${overLimit ? COLORS.red : isLibero ? COLORS.blue : COLORS.gold}`,
                  borderRadius: 10,
                  padding: "10px",
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: isLibero ? COLORS.blue : COLORS.gold,
                      border: `1px solid ${isLibero ? COLORS.blue : COLORS.gold}`,
                      borderRadius: 4,
                      padding: "1px 4px",
                      flexShrink: 0,
                      marginTop: 2,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isLibero ? "LIBERO" : "SERVE SUB"}
                  </span>
                  <div style={{ color: COLORS.chalk, flex: 1, lineHeight: 1.5 }}>
                    <div style={{ color: COLORS.chalkDim, fontSize: 10, fontWeight: 700 }}>{pr.note}</div>
                    <div>
                      Sub in: <b>#{jersey(inP)} {displayName(inP)}</b>
                    </div>
                    <div>
                      For: <b>#{jersey(out)} {displayName(out)}</b> ({pr.slot})
                    </div>
                    {overLimit && <div style={{ color: COLORS.red, fontWeight: 700 }}>Over sub limit</div>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => confirmPossessionPrompt(pr)}
                    style={{
                      flex: 1,
                      padding: "8px",
                      borderRadius: 8,
                      border: "none",
                      background: isLibero ? COLORS.blue : COLORS.gold,
                      color: "#1C2128",
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    Make the swap
                  </button>
                  <button
                    onClick={() =>
                      setDismissedPrompts((d) => [...d, `${possession.pointCount}:${pr.key}`])
                    }
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: `1px solid ${COLORS.line}`,
                      background: "none",
                      color: COLORS.chalkDim,
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    Not now
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
          {!assistant && (
            <SwipeConfirm label="Swipe to Advance Rotation" color={COLORS.blue} onConfirm={advanceRotation} height={30} />
          )}
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
        {!assistant && (
        <SwipeConfirm
          label={`Swipe to Start Set ${(activeLineup.setNumber || 1) + 1}`}
          color={COLORS.red}
          height={30}
          onConfirm={advanceSet}
        />
        )}
        {setBlockedMsg && (
          <div style={{ fontSize: 11, color: COLORS.gold, marginTop: 6 }}>{setBlockedMsg}</div>
        )}
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
                  background: COLORS.goldSoft,
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
                      Sub in: <b>#{jersey(inP)} {displayName(inP)}</b>
                    </div>
                    <div>
                      For: <b>#{jersey(out)} {displayName(out)}</b> ({sug.slot})
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
                background: active ? COLORS.accentSoft : "transparent",
                color: COLORS.chalk,
                display: "flex",
                alignItems: "center",
              }}
            >
              <span style={{ flex: "0 0 14px", fontSize: 8, color: COLORS.chalkDim, textAlign: "left" }}>
                {slot}
              </span>
              <span style={{ flex: 1, textAlign: "center", fontFamily: "'Oswald', sans-serif", fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
                {p ? `#${jersey(p)}` : "—"}
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
                    setSavePairing(false);
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

      {/* Libero serving cue — real volleyball rule this app didn't
          previously encode: a libero subbed in for more than one back-row
          player (e.g. two middles) is only allowed to actually serve
          during ONE of those rotational turns. Only shows up at all when
          a libero is currently occupying the true server slot (P1, always
          correct live via the rotation math, independent of the "1st
          Server" reference badge elsewhere which only marks the set's
          very first server). */}
      {(() => {
        const activePairing = findActiveLiberoPairing(slots, pairings);
        if (!activePairing) return null;
        const liberoPlayer = playerFor(activePairing.backId);
        const frontPlayer = playerFor(activePairing.frontId);
        return (
          <div
            style={{
              margin: "8px 20px 0",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 600,
              background: activePairing.liberoServes ? COLORS.greenSoft : COLORS.goldSoft,
              border: `1px solid ${activePairing.liberoServes ? COLORS.green : COLORS.gold}`,
              color: activePairing.liberoServes ? COLORS.green : COLORS.gold,
            }}
          >
            {activePairing.liberoServes
              ? `Libero (#${jersey(liberoPlayer)} ${displayName(liberoPlayer)}) is serving this rotation.`
              : `Libero is on court but not cleared to serve here — sub #${jersey(frontPlayer)} ${displayName(frontPlayer)} in to serve.`}
          </div>
        );
      })()}

        </>
      )}

      {/* Simple mode's only match-management control: advance the set, which
          clears the score and starts logging stats under the next set
          number. A swipe rather than a tap for the same reason Full mode
          uses one — this wipes the scoreboard, and the stat grid it sits
          above is tapped constantly. */}
      {simpleMode && !assistant && (
        <div style={{ padding: "8px 20px 0", flexShrink: 0 }}>
          <SwipeConfirm
            label={`Swipe to Start Set ${setNumber + 1}`}
            color={COLORS.red}
            height={26}
            onConfirm={advanceSet}
          />
          {setBlockedMsg && (
            <div style={{ fontSize: 11, color: COLORS.gold, marginTop: 6 }}>{setBlockedMsg}</div>
          )}
        </div>
      )}

      {/* Simple mode: the whole roster as tappable numbers — including
          players who aren't on court, which is the point. Tap a number,
          then tap a stat. */}
      {simpleMode && (
        <div
          style={{
            // Sized so a 390px-wide phone fits 5 numbers across rather than
            // 4 — a 10-player roster lands in 2 rows instead of 3, which is
            // the single biggest vertical saving available on this screen.
            // The buttons stay at/above a 44px touch target.
            padding: "8px 20px 4px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(62px, 1fr))",
            gap: 6,
            flexShrink: 0,
            maxHeight: "38vh",
            overflowY: "auto",
          }}
        >
          {simpleRoster.length === 0 && (
            <div style={{ fontSize: 12, color: COLORS.chalkDim }}>
              No players on the roster yet.
            </div>
          )}
          {simpleRoster.map((p) => {
            const on = simplePlayerId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setSimplePlayerId(on ? null : p.id)}
                style={{
                  padding: "6px 3px 5px",
                  borderRadius: 9,
                  border: `1.5px solid ${on ? COLORS.orange : COLORS.line}`,
                  background: on ? COLORS.accentSoft : COLORS.bgRaised,
                  color: COLORS.chalk,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  lineHeight: 1.1,
                }}
              >
                <span
                  style={{
                    fontFamily: "'Oswald', sans-serif",
                    fontSize: 19,
                    fontWeight: 700,
                    color: on ? COLORS.orange : COLORS.chalk,
                  }}
                >
                  {jersey(p)}
                </span>
                <span style={{ fontSize: 9, color: COLORS.chalkDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                  {displayName(p)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Recording with no match selected is not a small thing: the entries
          get no matchId, so they count in Season to Date but can never be
          shown BY match — not in the box score, Insights or Trends — and
          Settings' recover tool can't find them either, since it only rebuilds
          matches whose stats still carry an id. This happened for real, for a
          whole match. The header already said "No active match" in a dim
          subtitle, which is far too quiet to notice mid-rally, so it's said
          here instead: right above the buttons being tapped, in the colour
          this app uses for "stop and read me". */}
      {activeMatchId == null && (
        <button
          onClick={() => setTab("schedule")}
          style={{
            display: "block",
            width: "calc(100% - 40px)",
            margin: "4px 20px 0",
            padding: "9px 11px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.gold}`,
            background: COLORS.goldSoft,
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.gold }}>
            No match selected — these stats won't be attached to one
          </div>
          <div style={{ fontSize: 10.5, color: COLORS.chalkDim, marginTop: 2, lineHeight: 1.35 }}>
            They'll still count in Season to Date, but no box score will show
            them. Tap to pick tonight's match on the Schedule.
          </div>
        </button>
      )}

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
            ? `#${jersey(currentPlayer)} ${displayName(currentPlayer)}${currentPlayer.position ? ` (${currentPlayer.position})` : ""}`
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
        {visibleStatButtons.map((s) => (
          <button
            key={s.key}
            disabled={!currentPlayerId}
            onClick={() => recordStat(s.key)}
            style={{
              // Bigger type in the same box, which is what a coach glancing
              // down mid-rally actually needs. The size is measured, not
              // guessed: at the narrowest phone that matters (375px) each
              // button has 100px of text room once the side padding drops to
              // 2px, and the longest label ("Service Att.", 91.8px at 16px
              // bold) clears it by 8px — with the webfont blocked, too, which
              // is the normal offline state in a gym. 17px fits a 390px screen
              // but leaves barely 3px, which is not enough to trust across
              // devices. Vertical padding comes down to hold the button at the
              // same 40px it has always been.
              padding: "9px 2px",
              borderRadius: 10,
              border: `1.5px solid ${COLORS[s.colorKey]}`,
              background: `${COLORS[s.colorKey]}${COLORS.tintHex}`,
              color: COLORS.chalk,
              fontSize: 16,
              fontWeight: 700,
              textAlign: "center",
              // The block must not grow, and a wrapped label is the only thing
              // that would make it. nowrap makes that impossible regardless of
              // font metrics on a device we haven't measured.
              whiteSpace: "nowrap",
              opacity: currentPlayerId ? 1 : 0.4,
              cursor: currentPlayerId ? "pointer" : "not-allowed",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Undo tray - always visible, last 5 entries individually reversible.
          Deliberately one row: the "Recent entries — tap to undo" caption
          used to sit on its own line above the chips, which cost ~26px of
          vertical space on a phone for a label the chips already explain.
          The undo icon leads the row instead. */}
      <div
        style={{
          borderTop: `1px solid ${COLORS.line}`,
          background: COLORS.bgRaised,
          padding: "6px 16px 8px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Undo2 size={13} color={COLORS.chalkDim} style={{ flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto", flex: 1 }}>
          {recent.length === 0 && (
            <span style={{ fontSize: 11, color: COLORS.chalkDim, whiteSpace: "nowrap" }}>
              Recent entries — tap to undo
            </span>
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
                <span style={{ color: COLORS.chalkDim }}>#{jersey(p)}</span>
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
        // Liberos are offered here only for a back-row slot. Front row would
        // be an illegal placement, and this sheet is the only way onto the
        // court for a coach who hasn't set up pairings — so filtering them
        // out everywhere (which it used to do) meant the libero could never
        // be subbed in at all.
        const liberoAllowed = BACK_ROW_SLOTS.includes(subSheet.slot);
        const bench = roster.filter(
          (p) => !onCourtIds.has(p.id) && (liberoAllowed || !liberoIds.includes(p.id))
        );
        const outgoingIsLibero = liberoIds.includes(subSheet.playerId);
        const incomingIsLibero = liberoIds.includes(subReplacementId);
        const isLiberoSwap = outgoingIsLibero || incomingIsLibero;
        // Who the player being taken out is already tied to for this set.
        const outgoingCounterpart = outgoingIsLibero
          ? null
          : playerFor(boundCounterpart(subSheet.playerId));
        // "Make this a pair" is only offered when it would actually be a new,
        // valid pairing: a real (non-libero) sub where neither player is
        // already tied to a pairing for this lineup. A libero sub records its
        // own pairing automatically and doesn't need the offer.
        const inPairing = (id) =>
          pairings.some((pr) => pr.frontId === id || pr.backId === id);
        const canPair =
          !!subReplacementId &&
          !isLiberoSwap &&
          !inPairing(subSheet.playerId) &&
          !inPairing(subReplacementId);
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
                Out: #{jersey(outgoing)} {displayName(outgoing)} ·{" "}
                {isLiberoSwap
                  ? "counts as a libero swap, not a substitution"
                  : markInjured
                  ? "injury sub — doesn't count against your sub limit"
                  : "counts as one of your " + SUB_LIMIT + " subs"}
                {outgoingCounterpart && (
                  <div style={{ marginTop: 3 }}>
                    Tied to #{jersey(outgoingCounterpart)} {displayName(outgoingCounterpart)} this set
                  </div>
                )}
              </div>
              {!isLiberoSwap && !markInjured && subCount >= SUB_LIMIT && (
                <div style={{ fontSize: 12, color: COLORS.red, fontWeight: 700, marginTop: -8, marginBottom: 14 }}>
                  Over sub limit
                </div>
              )}
              <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Bringing In
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {bench.length === 0 && (
                  <div style={{ fontSize: 12, color: COLORS.chalkDim }}>No bench players available.</div>
                )}
                {bench.map((p) => {
                  // What this player is already committed to for the set. A
                  // returning player has to go back in for the same person —
                  // shown as a reminder, never as a block.
                  const counterpartId = liberoIds.includes(p.id) ? null : boundCounterpart(p.id);
                  const counterpart = playerFor(counterpartId);
                  const sameSpot = counterpartId && counterpartId === subSheet.playerId;
                  return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSubReplacementId(p.id);
                      setSavePairing(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 10px",
                      borderRadius: 8,
                      border: `1.5px solid ${subReplacementId === p.id ? COLORS.orange : COLORS.line}`,
                      background: subReplacementId === p.id ? COLORS.accentSoft : "transparent",
                      color: COLORS.chalk,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ textAlign: "left" }}>
                      <span>
                        #{jersey(p)} {displayName(p)} {p.position ? `(${p.position})` : ""}
                      </span>
                      {counterpart && (
                        <span
                          style={{
                            display: "block",
                            fontSize: 10,
                            marginTop: 2,
                            color: sameSpot ? COLORS.chalkDim : COLORS.gold,
                          }}
                        >
                          {sameSpot
                            ? `back in for #${jersey(counterpart)}`
                            : `tied to #${jersey(counterpart)} this set — different spot in the order`}
                        </span>
                      )}
                    </span>
                    {liberoIds.includes(p.id) && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.orange, border: `1px solid ${COLORS.orange}`, borderRadius: 4, padding: "1px 5px", marginLeft: "auto", marginRight: 6 }}>
                        LIBERO
                      </span>
                    )}
                    {injuredPlayerIds.includes(p.id) && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 4, padding: "1px 5px" }}>
                        OUT
                      </span>
                    )}
                  </button>
                  );
                })}
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
                Mark #{jersey(outgoing)} {displayName(outgoing)} as injured (doesn't count against the sub limit, and doesn't block them from returning)
              </button>
              {canPair && (
                <button
                  onClick={() => setSavePairing((v) => !v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    background: "none",
                    border: "none",
                    padding: "6px 0",
                    marginTop: -6,
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
                      border: `1.5px solid ${savePairing ? COLORS.green : COLORS.line}`,
                      background: savePairing ? COLORS.green : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {savePairing && <Check size={11} color={COLORS.chalk} />}
                  </span>
                  Make this a pair — the app will suggest this swap on its own at
                  the right rotation from now on
                </button>
              )}
              <button
                onClick={confirmFreeSubstitution}
                disabled={!subReplacementId}
                style={{
                  width: "100%",
                  padding: "11px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.green}`,
                  background: subReplacementId ? COLORS.greenSoft : "transparent",
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
// A destructive action that asks twice, in-app, instead of calling
// window.confirm(). The first tap arms the button and swaps its label; the
// second fires. It disarms itself after ARM_TIMEOUT so a button left armed
// and forgotten can't be triggered by a later stray tap.
//
// This exists because window.confirm/alert are documented as unreliable
// inside an installed standalone PWA on iOS — the dialog can fail to render
// while still blocking the page's JS thread, which is indistinguishable
// from the app freezing. See the CLAUDE.md note; that was a real report.
// Anywhere a native confirm is still in use, this is the replacement.
// "#4C9A63" -> "76,154,99", so a translucent fill can be built from whatever
// color was actually passed in. SwipeConfirm used to carry hardcoded RGB
// triplets and pick between them by comparing the color against COLORS.gold
// / COLORS.red, which meant it always drew the DARK theme's hues no matter
// which palette was live.
function hexToRgbTriplet(hex) {
  const h = String(hex).replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

const CONFIRM_ARM_TIMEOUT = 4000;
function ConfirmButton({ label, confirmLabel, onConfirm, style, armedStyle, disabled }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_ARM_TIMEOUT);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      style={{ ...style, ...(armed ? armedStyle : null) }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

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
        background: `rgba(${hexToRgbTriplet(color)},${
          parseInt(COLORS.tintHex, 16) / 255 + progress * 0.2
        })`,
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

function ScoreCounter({ label, value, onChange, color, disabled }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minWidth: 0 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: COLORS.chalkDim,
          letterSpacing: 0.5,
          maxWidth: 124,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <button
          onClick={() => onChange(-1)}
          style={{
            opacity: disabled ? 0.35 : 1,
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${COLORS.line}`,
            borderRadius: "50%",
            color: COLORS.chalk,
            width: 46,
            height: 46,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Minus size={23} />
        </button>
        <span
          style={{
            fontFamily: "'Oswald', sans-serif",
            fontSize: 38,
            fontWeight: 700,
            color,
            minWidth: 44,
            textAlign: "center",
            lineHeight: 1,
          }}
        >
          {value}
        </span>
        <button
          onClick={() => onChange(1)}
          style={{
            opacity: disabled ? 0.35 : 1,
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${COLORS.line}`,
            borderRadius: "50%",
            color: COLORS.chalk,
            width: 46,
            height: 46,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Plus size={23} />
        </button>
      </div>
    </div>
  );
}

// ---- Box score screen: current match, a specific past match, or full season ----
function BoxScoreScreen({ log, setLog, roster, matches, lineups, activeMatchId, statsView, setStatsView, pointLog, trendSubject, setTrendSubject, onEndMatch, assistant }) {
  const section = statsView?.section || "boxscore";
  const insightsMatchId = statsView?.insightsMatchId ?? null;
  const [editMode, setEditMode] = useState(false);
  const [boxPickerOpen, setBoxPickerOpen] = useState(false);

  const setSection = (s) => setStatsView((prev) => ({ ...(prev || {}), section: s }));
  // Which match the BOX SCORE is showing. It used to be hardwired to
  // activeMatchId, which made a just-finished match unreachable: End Match
  // clears activeMatchId (deliberately — new stats must not land on a closed
  // match), so the box score fell back to entries with no match at all and
  // read "No stats recorded yet" while the stats you'd just taken sat there
  // fine. Insights always had a picker; the box score now has the same one.
  // Explicit pick wins, then the active match, then the most recent match
  // that actually has stats — which is the one you just ended.
  const boxMatchPick = statsView?.boxMatchId;
  const boxMatchId =
    boxMatchPick !== undefined && boxMatchPick !== null
      ? boxMatchPick
      : activeMatchId != null
      ? activeMatchId
      : (() => {
          const withStats = matches
            .filter((m) => log.some((e) => e.matchId === m.id))
            .sort((a, b) => (a.date < b.date ? 1 : -1));
          return withStats.length ? withStats[0].id : null;
        })();
  const selectBoxMatch = (matchId) =>
    setStatsView((prev) => ({ ...(prev || {}), section: "boxscore", boxMatchId: matchId }));

  const selectInsightsMatch = (matchId) => setStatsView((prev) => ({ ...(prev || {}), section: "insights", insightsMatchId: matchId }));
  const backToInsightsList = () => setStatsView((prev) => ({ ...(prev || {}), insightsMatchId: null }));

  const groupByPlayer = (entries) => groupStatsByPlayer(entries, roster);

  // --- Box Score: current match only, kept simple — the plain per-player table ---
  const activeMatch = activeMatchId != null ? matches.find((m) => m.id === activeMatchId) : null;
  const boxMatch = boxMatchId != null ? matches.find((m) => m.id === boxMatchId) : null;
  // Every match worth offering in the box score's picker: anything with
  // stats, plus whichever is active even before it has any.
  const boxMatchList = useMemo(() => {
    const withData = new Set(log.map((e) => e.matchId).filter((id) => id != null));
    if (activeMatchId != null) withData.add(activeMatchId);
    return matches.filter((m) => withData.has(m.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [matches, log, activeMatchId]);
  const boxLog = useMemo(
    () => log.filter((e) => (e.matchId ?? null) === (boxMatchId ?? null)),
    [log, boxMatchId]
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
      jerseyLabel(player),
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
        background: section === key ? COLORS.accentSoft : "transparent",
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
              #{jerseyLabel(player)} {displayName(player)}
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
                      background: COLORS.redSoft,
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
            <button
              onClick={() => setBoxPickerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: "none",
                border: "none",
                padding: 0,
                color: COLORS.chalkDim,
                fontSize: 11,
                textAlign: "left",
                flex: 1,
              }}
            >
              {boxMatch
                ? `vs. ${boxMatch.opponent}${boxMatch.date ? ` · ${boxMatch.date}` : ""}`
                : "Pick a match"}
              <ChevronsRight
                size={12}
                style={{ transform: boxPickerOpen ? "rotate(-90deg)" : "rotate(90deg)", flexShrink: 0 }}
              />
            </button>
            {!assistant && (
              <button
                onClick={() => setEditMode((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: editMode ? COLORS.accentSoft : "none",
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
            )}
          </div>
          {boxPickerOpen && (
            <div style={{ marginBottom: 12 }}>
              {boxMatchList.length === 0 && (
                <div style={{ fontSize: 12, color: COLORS.chalkDim }}>No matches with stats yet.</div>
              )}
              {boxMatchList.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    selectBoxMatch(m.id);
                    setBoxPickerOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: m.id === boxMatchId ? COLORS.accentSoft : COLORS.bgRaised,
                    border: `1px solid ${m.id === boxMatchId ? COLORS.orange : COLORS.line}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 6,
                    color: COLORS.chalk,
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: COLORS.chalkDim, fontSize: 10 }}>{m.date || "No date"}</span>
                  <div style={{ fontWeight: 600 }}>
                    vs. {m.opponent}
                    {m.id === activeMatchId && (
                      <span style={{ color: COLORS.gold, fontSize: 9, fontWeight: 700, marginLeft: 6 }}>
                        ACTIVE
                      </span>
                    )}
                    {m.completedAt && (
                      <span style={{ color: COLORS.chalkDim, fontSize: 9, fontWeight: 700, marginLeft: 6 }}>
                        FINAL
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
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
          {activeMatchId && boxMatchId === activeMatchId && !assistant && (
            <>
              <div style={{ fontSize: 10, color: COLORS.chalkDim, marginTop: 14, marginBottom: 4 }}>
                Ending the match locks it in: each set's lineup and score are
                frozen onto this match, and the live scoreboard, sub counts and
                rotations reset for whatever comes next. Stats already recorded
                stay exactly as they are.
              </div>
              <ConfirmButton
                label="End Match"
                confirmLabel="Tap again to end and lock in this match"
                onConfirm={onEndMatch}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.red}`,
                  background: COLORS.redSoft,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                }}
                armedStyle={{ color: COLORS.red }}
              />
            </>
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
                      {STAT_LABELS[key]} leader: #{jerseyLabel(l.player)} {displayName(l.player)} ({l.value})
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
                    {rb.player ? `#${jerseyLabel(rb.player)} ${displayName(rb.player)}` : "Before tracking"}
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
                  #{jerseyLabel(p)} {displayName(p)}
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
                            background: COLORS[s.colorKey],
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
function RosterScreen({ roster, setRoster, captainIds, toggleCaptain, lineups, setLineups, teamName, setTeamName, teamAbbr, setTeamAbbr, coachName, setCoachName, teamLogo, updateTeamLogo, log, setLog, onOpenCaptainVote, assistant }) {
  const [playerSheet, setPlayerSheet] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [playerForm, setPlayerForm] = useState({ num: "", liberoNum: "", firstName: "", lastName: "", position: "", position2: "" });
  const [sortBy, setSortBy] = useState("number"); // "number" | "position" — display order only, never touches roster's actual stored order

  const openAddPlayer = () => {
    setPlayerForm({ num: "", liberoNum: "", firstName: "", lastName: "", position: "", position2: "" });
    setPlayerSheet({ mode: "add" });
  };

  const openEditPlayer = (p) => {
    setPlayerForm({ num: String(p.num), liberoNum: p.liberoNum ? String(p.liberoNum) : "", firstName: p.firstName || "", lastName: p.lastName || "", position: p.position || "", position2: p.position2 || "" });
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
                liberoNum: playerForm.liberoNum.trim(),
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
          liberoNum: playerForm.liberoNum.trim(),
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
    if (captainIds.includes(id)) toggleCaptain(id);
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
          placeholder="Scoreboard short name (e.g. GRAFTON)"
          value={teamAbbr}
          maxLength={10}
          onChange={(e) => setTeamAbbr(e.target.value)}
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

      <button
        onClick={onOpenCaptainVote}
        disabled={roster.length < 2}
        style={{
          width: "100%",
          marginBottom: 14,
          padding: "10px",
          borderRadius: 8,
          border: `1px solid ${COLORS.gold}`,
          background: COLORS.goldSoft,
          color: roster.length < 2 ? COLORS.chalkDim : COLORS.chalk,
          fontSize: 12,
          fontWeight: 700,
          opacity: roster.length < 2 ? 0.5 : 1,
          display: assistant ? "none" : "block",
        }}
      >
        Vote for Captain
      </button>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {!assistant && (
        <button
          onClick={openAddPlayer}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.orange}`,
            background: COLORS.accentSoft,
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
        )}
        {roster.length > 0 && (
          <button
            onClick={() =>
              downloadCSV(
                "roster.csv",
                ["Number", "First Name", "Last Name", "Position", "Captain"],
                roster.map((p) => [jerseyLabel(p), p.firstName, p.lastName, p.position || "", captainIds.includes(p.id) ? "C" : ""])
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
                background: sortBy === opt.key ? COLORS.accentSoft : "transparent",
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
            border: `1px solid ${captainIds.includes(p.id) ? COLORS.gold : COLORS.line}`,
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
            #{jerseyLabel(p)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14, color: COLORS.chalk, fontWeight: 600 }}>{displayName(p)}</span>
              {captainIds.includes(p.id) && (
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
          {!assistant && (
          <button
            onClick={() => toggleCaptain(p.id)}
            title="Toggle captain"
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 700,
              color: captainIds.includes(p.id) ? "#1C2128" : COLORS.chalkDim,
              background: captainIds.includes(p.id) ? COLORS.gold : "transparent",
              border: `1px solid ${captainIds.includes(p.id) ? COLORS.gold : COLORS.line}`,
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
          )}
          {!assistant && (
          <button
            onClick={() => openEditPlayer(p)}
            title="Edit player"
            style={{ flexShrink: 0, background: "none", border: "none", color: COLORS.chalkDim }}
          >
            <Pencil size={14} />
          </button>
          )}
          {!assistant && (
          <button
            onClick={() => deletePlayer(p.id)}
            title="Remove from roster"
            style={{ flexShrink: 0, background: "none", border: "none", color: COLORS.chalkDim }}
          >
            <Trash2 size={14} />
          </button>
          )}
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
            <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
              Libero Jersey # (optional)
            </label>
            <input
              placeholder="e.g. 32"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={playerForm.liberoNum}
              onChange={(e) => setPlayerForm((s) => ({ ...s, liberoNum: e.target.value.replace(/[^0-9]/g, "") }))}
              style={{
                width: 80,
                padding: "9px 10px",
                marginTop: 4,
                background: COLORS.bg,
                border: `1px solid ${COLORS.line}`,
                borderRadius: 8,
                color: COLORS.chalk,
                fontSize: 13,
              }}
            />
            <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "6px 0 14px" }}>
              Only if she wears a different jersey as libero. She stays one player —
              in a set where she's in the LIBEROS row she shows as this number, otherwise
              as #{playerForm.num || "—"}. Don't add her to the roster twice.
            </div>
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
// One day's worth of stranded stats, with a picker for the match to attach
// them to. Module scope, like everything else a long-lived screen renders —
// see CLAUDE.md on the ReferenceError a component-local helper caused once.
//
// The match defaults to one played on the same calendar day if the schedule
// has one, which is the overwhelmingly common case: the coach recorded on the
// 8th and there is an Oct 8 match sitting right there. Attaching is a
// ConfirmButton rather than a one-tap, since picking the wrong match moves a
// whole evening's stats onto it and there's no undo.
function UnassignedGroupRow({ group, matches, onAssign }) {
  const sorted = [...(matches || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const sameDay = group.date ? sorted.find((m) => m.date === group.date) : null;
  const [matchId, setMatchId] = useState(() => String(sameDay?.id ?? sorted[0]?.id ?? ""));
  const chosen = sorted.find((m) => String(m.id) === String(matchId));
  return (
    <div
      style={{
        border: `1px solid ${COLORS.gold}`,
        borderRadius: 8,
        padding: "9px 10px",
        marginBottom: 8,
        background: COLORS.goldSoft,
      }}
    >
      <div style={{ fontSize: 12, color: COLORS.chalk, fontWeight: 700 }}>
        {group.date ? new Date(group.firstAt).toLocaleDateString() : "Unknown date"}
      </div>
      <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
        {group.stats} stat{group.stats === 1 ? "" : "s"}
        {group.points ? ` · ${group.points} point${group.points === 1 ? "" : "s"}` : ""}
        {group.sets.length ? ` · set${group.sets.length === 1 ? "" : "s"} ${group.sets.join(", ")}` : ""}
      </div>
      {sorted.length === 0 ? (
        <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
          No matches on the schedule yet — add the match first, then come back.
        </div>
      ) : (
        <>
          <select
            value={matchId}
            onChange={(e) => setMatchId(e.target.value)}
            style={{
              width: "100%",
              padding: "8px",
              borderRadius: 6,
              border: `1px solid ${COLORS.line}`,
              background: COLORS.bg,
              color: COLORS.chalk,
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            {sorted.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.date} — {m.opponent}
                {group.date && m.date === group.date ? " (same day)" : ""}
              </option>
            ))}
          </select>
          <ConfirmButton
            label={`Attach to ${chosen ? chosen.opponent : "this match"}`}
            confirmLabel="Tap again to attach"
            onConfirm={() => matchId && onAssign(Number.isNaN(Number(matchId)) ? matchId : Number(matchId))}
            style={{
              width: "100%",
              padding: "9px",
              borderRadius: 8,
              border: `1.5px solid ${COLORS.green}`,
              background: COLORS.greenSoft,
              color: COLORS.chalk,
              fontSize: 12,
              fontWeight: 700,
            }}
            armedStyle={{ color: COLORS.green }}
          />
        </>
      )}
    </div>
  );
}

function ScheduleScreen({ matches, setMatches, activeMatchId, setActiveMatchId, setTab, setStatsView, matchIdsWithStats, orphanedMatches, unassignedEntries, onOpenSettings, assistant }) {
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

  // Does this match carry anything that dies with it? Stats survive in the
  // logs doc, but they stop being reachable per-match, and the frozen
  // lineup/score record is stored on the match itself.
  const hasRecord = (m) =>
    !!(m.completedAt || m.lineupSnapshots || (matchIdsWithStats && matchIdsWithStats.has(m.id)));

  const deleteMatch = (id) => {
    setMatches((prev) => prev.filter((m) => m.id !== id));
    if (activeMatchId === id) setActiveMatchId(null);
  };

  // Tap a match to jump straight to the right place: an upcoming match sets
  // it active and opens Lineup for prep; a past match opens its Insights.
  const goToMatch = (m) => {
    const todayStr = todayISO();
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
        {!assistant && (
        <button
          onClick={openAddMatch}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 8,
            border: `1.5px solid ${COLORS.orange}`,
            background: COLORS.accentSoft,
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
        )}
        {!assistant && (
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
        )}
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

      {/* Surfaced here, not just in Settings, because this is the screen where
          a match gets deleted — the coach who loses one looks here first. */}
      {orphanedMatches && orphanedMatches.length > 0 && (
        <button
          onClick={onOpenSettings}
          style={{
            width: "100%",
            textAlign: "left",
            border: `1px solid ${COLORS.gold}`,
            background: COLORS.goldSoft,
            borderRadius: 10,
            padding: "9px 11px",
            marginBottom: 10,
            color: COLORS.chalk,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>
            {orphanedMatches.length} deleted match
            {orphanedMatches.length === 1 ? "" : "es"} still {orphanedMatches.length === 1 ? "has" : "have"} stats
          </div>
          <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
            Nothing was lost — tap to restore in Settings → Recover Deleted Matches.
          </div>
        </button>
      )}

      {/* Same shape as the orphan banner above, different cause: these entries
          never had a match at all, because the Live screen was recording with
          none selected. Surfaced here because this is the screen where the
          matches to attach them to actually live. */}
      {!assistant && unassignedEntries && unassignedEntries.length > 0 && (
        <button
          onClick={onOpenSettings}
          style={{
            width: "100%",
            textAlign: "left",
            border: `1px solid ${COLORS.gold}`,
            background: COLORS.goldSoft,
            borderRadius: 10,
            padding: "9px 11px",
            marginBottom: 10,
            color: COLORS.chalk,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>
            {unassignedEntries.reduce((n, g) => n + g.stats, 0)} stat
            {unassignedEntries.reduce((n, g) => n + g.stats, 0) === 1 ? "" : "s"} aren't attached to a match
          </div>
          <div style={{ fontSize: 11, color: COLORS.chalkDim }}>
            Recorded with no match selected — tap to attach them in Settings →
            Stats Not Attached To A Match.
          </div>
        </button>
      )}

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
              {!assistant && (
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
              )}
              {assistant && isActive && (
                <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.gold }}>Active</span>
              )}
              {!assistant && (
              <button
                onClick={() => openEditMatch(m)}
                title="Edit match"
                style={{ background: "none", border: "none", color: COLORS.chalkDim }}
              >
                <Pencil size={14} />
              </button>
              )}
              {/* Deleting a played match is not recoverable: the stats
                  themselves live in the logs doc and survive, but this
                  match's lineupSnapshots/setScores/completedAt live on the
                  match object and go with it, and the surviving stats drop
                  out of every per-match view (box score picker, Insights,
                  Trends) since those all list from `matches`. It used to
                  delete on a single tap with no confirmation whatsoever. */}
              {!assistant && (
              <ConfirmButton
                label={<Trash2 size={15} />}
                confirmLabel={
                  <span style={{ fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                    {hasRecord(m) ? "Delete record?" : "Delete?"}
                  </span>
                }
                onConfirm={() => deleteMatch(m.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: COLORS.chalkDim,
                  padding: "4px 2px",
                }}
                armedStyle={{ color: COLORS.red }}
              />
              )}
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
                    background: form.homeAway === ha ? COLORS.accentSoft : "transparent",
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
const PrintArea = React.memo(function PrintArea({ target, roster, lineups, activeLineupId, log, score, matches, captainIds, teamName, coachName, activeMatchId, teamLogo, statsView, trendSubject, pointLog, includePairingsRoster, includePairingsLineup, printStatKeys, roleSystem }) {
  const activeLineupForPrint = lineups.find((l) => l.id === activeLineupId) || lineups[0];
  const setNumber = activeLineupForPrint?.setNumber || 1;
  const activeMatch = matches.find((m) => m.id === activeMatchId) || null;
  const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0] || EMPTY_LINEUP;
  const playerFor = (id) => roster.find((p) => p.id === id);

  const boxSection = statsView?.section || "boxscore";
  // Follows the box score's own match picker, not activeMatchId — otherwise
  // printing a finished match's sheet silently prints the live one instead.
  const boxPrintMatchId =
    statsView?.boxMatchId !== undefined && statsView?.boxMatchId !== null
      ? statsView.boxMatchId
      : activeMatchId;
  const boxLog = log.filter((e) => (e.matchId ?? null) === (boxPrintMatchId ?? null));

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
      return p ? `#${jerseyLabel(p)} ${fullName(p)}` : "Player";
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
    <div style={{ marginTop: 8, fontSize: 9, color: "#999", textAlign: "center" }}>
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
                <td style={{ ...td, fontWeight: 700, color: "#000" }}>{jerseyLabel(p)}</td>
                <td style={{ ...td, color: "#000" }}>{`${p.firstName || ""} ${p.lastName || ""}`.trim() || "—"}</td>
                <td style={{ ...td, color: "#000" }}>{p.position || "—"}</td>
                <td style={{ ...td, color: "#000" }}>{captainIds.includes(p.id) ? "C" : ""}</td>
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
                        Front: #{jerseyLabel(front)} {fullName(front)} &nbsp;↔&nbsp; Back: #{jerseyLabel(back)} {fullName(back)}
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
      {/* SERVE-RECEIVE — all six rotations on one page, as a reference card.
          Black on white like every other sheet: PrintArea never touches a
          COLORS token, or a sheet printed from dark mode comes out in
          dark-mode hues on paper. The track colours below resolve the same
          role keys the screen does, through a print palette instead. */}
      <div className={`print-section${target === "servereceive" ? " active" : ""}`}>
        {/* One page per SET, not just the active one — a coach prepping for a
            match wants the whole book. Each set is a `.servereceive-page-group`,
            which `handlePrint` captures as its own PDF page; without that,
            height-based slicing cuts a set's courts away from its own heading,
            the same bug the sub sheet and player guide already had. */}
        {(lineups || []).map((l) => {
          if (!l) return null;
          const system = roleSystem?.system || "5-1";
          const setterFront = roleSystem?.setterFront === "middle" ? "middle" : "right";
          const isAlt = !!l.serveReceiveAlternate;
          const TRACK = { S: "#8A6508", MB: "#1F6B3F", OH: "#5B3E9B", other: "#A63A32" };
          const track = (k) => TRACK[k] || TRACK.other;
          // 3 across x 2 down inside the 752px of printable width. Keeping the
          // screen's 0.82 aspect means the arrowhead maths is unchanged.
          const COURT_W = 244;
          // Taller than the screen's 0.82: three courts across is fixed by the
          // page width, so the only way to give the stack more room to spread
          // is downwards, and a letter page has the height spare. The aspect is
          // passed into the geometry, which needs it for the arrowhead maths.
          const ASPECT = 0.68;
          const MARK = 34; // circle diameter; the court is 2/3 the screen's width
          const onCourt = ["P1", "P2", "P3", "P4", "P5", "P6"]
            .map((pos) => l.slots?.[pos])
            .filter(Boolean);
          const keyPlayers = onCourt.map((id) => roster.find((p) => p.id === id)).filter(Boolean);
          const lib = (l.liberos || []).filter(Boolean).map((id) => roster.find((p) => p.id === id)).filter(Boolean);
          // All six rotations up front: the legend has to know which roles
          // actually move anywhere before the courts are drawn, and computing
          // them twice would be wasted work inside a memoised print tree.
          const rots = [1, 2, 3, 4, 5, 6].map((rot) => ({
            rot,
            geo: serveReceiveGeometry(system, computeRotationSlots(l, rot), roster, l.liberos || [], isAlt, setterFront, ASPECT),
          }));
          const movingRoles = new Set(rots.flatMap(({ geo }) => geo.arrows.map((a) => a.colorKey)));
          const jp = (p) => jerseyFor(p, l.liberos);
          return (
            <div className="servereceive-page-group" key={l.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
                {teamLogo ? <img src={teamLogo} alt="" style={{ height: 34 }} /> : null}
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.5 }}>
                  SERVE-RECEIVE — {(l.name || `SET ${l.setNumber || 1}`).toUpperCase()}
                </div>
              </div>
              <div style={{ fontSize: 11, marginBottom: 10 }}>
                {teamName || ""}{teamName ? " · " : ""}All six rotations · {system}
                {system === "4-2" ? ` · setter sets from ${setterFront === "middle" ? "middle" : "right"} front` : ""}
                {isAlt ? " · alternate pattern" : ""}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 9.5, marginBottom: 8 }}>
                {[["#2B6285", "Passer", true], [TRACK.S, "Setter", movingRoles.has("S")], [TRACK.MB, "Middle", movingRoles.has("MB")], [TRACK.OH, "Outside", movingRoles.has("OH")]]
                  .filter(([, , show]) => show)
                  .map(([c, label]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", border: `2px solid ${c}`, display: "inline-block" }} />
                    {label}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 9.5, marginBottom: 10 }}>
                Solid circle = where she stands at the moment of the serve. Arrow
                → dashed ring = where she moves once the ball is away.
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {rots.map(({ rot, geo }) => {
                  return (
                    <div key={rot} style={{ width: COURT_W }}>
                      <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 3 }}>ROTATION {rot}</div>
                      <div
                        style={{
                          position: "relative",
                          width: COURT_W,
                          height: COURT_W / ASPECT,
                          border: "1px solid #000",
                          borderTop: "3px solid #000",
                          boxSizing: "border-box",
                        }}
                      >
                        {geo.arrows.map((g) => (
                          <svg
                            key={`a-${g.pos}`}
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
                          >
                            <path d={g.d} fill="none" stroke={track(g.colorKey)} strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                            <polygon points={g.points} fill={track(g.colorKey)} />
                          </svg>
                        ))}
                        {geo.markers
                          .filter((m) => m.moveTo)
                          .map((m) => (
                            <div
                              key={`d-${m.pos}`}
                              style={{
                                position: "absolute",
                                left: `${m.moveTo.x}%`,
                                top: `${m.moveTo.y}%`,
                                transform: "translate(-50%, -50%)",
                                width: MARK * 0.8,
                                height: MARK * 0.8,
                                borderRadius: "50%",
                                border: `1.5px dashed ${track(m.colorKey)}`,
                                color: track(m.colorKey),
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 10.5,
                                fontWeight: 800,
                              }}
                            >
                              {m.player ? jp(m.player) : ""}
                            </div>
                          ))}
                        {geo.markers.map((m) => (
                          <div
                            key={m.pos}
                            style={{
                              position: "absolute",
                              left: `${m.coord.x}%`,
                              top: `${m.coord.y}%`,
                              transform: "translate(-50%, -50%)",
                              width: MARK,
                              height: MARK,
                              borderRadius: "50%",
                              border: `${m.colorKey ? 2 : 1.5}px solid ${m.colorKey ? track(m.colorKey) : m.isPasser ? "#2B6285" : "#000"}`,
                              background: "#fff",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 13,
                              fontWeight: 800,
                              boxSizing: "border-box",
                            }}
                          >
                            {m.player ? jp(m.player) : ""}
                          </div>
                        ))}
                        {/* Name under the circle, not inside it: at 34px a
                            circle can hold a jersey number or a name, not
                            both, and the court's dead space below each marker
                            is free real estate. Short form only — a full name
                            is wider than the gap between two markers in the
                            receive line. */}
                        {geo.markers
                          .filter((m) => m.player)
                          .map((m) => (
                            <div
                              key={`n-${m.pos}`}
                              style={{
                                position: "absolute",
                                left: `${m.coord.x}%`,
                                top: `calc(${m.coord.y}% + ${MARK / 2 + 6}px)`,
                                transform: "translate(-50%, -50%)",
                                // Sized to its own text and centred by the
                                // transform — a fixed width with
                                // overflow/ellipsis clipped the names to "a S."
                                // once there was a background span inside it.
                                // `displayName` is short ("Olive O."), and the
                                // receive line's markers are 68px apart, so
                                // nothing needs truncating.
                                whiteSpace: "nowrap",
                                fontSize: 9,
                                lineHeight: 1.25,
                                padding: "0 2px",
                                // The label paints over the arrows (it comes
                                // last in the DOM), but an arrow crossing the
                                // glyphs still makes them hard to read — the
                                // bow maths only knows about circles, not about
                                // text hanging below one. An opaque background
                                // lets the arrow pass behind the name instead
                                // of through it. A text-shadow halo would be
                                // prettier; html2canvas renders those
                                // unreliably.
                                background: "#fff",
                                color: m.colorKey ? track(m.colorKey) : "#222",
                              }}
                            >
                              {displayName(m.player)}
                            </div>
                          ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Numbers on the courts, names down here — at this size a circle
                  only fits a jersey number, same convention as the lineup sheet's
                  roster key. */}
              <div style={{ marginTop: 12, fontSize: 10, lineHeight: 1.7 }}>
                <b>ON COURT:</b>{" "}
                {keyPlayers.map((p, i) => (
                  <span key={p.id}>
                    {i ? " · " : ""}#{jerseyLabel(p)} {fullName(p)}
                    {p.position ? ` (${p.position})` : ""}
                  </span>
                ))}
                {lib.length ? (
                  <>
                    <br />
                    <b>LIBERO:</b>{" "}
                    {lib.map((p, i) => (
                      <span key={p.id}>
                        {i ? " · " : ""}#{jerseyFor(p, l.liberos)} {fullName(p)}
                      </span>
                    ))}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

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
              <div key={label} style={{ marginBottom: 12, fontSize: 15, fontWeight: 700 }}>
                {label}:
                {value ? (
                  <div style={{ fontWeight: 400, fontSize: 15 }}>{value}</div>
                ) : (
                  <div style={{ borderBottom: "1px solid #000", height: 18 }}>&nbsp;</div>
                )}
              </div>
            ))}
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Set Scores:</div>
            <div style={{ marginBottom: 12, fontSize: 14 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} style={{ marginBottom: 6 }}>
                  <b>Set {n}</b>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, margin: "12px 0 5px" }}>Roster:</div>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #000" }}>
              <thead>
                <tr>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", width: 38, fontSize: 14, padding: "6px 6px" }}>No.</th>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", fontSize: 17, padding: "6px 6px" }}>Name</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((p) => (
                  <tr key={p.id}>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 14, padding: "6px 6px" }}>{jerseyLabel(p)}</td>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 17, fontWeight: 600, padding: "6px 6px" }}>{fullName(p)}</td>
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
                            #{jerseyFor(front, l?.liberos)} {fullName(front)} ↔ #{jerseyFor(back, l?.liberos)} {fullName(back)}
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
                1: { circle: 84, gap: 16, pad: 16, setFont: 17, netFont: 11, border: 4, marginBottom: 22 },
                2: { circle: 72, gap: 14, pad: 14, setFont: 16, netFont: 11, border: 4, marginBottom: 19 },
                3: { circle: 62, gap: 12, pad: 12, setFont: 15, netFont: 10, border: 3, marginBottom: 16 },
                4: { circle: 50, gap: 9, pad: 9, setFont: 13, netFont: 9, border: 3, marginBottom: 12 },
                5: { circle: 42, gap: 7, pad: 8, setFont: 12, netFont: 8, border: 3, marginBottom: 9 },
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
                        const isCap = p && captainIds.includes(p.id);
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
                            {p ? jerseyFor(p, l?.liberos) : ""}
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
                    {/* Libero designations — pulled from the lineup's actual
                        assigned liberos when set, blank otherwise. Aligned in
                        the same 3-column grid as the circles above so Lib 2
                        lines up directly under the center position. */}
                    <div
                      style={{
                        fontSize: Math.max(sizing.setFont, 15),
                        marginTop: 6,
                        display: "grid",
                        gridTemplateColumns: "repeat(3, 1fr)",
                      }}
                    >
                      <span style={{ textAlign: "center" }}>
                        <b>Lib 1</b>&nbsp;{jerseyFor(playerFor(l?.liberos?.[0]), l?.liberos) || ""}
                      </span>
                      <span style={{ textAlign: "center" }}>
                        <b>Lib 2</b>&nbsp;{jerseyFor(playerFor(l?.liberos?.[1]), l?.liberos) || ""}
                      </span>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>

        <div style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
          <b>Please note:</b> Write only the player's number in the positions in which they will START.
          Indicate captain with a 'C' next to the number and the player serving first with a circle
          around the number.
        </div>
        <PrintFooter />
      </div>

      {/* BLANK LINEUP SHEET — for coaches who prefer to pencil in the actual
          lineup themselves. Only the roster is real data; everything else
          (team info, all 5 diagrams, liberos, set scores) is blank. Uses the
          same "5 sets" sizing as the real sheet always, since it's always
          exactly 5 blank sets here, never fewer. */}
      <div className={`print-section${target === "blanksheet" ? " active" : ""}`}>
        <div style={{ textAlign: "center", fontSize: 24, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
          VOLLEYBALL LINEUP SHEET
        </div>
        <div style={{ textAlign: "center", fontSize: 13, color: "#666", marginBottom: 24 }}>Blank — fill in by hand</div>
        <div style={{ display: "flex", gap: 24 }}>
          <div style={{ flex: 1 }}>
            {["Team", "Coach", "Date", "Opponent", "Match Winner"].map((label) => (
              <div key={label} style={{ marginBottom: 12, fontSize: 15, fontWeight: 700 }}>
                {label}:
                <div style={{ borderBottom: "1px solid #000", height: 18 }}>&nbsp;</div>
              </div>
            ))}
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Set Scores:</div>
            <div style={{ marginBottom: 12, fontSize: 14 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} style={{ marginBottom: 6 }}>
                  <b>Set {n}</b>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, margin: "12px 0 5px" }}>Roster:</div>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #000" }}>
              <thead>
                <tr>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", width: 38, fontSize: 14, padding: "6px 6px" }}>No.</th>
                  <th style={{ ...th, border: "1px solid #000", background: "#ddd", fontSize: 17, padding: "6px 6px" }}>Name</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((p) => (
                  <tr key={p.id}>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 14, padding: "6px 6px" }}>{jerseyLabel(p)}</td>
                    <td style={{ ...td, border: "1px solid #000", fontSize: 17, fontWeight: 600, padding: "6px 6px" }}>{fullName(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ flex: 1 }}>
            {[...Array(5)].map((_, i) => {
              const sizing = { circle: 42, gap: 7, pad: 8, setFont: 12, netFont: 8, border: 3, marginBottom: 9 };
              return (
                <div key={i} style={{ marginBottom: sizing.marginBottom }}>
                  <div style={{ textAlign: "center", fontSize: sizing.setFont, fontWeight: 700 }}>Set {i + 1}</div>
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
                    {["P4", "P3", "P2", "P5", "P6", "P1"].map((slot) => (
                      <div
                        key={slot}
                        style={{
                          width: sizing.circle,
                          height: sizing.circle,
                          borderRadius: "50%",
                          border: "1.5px solid #000",
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ fontSize: 15, marginTop: 6, display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
                    <span style={{ textAlign: "center" }}>
                      <b>Lib 1</b>
                    </span>
                    <span style={{ textAlign: "center" }}>
                      <b>Lib 2</b>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
          <b>Please note:</b> Write only the player's number in the positions in which they will START.
          Indicate captain with a 'C' next to the number and the player serving first with a circle
          around the number.
        </div>
        <PrintFooter />
      </div>

      {/* BOX SCORE — full match totals, current match only */}
      <div className={`print-section${target === "box" && boxSection === "boxscore" ? " active" : ""}`}>
        <PrintHeader
          title="Box Score — Full Match"
          subtitle={
            activeMatch
              ? `vs. ${activeMatch.opponent}${activeMatch.date ? ` · ${activeMatch.date}` : ""}`
              : `Set ${setNumber} · Us ${score.us} – ${score.opp} Opponent`
          }
        />
        {(() => {
          const visibleStats = STAT_BUTTONS.filter((s) => (printStatKeys || []).includes(s.key));
          return (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Name</th>
                  {visibleStats.map((s) => (
                    <th key={s.key} style={{ ...th, textAlign: "center" }}>
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {boxRows.map(({ player, stats }, idx) => (
                  <tr key={player.id} style={{ background: idx % 2 === 1 ? "#cfcfcf" : "transparent" }}>
                    <td style={{ ...td, fontWeight: 700 }}>{jerseyLabel(player)}</td>
                    <td style={td}>{fullName(player)}</td>
                    {visibleStats.map((s) => (
                      <td key={s.key} style={{ ...td, textAlign: "center" }}>
                        {stats[s.key] || ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
        <PrintFooter />
      </div>

      {/* BOX SCORE — broken down set by set, current match only. Same stat
          filter as the full-match version, reusing groupByPlayer per set
          instead of across the whole match. */}
      <div className={`print-section${target === "boxperset" ? " active" : ""}`}>
        <PrintHeader
          title="Box Score — By Set"
          subtitle={activeMatch ? `vs. ${activeMatch.opponent}${activeMatch.date ? ` · ${activeMatch.date}` : ""}` : "Current match"}
        />
        {(() => {
          const visibleStats = STAT_BUTTONS.filter((s) => (printStatKeys || []).includes(s.key));
          const setNumbers = [...new Set(boxLog.map((e) => e.setNumber || 1))].sort((a, b) => a - b);
          if (setNumbers.length === 0) {
            return <div style={{ fontSize: 12, color: "#444" }}>No stats recorded for this match.</div>;
          }
          return setNumbers.map((sn) => {
            const setRows = groupStatsByPlayer(boxLog.filter((e) => (e.setNumber || 1) === sn), roster);
            return (
              <div key={sn} style={{ marginBottom: 24, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Set {sn}</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>#</th>
                      <th style={th}>Name</th>
                      {visibleStats.map((s) => (
                        <th key={s.key} style={{ ...th, textAlign: "center" }}>
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {setRows.map(({ player, stats }, idx) => (
                      <tr key={player.id} style={{ background: idx % 2 === 1 ? "#cfcfcf" : "transparent" }}>
                        <td style={{ ...td, fontWeight: 700 }}>{jerseyLabel(player)}</td>
                        <td style={td}>{fullName(player)}</td>
                        {visibleStats.map((s) => (
                          <td key={s.key} style={{ ...td, textAlign: "center" }}>
                            {stats[s.key] || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          });
        })()}
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
                    {STAT_LABELS[key]} leader: #{jerseyLabel(l.player)} {fullName(l.player)} ({l.value})
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
                    <td style={td}>{rb.player ? `#${jerseyLabel(rb.player)} ${fullName(rb.player)}` : "Before tracking"}</td>
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
                <td style={{ ...td, fontWeight: 700 }}>{jerseyLabel(player)}</td>
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

      {/* ROTATION REFERENCE — hand this to players, not coaches. Six small
          court diagrams per set, one per rotation, with a dual circle only
          at the exact rotation a substitution actually happens — everything
          else is a single number. Deliberately minimal: no names, no prose,
          just numbers a player can find and follow. 2 sets per page — each
          ".subsheet-page-group" is captured as its own PDF page in
          handlePrint, rather than just letting natural height decide where
          pages break. (The title-orphaning issue this was meant to fix
          turned out to be a different bug entirely — handlePrint was
          reading a stale target value, so this grouping mechanism was
          never actually running at all. Now that it's fixed, 2-per-page
          works correctly.) */}
      <div className={`print-section${target === "subsheet" ? " active" : ""}`}>
        <PrintHeader title="Rotation Reference" subtitle="Find your number, follow it by rotation" />
        {(() => {
          const qualifying = lineups.slice(0, 5).filter((l) => {
            const filledCount = Object.values(l.slots).filter(Boolean).length;
            return filledCount === 6 && (l.pairings || []).length > 0;
          });
          const pageGroups = [];
          for (let i = 0; i < qualifying.length; i += 2) pageGroups.push(qualifying.slice(i, i + 2));
          return pageGroups.map((group, gi) => (
            <div className="subsheet-page-group" key={gi}>
              {group.map((l) => {
                const pairings = l.pairings || [];
                const { rotations, transitions } = computeSubTransitions(l);
                const order = ["P4", "P3", "P2", "P5", "P6", "P1"];
                const size = 48;
                return (
                  <div key={l.id} style={{ marginBottom: 28, pageBreakInside: "avoid" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, textAlign: "center", marginBottom: 3 }}>{l.name}</div>
                    <div style={{ fontSize: 10, color: "#555", textAlign: "center", marginBottom: 8 }}>
                Dual circle = a sub happens right here · struck-through = leaving · L = libero
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {rotations.map((_, i) => {
                  const r = i + 1;
                  const { withSubs } = rotations[i];
                  return (
                    <div key={r} style={{ border: "1px solid #999", borderRadius: 8, padding: 7 }}>
                      <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, marginBottom: 5 }}>
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
                                  <span style={{ fontSize: 14, fontWeight: 700 }}>{jerseyFor(playerFor(t.leaving), l?.liberos)}</span>
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
                                  <span style={{ fontSize: 16, fontWeight: 800 }}>
                                    {jerseyFor(playerFor(t.entering), l?.liberos)}
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
                              <span style={{ fontSize: 17, fontWeight: 800 }}>{jerseyFor(playerFor(withSubs[pos]), l?.liberos)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Plain-text summary of the pairings driving the grid above —
                  a quick reference without having to trace all 6 rotations.
                  Simple stacked lines, same proven pattern as the Lineup
                  Sheet's own pairings list — avoiding flexbox-gap here,
                  since html2canvas has known spotty support for it and that
                  was silently dropping this whole block before. */}
              <div style={{ marginTop: 12, textAlign: "center" }}>
                {pairings.map((pr, i) => {
                  const front = playerFor(pr.frontId);
                  const back = playerFor(pr.backId);
                  return (
                    <div key={pr.id || i} style={{ fontSize: 14, marginBottom: 3 }}>
                      <b>{displayName(front)}</b> <span style={{ fontWeight: 400, color: "#333" }}>#{jerseyFor(front, l?.liberos)}</span>
                      {" ↔ "}
                      <b>{displayName(back)}</b> <span style={{ fontWeight: 400, color: "#333" }}>#{jerseyFor(back, l?.liberos)}</span>
                      {pr.isLibero ? " (L)" : ""}
                    </div>
                  );
                })}
              </div>
            </div>
                );
              })}
            </div>
          ));
        })()}
        <PrintFooter />
      </div>

      {/* PLAYER GUIDE — the actual player-facing sheet. One clean starting
          diagram, then plain-language swap rules instead of a grid to
          decode — built after the rotation-grid version turned out to be
          too much to process live, mid-play. Front/back-row based, since
          that's something a player can directly observe, unlike a rotation
          number they'd have to track in their head. */}
      <div className={`print-section${target === "playerguide" ? " active" : ""}`}>
        <PrintHeader title="Player Guide" subtitle="Your starting lineup and swaps" />
        {lineups.slice(0, 5).map((l) => {
          const filledCount = Object.values(l.slots).filter(Boolean).length;
          const pairings = l.pairings || [];
          if (filledCount < 6 || pairings.length === 0) return null;
          const rotation1 = shiftSlotsClockwise(l.slots, 7 - (l.currentRotation || 1));
          const order = ["P4", "P3", "P2", "P5", "P6", "P1"];
          const serverSlot = (l.servesFirst || "us") === "us" ? "P1" : "P2";
          return (
            <div key={l.id} className="playerguide-page-group">
              <div style={{ fontSize: 18, fontWeight: 700, textAlign: "center", marginBottom: 8 }}>{l.name}</div>
              <div style={{ textAlign: "center", fontSize: 10, letterSpacing: 3, color: "#888", marginBottom: 8 }}>
                — NET —
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
                {order.map((slot) => {
                  const p = playerFor(rotation1[slot]);
                  const isServer = slot === serverSlot;
                  return (
                    <div key={slot} style={{ border: "1.5px solid #000", borderRadius: 8, padding: "8px 5px", textAlign: "center", position: "relative" }}>
                      {isServer && (
                        <div style={{ position: "absolute", top: -9, left: "50%", transform: "translateX(-50%)", background: "#000", color: "#fff", fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 4, letterSpacing: 0.5, whiteSpace: "nowrap" }}>
                          1ST SERVER
                        </div>
                      )}
                      <div style={{ fontSize: 9, color: "#888", textAlign: "left" }}>{slot}</div>
                      <div style={{ fontSize: 15, fontWeight: 400, color: "#333" }}>#{jerseyFor(p, l?.liberos)}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>{displayName(p)}</div>
                      {p?.position && (
                        <div style={{ fontSize: 9, fontWeight: 700, border: "1px solid #999", borderRadius: 3, padding: "0 3px", display: "inline-block", marginTop: 2 }}>
                          {p.position}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, borderTop: "1px solid #ccc", paddingTop: 14, marginBottom: 10 }}>
                Substitution Guide
              </div>
              {(() => {
                // Ordered by when things actually happen during the match,
                // not by pairing — a player reads this the same way they'd
                // experience the set: "at rotation 2, this happens," then
                // "at rotation 4, this happens," and so on.
                const { transitions } = computeSubTransitions(l);
                const byRotation = {};
                Object.keys(transitions).forEach((key) => {
                  const [r] = key.split("-");
                  if (!byRotation[r]) byRotation[r] = [];
                  byRotation[r].push(transitions[key]);
                });
                const rotationNumbers = Object.keys(byRotation)
                  .map(Number)
                  .sort((a, b) => a - b);
                return rotationNumbers.map((r) => (
                  <div key={r} style={{ border: "1.5px solid #000", borderRadius: 10, padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>
                      Rotation {r}
                    </div>
                    {byRotation[r].map((t, idx) => {
                      const entering = playerFor(t.entering);
                      const leaving = playerFor(t.leaving);
                      const isLib = (l.liberos || []).includes(t.entering);
                      return (
                        <div key={idx} style={{ fontSize: 16, marginBottom: 3 }}>
                          <b>{displayName(entering)}</b> <span style={{ fontWeight: 400, color: "#333" }}>#{jerseyFor(entering, l?.liberos)}</span>
                          {" in for "}
                          <b>{displayName(leaving)}</b> <span style={{ fontWeight: 400, color: "#333" }}>#{jerseyFor(leaving, l?.liberos)}</span>
                          {isLib && (
                            <span style={{ fontSize: 11, fontWeight: 700, border: "1px solid #000", borderRadius: 4, padding: "1px 6px", marginLeft: 6 }}>
                              LIBERO
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
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
});

// ---- Team Gate: shown once, before any team data loads, on any device
// that hasn't been linked to a team yet ----
function TeamGate({ onLinked, initialJoinCode, initialJoinError }) {
  const [mode, setMode] = useState(initialJoinCode ? "join" : "choice"); // "choice" | "create" | "join"
  const [codeInput, setCodeInput] = useState(() => generateTeamCode());
  const [joinInput, setJoinInput] = useState(initialJoinCode || "");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [codeTaken, setCodeTaken] = useState(false);
  const [createError, setCreateError] = useState("");
  const [joinError, setJoinError] = useState(initialJoinError || "");

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
    background: COLORS.accentSoft,
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
  const normalizeCode = normalizeTeamCode;

  const checkAndCreate = async () => {
    const code = codeInput.trim();
    if (!code) return;
    setChecking(true);
    setCreateError("");
    setCodeTaken(false);
    // Same defensive pattern as the print feature's safety net — a single
    // network check is much less likely to get stuck than a multi-page PDF
    // capture, but there's no real cost to guarding against it the same way.
    const forceCleanupTimer = setTimeout(() => setChecking(false), 15000);
    try {
      const ref = doc(db, "teams", code, "data", "main");
      const snap = await getDoc(ref);
      if (snap.exists()) {
        setCodeTaken(true);
        return;
      }
      onLinked(code, "coach");
    } catch (err) {
      setCreateError("Couldn't check that code — check your connection and try again.");
    } finally {
      clearTimeout(forceCleanupTimer);
      setChecking(false);
    }
  };

  // Join has to verify the team actually exists first — otherwise a typo'd
  // code would silently start a brand-new blank team instead of telling the
  // coach it couldn't find the one they meant to join.
  //
  // This one box takes EITHER code (see teamAccess.js). A team code links the
  // device with full access; an assistant code links it to the same team with
  // only what the coach allows. The code is the mode — there is no switch on
  // the device afterwards, which is what lets a helper set their own device
  // up without the coach ever touching it.
  const checkAndJoin = async () => {
    const code = normalizeCode(joinInput);
    if (!code) return;
    setChecking(true);
    setJoinError("");
    const forceCleanupTimer = setTimeout(() => setChecking(false), 15000);
    try {
      const snap = await getDoc(doc(db, "teams", code, "data", "main"));
      if (snap.exists()) {
        onLinked(code, "coach");
        return;
      }
      // Not a team code. Before calling it a typo, see whether it's an
      // assistant code — they're issued from a different alphabet-sharing
      // pool and resolved through their own top-level collection.
      const asst = await getDoc(doc(db, "assistantAccess", code));
      const linkedTeam = asst.exists() ? asst.data()?.teamCode : null;
      if (linkedTeam) {
        // The team the code points at can be deleted or re-made; don't link a
        // device to a team that isn't there.
        const teamSnap = await getDoc(doc(db, "teams", linkedTeam, "data", "main"));
        // And the code has to be the team's CURRENT one. Replacing a code
        // writes the new `assistantAccess` document before deleting the old,
        // so a failed delete (no signal, a closed tab) leaves a stale one
        // pointing at a live team. Without this check a device could join on
        // that stale code and then be evicted a second later by the mismatch
        // check in AppInner — a confusing flicker that looks like a bug and
        // quietly undoes a revoke. Accept only the live code.
        if (teamSnap.exists() && teamSnap.data()?.assistantCode === code) {
          onLinked(linkedTeam, "assistant", code);
          return;
        }
      }
      setJoinError("No team found with that code — double-check it and try again.");
    } catch (err) {
      setJoinError("Couldn't check that code — check your connection and try again.");
    } finally {
      clearTimeout(forceCleanupTimer);
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
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS[s.colorKey], marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 12, color: COLORS.chalkDim, lineHeight: 1.4 }}>
              {STAT_DEFINITIONS[s.key]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Captain vote sheet — pass-the-device ballot for picking a captain.
// Coach sets the candidates once, then hands the phone around: each player
// taps up to two names and submits, which immediately blanks the ballot for
// the next player (no visible running tally, no way to see who anyone else
// picked).
// The results view sits behind the same app passcode, hidden behind a small
// unlabeled dot in the corner rather than a real "Tabulate" button, so it
// isn't something a player passing the device along could stumble into.
function CaptainVoteSheet({ onClose, roster, captainVote, setCaptainVote }) {
  const [step, setStep] = useState(captainVote.candidateIds.length ? "vote" : "setup");
  const [pickIds, setPickIds] = useState(captainVote.candidateIds);
  const [selectedIds, setSelectedIds] = useState([]);
  const [justVoted, setJustVoted] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState(false);
  const [tallyOpen, setTallyOpen] = useState(false);

  const candidates = roster.filter((p) => captainVote.candidateIds.includes(p.id));

  // Each ballot is an OBJECT wrapping up to VOTES_PER_BALLOT candidate ids:
  // { picks: [id, id] }. The wrapper is not cosmetic — Firestore rejects
  // nested arrays outright, so `ballots` cannot be an array of arrays. It
  // was, briefly, and the resulting setDoc error failed every write to the
  // whole main doc, not just the vote. An array of maps is fine, and a map
  // may contain an array, so this shape is legal. Don't flatten it back.
  //
  // Ballots cast before multi-pick voting are a bare id, so reads go
  // through this — an election already part-way through when the app
  // updates still tallies instead of counting those as zero. The bare-array
  // case is handled too, purely to cope with state left over in a session
  // that ran the broken build before reloading.
  const ballotPicks = (b) => {
    if (b == null) return [];
    if (Array.isArray(b)) return b;
    if (typeof b === "object") return Array.isArray(b.picks) ? b.picks : [];
    return [b];
  };

  const startElection = () => {
    if (pickIds.length < 2) return;
    setCaptainVote({ candidateIds: pickIds, ballots: [] });
    setStep("vote");
  };

  // Toggling past the limit is a no-op rather than silently dropping an
  // earlier pick — a player passing the device should never have a choice
  // they made disappear without tapping it off themselves.
  const togglePick = (id) =>
    setSelectedIds((cur) =>
      cur.includes(id)
        ? cur.filter((x) => x !== id)
        : cur.length >= VOTES_PER_BALLOT
        ? cur
        : [...cur, id]
    );

  const submitVote = () => {
    if (selectedIds.length === 0) return;
    setCaptainVote((prev) => ({ ...prev, ballots: [...prev.ballots, { picks: selectedIds }] }));
    setSelectedIds([]);
    setJustVoted(true);
    setTimeout(() => setJustVoted(false), 1200);
  };

  const openResults = () => {
    if (APP_PASSCODE.trim() === "") {
      setTallyOpen(true);
    } else {
      setShowUnlock(true);
    }
  };

  const tryUnlockTally = () => {
    if (unlockInput === APP_PASSCODE) {
      setUnlockInput("");
      setUnlockError(false);
      setShowUnlock(false);
      setTallyOpen(true);
    } else {
      setUnlockError(true);
    }
  };

  // Both of these used to ask via window.confirm. This sheet is handed
  // around a locker room on the installed PWA, which is the worst possible
  // place for a native dialog that can silently fail to render — see
  // ConfirmButton. They're two-tap in-app confirms now.
  const resetVotes = () => {
    setCaptainVote((prev) => ({ ...prev, ballots: [] }));
    setTallyOpen(false);
  };

  const newElection = () => {
    setCaptainVote({ candidateIds: [], ballots: [] });
    setPickIds([]);
    setTallyOpen(false);
    setStep("setup");
  };

  const tally = useMemo(() => {
    const counts = {};
    captainVote.ballots.forEach((b) => {
      ballotPicks(b).forEach((id) => {
        counts[id] = (counts[id] || 0) + 1;
      });
    });
    return candidates.map((p) => ({ player: p, votes: counts[p.id] || 0 })).sort((a, b) => b.votes - a.votes);
  }, [candidates, captainVote.ballots]);

  const totalVotesCast = captainVote.ballots.reduce((n, b) => n + ballotPicks(b).length, 0);

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
          position: "relative",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, textTransform: "uppercase" }}>
            Captain Vote
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.chalkDim }}>
            <X size={20} />
          </button>
        </div>

        {step === "setup" && (
          <>
            <div style={{ fontSize: 12, color: COLORS.chalkDim, marginBottom: 10 }}>
              Pick who's on the ballot (at least 2), then hand the device to the first player.
            </div>
            {roster.map((p) => {
              const checked = pickIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => setPickIds((cur) => (checked ? cur.filter((id) => id !== p.id) : [...cur, p.id]))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "10px 4px",
                    background: "none",
                    border: "none",
                    borderBottom: `1px solid ${COLORS.line}`,
                    color: COLORS.chalk,
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `1.5px solid ${checked ? COLORS.orange : COLORS.line}`,
                      background: checked ? COLORS.orange : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {checked && <Check size={12} color={COLORS.bg} />}
                  </span>
                  <span style={{ fontSize: 13 }}>
                    #{p.num} {displayName(p)}
                  </span>
                </button>
              );
            })}
            <button
              onClick={startElection}
              disabled={pickIds.length < 2}
              style={{
                width: "100%",
                marginTop: 14,
                padding: "12px",
                borderRadius: 8,
                border: "none",
                background: pickIds.length < 2 ? COLORS.line : COLORS.orange,
                color: "#1C2128",
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              Start Voting ({pickIds.length} candidate{pickIds.length === 1 ? "" : "s"})
            </button>
          </>
        )}

        {step === "vote" && !tallyOpen && (
          <>
            {justVoted ? (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.green, marginBottom: 6 }}>
                  Vote submitted
                </div>
                <div style={{ fontSize: 12, color: COLORS.chalkDim }}>Pass the device to the next player.</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: COLORS.chalkDim, marginBottom: 4 }}>
                  Tap up to {VOTES_PER_BALLOT} picks for captain, then Submit.{" "}
                  {captainVote.ballots.length} ballot
                  {captainVote.ballots.length === 1 ? "" : "s"} cast so far.
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: selectedIds.length >= VOTES_PER_BALLOT ? COLORS.gold : COLORS.chalkDim,
                    marginBottom: 10,
                  }}
                >
                  {selectedIds.length} of {VOTES_PER_BALLOT} selected
                  {selectedIds.length >= VOTES_PER_BALLOT
                    ? " — tap one off to change it"
                    : selectedIds.length === 0
                    ? ""
                    : " — one more if you want it"}
                </div>
                {candidates.map((p) => {
                  const picked = selectedIds.includes(p.id);
                  const atLimit = !picked && selectedIds.length >= VOTES_PER_BALLOT;
                  return (
                  <button
                    key={p.id}
                    onClick={() => togglePick(p.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      textAlign: "left",
                      padding: "14px 12px",
                      marginBottom: 8,
                      borderRadius: 10,
                      border: `1.5px solid ${picked ? COLORS.orange : COLORS.line}`,
                      background: picked ? COLORS.accentSoft : "transparent",
                      color: COLORS.chalk,
                      fontSize: 14,
                      fontWeight: 600,
                      opacity: atLimit ? 0.45 : 1,
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: `1.5px solid ${picked ? COLORS.orange : COLORS.line}`,
                        background: picked ? COLORS.orange : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {picked && <Check size={12} color={COLORS.bg} />}
                    </span>
                    #{p.num} {displayName(p)}
                  </button>
                  );
                })}
                <button
                  onClick={submitVote}
                  disabled={selectedIds.length === 0}
                  style={{
                    width: "100%",
                    marginTop: 8,
                    padding: "12px",
                    borderRadius: 8,
                    border: "none",
                    background: selectedIds.length ? COLORS.orange : COLORS.line,
                    color: "#1C2128",
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  Submit {selectedIds.length === VOTES_PER_BALLOT ? "Votes" : "Vote"}
                </button>
              </>
            )}
            <button
              onClick={openResults}
              title="Results"
              style={{
                position: "absolute",
                bottom: 2,
                right: 6,
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                color: COLORS.chalkDim,
                fontSize: 10,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `1px solid ${COLORS.line}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: 0.5,
                }}
              >
                •••
              </span>
            </button>
          </>
        )}

        {tallyOpen && (
          <>
            <div style={{ fontSize: 12, color: COLORS.chalkDim, marginBottom: 12 }}>
              {captainVote.ballots.length} ballot{captainVote.ballots.length === 1 ? "" : "s"} ·{" "}
              {totalVotesCast} vote{totalVotesCast === 1 ? "" : "s"} (up to {VOTES_PER_BALLOT} per
              player).
            </div>
            {tally.map(({ player, votes }) => (
              <div
                key={player.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 4px",
                  borderBottom: `1px solid ${COLORS.line}`,
                }}
              >
                <span style={{ fontSize: 14, color: COLORS.chalk }}>
                  #{player.num} {displayName(player)}
                </span>
                <span style={{ fontSize: 16, fontWeight: 700, color: COLORS.orange }}>{votes}</span>
              </div>
            ))}
            <button
              onClick={() => setTallyOpen(false)}
              style={{
                width: "100%",
                marginTop: 14,
                padding: "11px",
                borderRadius: 8,
                border: `1px solid ${COLORS.line}`,
                background: "none",
                color: COLORS.chalk,
                fontSize: 13,
              }}
            >
              Back to Voting
            </button>
            <ConfirmButton
              label="Reset Votes (keep candidates)"
              confirmLabel="Tap again to clear every vote"
              onConfirm={resetVotes}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "11px",
                borderRadius: 8,
                border: `1px solid ${COLORS.red}`,
                background: "none",
                color: COLORS.red,
                fontSize: 13,
              }}
              armedStyle={{ background: COLORS.redSoft, fontWeight: 700 }}
            />
            <ConfirmButton
              label="Start a New Election"
              confirmLabel="Tap again to clear candidates and votes"
              onConfirm={newElection}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "11px",
                borderRadius: 8,
                border: "none",
                background: "none",
                color: COLORS.chalkDim,
                fontSize: 12,
              }}
              armedStyle={{ color: COLORS.red, fontWeight: 700 }}
            />
          </>
        )}

        {showUnlock && (
          <div
            onClick={() => {
              setShowUnlock(false);
              setUnlockInput("");
              setUnlockError(false);
            }}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "20px 20px 0 0",
            }}
          >
            <div onClick={(e) => e.stopPropagation()} style={{ width: 220, textAlign: "center" }}>
              <div style={{ fontSize: 13, color: COLORS.chalk, marginBottom: 10 }}>
                Enter passcode to view results
              </div>
              <input
                type="password"
                autoFocus
                value={unlockInput}
                onChange={(e) => {
                  setUnlockInput(e.target.value);
                  setUnlockError(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && tryUnlockTally()}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  marginBottom: 8,
                  background: COLORS.bg,
                  border: `1.5px solid ${unlockError ? COLORS.red : COLORS.line}`,
                  borderRadius: 8,
                  color: COLORS.chalk,
                  fontSize: 14,
                  textAlign: "center",
                }}
              />
              {unlockError && (
                <div style={{ color: COLORS.red, fontSize: 11, marginBottom: 8 }}>Wrong passcode.</div>
              )}
              <button
                onClick={tryUnlockTally}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: 8,
                  border: "none",
                  background: COLORS.orange,
                  color: "#1C2128",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                View Results
              </button>
            </div>
          </div>
        )}
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
  printStatKeys,
  setPrintStatKeys,
  trackStatKeys,
  setTrackStatKeys,
  teamCode,
  setTeamCode,
  setUnlockedWith,
  exportAllData,
  onUnlinkDevice,
  restoreFromBackup,
  restoreReport,
  orphanedMatches,
  recoverOrphanedMatch,
  unassignedEntries,
  assignUnassignedTo,
  assignReport,
  matches,
  playerCodes,
  playerAccessStyle,
  issuePlayerCodes,
  publishPlayerStats,
  revokePlayerAccess,
  publishReport,
  entitlements,
  roster,
  mergePlayers,
  mergeReport,
  assistantMode,
  assistantCanScore,
  assistantAccess,
  setAssistantAccess,
  assistantCode,
  issueAssistantCode,
  revokeAssistantCode,
  assistantCodeError,
}) {
  const [statListMode, setStatListMode] = useState("track"); // "track" | "print"
  const [mergeKeepId, setMergeKeepId] = useState("");
  const [mergeDropId, setMergeDropId] = useState("");
  const [mergeAsLibero, setMergeAsLibero] = useState(true);
  // Read once when Settings opens — the log only changes on a crash, which
  // takes the whole app down anyway, so there's nothing to keep in sync.
  const restoreFileRef = useRef(null);
  const [crashes, setCrashes] = useState(() => readCrashLog());
  const [copiedCrashes, setCopiedCrashes] = useState(false);
  // Which player's invite was just put on the clipboard, so the row can say
  // so. One field, not a per-row flag: only ever one is the latest.
  const [invite, setInvite] = useState(null); // { code, state: "sent"|"copied"|"failed" }

  // Hand the player's message to the share sheet when there is one — that is
  // one tap to Messages — and fall back to the clipboard when there isn't,
  // or when the share is refused for any reason other than the coach backing
  // out of it. A cancelled share must read as nothing happening, not as a
  // failure. Anything that throws here still has to leave a visible result:
  // a button that silently does nothing is the "dead tap" this app has been
  // bitten by before.
  const shareInvite = async (player, code) => {
    const text = playerInviteMessage({ player, code, url: PLAYER_STATS_URL });
    if (navigator.share) {
      try {
        await navigator.share({ text });
        setInvite({ code, state: "sent" });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return; // he backed out; say nothing
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setInvite({ code, state: "copied" });
    } catch (err) {
      setInvite({ code, state: "failed" });
    }
  };
  // `key` is passed because this is rendered from inside STAT_BUTTONS.map —
  // without it React logs a keyless-list warning for every stat, which both
  // costs reconciliation and buries any real warning in the console.
  const checkboxRow = (checked, onToggle, label, key) => (
    <button
      key={key}
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

  // Same shape as actionBtn, for the ConfirmButtons that sit beside those
  // buttons in this sheet's single column.
  const confirmBtnStyle = {
    width: "100%",
    padding: "9px",
    marginBottom: 8,
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    background: "none",
    color: COLORS.chalk,
    fontSize: 12,
    fontWeight: 700,
  };

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
                background: theme === t ? COLORS.accentSoft : "transparent",
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

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
          Stats
        </div>
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8, lineHeight: 1.45 }}>
          {statListMode === "track"
            ? "Which stat buttons show on the Live screen. Unchecking one only hides its button — nothing already recorded is deleted, and re-checking brings it back."
            : "Which columns show on printed box scores. Independent of what you track, so you can record something for yourself and leave it off the sheet."}
        </div>
        {/* Two separate lists, one at a time: what you record during a match
            and what you put on a printed sheet are different decisions. */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[
            { key: "track", label: "Track" },
            { key: "print", label: "Print" },
          ].map((m) => {
            const on = statListMode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setStatListMode(m.key)}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  borderRadius: 8,
                  border: `1.5px solid ${on ? COLORS.orange : COLORS.line}`,
                  background: on ? COLORS.accentSoft : "none",
                  color: on ? COLORS.orange : COLORS.chalkDim,
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <div style={{ marginBottom: 18 }}>
          {STAT_BUTTONS.map((s) => {
            const isTrack = statListMode === "track";
            const activeKeys = isTrack ? trackStatKeys : printStatKeys;
            const setActiveKeys = isTrack ? setTrackStatKeys : setPrintStatKeys;
            const checked = (activeKeys || []).includes(s.key);
            // Printing a stat you don't track gives you a column that's
            // always empty — worth flagging rather than silently allowing.
            const untracked =
              !isTrack && checked && !(trackStatKeys || []).includes(s.key);
            return checkboxRow(
              checked,
              () =>
                setActiveKeys((prev) => {
                  const current = prev || STAT_BUTTONS.map((b) => b.key);
                  return checked ? current.filter((k) => k !== s.key) : [...current, s.key];
                }),
              untracked ? `${s.label} — not tracked, will print empty` : s.label,
              s.key
            );
          })}
        </div>

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Assistant Device
        </div>
        {assistantMode ? (
          <div style={{ fontSize: 11, color: COLORS.chalk, background: COLORS.goldSoft, border: `1px solid ${COLORS.gold}`, borderRadius: 8, padding: "9px 10px", marginBottom: 10, lineHeight: 1.45 }}>
            <b>This device joined with an assistant code.</b> It can record stats
            {assistantCanScore ? " and work the scoreboard" : ""}, and the tabs your
            coach allowed are read-only. There's nothing to switch off here — the
            code this device joined with is what sets this. To give it full access,
            join again with the team code.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10, lineHeight: 1.45 }}>
              For a second device — an assistant coach or a parent keeping stats
              during a match. Give them the <b>assistant code</b> instead of your
              team code: they open the app, type it where they'd type a team code,
              and their device lands on your team with only what you allow below.
              You never have to touch their phone, and they can't reach the rest of
              the app because they don't have the team code.
            </div>
            {assistantCode ? (
              <>
                <div style={{ textAlign: "center", padding: "10px 8px", marginBottom: 8, background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                    Assistant code
                  </div>
                  <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 24, letterSpacing: 2, color: COLORS.orange }}>
                    {assistantCode}
                  </div>
                </div>
                {actionBtn(() => {
                  try {
                    navigator.clipboard?.writeText(assistantCode);
                  } catch (err) {
                    /* a refused clipboard is not worth an error banner — the
                       code is on screen to read out either way */
                  }
                }, "Copy Code")}
                {/* ConfirmButton takes `style`/`armedStyle`, not a colour —
                    matching actionBtn's shape so these two sit in the column
                    with every other button on this sheet. */}
                <ConfirmButton
                  onConfirm={issueAssistantCode}
                  label="Replace Code"
                  confirmLabel="Tap again — the old code stops working"
                  style={confirmBtnStyle}
                  armedStyle={{ border: `1px solid ${COLORS.gold}`, background: COLORS.goldSoft }}
                />
                <ConfirmButton
                  onConfirm={revokeAssistantCode}
                  label="Turn Off Assistant Access"
                  confirmLabel="Tap again — signs every helper out"
                  style={confirmBtnStyle}
                  armedStyle={{ border: `1px solid ${COLORS.red}`, background: COLORS.redSoft }}
                />
                <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "4px 0 12px", lineHeight: 1.45 }}>
                  Either one signs out every device that joined with this code, back
                  to the join screen, next time it has signal. Replacing hands you a
                  new code to give out; turning it off leaves none.
                </div>
              </>
            ) : (
              <>
                {actionBtn(issueAssistantCode, "Create Assistant Code", {
                  border: `1px solid ${COLORS.gold}`,
                  background: COLORS.goldSoft,
                })}
                <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "4px 0 12px" }}>
                  Nobody can join as an assistant until you create one.
                </div>
              </>
            )}
            {assistantCodeError && (
              <div style={{ fontSize: 11, color: COLORS.red, marginBottom: 10 }}>{assistantCodeError}</div>
            )}

            <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              What an assistant device can see
            </div>
            {ASSISTANT_TABS.map((t) =>
              checkboxRow(
                t.locked || assistantAccess.tabs.includes(t.key),
                () => {
                  if (t.locked) return;
                  const on = assistantAccess.tabs.includes(t.key);
                  const next = on
                    ? assistantAccess.tabs.filter((k) => k !== t.key)
                    : [...assistantAccess.tabs, t.key];
                  setAssistantAccess({ ...assistantAccess, tabs: next });
                },
                t.locked ? `${t.label} — always on` : t.label,
                t.key
              )
            )}
            {checkboxRow(
              assistantCanScore,
              () => setAssistantAccess({ ...assistantAccess, canScore: !assistantCanScore }),
              "May also work the scoreboard",
              "canScore"
            )}
            <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "4px 0 12px", lineHeight: 1.45 }}>
              A tab an assistant can see is still read-only — they can record stats,
              and nothing else they do is written to the team. Change any of this
              from here and their device follows, no re-joining needed.
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 12, lineHeight: 1.45 }}>
              Be clear-eyed about what this is: guard rails against a stray tap, not
              a lock. Anyone who learns the team code has the whole app.
            </div>
          </>
        )}

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
          Team
        </div>
        {/* An assistant device must never display the team code — that code is
            the whole app, and this screen is on a phone the coach doesn't
            hold. It joined with an assistant code and shows that instead. */}
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
          {assistantMode ? (
            <>Joined as an assistant device.</>
          ) : (
            <>Team code: <b style={{ color: COLORS.chalk }}>{teamCode}</b></>
          )}
        </div>
        {actionBtn(() => setUnlockedWith(""), "Lock This Device Now")}
        {/* Available on an assistant device too, and it has to be: joining
            again with the team code is the ONLY way to give this device full
            access, now that there's no assistant switch to turn off. Safe
            either way — it lands on the join screen, which needs a code. */}
        {actionBtn(() => {
          if (window.confirm("Unlink this device from its current team? You'll be asked to create or join a team again.")) {
            onUnlinkDevice();
          }
        }, "Switch Team")}
        {/* Not on an assistant device: this link carries the team code in a
            URL, which would hand over the thing the assistant code exists to
            withhold — and land them in Player Eval, which writes the roster. */}
        {PLAYER_EVAL_URL && !assistantMode &&
          actionBtn(
            () => window.open(`${PLAYER_EVAL_URL}?code=${encodeURIComponent(teamCode)}`, "_blank", "noopener,noreferrer"),
            "Open Player Eval ↗",
            { border: `1px solid ${COLORS.orange}`, background: COLORS.accentSoft }
          )}
        {/* NOT on an assistant device, and this is the one that matters most
            on this screen. The backup is the whole team in a file a helper
            could keep: the TEAM CODE (in the JSON and in the filename), every
            player's stats access code, the assistant code, the roster, the
            lineups, the lot. Read-only tabs were never the point — a device
            that can read everything can also save everything. Restore was
            already gated; Export was not, which was the gap.
            Found in the audit on 2026-10-18, not by anyone using it. */}
        {!assistantMode &&
          actionBtn(exportAllData, "Export All Data (Backup)", {
            border: `1px solid ${COLORS.blue}`,
            background: COLORS.blueSoft,
          })}
        {!assistantMode && (
        <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "2px 0 8px" }}>
          Restoring replaces this team's roster, lineups, matches and stats with
          whatever is in the file. Use it to undo a bad sync or bring a device back
          to a known-good state.
        </div>
        )}
        {!assistantMode && (
        <ConfirmButton
          label="Restore From Backup…"
          confirmLabel="Tap again, then pick the backup file"
          onConfirm={() => restoreFileRef.current?.click()}
          style={{
            width: "100%",
            marginBottom: 8,
            padding: "10px",
            borderRadius: 8,
            border: `1px solid ${COLORS.red}`,
            background: "none",
            color: COLORS.chalk,
            fontSize: 13,
            fontWeight: 700,
          }}
          armedStyle={{ background: COLORS.redSoft, color: COLORS.red }}
        />
        )}
        <input
          ref={restoreFileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // let the same file be picked twice
            restoreFromBackup?.(f);
          }}
        />
        {restoreReport && (
          <div style={{ fontSize: 11, color: COLORS.chalk, background: COLORS.greenSoft, border: `1px solid ${COLORS.green}`, borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
            {restoreReport}
          </div>
        )}
        {!assistantMode && orphanedMatches && orphanedMatches.length > 0 && (
          <>
            <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
              Recover Deleted Matches
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
              These stats are still here, but the match they belong to was
              deleted from the schedule, so nothing can show them by match.
              Restoring rebuilds the match and relinks everything — then rename
              it on the Schedule screen. Set scores come back; the lineup that
              played can't be rebuilt.
            </div>
            {orphanedMatches.map((o) => (
              <div
                key={o.matchId}
                style={{
                  border: `1px solid ${COLORS.gold}`,
                  borderRadius: 8,
                  padding: "9px 10px",
                  marginBottom: 8,
                  background: COLORS.goldSoft,
                }}
              >
                <div style={{ fontSize: 12, color: COLORS.chalk, fontWeight: 700 }}>
                  {Number.isFinite(o.firstAt)
                    ? new Date(o.firstAt).toLocaleDateString()
                    : "Unknown date"}
                </div>
                <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
                  {o.stats} stat{o.stats === 1 ? "" : "s"}
                  {o.points ? ` · ${o.points} point${o.points === 1 ? "" : "s"}` : ""}
                  {o.sets.length ? ` · set${o.sets.length === 1 ? "" : "s"} ${o.sets.join(", ")}` : ""}
                </div>
                {actionBtn(() => recoverOrphanedMatch(o), "Restore This Match", {
                  border: `1px solid ${COLORS.green}`,
                  background: COLORS.greenSoft,
                })}
              </div>
            ))}
          </>
        )}

        {/* Shown while anything is still stranded, and for one more render
            after the last group is attached so the confirmation has somewhere
            to live — otherwise the section vanishes the instant you tap and
            the only feedback goes with it. */}
        {!assistantMode && ((unassignedEntries && unassignedEntries.length > 0) || assignReport) && (
          <>
            <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
              Stats Not Attached To A Match
            </div>
            {unassignedEntries && unassignedEntries.length > 0 ? (
              <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
                These were recorded while no match was selected on the Live
                screen. They count in Season to Date, but no box score can show
                them until they're attached to a match. Pick the match each day
                belongs to — the set scores are rebuilt from the point log at the
                same time.
              </div>
            ) : null}
            {assignReport ? (
              <div style={{ fontSize: 11, color: COLORS.green, marginBottom: 10 }}>
                {assignReport} They'll show in that match's box score now.
              </div>
            ) : null}
            {unassignedEntries.map((g) => (
              <UnassignedGroupRow
                key={g.key}
                group={g}
                matches={matches}
                onAssign={(matchId) => assignUnassignedTo(g, matchId)}
              />
            ))}
          </>
        )}

        {!assistantMode && entitlements?.playerAccess && (
          <>
            <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
              Player Access
            </div>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10, lineHeight: 1.5 }}>
              Players look up their own stats at <b>{PLAYER_STATS_URL.replace(/^https:\/\//, "")}</b> by
              typing their code. Each code opens that player's numbers and the
              team totals — never the roster, the schedule, or anyone else's
              line. Nothing appears until you publish, so a half-finished match
              stays private.
            </div>

            <div style={{ fontSize: 10, color: COLORS.chalkDim, marginBottom: 6 }}>CODE STYLE</div>
            {CODE_STYLES.map((style) => {
              const on = playerAccessStyle === style;
              const note = CODE_STYLE_NOTES[style];
              return (
                <button
                  key={style}
                  onClick={() => issuePlayerCodes(style)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 10px",
                    marginBottom: 6,
                    borderRadius: 8,
                    border: `1.5px solid ${on ? COLORS.orange : COLORS.line}`,
                    background: on ? COLORS.accentSoft : "transparent",
                    color: COLORS.chalk,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{note.label}</div>
                  <div style={{ fontSize: 10.5, color: COLORS.chalkDim, marginTop: 2, lineHeight: 1.4 }}>{note.detail}</div>
                </button>
              );
            })}
            {playerAccessStyle === "jersey" ? (
              <div style={{ fontSize: 10.5, color: COLORS.gold, border: `1px solid ${COLORS.gold}`, background: COLORS.goldSoft, borderRadius: 8, padding: "8px 10px", marginBottom: 10, lineHeight: 1.45 }}>
                Heads up: jersey + initials can be worked out from the roster, so
                any player can open a team-mate's stats. Fine if you don't mind
                the team seeing each other's numbers — use one of the other two
                if you do.
              </div>
            ) : null}

            {playerCodes.length > 0 && (
              <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
                {playerCodes.map((c) => {
                  const p = roster.find((r) => r.id === c.playerId);
                  if (!p) return null;
                  const mine = invite && invite.code === c.code ? invite.state : null;
                  return (
                    <div key={c.code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12 }}>
                      <span style={{ color: COLORS.chalkDim, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        #{jerseyLabel(p)} {fullName(p)}
                      </span>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, letterSpacing: 1 }}>{c.code}</span>
                      <button
                        onClick={() => shareInvite(p, c.code)}
                        style={{
                          flexShrink: 0,
                          padding: "3px 8px",
                          borderRadius: 6,
                          border: `1px solid ${mine === "failed" ? COLORS.red : COLORS.line}`,
                          background: mine && mine !== "failed" ? COLORS.greenSoft : "transparent",
                          color: mine === "failed" ? COLORS.red : COLORS.chalk,
                          fontSize: 10.5,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {mine === "sent" ? "Sent" : mine === "copied" ? "Copied" : mine === "failed" ? "Failed" : navigator.share ? "Send" : "Copy"}
                      </button>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: COLORS.chalkDim, paddingTop: 4, lineHeight: 1.4 }}>
                  {navigator.share ? "Send" : "Copy"} writes that player's own message — the
                  link, her code, and what she'll see. Each code opens one card, so send
                  them one at a time rather than posting the list to a team chat.
                </div>
              </div>
            )}

            {publishReport ? (
              <div style={{ fontSize: 11, color: /^Could not/.test(publishReport) ? COLORS.red : COLORS.green, marginBottom: 8 }}>
                {publishReport}
              </div>
            ) : null}

            {actionBtn(publishPlayerStats, playerCodes.length ? "Publish Stats For Players" : "Create Codes & Publish", {
              border: `1px solid ${COLORS.green}`,
              background: COLORS.greenSoft,
            })}
            {playerCodes.length > 0 && (
              <ConfirmButton
                label="Revoke All Player Access"
                confirmLabel="Tap again — every code stops working"
                onConfirm={revokePlayerAccess}
                style={{
                  width: "100%",
                  padding: "10px",
                  marginTop: 6,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.red}`,
                  background: "transparent",
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                }}
                armedStyle={{ color: COLORS.red }}
              />
            )}
          </>
        )}

        {!assistantMode && (
        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
          Merge Duplicate Players
        </div>
        )}
        {!assistantMode && (
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
          For a player who ended up on the roster twice — usually a libero who
          also plays DS and wears a different jersey in each role. Merging folds
          her stats, ratings, lineups and sub record onto one player. Going
          forward, give her a Libero Jersey # on her player card instead of a
          second roster entry.
        </div>
        )}
        {!assistantMode && (() => {
          const opt = (p) => `#${p.num} ${displayName(p)}${p.position ? ` (${p.position})` : ""}`;
          const keep = roster.find((p) => String(p.id) === mergeKeepId);
          const drop = roster.find((p) => String(p.id) === mergeDropId);
          const same = mergeKeepId && mergeKeepId === mergeDropId;
          const ready = keep && drop && !same;
          const selStyle = {
            width: "100%",
            padding: "9px 10px",
            marginTop: 4,
            marginBottom: 10,
            background: COLORS.bg,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 8,
            color: COLORS.chalk,
            fontSize: 13,
          };
          return (
            <>
              <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
                Keep this entry
              </label>
              <select value={mergeKeepId} onChange={(e) => setMergeKeepId(e.target.value)} style={selStyle}>
                <option value="">Select player…</option>
                {roster.map((p) => (
                  <option key={p.id} value={p.id}>{opt(p)}</option>
                ))}
              </select>
              <label style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase" }}>
                Merge this one into it, then delete it
              </label>
              <select value={mergeDropId} onChange={(e) => setMergeDropId(e.target.value)} style={selStyle}>
                <option value="">Select player…</option>
                {roster.map((p) => (
                  <option key={p.id} value={p.id}>{opt(p)}</option>
                ))}
              </select>
              {same && (
                <div style={{ fontSize: 11, color: COLORS.red, marginBottom: 10 }}>
                  Those are the same entry — pick two different rows.
                </div>
              )}
              {ready && (
                <>
                  {checkboxRow(
                    mergeAsLibero,
                    () => setMergeAsLibero((v) => !v),
                    `#${drop.num} was her libero jersey — save it as ${displayName(keep)}'s Libero Jersey #`
                  )}
                  <div style={{ fontSize: 11, color: COLORS.chalkDim, margin: "6px 0 10px" }}>
                    She'll show as <b style={{ color: COLORS.chalk }}>#{keep.num}</b> normally
                    {mergeAsLibero ? <> and <b style={{ color: COLORS.chalk }}>#{drop.num}</b> in any set where she's in the LIBEROS row</> : null}.
                    This can't be undone from inside the app — export a backup first if you want a way back.
                  </div>
                  <ConfirmButton
                    label={`Merge #${drop.num} into #${keep.num}`}
                    confirmLabel="Tap again to merge"
                    onConfirm={() => {
                      mergePlayers(Number(mergeKeepId), Number(mergeDropId), mergeAsLibero);
                      setMergeKeepId("");
                      setMergeDropId("");
                    }}
                    style={{
                      width: "100%",
                      padding: "10px",
                      borderRadius: 8,
                      border: `1.5px solid ${COLORS.gold}`,
                      background: COLORS.goldSoft,
                      color: COLORS.chalk,
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                    armedStyle={{ color: COLORS.gold }}
                  />
                </>
              )}
            </>
          );
        })()}
        {mergeReport && !assistantMode && (
          <div style={{ fontSize: 11, color: COLORS.chalk, background: COLORS.greenSoft, border: `1px solid ${COLORS.green}`, borderRadius: 8, padding: "8px 10px", margin: "10px 0" }}>
            {mergeReport}
          </div>
        )}

        <div style={{ fontSize: 10, color: COLORS.chalkDim, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>
          Recent Errors
        </div>
        {crashes.length === 0 ? (
          <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 10 }}>
            None recorded on this device. If the app ever shows its error screen, what
            went wrong is saved here — you can hit Reload at the time and come back for
            the details afterwards.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
              Saved on this device only, newest first. Copy these when reporting a problem.
            </div>
            {crashes.map((c, i) => (
              <div
                key={i}
                style={{
                  border: `1px solid ${COLORS.line}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 6,
                  background: COLORS.bg,
                }}
              >
                <div style={{ fontSize: 10, color: COLORS.chalkDim }}>
                  {String(c.at || "").replace("T", " ").slice(0, 19)} · build {c.build}
                </div>
                <div style={{ fontSize: 11, color: COLORS.chalk, wordBreak: "break-word" }}>
                  {c.message}
                </div>
              </div>
            ))}
            {actionBtn(
              () => {
                const text = crashes
                  .map((c) =>
                    [
                      `When: ${c.at}`,
                      `Build: ${c.build}`,
                      `Error: ${c.message}`,
                      c.stack ? `Stack:\n${c.stack}` : "",
                      c.component ? `Component:\n${c.component}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n")
                  )
                  .join("\n\n----\n\n");
                try {
                  navigator.clipboard.writeText(text);
                  setCopiedCrashes(true);
                  setTimeout(() => setCopiedCrashes(false), 1500);
                } catch {
                  setCopiedCrashes(false);
                }
              },
              copiedCrashes ? "Copied" : "Copy Error Details",
              { border: `1px solid ${COLORS.blue}`, background: COLORS.blueSoft }
            )}
            {actionBtn(() => {
              clearCrashLog();
              setCrashes([]);
            }, "Clear Error Log")}
          </>
        )}

        <div style={{ textAlign: "center", fontSize: 10, color: COLORS.chalkDim, marginTop: 10 }}>
          Volley Bandit · Build {APP_VERSION}
        </div>
      </div>
    </div>
  );
}

// Registers the service-worker update check and surfaces it as in-app
// state instead of a native window.confirm() dialog. window.confirm/alert
// are documented as unreliable inside an installed, standalone-mode PWA on
// iOS — they can fail to actually display anything while still blocking
// the page's JS thread waiting for a response that will never come, which
// looks exactly like "the app is frozen/blank." A plain in-app banner has
// no such failure mode: it's just normal React state, and if the person
// never sees it (backgrounded tab), nothing blocks — the update simply
// applies the next time they naturally reopen the app fresh.
function useSWUpdate() {
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const updateRef = useRef(null);

  useEffect(() => {
    // Every one of these failure paths has to be swallowed. A service
    // worker update check is pure background housekeeping: it fetching
    // sw.js over a weak connection and failing means nothing to a coach
    // mid-match, and there is nothing for them to do about it.
    //
    // This is not hypothetical — it is the whole explanation for "the app
    // crashed on me again mid-match." `registration.update()` rejected on
    // gym wifi with no catch, so it became an unhandledrejection, and the
    // ErrorBoundary's window listener treated that as fatal and replaced
    // the live match screen with the crash page. Five entries in one
    // coach's crash log, all reading "Script .../sw.js load failed", spaced
    // ~32 minutes apart — the interval below, firing and failing.
    try {
      updateRef.current = registerSW({
        onRegisteredSW(swUrl, registration) {
          if (!registration) return;
          setInterval(() => {
            // Rejects whenever the network is unavailable or flaky. Normal.
            Promise.resolve(registration.update()).catch(() => {});
          }, 30 * 60 * 1000);
        },
        onNeedRefresh() {
          setNeedsRefresh(true);
        },
        onRegisterError() {
          // Couldn't register at all — the app still runs, just without
          // offline caching until the next load on a better connection.
        },
      });
    } catch {
      // registerSW itself threw (no service worker support, private mode).
    }
  }, []);

  // applyUpdate reloads via the service worker; if that rejects there's
  // nothing useful to tell anyone, and it must not bubble out as a crash.

  const applyUpdate = () => {
    try {
      Promise.resolve(updateRef.current?.(true)).catch(() => window.location.reload());
    } catch {
      window.location.reload();
    }
  };
  const dismiss = () => setNeedsRefresh(false);
  return { needsRefresh, applyUpdate, dismiss };
}

function AppInner() {
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

  // How this DEVICE got into the team, and therefore what it can do:
  // "coach" (joined with the team code) or "assistant" (joined with an
  // assistant code). Per-device, because it is a property of which code was
  // typed on this phone — what an assistant is *allowed* to do is the
  // coach's call and does sync, see `assistantAccess` below.
  //
  // THE CODE IS THE MODE. There is deliberately no switch to turn assistant
  // mode off: leaving it means joining again with the team code, which a
  // helper was never given. See teamAccess.js for why the old
  // tap-to-enable/passcode-to-leave arrangement was backwards.
  const [accessMode, setAccessMode] = usePersisted("vb-access-mode", "");
  // Devices that were put in assistant mode under the old per-device switch
  // stay assistants until they join again — dropping them to full access on
  // update is the one failure mode this must not have.
  const [legacyAssistant] = usePersisted("vb-assistant", false);
  // The assistant code this device joined with. Kept so that replacing the
  // code on the coach's phone actually kicks this device out — without it,
  // "revoke" would only stop NEW devices joining while every device already
  // set up carried on, which is not what that word means.
  const [accessCode, setAccessCode] = usePersisted("vb-access-code", "");
  const assistantMode = accessMode ? accessMode === "assistant" : !!legacyAssistant;
  const [assistantNotice, setAssistantNotice] = useState("");
  useEffect(() => {
    if (!assistantNotice) return;
    const t = setTimeout(() => setAssistantNotice(""), 4000);
    return () => clearTimeout(t);
  }, [assistantNotice]);

  // Which team's data this device is linked to — stays local per device on
  // purpose, since it's literally "which team is this device pointing at."
  // Everything the team code unlocks below is what actually syncs.
  const [teamCode, setTeamCode] = usePersisted("vb-team-code", "");

  // A `?code=GRF-4X29` deep link — e.g. the "Volley Bandit" link in the
  // companion Player Eval app's header — auto-joins that team instead of
  // making the coach retype a code they just came from. Only kicks in when
  // this device isn't already linked to a team. Declared before the
  // passcode-lock check below since hooks can't be called conditionally;
  // it still only takes effect once the coach is past that screen, since
  // this component doesn't render past the lock check until then anyway.
  // A `?code=` deep link always carries a TEAM code (it's generated from the
  // coach's own Settings), so a device that joins this way is a coach device.
  // It has to say so: without this, a phone that used to be an assistant and
  // was then unlinked still holds `vb-access-mode: "assistant"`, and joining
  // by link would leave it limited — silently defeating the one documented
  // way to hand a device full access. Found in the audit, not in use.
  const deepLink = useDeepLinkJoin(teamCode, (code) => {
    setAccessMode("coach");
    setAccessCode("");
    setTeamCode(code);
  });

  const MAIN_DEFAULT = {
    roster: [],
    captainIds: [],
    // Kept in step with captainIds[0] on every write — see setCaptainIds.
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
    subEntries: [], // per-set log of who went in for whom — see LiveScreen's partnerFor
    injuredPlayerIds: [],
    printStatKeys: STAT_BUTTONS.map((s) => s.key), // which stats show on printed box scores — defaults to all
    trackStatKeys: STAT_BUTTONS.map((s) => s.key), // which stat buttons show on the Live screen — defaults to all
    matches: [],
    activeMatchId: null,
    statsView: { section: "boxscore", insightsMatchId: null, boxMatchId: null },
    trendSubject: "team",
    teamName: "",
    teamAbbr: "", // short form for the live scoreboard — see scoreLabel
    coachName: "",
    includePairingsRoster: false,
    includePairingsLineup: false,
    roleSystem: { system: "5-1" },
    captainVote: { candidateIds: [], ballots: [] },
    // Whether devices in assistant mode may also work the scoreboard. Team
    // data, not per-device, so the coach sets it once from their own phone
    // rather than having to borrow the assistant's.
    assistantCanScore: false,
    // A code the coach sets and never shares, used ONLY to leave assistant
    // mode. It deliberately replaces APP_PASSCODE for that one check rather
    // than sitting alongside it: a helper running the app on their own phone
    // had to type APP_PASSCODE to get past the lock screen, so accepting it
    // here too would leave the gate opening to a code they already know.
    // Blank falls back to APP_PASSCODE, which is the pre-existing behavior.
    assistantCode: "",
    assistantAccess: null,
  };
  const LOGS_DEFAULT = { log: [], pointLog: [] };
  const BRANDING_DEFAULT = { teamLogo: null };

  const [mainDoc, setMainDocRaw, mainLoaded, mainError] = useTeamDoc(teamCode, "main", MAIN_DEFAULT);
  const [logsDoc, setLogsDoc, logsLoaded, logsError] = useTeamDoc(teamCode, "logs", LOGS_DEFAULT);
  const [brandingDoc, setBrandingDoc, brandingLoaded, brandingError] = useTeamDoc(teamCode, "branding", BRANDING_DEFAULT);
  // The two logs are collections now, one document per entry, so two
  // devices can record the same match at the same time — see
  // useTeamCollection. The `logs` document above still exists and is still
  // read: it holds whatever hasn't been migrated out of it yet.
  const [statEntries, statOps, statsLoaded, statsError] = useTeamCollection(teamCode, "stats");
  const [pointEntries, pointOps, pointsLoaded, pointsError] = useTeamCollection(teamCode, "points");
  const syncError = mainError || logsError || brandingError || statsError || pointsError;

  // What an assistant device may do, set by the coach and synced with the
  // team. `mainDoc.assistantCanScore` is the field this used to live in; a
  // team that ticked it before keeps it rather than silently losing it.
  const assistantAccess = assistantAccessOf(mainDoc);
  const assistantCanScore = assistantAccess.canScore || !!mainDoc.assistantCanScore;
  const allowedTabs = assistantMode ? orderTabs(assistantAccess.tabs) : null;
  const allowedTabsKey = allowedTabs ? allowedTabs.join(",") : "";

  // The open tab can stop being one this device is allowed — on first load
  // (`tab` starts at "roster"), or when the coach unticks a tab from their
  // own phone while the helper is standing on it.
  useEffect(() => {
    if (!allowedTabs || allowedTabs.includes(tab)) return;
    setTab(allowedTabs[0] || "live");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedTabsKey, tab]);

  // Replacing the assistant code evicts every device that joined with the
  // old one, back to the join screen. Gated on `mainLoaded` because an
  // unloaded document reads as the default (no code at all), and unlinking a
  // helper's device mid-match because their phone hadn't synced yet would be
  // far worse than the thing this is protecting against.
  useEffect(() => {
    if (accessMode !== "assistant" || !accessCode || !mainLoaded) return;
    if ((mainDoc.assistantCode || "") === accessCode) return;
    setAccessMode("");
    setAccessCode("");
    setTeamCode("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessMode, accessCode, mainLoaded, mainDoc.assistantCode]);

  // Issue (or replace) the code a helper types in to join with limited
  // access. Replacing deletes the old one first, so a code already handed
  // out stops working rather than going quiet and reviving later — same rule
  // as revoking player access.
  const [assistantCodeError, setAssistantCodeError] = useState("");
  const issueAssistantCode = async () => {
    setAssistantCodeError("");
    try {
      const previous = mainDoc.assistantCode || "";
      let next = "";
      // A code is a global name — it has to resolve to a team with nothing
      // else to go on — so don't hand out one another team already holds.
      for (let i = 0; i < 20 && !next; i += 1) {
        const candidate = generateAssistantCode();
        const taken = await getDoc(doc(db, "assistantAccess", candidate));
        const isTeam = await getDoc(doc(db, "teams", candidate, "data", "main"));
        if (!taken.exists() && !isTeam.exists()) next = candidate;
      }
      if (!next) {
        setAssistantCodeError("Couldn't find a free code — try again.");
        return;
      }
      await setDoc(doc(db, "assistantAccess", next), {
        teamCode,
        createdAt: Date.now(),
      });
      if (previous) await deleteDoc(doc(db, "assistantAccess", previous));
      setMainDoc((prev) => ({ ...prev, assistantCode: next }));
    } catch (err) {
      setAssistantCodeError(`Couldn't create a code: ${err?.message || err}`);
    }
  };

  const revokeAssistantCode = async () => {
    setAssistantCodeError("");
    try {
      const previous = mainDoc.assistantCode || "";
      if (previous) await deleteDoc(doc(db, "assistantAccess", previous));
      setMainDoc((prev) => ({ ...prev, assistantCode: "" }));
    } catch (err) {
      setAssistantCodeError(`Couldn't revoke: ${err?.message || err}`);
    }
  };

  // THE safeguard for a second device taking stats during a match.
  //
  // Hiding buttons is how assistant mode *looks*, but hiding is only as
  // good as my memory of every control in a 10,000-line file. This is the
  // part that actually holds: in assistant mode every write to the team
  // document is filtered down to the fields a helper is legitimately
  // allowed to touch, so a control I missed — or one added later by a
  // session that never heard of assistant mode — still cannot delete a
  // player, rewrite a lineup or end a match.
  //
  // Stat entries aren't here because they don't live in this document; they
  // are their own collection (see useTeamCollection) and are exactly what
  // the helper is there to write.
  //
  // `next` is computed OUTSIDE the updater on purpose. React runs updaters
  // during render and requires them to be pure, so the `setAssistantNotice`
  // below would be the documented "setState inside a setState updater" bug
  // if it ran in there.
  const ASSISTANT_WRITABLE = ["statsView"];
  const setMainDoc = (updater) => {
    if (!assistantMode) return setMainDocRaw(updater);
    const prev = mainDoc;
    const next = typeof updater === "function" ? updater(prev) : updater;
    const allowed = new Set(ASSISTANT_WRITABLE);
    if (assistantCanScore) allowed.add("score");
    const touched = Object.keys(next).filter((k) => !Object.is(next[k], prev?.[k]));
    const kept = touched.filter((k) => allowed.has(k));
    const blocked = touched.filter((k) => !allowed.has(k));
    if (blocked.length > 0) {
      setAssistantNotice(
        blocked.includes("score")
          ? "This device can record stats but not the score — ask the coach to allow it in Settings."
          : "This device joined as an assistant — that change wasn't saved. It can record stats, and read the rest."
      );
    }
    if (kept.length === 0) return;
    setMainDocRaw((p) => {
      const merged = { ...p };
      kept.forEach((k) => {
        merged[k] = next[k];
      });
      return merged;
    });
  };

  // Small helper: makes `const setX = fieldSetter(setMainDoc, "x")` behave
  // exactly like the old per-field useState setters — including functional
  // updates like setX(prev => ...) — so every screen below needed zero changes.
  const fieldSetter = (setDocFn, key) => (updater) =>
    setDocFn((prev) => ({ ...prev, [key]: typeof updater === "function" ? updater(prev[key]) : updater }));

  const roster = mainDoc.roster;
  const setRoster = fieldSetter(setMainDoc, "roster");
  const captainIds = captainIdList(mainDoc);
  const setCaptainIds = (updater) =>
    setMainDoc((prev) => {
      const cur = captainIdList(prev);
      const next = typeof updater === "function" ? updater(cur) : updater;
      // `captainId` is written alongside so a device still running an older
      // build — or an older backup restored later — shows a captain rather
      // than none. It's a mirror of the first entry, never read by this build.
      return { ...prev, captainIds: next, captainId: next[0] ?? null };
    });
  const toggleCaptain = (id) =>
    setCaptainIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const captainVote = mainDoc.captainVote || { candidateIds: [], ballots: [] };
  const setCaptainVote = fieldSetter(setMainDoc, "captainVote");
  const [showCaptainVote, setShowCaptainVote] = useState(false);
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
  // Per-set record of each substitution: { playerId, forPlayerId, slot }. Used
  // only to remind the coach who a returning player originally went in for —
  // NFHS re-entry has to be for the same spot in the serving order. Reset with
  // subCount at every set boundary, since the rule is per set.
  const subEntries = mainDoc.subEntries || [];
  const setSubEntries = fieldSetter(setMainDoc, "subEntries");
  const injuredPlayerIds = mainDoc.injuredPlayerIds || [];
  const setInjuredPlayerIds = fieldSetter(setMainDoc, "injuredPlayerIds");
  const printStatKeys = mainDoc.printStatKeys || STAT_BUTTONS.map((s) => s.key);
  const setPrintStatKeys = fieldSetter(setMainDoc, "printStatKeys");
  // Separate from printStatKeys on purpose: what you record during a match
  // and what you put on a printed sheet are different decisions (track block
  // errors for yourself, leave them off the sheet you hand out).
  const trackStatKeys = mainDoc.trackStatKeys || STAT_BUTTONS.map((s) => s.key);
  const setTrackStatKeys = fieldSetter(setMainDoc, "trackStatKeys");
  const matches = mainDoc.matches;
  const setMatches = fieldSetter(setMainDoc, "matches");

  // Freeze the lineup a set was played with onto the match record, the first
  // time a stat is recorded in that set. Lineups are living templates reused
  // match to match, so without this the only per-match trace is a stat's
  // lineupId pointing at a template that has since been edited — go back to
  // a past match and the app shows you today's lineup, not the one that
  // actually played. Written once per set and never updated, so later edits
  // to the template can't reach it.
  //
  // Stored as an object keyed by set number rather than an array, and the
  // rotation-1 RAW slots rather than whatever is on court at the moment of
  // the first stat — that's the starting six, which is what a lineup record
  // means. (Raw, not computeRotationSlots: subs are layered on for display
  // only and must never be committed as real lineup data.)
  // Deliberately goes around the assistant-mode write guard: freezing the
  // starting six onto a match is purely additive, first-write-wins, and is
  // triggered by recording a stat — which is exactly what an assistant
  // device is for. Blocking it would silently cost the match its record of
  // who actually played whenever the helper is the one taking stats.
  const setMatchesUnguarded = fieldSetter(setMainDocRaw, "matches");
  const snapshotLineupForMatch = (matchId, setNumber, lineup) => {
    if (matchId == null || !lineup) return;
    setMatchesUnguarded((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const existing = m.lineupSnapshots || {};
        if (existing[setNumber]) return m; // first write wins
        return {
          ...m,
          lineupSnapshots: { ...existing, [setNumber]: buildLineupSnapshot(lineup, setNumber) },
        };
      })
    );
  };
  const activeMatchId = mainDoc.activeMatchId;
  const setActiveMatchId = fieldSetter(setMainDoc, "activeMatchId");
  const statsView = mainDoc.statsView;
  const setStatsView = fieldSetter(setMainDoc, "statsView");
  const trendSubject = mainDoc.trendSubject;
  const setTrendSubject = fieldSetter(setMainDoc, "trendSubject");
  const teamName = mainDoc.teamName;
  const setTeamName = fieldSetter(setMainDoc, "teamName");
  const teamAbbr = mainDoc.teamAbbr || "";
  const setTeamAbbr = fieldSetter(setMainDoc, "teamAbbr");
  const coachName = mainDoc.coachName;
  const setCoachName = fieldSetter(setMainDoc, "coachName");
  const includePairingsRoster = mainDoc.includePairingsRoster;
  const setIncludePairingsRoster = fieldSetter(setMainDoc, "includePairingsRoster");
  const includePairingsLineup = mainDoc.includePairingsLineup;
  const setIncludePairingsLineup = fieldSetter(setMainDoc, "includePairingsLineup");
  const roleSystem = mainDoc.roleSystem || { system: "5-1" };
  const setRoleSystem = fieldSetter(setMainDoc, "roleSystem");

  // Reads are the union of what's still in the legacy `logs` document and
  // what's in the collection, deduped by id, so the app is correct at every
  // point during (and before) the migration below rather than only after
  // it. Once the migration completes the legacy side is empty and this is
  // just the collection.
  const log = useMemo(() => mergeEntries(logsDoc.log, statEntries), [logsDoc.log, statEntries]);

  // Which matches have stats recorded against them — used by the Schedule
  // screen to warn before deleting one that carries a real record.
  const matchIdsWithStats = useMemo(
    () => new Set((log || []).map((e) => e.matchId).filter((id) => id != null)),
    [log]
  );

  const pointLog = useMemo(() => mergeEntries(logsDoc.pointLog, pointEntries), [logsDoc.pointLog, pointEntries]);

  // Drops entries from the legacy array half of a log. Only relevant in the
  // window before the migration finishes; returning `prev` unchanged when
  // nothing matched means useTeamDoc's reference diff sends no write at all.
  const pruneLegacy = (field, keep) =>
    setLogsDoc((prev) => {
      const arr = prev[field] || [];
      const next = arr.filter(keep);
      return next.length === arr.length ? prev : { ...prev, [field]: next };
    });

  // Every screen still calls `setLog(prev => ...)` / `setPointLog(...)` the
  // way it did when these were plain arrays in a document. That interface
  // is kept deliberately: the call sites express what changed perfectly
  // well (append one entry, filter one out), and translating the result
  // into per-document writes here means none of them had to learn about
  // collections. The diff is by id — entries the updater added get written
  // as documents, entries it dropped get deleted, and an entry whose object
  // reference moved gets rewritten.
  //
  // Note this is strictly SAFER than the array write it replaces, not just
  // equivalent: two of these firing in the same tick from the same `prev`
  // used to mean the second overwrote the first, because each rebuilt the
  // whole array. Now each one only touches its own entry's document.
  const makeEntrySetter = (current, ops, legacyField) => (updater) => {
    const prev = current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    const prevById = new Map(prev.map((e) => [String(e.id), e]));
    const nextById = new Map(next.map((e) => [String(e.id), e]));
    const written = next.filter((e) => e?.id != null && prevById.get(String(e.id)) !== e);
    const removedIds = prev.filter((e) => !nextById.has(String(e.id))).map((e) => e.id);
    if (written.length === 1) ops.put(written[0]);
    else if (written.length > 1) ops.putMany(written);
    if (removedIds.length === 1) ops.remove(removedIds[0]);
    else if (removedIds.length > 1) ops.removeMany(removedIds);
    if (removedIds.length > 0) {
      const gone = new Set(removedIds.map((id) => String(id)));
      pruneLegacy(legacyField, (e) => !gone.has(String(e.id)));
    }
  };

  const setLog = makeEntrySetter(log, statOps, "log");
  const setPointLogRaw = makeEntrySetter(pointLog, pointOps, "pointLog");
  // The point log is the scoreboard's record, so it follows the same
  // coach-set policy as `score` itself rather than the stat-entry rule.
  const setPointLog = (updater) => {
    if (assistantMode && !assistantCanScore) {
      setAssistantNotice("This device can record stats but not the score — ask the coach to allow it in Settings.");
      return;
    }
    setPointLogRaw(updater);
  };

  // One-time, idempotent move of the legacy arrays into the collections.
  // Runs on whichever device opens the app first; a second device running
  // it concurrently writes the same document ids with the same contents,
  // so there's nothing to coordinate. The legacy arrays are only cleared
  // once the writes have actually landed — if they fail (no signal), the
  // union read above keeps the app fully correct and the migration is
  // simply retried on the next load.
  const migrationRef = useRef(false);
  useEffect(() => {
    if (!teamCode || !logsLoaded || !statsLoaded || !pointsLoaded) return;
    const legacyStats = logsDoc.log || [];
    const legacyPoints = logsDoc.pointLog || [];
    if (legacyStats.length === 0 && legacyPoints.length === 0) return;
    if (migrationRef.current) return;
    migrationRef.current = true;
    Promise.all([statOps.putMany(legacyStats), pointOps.putMany(legacyPoints)]).then(([statsOk, pointsOk]) => {
      if (statsOk && pointsOk) setLogsDoc((prev) => ({ ...prev, log: [], pointLog: [] }));
      else migrationRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCode, logsLoaded, statsLoaded, pointsLoaded, logsDoc.log, logsDoc.pointLog]);

  // Stats whose match no longer exists on the schedule — i.e. the match was
  // deleted out from under them. The entries themselves were never touched
  // (they live in the logs doc, not on the match), they just stopped being
  // reachable, since every per-match view lists from `matches`.
  //
  // They're recoverable because nothing about them was lost: each entry
  // still carries the deleted match's `matchId`, and a stat entry's `id` is
  // `Date.now() + Math.random()`, so the earliest one dates the match to the
  // evening it was actually played. Recreating a match with that SAME id
  // relinks the stats, the point log and everything downstream at once.
  const orphanedMatches = useMemo(() => {
    const known = new Set((matches || []).map((m) => m.id));
    const byId = new Map();
    const note = (matchId, entryId, kind, setNumber) => {
      if (matchId == null || known.has(matchId)) return;
      if (!byId.has(matchId))
        byId.set(matchId, { matchId, stats: 0, points: 0, firstAt: Infinity, sets: new Set() });
      const o = byId.get(matchId);
      o[kind] += 1;
      if (setNumber != null) o.sets.add(setNumber);
      // entry ids are epoch-ms + a random fraction; floor is the timestamp
      const at = Math.floor(entryId);
      if (at > 1000000000000 && at < o.firstAt) o.firstAt = at;
    };
    (log || []).forEach((e) => note(e.matchId, e.id, "stats", e.setNumber));
    (pointLog || []).forEach((e) => note(e.matchId, e.id, "points", e.setNumber));
    return [...byId.values()]
      .map((o) => ({ ...o, sets: [...o.sets].sort((a, b) => a - b) }))
      .sort((a, b) => b.firstAt - a.firstAt);
  }, [log, pointLog, matches]);

  // Rebuild a deleted match from what its stats still know. The id is reused
  // deliberately — that's what relinks everything. setScores is recomputed
  // from the point log; the lineup snapshots genuinely cannot be rebuilt
  // (they lived on the match object), so the record comes back without them
  // rather than with invented ones.
  const recoverOrphanedMatch = (orphan) => {
    const setScores = {};
    (pointLog || []).forEach((e) => {
      if (e.matchId !== orphan.matchId) return;
      const key = String(e.setNumber ?? 1);
      if (!setScores[key]) setScores[key] = { us: 0, opp: 0 };
      setScores[key][e.team] += 1;
    });
    const d = new Date(Number.isFinite(orphan.firstAt) ? orphan.firstAt : Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    setMatches((prev) => [
      ...prev,
      {
        id: orphan.matchId,
        date,
        opponent: "Recovered match",
        location: "",
        homeAway: "Home",
        ...(Object.keys(setScores).length ? { setScores } : {}),
        recoveredAt: Date.now(),
      },
    ]);
  };


  // Stats recorded with NO match selected at all. Different from an orphan
  // above, and not fixable by the same tool: an orphan's entries still carry
  // a matchId whose match was deleted, so rebuilding that match with the same
  // id relinks everything at once. These carry no id to relink — they were
  // tapped while the Live screen said "No active match" — so they count in
  // Season to Date and are invisible everywhere that works by match. That
  // happened for a whole match's worth of stats, which is what this is for.
  //
  // Grouped by the LOCAL calendar day the entries were recorded (stat ids are
  // `Date.now() + Math.random()`, so the floor is when it was tapped) because
  // that's what a coach can actually recognise: "the 42 stats from Oct 8".
  // Deliberately todayISO-style local date arithmetic, never toISOString —
  // see the UTC bullet in CLAUDE.md.
  const unassignedEntries = useMemo(() => {
    const byDay = new Map();
    const note = (entry, kind) => {
      if (entry?.matchId != null) return;
      const at = Math.floor(entry?.id);
      const valid = at > 1000000000000;
      let key = "unknown";
      if (valid) {
        const d = new Date(at);
        const pad = (n) => String(n).padStart(2, "0");
        key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      if (!byDay.has(key))
        byDay.set(key, { key, date: valid ? key : null, stats: 0, points: 0, statIds: [], pointIds: [], sets: new Set(), firstAt: Infinity });
      const g = byDay.get(key);
      g[kind] += 1;
      g[kind === "stats" ? "statIds" : "pointIds"].push(entry.id);
      if (entry.setNumber != null) g.sets.add(entry.setNumber);
      if (valid && at < g.firstAt) g.firstAt = at;
    };
    (log || []).forEach((e) => note(e, "stats"));
    (pointLog || []).forEach((e) => note(e, "points"));
    return [...byDay.values()]
      .map((g) => ({ ...g, sets: [...g.sets].sort((a, b) => a - b) }))
      .sort((a, b) => b.firstAt - a.firstAt);
  }, [log, pointLog]);

  const [assignReport, setAssignReport] = useState("");

  // Attach a day's worth of stranded entries to a real match. Stamping the
  // matchId is what relinks them — the box score, Insights and Trends all
  // filter on it — and the match's per-set scores are rebuilt from the point
  // log the same way endMatch and the orphan recovery do it, or the box score
  // would show the stats with no set scores beside them.
  //
  // setScores is computed from what the point log is ABOUT to be, not from
  // state, since the setPointLog above hasn't been applied yet in this tick.
  const assignUnassignedTo = (group, matchId) => {
    if (!group || matchId == null) return;
    const statIds = new Set(group.statIds.map(String));
    const pointIds = new Set(group.pointIds.map(String));
    const stamp = (e, ids) => (ids.has(String(e.id)) ? { ...e, matchId } : e);
    if (statIds.size) setLog((prev) => prev.map((e) => stamp(e, statIds)));
    const nextPoints = (pointLog || []).map((e) => stamp(e, pointIds));
    if (pointIds.size) setPointLog(() => nextPoints);
    const setScores = {};
    nextPoints.forEach((e) => {
      if (e.matchId !== matchId || !e.team) return;
      const key = String(e.setNumber ?? 1);
      if (!setScores[key]) setScores[key] = { us: 0, opp: 0 };
      setScores[key][e.team] += 1;
    });
    if (Object.keys(setScores).length)
      setMatches((prev) => prev.map((m) => (m.id === matchId ? { ...m, setScores } : m)));
    setAssignReport(
      `Attached ${group.stats} stat${group.stats === 1 ? "" : "s"}` +
        (group.points ? ` and ${group.points} point${group.points === 1 ? "" : "s"}` : "") +
        " to the match."
    );
  };

  // ─── PLAYER ACCESS ────────────────────────────────────────────────────────
  // Publishing is an EXPLICIT action, never automatic. A half-finished match
  // must not appear on a player's phone, and the coach is the one who knows
  // when the numbers are worth showing.
  //
  // Codes live on the team doc (`playerCodes`) so the coach's own device can
  // always list, re-show and revoke what it issued — a published document
  // deliberately carries no way back to its team.
  const playerCodes = mainDoc.playerCodes || [];
  const playerAccessStyle = mainDoc.playerAccessStyle || "hybrid";
  const entitlements = entitlementsOf(mainDoc);
  const [publishReport, setPublishReport] = useState("");

  const issuePlayerCodes = (style) => {
    const next = generateCodes(roster, style, playerCodes);
    setMainDoc((prev) => ({ ...prev, playerCodes: next, playerAccessStyle: style }));
    return next;
  };

  const publishPlayerStats = async () => {
    setPublishReport("");
    try {
      const codes = playerCodes.length ? playerCodes : issuePlayerCodes(playerAccessStyle);
      const docs = buildPublishedSet({
        roster,
        codes,
        teamName: mainDoc.teamName || "",
        log,
        matches,
        statKeys: printStatKeys,
      });
      const entries = Object.entries(docs);
      // Same chunked batching as every other bulk write here: Firestore caps
      // a batch at 500 operations.
      for (let i = 0; i < entries.length; i += WRITE_BATCH_LIMIT) {
        const batch = writeBatch(db);
        entries.slice(i, i + WRITE_BATCH_LIMIT).forEach(([code, data]) => {
          batch.set(doc(db, "playerAccess", code), data);
        });
        await batch.commit();
      }
      setPublishReport(
        `Published ${entries.length} player${entries.length === 1 ? "" : "s"} at ${new Date().toLocaleTimeString()}.`
      );
    } catch (err) {
      setPublishReport(`Could not publish: ${err?.message || err}`);
    }
  };

  // Revoking deletes the published documents AND drops the codes, so a code
  // already handed out stops working rather than going quiet and coming back
  // to life at the next publish.
  const revokePlayerAccess = async () => {
    setPublishReport("");
    try {
      for (let i = 0; i < playerCodes.length; i += WRITE_BATCH_LIMIT) {
        const batch = writeBatch(db);
        playerCodes.slice(i, i + WRITE_BATCH_LIMIT).forEach((c) => {
          batch.delete(doc(db, "playerAccess", c.code));
        });
        await batch.commit();
      }
      setMainDoc((prev) => ({ ...prev, playerCodes: [] }));
      setPublishReport("Player access revoked — every code has stopped working.");
    } catch (err) {
      setPublishReport(`Could not revoke: ${err?.message || err}`);
    }
  };

  // Folds one roster entry into another and deletes the duplicate.
  //
  // This exists for a specific, real situation: a libero who also plays
  // defensive specialist wears a different jersey number in each role, and
  // with no way to give one player two numbers the only option was to add her
  // to the roster twice. That splits everything that keys off `playerId` —
  // her box score, her season totals, her Player Eval ratings, and her
  // sub/re-entry record — into two half-players, permanently. `liberoNum` on
  // the player is the fix going forward; this is the fix for rosters that
  // already carry the duplicates.
  //
  // `keepId` survives and inherits everything. `useDropAsLibero` copies the
  // dropped entry's jersey number onto the survivor as her `liberoNum`, which
  // is almost always what you want — the duplicate WAS the libero jersey.
  const [mergeReport, setMergeReport] = useState("");
  const mergePlayers = (keepId, dropId, useDropAsLibero) => {
    const keep = roster.find((p) => p.id === keepId);
    const drop = roster.find((p) => p.id === dropId);
    if (!keep || !drop || keepId === dropId) {
      setMergeReport("Pick two different players from the roster.");
      return;
    }
    const movedStats = log.filter((e) => e.playerId === dropId).length;
    const movedPoints = pointLog.filter((e) => e.serverPlayerId === dropId).length;

    setMainDoc((prev) => {
      const dedupe = (arr) => [...new Set(arr)];
      return {
        ...prev,
        roster: prev.roster
          .map((p) =>
            p.id === keepId
              ? {
                  ...p,
                  liberoNum: useDropAsLibero ? String(drop.num) : p.liberoNum || "",
                  // a position she only had on the duplicate entry is still hers
                  position2: p.position2 || (drop.position !== p.position ? drop.position : "") || "",
                }
              : p
          )
          .filter((p) => p.id !== dropId),
        captainIds: dedupe(captainIdList(prev).map((id) => (id === dropId ? keepId : id))),
        captainId: prev.captainId === dropId ? keepId : prev.captainId,
        injuredPlayerIds: dedupe((prev.injuredPlayerIds || []).map((id) => (id === dropId ? keepId : id))),
        lineups: (prev.lineups || []).map((l) => remapLineupPlayer(l, dropId, keepId)),
        subEntries: (prev.subEntries || [])
          .map((e) => ({
            ...e,
            playerId: e.playerId === dropId ? keepId : e.playerId,
            forPlayerId: e.forPlayerId === dropId ? keepId : e.forPlayerId,
          }))
          // she can't have subbed for herself — that entry was an artifact of
          // the two jerseys being two roster entries
          .filter((e) => e.playerId !== e.forPlayerId),
        matches: (prev.matches || []).map((m) =>
          m.lineupSnapshots
            ? {
                ...m,
                lineupSnapshots: Object.fromEntries(
                  Object.entries(m.lineupSnapshots).map(([setNo, snap]) => [
                    setNo,
                    remapLineupPlayer(snap, dropId, keepId),
                  ])
                ),
              }
            : m
        ),
        captainVote: prev.captainVote
          ? {
              ...prev.captainVote,
              candidateIds: dedupe((prev.captainVote.candidateIds || []).map((id) => (id === dropId ? keepId : id))),
              ballots: (prev.captainVote.ballots || []).map((b) =>
                Array.isArray(b?.picks)
                  ? { ...b, picks: dedupe(b.picks.map((id) => (id === dropId ? keepId : id))) }
                  : b === dropId
                  ? keepId
                  : b
              ),
            }
          : prev.captainVote,
        trendSubject: prev.trendSubject === `player:${dropId}` ? `player:${keepId}` : prev.trendSubject,
      };
    });

    if (movedStats > 0) setLog((prev) => prev.map((e) => (e.playerId === dropId ? { ...e, playerId: keepId } : e)));
    if (movedPoints > 0)
      setPointLog((prev) => prev.map((e) => (e.serverPlayerId === dropId ? { ...e, serverPlayerId: keepId } : e)));

    // Player Eval keeps its own doc that this app never otherwise touches.
    // Leaving it alone would strand every rating recorded against the
    // duplicate, which is half the point of merging.
    let evalNote = "";
    if (teamCode) {
      const peRef = doc(db, "teams", teamCode, "data", "playerEval");
      getDoc(peRef)
        .then((snap) => {
          if (!snap.exists()) return;
          const evaluations = snap.data().evaluations || [];
          if (!evaluations.some((e) => e.playerId === dropId)) return;
          return setDoc(
            peRef,
            { evaluations: evaluations.map((e) => (e.playerId === dropId ? { ...e, playerId: keepId } : e)) },
            { merge: true }
          );
        })
        .catch((err) => console.warn("Couldn't merge Player Eval ratings:", err));
      evalNote = " Player Eval ratings were moved across too.";
    }

    setMergeReport(
      `Merged #${drop.num} ${displayName(drop)} into #${keep.num} ${displayName(keep)}` +
        (useDropAsLibero ? ` (libero jersey #${drop.num})` : "") +
        `. Moved ${movedStats} stat ${movedStats === 1 ? "entry" : "entries"}` +
        (movedPoints > 0 ? ` and ${movedPoints} served ${movedPoints === 1 ? "point" : "points"}` : "") +
        `.${evalNote}`
    );
  };

  const teamLogo = brandingDoc.teamLogo;
  const updateTeamLogo = (dataUrl) => setBrandingDoc((prev) => ({ ...prev, teamLogo: dataUrl }));

  const dataLoaded = mainLoaded && logsLoaded && brandingLoaded && statsLoaded && pointsLoaded;

  // A full backup of everything this team's data actually is — the one
  // recovery path if a team code ever got lost or something went wrong,
  // since there's no other way to pull this back out of Firestore.
  const exportAllData = () => {
    const dateStr = todayISO();
    downloadJSON(`volley-bandit-backup-${teamCode}-${dateStr}.json`, {
      teamCode,
      exportedAt: new Date().toISOString(),
      main: mainDoc,
      // Not `logsDoc` — the entries live in their own collections now, and
      // that document is empty once the migration has run. A backup has to
      // carry the real thing, and it stays in the same `{ log, pointLog }`
      // shape so older backups and newer ones restore identically.
      logs: { log, pointLog },
      branding: brandingDoc,
    });
  };

  // The other half of Export. A backup nobody can restore isn't a backup,
  // and until now there was no way back in — the export was a file you
  // could read but never reinstate. It writes whichever of the three docs
  // the file actually contains, so an older backup missing `branding`
  // simply leaves branding alone rather than blanking it.
  //
  // Deliberately replaces rather than merges: restoring half a roster into
  // a live one would be worse than either state on its own. That's also why
  // it sits behind a two-tap confirm and reports exactly what it read
  // before doing anything.
  const [restoreReport, setRestoreReport] = useState("");
  const restoreFromBackup = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setRestoreReport("Couldn't read that file.");
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setRestoreReport("That file isn't a Volley Bandit backup — it wouldn't parse.");
        return;
      }
      if (!parsed || typeof parsed !== "object" || (!parsed.main && !parsed.logs && !parsed.branding)) {
        setRestoreReport("That file doesn't look like a Volley Bandit backup.");
        return;
      }
      const parts = [];
      if (parsed.main && typeof parsed.main === "object") {
        setMainDoc(parsed.main);
        parts.push(
          `${(parsed.main.roster || []).length} players, ${(parsed.main.lineups || []).length} lineups, ${(parsed.main.matches || []).length} matches`
        );
      }
      if (parsed.logs && typeof parsed.logs === "object") {
        // Replaces both collections outright — including deleting entries
        // the backup doesn't have — and empties the legacy arrays so the
        // restored file is the whole truth, not merged into what was here.
        statOps.replaceAll(parsed.logs.log || []);
        pointOps.replaceAll(parsed.logs.pointLog || []);
        setLogsDoc({ log: [], pointLog: [] });
        parts.push(`${(parsed.logs.log || []).length} stat entries`);
      }
      if (parsed.branding && typeof parsed.branding === "object") {
        setBrandingDoc(parsed.branding);
        parts.push("branding");
      }
      setRestoreReport(
        `Restored from ${parsed.exportedAt ? parsed.exportedAt.slice(0, 10) : "backup"}: ${parts.join(" · ")}.`
      );
    };
    reader.readAsText(file);
  };

  // Advances to the next set: resets the scoreboard, the sub counters and
  // the per-set sub record, and switches to that set's lineup freshly at
  // Rotation 1. Returns null on success, or a message to show if it can't
  // proceed — deliberately NOT an alert(), which is the documented
  // iOS-standalone-PWA hazard described in CLAUDE.md (the dialog can fail
  // to render while still blocking the JS thread, i.e. "the app froze").
  //
  // In Full mode a missing lineup for the next set is a block: that mode is
  // built around per-set lineups and guessing one would be worse than
  // saying so. Simple mode doesn't manage lineups at all, so there it
  // duplicates the current one rather than dead-ending a coach who only
  // wanted the score cleared — same players, rotation 1, renamed for the set.
  const startNextSet = ({ autoCreate = false } = {}) => {
    const activeLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0] || EMPTY_LINEUP;
    const nextSetNumber = (activeLineup.setNumber || 1) + 1;
    let nextLineup = lineups.find((l) => l.setNumber === nextSetNumber);
    if (!nextLineup && !autoCreate) {
      return `The lineup for Set ${nextSetNumber} needs to be created — create or duplicate a lineup on the Lineup screen first.`;
    }
    if (!nextLineup) {
      nextLineup = {
        ...activeLineup,
        id: Date.now(),
        name: `Set ${nextSetNumber}`,
        setNumber: nextSetNumber,
        currentRotation: 1,
      };
      setLineups((prev) => [...prev, nextLineup]);
    } else {
      setLineups((prev) => prev.map((l) => (l.id === nextLineup.id ? { ...l, currentRotation: 1 } : l)));
    }
    setScore({ us: 0, opp: 0 });
    setSubCount(0);
    setLiberoSubCount(0);
    setSubEntries([]);
    setActiveLineupId(nextLineup.id);
    return null;
  };

  // Ends the active match: resets the live scoreboard, returns to Set 1's
  // lineup (freshly at Rotation 1) so the next match starts clean, and
  // clears which match is active so new stat entries don't accidentally get
  // logged against a match that's already finished. Stats already recorded
  // stay exactly where they are — this only resets live-tracking state.
  const endMatch = () => {
    // Ending the match is what locks it in. Everything that made this match
    // what it was gets frozen onto the match record here, because none of it
    // survives otherwise: lineups are templates that keep being edited, and
    // the live score and counters are all about to be reset for the next
    // match. After this the match is a closed record — the Lineup tab shows
    // what played rather than today's templates whenever it's active again.
    //
    // The per-set lineup is normally already captured by the first stat of
    // each set (snapshotLineupForMatch). This backfills any set that has
    // points but no stats, and the set that was in progress when the match
    // ended, so a match run without stat entry still gets a record.
    const endingMatchId = activeMatchId;
    if (endingMatchId != null) {
      const setsPlayed = new Set();
      log.forEach((e) => {
        if (e.matchId === endingMatchId) setsPlayed.add(e.setNumber ?? 1);
      });
      const setScores = {};
      pointLog.forEach((e) => {
        if (e.matchId !== endingMatchId) return;
        const key = String(e.setNumber ?? 1);
        setsPlayed.add(e.setNumber ?? 1);
        if (!setScores[key]) setScores[key] = { us: 0, opp: 0 };
        setScores[key][e.team] += 1;
      });
      const liveLineup = lineups.find((l) => l.id === activeLineupId) || lineups[0];
      if (liveLineup) setsPlayed.add(liveLineup.setNumber || 1);

      setMatches((prev) =>
        prev.map((m) => {
          if (m.id !== endingMatchId) return m;
          const snaps = { ...(m.lineupSnapshots || {}) };
          setsPlayed.forEach((sn) => {
            if (snaps[sn]) return; // a snapshot taken during play always wins
            const l = lineups.find((x) => (x.setNumber || 1) === sn);
            if (l) snaps[sn] = buildLineupSnapshot(l, sn);
          });
          return {
            ...m,
            lineupSnapshots: snaps,
            setScores,
            completedAt: Date.now(),
          };
        })
      );
    }

    const setOneLineup = lineups.find((l) => l.setNumber === 1) || lineups[0];
    setScore({ us: 0, opp: 0 });
    setSubCount(0);
    setLiberoSubCount(0);
    setSubEntries([]);
    setInjuredPlayerIds([]);
    setLineups((prev) => prev.map((l) => ({ ...l, currentRotation: 1 })));
    if (setOneLineup) setActiveLineupId(setOneLineup.id); // no lineups at all: nothing to point at
    setActiveMatchId(null);
  };

  // The Live tab's subtitle shipped as a hardcoded placeholder
  // ("Riverside High vs. Lincoln") — the only tab whose subtitle was never
  // wired to real data. It's the team's own name against whichever match is
  // currently active, and says plainly when no match is active, since that's
  // also what decides where stat entries get logged.
  // Just "vs. Opponent", matching every other tab — the team's own name is
  // on the logo beside it, and spelling it out here wrapped the header onto
  // a second line on a phone, which is exactly the vertical space this
  // screen has least of.
  const liveMatch = activeMatchId != null ? matches.find((m) => m.id === activeMatchId) : null;
  const liveSubtitle = liveMatch
    ? `vs. ${liveMatch.opponent}`
    : "No active match — pick one on Schedule";

  const titles = {
    roster: { title: "Roster", sub: "Your full team" },
    lineup: { title: "Lineup", sub: "Tap a slot to assign a player" },
    live: { title: "Live Stats", sub: liveSubtitle },
    box: { title: "Stats", sub: "Box score, insights, trends & season" },
    schedule: { title: "Schedule", sub: "Upcoming and past matches" },
    tourney: { title: "Tournament", sub: "King & Queen of the Court" },
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
  // Why the last print failed, shown in-app. This used to be an alert(),
  // which is the one native dialog CLAUDE.md still listed as outstanding
  // and the worst-placed of them: inside an installed standalone PWA on
  // iOS, alert() can fail to render while still blocking the page's JS
  // thread, which is indistinguishable from the app freezing — and it sat
  // on the failure path of the feature most likely to fail on a phone with
  // no signal. Reported as state instead, so a failure can never wedge the
  // app; worst case the coach sees a line they can dismiss.
  const [printError, setPrintError] = useState("");
  const [printChoiceOpen, setPrintChoiceOpen] = useState(false);
  const [boxPrintChoiceOpen, setBoxPrintChoiceOpen] = useState(false);
  const [printTarget, setPrintTarget] = useState(null); // null = use the current tab's default target
  // Tournament Builder owns its own print logic (its data has nothing to do
  // with the roster/lineup/match print targets below) — this ref/state pair
  // is just how its Print action reaches the shared TopBar button, same
  // spot as every other tab's. See TournamentBuilder.jsx's own comment on
  // the ref for the full reasoning.
  const tourneyPrintRef = useRef(null);
  const [tourneyPrinting, setTourneyPrinting] = useState(false);
  const [tourneyReady, setTourneyReady] = useState(false);
  const handlePrint = async (explicitTarget) => {
    if (printing) return;
    setPrinting(true);
    setPrintError("");
    // Fixes a real bug: reading printTarget from React state here was
    // grabbing a stale, leftover value from before this call, since
    // setPrintTarget(...) called right before handlePrint() doesn't take
    // effect until the next render — handlePrint was always working off
    // whatever target was current before this tap, not the one just
    // selected. Taking it as a direct parameter instead sidesteps that
    // timing problem entirely. This is also why every download was
    // showing up named "volley-bandit-lineup" regardless of which sheet
    // was actually printed.
    setPrintTarget(explicitTarget);
    const root = document.getElementById("print-root");
    // Safety net: if this whole operation somehow never reaches its own
    // finally block — iOS can genuinely suspend an in-flight async function
    // mid-await if the tab gets backgrounded, the screen locks, or you
    // switch apps during a multi-page print — this forces the capturing
    // state to clear on its own after 20s no matter what, rather than
    // leaving the print sheet permanently rendered in the background for
    // the rest of the session (which would mean real, ongoing CPU/memory
    // use even while just using the app normally afterward).
    const forceCleanupTimer = setTimeout(() => {
      root.classList.remove("print-root-capturing");
      setPrinting(false);
      console.warn("Print operation force-cleaned after timing out — this shouldn't normally happen.");
    }, 20000);
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

      const pdf = new jsPDF("p", "pt", "letter");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const MARGIN = 26; // reduced from 36 (half-inch) to reclaim a bit more usable page height
      const contentWidth = pageWidth - MARGIN * 2;
      const contentHeight = pageHeight - MARGIN * 2;
      let pageIndex = 0;

      // Captures one element and adds it to the PDF, slicing into separate
      // per-page images sized to exactly fit inside the margin box, rather
      // than positioning one huge image and hoping the page edge clips it —
      // that's what was causing content to run edge-to-edge with no margin.
      // This also keeps each individual image small (helps avoid hitting
      // canvas/memory limits on iOS specifically, and JPEG compression here
      // cuts file size a lot versus the uncompressed PNG this used before).
      const captureElementToPdf = async (el) => {
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
        const scaleFactor = contentWidth / canvas.width;
        const sliceHeightPx = contentHeight / scaleFactor;
        let renderedPx = 0;
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
      };

      // The Rotation Reference, Player Guide and Serve-Receive sheets all
      // force exactly 1 set per page — each page-group class gets captured and paginated on its own,
      // always starting a fresh page, instead of one continuous capture
      // where page breaks land wherever the height happens to run out
      // (which was orphaning a set's title or pairing list onto the next
      // page, separated from its own content).
      const PAGE_GROUPS = {
        subsheet: ".subsheet-page-group",
        playerguide: ".playerguide-page-group",
        servereceive: ".servereceive-page-group",
      };
      const pageGroupSelector = PAGE_GROUPS[explicitTarget] || null;
      const pageGroups = pageGroupSelector ? Array.from(activeSection.querySelectorAll(pageGroupSelector)) : [];
      if (pageGroups.length > 0) {
        for (const group of pageGroups) {
          await captureElementToPdf(group);
        }
      } else {
        await captureElementToPdf(activeSection);
      }

      const blob = pdf.output("blob");
      const dateStr = todayISO();
      const filename = `volley-bandit-${explicitTarget || tab}-${dateStr}.pdf`;
      const file = new File([blob], filename, { type: "application/pdf" });

      const downloadDirectly = () => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
        } catch (shareErr) {
          // The user closing the share sheet counts as "AbortError" — that's
          // normal, not a failure, nothing more to do. Any OTHER failure
          // here means this browser claimed it could share a file but
          // actually can't (seen on Chrome for iOS specifically — every iOS
          // browser sits on the same rendering engine, but that doesn't mean
          // they all support this capability equally) — fall back to a
          // plain download rather than just erroring out.
          if (shareErr.name !== "AbortError") downloadDirectly();
        }
      } else {
        downloadDirectly();
      }
    } catch (err) {
      // Include the actual error message directly in the alert — mobile
      // Safari's console isn't reachable without a Mac plugged in via cable,
      // so this is the only practical way to see what actually went wrong.
      console.warn("PDF export failed:", err);
      setPrintError(err?.message || String(err));
      // Also record it where Settings can read it back later — a print that
      // fails courtside is exactly the report that never survives the walk
      // back to the bench.
      recordCrash(err instanceof Error ? err : new Error(String(err)), {
        componentStack: `handlePrint(${explicitTarget || tab})`,
      });
    } finally {
      clearTimeout(forceCleanupTimer); // normal completion — the safety net above isn't needed
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
    if (deepLink.status === "checking") {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0D10", color: COLORS.chalkDim, fontSize: 13 }}>
          Joining team {deepLink.code}…
        </div>
      );
    }
    return (
      <TeamGate
        onLinked={(code, mode, typedCode) => {
          setAccessMode(mode || "coach");
          setAccessCode(mode === "assistant" ? typedCode || "" : "");
          setTeamCode(code);
        }}
        initialJoinCode={deepLink.status === "failed" ? deepLink.code : undefined}
        initialJoinError={deepLink.status === "failed" ? deepLink.error || "No team found with that code — double-check it and try again." : undefined}
      />
    );
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
      {assistantNotice && (
        <div
          style={{
            position: "fixed",
            bottom: 122,
            left: 12,
            right: 12,
            zIndex: 70,
            background: COLORS.goldSoft,
            border: `1.5px solid ${COLORS.gold}`,
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 12,
            color: COLORS.chalk,
            lineHeight: 1.4,
          }}
        >
          {assistantNotice}
        </div>
      )}
      {printError && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 60,
            background: COLORS.redSoft,
            borderBottom: `1.5px solid ${COLORS.red}`,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            backdropFilter: "blur(6px)",
          }}
        >
          <div style={{ flex: 1, fontSize: 12, color: COLORS.chalk, lineHeight: 1.4 }}>
            <b>Couldn't make the PDF.</b> Nothing else is affected — your stats and
            lineups are untouched. {printError}
          </div>
          <button
            onClick={() => setPrintError("")}
            style={{ background: "none", border: "none", color: COLORS.chalkDim, flexShrink: 0 }}
          >
            <X size={16} />
          </button>
        </div>
      )}
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
        captainIds={captainIds}
        teamName={teamName}
        coachName={coachName}
        activeMatchId={activeMatchId}
        teamLogo={teamLogo}
        statsView={statsView}
        trendSubject={trendSubject}
        pointLog={pointLog}
        includePairingsRoster={includePairingsRoster}
        includePairingsLineup={includePairingsLineup}
        printStatKeys={printStatKeys}
        roleSystem={roleSystem}
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
          onPrint={
            tab === "tourney"
              ? tourneyReady
                ? () => tourneyPrintRef.current?.print()
                : null
              : PRINTABLE_TABS[tab]
              ? tab === "lineup"
                ? () => setPrintChoiceOpen(true)
                : tab === "box"
                ? () => setBoxPrintChoiceOpen(true)
                : () => handlePrint(PRINTABLE_TABS[tab])
              : null
          }
          printing={tab === "tourney" ? tourneyPrinting : printing}
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
                  handlePrint("lineup");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginBottom: 8,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.orange}`,
                  background: COLORS.accentSoft,
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
                  handlePrint("servereceive");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginBottom: 8,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.purple}`,
                  background: COLORS.bgRaised,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Serve-Receive Sheet
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  One page per set — all six rotations, with the switch arrows
                </div>
              </button>
              <button
                onClick={() => {
                  setPrintChoiceOpen(false);
                  handlePrint("subsheet");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.green}`,
                  background: COLORS.greenSoft,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Rotation Reference
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  Coach reference — every rotation, all subs mapped out
                </div>
              </button>
              <button
                onClick={() => {
                  setPrintChoiceOpen(false);
                  handlePrint("playerguide");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginTop: 8,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.blue}`,
                  background: COLORS.blueSoft,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Player Guide
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  Hand to players — starting diagram + plain-language swaps
                </div>
              </button>
              <button
                onClick={() => {
                  setPrintChoiceOpen(false);
                  handlePrint("blanksheet");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginTop: 8,
                  borderRadius: 8,
                  border: `1px dashed ${COLORS.line}`,
                  background: "none",
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Blank Lineup Sheet
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  Roster filled in, everything else blank — pencil it in yourself
                </div>
              </button>
            </div>
          </div>
        )}
        {boxPrintChoiceOpen && (
          <div
            onClick={() => setBoxPrintChoiceOpen(false)}
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
                  setBoxPrintChoiceOpen(false);
                  handlePrint("box");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  marginBottom: 8,
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.orange}`,
                  background: COLORS.accentSoft,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Per Match
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  One table — totals for the whole match
                </div>
              </button>
              <button
                onClick={() => {
                  setBoxPrintChoiceOpen(false);
                  handlePrint("boxperset");
                }}
                style={{
                  width: "100%",
                  padding: "12px",
                  borderRadius: 8,
                  border: `1.5px solid ${COLORS.green}`,
                  background: COLORS.greenSoft,
                  color: COLORS.chalk,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: "left",
                }}
              >
                Per Set
                <div style={{ fontSize: 11, fontWeight: 400, color: COLORS.chalkDim, marginTop: 2 }}>
                  A separate table for each set played
                </div>
              </button>
            </div>
          </div>
        )}
        {showStatInfo && <StatInfoSheet onClose={() => setShowStatInfo(false)} />}
        {showCaptainVote && (
          <CaptainVoteSheet
            onClose={() => setShowCaptainVote(false)}
            roster={roster}
            captainVote={captainVote}
            setCaptainVote={setCaptainVote}
          />
        )}
        {showSettings && (
          <SettingsSheet
            onClose={() => setShowSettings(false)}
            theme={theme}
            setTheme={setTheme}
            includePairingsRoster={includePairingsRoster}
            setIncludePairingsRoster={setIncludePairingsRoster}
            includePairingsLineup={includePairingsLineup}
            setIncludePairingsLineup={setIncludePairingsLineup}
            printStatKeys={printStatKeys}
            setPrintStatKeys={setPrintStatKeys}
            trackStatKeys={trackStatKeys}
            setTrackStatKeys={setTrackStatKeys}
            teamCode={teamCode}
            onUnlinkDevice={() => {
              // Clear what this device joined AS, not just which team. An
              // unlinked device is not an assistant device, and leaving the
              // mode behind is how a later join could come up limited.
              setAccessMode("");
              setAccessCode("");
              setTeamCode("");
            }}
            setTeamCode={setTeamCode}
            setUnlockedWith={setUnlockedWith}
            exportAllData={exportAllData}
            restoreFromBackup={restoreFromBackup}
            restoreReport={restoreReport}
            orphanedMatches={orphanedMatches}
            recoverOrphanedMatch={recoverOrphanedMatch}
            unassignedEntries={unassignedEntries}
            assignUnassignedTo={assignUnassignedTo}
            assignReport={assignReport}
            matches={matches}
            playerCodes={playerCodes}
            playerAccessStyle={playerAccessStyle}
            issuePlayerCodes={issuePlayerCodes}
            publishPlayerStats={publishPlayerStats}
            revokePlayerAccess={revokePlayerAccess}
            publishReport={publishReport}
            entitlements={entitlements}
            roster={roster}
            mergePlayers={mergePlayers}
            mergeReport={mergeReport}
            assistantMode={assistantMode}
            assistantCanScore={assistantCanScore}
            assistantAccess={assistantAccess}
            assistantCode={mainDoc.assistantCode}
            setAssistantAccess={fieldSetter(setMainDoc, "assistantAccess")}
            issueAssistantCode={issueAssistantCode}
            revokeAssistantCode={revokeAssistantCode}
            assistantCodeError={assistantCodeError}
          />
        )}
        {tab === "roster" && (
          <RosterScreen
            roster={roster}
            setRoster={setRoster}
            captainIds={captainIds}
            toggleCaptain={toggleCaptain}
            lineups={lineups}
            setLineups={setLineups}
            teamName={teamName}
            setTeamName={setTeamName}
            teamAbbr={teamAbbr}
            setTeamAbbr={setTeamAbbr}
            coachName={coachName}
            setCoachName={setCoachName}
            teamLogo={teamLogo}
            updateTeamLogo={updateTeamLogo}
            log={log}
            setLog={setLog}
            onOpenCaptainVote={() => setShowCaptainVote(true)}
            assistant={assistantMode}
          />
        )}
        {tab === "lineup" && (
          <LineupScreen
            lineups={lineups}
            setLineups={setLineups}
            activeLineupId={activeLineupId}
            setActiveLineupId={setActiveLineupId}
            roster={roster}
            setRoster={setRoster}
            captainIds={captainIds}
            toggleCaptain={toggleCaptain}
            roleSystem={roleSystem}
            setRoleSystem={setRoleSystem}
            matches={matches}
            activeMatchId={activeMatchId}
            assistant={assistantMode}
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
            subEntries={subEntries}
            setSubEntries={setSubEntries}
            injuredPlayerIds={injuredPlayerIds}
            setInjuredPlayerIds={setInjuredPlayerIds}
            activeMatchId={activeMatchId}
            pointLog={pointLog}
            setPointLog={setPointLog}
            onStartNextSet={startNextSet}
            onSnapshotLineup={snapshotLineupForMatch}
            setTab={setTab}
            trackStatKeys={trackStatKeys}
            assistant={assistantMode}
            assistantCanScore={assistantCanScore}
            usLabel={scoreLabel(teamAbbr || teamName, "US")}
            oppLabel={scoreLabel(liveMatch?.opponent, "OPP")}
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
            assistant={assistantMode}
          />
        )}
        {tab === "schedule" && (
          <ScheduleScreen
            matches={matches}
            setMatches={setMatches}
            matchIdsWithStats={matchIdsWithStats}
            orphanedMatches={orphanedMatches}
            unassignedEntries={unassignedEntries}
            onOpenSettings={() => setShowSettings(true)}
            activeMatchId={activeMatchId}
            setActiveMatchId={setActiveMatchId}
            setTab={setTab}
            setStatsView={setStatsView}
            assistant={assistantMode}
          />
        )}
        {tab === "tourney" && (
          <TournamentBuilder
            ref={tourneyPrintRef}
            roster={roster}
            onPrintingChange={setTourneyPrinting}
            onReadyChange={setTourneyReady}
          />
        )}
        <TabBar tab={tab} setTab={setTab} allowedTabs={allowedTabs} />
      </PhoneFrame>
    </div>
  );
}

// Wipes every client-side cache this app controls — service worker
// registrations and their caches — then hard-reloads. Deliberately does NOT
// touch localStorage, so the team code and passcode unlock survive: the
// point is to recover from a bad/stale cached build, not to make the coach
// re-link their device. This is the escape hatch for "the app went blank
// and I can't get back in" without needing to delete and reinstall it.
async function clearCachesAndReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn("Cache clear failed:", err);
  }
  window.location.reload(true);
}

// A blank screen is the worst possible failure on a phone: there's no
// console to open and nothing to report back. This catches render-time
// crashes and puts the actual error on screen, selectable, along with the
// recovery button above. Non-render failures (a rejected promise, a script
// that failed to load) are caught by the window-level listeners below and
// routed to the same place.
// Crashes are written to localStorage as they happen, so the error text
// survives the reload that the crash screen invites you to press.
// Previously it existed only on that screen: a coach mid-match taps Reload
// (rightly — it gets them back to the bench), and the only copy of what
// went wrong is gone. This happened for real, twice in one match, and left
// nothing to diagnose from. Settings → Recent Errors reads it back later.
//
// Deliberately dependency-free and wrapped in try/catch at every step: this
// runs on the path where the app is ALREADY broken, and must never be the
// thing that throws. localStorage can be unavailable or full.
const CRASH_LOG_KEY = "vb-crash-log";
const CRASH_LOG_MAX = 5;
function readCrashLog() {
  try {
    const raw = window.localStorage.getItem(CRASH_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function recordCrash(error, info) {
  try {
    const entry = {
      at: new Date().toISOString(),
      build: APP_VERSION,
      message: String(error?.message || error || "Unknown error").slice(0, 500),
      stack: String(error?.stack || "").slice(0, 2000),
      component: String(info?.componentStack || "").slice(0, 2000),
    };
    const next = [entry, ...readCrashLog()].slice(0, CRASH_LOG_MAX);
    window.localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(next));
  } catch {
    // A crash we can't record is still a crash we survived — never rethrow.
  }
}
function clearCrashLog() {
  try {
    window.localStorage.removeItem(CRASH_LOG_KEY);
  } catch {
    /* nothing to do */
  }
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ error, info });
    recordCrash(error, info);
    console.error("Caught by ErrorBoundary:", error, info);
  }

  componentDidMount() {
    // A window-level error or promise rejection is RECORDED but does not
    // take the app down. Only a real React render crash (componentDidCatch)
    // does, because that's the only case where the UI is genuinely broken.
    //
    // This used to replace the whole app for either one, and that was the
    // bug behind "it crashed mid-match, I hit reload and it was fine": a
    // background service-worker update check failing on gym wifi became an
    // unhandledrejection, and a coach lost their live match screen over a
    // network hiccup that affected nothing they were doing. Reload "fixed"
    // it because there was never anything wrong to fix.
    //
    // The crash log still gets every one of them, so nothing is lost for
    // diagnosis — that's how this was found in the first place.
    this.onRejection = (e) => {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      recordCrash(err, { componentStack: "window:unhandledrejection" });
    };
    this.onError = (e) => {
      const err = e.error instanceof Error ? e.error : new Error(e.message || "Script error");
      recordCrash(err, { componentStack: "window:error" });
    };
    window.addEventListener("unhandledrejection", this.onRejection);
    window.addEventListener("error", this.onError);
  }

  componentWillUnmount() {
    window.removeEventListener("unhandledrejection", this.onRejection);
    window.removeEventListener("error", this.onError);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const detail = [
      `Build: ${APP_VERSION}`,
      `Error: ${error.message || String(error)}`,
      error.stack ? `\nStack:\n${error.stack}` : "",
      info?.componentStack ? `\nComponent:\n${info.componentStack}` : "",
    ].join("\n");
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0B0D10",
          color: "#E8EAED",
          fontFamily: "'Inter', system-ui, sans-serif",
          padding: 20,
          overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Something went wrong</div>
        <div style={{ fontSize: 12, color: "#9AA0A6", marginBottom: 14, lineHeight: 1.5 }}>
          Your team data is safe — it lives in the cloud, not on this device. This is the
          app itself failing to draw. The details below are what to send along when
          reporting it. <b style={{ color: "#E8EAED" }}>This error has been saved to this
          device</b> — hit Reload and get back to your match; you can copy it afterwards
          from Settings → Recent Errors.
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #3C4043", background: "none", color: "#E8EAED", fontWeight: 700, fontSize: 13 }}
          >
            Reload
          </button>
          <button
            onClick={clearCachesAndReload}
            style={{ padding: "10px 14px", borderRadius: 8, border: "none", background: "#FF6B35", color: "#1C2128", fontWeight: 700, fontSize: 13 }}
          >
            Clear cached app &amp; reload
          </button>
          <button
            onClick={() => navigator.clipboard?.writeText(detail)}
            style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #3C4043", background: "none", color: "#E8EAED", fontWeight: 700, fontSize: 13 }}
          >
            Copy details
          </button>
        </div>
        <pre
          style={{
            fontSize: 11,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            userSelect: "text",
            background: "#15181C",
            border: "1px solid #3C4043",
            borderRadius: 8,
            padding: 12,
            margin: 0,
            color: "#C9CCD1",
          }}
        >
          {detail}
        </pre>
      </div>
    );
  }
}

export default function App() {
  const { needsRefresh, applyUpdate, dismiss } = useSWUpdate();
  return (
    <ErrorBoundary>
      {needsRefresh && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "10px 14px",
            background: COLORS.orange,
            color: "#1C2128",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          <span>A new version is available.</span>
          <button
            onClick={applyUpdate}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: "none",
              background: "#1C2128",
              color: COLORS.chalk,
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Reload
          </button>
          <button
            onClick={dismiss}
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              border: "1px solid #1C2128",
              background: "none",
              color: "#1C2128",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            Later
          </button>
        </div>
      )}
      <AppInner />
    </ErrorBoundary>
  );
}
