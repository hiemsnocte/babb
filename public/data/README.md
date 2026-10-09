# Generated menu and weather snapshots

GitHub Actions runs `node scripts/prepare-site.cjs` before deploying Pages.
It reads the ordered restaurant catalog from `public/restaurants.json`. Entries
with `source.type: "capture"` read their menu from Firestore using the public
Firebase config in `public/config.json`; entries with `source.type: "static"`
read a checked-in image from `public/assets/menus/`. It validates every image's
file signature and size, then publishes:

- `menus.json`: capture date, update time, capture warnings, and ordered menus with
  local image paths, `menuType` (`daily` or `fixed`), and optional labeled links.
- `images/<restaurant>-<content hash>.<extension>`: local copies served by Pages.
- `weather.json`: one shared, three-day hourly Open-Meteo forecast for Namguro.

Image paths in the manifest are relative to the page, such as
`./data/images/bombom-0123456789abcdef.png`. Weather is optional. If its request
fails, an existing valid local snapshot up to 12 hours old can be retained;
otherwise it is omitted. A new Actions checkout normally has no previous weather
snapshot.

A missing required capture, invalid menu image, or unavailable menu source fails the
build before replacing generated files. GitHub Pages keeps its last successful
deployment when preparation fails. All configured menu images are validated before
any build output is staged. Generated JSON and images should not be committed.

To add a fixed menu, commit its image under `public/assets/menus/` and add a
catalog entry with a unique ID, display name, `source: { "type": "static",
"path": "./assets/menus/<file>.jpg" }`, and optional `links: [{ "label": "소식",
"url": "https://…" }]`. The card order follows the catalog. HTTPS links are shown
as links, never scraped. Static entries need no Firestore menu document or image
download, and a fixed-only catalog does not contact Firestore at build time.

To add an automatically captured menu, configure its capture source in
`capture.js` and add a matching ID with `source: { "type": "capture" }` to the
catalog. Every configured captured menu must be present before a new build is
published. The daily comment cleanup also reads this catalog, so new restaurants
are included automatically.
