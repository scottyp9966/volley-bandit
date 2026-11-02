import React from "react";
import { ROMAN, SUB_LIMIT, TIMEOUT_LIMIT, other } from "./engine.js";

// The paper score sheet, drawn from a replayed set. Always black-on-white
// with the handbook's ink convention — the first time through the serving
// order in blue, the second in red, the third in blue again — because this
// is the document the officials sign, whatever theme the screen is in.
//
// Fixed at 1056 x 816 CSS px: a US Letter page in landscape at 96 dpi, so
// the PDF capture is one page per set with no scaling surprises. The screen
// preview scales the same element down to fit.

export const SHEET_W = 1056;
export const SHEET_H = 816;
const BLUE = "#1d3f9a";
const RED = "#c0262d";
const INK = "#111";
const RULE = "#222";
const FAINT = "#888";
const ink = (round) => (round % 2 === 0 ? RED : BLUE);
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function Tri({ children, color, size = 22, circled = false }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size - 2, alignItems: "flex-end", justifyContent: "center", verticalAlign: "middle" }}>
      <svg width={size} height={size - 2} viewBox="0 0 22 20" style={{ position: "absolute", inset: 0 }}>
        <polygon points="11,1.5 20.5,18.5 1.5,18.5" fill="none" stroke={color} strokeWidth="1.5" />
        {circled && <circle cx="11" cy="11" r="10" fill="none" stroke={color} strokeWidth="1.3" />}
      </svg>
      <span style={{ position: "relative", fontSize: 9.5, fontWeight: 700, lineHeight: "12px", color }}>{children}</span>
    </span>
  );
}

const boxed = (color, round = false) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  height: 18,
  padding: "0 2px",
  border: `1.5px solid ${color}`,
  borderRadius: round ? 999 : 1,
  fontSize: 11,
  fontWeight: 700,
  color,
  lineHeight: 1,
});

function Mark({ m }) {
  const c = ink(m.round);
  switch (m.k) {
    case "pt":
      return <span style={{ color: c, fontSize: 12, fontWeight: 600 }}>{m.n}</span>;
    case "box":
      return <span style={boxed(c)}>{m.n}</span>;
    case "circle":
      return <span style={boxed(c, true)}>{m.n}</span>;
    case "lor":
      return <span style={{ color: c, fontSize: 13, fontWeight: 800, letterSpacing: -1 }}>-|</span>;
    case "tri":
      return <Tri color={c} circled={m.circle}>{m.lor ? "-|" : m.n}</Tri>;
    case "sub":
      return (
        <span style={{ color: c, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
          S{m.x && <sub style={{ fontSize: 8 }}>x</sub>}
          {m.pairs.map((p, i) => (
            <span key={i} style={{ marginLeft: i ? 4 : 1 }}>
              <sup style={{ fontSize: 9 }}>{p.in}</sup>/<sub style={{ fontSize: 9 }}>{p.out}</sub>
            </span>
          ))}
        </span>
      );
    case "to":
      return (
        <span style={{ color: c, fontSize: 12, fontWeight: 700 }}>
          T{m.x && <sub style={{ fontSize: 8 }}>x</sub>}
        </span>
      );
    case "rs":
      return <span style={{ color: c, fontSize: 11, fontWeight: 700 }}>RS</span>;
    case "r":
      return <span style={{ color: c, fontSize: 11, fontWeight: 700 }}>R</span>;
    default:
      return null;
  }
}

function Slash({ color = INK }) {
  return (
    <svg viewBox="0 0 10 10" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <line x1="8.5" y1="1" x2="1.5" y2="9" stroke={color} strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RunCell({ n, type, round }) {
  const c = type ? ink(round || 1) : FAINT;
  const base = { position: "relative", width: 20, height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: type ? INK : FAINT, fontWeight: type ? 700 : 400 };
  if (type === "box") return <div style={base}><span style={{ ...boxed(c), minWidth: 16, height: 14, fontSize: 10, color: INK }}>{n}</span></div>;
  if (type === "circle") return <div style={base}><span style={{ ...boxed(c, true), minWidth: 15, height: 15, fontSize: 10, color: INK }}>{n}</span></div>;
  if (type === "tri" || type === "tri-circle")
    return <div style={base}><Tri color={c} size={20} circled={type === "tri-circle"}>{n}</Tri></div>;
  return (
    <div style={base}>
      {n}
      {type === "slash" && <Slash color={c} />}
    </div>
  );
}

function Numbers({ list, captain }) {
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0 5px" }}>
      {list.map((n, i) => {
        const last = i === list.length - 1;
        return (
          <span key={i} style={{ position: "relative", color: BLUE, fontSize: 13, fontWeight: 600 }}>
            {n || " "}
            {n && n === captain && <span style={{ fontSize: 10 }}>c</span>}
            {!last && <Slash color={BLUE} />}
          </span>
        );
      })}
    </span>
  );
}

// Tall enough to use the page; a row with more marks than fit just grows,
// and so does the page (see minHeight below) rather than clipping the footer.
const ROW_H = 68;

function TeamBlock({ t, set, st, name, align }) {
  const team = set.teams[t];
  const libs = st.liberos[t];
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", border: `1.5px solid ${RULE}` }}>
      <div style={{ display: "flex", borderBottom: `1.5px solid ${RULE}`, height: 34 }}>
        <div style={{ width: 34, fontSize: 8, padding: 2, borderRight: `1px solid ${RULE}`, lineHeight: 1.1 }}>Serve Order</div>
        <div style={{ width: 66, fontSize: 8, padding: 2, borderRight: `1px solid ${RULE}`, lineHeight: 1.1 }}>Player Number</div>
        <div style={{ flex: 1, padding: "2px 6px", borderRight: `1px solid ${RULE}`, minWidth: 0 }}>
          <div style={{ fontSize: 8 }}>Team</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: BLUE, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: align }}>{name}</div>
        </div>
        <div style={{ width: 54, padding: 2 }}>
          <div style={{ fontSize: 8 }}>Libero</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: BLUE }}>
            {team.noLibero ? "X" : <Numbers list={libs.length ? libs : [""]} />}
          </div>
        </div>
      </div>
      {st.rows[t].map((row, i) => (
        <div key={i} style={{ display: "flex", minHeight: ROW_H, borderBottom: i < 5 ? `1px solid ${RULE}` : "none" }}>
          <div style={{ width: 34, display: "flex", alignItems: "center", justifyContent: "center", borderRight: `1px solid ${RULE}`, fontWeight: 800, fontFamily: "Georgia, serif", fontSize: 14 }}>
            {row.liberoTri ? <Tri color={BLUE} size={30}>{ROMAN[i]}</Tri> : ROMAN[i]}
          </div>
          <div style={{ width: 66, padding: "4px 4px", borderRight: `1px solid ${RULE}`, display: "flex", alignItems: "flex-start" }}>
            <Numbers list={row.numbers} captain={team.captain} />
          </div>
          <div style={{ flex: 1, padding: "4px 6px", display: "flex", flexWrap: "wrap", alignContent: "flex-start", alignItems: "center", gap: "3px 6px" }}>
            {row.marks.map((m, k) => (
              <Mark key={k} m={m} />
            ))}
          </div>
        </div>
      ))}
      <div style={{ borderTop: `1.5px solid ${RULE}`, padding: "3px 6px", fontSize: 10, display: "flex", gap: 6, alignItems: "center" }}>
        <b>Subs:</b>
        {Array.from({ length: SUB_LIMIT }, (_, i) => (
          <span key={i} style={{ position: "relative", width: 14, textAlign: "center", color: i < st.subs[t] ? INK : FAINT }}>
            {i + 1}
            {i < st.subs[t] && <Slash color={BLUE} />}
          </span>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${RULE}`, padding: "3px 6px", minHeight: 52, fontSize: 11 }}>
        <b style={{ fontSize: 10 }}>Comments: </b>
        <span style={{ color: BLUE }}>{st.comments[t].map((c) => c.text).join(", ")}</span>
      </div>
    </div>
  );
}

export default function Sheet({ match, set, st, setIndex }) {
  const L = set.left;
  const R = other(L);
  const name = (t) => (t === "H" ? match.header.home : match.header.visitor) || (t === "H" ? "Home" : "Visitor");
  const cols = Math.max(2, Math.ceil(Math.max(32, st.score.H, st.score.V) / 16));
  const runCols = (t) =>
    Array.from({ length: cols }, (_, c) => (
      <div key={c} style={{ display: "flex", flexDirection: "column" }}>
        {Array.from({ length: 16 }, (_, r) => {
          const n = c * 16 + r + 1;
          return <RunCell key={n} n={n} type={st.run[t][n]} round={st.runRound[t][n]} />;
        })}
      </div>
    ));
  const h = match.header;
  const circled = (on) => ({ padding: "0 4px", borderRadius: 999, border: on ? `1.5px solid ${BLUE}` : "1.5px solid transparent" });
  const winner = set.ended ? (st.score.H > st.score.V ? "H" : "V") : null;
  const field = (label, value, w) => (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "baseline", marginRight: 14 }}>
      <span style={{ fontSize: 10, fontWeight: 700 }}>{label}:</span>
      <span style={{ minWidth: w, borderBottom: `1px solid ${RULE}`, color: BLUE, fontSize: 13, fontWeight: 600, padding: "0 4px" }}>{value || " "}</span>
    </span>
  );
  return (
    <div
      className="sheet-page"
      style={{ width: SHEET_W, minHeight: SHEET_H, background: "#fff", color: INK, fontFamily: FONT, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div style={{ textAlign: "center", fontSize: 17, fontWeight: 800, letterSpacing: 0.3 }}>Volleyball Score Sheet — NFHS</div>
      <div style={{ display: "flex", flexWrap: "wrap", rowGap: 4, alignItems: "baseline" }}>
        {field("Date", h.date, 80)}
        {field("Home", h.home, 150)}
        {field("Visitor", h.visitor, 150)}
        {field("Site", h.site, 120)}
        {field("Start Time", fmtTime(set.startTime), 64)}
        {field("End Time", fmtTime(set.endTime), 64)}
      </div>
      <div style={{ display: "flex", gap: 22, fontSize: 11, alignItems: "center" }}>
        <span>
          <b>Set Number: </b>
          {[1, 2, 3, 4, 5].slice(0, Math.max(match.bestOf || 5, set.number)).map((n) => (
            <span key={n} style={circled(n === set.number)}>{n}</span>
          ))}
        </span>
        <span>
          <b>Level: </b>
          {["Varsity", "JV", "Freshman", "Middle School"].map((l) => (
            <span key={l} style={circled(h.level === l)}>{l}</span>
          ))}
        </span>
        <span>
          {["Boys", "Girls"].map((g) => (
            <span key={g} style={circled(h.gender === g)}>{g}</span>
          ))}
        </span>
        <span style={{ marginLeft: "auto", color: FAINT }}>Set to {set.target}</span>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <TeamBlock t={L} set={set} st={st} name={name(L)} align="left" />
        <div style={{ display: "flex", flexDirection: "column", border: `1.5px solid ${RULE}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, textAlign: "center", borderBottom: `1px solid ${RULE}`, padding: 2 }}>First Serve</div>
          <div style={{ display: "flex", borderBottom: `1.5px solid ${RULE}`, height: 18 }}>
            {[L, R].map((t, i) => (
              <div key={t} style={{ flex: 1, textAlign: "center", fontWeight: 800, color: BLUE, borderLeft: i ? `1px solid ${RULE}` : "none" }}>{set.firstServe === t ? "X" : ""}</div>
            ))}
          </div>
          <div style={{ display: "flex", padding: "2px 3px", flex: 1 }}>
            <div style={{ display: "flex" }}>{runCols(L)}</div>
            <div style={{ width: 1, background: RULE, margin: "0 3px" }} />
            <div style={{ display: "flex" }}>{runCols(R)}</div>
          </div>
          <div style={{ borderTop: `1.5px solid ${RULE}`, fontSize: 9, fontWeight: 700, textAlign: "center", padding: 2 }}>Time Outs</div>
          <div style={{ display: "flex", borderTop: `1px solid ${RULE}` }}>
            {[L, R].map((t, i) => (
              <div key={t} style={{ flex: 1, borderLeft: i ? `1px solid ${RULE}` : "none" }}>
                {Array.from({ length: Math.max(TIMEOUT_LIMIT, st.timeouts[t].length) }, (_, k) => (
                  <div key={k} style={{ height: 22, borderTop: k ? `1px solid ${RULE}` : "none", fontSize: 11, fontWeight: 700, color: k >= TIMEOUT_LIMIT ? RED : BLUE, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {st.timeouts[t][k] || ""}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <TeamBlock t={R} set={set} st={st} name={name(R)} align="left" />
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: "auto", fontSize: 10 }}>
        <div style={{ flex: 1.2, border: `1.5px solid ${RULE}`, padding: "4px 8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 12px", alignItems: "center" }}>
          <div style={{ gridColumn: "1 / -1", fontWeight: 700 }}>Scorekeeping Key</div>
          <span><span style={boxed(INK, true)}>&nbsp;</span> = Penalty Point</span>
          <span><Tri color={INK} size={18}>{""}</Tri> = Libero Serve</span>
          <span><b>1</b> = Point &nbsp; <b>-|</b> = Loss of Rally</span>
          <span><span style={boxed(INK)}>1</span> = Loss of Rally Point</span>
          <span><b>R</b> = Replay &nbsp; <b>RS</b> = Re-Serve</span>
          <span><b>c</b> = Playing Captain</span>
          <span><b>S</b> = Sub &nbsp; <b>S<sub>x</sub></b> = Opponent Sub</span>
          <span><b>T</b> = Time-Out &nbsp; <b>T<sub>x</sub></b> = Opp. Time-Out</span>
        </div>
        <div style={{ flex: 1, border: `1.5px solid ${RULE}`, padding: "4px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            ["R1", h.r1],
            ["R2", h.r2],
            ["Scorekeeper", h.scorer],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 6 }}>
              <b style={{ width: 70 }}>{k}</b>
              <span style={{ flex: 1, borderBottom: `1px solid ${RULE}`, color: BLUE, fontSize: 12 }}>{v || " "}</span>
              {k === "R2" && <span style={{ width: 90, borderBottom: `1px solid ${RULE}`, color: FAINT }}>(verified)</span>}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, border: `1.5px solid ${RULE}`, padding: "4px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          <b>Set Results</b>
          {[
            ["Winning Team", winner],
            ["Losing Team", winner && other(winner)],
          ].map(([k, t]) => (
            <div key={k} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <b style={{ width: 80 }}>{k}</b>
              <span style={{ flex: 1, borderBottom: `1px solid ${RULE}`, color: BLUE, fontSize: 12 }}>{t ? name(t) : " "}</span>
              <b>Points</b>
              <span style={{ width: 34, borderBottom: `1px solid ${RULE}`, color: BLUE, fontSize: 12, textAlign: "center" }}>{t ? st.score[t] : " "}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
