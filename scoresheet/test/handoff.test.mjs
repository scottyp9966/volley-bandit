// The scorer -> libero tracker handoff: what the QR carries, that it
// survives the round trip, that garbage can't break the app, and that the QR
// codes we draw are actually readable by the decoder the app scans with.
//
//   node test/handoff.test.mjs
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { encodeSetHandoff, decodeSetHandoff, handoffFromText, handoffUrl } from "../src/handoff.js";
import { handbookSet } from "./handbookExample.mjs";

let fails = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};

const set = handbookSet();
set.teams.V.libero2 = "12";
const match = {
  id: "m8x2k3",
  bestOf: 5,
  decidingTarget: 15,
  header: { date: "2017-09-01", home: "Holy Angels Academy", visitor: "Washington Central", site: "Holy Angels Academy", level: "Varsity", gender: "Girls", r1: "Tom Ball", r2: "Sally Whistle", scorer: "Ima Writer" },
  sets: [set],
};
const url = handoffUrl(encodeSetHandoff(match, set), "https://volley-bandit-scoresheet.vercel.app/");
const back = handoffFromText(url);
const norm = (t) => ({ lineup: t.lineup, libero: t.libero || "", libero2: t.libero2 || "", noLibero: !!t.noLibero, captain: t.captain || "" });
eq([norm(back.set.teams.H), norm(back.set.teams.V)], [norm(set.teams.H), norm(set.teams.V)], "both teams' lineups, liberos and captains round-trip");
eq([back.set.number, back.set.left, back.set.firstServe, back.set.target], [1, "V", "V", 25], "set number, sides, first serve, target");
eq(back.header.home + " / " + back.header.visitor, "Holy Angels Academy / Washington Central", "team names");
eq(back.sourceId, "m8x2k3", "scorer's match id, so later sets land in the same tracker match");
eq(JSON.stringify(back).includes("Sally") || JSON.stringify(back).includes("Ima"), false, "officials' and scorer's names are NOT carried");
eq(url.startsWith("https://volley-bandit-scoresheet.vercel.app/#track="), true, "a plain link — a Camera app can open it");
console.log(`     link is ${url.length} characters`);

eq(decodeSetHandoff("not-base64!"), null, "garbage -> null, not a crash");
eq(handoffFromText("https://example.com/"), null, "someone else's QR code -> null");
const bad = encodeSetHandoff(match, set); bad.T.H = "1.2/10//0/1";
eq(decodeSetHandoff(bad), null, "a lineup without six players is refused");
const evil = encodeSetHandoff(match, set); evil.T.H = "<img>.2.3.4.5.6/10//0/1"; evil.h.ho = "x".repeat(500);
const ev = decodeSetHandoff(evil);
eq([ev.set.teams.H.lineup[0], ev.header.home.length], ["", 60], "jersey numbers are digits only; names are length-capped");

// Draw the QR the way the app does and read it back with jsQR (the iPad path).
function rasterise(text, scale = 6) {
  const qr = qrcode(0, "M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), quiet = 4, size = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return { px, size, modules: n };
}
const img = rasterise(url);
const read = jsQR(img.px, img.size, img.size);
eq(read?.data, url, `jsQR reads our QR back exactly (${img.modules}x${img.modules} modules)`);
eq(img.modules <= 77, true, "QR is version 15 or smaller — comfortably scannable off a tablet screen");

// Worst case: long team names, two liberos each, every field filled.
const long = { ...match, header: { ...match.header, home: "Saint Bartholomew's Academy of the Sacred Heart", visitor: "North Middlesex Regional High School", site: "Saint Bartholomew's Gymnasium" } };
const set2 = JSON.parse(JSON.stringify(set)); set2.teams.H.libero2 = "77";
const url2 = handoffUrl(encodeSetHandoff(long, set2), "https://volley-bandit-scoresheet.vercel.app/");
const img2 = rasterise(url2);
eq(jsQR(img2.px, img2.size, img2.size)?.data, url2, `long names still decode (${img2.modules}x${img2.modules} modules, ${url2.length} chars)`);

console.log(fails ? `\n${fails} FAILURES` : "\nall checks passed");
process.exit(fails ? 1 : 0);
