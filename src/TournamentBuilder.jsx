import React, { useState, useMemo, forwardRef, useImperativeHandle, useEffect } from "react";
import { ChevronLeft, Check, RotateCcw, X } from "lucide-react";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import { COLORS, usePersisted, displayName } from "./shared.js";
import { computeRoundPlan, planTeamLayout, generateSchedule } from "./tournamentLogic.js";

// PDF export follows the same pattern as handlePrint/PrintArea in App.jsx
// (see CLAUDE.md's "Read this before touching print/PDF code"): a
// display:none-except-while-capturing root, html2canvas + jsPDF, and the
// share-sheet-with-download-fallback delivery — window.print()/alert() are
// avoidably unreliable inside an installed iOS PWA, so this deliberately
// doesn't use either. Kept self-contained here rather than added to the
// main PrintArea/handlePrint, since this component's data (schedule,
// points) has nothing to do with the roster/lineup/match print targets
// those already handle. UNLIKE the main app's print (which forces one PDF
// page per repeating section), this captures the whole sheet as ONE
// element — it's meant to be a single at-a-glance reference card, not a
// paginated document, so it must stay one page. Keep the printable layout
// dense (small type, real names inline, no per-round page breaks) so it
// actually does.
const PRINT_ROOT_ID = "tourney-print-root";

// The print icon lives in App.jsx's shared TopBar (next to Settings, same
// as every other tab), not inside this component's own content — but the
// print logic and its schedule/points data live here. This ref is how
// App.jsx triggers it without either side needing to know the other's
// internals: forwardRef + useImperativeHandle exposes just `.print()`,
// and `onPrintingChange` reports the in-flight/error state back up so the
// TopBar button can show the same spinner/disabled state every other
// print button does.

// "King & Queen of the Court" tournament generator — see
// tournament-builder-spec.md this was built from. Deliberately local-only
// (usePersisted / localStorage), not synced through the team's Firestore
// doc: it's a same-practice, same-device tool the coach runs live, and
// keeping it out of `main` sidesteps the nested-array Firestore gotcha
// documented in CLAUDE.md (this module's schedule data is arrays of arrays
// of player indices) as well as the Player Eval data-sharing contract on
// `roster`/`lineups`/`activeLineupId`. If this ever needs to sync across
// devices, it needs its own doc, not a bolt-on to `main`.

const TEAM_SIZE_OPTIONS = ["auto", 3, 4, 5, 6];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split(""); // skip I/O, same reasoning as the team-code alphabet

const initialState = {
  step: "setup", // "setup" | "strategy" | "schedule"
  config: {
    attendingIds: [],
    guests: [], // players from another team practicing together — not on this team's roster, so kept here rather than written to it
    courts: 2,
    totalMinutes: 45,
    targetRoundLength: 7,
    teamSizePref: "auto",
  },
  layout: null,
  playerOrder: [], // roster ids, index-stable for the life of this tournament
  letterFor: {}, // roster id -> display letter
  schedule: null, // { rounds, stats, strategy }
  winners: {}, // "r-c" -> "A" | "B"
  manualAdjustments: {}, // playerId -> point delta, layered on top of the tap-to-record tally (corrections/ties)
  error: null,
};

function cardStyle() {
  return {
    background: COLORS.bgRaised,
    border: `1px solid ${COLORS.line}`,
    borderRadius: 14,
    padding: 14,
  };
}

function labelStyle() {
  return { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: COLORS.chalkDim, marginBottom: 6 };
}

function numberInputStyle() {
  return {
    width: "100%",
    background: COLORS.bg,
    border: `1px solid ${COLORS.line}`,
    borderRadius: 8,
    color: COLORS.chalk,
    padding: "10px 12px",
    fontSize: 15,
  };
}

function primaryButtonStyle(disabled) {
  return {
    width: "100%",
    padding: "13px",
    borderRadius: 10,
    border: "none",
    background: disabled ? COLORS.line : COLORS.orange,
    color: disabled ? COLORS.chalkDim : "#fff",
    fontWeight: 700,
    fontSize: 15,
    cursor: disabled ? "default" : "pointer",
  };
}

function pointStepperButtonStyle() {
  return {
    width: 24,
    height: 24,
    borderRadius: 6,
    border: `1px solid ${COLORS.line}`,
    background: COLORS.bg,
    color: COLORS.chalk,
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

const TournamentBuilder = forwardRef(function TournamentBuilder({ roster, onPrintingChange, onReadyChange }, ref) {
  const [state, setState] = usePersisted("vb-tournament", initialState);
  const { step, config, layout, playerOrder, letterFor, schedule, winners, error } = state;
  const manualAdjustments = state.manualAdjustments || {};
  const guests = config.guests || [];
  const [guestName, setGuestName] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(null);

  useEffect(() => {
    onPrintingChange?.(printing);
  }, [printing, onPrintingChange]);

  // The TopBar print icon only makes sense once there's a schedule to
  // print — tells App.jsx whether to show it at all, same idea as
  // onPrintingChange above.
  useEffect(() => {
    onReadyChange?.(!!schedule);
  }, [schedule, onReadyChange]);

  const patch = (fields) => setState((s) => ({ ...s, ...fields }));
  const patchConfig = (fields) => setState((s) => ({ ...s, config: { ...s.config, ...fields } }));

  const toggleAttending = (id) => {
    patchConfig({
      attendingIds: config.attendingIds.includes(id)
        ? config.attendingIds.filter((x) => x !== id)
        : [...config.attendingIds, id],
    });
  };

  const addGuest = () => {
    const trimmed = guestName.trim();
    if (!trimmed) return;
    const [firstName, ...rest] = trimmed.split(" ");
    const guest = { id: -Date.now(), firstName, lastName: rest.join(" "), guest: true };
    patchConfig({ guests: [...guests, guest], attendingIds: [...config.attendingIds, guest.id] });
    setGuestName("");
  };

  const removeGuest = (id) => {
    patchConfig({
      guests: guests.filter((g) => g.id !== id),
      attendingIds: config.attendingIds.filter((x) => x !== id),
    });
  };

  const startOver = () => setState(initialState);

  const buildLayout = () => {
    const attending = [...roster, ...guests].filter((p) => config.attendingIds.includes(p.id));
    if (attending.length < 4) {
      patch({ error: "Check off at least 4 players before generating a tournament." });
      return;
    }
    const roundPlan = computeRoundPlan(config.totalMinutes, config.targetRoundLength);
    if (roundPlan.numRounds < 1) {
      patch({ error: "That's not enough practice time for even one round at this round length." });
      return;
    }
    const teamSizePref = config.teamSizePref === "auto" ? "auto" : Number(config.teamSizePref);
    const computedLayout = planTeamLayout(attending.length, config.courts, teamSizePref);
    const order = attending.map((p) => p.id);
    const letters = {};
    order.forEach((id, i) => {
      letters[id] = i < LETTERS.length ? LETTERS[i] : `${LETTERS[i % LETTERS.length]}${Math.floor(i / LETTERS.length) + 1}`;
    });

    if (computedLayout.fitsStandard) {
      finalizeSchedule(order, letters, roundPlan, computedLayout, "standard", computedLayout.teamSize);
      return;
    }
    if (computedLayout.strategies.length === 0) {
      patch({
        error: `No workable layout for ${attending.length} players on ${config.courts} court${config.courts > 1 ? "s" : ""}. Try a different team size or court count.`,
      });
      return;
    }
    patch({ playerOrder: order, letterFor: letters, layout: { ...computedLayout, roundPlan }, step: "strategy", error: null });
  };

  const chooseStrategy = (strategyOpt) => {
    finalizeSchedule(playerOrder, letterFor, layout.roundPlan, layout, strategyOpt.key, strategyOpt.teamSize);
  };

  const finalizeSchedule = (order, letters, roundPlan, layoutResult, strategyKey, teamSize) => {
    const result = generateSchedule({
      playerCount: order.length,
      teamSize,
      numRounds: roundPlan.numRounds,
      courts: config.courts,
      strategy: strategyKey,
    });
    setState((s) => ({
      ...s,
      playerOrder: order,
      letterFor: letters,
      layout: { ...layoutResult, roundPlan, teamSize },
      schedule: result,
      winners: {},
      step: "schedule",
      error: null,
    }));
  };

  const playerById = useMemo(() => {
    const map = {};
    roster.forEach((p) => (map[p.id] = p));
    guests.forEach((p) => (map[p.id] = p));
    return map;
  }, [roster, guests]);

  const playerAt = (idx) => playerById[playerOrder[idx]];

  const recordWinner = (roundIdx, courtIdx, side) => {
    const key = `${roundIdx}-${courtIdx}`;
    patch({ winners: { ...winners, [key]: winners[key] === side ? null : side } });
  };

  const points = useMemo(() => {
    const tally = {};
    playerOrder.forEach((id) => (tally[id] = 0));
    if (schedule) {
      schedule.rounds.forEach((round, r) => {
        round.courts.forEach((court, c) => {
          const side = winners[`${r}-${c}`];
          if (!side) return;
          const winningTeam = side === "A" ? court.teamA : court.teamB;
          winningTeam.forEach((idx) => {
            const id = playerOrder[idx];
            tally[id] = (tally[id] || 0) + 1;
          });
        });
      });
    }
    playerOrder.forEach((id) => {
      tally[id] = (tally[id] || 0) + (manualAdjustments[id] || 0);
    });
    return tally;
  }, [schedule, winners, playerOrder, manualAdjustments]);

  // Standings update automatically from the tap-to-record winners above —
  // this is a manual layer on top for corrections/ties/forfeits, since a
  // coach reading this one-handed during a match needs a way to fix a
  // mis-tap without re-deciding who won the whole round.
  const adjustPoints = (id, delta) => {
    patch({ manualAdjustments: { ...manualAdjustments, [id]: (manualAdjustments[id] || 0) + delta } });
  };

  const standings = useMemo(
    () =>
      playerOrder
        .map((id) => ({ player: playerById[id], points: points[id] || 0 }))
        .filter((row) => row.player)
        .sort((a, b) => b.points - a.points || displayName(a.player).localeCompare(displayName(b.player))),
    [playerOrder, points, playerById]
  );

  const handlePrintBracket = async () => {
    if (printing || !schedule) return;
    setPrinting(true);
    setPrintError(null);
    const root = document.getElementById(PRINT_ROOT_ID);
    const forceCleanupTimer = setTimeout(() => {
      root?.classList.remove("tourney-print-root-capturing");
      setPrinting(false);
    }, 20000);
    try {
      root.classList.add("tourney-print-root-capturing");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const pdf = new jsPDF("p", "pt", "letter");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const MARGIN = 26;
      const contentWidth = pageWidth - MARGIN * 2;
      const contentHeight = pageHeight - MARGIN * 2;

      // One continuous capture, not one-page-per-round — this is meant to
      // be a single at-a-glance reference sheet. It only overflows onto a
      // second page if the content genuinely doesn't fit (very high round
      // or player counts); the printable layout below is kept dense
      // specifically so that doesn't normally happen.
      const canvas = await html2canvas(root, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
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
      const filename = `tournament-bracket-${dateStr}.pdf`;
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
          if (shareErr.name !== "AbortError") downloadDirectly();
        }
      } else {
        downloadDirectly();
      }
    } catch (err) {
      // In-app error line rather than alert() — the exact iOS-standalone-PWA
      // hazard CLAUDE.md flags for the main app's own PDF-failure alert().
      setPrintError(`Couldn't generate the PDF: ${err?.message || err}`);
    } finally {
      clearTimeout(forceCleanupTimer);
      root?.classList.remove("tourney-print-root-capturing");
      setPrinting(false);
    }
  };

  useImperativeHandle(ref, () => ({ print: handlePrintBracket }));

  if (step === "setup") {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
        <div style={cardStyle()}>
          <div style={labelStyle()}>Who's here today</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => patchConfig({ attendingIds: [...roster, ...guests].map((p) => p.id) })}
              style={{ fontSize: 12, color: COLORS.orange, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}
            >
              Select all
            </button>
            <button
              onClick={() => patchConfig({ attendingIds: [] })}
              style={{ fontSize: 12, color: COLORS.chalkDim, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}
            >
              Clear
            </button>
          </div>
          {roster.length === 0 && <div style={{ color: COLORS.chalkDim, fontSize: 13 }}>No players on the roster yet — add some on the Roster tab first.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {roster.map((p) => {
              const checked = config.attendingIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggleAttending(p.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: `1px solid ${checked ? COLORS.orange : COLORS.line}`,
                    background: checked ? COLORS.accentSoft : "transparent",
                    color: COLORS.chalk,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `1.5px solid ${checked ? COLORS.orange : COLORS.chalkDim}`,
                      background: checked ? COLORS.orange : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {checked && <Check size={13} color="#fff" strokeWidth={3} />}
                  </div>
                  <span style={{ fontSize: 14 }}>
                    #{p.num} {displayName(p)}
                  </span>
                </button>
              );
            })}
            {guests.map((p) => {
              const checked = config.attendingIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: `1px solid ${checked ? COLORS.orange : COLORS.line}`,
                    background: checked ? COLORS.accentSoft : "transparent",
                  }}
                >
                  <button
                    onClick={() => toggleAttending(p.id)}
                    style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: `1.5px solid ${checked ? COLORS.orange : COLORS.chalkDim}`,
                        background: checked ? COLORS.orange : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {checked && <Check size={13} color="#fff" strokeWidth={3} />}
                    </div>
                    <span style={{ fontSize: 14, color: COLORS.chalk }}>
                      {displayName(p)} <span style={{ color: COLORS.chalkDim, fontSize: 11 }}>(guest)</span>
                    </span>
                  </button>
                  <button
                    onClick={() => removeGuest(p.id)}
                    title="Remove guest"
                    style={{ background: "none", border: "none", color: COLORS.chalkDim, cursor: "pointer", padding: 4, flexShrink: 0 }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              type="text"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addGuest();
              }}
              placeholder="Add a guest (JV2, Varsity, etc.)"
              style={{ ...numberInputStyle(), flex: 1 }}
            />
            <button onClick={addGuest} style={{ ...primaryButtonStyle(!guestName.trim()), width: 72 }}>
              Add
            </button>
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={labelStyle()}>Courts available</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => patchConfig({ courts: Math.max(1, config.courts - 1) })}
              style={{ ...primaryButtonStyle(false), width: 40, padding: "8px 0" }}
            >
              −
            </button>
            <div style={{ fontSize: 20, fontWeight: 700, minWidth: 24, textAlign: "center" }}>{config.courts}</div>
            <button onClick={() => patchConfig({ courts: config.courts + 1 })} style={{ ...primaryButtonStyle(false), width: 40, padding: "8px 0" }}>
              +
            </button>
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={labelStyle()}>Total practice time (minutes)</div>
          <input
            type="number"
            value={config.totalMinutes}
            onChange={(e) => patchConfig({ totalMinutes: Number(e.target.value) || 0 })}
            style={numberInputStyle()}
          />
        </div>

        <div style={cardStyle()}>
          <div style={labelStyle()}>Target round length (minutes)</div>
          <input
            type="number"
            value={config.targetRoundLength}
            onChange={(e) => patchConfig({ targetRoundLength: Number(e.target.value) || 0 })}
            style={numberInputStyle()}
          />
          <div style={{ fontSize: 12, color: COLORS.chalkDim, marginTop: 6 }}>
            {(() => {
              const plan = computeRoundPlan(config.totalMinutes, config.targetRoundLength);
              return `${plan.numRounds} round${plan.numRounds === 1 ? "" : "s"} · ${plan.totalTimeUsed} of ${config.totalMinutes} min used (1 min buffer between rounds)`;
            })()}
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={labelStyle()}>Team size</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TEAM_SIZE_OPTIONS.map((opt) => {
              const active = config.teamSizePref === opt;
              return (
                <button
                  key={opt}
                  onClick={() => patchConfig({ teamSizePref: opt })}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: `1px solid ${active ? COLORS.orange : COLORS.line}`,
                    background: active ? COLORS.accentSoft : "transparent",
                    color: COLORS.chalk,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div style={{ color: COLORS.red, fontSize: 13, fontWeight: 600, padding: "0 2px" }}>{error}</div>
        )}

        <button onClick={buildLayout} style={primaryButtonStyle(false)}>
          Generate Tournament
        </button>
      </div>
    );
  }

  if (step === "strategy") {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
        <button
          onClick={() => patch({ step: "setup" })}
          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: COLORS.chalkDim, cursor: "pointer", fontSize: 13 }}
        >
          <ChevronLeft size={16} /> Back
        </button>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 17, textTransform: "uppercase" }}>
          {playerOrder.length} players doesn't split evenly
        </div>
        <div style={{ color: COLORS.chalkDim, fontSize: 13 }}>Pick how to handle it:</div>
        {layout.strategies.map((opt) => (
          <button
            key={opt.key}
            onClick={() => chooseStrategy(opt)}
            style={{ ...cardStyle(), textAlign: "left", cursor: "pointer", display: "block", width: "100%" }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{opt.label}</div>
            {opt.detail && <div style={{ fontSize: 12, color: COLORS.chalkDim }}>{opt.detail}</div>}
          </button>
        ))}
      </div>
    );
  }

  // step === "schedule"
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, color: COLORS.chalkDim }}>
          {schedule.stats.distinctPairsCovered} of {schedule.stats.totalPossiblePairs} possible pairings happened at least
          once · no pair repeated more than {schedule.stats.maxRepeat}×
        </div>
        <button
          onClick={startOver}
          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: COLORS.chalkDim, cursor: "pointer", fontSize: 12, flexShrink: 0, marginLeft: 8 }}
        >
          <RotateCcw size={13} /> New
        </button>
      </div>

      {printError && <div style={{ color: COLORS.red, fontSize: 12, fontWeight: 600, padding: "0 2px" }}>{printError}</div>}

      <div style={cardStyle()}>
        <div style={labelStyle()}>Roster key</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
          {playerOrder.map((id) => {
            const p = playerById[id];
            if (!p) return null;
            return (
              <div key={id} style={{ fontSize: 13, display: "flex", gap: 5 }}>
                <span style={{ fontWeight: 800, color: COLORS.orange }}>{letterFor[id]}</span>
                <span style={{ color: COLORS.chalkDim }}>{displayName(p)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {schedule.rounds.map((round, r) => (
          <div key={r} style={cardStyle()}>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, textTransform: "uppercase", marginBottom: 10 }}>
              Round {r + 1}
            </div>
            {round.courts.map((court, c) => {
              const key = `${r}-${c}`;
              const winner = winners[key];
              return (
                <div key={c} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 4, fontWeight: 700 }}>COURT {court.court}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[
                      ["A", court.teamA],
                      ["B", court.teamB],
                    ].map(([side, team]) => {
                      const isWinner = winner === side;
                      return (
                        <button
                          key={side}
                          onClick={() => recordWinner(r, c, side)}
                          style={{
                            flex: 1,
                            textAlign: "left",
                            padding: 10,
                            borderRadius: 8,
                            border: `1.5px solid ${isWinner ? COLORS.green : COLORS.line}`,
                            background: isWinner ? COLORS.greenSoft : COLORS.bg,
                            color: COLORS.chalk,
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>{team.map((idx) => letterFor[playerOrder[idx]]).join(" ")}</div>
                          {isWinner && <div style={{ fontSize: 10, color: COLORS.green, fontWeight: 700, marginTop: 2 }}>WINNER +1</div>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {round.byes.length > 0 && (
              <div style={{ fontSize: 12, color: COLORS.chalkDim }}>
                Sitting out: {round.byes.map((idx) => letterFor[playerOrder[idx]]).join(" ")}
              </div>
            )}
            {round.idleCourts.length > 0 && (
              <div style={{ fontSize: 12, color: COLORS.chalkDim }}>
                Court{round.idleCourts.length > 1 ? "s" : ""} {round.idleCourts.join(", ")} open — use for a side drill.
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={cardStyle()}>
        <div style={labelStyle()}>Standings</div>
        <div style={{ fontSize: 11, color: COLORS.chalkDim, marginBottom: 8 }}>
          Updates automatically as you tap winners above — use +/− here for corrections or ties.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {standings.map((row, i) => (
            <div key={row.player.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, padding: "4px 0" }}>
              <span>
                {i + 1}. {displayName(row.player)}
                {row.player.guest && <span style={{ color: COLORS.chalkDim, fontSize: 11 }}> (guest)</span>}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => adjustPoints(row.player.id, -1)} style={pointStepperButtonStyle()} aria-label="Subtract a point">
                  −
                </button>
                <span style={{ fontWeight: 700, minWidth: 18, textAlign: "center" }}>{row.points}</span>
                <button onClick={() => adjustPoints(row.player.id, 1)} style={pointStepperButtonStyle()} aria-label="Add a point">
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        #${PRINT_ROOT_ID} { display: none; }
        #${PRINT_ROOT_ID}.tourney-print-root-capturing {
          display: block;
          position: fixed;
          top: 0;
          left: -9999px;
          width: 780px;
          background: #fff;
          color: #000;
          padding: 24px 28px;
          font-family: 'Inter', system-ui, sans-serif;
        }
      `}</style>
      {/* One dense reference sheet, not a paginated document — real names
          inline per matchup (not just letters) since this is meant to be
          read at a glance mid-practice, and no per-round page breaks so it
          actually stays to one printed page. */}
      <div id={PRINT_ROOT_ID}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18 }}>King &amp; Queen of the Court</div>
          <div style={{ fontSize: 11, color: "#666" }}>{new Date().toLocaleDateString()}</div>
        </div>

        {schedule.rounds.map((round, r) => (
          <div key={r} style={{ marginBottom: 6, breakInside: "avoid" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>Round {r + 1}</div>
            {round.courts.map((court, c) => (
              <div key={c} style={{ fontSize: 11, marginBottom: 1 }}>
                <span style={{ color: "#666" }}>Court {court.court}: </span>
                <b>{court.teamA.map((idx) => displayName(playerAt(idx))).join(", ")}</b>
                <span style={{ color: "#666" }}> vs </span>
                <b>{court.teamB.map((idx) => displayName(playerAt(idx))).join(", ")}</b>
                {winners[`${r}-${c}`] && (
                  <span style={{ color: "#2E7D4F", fontWeight: 700 }}>
                    {" "}
                    — {winners[`${r}-${c}`] === "A" ? court.teamA.map((idx) => displayName(playerAt(idx))).join("/") : court.teamB.map((idx) => displayName(playerAt(idx))).join("/")} won
                  </span>
                )}
              </div>
            ))}
            {round.byes.length > 0 && (
              <div style={{ fontSize: 10, color: "#666" }}>Sitting out: {round.byes.map((idx) => displayName(playerAt(idx))).join(", ")}</div>
            )}
          </div>
        ))}

        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>Standings</div>
        <div style={{ columnCount: 2, columnGap: 24, fontSize: 11 }}>
          {standings.map((row, i) => (
            <div key={row.player.id} style={{ breakInside: "avoid" }}>
              {i + 1}. {displayName(row.player)}
              {row.player.guest ? " (guest)" : ""} — {row.points}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default TournamentBuilder;
