"""Regenerate all three apps' icons from the sources in this folder.

    python3 design/icons/build.py

Needs Python 3 and ImageMagick (`convert`, `identify`); nothing else.
Writes icon-512.png, icon-192.png and favicon.svg into each app's public/.

Sources:
  volleyball.py  — the ball, generated from its geometry (original artwork)
  raccoon.png    — the Thrift Bandit raccoon, the coach's own character,
                   cut from a screenshot of that app's icon (~168px of real
                   artwork, so it is soft at 512; drop in the original asset
                   here if it turns up and re-run — nothing else changes)

Every app gets the same mark; the background colour is what says which app
it is. See CLAUDE.md, "App icons", for why each choice below was made.
"""
import base64, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import volleyball  # noqa: E402

APPS = [  # (public dir, background)
    ("public", "#255E42"),               # Volley Bandit — green
    ("player-eval/public", "#1F4E79"),   # Player Eval   — blue
    ("player-stats/public", "#5D3A7A"),  # Player Stats  — plum
]
BONE = "#F5F3EE"
TILE, BALL, COON = 512, 440, 320   # raccoon centred, ball a touch larger
BALL_SRC = 838                     # line-art raster the ball is cut from

def run(*a):
    subprocess.run(a, check=True)

def dim(path):
    out = subprocess.run(["identify", "-format", "%w %h", path],
                         capture_output=True, text=True, check=True).stdout
    return tuple(int(v) for v in out.split())

def png_opts(colors):
    # Quantised: straight out of the compositor the 512 is ~147KB of 16-bit
    # PNG; at 128 colours it is ~35KB and measurably identical. This bundle
    # loads on gym wifi and is deliberately not code-split.
    return ["-alpha", "off", "-colors", str(colors), "-depth", "8", "-strip",
            "-define", "png:compression-level=9"]

def main():
    with tempfile.TemporaryDirectory() as tmp:
        t = lambda name: os.path.join(tmp, name)
        # The ball, drawn at 2x and brought down for clean edges. Passed
        # inline: this ImageMagick's policy refuses `-draw @file`.
        big = BALL_SRC * 2
        run("convert", "-size", f"{big}x{big}", "xc:white",
            "-draw", volleyball.mvg(big),
            "-resize", f"{BALL_SRC}x{BALL_SRC}", "-colorspace", "gray", t("ball.png"))
        r = BALL_SRC // 2
        run("convert", "-size", f"{BALL_SRC}x{BALL_SRC}", "xc:none", "-fill", "white",
            "-draw", f"circle {r},{r} {r},1", t("mask.png"))
        run("convert", os.path.join(HERE, "raccoon.png"), "-background", "none",
            "-filter", "Lanczos", "-resize", f"{COON}x", t("coon.png"))
        cw, ch = dim(t("coon.png"))

        for public, bg in APPS:
            out = os.path.join(ROOT, public)
            # Seams take the background colour, so each tile is one colour
            # plus bone and nothing looks pasted on.
            run("convert", t("ball.png"), "+level-colors", f"{bg},{BONE}", t("col.png"))
            run("convert", t("col.png"), t("mask.png"), "-alpha", "off",
                "-compose", "CopyOpacity", "-composite", t("disc.png"))
            run("convert", t("disc.png"), "-filter", "Lanczos",
                "-resize", f"{BALL}x{BALL}", t("b.png"))
            bw, bh = dim(t("b.png"))
            # Full-bleed square, no alpha: the manifest declares icon-512 as
            # maskable, and the platform applies its own mask. Baked-in
            # corners would be clipped twice.
            run("convert", "-size", f"{TILE}x{TILE}", f"xc:{bg}",
                t("b.png"), "-geometry", f"+{(TILE - bw) // 2}+{(TILE - bh) // 2}", "-composite",
                t("coon.png"), "-geometry", f"+{(TILE - cw) // 2}+{(TILE - ch) // 2}", "-composite",
                *png_opts(128), os.path.join(out, "icon-512.png"))
            run("convert", os.path.join(out, "icon-512.png"), "-filter", "Lanczos",
                "-resize", "192x192", *png_opts(128), os.path.join(out, "icon-192.png"))
            # favicon.svg wraps a 64px PNG: rounded, because nothing masks a
            # favicon for us, and it keeps index.html untouched.
            run("convert", os.path.join(out, "icon-512.png"), "-filter", "Lanczos",
                "-resize", "64x64", *png_opts(96), t("fav.png"))
            b64 = base64.b64encode(open(t("fav.png"), "rb").read()).decode()
            with open(os.path.join(out, "favicon.svg"), "w") as f:
                f.write('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">\n'
                        '  <defs><clipPath id="r"><rect width="64" height="64" rx="14"/></clipPath></defs>\n'
                        f'  <image clip-path="url(#r)" width="64" height="64" xlink:href="data:image/png;base64,{b64}"/>\n'
                        '</svg>\n')
            sizes = [os.path.getsize(os.path.join(out, n)) // 1024
                     for n in ("icon-512.png", "icon-192.png", "favicon.svg")]
            print(f"{public}: icon-512 {sizes[0]}KB, icon-192 {sizes[1]}KB, favicon {sizes[2]}KB")

if __name__ == "__main__":
    main()
