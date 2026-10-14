# Kanban website brand resources

The website uses the approved nickel Split K for browser and app icons. The sharing card uses the complete canonical Inter 780 horizontal lockup. These resources add browser, installation, and sharing identity to the existing themed header.

| Entry point | Resource | Approved source |
| --- | --- | --- |
| Adaptive browser favicon | `favicon.svg` | Both `applied/favicon.svg` and `applied/favicon-dark.svg` |
| Explicit light and dark browser icons | `favicon-light.svg`, `favicon-dark.svg` | Exact applied SVG bytes |
| Legacy browser fallback | `favicon.ico` | Exact applied ICO bytes with 16, 32, and 48px frames |
| Apple touch icon | `apple-touch-icon.png` | Exact applied 180px PNG bytes |
| Safari pinned tab | `safari-pinned-tab.svg` | Existing monochrome mask source |
| Installed app and maskable icons | `app-icon-192.png`, `app-icon-512.png`, `maskable-192.png`, `maskable-512.png` | `app-icons/app-icon-nickel.svg` |
| Open Graph and Twitter card | `social-brand-v1.png` | `lockups/horizontal.svg` at one uniform scale |
| Installed app metadata | `site.webmanifest` | Fixed product name, public icon references, and root-relative entry |

The adaptive favicon switches visibility between the two existing approved treatments. Its polygon points and fills remain unchanged. The server permits only the hash of that fixed display stylesheet on the adaptive SVG response. Page CSP remains unchanged. The explicit themed SVG links contain no stylesheet. Safari's pinned-tab API applies a single mask color, so its approved monochrome source is the documented exception to the nickel treatment.

The 1200 by 630px social card places the canonical lockup at exactly twice its source size, centered on an opaque Warm ivory background. Every mark polygon, outlined glyph, internal transform, and proportion stays intact. Metadata points to the public PNG at `https://kanban.cards/social-brand-v1.png`, with image type, dimensions, and alternate text. Use a new versioned filename when replacing that image. External platforms control their own cached previews.

The app tile remains opaque and square. Its existing placement keeps the complete silhouette and antialias pixels inside the 40% radius maskable safe zone. App and maskable files intentionally share pixels. Touch and app icons keep nickel in the lower arm. Platform rounding belongs to the platform mask.

The manifest uses `/` for its ID, start URL, and scope. Each host opens its own product entry route. The manifest contains no owner, Workspace, auth-intent, handoff, or query data. No service worker or offline behavior is introduced.

`src/brand.ts` provides the head metadata used by the server fallback. The static `index.html` contains the same metadata, and focused tests check that they match. The auth host allows only exact public GET and HEAD resource paths. Other methods, source directories, data routes, and encoded traversal paths remain restricted.

The site retains `noindex,nofollow` in HTML and response policy. Only the primary public root host's `robots.txt` permits the exact root and versioned sharing PNG for preview crawlers. Its query strings and other routes remain disallowed. Auth, Workspace, candidate, and unknown hosts return the blanket `Disallow: /` policy. These crawler declarations grant no authenticated access.

## Rebuild

From the repository root, refresh committed exports with Python 3, Pillow, and ImageMagick:

```sh
python3 scripts/generate-web-brand-assets.py
```

The generator verifies approved source geometry and the canonical lockup fingerprint, renders the fixed-size PNGs, checks maskable bounds, and writes the asset fingerprints and TypeScript route inventory. It requires no font file. Routine builds run `scripts/copy-brand-assets.mjs` through `npm run build:static`; they verify source and export hashes, check the route inventory, and copy exact bytes into ignored `public/branding/`. Routine Node builds need no Python or rasterizer.

Run `npm run check` and the focused brand/security tests before handoff. Inspect the favicon at actual 16, 24, 32, and 48px sizes in both themes, app icons under platform masks, and the complete social PNG. Browser evidence belongs under `output/playwright/` or the task's external evidence folder.
