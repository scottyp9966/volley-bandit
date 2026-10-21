// Player Access — the read-only stats a player can look up for herself.
//
// Pure module: no React, no Firestore, no COLORS. Everything here is a
// function of plain data, which is what makes it testable with a plain Node
// script (see CLAUDE.md's "On testing" — that matters more than it sounds).
//
// ─── WHAT A PLAYER CAN REACH ────────────────────────────────────────────────
// A published document holds ONE player's numbers plus TEAM TOTALS, and
// nothing else. No roster, no other player's line, no lineups, no schedule,
// and above all no team code — the team code is the writable key to
// everything, so it must never travel into something handed to a teenager.
// If you add a field here, ask what a stranger holding one leaked code learns
// from it.
//
// ─── WHY A SEPARATE TOP-LEVEL COLLECTION ────────────────────────────────────
// Published docs live at `playerAccess/{code}`, NOT under `teams/{code}/…`.
// Three reasons, and the third is the one that will matter later:
//   1. The player app can resolve a code with a single read and no knowledge
//      of which team the player is on.
//   2. Security rules can make this one path world-readable without making
//      any part of the team's own data readable.
//   3. It can be billed, gated or revoked on its own, without touching team
//      data — see `entitlementsOf` below.
//
// ─── CODES ──────────────────────────────────────────────────────────────────
// Because one URL serves every organisation, a code is a GLOBAL name, so two
// teams must never generate the same one. `generateCodes` is given the codes
// already taken and never reissues one.
//
// The coach picks the style. Both are offered because they trade different
// things, and the coach is the one who knows their team:
//   "random"  — unguessable, has to be handed out.
//   "jersey"  — #32 + initials ("32JB"), easy to re-tell a player who lost
//               hers, but ANY TEAMMATE CAN GUESS IT. That is not a subtle
//               risk, it is arithmetic: a roster is public, so every code on
//               the team is derivable the moment one player sees the pattern.
//   "hybrid"  — jersey + initials + a random tail ("32JB-K4P"). Still
//               derivable by the coach from the roster, not guessable by a
//               teammate. This is the recommended middle ground.
// `CODE_STYLE_NOTES` carries that warning into the UI so the choice is made
// with the trade-off visible, not buried here.

import { randomFrom } from "./randomCode.js";

// No 0/O/1/I/L/5/S — a code gets read off a screen and typed by a 14-year-old.
const CODE_ALPHABET = "23467989ABCDEFGHJKMNPQRTUVWXYZ";
// Six characters, not four. Four is ~1M combinations, which is plenty for one
// team but collides fast once this serves many organisations from one URL
// (a few thousand live codes and near-certain collisions). Six is ~1.07
// billion and still short enough to type.
export const CODE_LENGTH = 6;
export const RANDOM_TAIL = 3;

export const CODE_STYLES = ["random", "hybrid", "jersey"];
export const CODE_STYLE_NOTES = {
  random: {
    label: "Random code",
    detail: "Six characters, e.g. K4P9TM. Unguessable; you hand it out once.",
  },
  hybrid: {
    label: "Jersey + initials + tail",
    detail: "e.g. 32JB-K4P. You can look it up from the roster, a teammate can't guess it.",
  },
  jersey: {
    label: "Jersey + initials",
    detail: "e.g. 32JB. Easy to re-tell — but any teammate can work out everyone else's.",
  },
};

// WebCrypto, not Math.random — see randomCode.js for why that matters when a
// whole roster's codes come out of one generator and every one of them is
// handed to a teenager.
function randomChars(n, rng) {
  return randomFrom(CODE_ALPHABET, n, rng);
}

// Initials from whatever the roster actually holds. A player with no last
// name still gets something rather than an empty string.
function initialsOf(player) {
  const a = (player?.firstName || "").trim()[0] || "";
  const b = (player?.lastName || "").trim()[0] || "";
  return (a + b).toUpperCase() || "X";
}

export function codeFor(player, style, taken, rng) {
  const num = String(player?.num ?? "").replace(/[^0-9A-Za-z]/g, "") || "0";
  const base =
    style === "jersey" ? `${num}${initialsOf(player)}`
    : style === "hybrid" ? `${num}${initialsOf(player)}-${randomChars(RANDOM_TAIL, rng)}`
    : randomChars(CODE_LENGTH, rng);
  if (!taken.has(base)) return base;
  // A collision. For the derivable styles that means two players share a
  // jersey+initials (it happens), so they need distinguishing; for random it
  // is just bad luck. Either way: extend with more entropy until it's free,
  // rather than silently handing two players the same code.
  for (let i = 0; i < 50; i += 1) {
    const candidate = style === "random"
      ? randomChars(CODE_LENGTH, rng)
      : `${base}${style === "hybrid" ? "" : "-"}${randomChars(2, rng)}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological: fall back to something certain to be unique.
  return `${base}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

// Codes for everyone on the roster who doesn't already have one. Existing
// codes are KEPT: reissuing would silently invalidate a code a player has
// already been given, with no sign anything changed.
export function generateCodes(roster, style, existing = [], globallyTaken = [], rng) {
  const byPlayer = new Map(existing.filter((e) => e && e.code).map((e) => [e.playerId, e.code]));
  const taken = new Set([...globallyTaken, ...byPlayer.values()]);
  const out = [];
  (roster || []).forEach((p) => {
    const already = byPlayer.get(p.id);
    if (already) {
      out.push({ playerId: p.id, code: already });
      return;
    }
    const code = codeFor(p, style, taken, rng);
    taken.add(code);
    out.push({ playerId: p.id, code });
  });
  return out;
}

// ─── ENTITLEMENTS ───────────────────────────────────────────────────────────
// The seam for charging later. Nothing is gated TODAY — every feature reads
// as on — but every paid-upgrade candidate reads through this one function,
// so turning billing on later is a change to this normalizer and a field on
// the team doc, not a hunt through the app.
//
// Treat a missing field as ON, never OFF: a team whose document predates
// billing must not silently lose a feature it has been using, and a failed
// read must never lock a coach out mid-match.
export function entitlementsOf(mainDoc) {
  const e = mainDoc?.entitlements || {};
  return {
    plan: e.plan || "free",
    playerAccess: e.playerAccess !== false,
    playerEval: e.playerEval !== false,
  };
}

// ─── THE PUBLISHED SNAPSHOT ─────────────────────────────────────────────────
// Built from the same stat log the box score reads, so a published number and
// an on-screen number cannot disagree.
//
// Shape note, and it is load-bearing: Firestore REJECTS an array that directly
// contains another array (see CLAUDE.md). `matches` is an array of maps and
// every stat bundle is a map, so nothing here nests an array in an array.
// "Joy B." — enough for a player to confirm she opened her own card, and no
// more. Deliberately not `fullName`: a published document is the one thing
// here a stranger might hold, so it carries a first name and an initial, not
// a full name that identifies a minor off the team.
function shortName(player) {
  const first = (player?.firstName || "").trim();
  const initial = (player?.lastName || "").trim()[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

export function buildPublishedDoc({ player, teamName, codes, log, matches, statKeys, now = Date.now() }) {
  const keys = statKeys && statKeys.length ? statKeys : [];
  const tally = (entries) => {
    const out = {};
    entries.forEach((e) => {
      if (keys.length && !keys.includes(e.stat)) return;
      out[e.stat] = (out[e.stat] || 0) + 1;
    });
    return out;
  };
  const mine = (log || []).filter((e) => e.playerId === player.id);
  const byMatch = new Map((matches || []).map((m) => [m.id, m]));

  // Per match, most recent first — and only matches that actually have a
  // record. A scheduled match nobody played should not show up as a row of
  // zeroes on a player's phone.
  const perMatch = [];
  const matchIds = [...new Set(mine.map((e) => e.matchId).filter((id) => id != null))];
  matchIds.forEach((id) => {
    const m = byMatch.get(id);
    if (!m) return; // stats whose match was deleted stay out of a player's view
    perMatch.push({
      date: m.date || "",
      opponent: m.opponent || "",
      stats: tally(mine.filter((e) => e.matchId === id)),
    });
  });
  perMatch.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Note what is deliberately absent and must stay absent: the team code, the
  // roster, any other player's code, a full last name. Don't express that as
  // an explicit `codes: undefined` — Firestore rejects an undefined field
  // value outright (`Unsupported field value: undefined`), which failed every
  // write of every document in the batch. That shipped, and publishing never
  // worked until it was removed.
  return {
    v: 1,
    teamName: teamName || "",
    // Enough to confirm she opened her own card, and no more. No last name in
    // full, no contact details, nothing that identifies her off the team.
    player: { name: shortName(player), num: String(player.num ?? "") },
    season: tally(mine),
    teamSeason: tally(log || []),
    matches: perMatch,
    statKeys: keys,
    publishedAt: now,
  };
}

// Every published document for a team, keyed by the code that opens it.
export function buildPublishedSet({ roster, codes, teamName, log, matches, statKeys, now = Date.now() }) {
  const byPlayer = new Map((codes || []).map((c) => [c.playerId, c.code]));
  const out = {};
  (roster || []).forEach((p) => {
    const code = byPlayer.get(p.id);
    if (!code) return;
    out[code] = buildPublishedDoc({ player: p, teamName, log, matches, statKeys, now });
  });
  return out;
}
