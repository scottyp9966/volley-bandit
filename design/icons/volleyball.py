"""The volleyball in the app icons — drawn from the ball's own geometry.

This is original artwork, generated rather than traced, so it carries no
third-party licence. (The two stock/clipart balls used before it did, or
might have — see CLAUDE.md, "App icons".)

A real ball's 18-panel pattern seen face-on is: one junction J, three seams
from J to the rim, and in each of the three sectors two more seams that
start ON one boundary and run roughly PARALLEL to the next boundary round.
"Roughly" because on a sphere those seams diverge as they move away from
the junction. So each interior seam is the next boundary, translated onto
its start point, rotated outward a few degrees, extended past its end and
cut exactly at the rim. That construction is what guarantees every seam
meets the one it starts on and none ends in mid-air — the failure that made
earlier hand-placed attempts read as beach balls.

    python3 volleyball.py svg  out.svg          # the vector artwork
    python3 volleyball.py mvg  out.mvg 838      # ImageMagick draw commands

The MVG form exists because ImageMagick here has no SVG renderer (it wants
rsvg-convert) and its security policy refuses -draw @file, so build.py
passes these commands inline instead.
"""
import math, sys

P = dict(
    cx=500, cy=500, R=440,
    J=(-15, -3),                        # junction, offset from centre
    # boundaries, clockwise. (rim angle in degrees, maths convention;
    # bow in px, +ve = to the left of travel from J out to the rim)
    UL=(135.8, 96), RT=(17.5, 92), DN=(-93.0, 96),
    # per sector — starts on boundary i, runs alongside boundary i+1:
    # [where along boundary i the seam leaves (0..1), outward turn in deg]
    top=[[0.55, 5], [0.80, 12]],
    right=[[0.30, 10], [0.67, 11]],
    left=[[0.33, 16], [0.77, 17]],
    sw_line=17, sw_rim=19,
)

def _quad(p0, c, p1, t):
    a, b, d = (1 - t) ** 2, 2 * (1 - t) * t, t * t
    return (a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1])

def _rot(v, deg):
    # counter-clockwise in maths convention, in screen coordinates (y down)
    th = math.radians(deg); c, s = math.cos(th), math.sin(th)
    return (v[0] * c + v[1] * s, -v[0] * s + v[1] * c)

def _inside(p):
    return math.hypot(p[0] - P["cx"], p[1] - P["cy"]) <= P["R"]

def _boundary(J, ang, bow):
    end = (P["cx"] + P["R"] * math.cos(math.radians(ang)),
           P["cy"] - P["R"] * math.sin(math.radians(ang)))
    mx, my = (J[0] + end[0]) / 2, (J[1] + end[1]) / 2
    dx, dy = end[0] - J[0], end[1] - J[1]
    L = math.hypot(dx, dy)
    return (J, (mx + dy / L * bow, my - dx / L * bow), end)

def _to_rim(p0, c, p1, smax=3.0, n=600):
    """Extend the curve past its end until it leaves the ball, and return the
    part inside as ONE exact quadratic. The segment of a quadratic from 0 to
    any s — s > 1 included, which is how a seam reaches the rim — is itself a
    quadratic with control point (1-s)*p0 + s*c, so nothing is approximated
    and the curve is exact at any size."""
    prev = 0.0
    for i in range(1, n + 1):
        s = smax * i / n
        if not _inside(_quad(p0, c, p1, s)):
            lo, hi = prev, s
            for _ in range(50):
                mid = (lo + hi) / 2
                lo, hi = (mid, hi) if _inside(_quad(p0, c, p1, mid)) else (lo, mid)
            break
        prev = s
    else:
        lo = smax
    ctrl = ((1 - lo) * p0[0] + lo * c[0], (1 - lo) * p0[1] + lo * c[1])
    return (p0, ctrl, _quad(p0, c, p1, lo))

def seams():
    J = (P["cx"] + P["J"][0], P["cy"] + P["J"][1])
    B = [_boundary(J, *P[k]) for k in ("UL", "RT", "DN")]
    lines = [_to_rim(*b) for b in B]
    for i, key in enumerate(("top", "right", "left")):
        bi, bn = B[i], B[(i + 1) % 3]
        for t, turn in P[key]:
            p0 = _quad(*bi, t)
            vc = _rot((bn[1][0] - J[0], bn[1][1] - J[1]), turn)
            v1 = _rot((bn[2][0] - J[0], bn[2][1] - J[1]), turn)
            lines.append(_to_rim(p0, (p0[0] + vc[0], p0[1] + vc[1]),
                                 (p0[0] + v1[0], p0[1] + v1[1])))
    return lines

def _frame():
    half = P["R"] + P["sw_rim"] / 2     # the outer edge of the rim stroke
    return P["cx"] - half, P["cy"] - half, 2 * half

def svg():
    x0, y0, side = _frame()
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.1f} {y0:.1f} {side:.1f} {side:.1f}">',
           f'  <circle cx="{P["cx"]}" cy="{P["cy"]}" r="{P["R"]}" fill="#fff"/>',
           f'  <g fill="none" stroke="#000" stroke-width="{P["sw_line"]}" stroke-linecap="round" stroke-linejoin="round">']
    for (a, c, b) in seams():
        out.append(f'    <path d="M {a[0]:.2f} {a[1]:.2f} Q {c[0]:.2f} {c[1]:.2f} {b[0]:.2f} {b[1]:.2f}"/>')
    out += ['  </g>',
            f'  <circle cx="{P["cx"]}" cy="{P["cy"]}" r="{P["R"]}" fill="none" stroke="#000" stroke-width="{P["sw_rim"]}"/>',
            '</svg>']
    return "\n".join(out) + "\n"

def mvg(size):
    """The same drawing as ImageMagick draw commands, pre-scaled to `size`
    square, with the ball filling the frame edge to edge."""
    x0, y0, side = _frame()
    k = size / side
    X = lambda x: (x - x0) * k
    Y = lambda y: (y - y0) * k
    cx, cy, R = X(P["cx"]), Y(P["cy"]), P["R"] * k
    out = [f"viewbox 0 0 {size} {size}",
           "stroke-antialias 1",
           "fill white", f"circle {cx:.2f},{cy:.2f} {cx:.2f},{cy + R:.2f}",
           "fill none", "stroke black",
           f"stroke-width {P['sw_line'] * k:.3f}",
           "stroke-linecap round", "stroke-linejoin round"]
    for (a, c, b) in seams():
        out.append(f"path 'M {X(a[0]):.2f},{Y(a[1]):.2f} Q {X(c[0]):.2f},{Y(c[1]):.2f} {X(b[0]):.2f},{Y(b[1]):.2f}'")
    out += [f"stroke-width {P['sw_rim'] * k:.3f}",
            f"circle {cx:.2f},{cy:.2f} {cx:.2f},{cy + R:.2f}"]
    return "\n".join(out) + "\n"

if __name__ == "__main__":
    kind, path = sys.argv[1], sys.argv[2]
    open(path, "w").write(svg() if kind == "svg" else mvg(int(sys.argv[3])))
