// Handing a set's setup from the scorer's tablet to the libero tracker's
// tablet with a QR code — no network, no pairing, no accounts.
//
// The QR holds a URL: `<this app>/#track=<base64url JSON>`. A URL rather
// than bare data so it works two ways:
//   - the tracker's own Camera app can scan it and open the Score Sheet with
//     it (no in-app scanner needed at all);
//   - the app's Scan button reads the same code and imports it in place,
//     which matters on an iPad where the app is installed to the home
//     screen — there the Camera app would open Safari, whose storage is a
//     different place from the installed app's.
//
// What it carries: the match header, the format, and ONE set's setup — sides,
// first serve, target, both teams' six in serving order, liberos and
// captains. Jersey numbers only; no names. It's read off a screen in a gym.
//
// Short keys keep the QR small enough to scan from across a table.

import qrcode from "qrcode-generator";

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const str = (v, max = 60) => String(v ?? "").slice(0, max);
const jersey = (v) => String(v ?? "").replace(/[^0-9]/g, "").slice(0, 3);

export function encodeSetHandoff(match, set) {
  // One team as one short string — "4.2.6.1.8.7/10/12/0/10": the six in
  // serving order, L1, L2, no-libero flag, captain. Far denser than a JSON
  // object, and every byte saved is a less dense QR to scan across a table.
  const team = (t) => [t.lineup.map(jersey).join("."), jersey(t.libero), jersey(t.libero2), t.noLibero ? 1 : 0, jersey(t.captain)].join("/");
  const h = match.header;
  return {
    v: 1,
    sid: str(match.id, 40),
    h: { d: str(h.date, 10), ho: str(h.home), vi: str(h.visitor), si: str(h.site), lv: str(h.level, 20), g: str(h.gender, 10) },
    b: match.bestOf || 5,
    dt: match.decidingTarget || 15,
    s8: match.switchAt8 === false ? 0 : 1,
    n: set.number,
    lf: set.left,
    f: set.firstServe,
    t: set.target,
    T: { H: team(set.teams.H), V: team(set.teams.V) },
  };
}

// Returns null for anything that isn't a well-formed handoff, rather than
// throwing — a QR code from somewhere else must never break the app.
export function decodeSetHandoff(raw) {
  try {
    const d = typeof raw === "string" ? JSON.parse(b64urlDecode(raw)) : raw;
    if (!d || d.v !== 1 || !d.T || !d.T.H || !d.T.V) return null;
    const side = (s) => (s === "H" ? "H" : "V");
    const team = (t) => {
      const [six = "", l = "", l2 = "", x = "0", c = ""] = String(t).split("/");
      const u = six.split(".").map(jersey);
      if (u.length !== 6) throw new Error("lineup");
      return { lineup: u, libero: jersey(l), libero2: jersey(l2), noLibero: x === "1", captain: jersey(c) };
    };
    const n = Math.max(1, Math.min(5, Number(d.n) || 1));
    return {
      sourceId: str(d.sid, 40),
      header: { date: str(d.h?.d, 10), home: str(d.h?.ho), visitor: str(d.h?.vi), site: str(d.h?.si), level: str(d.h?.lv, 20) || "Varsity", gender: str(d.h?.g, 10) || "Girls" },
      bestOf: [3, 5].includes(Number(d.b)) ? Number(d.b) : 5,
      decidingTarget: [15, 25].includes(Number(d.dt)) ? Number(d.dt) : 15,
      switchAt8: d.s8 !== 0,
      set: { number: n, left: side(d.lf), firstServe: side(d.f), target: [15, 25].includes(Number(d.t)) ? Number(d.t) : 25, teams: { H: team(d.T.H), V: team(d.T.V) } },
    };
  } catch {
    return null;
  }
}

export function handoffUrl(payload, base = window.location.origin + window.location.pathname) {
  return `${base.replace(/\/$/, "")}/#track=${b64urlEncode(JSON.stringify(payload))}`;
}

// Pulls the payload out of anything a scanner might hand us: the full URL,
// or just the fragment.
export function handoffFromText(text) {
  const m = String(text || "").match(/track=([A-Za-z0-9_-]+)/);
  return m ? decodeSetHandoff(m[1]) : null;
}

// An SVG string for a QR code of `text`. Error correction M: survives a
// glare spot on a tablet screen without making the code much denser.
export function qrSvg(text, { size = "100%" } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const cells = count + quiet * 2;
  let path = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges"><rect width="${cells}" height="${cells}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
