# Kanban website brand resources

The website uses the approved nickel Split K and outlined Inter 780 lockup. The browser and installation icons implement Mike’s October 15, 2026 request to align favicon scale and corners across the three product sites. [derivative-rules.json](derivative-rules.json) records the colors, dimensions, placement, and raster recipe.

| Entry point | Current resource | Approved source |
| --- | --- | --- |
| Adaptive browser favicon | `favicon-v2.svg` | Both `applied/favicon.svg` and `applied/favicon-dark.svg` |
| Explicit themed browser icons | `favicon-v2-light.svg`, `favicon-v2-dark.svg`, and their 16/32px PNGs | Unchanged applied polygons and fills |
| Browser fallback | `favicon-v2.ico` | Light tile at 16, 32, and 48px |
| Apple touch icon | `apple-touch-icon-v2.png` | Light Split K on a square plate |
| Installed app icons | `app-icon-v2-192.png`, `app-icon-v2-512.png` | `app-icon-v2.svg` |
| Maskable app icons | `maskable-v2-192.png`, `maskable-v2-512.png` | `maskable-v2.svg` |
| Safari pinned tab | `safari-pinned-tab.svg` | Existing monochrome mask source |
| Open Graph and Twitter card | `social-brand-v2.png` | Complete `lockups/horizontal-reversed.svg` |
| Installed app metadata | `site.webmanifest` | Fixed product name and root-relative entry |

## Icon placement

Browser tiles use a 64 by 64px canvas and an 8px corner radius. The visible mark is 48px tall, centered at (32, 32) by its actual polygon bounds. The generator applies one uniform transform to the three original polygons. It preserves every point string and fill. Light tiles use an Ivory `#F7F6F2` plate with Ink `#0B0D0E` primary shapes. Dark tiles reverse those two colors. The lower arm remains Nickel `#8B9096` in both themes. The rounded plate is an external container; it does not round the mark.

Head links supply explicit light and dark SVGs and 16/32px PNGs with media queries. The adaptive SVG switches visibility between those same tiles. Only its exact fixed stylesheet hash is allowed on the two adaptive resource responses, `/favicon-v2.svg` and `/favicon.svg`. Page CSP stays unchanged. The ICO and unthemed raster fallbacks use the light tile. Safari's pinned-tab API applies a single mask color, so its approved monochrome source remains the documented exception.

Apple touch and regular app icons use the same 48px visible mark on an opaque, square Ivory plate. Maskable icons use a 36px visible mark, centered by the same bounds. The smaller maskable alternate keeps the complete silhouette and antialias pixels inside the central 80%-diameter safe-zone circle. The platform supplies the final mask. Regular and maskable icons intentionally have different placement.

Every icon PNG uses the same raster recipe: `magick -background none -density 384 source.svg -resize WIDTHxHEIGHT! -strip -colorspace sRGB PNG32:output.png`. This fixes the corner antialiasing across product icons. Browser PNG corners retain alpha; square installation icons have alpha 255 throughout.

## Sharing card

The 1200 by 630px card has an opaque Ink background. The complete reversed canonical lockup is centered using its full viewBox and one uniform scale: `min(2.8, 960 / viewBoxWidth)`. All mark polygons, outlined glyphs, internal transforms, and proportions remain intact. The image contains only that lockup and background. Preview title, description, and domain belong to the sharing platform's surrounding UI.

Metadata points to `https://kanban.cards/social-brand-v2.png`, with image type, dimensions, and alternate text. Existing unversioned icon aliases and `social-brand-v1.svg/png` contain the current export bytes so older references receive the same artwork. Future replacements need a new versioned filename. External platforms control their cached previews.

## Public delivery

The manifest uses `/` for its ID, start URL, and scope. It contains no owner, Workspace, auth-intent, handoff, or query data. No service worker or offline behavior is introduced.

`src/brand.ts` supplies the fallback head. Static `index.html` contains the same metadata, and focused tests check that they match. Only exact public GET and HEAD resource paths bypass auth-host routing restrictions. Other methods, source directories, data routes, and encoded traversal remain restricted.

HTML retains `noindex,nofollow`. Only the primary public root host's `robots.txt` permits the exact root and fixed versioned sharing PNGs for preview crawlers. Query strings and all other routes remain disallowed. Auth, Workspace, candidate, and unknown hosts return blanket `Disallow: /`. These declarations grant no authenticated access.

## Rebuild

Refresh the committed exports from the repository root with Python 3, Pillow, and ImageMagick:

```sh
python3 scripts/generate-web-brand-assets.py
```

The generator checks approved source geometry and canonical lockup fingerprints, renders PNGs, checks maskable bounds, and writes source/export fingerprints and the TypeScript route inventory. It requires no font file. Routine `npm run build:static` verifies those fingerprints and copies exact bytes into ignored `public/branding/`; it needs no Python or rasterizer.

Run `npm run check` and focused brand/security tests before handoff. Inspect actual-size 16/32px favicons in both themes, app icons under platform masks, and the complete social card. Save browser evidence in the task's local evidence folder. Canonical header lockups, legacy applied exports, and native app sources remain separate source assets.
