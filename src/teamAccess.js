// Assistant access — a SECOND code that opens the same team with less of it.
//
// ─── THE SHAPE, AND WHY ─────────────────────────────────────────────────────
// Assistant mode used to be a switch on the device: the coach took the
// helper's phone, tapped "put this device in assistant mode", and a passcode
// turned it back off. Two things were wrong with that. The coach had to
// handle a device that isn't theirs — usually the team's tablet, handed to
// whoever is free that night — and the way OUT was a passcode while the way
// IN was a tap, which is backwards: restricting yourself needs no permission,
// un-restricting yourself is the thing worth gating.
//
// So the code IS the mode. There is one box on the join screen and it takes
// either code:
//
//     team code       -> full access, exactly as before
//     assistant code  -> the same team, limited to what the coach allows
//
// Nothing to toggle, nothing to turn off, and nothing for the coach to do on
// the helper's device. Getting full access means knowing the team code, which
// the helper was never given. The helper sets up their own device start to
// finish: URL -> app passcode -> assistant code -> in.
//
// ─── WHAT THIS BUYS, HONESTLY ───────────────────────────────────────────────
// `assistantAccess/{code}` has to hold the team code, or an assistant code
// couldn't resolve to a team. So the team code is recoverable by someone who
// opens devtools on the helper's device. Like everything else in this app
// before sign-in exists, this stops mis-taps and casual poking, not a
// determined person. Say that out loud rather than implying otherwise.

import { randomFrom } from "./randomCode.js";

// Same alphabet as team codes: no 0/O, no 1/I/L. It gets read off one screen
// and typed into another, often by someone who isn't invested in getting it
// right first time.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ASSISTANT_CODE_LENGTH = 6;

// Deliberately random, NOT derived from the team code. A derived code would
// hand the team code to anyone who worked out the pattern, which is the one
// thing this is supposed to hold back.
//
// Drawn from WebCrypto, not `Math.random` — see randomCode.js. `rng` is still
// accepted so a test can pin the output.
export function generateAssistantCode(rng) {
  return randomFrom(CODE_CHARS, ASSISTANT_CODE_LENGTH, rng);
}

// The tabs a coach can hand to an assistant. "live" is the reason the feature
// exists, so it can't be taken away — an assistant device with no Live tab
// has nothing to do.
export const ASSISTANT_TABS = [
  { key: "live", label: "Live (stat entry)", locked: true },
  { key: "box", label: "Stats" },
  { key: "schedule", label: "Schedule" },
  { key: "lineup", label: "Lineup" },
  { key: "roster", label: "Roster" },
  { key: "tourney", label: "Tourney" },
];

export const DEFAULT_ASSISTANT_TABS = ["live", "box"];

// Normalizer, same pattern as `entitlementsOf` and `ballotPicks`: a team doc
// written before this existed must read as something sensible rather than as
// an assistant device with no tabs at all.
//
// Note `tabs: []` is NOT the same as a missing field — a coach who unticks
// everything still gets Live, because `live` is forced back in below, but an
// absent field means "never configured" and falls back to the default pair.
export function assistantAccessOf(mainDoc) {
  const raw = mainDoc?.assistantAccess;
  const tabs = Array.isArray(raw?.tabs) ? raw.tabs : DEFAULT_ASSISTANT_TABS;
  const allowed = new Set(ASSISTANT_TABS.map((t) => t.key));
  const kept = tabs.filter((t) => allowed.has(t));
  // Live is never removable: see ASSISTANT_TABS.
  if (!kept.includes("live")) kept.unshift("live");
  return {
    tabs: kept,
    canScore: raw?.canScore === true,
  };
}

// The tab order the TabBar renders in, so an assistant's bar doesn't come out
// in whatever order the checkboxes were ticked.
export function orderTabs(keys) {
  const order = ASSISTANT_TABS.map((t) => t.key);
  return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
