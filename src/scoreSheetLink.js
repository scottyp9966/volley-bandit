// Builds the link that opens the Score Sheet app (scoresheet/) with this
// team's lineups already filled in. Pure — no React, no Firestore.
//
// WHAT THE LINK CARRIES, and why it's this little: a team name, the match's
// opponent/date/site, and per set the six JERSEY NUMBERS in serving order
// plus the libero and the captain. Never the team code, never a player's
// name. The scorer is often a parent volunteer or the other school's scorer,
// and this is exactly the kind of link that gets texted to them — see
// CLAUDE.md, "Nothing on an assistant device may show or carry the team
// code"; the same rule applies to anything that leaves the coach's hands.
// It rides in the URL #fragment, which browsers never send to a server.

export const SCORE_SHEET_URL = "https://volley-bandit-scoresheet.vercel.app";

// Serving order I..VI from a lineup's rotation-1 slots. The server is P1 and
// the rotation runs P2 -> P1, so a team that serves first is P1..P6 in order.
// A team that receives first serves first from right front (P2) — the
// handbook's "first server for the receiving team is physically in the right
// front position" — so its order starts at P2.
export function servingOrder(slots, servesFirst) {
  const ring = ["P1", "P2", "P3", "P4", "P5", "P6"];
  // Volley Bandit stores "us" (We Serve) or "opp" (We Receive); unset means "us".
  const order = servesFirst === "opp" ? [...ring.slice(1), ring[0]] : ring;
  return order.map((k) => slots?.[k] ?? null);
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// `rawSlots(lineup)` must return the lineup's rotation-1 starting slots
// (computeRawRotationSlots(lineup, 1) in App.jsx — raw, never with subs).
// `jersey(player, liberoIds)` resolves which number she wears that set.
export function buildScoreSheetPayload({ teamName, match, lineups, roster, captainIds = [], rawSlots, jersey }) {
  const byId = new Map((roster || []).map((p) => [p.id, p]));
  const numberOf = (id, liberoIds) => {
    const p = byId.get(id);
    if (!p) return "";
    const n = jersey(p, liberoIds);
    return n == null ? "" : String(n);
  };
  const sets = (lineups || [])
    .filter((l) => l && l.slots)
    .map((l) => {
      const liberoIds = (l.liberos || []).filter(Boolean);
      const ids = servingOrder(rawSlots(l), l.servesFirst);
      const captainId = [...ids, ...liberoIds].find((id) => id != null && captainIds.includes(id));
      return {
        set: Number(l.setNumber) || 1,
        order: ids.map((id) => (id == null ? "" : numberOf(id, liberoIds))),
        libero: liberoIds.length ? numberOf(liberoIds[0], liberoIds) : "",
        captain: captainId != null ? numberOf(captainId, liberoIds) : "",
      };
    })
    .sort((a, b) => a.set - b.set);
  // one lineup per set number — the first one wins, same as the Live screen
  const seen = new Set();
  const unique = sets.filter((s) => (seen.has(s.set) ? false : seen.add(s.set)));
  return {
    v: 1,
    team: teamName || "",
    opponent: match?.opponent || "",
    date: match?.date || "",
    homeAway: match?.homeAway === "Away" ? "Away" : "Home",
    location: match?.location || "",
    lineups: unique,
  };
}

export function scoreSheetUrl(payload, base = SCORE_SHEET_URL) {
  return `${base}/#import=${b64url(JSON.stringify(payload))}`;
}
