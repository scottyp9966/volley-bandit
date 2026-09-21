import { useState, useEffect } from "react";

// Pulled out of App.jsx so a new module (TournamentBuilder.jsx) can reuse
// the theme tokens and a couple of small helpers without a circular import
// between App.jsx and that module.

export const DARK_COLORS = {
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
  accentSoft: "rgba(255,107,53,0.15)",
  greenSoft: "rgba(76,154,99,0.14)",
  redSoft: "rgba(193,68,60,0.14)",
  blueSoft: "rgba(62,124,166,0.14)",
  goldSoft: "rgba(255,200,87,0.12)",
  tintHex: "22",
};
export const LIGHT_COLORS = {
  bg: "#E8E8E6",
  bgRaised: "#FFFFFF",
  chalk: "#12261A",
  chalkDim: "#42604C",
  orange: "#155C2E", // primary accent — key name kept as "orange" everywhere it's referenced, value repurposed to green for this theme
  blue: "#2B6285",
  green: "#2E7D4F",
  red: "#A63A32",
  line: "#CBD1CA",
  gold: "#8A6508",
  accentSoft: "rgba(21,92,46,0.24)",
  greenSoft: "rgba(46,125,79,0.26)",
  redSoft: "rgba(166,58,50,0.24)",
  blueSoft: "rgba(43,98,133,0.24)",
  goldSoft: "rgba(138,101,8,0.24)",
  tintHex: "40",
};

// A mutable object (never reassigned, just mutated via Object.assign) so
// every component that reads COLORS.xxx at render time picks up a theme
// switch automatically. See App.jsx's theme toggle — anything that reads
// this at MODULE scope instead of render time freezes the dark palette
// forever, which bit STAT_BUTTONS once; don't repeat that here.
export let COLORS = { ...DARK_COLORS };

// Persist state to localStorage so nothing is lost when the tab closes or
// the phone loses signal.
export function usePersisted(key, initialValue) {
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

// Short display form used everywhere except the roster add/edit form itself —
// "First L." rather than the full last name, to keep lists and slots compact.
export const displayName = (p) => {
  if (!p) return "";
  const last = (p.lastName || "").trim();
  return last ? `${p.firstName} ${last.charAt(0).toUpperCase()}.` : p.firstName || "";
};

export const fullName = (p) => (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "");
