# Product page

The public product page is a buildless static site served by the repository's existing GitHub Pages source: `main` / `docs`.

Edit `website/index.template.html`, `docs/assets/site.css`, and `docs/assets/site.js`. Regenerate the tracked page with Node 24 or newer:

```text
node scripts/build-pages.mjs
```

The generator imports the canonical application name from `src/lib/brand.ts` and reads the current version from `package.json`. `docs/.nojekyll` makes Pages serve the assets directly; no application build or hosted CI workflow is required.

## Interface captures

The three product images are copied without alteration from the October 6, 2026 web-mode verification captures in `e2e/visual-audit-output/1920x1080/`:

- `19-modal-new-flight.png` → `docs/assets/product-flights.png`
- `03b-agents.png` → `docs/assets/product-agents.png`
- `17-settings-cli-clients.png` → `docs/assets/product-workspaces.png`

These show actual frontend components with test authentication and sample or empty states. They do not prove native IPC, live PTY work, or paid-provider execution. The page captions preserve this distinction. Replace them with newer verified product captures when available.

The app icon comes from `icon-1024.png`. Inter webfonts and their license are copied from the existing `@fontsource/inter` dependency; the site loads no third-party font or analytics service.

Before publication, check the product tabs, keyboard navigation, external CTA links, image loading, and layout at desktop and phone widths. Push the generated page and its assets together.
