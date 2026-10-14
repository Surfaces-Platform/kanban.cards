# kanban.cards Split K assets

Use the Split K with a nickel lower arm and the outlined Inter 780 wordmark. The canonical horizontal lockups use the same proportions and spacing as Surfaces and JudgmentKit. Mike approved these lockups on October 14, 2026.

[split-k.svg](split-k.svg) remains the geometry master. Its three polygons have not changed. [direction-lock.md](direction-lock.md) records the mark selection and current lockup contract. [wordmark-source/lockup-rules.json](wordmark-source/lockup-rules.json) supplies the exact values and approved SVG fingerprints used by the builder.

## Choose an asset

| Application | Asset |
| --- | --- |
| Horizontal lockup on light backgrounds | [lockups/horizontal.svg](lockups/horizontal.svg) |
| Horizontal lockup on dark backgrounds | [lockups/horizontal-reversed.svg](lockups/horizontal-reversed.svg) |
| Stacked lockup on light backgrounds | [lockups/stacked.svg](lockups/stacked.svg) |
| Stacked lockup on dark backgrounds | [lockups/stacked-reversed.svg](lockups/stacked-reversed.svg) |
| Transparent nickel mark on light backgrounds | [applied/brand-mark.svg](applied/brand-mark.svg) |
| Transparent nickel mark on dark backgrounds | [applied/brand-mark-dark.svg](applied/brand-mark-dark.svg) |
| Monochrome geometry master | [split-k.svg](split-k.svg) |
| Monochrome reversed mark | [svg/mark-reversed.svg](svg/mark-reversed.svg) |
| Inline monochrome mark that inherits text color | [svg/mark-currentcolor.svg](svg/mark-currentcolor.svg) |
| Applied light and dark browser favicons | [applied/favicon.svg](applied/favicon.svg), [applied/favicon-dark.svg](applied/favicon-dark.svg) |
| Applied ICO fallback and touch icon | [applied/favicon.ico](applied/favicon.ico), [applied/apple-touch-icon.png](applied/apple-touch-icon.png) |
| Nickel app tile source and 1024px export | [app-icons/app-icon-nickel.svg](app-icons/app-icon-nickel.svg), [app-icons/app-icon-nickel-1024.png](app-icons/app-icon-nickel-1024.png) |
| Monochrome app and maskable alternatives | [app-icons/app-icon.svg](app-icons/app-icon.svg), [192px](app-icons/maskable-192.png), [512px](app-icons/maskable-512.png) |
| Conventional monochrome Apple catalog | [app-icons/apple/AppIcon.appiconset/Contents.json](app-icons/apple/AppIcon.appiconset/Contents.json) |
| Monochrome macOS icon family | [app-icons/macos/kanban-cards.icns](app-icons/macos/kanban-cards.icns) |
| Motion concept | [svg/mark-motion.svg](svg/mark-motion.svg) |

SVG lockups contain glyph outlines and render without installed fonts. PNG lockups are transparent exports at four times the SVG dimensions. [proofs/lockup-proof.png](proofs/lockup-proof.png) shows the horizontal light and dark lockups at the same scale. [proofs/stacked-proof.png](proofs/stacked-proof.png) shows the stacked derivative in both themes. [index.html](index.html) provides the asset gallery.

## Lockup proportions

The canonical horizontal composition uses:

1. A 60px visible mark height, with unchanged polygon coordinates and uniform scaling only.
2. A 38px cap height in Inter at weight 780 and optical size 32. The effective font size is 52.2308724832px. Preserve the natural lowercase height and descenders.
3. A 20px gap from the mark's rightmost visible point to the wordmark's leftmost visible point.
4. A shared baseline at y=73. The cap box and visible mark both center at y=54.
5. At least 24px outer padding and a 109px canvas height. Width follows the complete wordmark and right padding.

Scale the whole lockup uniformly. Do not fit the mark and wordmark independently or change tracking, baseline, or their gap. The stacked derivative retains the same 60px mark and 38px cap height, centers both on one vertical axis, and leaves 20px between their visible bounds with at least 24px outer padding. Its canvas is 380 by 167px.

## Mark geometry and color

The standalone master uses `0 0 64 64`, with visible bounds x=6 to 58 and y=2 to 62. Keep the upright stem, both angled arms, the 8-unit stem separation, and the 4-unit central opening. No rounded corners, strokes, gradients, shadows, extra planes, or independent plane transforms belong to the mark.

The primary lockup uses Ink `#0B0D0E` on light backgrounds and Warm ivory `#F7F6F2` on dark backgrounds. Its lower arm stays Nickel `#8B9096` in both themes. Monochrome assets remain available when one color is required.

Leave at least 12 canonical units around standalone marks. App tiles center a 640px mark viewport on a 1024px square. The visible silhouette occupies 520 by 600px and stays inside the 409.6px maskable safe-zone radius. Platform masks belong to the container. Opaque app sources have square corners.

## Wordmark source

[wordmark-source/kanban-cards-wordmark.svg](wordmark-source/kanban-cards-wordmark.svg) contains the approved Inter 780 outlines at a 64px source size and baseline zero. [metrics.json](wordmark-source/metrics.json) records the 46.5625px source cap height, optical size 32, zero fallback runs, and the original font file fingerprint. No font binary is included.

Routine builds use the included outlines. To regenerate them on macOS, run the guarded CoreText helper with the exact approved Inter variable font file and an output directory:

```sh
swift brand/split-k/tools/outline-wordmark.swift /path/to/Inter-VariableFont_opsz,wght.ttf brand/split-k/wordmark-source
```

The helper rejects a different font fingerprint, axis values, fallback runs, or missing glyphs. The asset builder rejects outlines that differ from the approved glyph digest. Font replacement requires a new explicit selection and updated source rules.

## Rebuild and verify

From the repository root:

```sh
python3 brand/split-k/build_assets.py
python3 brand/split-k/validate_assets.py
python3 brand/split-k/package_assets.py
```

The builder requires Python 3, Pillow, and ImageMagick. It rebuilds lockups from the included vector sources without CoreText or an installed Inter font. `build_lockups.py` can refresh only the lockups and their proof. `build_applied_assets.py` rebuilds the existing applied nickel icon resources.

The validator checks canonical polygons, portable glyph outlines, approved horizontal fingerprints, typography, spacing, colors, raster sizes, alpha, masks, and icon packages. The package command refreshes the ZIP, SHA-256 inventory, and archive receipt after validation. Review the rendered light and dark lockup proof before handoff.

Updating this asset package does not deploy a site or change app typography. The conventional Apple catalog and macOS icon family remain monochrome alternatives; the native product's existing nickel icon is separate.
