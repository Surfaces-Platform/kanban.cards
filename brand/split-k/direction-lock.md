# Split K direction lock

## Authority

1. Geometry source: `split-k.svg`, preserving the selected Split K candidate’s exact polygons. The original candidate fingerprint is recorded below; exploratory comparison files are outside this active package.
2. User selection: “Go with A. Refine the Split K and build out the SVG, favicon, and app icon assets.”
3. Mark selection recorded October 13, 2026, America/Los_Angeles.
4. Mike selected Inter at weight 780 for all three family wordmarks, then approved consistent proportions and spacing. On October 14, 2026, he requested these lockups become canonical in each repository.

## Canonical form

The mark contains exactly three filled polygons in a 64 × 64 coordinate system: one upright rectangular stem and two equal angled arms, mirrored across y=32. The stem is separated from both arms. The arms remain separated by an open central gap.

```text
Stem:      6,6 18,6 18,58 6,58
Upper arm: 26,16 58,2 58,16 26,30
Lower arm: 26,34 58,48 58,62 26,48
```

Visible bounds are x=6 to 58 and y=2 to 62. The stem-to-arm gap is 8 units. The central arm-to-arm gap is 4 units at x=26 and opens toward the right. No rounded corners or strokes belong to the mark.

## Include

1. The upright stem, both sloped arms, their relative sizes, and the selected open gaps.
2. Sharp ends and a flat silhouette.
3. Ink or ivory stem and upper arm with a nickel lower arm in primary lockups. Monochrome marks remain production alternatives.

## Exclude

1. Shared seams, hinges, rails, or other primitives from B or C.
2. Dots, ticks, outlined cards, enclosing frames, construction lines, gradients, and decorative shadows in the mark.
3. Any secondary symbol or hybrid.

## Contextual treatments

Ink is `#0B0D0E`; warm ivory is `#F7F6F2`; nickel is `#8B9096`. The primary horizontal and stacked lockups use nickel on the lower arm in both themes, with Ink or ivory on the remaining shapes and wordmark. The included `applied/` resources supply the selected nickel treatment for headers, favicons, and touch icons. Monochrome exports remain available for applications that need one color.

App backgrounds may use ink or ivory without changing the mark. Platform masks belong to the icon container. Store icon source images remain square and opaque. Transparent company/social marks use the free-standing silhouette.

The canonical horizontal lockups are `lockups/horizontal.svg` and `lockups/horizontal-reversed.svg`. They contain outlined lowercase `kanban.cards` in Inter at weight 780 and optical size 32. The 60px visible mark, 38px cap height, 20px measured ink gap, y=73 baseline, and minimum 24px padding are fixed. Mark and cap-box centers share y=54 in a 109px canvas. Use the whole composition at one uniform scale.

The stacked derivatives retain the same mark and type scale. Center both on one vertical axis, keep 20px between their visible bounds, and leave at least 24px outer padding. Do not equalize full wordmark bounds across names or remove natural lowercase and descender differences. `wordmark-source/lockup-rules.json` records source fingerprints and rebuild values.

Motion may reveal the three existing planes and must settle into the locked geometry.

## Responsive behavior

The master, 16px mark, favicon, and all larger exports use the same polygon coordinates and 64 × 64 coordinate system. The production refinement will clean the SVG source, fix deterministic export rules, and tune surrounding clear space and icon placement. It will not redraw the selected silhouette.

The legacy applied and native app sources retain their existing 62.5%-width mark viewport and full-viewBox favicon placement. Website derivatives follow the shared October 15, 2026 contract in `web/derivative-rules.json`: a 48px visible mark centered in a transparent 64px browser canvas in both themes. A synchronous shared controller selects exactly one light or dark ICO and updates it on theme changes. JavaScript-disabled browsers receive the light ICO through `noscript`; unqualified compatibility aliases retain the transparent dark mark. Apple and regular PWA icons keep the 48px placement on an opaque square Ink plate. Maskable PWA icons use the documented 36px visible-height alternate to fit the central 80%-diameter safe zone. Light and dark browser icons preserve the selected nickel lower arm and exact polygons. Website exports change the external container and whole-mark scale; the master and native sources stay unchanged.

## Optical decisions

The selected 4-unit central opening remains 1px at a 16px viewBox. The 8-unit stem separation becomes 2px. Actual-size exports must confirm both remain visible. If a future optical correction is needed, document it as a separate variant rather than silently replacing these coordinates.

## Validation

Compare the polygons in every SVG to the selected source. Confirm the horizontal lockups match their approved fingerprints, use the pinned Inter 780 outlines without live text, preserve the 60/38/20px proportions, and retain nickel in both themes. Inspect stacked derivatives using their measured vertical gap. Inspect actual 16, 24, 32, 48, and 96px exports on light and dark backgrounds. Check app icons under square, rounded-square, squircle-like, and circular masks. Confirm maskable artwork remains inside its safe zone. Inspect every primary asset for accidental readings and excluded details.

## Source fingerprint

Selected source SHA-256: `f44485659d12a4592d18ed8b060cc315cda4edbcad5a61ccedfa96be4697dba6`. The canonical SVG preserves its exact polygon coordinates.
