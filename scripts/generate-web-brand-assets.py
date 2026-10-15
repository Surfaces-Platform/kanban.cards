#!/usr/bin/env python3
"""Refresh site derivatives from approved Split K sources and shared rules.

Requires Python 3, Pillow, and ImageMagick. Routine npm builds copy committed
exports and check hashes; they need neither a rasterizer nor a font file.
"""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import math
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand/split-k"
OUT = BRAND / "web"
OUT.mkdir(exist_ok=True)
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
POLYGONS = ["6,6 18,6 18,58 6,58", "26,16 58,2 58,16 26,30", "26,34 58,48 58,62 26,48"]
LOCKUP_RULES = json.loads((BRAND / "wordmark-source/lockup-rules.json").read_text())
sources, assets = {}, []


def source(relative):
    path = BRAND / relative
    data = path.read_bytes()
    sources[str(path.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
    if path.suffix == ".svg":
        tree = ET.fromstring(data)
        assert [p.attrib["points"] for p in tree.iter(f"{{{NS}}}polygon")] == POLYGONS
        assert not list(tree.iter(f"{{{NS}}}text"))
    return path


RULES = json.loads(source("web/derivative-rules.json").read_text())
INK, IVORY, NICKEL = [RULES["palette"][key] for key in ["ink", "ivory", "nickel"]]
assert [INK, IVORY, NICKEL] == ["#0B0D0E", "#F7F6F2", "#8B9096"]
MARKS = {theme: ET.parse(source(relative)).getroot()
         for theme, relative in [("light", "applied/favicon.svg"), ("dark", "applied/favicon-dark.svg")]}
for theme, mark in MARKS.items():
    expected = INK if theme == "light" else IVORY
    assert [p.get("fill") for p in mark.findall(f"{{{NS}}}polygon")] == [expected, expected, NICKEL]
vertices = [tuple(map(float, point.split(","))) for points in POLYGONS for point in points.split()]
xmin, xmax = min(x for x, y in vertices), max(x for x, y in vertices)
ymin, ymax = min(y for x, y in vertices), max(y for x, y in vertices)
center_x, center_y = (xmin + xmax) / 2, (ymin + ymax) / 2


def record(filename, content_type, derived_from, size=None, opaque=None, alias_of=None):
    path = OUT / filename
    item = {"route": "/" + filename, "source": str(path.relative_to(ROOT)),
            "contentType": content_type, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "derivedFrom": derived_from}
    if size:
        item["dimensions"] = list(size)
    if opaque is not None:
        item["opaque"] = opaque
    if alias_of:
        item["aliasOf"] = "/" + alias_of
    assets.append(item)


def write_svg(filename, document, derived_from):
    (OUT / filename).write_bytes(ET.tostring(document, encoding="utf-8") + b"\n")
    record(filename, "image/svg+xml", derived_from)
    return OUT / filename


def tile(theme, visible_height, radius, plate=True):
    canvas = RULES["browserIcon"]["canvas"]
    doc = ET.Element(f"{{{NS}}}svg", {"width": str(canvas), "height": str(canvas), "viewBox": f"0 0 {canvas} {canvas}"})
    ET.SubElement(doc, f"{{{NS}}}title").text = "kanban.cards"
    if plate:
        ET.SubElement(doc, f"{{{NS}}}rect", {"width": str(canvas), "height": str(canvas), "rx": str(radius), "fill": IVORY if theme == "light" else INK})
    scale = visible_height / (ymax - ymin)
    tx, ty = canvas / 2 - center_x * scale, canvas / 2 - center_y * scale
    group = ET.SubElement(doc, f"{{{NS}}}g", {"data-role": "mark", "transform": f"translate({tx:.9f} {ty:.9f}) scale({scale:.9f})"})
    for polygon in MARKS[theme].findall(f"{{{NS}}}polygon"):
        group.append(deepcopy(polygon))
    return doc


def render(svg, filename, size, opaque):
    icon = max(size) <= 512
    density = RULES["iconRaster"]["density"] if icon else 96
    args = ["magick", "-background", "none", "-density", str(density), str(svg),
            "-resize", f"{size[0]}x{size[1]}!", "-strip", "-colorspace", "sRGB"]
    args += ["PNG32:" + str(OUT / filename)] if icon else ["-alpha", "off", "PNG24:" + str(OUT / filename)]
    subprocess.run(args, check=True)
    with Image.open(OUT / filename) as im:
        assert im.size == size and im.mode == ("RGBA" if icon else "RGB")
        if opaque:
            assert im.convert("RGBA").getchannel("A").getextrema() == (255, 255)
    record(filename, "image/png", [str(svg.relative_to(ROOT))], size, opaque)


def alias(source_name, destination, content_type, size=None, opaque=None):
    shutil.copyfile(OUT / source_name, OUT / destination)
    record(destination, content_type, [str((OUT / source_name).relative_to(ROOT))], size, opaque, source_name)


# Both browser themes use a free-standing mark with identical placement.
browser = RULES["browserIcon"]
for theme in ["light", "dark"]:
    name = f"favicon-v2-{theme}.svg"
    svg = write_svg(name, tile(theme, browser["visibleMarkHeight"], 0, plate=False),
                    ["brand/split-k/applied/favicon" + ("-dark" if theme == "dark" else "") + ".svg", "brand/split-k/web/derivative-rules.json"])
    for size in [16, 32, 48]:
        render(svg, f"favicon-v2-{theme}-{size}.png", (size, size), False)
    alias(name, f"favicon-{theme}.svg", "image/svg+xml")

# Unthemed SVG paths use the same dark fallback as ICO and raster aliases.
alias("favicon-v2-dark.svg", "favicon-v2.svg", "image/svg+xml")
alias("favicon-v2-dark.svg", "favicon.svg", "image/svg+xml")
for theme in ["light", "dark"]:
    frames = [Image.open(OUT / f"favicon-v2-{theme}-{size}.png").convert("RGBA") for size in [16, 32, 48]]
    frames[-1].save(OUT / f"favicon-v2-{theme}.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=frames[:-1])
    record(f"favicon-v2-{theme}.ico", "image/x-icon", [f"brand/split-k/web/favicon-v2-{theme}.svg"])
alias("favicon-v2-dark.ico", "favicon-v2.ico", "image/x-icon")
alias("favicon-v2-dark.ico", "favicon.ico", "image/x-icon")
for size in [16, 32]:
    alias(f"favicon-v2-dark-{size}.png", f"favicon-{size}.png", "image/png", (size, size), False)

# Regular install icons keep the shared 48px mark on an opaque dark square.
regular = RULES["regularAppIcon"]
regular_svg = write_svg("app-icon-v2.svg", tile(regular["theme"], regular["visibleMarkHeight"], regular["cornerRadius"]),
                        ["brand/split-k/applied/favicon-dark.svg", "brand/split-k/web/derivative-rules.json"])
render(regular_svg, "apple-touch-icon-v2.png", (180, 180), True)
alias("apple-touch-icon-v2.png", "apple-touch-icon.png", "image/png", (180, 180), True)
for size in [192, 512]:
    render(regular_svg, f"app-icon-v2-{size}.png", (size, size), True)
    alias(f"app-icon-v2-{size}.png", f"app-icon-{size}.png", "image/png", (size, size), True)

# Maskable icons use the shared documented 36px alternate, with pixel safety.
maskable = RULES["maskableIcon"]
mask_svg = write_svg("maskable-v2.svg", tile(maskable["theme"], maskable["visibleMarkHeight"], maskable["cornerRadius"]),
                     ["brand/split-k/applied/favicon-dark.svg", "brand/split-k/web/derivative-rules.json"])
for size in [192, 512]:
    name = f"maskable-v2-{size}.png"
    render(mask_svg, name, (size, size), True)
    with Image.open(OUT / name) as raster:
        im = raster.convert("RGB")
        for y in range(size):
            for x in range(size):
                if im.getpixel((x, y)) != tuple(bytes.fromhex(INK[1:])):
                    assert max(math.hypot(px - size / 2, py - size / 2)
                               for px in [x, x + 1] for py in [y, y + 1]) <= size * maskable["safeZoneRadiusRatio"]
    alias(name, f"maskable-{size}.png", "image/png", (size, size), True)
pinned = source("favicon/safari-pinned-tab.svg")
shutil.copyfile(pinned, OUT / "safari-pinned-tab.svg")
record("safari-pinned-tab.svg", "image/svg+xml", [str(pinned.relative_to(ROOT))])

# The shared controller is source, served verbatim, and part of the cache identity.
controller = source("web/" + RULES["browserController"]["source"])
assert hashlib.sha256(controller.read_bytes()).hexdigest() == RULES["browserController"]["sha256"]
record(controller.name, "text/javascript", [str(controller.relative_to(ROOT))])

# Every browser/head installation reference carries an identity from actual icon bytes.
icon_revision = hashlib.sha256(json.dumps(sorted((a["route"], a["sha256"]) for a in assets), separators=(",", ":")).encode()).hexdigest()[:12]

# Serve the current and previous hashed paths from the same canonical derivatives.
icon_revisions = [icon_revision] + RULES.get("compatibilityIconRevisions", [])
assert len(set(icon_revisions)) == len(icon_revisions)
assert all(re.fullmatch(r"[a-f0-9]{12}", value) for value in icon_revisions)
for revision in icon_revisions:
    for src, dst in [("favicon-v2.ico", f"favicon-{revision}.ico"),
                     ("favicon-v2.svg", f"favicon-{revision}.svg"),
                     ("apple-touch-icon-v2.png", f"apple-touch-icon-{revision}.png"),
                     ("safari-pinned-tab.svg", f"safari-pinned-tab-{revision}.svg")]:
        current = next(a for a in assets if a["route"] == "/" + src)
        alias(src, dst, current["contentType"], current.get("dimensions"), current.get("opaque"))
    for theme in ["light", "dark"]:
        alias(f"favicon-v2-{theme}.svg", f"favicon-{revision}-{theme}.svg", "image/svg+xml")
        for size in [16, 32]:
            alias(f"favicon-v2-{theme}-{size}.png", f"favicon-{revision}-{theme}-{size}.png", "image/png", (size, size), False)
    for prefix in ["app-icon", "maskable"]:
        for size in [192, 512]:
            alias(f"{prefix}-v2-{size}.png", f"{prefix}-{revision}-{size}.png", "image/png", (size, size), True)

# Only the current head uses these newly introduced theme-specific ICO/controller paths.
for theme in ["light", "dark"]:
    alias(f"favicon-v2-{theme}.ico", f"favicon-{icon_revision}-{theme}.ico", "image/x-icon")
alias(controller.name, f"favicon-theme-{icon_revision}.js", "text/javascript")

# Sharing art contains only the whole canonical reversed outlined lockup.
card = RULES["socialCard"]
lockup = source(card["source"])
assert hashlib.sha256(lockup.read_bytes()).hexdigest() == LOCKUP_RULES["approvedHorizontalSha256"][lockup.name]
canonical = ET.parse(lockup).getroot()
width, height = map(float, canonical.get("viewBox").split()[2:])
scale = min(card["maximumScale"], card["maximumLockupWidth"] / width)
social = ET.Element(f"{{{NS}}}svg", {"width": str(card["width"]), "height": str(card["height"]), "viewBox": f"0 0 {card['width']} {card['height']}"})
ET.SubElement(social, f"{{{NS}}}title").text = "kanban.cards"
ET.SubElement(social, f"{{{NS}}}rect", {"width": str(card["width"]), "height": str(card["height"]), "fill": card["background"]})
group = ET.SubElement(social, f"{{{NS}}}g", {"data-role": "canonical-lockup", "transform": f"translate({(card['width'] - width * scale) / 2:.9f} {(card['height'] - height * scale) / 2:.9f}) scale({scale:.12f})"})
for child in canonical:
    group.append(deepcopy(child))
svg = write_svg("social-brand-v2.svg", social, [str(lockup.relative_to(ROOT)), "brand/split-k/web/derivative-rules.json"])
render(svg, "social-brand-v2.png", (card["width"], card["height"]), True)
alias("social-brand-v2.svg", "social-brand-v1.svg", "image/svg+xml")
alias("social-brand-v2.png", "social-brand-v1.png", "image/png", (1200, 630), True)

manifest = {"id": "/", "name": "kanban.cards", "short_name": "kanban.cards", "lang": "en",
            "description": "A simple Kanban board for projects run by you and your agents.",
            "start_url": "/", "scope": "/", "display": "standalone", "background_color": INK, "theme_color": INK,
            "icons": [{"src": f"/{prefix}-{icon_revision}-{size}.png", "sizes": f"{size}x{size}", "type": "image/png", "purpose": purpose}
                      for prefix, purpose in [("app-icon", "any"), ("maskable", "maskable")] for size in [192, 512]]}
(OUT / "site.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
record("site.webmanifest", "application/manifest+json", ["brand/split-k/web/derivative-rules.json"])
for revision in icon_revisions:
    alias("site.webmanifest", f"site-{revision}.webmanifest", "application/manifest+json")
style_hash = None
style_routes = []
(OUT / "asset-manifest.json").write_text(json.dumps({"version": 5, "iconRevision": icon_revision, "sources": sources, "faviconStyleHash": style_hash,
                                                    "faviconStyleRoutes": style_routes, "assets": assets}, indent=2) + "\n")
routes = [[a["route"], "public/branding/" + Path(a["source"]).name, a["contentType"]] for a in assets]
(ROOT / "src/brand-web-assets.ts").write_text("// Generated by scripts/generate-web-brand-assets.py.\nexport const BRAND_ICON_REVISION = " + json.dumps(icon_revision) + ";\nexport const FAVICON_STYLE_HASH = " + json.dumps(style_hash) + ";\nexport const FAVICON_STYLE_ROUTES = " + json.dumps(style_routes, separators=(",", ":")) + " as const;\nexport const BRAND_WEB_ASSETS = " + json.dumps(routes, indent=2) + " as const;\n")
# Keep the static loading shell head synchronized with the shared server helper.
brand_source = (ROOT / "src/brand.ts").read_text()
head = re.search(r"export function renderBrandHead\(\): string \{\n  return `([\s\S]*?)`;", brand_source).group(1)
head = head.replace("${BRAND_ICON_REVISION}", icon_revision)
assert "${" not in head
index = ROOT / "index.html"
html = index.read_text()
start, end = html.index('  <meta name="description"'), html.index('  <title>')
index.write_text(html[:start] + head + "\n" + html[end:])
print(f"Refreshed {len(assets)} web resources from unchanged canonical geometry.")
