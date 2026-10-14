#!/usr/bin/env python3
"""Refresh committed web exports from approved Split K sources.

Requires Python 3, Pillow, and ImageMagick. Routine npm builds copy the committed
exports and check their hashes; they do not need a rasterizer or a font file.
"""
from copy import deepcopy
from pathlib import Path
import hashlib
import base64
import json
import math
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
RULES = json.loads((BRAND / "wordmark-source/lockup-rules.json").read_text())
sources = {}
assets = []


def source(relative):
    path = BRAND / relative
    data = path.read_bytes()
    sources[str(path.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
    if path.suffix == ".svg":
        tree = ET.fromstring(data)
        assert [p.attrib["points"] for p in tree.iter(f"{{{NS}}}polygon")] == POLYGONS
        assert not list(tree.iter(f"{{{NS}}}text"))
    return path


def record(filename, content_type, derived_from, size=None):
    path = OUT / filename
    item = {"route": "/" + filename, "source": str(path.relative_to(ROOT)),
            "contentType": content_type, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "derivedFrom": derived_from}
    if size:
        item["dimensions"] = list(size)
    assets.append(item)


def copy(relative, filename, content_type, size=None):
    path = source(relative)
    shutil.copyfile(path, OUT / filename)
    record(filename, content_type, [str(path.relative_to(ROOT))], size)


def render(svg, filename, size):
    subprocess.run(["magick", "-background", "none", "-density", "96", str(svg),
                    "-resize", f"{size[0]}x{size[1]}!", "-strip", "-colorspace", "sRGB",
                    "-alpha", "off", "PNG24:" + str(OUT / filename)], check=True)
    with Image.open(OUT / filename) as im:
        assert im.size == size and im.mode == "RGB"


copy("applied/favicon.svg", "favicon-light.svg", "image/svg+xml")
copy("applied/favicon-dark.svg", "favicon-dark.svg", "image/svg+xml")
copy("applied/favicon.ico", "favicon.ico", "image/x-icon")
copy("applied/apple-touch-icon.png", "apple-touch-icon.png", "image/png", (180, 180))
copy("favicon/safari-pinned-tab.svg", "safari-pinned-tab.svg", "image/svg+xml")

# The adaptive favicon switches between the two approved treatments. It never
# changes a polygon, its fill, or the nickel arm.
adaptive = ET.Element(f"{{{NS}}}svg", {"width": "64", "height": "64", "viewBox": "0 0 64 64"})
ET.SubElement(adaptive, f"{{{NS}}}title").text = "kanban.cards"
adaptive_style = ".dark{display:none}@media(prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}"
ET.SubElement(adaptive, f"{{{NS}}}style").text = adaptive_style
for scheme, relative in [("light", "applied/favicon.svg"), ("dark", "applied/favicon-dark.svg")]:
    group = ET.SubElement(adaptive, f"{{{NS}}}g", {"class": scheme})
    for polygon in ET.parse(source(relative)).getroot().findall(f"{{{NS}}}polygon"):
        group.append(deepcopy(polygon))
(OUT / "favicon.svg").write_bytes(ET.tostring(adaptive, encoding="utf-8") + b"\n")
record("favicon.svg", "image/svg+xml", ["brand/split-k/applied/favicon.svg", "brand/split-k/applied/favicon-dark.svg"])

tile = source("app-icons/app-icon-nickel.svg")
for size in [192, 512]:
    filename = f"app-icon-{size}.png"
    render(tile, filename, (size, size))
    record(filename, "image/png", [str(tile.relative_to(ROOT))], (size, size))
    # The approved square tile already keeps every painted pixel in the safe
    # zone, so any and maskable exports intentionally have identical pixels.
    maskable = f"maskable-{size}.png"
    shutil.copyfile(OUT / filename, OUT / maskable)
    with Image.open(OUT / maskable) as im:
        for y in range(size):
            for x in range(size):
                if im.getpixel((x, y)) != (11, 13, 14):
                    assert max(math.hypot(px - size / 2, py - size / 2)
                               for px in [x, x + 1] for py in [y, y + 1]) <= size * .4
    record(maskable, "image/png", [str(tile.relative_to(ROOT))], (size, size))

lockup = source("lockups/horizontal.svg")
assert hashlib.sha256(lockup.read_bytes()).hexdigest() == RULES["approvedHorizontalSha256"][lockup.name]
canonical = ET.parse(lockup).getroot()
width = float(canonical.attrib["width"])
height = float(canonical.attrib["height"])
social = ET.Element(f"{{{NS}}}svg", {"width": "1200", "height": "630", "viewBox": "0 0 1200 630"})
ET.SubElement(social, f"{{{NS}}}title").text = "kanban.cards"
ET.SubElement(social, f"{{{NS}}}rect", {"width": "1200", "height": "630", "fill": "#F7F6F2"})
group = ET.SubElement(social, f"{{{NS}}}g", {"data-role": "canonical-lockup", "transform": f"translate({(1200 - width * 2) / 2:.9f} {(630 - height * 2) / 2:.9f}) scale(2)"})
for child in canonical:
    group.append(deepcopy(child))
(OUT / "social-brand-v1.svg").write_bytes(ET.tostring(social, encoding="utf-8") + b"\n")
record("social-brand-v1.svg", "image/svg+xml", [str(lockup.relative_to(ROOT))], (1200, 630))
render(OUT / "social-brand-v1.svg", "social-brand-v1.png", (1200, 630))
record("social-brand-v1.png", "image/png", [str(lockup.relative_to(ROOT))], (1200, 630))

manifest = {"id": "/", "name": "kanban.cards", "short_name": "kanban.cards", "lang": "en",
            "description": "A simple Kanban board for projects run by you and your agents.",
            "start_url": "/", "scope": "/", "display": "standalone",
            "background_color": "#0B0D0E", "theme_color": "#0B0D0E",
            "icons": [{"src": f"/{prefix}-{size}.png", "sizes": f"{size}x{size}", "type": "image/png", "purpose": purpose}
                      for prefix, purpose in [("app-icon", "any"), ("maskable", "maskable")] for size in [192, 512]]}
(OUT / "site.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
record("site.webmanifest", "application/manifest+json", [])
style_hash = "sha256-" + base64.b64encode(hashlib.sha256(adaptive_style.encode()).digest()).decode()
(OUT / "asset-manifest.json").write_text(json.dumps({"version": 1, "sources": sources, "faviconStyleHash": style_hash, "assets": assets}, indent=2) + "\n")
routes = [[a["route"], "public/branding/" + Path(a["source"]).name, a["contentType"]] for a in assets]
(ROOT / "src/brand-web-assets.ts").write_text("// Generated by scripts/generate-web-brand-assets.py.\nexport const FAVICON_STYLE_HASH = " + json.dumps(style_hash) + ";\nexport const BRAND_WEB_ASSETS = " + json.dumps(routes, indent=2) + " as const;\n")
print(f"Refreshed {len(assets)} web resources from approved sources.")
