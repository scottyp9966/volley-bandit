import React, { useState, useMemo } from "react";
import { ChevronLeft, Check, RotateCcw } from "lucide-react";
import { COLORS, usePersisted, displayName } from "./shared.js";
import { computeRoundPlan, planTeamLayout, generateSchedule } from "./tournamentLogic.js";

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
  config: { attendingIds: [], courts: 2, totalMinutes: 45, targetRoundLength: 7, teamSizePref: "auto" },
  layout: null,
  playerOrder: [], // roster ids, index-stable for the life of this tournament
  letterFor: {}, // roster id -> display letter
  schedule: null, // { rounds, stats, strategy }
  winners: {}, // "r-c" -> "A" | "B"
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

export default function TournamentBuilder({ roster }) {
  const [state, setState] = usePersisted("vb-tournament", initialState);
  const { step, config, layout, playerOrder, letterFor, schedule, winners, error } = state;

  const patch = (fields) => setState((s) => ({ ...s, ...fields }));
  const patchConfig = (fields) => setState((s) => ({ ...s, config: { ...s.config, ...fields } }));

  const toggleAttending = (id) => {
    patchConfig({
      attendingIds: config.attendingIds.includes(id)
        ? config.attendingIds.filter((x) => x !== id)
        : [...config.attendingIds, id],
    });
  };

  const startOver = () => setState(initialState);

  const buildLayout = () => {
    const attending = roster.filter((p) => config.attendingIds.includes(p.id));
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
    return map;
  }, [roster]);

  const playerAt = (idx) => playerById[playerOrder[idx]];

  const recordWinner = (roundIdx, courtIdx, side) => {
    const key = `${roundIdx}-${courtIdx}`;
    patch({ winners: { ...winners, [key]: winners[key] === side ? null : side } });
  };

  const points = useMemo(() => {
    const tally = {};
    playerOrder.forEach((id) => (tally[id] = 0));
    if (!schedule) return tally;
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
    return tally;
  }, [schedule, winners, playerOrder]);

  const standings = useMemo(
    () =>
      playerOrder
        .map((id) => ({ player: playerById[id], points: points[id] || 0 }))
        .filter((row) => row.player)
        .sort((a, b) => b.points - a.points || displayName(a.player).localeCompare(displayName(b.player))),
    [playerOrder, points, playerById]
  );

  if (step === "setup") {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
        <div style={cardStyle()}>
          <div style={labelStyle()}>Who's here today</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => patchConfig({ attendingIds: roster.map((p) => p.id) })}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {standings.map((row, i) => (
            <div key={row.player.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "4px 0" }}>
              <span>
                {i + 1}. {displayName(row.player)}
              </span>
              <span style={{ fontWeight: 700 }}>{row.points}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
