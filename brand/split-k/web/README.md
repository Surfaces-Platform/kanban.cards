# Kanban website brand resources

The website uses the approved nickel Split K and outlined Inter 780 lockup. The browser and installation icons implement Mike’s October 15, 2026 requests to align product icons and remove light fallback borders in dark themes. [derivative-rules.json](derivative-rules.json) records the colors, dimensions, placement, and raster recipe.

| Entry point | Current resource | Approved source |
| --- | --- | --- |
| Browser selection | `favicon-theme-{iconRevision}.js` | Shared synchronous theme controller |
| Themed browser ICOs | `favicon-{iconRevision}-light.ico`, `favicon-{iconRevision}-dark.ico` | Transparent applied marks at 16, 32, and 48px |
| Browser without JavaScript | Light themed ICO in `noscript` | Ink/Nickel transparent mark |
| Legacy browser aliases | `favicon.svg`, `favicon.ico`, stable and previous hashed paths | Transparent dark mark; explicit themed resources retain their theme |
| Apple touch icon | `apple-touch-icon-{iconRevision}.png` | Reversed Split K on a square Ink plate |
| Installed app icons | `app-icon-v2-192.png`, `app-icon-v2-512.png` | `app-icon-v2.svg` |
| Maskable app icons | `maskable-v2-192.png`, `maskable-v2-512.png` | `maskable-v2.svg` |
| Safari pinned tab | `safari-pinned-tab.svg` | Existing monochrome mask source |
| Open Graph and Twitter card | `social-brand-v2.png` | Complete `lockups/horizontal-reversed.svg` |
| Installed app metadata | `site.webmanifest` | Fixed product name and root-relative entry |

## Icon placement

Browser icons use a transparent 64 by 64px canvas. The visible mark is 48px tall, centered at (32, 32) by its actual polygon bounds. The generator applies one uniform transform to the three original polygons. It preserves every point string and fill. Light icons use Ink `#0B0D0E` primary shapes; dark icons use Ivory `#F7F6F2`. The lower arm remains Nickel `#8B9096` in both themes. Browser icons contain no plate, external corner radius, stroke, or baked-in border.

The head loads one synchronous classic script from the same origin. It reads `prefers-color-scheme`, creates exactly one typed ICO link before parsing finishes, and updates that same link when the theme changes. The head contains no competing static PNG or SVG favicon links. A single light ICO inside `noscript` supplies the JavaScript-disabled fallback. The theme controller is byte-identical across the product family and its fingerprint is recorded in the rules. It uses the existing `script-src 'self'` CSP; no inline script or policy exception is needed.

Each themed ICO contains exact corresponding PNG pixels at 16, 32, and 48px. The unqualified SVG, PNG and ICO aliases retain a transparent dark compatibility fallback. Explicit themed SVG and PNG resources remain served for direct consumers. Favicon SVGs contain no stylesheet. Safari's pinned-tab API applies a single mask color, so its approved monochrome source remains the documented exception. Native browsers can retain a previously processed icon after new bytes and paths are available; successful resource delivery does not prove an existing profile's cache has changed.

Apple touch and regular app icons use the same 48px visible reversed mark on an opaque, square Ink plate. Maskable icons use a 36px visible mark, centered by the same bounds. The smaller maskable alternate keeps the complete silhouette and antialias pixels inside the central 80%-diameter safe-zone circle. The PWA manifest also uses Ink for its background and theme colors. The platform supplies the final mask. Regular and maskable icons intentionally have different placement.

The raster recipe remains unchanged: `magick -background none -density 384 source.svg -resize WIDTHxHEIGHT! -strip -colorspace sRGB PNG32:output.png`. The same raster recipe applies across product icons. Both browser themes have alpha zero outside the mark, including all outer edges and corners. Square installation icons have alpha 255 throughout.

Head icon, touch, pinned-mask, and manifest links use fresh filenames containing `iconRevision`, the first 12 hex characters of SHA-256 over sorted icon route/export fingerprints, including the shared controller bytes. The PWA manifest references the same hashed app and maskable filenames. The generator derives the identity from actual bytes and synchronizes static `index.html` with `renderBrandHead()`. The previous `1965faabf6d1` filenames and stable aliases remain public compatibility routes and receive current derivative bytes; new hashed paths avoid reusing an older favicon or touch-icon cache.

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

The generator checks approved source geometry and canonical lockup fingerprints, renders PNGs, checks maskable bounds, and writes source/export fingerprints, hashed paths, the TypeScript route inventory, and the static head. It requires no font file. Routine `npm run build:static` verifies those fingerprints and copies exact bytes into ignored `public/branding/`; it needs no Python or rasterizer.

Run `npm run check` and focused brand/security tests before handoff. Inspect actual-size 16/32px favicons in both themes, app icons under platform masks, and the complete social card. Save browser evidence in the task's local evidence folder. Canonical header lockups, legacy applied exports, and native app sources remain separate source assets.
