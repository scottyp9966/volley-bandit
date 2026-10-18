// One source of randomness for everything that issues a CODE.
//
// These codes are credentials. A player's code is the only thing standing
// between a stranger and her card; an assistant code is what gets a device
// onto a team. `Math.random()` is not built for that: V8 implements it as
// xorshift128+, and seeing a handful of consecutive outputs is enough to
// recover the generator's internal state and predict every later one.
//
// That is not theoretical here, because of exactly how these are issued:
// `generateCodes` mints a whole roster's worth in one pass from one
// generator, and every one of those codes is handed to a teenager. A player
// who has two or three team-mates' codes — which is a normal afternoon on a
// team bus — is the precise situation that attack needs. The app already
// warns that the `jersey` style is derivable by any team-mate; it would be a
// poor joke if `random` and `hybrid` were too, just less obviously.
//
// `crypto.getRandomValues` is in every browser this app runs on and in Node
// 19+. The `Math.random` fallback exists only so a test runner or an exotic
// environment without WebCrypto still works, and it is the only path that
// should ever be weak.
//
// Modulo bias: the alphabets here are 30 and 31 characters, neither a power
// of two, so taking a random byte mod N would favour the first few letters.
// `pick` rejects the tail of the byte range instead of folding it in — a
// couple of extra draws, and a genuinely uniform code.
function cryptoBytes(n) {
  try {
    const c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === "function") {
      return c.getRandomValues(new Uint8Array(n));
    }
  } catch {
    /* fall through to Math.random */
  }
  return null;
}

// Returns a function that yields one uniformly random index into `size`.
// `rng` is honoured when a caller passes one explicitly, which is what makes
// these functions testable with a fixed sequence.
export function makePicker(size, rng) {
  if (rng) return () => Math.floor(rng() * size);
  const limit = Math.floor(256 / size) * size; // reject above this
  let buf = cryptoBytes(64);
  let i = 0;
  if (!buf) return () => Math.floor(Math.random() * size);
  return () => {
    for (let guard = 0; guard < 1000; guard += 1) {
      if (i >= buf.length) {
        buf = cryptoBytes(64) || buf;
        i = 0;
      }
      const b = buf[i];
      i += 1;
      if (b < limit) return b % size;
    }
    // Pathological: a thousand rejections in a row cannot happen with
    // limit >= 240/256, but never spin forever on a live match screen.
    return Math.floor(Math.random() * size);
  };
}

// Convenience for "n characters from this alphabet".
export function randomFrom(alphabet, n, rng) {
  const pick = makePicker(alphabet.length, rng);
  let out = "";
  for (let i = 0; i < n; i += 1) out += alphabet[pick()];
  return out;
}
