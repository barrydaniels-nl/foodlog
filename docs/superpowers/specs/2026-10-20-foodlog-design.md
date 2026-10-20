# Foodlog — Design

Date: 2026-10-20
Status: Draft, awaiting approval

## Intent

A personal food **planner** for a single user. The user opens it once a day
(morning or the night before) to plan what they'll eat, and once more later to
adjust or review. They mostly eat the same meals, made from fresh ingredients
plus store-bought products such as yogurts. They have daily **calorie** and
**protein** targets and want to see at a glance how the planned day compares
to them.

It has to look good and be easy to use. It runs on both phone and desktop and is
self-hosted in Docker on a Raspberry Pi, reachable only over the user's
Tailscale tailnet.

## Goals

- Plan a day quickly. Repeat meals should take one tap, not a search for each
  ingredient.
- See calories and protein against their targets clearly, with carbs, fat and
  fibre shown as totals.
- Keep a personal ingredient database that can be searched, added to, edited and
  deleted. All values are metric and stored per 100 g.
- Find new ingredients by name search or by phone-camera barcode scan, using
  Open Food Facts.
- Create and manage pre-configured (saved) meals.
- Feel good to use on both phone and desktop.

## Non-goals (for now)

- Weekly or monthly charts and history graphs
- Water, micronutrient or exercise / calorie-burn tracking
- Multiple users, accounts, login
- Offline use / sync
- Cloud hosting

## Anti-goals (a failure even if it technically works)

- Adding a usual breakfast is slow or needs many taps.
- It feels like a generic admin panel or spreadsheet instead of a pleasant app.
- Data is lost when the container is updated or rebuilt.
- Values arrive in non-metric units or per serving with no grams.

## Decided by the user

- **Language:** JavaScript. No heavy framework ("no fancy API needed").
- **Visual style: "A · Fresh"** (chosen from three mockups). Light, airy
  off-white background (`#f6f8f4`), white rounded cards with soft shadows,
  dark green-grey text, green accent (`#3f9c5f`) for calories and actions, and an
  indigo accent (`#5b6cf0`) for protein. Progress **rings** for the two targets,
  a floating round "+" button. Reference mockup:
  `.superpowers/brainstorm/*/content/visual-style.html`, option A. That path is
  not committed, so the tokens above are the source of truth.
- **Targets:** a daily calorie target and a daily protein target.
- **Saved meals:** the user explicitly wants pre-configured meals they can create
  and manage.
- **Lookup:** both text search and barcode scanning.
- **Single user.** No login; the tailnet is the access control.
- **Deployment:** Docker on a Raspberry Pi, accessed over Tailscale.

## Decided by Claude (user can override)

- **Stack:** a small Node.js server (Node LTS) serving a JSON API plus static
  files, and a vanilla JS / HTML / CSS frontend with no build step. Use native ES
  modules in the browser.
- **Storage:** SQLite, in one file on a named Docker volume (`/data/foodlog.db`).
- **Ingredient source:** Open Food Facts (free, no API key, strong EU product
  coverage). Results are **copied** into the local database when chosen. After
  that the app uses only the local copy, which the user can edit. Values are
  per 100 g (`energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`,
  `fat_100g`, `fiber_100g`). Products that are missing kcal are shown but have
  to be completed by hand before saving. Calls to OFF go through the backend,
  which sets a proper User-Agent as OFF requests and avoids CORS issues.
- **Barcode scanning:** the user is on an **iPhone**, where Safari has no
  `BarcodeDetector`, so a ZXing-based scanning library is required. **The user
  approved it.** Use the native `BarcodeDetector` where it exists and fall back
  to the library elsewhere. All library files, including any WASM, are served
  from the app itself and never from a CDN.
- **Linting:** ESLint as a dev-only dependency (user approved).
- **HTTPS for the camera:** browsers only allow camera access on secure origins.
  The container publishes a single port (default `8080`) on `127.0.0.1` only,
  so the home LAN can't reach it. The README documents
  running `tailscale serve --bg 8080` on the Pi host to get
  `https://<pi>.<tailnet>.ts.net`. No Tailscale sidecar in compose.
- **Zero runtime npm dependencies (Claude's call):** use built-in `node:http`
  and `node:sqlite` on Node 24 LTS. No native modules means the image builds
  cleanly on arm64.
- **Image (Claude's call):** built **on the Pi** with
  `docker compose up -d --build`. There is no registry and no CI workflow. It
  also builds on a Mac for local development.
- **Installable:** includes a web app manifest and icons so "Add to Home Screen"
  opens it full-screen. A service worker is not required (offline is a non-goal).

## What it does

### Day screen (home)

- Opens on **today**. Arrows (and swipe on mobile) move to earlier and later
  days, so the user can plan tomorrow.
- Header: two cards with rings, **kcal planned / kcal target** and **protein
  planned / protein target**. Below them, carbs, fat and fibre totals.
- Meal sections: **Breakfast, Lunch, Dinner, Snacks** (fixed for now). Each
  shows its entries (name, grams, kcal), its kcal subtotal, and "+ Add food".
- Tap an entry to change its grams or remove it.
- **Copy a previous day** into this day (adds to it, does not replace).
- **Save a meal section as a saved meal.**
- When a ring passes its target it shows that clearly, e.g. a different shade or
  an "over by N" note, without looking alarming.

### Adding food (to a meal section on a day)

One sheet/modal with:
1. **Search box.** Matches the user's own ingredients and saved meals first, as
   they type.
2. **"Search Open Food Facts"** for results that aren't in the local list.
3. **📷 Scan button.** Opens the camera and reads EAN/UPC barcodes. A known
   barcode → straight to the amount step. An unknown one → OFF lookup → confirm
   and edit values → saved to the local list → amount step.
4. **Amount step:** grams input, plus quick buttons for the ingredient's defined
   portions (e.g. "1 pot (150 g)"). It shows the resulting kcal and protein live.
5. Adding a **saved meal** copies its ingredients into that meal section as
   separate entries. An optional scale factor (×0.5, ×1, ×1.5, ×2) applies to all
   of them. Changing the entries afterwards does not change the saved meal.

### Foods screen (ingredient database)

- A searchable list of local ingredients.
- Add manually, edit or delete. Fields: name, brand (optional), barcode
  (optional), kcal, protein, carbs, fat, fibre (all per 100 g), and zero or more
  **portions** (label + grams, e.g. "1 pot = 150 g", "1 slice = 35 g").
- Import from OFF by search or barcode, with a chance to review and edit before
  saving.
- **Editing an ingredient (Claude's call):** day entries link to the
  ingredient and also keep a snapshot of its per-100 g values. When an
  ingredient is edited, entries on **today and future days** are updated to
  the new values; entries on **past days** stay frozen. That way fixing a wrong
  kcal value fixes the plan without rewriting history.
- **Deleting an ingredient (Claude's call):** this is a soft delete. The
  ingredient is archived: it is hidden from search and the Foods list, but past
  days and saved meals that use it still work. A saved meal that contains an
  archived ingredient shows a small "archived" badge on that item.
- **Drinks (Claude's call):** when OFF only has per-100 ml values, they are
  treated as per 100 g, which is close enough for drinks. Portions can still be
  labelled in ml.

### Meals screen (saved meals)

- List of saved meals with their kcal and protein totals.
- Create and edit: name, plus a list of ingredients with grams. Totals update
  live while building.
- Delete.

### Settings

- Daily kcal target and daily protein target (defaults 2000 kcal / 120 g until
  set).
- Export / import all data as JSON (a cheap backup). **Import replaces all
  data (Claude's call)** after an explicit confirmation. Before replacing, the
  server saves the current data to `/data/backups/pre-import-<time>.json`, so
  nothing is lost by accident. This replaced a browser download, which iOS
  doesn't guarantee.
- Open Food Facts search region, default **Netherlands / Dutch** (Claude's
  call): `nl` results ranked first, worldwide results still included.

## Layout

- **Mobile first.** Bottom tab bar on phones: Day · Meals · Foods · Settings.
  Large touch targets, and modal sheets that slide up from the bottom.
- **Desktop:** the same views in a centred, wider layout with a top or side nav.
  The day view can show the meal sections in two columns. No separate desktop
  design is needed.
- Works on recent iOS Safari, Android Chrome, and desktop Chrome, Firefox and
  Safari.

## Quality bar

- Unit tests for the server logic (nutrition maths, OFF response mapping, API
  handlers) using Node's built-in `node:test`. OFF is mocked in tests and never
  called for real.
- Tests and lint run through `docker compose` (the user's standing rule when a
  compose file exists).
- The README covers running locally, deploying to the Pi, `tailscale serve`, and
  backup/restore of the volume.

## Left to the builder

- Database schema, API routes, file structure.
- Routing structure on top of `node:http`. Ask before adding any dependency.
- Icon, typography and spacing details within the "A · Fresh" style.
