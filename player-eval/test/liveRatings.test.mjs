import assert from "node:assert/strict";
import { SCALES, cleanRating, summarize, byPlayer, mergeStatEntries, statTotals, statHighlights, statsSince, ratingsSince, defaultMatchId, newRatingId, dayOf } from "../src/liveRatings.js";

// cleanRating rejects anything that would poison an average
assert.equal(cleanRating({ skill: "pass", value: 4 }), null);
assert.equal(cleanRating({ skill: "pass", value: -1 }), null);
assert.equal(cleanRating({ skill: "pass", value: 1.5 }), null);
assert.equal(cleanRating({ skill: "hit", value: 1 }), null);
assert.equal(cleanRating(null), null);
assert.equal(cleanRating({ skill: "serve", value: "4" }).value, 4);

const r = (playerId, skill, value, extra = {}) => ({ id: newRatingId(), playerId, skill, value, at: 1000, ...extra });
const entries = [r(1, "pass", 3), r(1, "pass", 2), r(1, "pass", 0), r(2, "pass", 3), r(2, "serve", 4), r(2, "serve", 0)];

const s = summarize(entries, "pass");
assert.equal(s.count, 4);
assert.equal(s.avg, 2);
assert.deepEqual(s.dist, { 3: 2, 2: 1, 1: 0, 0: 1 });
assert.equal(summarize([], "pass").avg, null);

const rows = byPlayer(entries, "pass");
assert.deepEqual(rows.map((x) => [x.playerId, x.count]), [[2, 1], [1, 3]]);
assert.deepEqual(byPlayer(entries, "serve").map((x) => [x.playerId, x.avg]), [[2, 2]]);

// stat log: collection + legacy array, deduped by id
const merged = mergeStatEntries([{ id: 1, stat: "kill" }, { id: 2, stat: "ace" }], [{ id: 2, stat: "ace" }, { id: 3, stat: "dig" }]);
assert.equal(merged.length, 3);
const t = statTotals([...merged, { id: 4, stat: "serviceAtt" }, { id: 5, stat: "serviceAtt" }, { id: 6, stat: "serveErr" }, { id: 7, stat: "bogus" }]);
assert.equal(t.kill, 1);
assert.equal(t.serviceAtt, 2);
assert.deepEqual(statHighlights(t), ["1 K · 0 E", "1 ace · 50% serve in", "1 dig"]);

// "since" filters: stat ids are timestamps (Date.now() + Math.random())
assert.equal(statsSince([{ id: 5000.7 }, { id: 9000.2 }], 6000).length, 1);
assert.equal(ratingsSince([{ at: 5000 }, { at: 9000 }], 6000).length, 1);

// default match: active > today > none
const matches = [{ id: "a", date: "2026-11-20" }, { id: "b", date: "2026-11-21" }];
assert.equal(defaultMatchId(matches, "a", "2026-11-21"), "a");
assert.equal(defaultMatchId(matches, "gone", "2026-11-21"), "b");
assert.equal(defaultMatchId(matches, null, "2026-12-01"), null);

// ids unique and string-shaped (they're Firestore document ids)
const ids = new Set(Array.from({ length: 500 }, () => newRatingId()));
assert.equal(ids.size, 500);
assert.match(newRatingId(), /^\d+-[0-9a-z]+$/);

// local-day grouping for practice
assert.equal(dayOf(new Date(2026, 10, 21, 23, 30).getTime()), "2026-11-21");

assert.equal(SCALES.pass.max, 3);
assert.equal(SCALES.serve.max, 4);
console.log("liveRatings: all passed");
