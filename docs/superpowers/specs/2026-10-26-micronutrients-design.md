# Micronutrients and supplements — Design

Date: 2026-10-26
Status: Draft, awaiting approval

## Intent

The user wants to **adjust their supplements** based on what their food
actually provides. Foodlog already tracks kcal, protein, carbs, fat and fibre.
It knows nothing about vitamins and minerals, and nothing about the
supplements the user takes.

The user wants to see, per day and per month, how much of each micronutrient
they get from food and from supplements, compared with what a person of their
sex and age needs, and whether supplements push anything over a safe upper
limit. The values per food must be researched, not guessed, and stored in the
database.

## Goals

- Track **23 micronutrients** for every food, from the best source available.
- Know the user's **recommended amount** and **upper limit** for each one,
  based on their sex and age.
- Keep a **supplement catalogue** with label values, and log supplements per
  day.
- A dedicated **Micros page** with a day view and a month view: food plus
  supplements against the recommended amount, upper-limit warnings, and the
  top sources for each nutrient.
- Fill in values for the user's **existing foods** without manual work, and
  let them review what the AI matched.
- Include micronutrients and supplements in the **diet export** and the
  **day analysis**.

## Non-goals

- Macros detail beyond what exists (saturated fat, sugar, fatty-acid profiles).
- Pantothenic acid (B5), biotin, choline, chromium, manganese, molybdenum.
  NEVO has no values for them and shortfalls are rare.
- Pregnancy and lactation reference values.
- A supplement routine that counts automatically. Only what is logged counts.
- Reading supplement labels from photos.
- Micronutrient targets or warnings on the Day, Month, Meals or Foods pages.

## Anti-goals (a failure even if it technically works)

- AI-estimated values presented as facts. Every value knows where it came from,
  and the user can always see how much of a number is estimated.
- A blank in NEVO treated as zero, making a nutrient look short when it was
  simply not measured.
- Upper-limit warnings that are wrong because the limit only applies to
  supplements (magnesium, folic acid) or to one form (retinol), but is compared
  with the total.
- The Day, Month, Meals or Foods pages becoming more crowded.
- The Micros page staying empty for weeks until the user has reviewed every
  food.

## Decided by the user

- **Micronutrients**, not macros.
- **Value sources, in order, per nutrient:**
  1. **Label:** values from Open Food Facts, or typed in by the user.
  2. **NEVO twin:** every food links to one NEVO food whose values it uses.
     NEVO foods are their own twin.
  3. **AI estimate:** when there is no twin, or the twin has a blank for that
     nutrient.
- **AI picks the twin first** and only estimates values when no NEVO food fits.
- **Matches apply automatically.** AI-made twins and estimates count at once,
  are labelled "AI-matched · unconfirmed", and wait in a review list.
- **Estimates are stored once** on the ingredient, never regenerated on view,
  and can be edited.
- **Live, not snapshotted.** Micros for an entry come from the ingredient's
  current values, so improvements apply to past days too. (Macros keep their
  snapshot as before.)
- **Reference values:** Gezondheidsraad Voedingsnormen, with EFSA where the
  Gezondheidsraad has none. Recommended amount (ADH, or adequate intake where
  there is no ADH) and upper limit.
- **Profile in Settings:** sex and birth year. The user can override the
  recommended amount per nutrient.
- **Supplements are logged per day**, like food, with a "My daily supplements"
  set for one-tap adding and copy from the previous day.
- **Separate Micros page** in the nav. Supplement logging, the catalogue link,
  the review list and both overviews all live there.
- **The Micros page** has a date picker and a **Day | Month** toggle:
  - **Day:** the day's supplements at the top, then one row per nutrient with
    a food and supplement bar against the recommended amount.
  - **Month:** the daily average over completed days, plus "days below 66%"
    per nutrient.
  - **Colours:** red below 66%, amber 66–99%, green 100% and up, and ⚠ above
    the upper limit.
  - **Tapping a row** shows the top sources: foods and supplements, with their
    share.
- **Both AI features get micros:** the diet export and the day analysis.

## The 23 nutrients

| Group | Nutrients |
|---|---|
| Vitamins | A (RAE), B1 thiamine, B2 riboflavin, B3 niacin, B6, folate (DFE), B12, C, D, E, K |
| Minerals | calcium, magnesium, iron, zinc, selenium, iodine, potassium, phosphorus, copper, salt |
| Fatty acids | EPA + DHA, ALA |

Salt is computed from NEVO sodium (Na × 2.5 / 1000 g). EPA + DHA is the sum
of NEVO `F20:5CN3` and `F22:6CN3`. ALA is `F18:3CN3`.

## Decided by Claude (user can override)

### Data model

- **One definition list** in `public/js/shared/micronutrients.js`. It is
  shared by server and browser, like `nutrition.js`. Each nutrient has a key,
  label, unit (`mg`, `µg` or `g`), group, the NEVO column(s) it comes from,
  and its upper-limit basis (see below). Nothing else hard-codes the list.
- **Reference values** live in the same module: per nutrient, per sex and per
  age band, the recommended amount and upper limit. Each value has a source
  comment (Gezondheidsraad or EFSA, with year). The builder researches the
  values and checks every one against the source.
- **NEVO import** stores the extra columns in a new `reference_micros` table
  (`source`, `code`, `nutrient`, `amount`). Only measured values get a row; a
  NEVO blank has no row and stays "unknown", never zero. The importer also
  keeps retinol (`RETOL`) for the vitamin A upper limit. Existing NEVO data
  has no micros, so Settings shows "Upload the NEVO file again to add
  micronutrients" until it is re-uploaded.
- **Twin link** is a new column on `ingredients`: `micro_twin_code` (e.g.
  `nevo:83`), plus `micro_status` with the values below. Adopting a NEVO food
  sets its own code as twin, with status `confirmed`. Editing a NEVO food's
  macros (which makes it a manual food) keeps the twin.

  | `micro_status` | Meaning |
  |---|---|
  | `pending` | not matched yet |
  | `unconfirmed` | the AI matched it |
  | `confirmed` | the user approved it, or it is a NEVO food |
  | `none` | no data and no AI available |

- **Own values** live in a new `ingredient_micros` table (`ingredient_id`,
  `nutrient`, `amount` per 100 g, `origin` = `label` or `ai`).
- **Resolution** happens at read time, per nutrient:
  1. the `label` row;
  2. otherwise the twin's NEVO value;
  3. otherwise the `ai` row;
  4. otherwise **unknown**.

  Unknown counts as nothing in totals, but the coverage line on the Micros page
  reports it.
- **Open Food Facts** micronutrients are mapped as `label` values when present:
  vitamin D, calcium, iron, salt, potassium, magnesium, zinc, vitamin B12,
  vitamin C and folate. OFF stores amounts in grams; they are converted to the
  nutrient's unit.
- **Supplements:**
  - a new `supplements` table (`id`, `name`, `brand`, `unit_label` such as
    "tablet", `archived`);
  - a `supplement_nutrients` table (`supplement_id`, `nutrient`, `amount` per
    unit);
  - **form fields where it matters:** folate is entered as **folic acid**
    (µg), and counted as DFE × 1.7. Vitamin A is entered as retinol.
  - **Vitamin D** accepts µg, or IU converted at 40 IU = 1 µg.
- **Supplement log:** a new `supplement_entries` table (`id`, `date`,
  `supplement_id`, `units`, `position`). Its values are live from the
  supplement, the same as food micros.
- **Daily set:** a single `supplement_set` table (`supplement_id`, `units`,
  `position`). There is one set, not several.
- **Profile settings:** `sex` (`female` or `male`), `birthYear`, and
  `microTargets` (a map of nutrient key to the user's own recommended amount).
  An override replaces only the recommended amount, never the upper limit.
- **Age** is taken on the date being viewed, so a birthday mid-month can change
  the band in the month view. That's fine. Each day uses its own reference.

### Upper limits

Each nutrient's upper limit has a **basis**:

| Basis | Nutrients | The limit is compared with |
|---|---|---|
| `total` | most nutrients | food + supplements |
| `supplement` | magnesium, folic acid, niacin (nicotinamide) | supplements only |
| `retinol` | vitamin A | food retinol + supplement vitamin A |
| none | nutrients without an upper limit (e.g. K, B1, B2, B12) | nothing; no ⚠ is shown |

Two refinements came out of the research (2026-10-26):
- **Limit kinds.** Most limits are EFSA upper limits; the Gezondheidsraad
  adopted EFSA's ULs in 2023. Two are different:
  - **Iron's 40 mg** is an EFSA "safe level". It is shown as "above safe
    level".
  - **Salt's 6 g** is the Dutch guideline maximum. It is shown as "above
    guideline maximum", and salt has no recommended amount.
- **Energy-based amounts.** Thiamin (0.1 mg/MJ), niacin (1.6 mg NE/MJ) and
  ALA (0.5% of energy, per the 2026 Gezondheidsraad fats advisory) are
  converted with the user's kcal target.
- **Indicative values.** Vitamin E, selenium and phosphorus have
  weak-evidence adequate intakes, which are labelled "indicative".

### AI matching

- A **background matcher** on the server works through ingredients with
  status `pending`, one at a time:
  - after a migration, every existing non-NEVO food starts as `pending`;
  - a new OFF or manual food is `pending` when created.
- **Matching:**
  1. The AI returns a few search terms (Dutch and English).
  2. The server searches NEVO with them and sends up to **40 candidates**
     (code, names, food group, macros).
  3. The AI picks one, or answers "none".
  - The server rejects a code it didn't send.
  - When the AI picks "none", or the twin has blanks, one more call asks for
    estimates of the missing nutrients only. These are stored as `ai` rows.
- **Status after matching** is `unconfirmed`.
- **Without `OPENAI_API_KEY`** the matcher doesn't run. Foods stay `pending`
  and are shown as "no micronutrient data". The user can still pick a twin by
  hand.
- **What is sent to OpenAI:** the food's name, brand and per-100 g macros, and
  the candidate list. Nothing about the user's days or profile.
- **Failures** are logged, and the food stays `pending` and is retried on the
  next pass. Each food has an attempt limit (3), after which it becomes `none`.
- Uses the existing `server/openai.js` client with structured output.

### Micros page

- **Routes:** `#/micros/day/YYYY-MM-DD`, `#/micros/month/YYYY-MM` and
  `#/micros/review`. The nav item is "Micros", with a pill icon.
- **Day mode, top:** the day's supplements as a list with unit steppers, plus
  three actions:
  - "Add supplement" (picks from the catalogue);
  - "Add my daily supplements";
  - "Copy from previous day".

  A "Manage supplements" link opens the catalogue: list, add, edit, archive,
  and edit the daily set.
- **Day mode, rows:** one row per nutrient, grouped Vitamins / Minerals /
  Fatty acids.
  - **Bar:** a food segment and a supplement segment against the recommended
    amount, capped visually at 150%.
  - **Text:** the amount, unit and %.
  - **Colours:** red below 66%, amber 66–99%, green 100% and up.
  - **⚠ "above upper limit"** when the amount on the limit's basis is over it.
  - **"≈"** when more than **25%** of the total comes from `ai` values or
    `unconfirmed` twins.
- **Coverage line:** for example "2 foods (180 g) have no micronutrient data",
  linking to the review list.
- **Month mode:**
  - The same rows, using the **average over completed days**: days before
    today with food logged. This is the rule the Month page already uses.
  - Per nutrient: "**days below 66%: 12 / 20**".
  - ⚠ when the **average** is over the upper limit, plus "days over limit:
    n / m".
- **Top sources sheet** (tap a row): foods aggregated by ingredient, plus
  supplements, each with an amount and a share of the total, sorted
  descending. The top 8 are shown, then "others".
- **Review list:**
  - Shows foods that are `unconfirmed`, `pending` or `none`: food → twin (or
    "AI estimate"), with the estimated nutrients listed.
  - Actions: **✓ Confirm**, **✎ Change twin** (NEVO search picker), **✕ No
    twin** (keeps or requests AI estimates).
  - The estimated values can be edited. An edited value becomes a `label` value.
- **No profile set:** the rows show amounts only, with a banner: "Set your sex
  and birth year in Settings to compare with what you need."

### Ingredient form

The form gets a small read-only "**Micronutrients from**" line showing the twin
name and status, with a "Change" action (NEVO search picker). It reuses the
same picker as the review list. Nothing else on the Foods page changes.

### Diet export

- **Per day:** a "Supplements: …" line listing the name and units taken.
- **Summary:** a micronutrient table for the completed days with these columns:
  - nutrient;
  - average from food;
  - average from supplements;
  - total;
  - recommended;
  - %;
  - upper limit (⚠ if exceeded);
  - days below 66%;
  - % estimated.
- **Header:** sex and age, and a note that the micros are the current best
  values rather than snapshots, and that "≈" marks estimates.

### Day analysis

- **Input** adds the day's micronutrient totals, split into food and
  supplements, with recommended amount, upper limit and estimated share, plus
  the supplements logged.
- **For a future day with no supplements logged**, the daily set is sent
  instead, marked "usual supplements, not logged yet".
- **Schema** adds a `micronutrients` list of 0–4 tips:
  - shortfalls below 66%, with food changes first and then supplement
    changes;
  - anything over an upper limit;
  - an empty list when nothing stands out.
- **Sheet** gets a "Micronutrients" section, shown only when there are tips.
- **Prompt rules:** estimated numbers start with "≈". The AI never advises
  medication or doses above the upper limit.

### Backup

Backups go to **version 2** and include supplements, the supplement nutrients,
the supplement log, the daily set, twin links, statuses, `ingredient_micros`
and the profile settings. **Version 1** backups still import, with every
non-NEVO food set to `pending`. NEVO reference data stays out of backups, as
it is now.

## Quality bar

- `node:test` tests for:
  - **NEVO parsing:** micronutrient columns, blanks staying unknown, salt and
    EPA + DHA derivation.
  - **Resolution order:** label → twin → AI → unknown.
  - **Reference lookup:** sex and age bands, overrides, and each
    upper-limit basis (total, supplement-only, retinol).
  - **Day and month micronutrient totals:** food vs supplement split, the
    estimated share, days below 66%, and top sources.
  - **Supplement units:** folic acid → DFE, and IU → µg for vitamin D.
  - **The matcher:** the candidate list, rejecting an unknown code, "none"
    leading to estimates, gap-filling blanks, attempt limit, no key.
  - **Supplements, supplement log, daily set and copy-day routes.**
  - **Diet export and day analysis:** the new input and output.
  - **Backup:** version 2 round-trip, and importing version 1.
- OpenAI is always mocked. Tests never make network calls.
- Tests and lint run through `docker compose --profile test`.
- **README:**
  - a "Micronutrients and supplements" section (sources, the estimate
    labelling, live values, re-uploading NEVO);
  - the reference-value sources.

## Left to the builder

- Exact reference values per age band, researched and cited in code.
- Exact OFF nutriment keys and unit conversions.
- Prompt wording and JSON schemas for matching and estimating.
- The matcher's scheduling (interval or a queue nudged on create), provided it
  never blocks a request.
- Micros page styling within "A · Fresh", and the nav icon.
