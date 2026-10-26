# Micronutrients and Supplements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track 23 micronutrients per food and per logged supplement. Compare
them with the user's recommended amounts and upper limits on a new Micros page
with day and month views. Feed the result into the diet export and the day
analysis.

**Architecture:**
- **Shared modules:**
  - `micronutrients.js` defines the nutrient list, NEVO mapping, upper-limit
    bases and status thresholds.
  - `reference-values.js` holds the cited Gezondheidsraad/EFSA table and the
    profile lookup.
- **Server, food values:**
  - The NEVO import gains a `reference_micros` table.
  - Each ingredient gets a twin link, a status and its own label/AI values.
  - Values are resolved **at read time** (label → twin → AI → unknown).
- **Server, other modules:**
  - `server/supplements.js` holds the supplement catalogue, the day log and
    the daily set.
  - `server/micros.js` computes day, month and range summaries.
  - `server/micro-matcher.js` is a background worker that uses the existing
    OpenAI client to pick twins and estimate gaps.
- **Frontend:** a new Micros page with Day, Month and Review routes. Every
  other page stays as it is, apart from a twin line on the ingredient form and
  a Profile card in Settings.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite`, global `fetch`), vanilla
ES modules with no build step, `node:test`, ESLint. There are no new
dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-micronutrients-design.md`

## Global Constraints

- No new npm dependencies.
- Run everything through Docker Compose:
  - tests: `docker compose --profile test run --rm test npm test`
  - lint: `docker compose --profile test run --rm test npm run lint`
- **Work order** follows the user's policy: implement first, then write
  focused tests. A task is done only when its tests and lint pass.
- **Never commit.** Each task ends with its changes left unstaged for review,
  with a suggested conventional-commit message.
- **The 23 nutrient keys, in display order:**
  1. Vitamins: `vitaminA`, `thiamin`, `riboflavin`, `niacin`, `vitaminB6`,
     `folate`, `vitaminB12`, `vitaminC`, `vitaminD`, `vitaminE`, `vitaminK`
  2. Minerals: `calcium`, `magnesium`, `iron`, `zinc`, `selenium`, `iodine`,
     `potassium`, `phosphorus`, `copper`, `salt`
  3. Fatty acids: `epaDha`, `ala`

  Plus an internal key, `retinol`, which is never displayed and is used only
  for the vitamin A upper limit.
- **Thresholds:** red (`low`) below **66%**, amber (`fair`) 66–99%, green
  (`good`) at **100%** and above. "≈" is shown when the estimated share is
  above **0.25**.
- **Value origins:** `label`, `nevo` and `ai`.
- **Ingredient `micro_status`:** `pending`, `unconfirmed`, `confirmed` or
  `none`.
- **Ingredient `micro_job`:** `match`, `fill` or `NULL`.
- **Matcher:**
  - up to **40** candidates;
  - **3** attempts per food;
  - polls every **30 s**;
  - processes one food at a time;
  - never blocks a request.
- **What is sent to OpenAI for matching:** only the food's name, brand and
  per-100 g macros, plus the candidates. Never days, the profile or
  supplements.
- **NEVO blanks** are stored as *no row*, never as 0.
- **Micros are live:** they are never snapshotted into `entries` or
  `supplement_entries`.
- **Supplement units:**
  - folate is entered as **folic acid µg** and counted as DFE ×**1.7**;
  - vitamin A is entered as retinol µg;
  - vitamin D accepts IU at **40 IU = 1 µg**. The conversion happens in the
    form; the server stores µg.
- **Backups:** export version **2**; versions 1 and 2 both import.
- **User-facing copy:**
  - nav label `Micros`;
  - no-profile banner: `Set your sex and birth year in Settings to compare with what you need.`;
  - NEVO notice: `Upload the NEVO file again to add micronutrients`;
  - status label: `AI-matched · unconfirmed`;
  - coverage line: `{n} foods ({g} g) have no micronutrient data` (singular
    `1 food`);
  - day-analysis section title: `Micronutrients`;
  - over-limit markers by `limitKind`:
    - `ul`: `⚠ above upper limit`;
    - `safe`: `⚠ above safe level`;
    - `guideline`: `⚠ above guideline maximum`;
  - indicative marker: `indicative`, shown as small muted text next to the
    recommended amount when `indicative` is true.
- **Energy-based amounts** (thiamin, niacin, ALA) use the user's **kcal
  target** from Settings. The micro summaries take it from `settings.get()`.

## Review Focus

1. **NEVO not re-uploaded yet.** The matcher must stay idle, not ask the AI to
   estimate all 23 nutrients for every food because every twin looks blank.
   Test: Task 7 `matcher idles until NEVO has micronutrients`.
2. **A blank is not a zero.** Iodine is blank in NEVO for a food the user eats
   daily. The day must show it as unknown (and queue an AI fill), never count
   0 µg as measured. Test: Task 2 `blank micronutrient columns store no row`
   and Task 3 `resolve falls through to ai when the twin is blank`.
3. **The AI returns a code it wasn't offered, or a negative or absurd
   amount.** These must be rejected, counted as an attempt, and never stored.
   Test: Task 7 `rejects a twin code outside the candidates` and
   `drops estimates outside the nutrient's range`.
4. **Supplement-only upper limits.** 300 mg magnesium from a tablet plus
   400 mg from food must give ⚠ (supplement 300 > 250). 200 mg from a tablet
   plus 600 mg from food must not. Test: Task 6 `upper limit basis
   supplement ignores food`.
5. **Profile missing, or born this year.** Without sex or birth year the page
   must still show amounts, with no percentages or colours. Settings must
   reject a birth year that makes the user younger than 18. Test: Task 4
   `rejects birthYear under 18` and Task 6 `day without profile has null
   recommended and status`.

---

### Task 1: Shared micronutrient definitions and reference values

**Files:**
- Create: `public/js/shared/micronutrients.js`
- Create: `public/js/shared/reference-values.js`
- Test: `test/micronutrients.test.js`

**Interfaces:**
- Produces from `micronutrients.js`:
  - `MicroGroup = { VITAMINS: 'vitamins', MINERALS: 'minerals', FATTY_ACIDS: 'fattyAcids' }`
  - `UlBasis = { TOTAL: 'total', SUPPLEMENT: 'supplement', RETINOL: 'retinol', NONE: 'none' }`
  - `Origin = { LABEL: 'label', NEVO: 'nevo', AI: 'ai' }`
  - `MicroStatus = { LOW: 'low', FAIR: 'fair', GOOD: 'good' }`
  - `MICRONUTRIENTS`: a frozen array of
    `{ key, label, unit: 'mg'|'µg'|'g', group, ulBasis, supplementFactor, max, fromNevo(value: (column: string) => number|null): number|null }`.
    `max` is a per-100 g sanity ceiling used to validate AI and label values.
  - `MICRO_KEYS`: the 23 keys in display order.
  - `RETINOL_KEY = 'retinol'` and `NEVO_RETINOL_COLUMN = 'RETOL (µg)'`.
  - `MICRO_BY_KEY`: key → definition.
  - `LOW_PERCENT = 66`, `ESTIMATED_SHARE_LIMIT = 0.25`, `IU_PER_UG_VITAMIN_D = 40`.
  - `statusFor(percent: number|null): MicroStatus|null`
  - `roundMicro(value: number): number`, rounding to 3 significant digits
    (0 stays 0).
- Produces from `reference-values.js`:
  - `Sex = { FEMALE: 'female', MALE: 'male' }`
  - `MIN_AGE = 18`
  - `LimitKind = { UL: 'ul', SAFE: 'safe', GUIDELINE: 'guideline' }`
  - `RecommendedPer = { DAY: 'day', MJ: 'mj', ENERGY_PERCENT: 'energyPercent' }`
  - `KJ_PER_KCAL = 4.184`
  - `REFERENCE_VALUES`: per nutrient key, a list of
    `{ sex: Sex|null, minAge, maxAge: number|null, recommended: number|null, per: RecommendedPer, kind: 'ADH'|'AI'|null, indicative: boolean, upperLimit: number|null, limitKind: LimitKind|null, source: string }`.
    `sex: null` means both sexes. Age bands are per nutrient and inclusive.
  - `ageOn(birthYear: number, isoDate: string): number`, the year difference.
  - `referenceFor(key, { sex, age }): ReferenceRow`. It throws if no row
    matches, which is a data bug.
  - `targetsFor(profile: { sex, birthYear, microTargets }, isoDate, kcalTarget: number)`
    returns `Record<key, { recommended: number|null, upperLimit: number|null, limitKind, indicative: boolean }>`,
    or null when sex or birthYear is missing.
    - It converts per-energy values with `kcalTarget`:
      - `mj`: recommended × kcal × 4.184 / 1000;
      - `energyPercent`: g = kcal × recommended / 100 / 9.
    - A `microTargets[key]` override replaces `recommended` only, and
      clears `indicative`.

**NEVO mapping** (the `fromNevo` columns are exactly the CSV headers):

| key | unit | NEVO source | ulBasis | supplementFactor |
|---|---|---|---|---|
| vitaminA | µg | `VITA_RAE (µg)` | retinol | 1 |
| thiamin | mg | `THIA (mg)` | none | 1 |
| riboflavin | mg | `RIBF (mg)` | none | 1 |
| niacin | mg | `NIAEQ (mg)` | supplement | 1 |
| vitaminB6 | mg | `VITB6 (mg)` | total | 1 |
| folate | µg | `FOLFD (µg)` + 1.7 × `FOLAC (µg)` when either is known, else `FOL (µg)` | supplement | 1.7 |
| vitaminB12 | µg | `VITB12 (µg)` | none | 1 |
| vitaminC | mg | `VITC (mg)` | none | 1 |
| vitaminD | µg | `VITD (µg)` | total | 1 |
| vitaminE | mg | `VITE (mg)` | total | 1 |
| vitaminK | µg | `VITK (µg)` | none | 1 |
| calcium | mg | `CA (mg)` | total | 1 |
| magnesium | mg | `MG (mg)` | supplement | 1 |
| iron | mg | `FE (mg)` | total | 1 |
| zinc | mg | `ZN (mg)` | total | 1 |
| selenium | µg | `SE (µg)` | total | 1 |
| iodine | µg | `ID (µg)` | total | 1 |
| potassium | mg | `K (mg)` | none | 1 |
| phosphorus | mg | `P (mg)` | none | 1 |
| copper | mg | `CU (mg)` | total | 1 |
| salt | g | `NA (mg)` × 2.5 / 1000 | total | 1 |
| epaDha | mg | (`F20:5CN3 (g)` + `F22:6CN3 (g)`) × 1000, summing the known ones; null if both are blank | none | 1 |
| ala | g | `F18:3CN3 (g)` | none | 1 |

Nutrients with `ulBasis: 'none'` have `upperLimit: null` in every reference row.

**Reference values:** copy the "Reference values" section at the end of this
plan into `REFERENCE_VALUES`, with a `source` string per row.

- [ ] **Step 1: Implement `micronutrients.js` and `reference-values.js`** with
  the interfaces and tables above. Use JSDoc in the style of `nutrition.js`.
  There are no other imports apart from `reference-values.js` importing
  `MICRO_KEYS`.
- [ ] **Step 2: Add `test/micronutrients.test.js`**

```js
test('MICRO_KEYS lists the 23 nutrients in display order', () => {
  assert.equal(MICRO_KEYS.length, 23);
  assert.deepEqual(MICRO_KEYS.slice(0, 2), ['vitaminA', 'thiamin']);
  assert.deepEqual(MICRO_KEYS.slice(-3), ['salt', 'epaDha', 'ala']);
});

test('fromNevo derives salt, EPA+DHA and folate DFE and keeps blanks unknown', () => {
  const v = (cols) => (name) => cols[name] ?? null;
  assert.equal(MICRO_BY_KEY.salt.fromNevo(v({ 'NA (mg)': 400 })), 1);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({ 'F20:5CN3 (g)': 0.5, 'F22:6CN3 (g)': 1.2 })), 1700);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({ 'F22:6CN3 (g)': 1.2 })), 1200);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({})), null);
  assert.equal(MICRO_BY_KEY.folate.fromNevo(v({ 'FOLFD (µg)': 100, 'FOLAC (µg)': 10 })), 117);
  assert.equal(MICRO_BY_KEY.folate.fromNevo(v({ 'FOL (µg)': 80 })), 80);
  assert.equal(MICRO_BY_KEY.iodine.fromNevo(v({})), null);
});

test('statusFor uses 66 and 100 percent', () => {
  assert.equal(statusFor(65.9), 'low');
  assert.equal(statusFor(66), 'fair');
  assert.equal(statusFor(99.9), 'fair');
  assert.equal(statusFor(100), 'good');
  assert.equal(statusFor(null), null);
});

test('roundMicro keeps three significant digits', () => {
  assert.equal(roundMicro(1234.5), 1230);
  assert.equal(roundMicro(0.012345), 0.0123);
  assert.equal(roundMicro(0), 0);
});

test('targetsFor picks the band by sex and age and applies overrides', () => {
  const woman = targetsFor({ sex: 'female', birthYear: 1990, microTargets: {} }, '2026-10-26', 2000);
  const man = targetsFor({ sex: 'male', birthYear: 1990, microTargets: { vitaminD: 25 } }, '2026-10-26', 2000);
  assert.equal(woman.iron.recommended, 16);
  assert.equal(man.iron.recommended, 11);
  assert.equal(man.iron.limitKind, 'safe');
  assert.equal(man.vitaminD.recommended, 25);
  assert.equal(man.vitaminD.upperLimit, 100);
  assert.equal(woman.vitaminA.recommended, 680);
  assert.equal(woman.salt.recommended, null);
  assert.equal(woman.salt.upperLimit, 6);
  assert.equal(woman.salt.limitKind, 'guideline');
  assert.equal(woman.vitaminE.indicative, true);
  assert.equal(targetsFor({ sex: null, birthYear: 1990, microTargets: {} }, '2026-10-26', 2000), null);
});

test('targetsFor uses age bands on the viewed date', () => {
  const at = (birthYear, sex) => targetsFor({ sex, birthYear, microTargets: {} }, '2026-10-26', 2000);
  assert.equal(at(1957, 'male').vitaminD.recommended, 10); // 69
  assert.equal(at(1956, 'male').vitaminD.recommended, 20); // 70
  assert.equal(at(1976, 'male').vitaminB6.recommended, 1.5); // 50
  assert.equal(at(1975, 'male').vitaminB6.recommended, 1.8); // 51
  assert.equal(at(1977, 'female').calcium.recommended, 950); // 49
  assert.equal(at(1976, 'female').calcium.recommended, 1100); // 50
  assert.equal(at(1976, 'female').iron.recommended, 11); // 50
});

test('targetsFor converts energy-based values with the kcal target', () => {
  const t = targetsFor({ sex: 'male', birthYear: 1990, microTargets: {} }, '2026-10-26', 2000);
  assert.equal(roundMicro(t.thiamin.recommended), 0.837); // 0.1 mg/MJ × 8.368 MJ
  assert.equal(roundMicro(t.niacin.recommended), 13.4); // 1.6 mg/MJ
  assert.equal(roundMicro(t.ala.recommended), 1.11); // 0.5 % energy / 9 kcal per g
});

test('every nutrient has a reference row for each sex from 18 up', () => {
  for (const key of MICRO_KEYS) for (const sex of ['female', 'male']) for (const age of [18, 50, 51, 70, 71, 90]) {
    assert.doesNotThrow(() => referenceFor(key, { sex, age }), `${key} ${sex} ${age}`);
  }
});
```

- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add micronutrient definitions and Dutch reference values`

---

### Task 2: Schema migration and NEVO micronutrient import

**Files:**
- Modify: `server/db.js` (append migration 3)
- Modify: `server/nevo.js`
- Test: `test/nevo.test.js`
- Modify: `test/fixtures/nevo-sample.csv` (fill micronutrient cells for 9001 and 9002, and leave `ID (µg)` blank for 9002)

**Interfaces:**
- Consumes: `MICRONUTRIENTS`, `NEVO_RETINOL_COLUMN`, `RETINOL_KEY` (Task 1).
- Produces:
  - `parseNevoCsv`: each food gains `micros: Record<key, number>`, holding
    only the known values (including `retinol`). A food's existing fields
    are unchanged.
  - The reference repo gains:
    - `getMicros(code: number): Record<key, number>`
    - `searchCandidates(terms: string[], limit: number): Array<{code, name, nameEn, group, kcal, protein, carbs, fat}>`.
      It matches any term in `name`, `name_en` or `synonym`, deduplicates,
      and is not limited to foods missing from the personal list.
    - `hasMicros(): boolean`
  - `status()` gains `hasMicros`.
  - `GET /api/reference/search?q=…&all=1` includes foods already in the
    personal list. This is used by the twin picker.

**Migration 3** (exact DDL):

```sql
CREATE TABLE reference_micros (
  source TEXT NOT NULL, code INTEGER NOT NULL, nutrient TEXT NOT NULL, amount REAL NOT NULL,
  PRIMARY KEY (source, code, nutrient),
  FOREIGN KEY (source, code) REFERENCES reference_foods(source, code) ON DELETE CASCADE
);
ALTER TABLE reference_sources ADD COLUMN has_micros INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ingredients ADD COLUMN micro_twin_code TEXT;
ALTER TABLE ingredients ADD COLUMN micro_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE ingredients ADD COLUMN micro_job TEXT;
ALTER TABLE ingredients ADD COLUMN micro_attempts INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ingredient_micros (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  nutrient TEXT NOT NULL, amount REAL NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('label', 'ai')),
  PRIMARY KEY (ingredient_id, nutrient, origin)
);

CREATE TABLE supplements (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT, unit_label TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE supplement_nutrients (
  supplement_id INTEGER NOT NULL REFERENCES supplements(id) ON DELETE CASCADE,
  nutrient TEXT NOT NULL, amount REAL NOT NULL,
  PRIMARY KEY (supplement_id, nutrient)
);
CREATE TABLE supplement_entries (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  supplement_id INTEGER NOT NULL REFERENCES supplements(id),
  units REAL NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX supplement_entries_date ON supplement_entries(date);
CREATE TABLE supplement_set (
  supplement_id INTEGER PRIMARY KEY REFERENCES supplements(id),
  units REAL NOT NULL, position INTEGER NOT NULL
);

UPDATE ingredients SET micro_twin_code = reference_code, micro_status = 'confirmed', micro_job = 'fill'
  WHERE reference_code IS NOT NULL;
UPDATE ingredients SET micro_job = 'match' WHERE reference_code IS NULL;
```

- [ ] **Step 1: Append the migration**, and extend `parseNevoCsv` and the
  reference repo:
  - The micronutrient columns are **optional** in the header. A file without
    them still imports, with `has_micros = 0`.
  - `importNevo` inserts one `reference_micros` row per known value inside
    the existing transaction, and sets `has_micros` to 1 when any micro
    column was present.
  - The existing `clear` cascades to `reference_micros`.
- [ ] **Step 2: Add tests to `test/nevo.test.js`:**
  - `parseNevoCsv reads micronutrients and derives salt and EPA+DHA`: assert
    exact values for 9001.
  - `blank micronutrient columns store no row`: after `importSample()`,
    `getMicros(9002)` has no `iodine` key.
  - `status reports hasMicros after an import with micronutrient columns`.
  - `migration 3 links existing NEVO foods as confirmed twins with a fill job`:
    open a DB at `user_version` 2, insert one NEVO-linked ingredient and one
    manual ingredient, migrate, then assert twin, status and job for both.
  - `search with all=1 includes adopted foods`.
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: import NEVO micronutrients and add micronutrient schema`

---

### Task 3: Food micronutrient sources (twin, own values, resolution)

**Files:**
- Create: `server/food-micros.js`
- Modify: `server/ingredients.js`, `server/nevo.js` (adopt route), `server/off.js`, `server/app.js`
- Modify: `public/js/ui/ingredient-form.js` (pass `initial.micros` through on submit; there is no visible field yet)
- Test: `test/food-micros.test.js`, `test/off.test.js`

**Interfaces:**
- Consumes: Task 1 constants, and `reference.getMicros` (Task 2).
- Produces:
  - `validateMicroValues(input: unknown, field: string): Record<key, number>`.
    Keys must be in `MICRO_KEYS`, and each value must be a number in
    `0..MICRO_BY_KEY[key].max`. Otherwise it throws `HttpError(400)`.
  - `createFoodMicrosRepo(db, { reference })` returns:
    - `resolve(ids: number[]): Map<id, ResolvedFood>`, where
      `ResolvedFood = { status, twinCode, values: Record<key, { amount: number, origin }>, retinol: number|null, hasData: boolean }`.
      Per key, the order is: `label` row, then the twin's
      `reference_micros`, then the `ai` row. Unknown keys are absent.
      `retinol` comes from the twin only.
    - `info(id)`: `{ twinCode, twinName, status, job, label: Record, ai: Record }`
    - `writeLabelValues(id, values)`: replaces all `label` rows.
    - `setTwin(id, code: number|null)`: sets the twin, `confirmed`,
      `job = 'fill'`, `attempts = 0`, and deletes the `ai` rows.
    - `confirm(id)`: `unconfirmed` → `confirmed`.
    - `saveValues(id, values)`: user edits; stored as `label`, and the same
      keys' `ai` rows are deleted.
    - `queue(limit)`: rows with `micro_job IS NOT NULL` and `attempts < 3`,
      by id.
    - `finishJob(id, { twinCode?, status, aiValues })`
    - `failJob(id)`: increments attempts. At 3, it clears the job and sets
      `none` when the food has no twin and no values.
    - `listForReview()`: non-archived foods with status `unconfirmed`,
      `pending` or `none`, with `{ id, name, brand, status, twinCode, twinName, aiKeys: string[] }`.
  - `registerFoodMicroRoutes(router, { foodMicros })`:
    - `GET /api/micros/review`
    - `GET /api/ingredients/:id/micros` returns `info`
    - `POST /api/ingredients/:id/micros/confirm`
    - `PUT /api/ingredients/:id/micros/twin` with `{ code: number|null }`
      (the code must exist in NEVO, else 404)
    - `PUT /api/ingredients/:id/micros/values` with `{ values }`
  - Ingredients:
    - `create` accepts an optional `micros` (label values), stored in the
      same transaction.
    - New rows get `micro_job = 'match'` unless created through NEVO
      adoption.
    - `update` replaces the label values only when `micros` is present.
    - `hydrate` adds `micro: { twinCode, status }`.
  - NEVO adopt sets the twin to its own code, `confirmed`, `job = 'fill'`.
  - `mapOffProduct` adds `micros: Record<key, number>`, built from the OFF
    `<name>_100g` fields (grams), converted to the nutrient unit and rounded
    with `roundMicro`. These are mapped: `vitamin-d`, `calcium`, `iron`,
    `salt`, `potassium`, `magnesium`, `zinc`, `vitamin-b12`, `vitamin-c` and
    `folates`. Missing or invalid values are left out.

- [ ] **Step 1: Implement `server/food-micros.js`** and wire it in `app.js`
  (created before ingredients; passed as `createIngredientsRepo(db, { today, foodMicros })`).
- [ ] **Step 2: Extend ingredients, the NEVO adopt route, the OFF mapping and
  the form pass-through.**
- [ ] **Step 3: Add `test/food-micros.test.js`** using the test server and the
  NEVO sample:
  - `adopting a NEVO food makes it its own confirmed twin with a fill job`
  - `a new manual food is pending with a match job`
  - `resolve prefers label over twin over ai`
  - `resolve falls through to ai when the twin is blank`: twin 9002 with an
    `ai` iodine row gives an iodine origin of `ai`.
  - `setTwin clears ai values and queues a fill`
  - `saveValues stores label values and drops the ai row for that key`
  - `rejects unknown keys and values above max with 400`
  - `failJob marks a food without data as none after 3 attempts`
  - `listForReview leaves out confirmed and archived foods`
  - `creating with micros stores label values; updating without micros keeps them`
  - `editing a NEVO food's macros keeps its twin`: `referenceCode` becomes
    null, while `micro.twinCode` stays `nevo:9001`.
- [ ] **Step 4: Add to `test/off.test.js`:** `mapOffProduct maps micronutrients
  from grams`. For example, `vitamin-d_100g: 0.0000025` gives `vitaminD: 2.5`
  and `salt_100g: 1.2` gives `salt: 1.2`. Absent fields are not present.
- [ ] **Step 5: Run** the tests and lint. Expected: both pass.
- [ ] **Step 6: Leave unstaged.** Suggested message: `feat: resolve food micronutrients from label, NEVO twin and AI values`

---

### Task 4: Profile settings

**Files:**
- Modify: `public/js/shared/constants.js` (`DEFAULT_SETTINGS` gains `sex: null, birthYear: null, microTargets: {}`)
- Modify: `server/settings.js`
- Test: `test/settings.test.js`

**Interfaces:**
- Produces: `settings.get()` also returns `sex`, `birthYear` and
  `microTargets`. `PUT /api/settings` accepts:
  - `sex`: `'female'`, `'male'` or `null`.
  - `birthYear`: an integer from 1900 to (current year − `MIN_AGE`), or
    `null`.
  - `microTargets`: replaces the whole map. Keys must be in `MICRO_KEYS`,
    and each value a number above 0 and up to `MICRO_BY_KEY[key].max * 100`.
- The server's "current year" comes from a `today()` dependency, so tests are
  deterministic. That means `createSettingsRepo(db, { today })`, with the
  caller in `app.js` updated.

- [ ] **Step 1: Implement the validation.**
- [ ] **Step 2: Add tests:**
  - `saves sex, birthYear and microTargets`
  - `rejects birthYear under 18`: with today `2026-10-21`, 2009 → 400 and
    2008 → OK.
  - `rejects unknown microTargets keys`
  - `null clears sex and birthYear`
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add profile and personal micronutrient targets to settings`

---

### Task 5: Supplements, daily set and supplement log

**Files:**
- Create: `server/supplements.js`
- Modify: `server/app.js`
- Test: `test/supplements.test.js`

**Interfaces:**
- Consumes: `validateMicroValues` (Task 3).
- Produces:
  - `createSupplementsRepo(db)` returns:
    - `list({ includeArchived })`, `get(id)`, `create(input)`,
      `update(id, input)`, `archive(id)`, `restore(id)`
    - `getSet()`: `[{ supplementId, name, units }]`, and `putSet(items)`:
      `items` is `[{ supplementId, units }]`; it replaces the set and keeps
      the order.
    - `entriesForRange(from, to)`: rows of
      `{ id, date, supplementId, name, brand, unitLabel, units, position }`
    - `addEntry(date, { supplementId, units })`,
      `updateEntry(id, { units })`, `removeEntry(id)`, `addSet(date)`,
      `copyDay(date, { fromDate })`. Each returns the day's entries list.
    - `nutrientsFor(ids): Map<id, Record<key, number>>`, holding the raw
      per-unit amounts (folate as folic acid).
  - A supplement is
    `{ id, name, brand, unitLabel, archived, nutrients: Record<key, number> }`.
    The input requires `name` (max 120), `unitLabel` (max 30) and at least
    one nutrient; `brand` is optional (max 80). Nutrient amounts are per
    unit, from 0 to 100000.
  - `units` must be from 0.25 to 20.
  - Routes:
    - catalogue: `GET/POST /api/supplements`,
      `GET/PUT/DELETE /api/supplements/:id`,
      `POST /api/supplements/:id/restore`
    - daily set: `GET/PUT /api/supplement-set`
    - day log: `POST /api/days/:date/supplements`,
      `POST /api/days/:date/supplements/set`,
      `POST /api/days/:date/supplements/copy`,
      `PATCH /api/supplement-entries/:id`,
      `DELETE /api/supplement-entries/:id`
  - Adding the set to a day that already has some of those supplements adds
    them again. The user removes duplicates (same as meals).
  - Copying from the same day gives 400 `Pick a different day to copy from`.
  - Archived supplements stay in past logs and in the set; they can't be
    newly added (400).

- [ ] **Step 1: Implement `server/supplements.js`**, following
  `server/meals.js`'s repo and route style, and register it in `app.js`.
- [ ] **Step 2: Add `test/supplements.test.js`:**
  - `creates, lists, updates and archives a supplement`
  - `requires at least one nutrient`
  - `puts the daily set and adds it to a day in order`
  - `copies supplements from another day`
  - `rejects copying from the same day`
  - `rejects adding an archived supplement`
  - `updates units and removes an entry`
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add supplement catalogue, daily set and day log`

---

### Task 6: Micronutrient day, month and range summaries

**Files:**
- Create: `server/micros.js`
- Modify: `server/app.js`
- Test: `test/micros.test.js`

**Interfaces:**
- Consumes: `foodMicros.resolve` (Task 3); `supplements.entriesForRange`
  and `nutrientsFor` (Task 5); `settings.get` (Task 4); `targetsFor` and
  `ageOn` (Task 1).
- Produces `createMicrosService(db, { settings, foodMicros, supplements, today })`
  with:
  - `getDay(date): MicroDay`
  - `getRange(dates: string[]): MicroSummary`, over the completed days in
    `dates` (date < today with at least one food entry).
  - `getMonth(month): MicroSummary & { month }`

  Routes: `GET /api/micros/days/:date` and `GET /api/micros/months/:month`.

  The `MicroNutrientRow` type:
  `{ key, label, unit, group, food, supplements, total, recommended, indicative, upperLimit, limitKind, ulBasis, limitAmount, percent, status, overLimit, estimatedShare, sources: [{ kind: 'food'|'supplement', id, name, amount, share }] }`.
  Targets come from `targetsFor(profile, date, settings.kcalTarget)`.
  - All amounts use `roundMicro`.
  - `percent` = total / recommended × 100, rounded to a whole number, or null.
  - `limitAmount` is the amount compared with the upper limit:
    - `total` basis: food + supplements;
    - `supplement` basis: the **raw** supplement amount (folic acid before
      ×1.7);
    - `retinol` basis: food retinol + supplement vitamin A;
    - `none` basis: null.
  - `overLimit` = limitAmount > upperLimit.
  - `estimatedShare` = the amount from `ai` values, plus twin values on
    `unconfirmed` foods, divided by the total. It is 0 when the total is 0.
  - `sources`: the top 8 by amount, plus one `{ kind: 'other', name: 'Others', … }`
    row when there are more.

  `MicroDay` is
  `{ date, profile: { sex, age }|null, supplements: SupplementEntry[], nutrients: MicroNutrientRow[], coverage: { missingFoods, missingGrams } }`.
  A missing food is an entry whose ingredient has `hasData = false`; it is
  counted once per ingredient, and its grams are summed.

  `MicroSummary` is
  `{ completedDays, profile, nutrients: Array<MicroNutrientRow & { daysBelow, daysOverLimit }>, coverage }`.
  - Amounts are averages over the completed days.
  - `recommended` and `upperLimit` are averages of each day's own targets.
  - `daysBelow` counts days whose own percent < 66.
  - `daysOverLimit` counts days that were over the limit.
  - `sources` are averaged the same way.
  - With 0 completed days, all amounts are 0, `percent` and `status` are
    null, and the counts are 0.

- [ ] **Step 1: Implement `server/micros.js`.** Food amount = resolved
  per-100 × grams / 100, and a supplement's contribution = amount × units ×
  `supplementFactor`. Resolve each ingredient once per call. Load the range's
  entries with one query, like `getMonth` in `days.js`.
- [ ] **Step 2: Add `test/micros.test.js`.** Seed the data through the API,
  plus direct `db` inserts for `ai` rows:
  - `day sums food and supplements per nutrient`
  - `folic acid counts as DFE x1.7 but the upper limit uses the raw amount`
  - `upper limit basis supplement ignores food`: 300 mg magnesium tablet + 400
    mg food → `overLimit`; 200 + 600 → not.
  - `vitamin A upper limit uses retinol, not RAE`
  - `estimated share counts ai values and unconfirmed twins`
  - `day without profile has null recommended and status`
  - `coverage counts foods without any micronutrient data`
  - `top sources are sorted, capped at 8 plus others`
  - `month averages completed days only and counts days below 66 percent`:
    today `2026-10-21`; days 10-19 and 10-20 are logged, 10-21 is logged
    (excluded), and 10-22 is future.
  - `month with no completed days has zero amounts and null percent`
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: compute daily and monthly micronutrient summaries`

---

### Task 7: AI matcher

**Files:**
- Create: `server/micro-matcher.js`
- Modify:
  - `server/app.js`: `createApp` gains the option `startMatcher = false`.
    When it is true and `openAi` is set, it builds the matcher from its own
    repos and calls `start()`.
  - `server/index.js`: passes `startMatcher: true`, and logs
    `Micronutrient matching: on` or
    `Micronutrient matching: off (no OPENAI_API_KEY)`.
  - Tests build the matcher directly; `test/helpers.js` is unchanged.
- Test: `test/micro-matcher.test.js`

**Interfaces:**
- Consumes: `openAi.generateJson` (existing); `reference.searchCandidates`,
  `getMicros` and `hasMicros` (Task 2); `foodMicros.queue`, `finishJob`,
  `failJob` and `resolve` (Task 3).
- Produces
  `createMicroMatcher({ db, openAi, reference, foodMicros, intervalMs = 30_000 })`,
  which returns `{ runOnce(): Promise<number>, start(), stop() }`.
  `runOnce` returns the number of foods processed.
  - If `!reference.hasMicros()`, it returns 0 and touches nothing.
  - **`match` job:**
    1. `micro_search_terms` returns `{ terms: string[] }` (1–6, Dutch and
       English). The server keeps up to 6 non-empty terms.
    2. Call `searchCandidates(terms, 40)`.
    3. `micro_twin` returns `{ code: integer|null }`. A code that isn't in
       the candidates counts as a failure (`failJob`).
    4. Fill the gaps (below), then `finishJob(id, { twinCode, status: 'unconfirmed', aiValues })`.
  - **`fill` job:** fill the gaps only, then
    `finishJob(id, { status: <unchanged>, aiValues })`.
  - **Gaps** are the `MICRO_KEYS` with no label value and no twin value. When
    there are gaps, `micro_estimate` returns
    `{ values: [{ key, amount }] }`. The schema's `key` is an `enum` of the
    gap keys.
    - Values outside `0..max`, or for keys that aren't gaps, are dropped.
    - Remaining gaps the model skipped stay unknown.
  - Any `OpenAiError` triggers `failJob(id)` and is logged with the
    ingredient id. Other errors propagate.
  - **Prompts** (in the module, like `analysis.js`): estimate per 100 g of
    the food as sold, in the given unit; prefer the Dutch market; prefer a
    raw or unprepared twin unless the name says it's prepared.

- [ ] **Step 1: Implement the matcher.** The `start()` interval uses
  `unref()` and never overlaps runs (it skips a tick while a run is busy).
- [ ] **Step 2: Add `test/micro-matcher.test.js`**, with a scripted fake
  `generateJson` that returns answers by `name`:
  - `matcher idles until NEVO has micronutrients`
  - `matches a twin and fills the twin's blanks with ai values`
  - `rejects a twin code outside the candidates`: `attempts` becomes 1, and
    the twin is unset.
  - `no twin leads to estimates for all gaps and status unconfirmed`
  - `drops estimates outside the nutrient's range`
  - `fill job keeps a confirmed status`
  - `gives up after 3 failures and marks the food none`
  - `sends only name, brand, macros and candidates`: inspect the `input` JSON
    keys.
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: match foods to NEVO twins and estimate gaps with AI`

---

### Task 8: Backup version 2

**Files:**
- Modify: `server/backup.js`
- Test: `test/backup.test.js`

**Interfaces:**
- Consumes: the tables from Task 2.
- Produces: an export with `version: 2`. It adds:
  - `ingredients[].micro`:
    `{ twinCode: string|null, status, values: [{ nutrient, amount, origin }] }`
  - `supplements`:
    `[{ id, name, brand, unitLabel, archived, nutrients: Record<key, number> }]`
  - `supplementSet`: `[{ supplementId, units }]`
  - `supplementEntries`: `[{ id, date, supplementId, units, position }]`

  The settings already carry the profile.
- **Import:**
  - Accepts versions 1 and 2. Validates the new rows, and checks that
    `supplementId` references exist.
  - For each ingredient, the job is derived:
    - `pending` → `match`;
    - `confirmed` with a twin → `fill`;
    - otherwise NULL.
  - Version 1 ingredients become: a NEVO-linked food → twin = its
    `referenceCode`, `confirmed`, `fill`; anything else → `pending`,
    `match`.
  - The delete order covers the new tables.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Add tests:**
  - `version 2 round-trips supplements, set, log, twins and values`
  - `imports a version 1 backup and queues matching`
  - `rejects a supplement entry that references a missing supplement`
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: include supplements and micronutrient data in backups`

---

### Task 9: Diet export and day analysis

**Files:**
- Modify: `server/diet-export.js`, `server/analysis.js`, `server/app.js`
- Modify: `public/js/ui/day-analysis.js`
- Test: `test/diet-export.test.js`, `test/analysis.test.js`

**Interfaces:**
- Consumes: `micros.getDay` and `micros.getRange` (Task 6), and
  `supplements.getSet` (Task 5).
- **Diet export:**
  - `buildDietReport({ days, todayIso, micros })`, where
    `micros = { byDate: Map<date, MicroDay>, summary: MicroSummary }`.
  - **Header:** adds `Profile: {sex}, {age}` (or `Profile: not set`) and the
    note `Micronutrients use the current best values per food, not snapshots;
    "≈" marks values that are more than 25% estimated.`
  - **Summary:** adds `## Micronutrients (average per completed day)` with a
    Markdown table. The columns are: Nutrient | Food | Supplements | Total |
    Recommended | % | Upper limit | Days below 66% | Estimated.
    - `⚠ ` goes before the upper limit when `overLimit`.
    - The Estimated column is a whole-number percentage.
  - **Each day with supplements** gets the line
    `Supplements: Vitamin D 25 µg × 1, Magnesium × 2`. That's the name and
    units, using the unit label.
- **Day analysis:**
  - `buildAnalysisInput` gains `micronutrients` and `supplements`:
    - `micronutrients`: per nutrient
      `{ key, unit, food, supplements, recommended, upperLimit, percent, overLimit, estimatedShare }`.
    - `supplements`: `{ logged: boolean, items: [{ name, units, unitLabel }] }`.
      When the day has no supplement entries and isn't in the past, `items`
      is the daily set, with `logged: false`.
  - `ANALYSIS_SCHEMA` adds the required `micronutrients: tipList`.
  - The instructions add: 0–4 tips for nutrients below 66% (food changes
    first, then supplements) or over the upper limit; an empty list when
    nothing stands out; never advise exceeding an upper limit or taking
    medication; and "≈" for estimates.
  - `parseAnalysis` returns `micronutrients` with the same cleaning.
  - The sheet renders a `Micronutrients` section when the list is non-empty.

- [ ] **Step 1: Implement both, and wire `micros` and `supplements` into
  their routes in `app.js`.**
- [ ] **Step 2: Add tests:**
  - `diet report lists supplements per day and a micronutrient table`
  - `diet report shows profile not set`
  - `analysis input includes micronutrients and logged supplements`
  - `analysis input uses the daily set when no supplements are logged`
  - `parseAnalysis caps micronutrient tips at 4`
  - Update the existing schema and parse tests for the new required field.
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add micronutrients and supplements to diet export and day analysis`

---

### Task 10: Micros page (day and month views)

**Files:**
- Create: `public/js/views/micros.js`, `public/js/ui/micro-rows.js`
- Modify: `public/index.html` (nav link `Micros` between Month and Meals, `data-nav="micros"`, `data-icon="pill"`), `public/js/ui/icons.js` (`pill` path), `public/js/app.js` (routes), `public/css/app.css`

**Interfaces:**
- Consumes: `GET /api/micros/days/:date` and `/api/micros/months/:month`
  (Task 6), the supplement routes (Task 5), and `openSheet` and `segmented`
  (existing).
- Produces:
  - **Routes:** `#/micros` (today's day), `#/micros/day/YYYY-MM-DD`,
    `#/micros/month/YYYY-MM`.
  - `microRows(nutrients, { mode: 'day'|'month', onOpen })` renders grouped
    rows (Vitamins / Minerals / Fatty acids):
    - **Bar:** a food segment and a supplement segment as a share of
      `recommended`, with the visual cap at 150%.
    - **Text:** `total unit · percent%`.
    - **Status class:** `micro-low`, `micro-fair` or `micro-good`.
    - **Markers:** the over-limit marker for the row's `limitKind` (see
      Global Constraints) when `overLimit`; `≈` when
      `estimatedShare > 0.25`; and `indicative` when `indicative` is true.
    - **Month mode** adds `days below 66%: {daysBelow} / {completedDays}`,
      plus `days over limit: n / m` when n > 0.
    - **When `recommended` is null** (e.g. salt, or no profile), the bar uses
      `upperLimit` as its scale with a neutral colour, or is hidden if
      neither exists.
  - `openSourcesSheet(row)`: a list of `name · amount unit · share%`.
- **Day mode:**
  - **Header:** a date title with prev/next buttons and a `Day | Month`
    segmented control.
  - **Supplements card:**
    - Each entry has a units stepper (±0.5) and remove.
    - Actions `Add supplement`, `Add my daily supplements` and
      `Copy from previous day`.
    - A `Manage supplements` link (Task 11).
  - **Below:** the coverage line, then the rows.
- **Month mode:** the month title with prev/next, `Daily average ·
  {n} completed days`, and the rows. With 0 completed days it shows
  `No completed days yet this month.`
- **No profile:** the banner from Global Constraints links to `#/settings`.

- [ ] **Step 1: Implement**, in the existing view style (`day.js` and
  `month.js`).
- [ ] **Step 2: Manually check it in the running app** (`run` skill or
  `docker compose up`):
  - a day with food and supplements;
  - a month;
  - no profile;
  - the sources sheet on a phone-sized viewport.
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add Micros page with day and month overviews`

---

### Task 11: Supplement catalogue, daily set, review list, twin picker, settings

**Files:**
- Create:
  - `public/js/views/supplements.js` (`#/micros/supplements`)
  - `public/js/ui/supplement-form.js`
  - `public/js/views/micros-review.js` (`#/micros/review`)
  - `public/js/ui/nevo-picker.js`
- Modify:
  - `public/js/app.js`
  - `public/js/ui/ingredient-form.js` (the "Micronutrients from" line)
  - `public/js/views/settings.js` (Profile card and NEVO notice)
  - `public/css/app.css`

**Interfaces:**
- Consumes: the routes from Tasks 2, 3, 4 and 5.
- Produces:
  - `openNevoPicker({ title, onPick(code: number|null) })`: a sheet with a
    NEVO search (`/api/reference/search?all=1`) and a `No twin — estimate
    with AI` action. It is used by the review list and the ingredient form.
  - `supplementForm({ initial, onSubmit, onDelete })`:
    - name, brand and unit label;
    - a nutrient list where the user adds a row (a nutrient select plus an
      amount);
    - the folate row is labelled `Folic acid (µg)`;
    - the vitamin D row has a `µg | IU` toggle that converts before submit.
- **Supplements view:**
  - The catalogue list, with add/edit/archive.
  - A `My daily supplements` editor: an ordered list with units, add from
    the catalogue, and remove. It saves via `PUT /api/supplement-set`.
- **Review view:** one card per food with:
  - the name;
  - the status chip `AI-matched · unconfirmed`, `No data yet` or
    `No data`;
  - the twin name or `AI estimate`;
  - the estimated keys, with editable amounts that save via `values`;
  - the buttons `✓ Confirm`, `✎ Change twin` and `✕ No twin`.
- **Ingredient form:** for an existing ingredient (`initial.id`), show
  `Micronutrients from: {twinName|AI estimate|none yet} · {status}`, with a
  `Change` action that opens `openNevoPicker`.
- **Settings:**
  - A `Profile` card with sex (segmented Female / Male), birth year, and
    `Your own amounts` (a list of nutrient + amount, added and removed like
    portions). It saves via `PUT /api/settings`.
  - The NEVO card shows `Upload the NEVO file again to add micronutrients`
    when `status.hasMicros === false`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Manually check it in the running app:**
  - create a supplement with folic acid and vitamin D in IU, and check the
    stored µg;
  - edit the daily set and add it to a day;
  - confirm and change a twin;
  - set the profile, then see the percentages appear.
- [ ] **Step 3: Run** the tests and lint. Expected: both pass.
- [ ] **Step 4: Leave unstaged.** Suggested message: `feat: add supplement catalogue, match review and profile settings`

---

### Task 12: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Micronutrients and supplements" section:**
  - the value sources and their order;
  - the "≈" and unconfirmed labels;
  - micros being live, not snapshots;
  - re-uploading NEVO;
  - what the matcher sends to OpenAI, and that it is off without a key;
  - supplement entry rules (folic acid, IU);
  - the reference-value sources, with links;
  - that thiamin, niacin and ALA scale with the kcal target;
  - the Dutch vitamin D supplement advice (10 µg for women 50–70 and for
    people with little sun; 20 µg for 70+) as a note.

  Update the feature list and the "Non-goals" wording if needed. Add the
  `Micronutrient matching: on/off` log line to the configuration notes.
- [ ] **Step 2: Leave unstaged.** Suggested message: `docs: document micronutrients and supplements`

---

## Reference values

These are adults aged 18 and over, not pregnant or lactating. Researched on
2026-10-26 against the primary documents listed below. Age bands are
inclusive, `+` means no upper age, and M/F means one row with `sex: null`.

**About the upper limits:**
- The Gezondheidsraad adopted EFSA's ULs, including future revisions
  (advisory 2023/04). So the ULs are the current EFSA values (EFSA UL
  overview v11, August 2025).
- `limitKind` is `ul` unless stated otherwise.

| key | sex | ages | recommended | per | kind | indicative | upperLimit | limitKind | source |
|---|---|---|---|---|---|---|---|---|---|
| vitaminA | M | 18+ | 800 | day | ADH | no | 3000 | ul | GR 2018; UL EFSA 2024 (retinol only) |
| vitaminA | F | 18+ | 680 | day | ADH | no | 3000 | ul | GR 2018; UL EFSA 2024 (retinol only) |
| thiamin | M/F | 18+ | 0.1 | mj | ADH | no | null | — | GR 2018 (EFSA) |
| riboflavin | M/F | 18+ | 1.6 | day | ADH | no | null | — | GR 2018 (EFSA) |
| niacin | M/F | 18+ | 1.6 | mj | ADH | no | 900 | ul | GR 2018; UL SCF 2002 nicotinamide (supplements) |
| vitaminB6 | M | 18–50 | 1.5 | day | ADH | no | 12 | ul | GR 2018; UL EFSA 2023 |
| vitaminB6 | M | 51+ | 1.8 | day | ADH | no | 12 | ul | GR 2018; UL EFSA 2023 |
| vitaminB6 | F | 18+ | 1.5 | day | ADH | no | 12 | ul | GR 2018; UL EFSA 2023 |
| folate | M/F | 18+ | 300 | day | ADH | no | 1000 | ul | GR 2018; UL EFSA 2023 (folic acid only) |
| vitaminB12 | M/F | 18+ | 2.8 | day | ADH | no | null | — | GR 2018 |
| vitaminC | M/F | 18+ | 75 | day | ADH | no | null | — | GR 2018 |
| vitaminD | M/F | 18–69 | 10 | day | AI | no | 100 | ul | GR 2018; UL EFSA 2023 |
| vitaminD | M/F | 70+ | 20 | day | ADH | no | 100 | ul | GR 2018; UL EFSA 2023 |
| vitaminE | M | 18+ | 13 | day | AI | yes | 300 | ul | GR 2018 (EFSA); UL EFSA 2024 |
| vitaminE | F | 18+ | 11 | day | AI | yes | 300 | ul | GR 2018 (EFSA); UL EFSA 2024 |
| vitaminK | M/F | 18+ | 70 | day | AI | no | null | — | GR 2018 (EFSA) |
| calcium | M/F | 18–24 | 1000 | day | ADH | no | 2500 | ul | GR 2018 (EFSA); UL EFSA 2012 |
| calcium | M | 25–69 | 950 | day | ADH | no | 2500 | ul | GR 2018 (EFSA); UL EFSA 2012 |
| calcium | F | 25–49 | 950 | day | ADH | no | 2500 | ul | GR 2018 (EFSA); UL EFSA 2012 |
| calcium | F | 50–69 | 1100 | day | AI | no | 2500 | ul | GR 2018 (GR 2000); UL EFSA 2012 |
| calcium | M/F | 70+ | 1200 | day | AI | no | 2500 | ul | GR 2018 (GR 2000); UL EFSA 2012 |
| magnesium | M | 18+ | 350 | day | AI | no | 250 | ul | GR 2018 (EFSA); UL SCF 2001 (supplements only) |
| magnesium | F | 18+ | 300 | day | AI | no | 250 | ul | GR 2018 (EFSA); UL SCF 2001 (supplements only) |
| iron | M | 18+ | 11 | day | ADH | no | 40 | safe | GR 2018 (EFSA); EFSA 2024 safe level |
| iron | F | 18–49 | 16 | day | ADH | no | 40 | safe | GR 2018 premenopausal, Voedingscentrum age mapping |
| iron | F | 50+ | 11 | day | ADH | no | 40 | safe | GR 2018 postmenopausal, Voedingscentrum age mapping |
| zinc | M | 18+ | 9 | day | ADH | no | 25 | ul | GR 2018 (NCM 2014); UL SCF 2002 |
| zinc | F | 18+ | 7 | day | ADH | no | 25 | ul | GR 2018 (NCM 2014); UL SCF 2002 |
| selenium | M/F | 18+ | 70 | day | AI | yes | 255 | ul | GR 2018 (EFSA); UL EFSA 2023 |
| iodine | M/F | 18+ | 150 | day | AI | no | 600 | ul | GR 2018 (EFSA); UL SCF 2002 |
| potassium | M/F | 18+ | 3500 | day | AI | no | null | — | GR 2018 (EFSA) |
| phosphorus | M/F | 18+ | 550 | day | AI | yes | null | — | GR 2018 (EFSA) |
| copper | M/F | 18+ | 0.9 | day | ADH | no | 5 | ul | GR 2018 (NCM 2014); UL SCF 2003 |
| salt | M/F | 18+ | null | day | null | no | 6 | guideline | Richtlijnen goede voeding 2015, kept in 2025 |
| epaDha | M/F | 18+ | 200 | day | AI | no | null | — | GR 2026 fats advisory |
| ala | M/F | 18+ | 0.5 | energyPercent | AI | no | null | — | GR 2026 fats advisory (replaces 1% from 2001) |

**Notes for the implementer:**
- **Vitamin A for women:** the Voedingscentrum's 05/2025 PDF says 690. GR
  2018 and the Voedingscentrum vitamin A page both say 680, so use **680**.
- **Niacin:** supplements use nicotinamide, so the UL is **900** mg on the
  `supplement` basis. Nicotinic acid (10 mg) is out of scope.
- **Not modelled:**
  - the Dutch vitamin D supplement advice (10 µg for women 50–70 and for
    people with little sun; 20 µg for 70+). The README mentions it;
  - the EFSA sodium value (2 g);
  - the copper acceptable daily intake;
  - EFSA's DHA safe level.

**Sources:**
1. GR 2018, *Voedingsnormen voor vitamines en mineralen voor volwassenen*: https://www.gezondheidsraad.nl/site/binaries/site-content/collections/documents/2018/09/18/voedingsnormen-voor-vitamines-en-mineralen-voor-volwassenen/kernadvies+Voedingsnormen+voor+vitamines+en+mineralen+voor+volwassenen.pdf
2. GR 2023, *Aanvaardbare bovengrenzen voor vitamines en mineralen*: https://www.gezondheidsraad.nl/site/binaries/site-content/collections/documents/2023/03/07/advies-aanvaardbare-bovengrenzen-voor-vitamines-en-mineralen/20230307-Advies-aanvaardbare-bovengrenzen-voor-vitamines-en-mineralen-042-VWS-GR.pdf
3. EFSA UL overview v11 (August 2025): https://www.efsa.europa.eu/sites/default/files/2024-05/ul-summary-report.pdf
4. Voedingscentrum tables (05/2025): https://mobiel.voedingscentrum.nl/Assets/Uploads/voedingscentrum/Documents/Professionals/vitamines%20en%20mineralen/Vitamines%20mineralen%20en%20spoorelementen_2025_def.pdf
5. GR 2026, *Voedingsnormen voor vetten, vetzuren, verteerbare koolhydraten en voedingsvezels*: https://www.gezondheidsraad.nl/site/binaries/site-content/collections/documents/2026/07/07/advies-voedingsnormen-voor-vetten-vetzuren-verteerbare-koolhydraten-en-voedingsvezels/14-voedingsnormen-voor-vetten-vetzuren-verteerbare-koolhydraten-en-voedingsvezels-erratum.pdf
6. GR 2025, *Richtlijnen goede voeding*: https://www.gezondheidsraad.nl/site/binaries/site-content/collections/documents/2025/12/04/advies-richtlijnen-goede-voeding-eiwitbronnen-en-voedingspatronen-2025/19-richtlijnen-goede-voeding-eiwitbronnen-en-voedingspatronen-2025-advies.pdf
7. EFSA 2024 vitamin E UL: https://doi.org/10.2903/j.efsa.2024.8953
