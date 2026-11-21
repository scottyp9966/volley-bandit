// Live, per-contact ratings — "that pass was a 2" — and the stats Volley
// Bandit records, summarised for Player Eval. Pure: no React, no Firestore,
// so it can be checked with a plain Node script (test/liveRatings.test.mjs).
//
// A rating entry is one document in teams/{code}/ratings/{id}:
//   { id, playerId, skill: "pass" | "serve", value, matchId, setNumber, at }
// One document per tap, never an array on a shared doc — two devices rating
// the same match would otherwise overwrite each other (the lesson Volley
// Bandit's stat log learned the hard way; see CLAUDE.md, "The stat log and
// the point log are Firestore COLLECTIONS").

// The two scales are the ones most programs and rating apps use. Pass is
// rated by what it leaves the setter; serve by what the other team could do
// with it, so a serve rating is the mirror of their pass rating.
export const SCALES = {
  pass: {
    label: "Pass",
    max: 3,
    noun: "pass",
    plural: "passes",
    values: [
      { v: 3, short: "Perfect", detail: "Setter has every option" },
      { v: 2, short: "Good", detail: "Setter has two options" },
      { v: 1, short: "Poor", detail: "One option, or a free ball back" },
      { v: 0, short: "Error", detail: "Aced, shanked or overpassed" },
    ],
  },
  serve: {
    label: "Serve",
    max: 4,
    noun: "serve",
    plural: "serves",
    values: [
      { v: 4, short: "Ace", detail: "Point on the serve" },
      { v: 3, short: "Tough", detail: "They pass poorly or free-ball it back" },
      { v: 2, short: "In play", detail: "They pass well, limited options" },
      { v: 1, short: "Easy", detail: "They pass perfectly" },
      { v: 0, short: "Error", detail: "Missed serve" },
    ],
  },
};

export const SKILL_KEYS = Object.keys(SCALES);

export function newRatingId(now = Date.now(), rnd = Math.random) {
  return `${now}-${Math.floor(rnd() * 1e9).toString(36)}`;
}

// A well-formed entry, or null. Anything read from Firestore goes through
// this, so a malformed document can't put NaN into an average.
export function cleanRating(e) {
  if (!e || !SCALES[e.skill]) return null;
  const v = Number(e.value);
  if (!Number.isInteger(v) || v < 0 || v > SCALES[e.skill].max) return null;
  return { ...e, value: v };
}

// count, average and how many of each value — for any subset of entries.
export function summarize(entries, skill) {
  const scale = SCALES[skill];
  const dist = Object.fromEntries(scale.values.map((x) => [x.v, 0]));
  let sum = 0;
  let count = 0;
  for (const e of entries) {
    if (e.skill !== skill) continue;
    dist[e.value] = (dist[e.value] || 0) + 1;
    sum += e.value;
    count += 1;
  }
  return { count, avg: count ? sum / count : null, dist, max: scale.max };
}

// Per player, for one skill, highest average first; players with no entries
// are left out.
export function byPlayer(entries, skill) {
  const groups = new Map();
  for (const e of entries) {
    if (e.skill !== skill) continue;
    if (!groups.has(e.playerId)) groups.set(e.playerId, []);
    groups.get(e.playerId).push(e);
  }
  return [...groups.entries()]
    .map(([playerId, list]) => ({ playerId, ...summarize(list, skill) }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
}

export const countOf = (n, skill) => `${n} ${n === 1 ? SCALES[skill].noun : SCALES[skill].plural}`;

export const fmtAvg = (avg) => (avg == null ? "–" : avg.toFixed(2));

// ---- Volley Bandit's recorded stats -------------------------------------
//
// Volley Bandit's stat log lives in teams/{code}/stats (one doc per entry),
// with older teams still carrying part of it as the `log` array in
// teams/{code}/data/logs until that device migrates. Read both and dedupe by
// id, exactly as Volley Bandit's own mergeEntries does, or a team mid-
// migration shows half its season.
export function mergeStatEntries(legacy, fromCollection) {
  const seen = new Set();
  const out = [];
  for (const e of [...(fromCollection || []), ...(legacy || [])]) {
    if (!e || e.id == null || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export const STAT_KEYS = [
  ["ace", "Aces"],
  ["serviceAtt", "Serve att."],
  ["serveErr", "Serve err"],
  ["kill", "Kills"],
  ["attackErr", "Attack err"],
  ["assist", "Assists"],
  ["dig", "Digs"],
  ["recErr", "Rec err"],
  ["passingErr", "Pass err"],
  ["blockSolo", "Solo blocks"],
  ["blockAst", "Block ast"],
  ["blockErr", "Block err"],
];

export function statTotals(entries) {
  const t = Object.fromEntries(STAT_KEYS.map(([k]) => [k, 0]));
  for (const e of entries) if (e && e.stat in t) t[e.stat] += 1;
  return t;
}

// The few lines worth reading at a glance. Volley Bandit records kills and
// attack errors but not total attempts, and passing errors but not total
// passes, so hitting % and passing % can't be computed from it — which is
// exactly the gap the live ratings fill. Serve % can, when attempts are
// recorded.
export function statHighlights(t) {
  const parts = [];
  if (t.kill || t.attackErr) parts.push(`${t.kill} K · ${t.attackErr} E`);
  if (t.serviceAtt) {
    const pct = Math.round(((t.serviceAtt - t.serveErr) / t.serviceAtt) * 100);
    parts.push(`${t.ace} ace · ${pct}% serve in`);
  } else if (t.ace || t.serveErr) parts.push(`${t.ace} ace · ${t.serveErr} serve err`);
  if (t.dig) parts.push(`${t.dig} dig`);
  if (t.recErr || t.passingErr) parts.push(`${t.recErr + t.passingErr} rec/pass err`);
  if (t.blockSolo || t.blockAst) parts.push(`${t.blockSolo + t.blockAst} blk`);
  if (t.assist) parts.push(`${t.assist} ast`);
  return parts;
}

// Entries since a moment (ms). Live ratings carry `at`; Volley Bandit stat
// ids are `Date.now() + Math.random()`, so the id is the timestamp.
export const ratingsSince = (entries, since) => entries.filter((e) => (e.at ?? 0) > since);
export const statsSince = (entries, since) => entries.filter((e) => Math.floor(Number(e.id) || 0) > since);

// Which match a coach opening the Live tab most likely means: the one
// Volley Bandit has active, else one dated today, else none (practice).
export function defaultMatchId(matches, activeMatchId, today) {
  if (activeMatchId != null && (matches || []).some((m) => m.id === activeMatchId)) return activeMatchId;
  const todays = (matches || []).find((m) => m.date === today);
  return todays ? todays.id : null;
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Practice ratings have no match; they're grouped by the local day they were
// recorded on instead, so "today's practice" is its own session.
export const dayOf = (ms) => todayISO(new Date(ms));
