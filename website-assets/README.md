# Public website assets

The public Kanban shell uses the existing self-hosted Inter font from JudgmentKit commit `231a50acc3aa39a1d72df009f24cbca8bbc2cd93`, copied unchanged from `site/assets/fonts/`. The upstream download URL is not documented in that source repository. `manifest.json` records the source, license, and exact file fingerprints.

Inter is licensed under the SIL Open Font License 1.1. Keep `fonts/OFL.txt` with the font. `scripts/copy-website-assets.mjs` verifies both files before copying them into the ignored `public/fonts/` build directory.

`website.css` applies only under `body.public-website`. The client adds that marker only for signed-out root and auth pages and removes it for signed-in screens and local development. The Workbench stylesheet and its system typography remain unchanged.

The public homepage follows `docs/specs/website-family-layout.md`. Mike selected **B · Card cascade** on October 16, 2026. `kanban-card-cascade.webp` preserves the selected source bytes. `art-provenance.json` records the prompt, selection, fingerprint and initial CSS crop. The manifest verifies the image before copying it to the exact public image route. The image contains no page copy, controls or logo; `website.css` supplies the readability overlay. Desktop uses a centered crop; compact widths use an 80% horizontal crop to retain the Card progression and front queues. Rendered crop acceptance remains a separate visual check. The rejected architectural draft is excluded from this package.

`copy-provenance.md` maps the short homepage copy to `README.md` and `docs/product-vision.md`. Auth forms and their existing handlers remain separate from the homepage composition.
