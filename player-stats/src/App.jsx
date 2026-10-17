import React, { useCallback, useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";

// ─────────────────────────────────────────────────────────────────────────────
// My Volleyball Stats — the player-facing half of Volley Bandit's Player
// Access feature.
//
// One URL for everybody. A player types the code her coach gave her and sees
// her own season numbers first, then the same numbers broken down match by
// match, with the team's totals beside her own for context.
//
// WHAT THIS APP CAN REACH, and why it is this small: it reads exactly one
// document, `playerAccess/{code}`, written by the coach's app when she taps
// Publish. That document holds one player's numbers, the team's totals, a
// short name ("Joy B.") and nothing else — no team code, no roster, no
// lineups, no other player's line. The team code is the writable key to the
// whole team, so it must never travel into something handed to a teenager.
// If you add a read here, it stays inside that one document.
//
// There is no sign-in anywhere in this project yet (see the main repo's
// CLAUDE.md, "Player Access, and the seams left for charging money"), so the
// code IS the credential. That is why it is six characters from an alphabet
// with no look-alikes, and why the coach can revoke one.
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION = "2026.10.18a";

// Own copy of the palette on purpose: a separate app cannot import from the
// main app's `src/`, same as Player Eval. Dark only — this is a phone screen
// in a gym, and there is no setting here worth building a theme toggle for.
const C = {
  bg: "#12161c",
  card: "#1a2029",
  card2: "#212936",
  line: "#2c3542",
  text: "#e8edf4",
  dim: "#8c9aad",
  accent: "#ff7a3d",
  green: "#3fbf6f",
  red: "#e5564a",
  blue: "#4a9fe5",
  gold: "#e0b23a",
};

// Also a copy — the published document carries stat KEYS, not labels, so this
// app has to know how to say them. Keys match `STAT_BUTTONS` in the coach
// app; `prettyKey` below covers anything added there but not here, so a new
// stat shows up as a readable column rather than vanishing.
const STAT_GROUPS = [
  {
    group: "Serve",
    keys: [
      ["ace", "Aces"],
      ["serviceAtt", "Service attempts"],
      ["serveErr", "Serve errors"],
    ],
  },
  {
    group: "Attack",
    keys: [
      ["kill", "Kills"],
      ["assist", "Assists"],
      ["attackErr", "Attack errors"],
    ],
  },
  {
    group: "Reception",
    keys: [
      ["dig", "Digs"],
      ["recErr", "Reception errors"],
      ["passingErr", "Passing errors"],
    ],
  },
  {
    group: "Block",
    keys: [
      ["blockSolo", "Solo blocks"],
      ["blockAst", "Block assists"],
      ["blockErr", "Block errors"],
    ],
  },
];

const KNOWN_LABELS = Object.fromEntries(
  STAT_GROUPS.flatMap((g) => g.keys).map(([k, label]) => [k, label])
);
const KNOWN_ORDER = STAT_GROUPS.flatMap((g) => g.keys.map(([k]) => k));

// "blockErr" -> "Block err", for a stat key this app hasn't been taught.
function prettyKey(key) {
  const spaced = String(key).replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
const labelFor = (key) => KNOWN_LABELS[key] || prettyKey(key);

// An error stat is the one thing a player might read the wrong way round, so
// it is tinted rather than left to look like an achievement.
const ERROR_KEYS = new Set(["serveErr", "attackErr", "recErr", "passingErr", "blockErr"]);

// ─── CODES ──────────────────────────────────────────────────────────────────
// Codes are issued uppercase (see playerAccess.js in the coach app), so a
// phone keyboard's lowercase has to be folded up before the lookup. The
// hyphen in a "hybrid" code (32JB-K4P) is the part a player types from memory
// and leaves out, so a code without one is also tried WITH one inserted
// before the last three characters — otherwise "32JB8TY" reads as a wrong
// code when it is the right one typed plainly.
function codeCandidates(raw) {
  const clean = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!clean) return [];
  const out = [clean];
  if (!clean.includes("-") && clean.length > 3) {
    out.push(`${clean.slice(0, -3)}-${clean.slice(-3)}`);
  }
  return out;
}

const STORE_KEY = "vbs-code";

function readStoredCode() {
  // localStorage throws in a locked-down browser; a card nobody can open is a
  // better outcome than a blank screen.
  try {
    return window.localStorage.getItem(STORE_KEY) || "";
  } catch {
    return "";
  }
}
function writeStoredCode(code) {
  try {
    if (code) window.localStorage.setItem(STORE_KEY, code);
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

// A date the coach typed as a local calendar date ("2026-09-22"). Parsed
// field by field, NOT with `new Date(str)`, which reads a bare ISO date as
// UTC midnight and so shows the day before west of UTC — the same bug
// `todayISO()` exists for in the coach app.
function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso || "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Which stats to show, and in what order: whatever the coach chose to publish
// (`statKeys`), in this app's own order, with anything else appended so a key
// it doesn't know still appears. Falls back to every key that carries a
// number if the published doc named none.
function statOrder(card) {
  const published = Array.isArray(card?.statKeys) ? card.statKeys : [];
  const seen = new Set([
    ...Object.keys(card?.season || {}),
    ...Object.keys(card?.teamSeason || {}),
    ...(card?.matches || []).flatMap((m) => Object.keys(m?.stats || {})),
  ]);
  const wanted = published.length ? published : [...seen];
  const set = new Set(wanted);
  const known = KNOWN_ORDER.filter((k) => set.has(k));
  const rest = wanted.filter((k) => !KNOWN_LABELS[k]).sort();
  return [...known, ...rest];
}

function Shell({ children, footer }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: C.bg,
        color: C.text,
        fontFamily:
          "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: "18px 14px calc(26px + env(safe-area-inset-bottom))",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {children}
        {footer}
      </div>
    </div>
  );
}

function CodeEntry({ onSubmit, busy, error, initial }) {
  const [value, setValue] = useState(initial || "");
  return (
    <Shell
      footer={
        <div style={{ marginTop: 28, color: C.dim, fontSize: 12, textAlign: "center" }}>
          v{APP_VERSION}
        </div>
      }
    >
      <h1 style={{ fontSize: 26, margin: "10px 0 6px", letterSpacing: -0.4 }}>My Stats</h1>
      <p style={{ color: C.dim, fontSize: 15, lineHeight: 1.5, margin: "0 0 22px" }}>
        Enter the code your coach gave you to see your season stats and how the
        team is doing.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 32JB-K4P"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Your code"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "15px 16px",
            fontSize: 20,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            background: C.card,
            color: C.text,
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          style={{
            width: "100%",
            marginTop: 12,
            padding: "15px 16px",
            fontSize: 17,
            fontWeight: 700,
            background: busy || !value.trim() ? C.card2 : C.accent,
            color: busy || !value.trim() ? C.dim : "#1a1206",
            border: "none",
            borderRadius: 12,
          }}
        >
          {busy ? "Looking…" : "Show my stats"}
        </button>
      </form>
      {error && (
        <div
          style={{
            marginTop: 16,
            padding: "12px 14px",
            background: C.card,
            border: `1px solid ${C.red}`,
            borderRadius: 12,
            color: C.text,
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}
    </Shell>
  );
}

function StatTable({ rows }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
      <thead>
        <tr style={{ color: C.dim, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>
          <th style={{ textAlign: "left", padding: "4px 0 8px" }}>Stat</th>
          <th style={{ textAlign: "right", padding: "4px 0 8px", width: 64 }}>You</th>
          <th style={{ textAlign: "right", padding: "4px 0 8px", width: 64 }}>Team</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, mine, team }) => (
          <tr key={key} style={{ borderTop: `1px solid ${C.line}` }}>
            <td style={{ padding: "10px 0", color: C.text }}>{labelFor(key)}</td>
            <td
              style={{
                padding: "10px 0",
                textAlign: "right",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: mine ? (ERROR_KEYS.has(key) ? C.red : C.green) : C.dim,
              }}
            >
              {mine || 0}
            </td>
            <td
              style={{
                padding: "10px 0",
                textAlign: "right",
                color: C.dim,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {team || 0}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Panel({ title, children, note }) {
  return (
    <section
      style={{
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: "14px 16px",
        marginTop: 14,
      }}
    >
      <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.8, color: C.dim, margin: "0 0 10px" }}>
        {title}
      </h2>
      {children}
      {note && <div style={{ color: C.dim, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
    </section>
  );
}

function MatchRow({ match, keys, open, onToggle }) {
  const stats = match?.stats || {};
  const present = keys.filter((k) => stats[k]);
  return (
    <div style={{ borderTop: `1px solid ${C.line}` }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "13px 0",
          background: "none",
          border: "none",
          color: C.text,
          textAlign: "left",
          fontSize: 15,
        }}
      >
        <span>
          <span style={{ fontWeight: 700 }}>{match?.opponent || "Match"}</span>
          <span style={{ color: C.dim, fontSize: 13, display: "block", marginTop: 2 }}>
            {prettyDate(match?.date)}
          </span>
        </span>
        <span style={{ color: C.dim, fontSize: 13, whiteSpace: "nowrap" }}>
          {present.length
            ? `${present.length} stat${present.length === 1 ? "" : "s"}`
            : "no stats"}
          <span style={{ marginLeft: 8, color: C.accent }}>{open ? "–" : "+"}</span>
        </span>
      </button>
      {open && (
        <div style={{ paddingBottom: 12 }}>
          {present.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {present.map((k) => (
                <span
                  key={k}
                  style={{
                    background: C.card2,
                    border: `1px solid ${C.line}`,
                    borderRadius: 10,
                    padding: "7px 10px",
                    fontSize: 14,
                  }}
                >
                  <b
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      color: ERROR_KEYS.has(k) ? C.red : C.green,
                    }}
                  >
                    {stats[k]}
                  </b>{" "}
                  <span style={{ color: C.dim }}>{labelFor(k)}</span>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ color: C.dim, fontSize: 13 }}>
              Nothing was recorded for you in this match.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ card, code, onForget, onRefresh, refreshing }) {
  const keys = useMemo(() => statOrder(card), [card]);
  const rows = useMemo(
    () =>
      keys.map((key) => ({
        key,
        mine: card?.season?.[key] || 0,
        team: card?.teamSeason?.[key] || 0,
      })),
    [keys, card]
  );
  const matches = card?.matches || [];
  // The season tally counts every stat recorded against this player; the
  // per-match list can only show matches that still exist on the coach's
  // schedule and that the stats were actually attached to. Those two numbers
  // disagree when a stat was tapped with no match active (a known thing the
  // coach app has a repair screen for), and a player reading 24 kills above a
  // list that adds to 15 would reasonably think one of them is lying. Say so
  // instead, quietly.
  const unattached = useMemo(() => {
    const seasonTotal = keys.reduce((t, k) => t + (card?.season?.[k] || 0), 0);
    const matchTotal = (card?.matches || []).reduce(
      (t, m) => t + keys.reduce((s, k) => s + (m?.stats?.[k] || 0), 0),
      0
    );
    return Math.max(0, seasonTotal - matchTotal);
  }, [keys, card]);
  // Most recent match open to begin with — it's the one she just played and
  // the reason she opened this.
  const [openIdx, setOpenIdx] = useState(0);
  const anyStats = rows.some((r) => r.mine);

  return (
    <Shell
      footer={
        <div style={{ marginTop: 22, color: C.dim, fontSize: 12, textAlign: "center", lineHeight: 1.7 }}>
          Published by your coach{card?.publishedAt ? ` ${new Date(card.publishedAt).toLocaleString()}` : ""}.
          <br />
          New stats show up here the next time your coach publishes.
          <br />
          <button
            onClick={onForget}
            style={{
              marginTop: 10,
              background: "none",
              border: `1px solid ${C.line}`,
              color: C.dim,
              borderRadius: 999,
              padding: "7px 14px",
              fontSize: 12,
            }}
          >
            Use a different code
          </button>
          <div style={{ marginTop: 10 }}>v{APP_VERSION}</div>
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ color: C.dim, fontSize: 13 }}>{card?.teamName || "My team"}</div>
          <h1 style={{ fontSize: 26, margin: "4px 0 0", letterSpacing: -0.4 }}>
            {card?.player?.num ? (
              <span style={{ color: C.accent, marginRight: 8 }}>#{card.player.num}</span>
            ) : null}
            {card?.player?.name || "My stats"}
          </h1>
        </div>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            background: C.card,
            border: `1px solid ${C.line}`,
            color: refreshing ? C.dim : C.text,
            borderRadius: 999,
            padding: "8px 13px",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
        >
          {refreshing ? "…" : "Refresh"}
        </button>
      </div>

      <Panel
        title="Season so far"
        note={
          anyStats
            ? "Your totals for the season, with the whole team's beside them."
            : "No stats recorded for you yet this season — your coach publishes these after matches."
        }
      >
        {rows.length ? (
          <StatTable rows={rows} />
        ) : (
          <div style={{ color: C.dim, fontSize: 14 }}>Nothing published yet.</div>
        )}
      </Panel>

      <Panel
        title={`By match${matches.length ? ` (${matches.length})` : ""}`}
        note={
          matches.length
            ? unattached
              ? "Tap a match to see your stats from it. Some of your stats aren't tied to a particular match yet, so these add up to less than your season totals."
              : "Tap a match to see your stats from it."
            : null
        }
      >
        {matches.length ? (
          matches.map((m, i) => (
            <MatchRow
              key={`${m?.date || ""}-${m?.opponent || ""}-${i}`}
              match={m}
              keys={keys}
              open={openIdx === i}
              onToggle={() => setOpenIdx(openIdx === i ? -1 : i)}
            />
          ))
        ) : (
          <div style={{ color: C.dim, fontSize: 14 }}>No matches with your stats in them yet.</div>
        )}
      </Panel>

      <div style={{ marginTop: 14, color: C.dim, fontSize: 12 }}>
        Code <b style={{ color: C.text }}>{code}</b> — keep it to yourself.
      </div>
    </Shell>
  );
}

function AppInner() {
  const [code, setCode] = useState(() => readStoredCode());
  const [card, setCard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Deep link: a coach can text `…/?code=32JB-K4P` instead of asking a
  // 14-year-old to type it. Same idea as the team-code deep link the other
  // two apps carry. Stripped from the URL once consumed so the code isn't
  // sitting in a shared screenshot of the address bar forever.
  const deepLink = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("code") || "";
    } catch {
      return "";
    }
  }, []);

  const lookUp = useCallback(async (raw, { quiet = false } = {}) => {
    const candidates = codeCandidates(raw);
    if (!candidates.length) return;
    setBusy(true);
    if (!quiet) setError("");
    try {
      for (const candidate of candidates) {
        const snap = await getDoc(doc(db, "playerAccess", candidate));
        if (snap.exists()) {
          setCard(snap.data());
          setCode(candidate);
          writeStoredCode(candidate);
          setError("");
          setBusy(false);
          return;
        }
      }
      // Not found. Say which half of it might be wrong without guessing which
      // — a player with a mistyped code and a player whose coach revoked
      // access see the same thing, and both next steps are "ask the coach".
      setError(
        "That code didn't match anything. Check it against what your coach gave you — if it looks right, ask your coach to publish stats again."
      );
      if (!quiet) setCard(null);
    } catch (err) {
      setError(
        `Couldn't reach your stats${err?.code ? ` (${err.code})` : ""}. If you're offline, try again once you have signal.`
      );
    }
    setBusy(false);
  }, []);

  // One effect for both ways in: a code in the URL, or one this device has
  // used before.
  useEffect(() => {
    const first = deepLink || readStoredCode();
    if (!first) return;
    lookUp(first, { quiet: true });
    if (deepLink) {
      try {
        window.history.replaceState({}, "", window.location.pathname);
      } catch {
        /* ignore */
      }
    }
  }, [deepLink, lookUp]);

  if (card) {
    return (
      <Card
        card={card}
        code={code}
        refreshing={busy}
        onRefresh={() => lookUp(code, { quiet: true })}
        onForget={() => {
          writeStoredCode("");
          setCard(null);
          setCode("");
          setError("");
        }}
      />
    );
  }

  return <CodeEntry onSubmit={lookUp} busy={busy} error={error} initial={code} />;
}

// Same reasoning as the other two apps' boundaries: this runs on phones with
// no console to open, so a crash has to show its own error text rather than a
// blank screen. Kept dependency-free — it must never be the thing that
// throws. No crash log here: there is nothing on this device worth keeping
// and nobody to read it back, so the text on screen is the whole report.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  clear = () => {
    try {
      if (navigator.serviceWorker?.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
      }
      if (window.caches?.keys) {
        window.caches.keys().then((ks) => ks.forEach((k) => window.caches.delete(k)));
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => window.location.reload(), 250);
  };
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, padding: 20, fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
        <pre style={{ whiteSpace: "pre-wrap", color: C.dim, fontSize: 13 }}>
          {String(this.state.error?.message || this.state.error)}
        </pre>
        <div style={{ color: C.dim, fontSize: 12 }}>v{APP_VERSION}</div>
        <button
          onClick={this.clear}
          style={{ marginTop: 14, padding: "12px 16px", borderRadius: 10, border: "none", background: C.accent, color: "#1a1206", fontWeight: 700 }}
        >
          Clear cached app & reload
        </button>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
