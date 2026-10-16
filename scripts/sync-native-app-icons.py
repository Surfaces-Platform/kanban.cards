#!/usr/bin/env python3
"""Build both native Icon Composer documents from the canonical brand tile."""

import json
from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "brand/split-k/app-icons/app-icon-nickel.svg"
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)


def main():
    artwork = ET.parse(SOURCE).getroot()
    background = artwork.find(f"{{{SVG}}}rect")
    if background is None:
        raise ValueError("The canonical app tile must have a solid background")
    color = background.attrib["fill"].removeprefix("#")
    if len(color) != 6:
        raise ValueError("The canonical background must use a six-digit hex color")
    channels = [int(color[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    artwork.remove(background)
    foreground = ET.tostring(artwork, encoding="utf-8", xml_declaration=True) + b"\n"

    # Icon Composer's native container supplies platform masks and appearances.
    # Keep the approved artwork opaque and flat, with its existing SVG placement.
    document = {
        "fill": {"solid": "extended-srgb:" + ",".join(f"{v:.8f}" for v in channels) + ",1.00000000"},
        "groups": [{
            "name": "Split K",
            "layers": [{"name": "Split K Nickel", "image-name": "Foreground.svg", "glass": False}],
            "shadow": {"kind": "neutral", "opacity": 0},
            "translucency": {"enabled": False, "value": 0},
        }],
        "supported-platforms": {"squares": "shared"},
    }

    for platform in ("ios", "macos"):
        target = ROOT / platform / "KanbanCards/AppIcon.icon"
        assets = target / "Assets"
        assets.mkdir(parents=True, exist_ok=True)
        (assets / "Foreground.svg").write_bytes(foreground)
        (target / "icon.json").write_text(json.dumps(document, indent=2) + "\n")
        print(f"Updated {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
