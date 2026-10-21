# Day Analysis (AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "✦ Analyse day" button on the Day screen. It opens a sheet with a
short OpenAI-written analysis of the planned day: a summary, protein tips and,
when needed, calorie tips.

**Architecture:** There are two new server modules:
- `server/openai.js` is a generic OpenAI Responses-API client that returns
  structured JSON, built with `fetch` the same way as `server/off.js`.
- `server/analysis.js` owns the domain part: it builds the prompt input,
  holds the schema and instructions, parses the result and registers the
  routes.

The meal-time logic moves into a shared module so the server and the browser
use the same rules. A new UI module renders the analysis into the existing
sheet.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite`, global `fetch`), vanilla
ES modules in the browser, `node:test`, ESLint. There are no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-day-analysis-design.md`

## Global Constraints

- No new npm dependencies. OpenAI is called with the global `fetch`.
- Configuration comes from env: `OPENAI_API_KEY` (feature off when unset) and `OPENAI_MODEL` (optional, default `gpt-5-mini`). Check that `gpt-5-mini` is still a current, cheap OpenAI model at build time, and replace it if it isn't.
- Never send the API key to the browser, and never log it.
- The OpenAI timeout is **30 seconds**.
- Food list cap: **300**, most recently planned first.
- Tip lists are capped at **4** items each.
- **Snacks is always ahead.** On today, the current slot (`slotForTime`) and every later slot count as ahead.
- Analysis is available only for **today and future days**. Past dates get 400.
- AI tips are rendered as **plain text** (`h()` text nodes), never as HTML.
- User-facing copy:
  - button: `Analyse day` (with a ✦)
  - sheet title: `Day analysis`
  - section headings: `Your day`, `More protein`, `Fewer calories`
  - refresh button: `Refresh`
  - failure text: `Couldn't analyse your day right now. Try again in a moment.`
  - feature off (503): `Day analysis is off. Set OPENAI_API_KEY to turn it on.`
  - past day (400): `Only today and future days can be analysed`
  - empty day (400): `Plan some food first`
- Work order follows the user's policy: implement first, then write focused tests. A task is done only when its tests pass.
- Run all commands through Docker Compose: `docker compose --profile test run --rm test npm test` and `... npm run lint`.
- **Never commit.** Each task ends by leaving the changes unstaged and reviewable. Suggested commit messages are given in conventional-commit form for the user to use.

## Review Focus

These are the cases most likely to break for the user that the spec doesn't spell out:

1. **OpenAI is slow or hangs.** The request must abort at the timeout and return 502 with the failure text, not leave the sheet spinning forever. Test: Task 2 `aborts after timeoutMs`.
2. **The model stops early or refuses.** A `status: "incomplete"` response or a `refusal` content part must give 502, not a half-parsed analysis. Test: Task 2 `incomplete` and `refusal` cases.
3. **The model returns too many, empty or padded tips.** The parser trims strings, drops empty ones and caps each list at 4. Test: Task 3 `parseAnalysis caps and trims`.
4. **The key leaks into logs.** Failure logs must never contain the API key. Test: Task 2 `never logs the api key`.
5. **Late evening on today.** At 22:30, only `snacks` is ahead. Earlier slots still count in the totals. Test: Task 1 `slotsAhead` at 22:30, and Task 3 `buildAnalysisInput on today`.

---

### Task 1: Shared meal-time helpers

**Files:**
- Create: `public/js/shared/meal-time.js`
- Modify: `public/js/views/day.js:15-29` (remove local `slotForTime`, import it)
- Test: `test/shared.test.js`

**Interfaces:**
- Produces:
  - `slotForTime(now: Date): string`, which keeps the current thresholds unchanged: before 10:30 breakfast, before 15:00 lunch, before 21:00 dinner, otherwise snacks.
  - `slotsAhead(now: Date): string[]`, which returns `MEAL_SLOTS` from `slotForTime(now)` to the end. Snacks is always included.

- [ ] **Step 1: Move `slotForTime` into `public/js/shared/meal-time.js` and add `slotsAhead`.** Use the existing JSDoc style. Import `MEAL_SLOTS` from `./constants.js`.
- [ ] **Step 2: Change `day.js` to import `slotForTime` from `../shared/meal-time.js`.** Behaviour must not change.
- [ ] **Step 3: Add tests to `test/shared.test.js`**

```js
test('slotForTime keeps the existing meal boundaries', () => {
  const at = (hh, mm) => new Date(2026, 9, 21, hh, mm);
  assert.equal(slotForTime(at(10, 29)), 'breakfast');
  assert.equal(slotForTime(at(10, 30)), 'lunch');
  assert.equal(slotForTime(at(15, 0)), 'dinner');
  assert.equal(slotForTime(at(21, 0)), 'snacks');
});

test('slotsAhead includes the current slot and always snacks', () => {
  const at = (hh, mm) => new Date(2026, 9, 21, hh, mm);
  assert.deepEqual(slotsAhead(at(7, 0)), ['breakfast', 'lunch', 'dinner', 'snacks']);
  assert.deepEqual(slotsAhead(at(14, 0)), ['lunch', 'dinner', 'snacks']);
  assert.deepEqual(slotsAhead(at(22, 30)), ['snacks']);
});
```

- [ ] **Step 4: Run** `docker compose --profile test run --rm test npm test`. Expected: all tests pass.
- [ ] **Step 5: Leave unstaged for review.** Suggested message: `refactor: share meal-time slot helpers between server and browser`

---

### Task 2: OpenAI structured-output client

**Files:**
- Create: `server/openai.js`
- Test: `test/openai.test.js`

**Interfaces:**
- Produces:
  - `class OpenAiError extends Error`, thrown for every failure. Its message is for logs only, never for users.
  - `createOpenAiClient({ apiKey: string, model: string, fetchImpl?: typeof fetch, timeoutMs?: number })`, where `timeoutMs` defaults to `30_000`. It returns `{ generateJson({ name: string, schema: object, instructions: string, input: string }): Promise<any> }`.

- [ ] **Step 1: Implement `createOpenAiClient`.** Follow `server/off.js`'s `getJson` style.
  - Send `POST https://api.openai.com/v1/responses` with headers `Authorization: Bearer <apiKey>` and `Content-Type: application/json`.
  - The body is `{ model, instructions, input, text: { format: { type: 'json_schema', name, schema, strict: true } } }`.
  - Pass `signal: AbortSignal.timeout(timeoutMs)`.
  - Parse the reply by finding the `output` item with `type: 'message'`:
    - a content part `type: 'output_text'` gets `JSON.parse(text)`,
    - a content part `type: 'refusal'` throws `OpenAiError`.
  - These also throw `OpenAiError`: network or abort errors, non-2xx responses, `status !== 'completed'`, missing text, and invalid JSON.
  - Before throwing, `console.error` the context: the HTTP status, and OpenAI's `error.message` from the body when present. Never log the key or the request headers.
- [ ] **Step 2: Write `test/openai.test.js`** with a fake `fetchImpl`, in the same style as `fakeFetch` in `test/off.test.js`. Add one test for each of these:
  - `sends model, instructions and a strict json_schema format with a bearer key`: assert the URL, `headers.Authorization === 'Bearer sk-test'`, `body.text.format.strict === true`, and that `body.model` is the configured one.
  - `returns the parsed output_text JSON`: a completed response with `output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }]` gives `{ a: 1 }`.
  - `rejects a refusal`: `assert.rejects(..., OpenAiError)`.
  - `rejects an incomplete response`: `status: 'incomplete'` gives `OpenAiError`.
  - `rejects a non-2xx answer`: a 500 gives `OpenAiError`.
  - `rejects invalid JSON text`: `output_text` `'not json'` gives `OpenAiError`.
  - `aborts after timeoutMs`: the fake fetch waits for `init.signal`'s abort, with `timeoutMs: 20`. Expect `OpenAiError`.
  - `never logs the api key`: use `t.mock.method(console, 'error')`, trigger a 401 failure, and assert that no logged argument (stringified) contains `sk-test`.
- [ ] **Step 3: Run** `docker compose --profile test run --rm test npm test`. Expected: all tests pass.
- [ ] **Step 4: Leave unstaged for review.** Suggested message: `feat: add OpenAI structured-output client`

---

### Task 3: Analysis domain, routes, wiring and configuration

**Files:**
- Create: `server/analysis.js`
- Modify:
  - `server/ingredients.js`: add `listByRecentUse` to the repo
  - `server/app.js`: new deps `openAi`, `now`, and register the routes
  - `server/index.js`: read env, build the client
  - `test/helpers.js`: `startTestServer` accepts `openAi` and `now`
  - `docker-compose.yml`: `app.environment`
  - `README.md`: configuration table, plus a new "Day analysis (AI)" section
- Test: `test/analysis.test.js`, `test/ingredients.test.js`

**Interfaces:**
- Consumes:
  - `slotsAhead(now)` (Task 1)
  - `createOpenAiClient`, `OpenAiError` (Task 2)
  - `days.getDay(date): Day` (existing)
- Produces:
  - `ingredients.listByRecentUse(limit: number): Array<{name: string, brand: string|null, kcal: number, protein: number, carbs: number, fat: number}>`
    - non-archived only
    - ordered by most recently planned (highest entry id), then never-planned foods by name `COLLATE NOCASE`
    - `LIMIT` is the argument
    - no portions
  - In `server/analysis.js`:
    - `ANALYSIS_SCHEMA`: a strict JSON schema with `additionalProperties: false` and required `summary: string`, `protein: string[]` and `calories: string[]`. An empty `calories` array means no calorie tips.
    - `ANALYSIS_INSTRUCTIONS: string`. The wording is the builder's, but it must contain these rules:
      - write in English
      - be concrete, and tie tips to the planned foods and grams
      - prefer foods from `foods`, though new foods are allowed
      - prefix every number not taken from the input with `≈`
      - one sentence per tip
      - 2–4 protein tips
      - calorie tips (2–4) only when totals exceed the kcal target, or would after following the protein tips, and otherwise an empty array
      - when `mealsAhead` is given, only change foods in those meals, but count every meal in the totals
      - summary in 1–2 sentences, covering kcal and protein against the targets and where the calories come from
    - `buildAnalysisInput({ day: Day, foods: ReturnType<listByRecentUse>, isToday: boolean, now: Date }): object` returns:
      ```js
      {
        date,
        targets: { kcal, protein },
        totals,                         // day.totals
        time: 'HH:MM' | null,           // only when isToday
        mealsAhead: string[] | null,    // slotsAhead(now) only when isToday
        meals: { [slot]: [{ name, brand, grams, kcal, protein, per100: { kcal, protein, carbs, fat } }] },
        foods,
      }
      ```
      Entry `kcal` and `protein` are the entry's rounded `nutrients`.
    - `parseAnalysis(raw: unknown): { summary: string, protein: string[], calories: string[] }`. It trims strings, drops empty items and caps each list at `MAX_TIPS = 4`. It throws `OpenAiError` when the shape is wrong (summary missing or empty, or not arrays).
    - `registerAnalysisRoutes(router, { openAi: {generateJson}|null, days, ingredients, today: () => string, now: () => Date })`
      - `GET /api/analysis/status` returns `{ enabled: openAi !== null }`.
      - `POST /api/days/:date/analysis` returns `{ summary, protein, calories }` (200). In order:
        1. `requireDate`
        2. `openAi` null gives 503 with the off copy
        3. `date < today()` gives 400 with the past copy
        4. a day with no entries gives 400 with the empty copy
        5. call `generateJson({ name: 'day_analysis', schema, instructions, input: JSON.stringify(buildAnalysisInput(...)) })`
        6. `parseAnalysis`
      - It catches only `OpenAiError` and rethrows it as `HttpError(502, <failure copy>)`. The client already logged it.
  - `createApp({ ..., openAi = null, now = () => new Date() })`
  - `startTestServer({ offClient, today, openAi = null, now = () => new Date('2026-10-21T09:00:00') })`

- [ ] **Step 1: Add `listByRecentUse(limit)` to `createIngredientsRepo`.** Use one prepared statement with a `LEFT JOIN` on `MAX(entries.id)` per ingredient, ordered by `last_entry IS NULL, last_entry DESC, name COLLATE NOCASE`.
- [ ] **Step 2: Implement `server/analysis.js`** to the interfaces above. Set `FOOD_LIMIT = 300` and `MAX_TIPS = 4`. Format `HH:MM` from `now()` in local time; the container's `TZ` decides it. For the past-date check, compare ISO date strings directly.
- [ ] **Step 3: Wire it up.**
  - In `app.js`, call `registerAnalysisRoutes(router, { openAi, days, ingredients, today, now })`.
  - In `index.js`, set `openAi: process.env.OPENAI_API_KEY ? createOpenAiClient({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || DEFAULT_MODEL }) : null`, where `DEFAULT_MODEL = 'gpt-5-mini'` is exported from `server/openai.js`.
  - Extend `test/helpers.js` to match.
- [ ] **Step 4: Update the configuration.**
  - In `docker-compose.yml`, add `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` and `OPENAI_MODEL: ${OPENAI_MODEL:-}` under `app.environment`, with a one-line comment that they come from `.env`.
  - In `README.md`:
    - add both variables to the configuration table,
    - add the OpenAI call to the mermaid diagram (`app -- day analysis --> openai[OpenAI]`),
    - add a short "Day analysis (AI)" section covering what it does, how to enable it (`echo "OPENAI_API_KEY=sk-..." >> .env && docker compose up -d`), exactly what is sent (the day's plan, targets, up to 300 of your foods, and the time on today), and that nothing is stored.
- [ ] **Step 5: Write the tests.** In `test/ingredients.test.js`:
  - `listByRecentUse orders recently planned first, skips archived, respects limit`

  In `test/analysis.test.js`:
  - `buildAnalysisInput on today includes time and mealsAhead`: at `new Date(2026, 9, 21, 22, 30)`, expect `time === '22:30'`, `mealsAhead` deep-equal to `['snacks']`, and entries from breakfast still present in `meals.breakfast`.
  - `buildAnalysisInput on a future day has no time or mealsAhead`: both are `null`.
  - `parseAnalysis caps and trims`: 6 protein tips with padding and one `''` give 4 trimmed tips. `calories: []` stays `[]`.
  - `parseAnalysis rejects a missing summary`: throws `OpenAiError`.
  - Route tests use `startTestServer` with a fake `openAi = { generateJson: async (args) => { calls.push(args); return {...} } }`:
    - `status reports disabled without a client`: `{ enabled: false }`
    - `analysis answers 503 when disabled`
    - `analysis rejects a past day`: `2026-10-20` gives 400
    - `analysis rejects an empty day`: gives 400
    - `analysis returns the parsed tips for today`: assert the body, that `calls[0].name === 'day_analysis'`, that `JSON.parse(calls[0].input).targets` equals the settings targets, and that `foods` is present
    - `analysis works for a future day`
    - `analysis maps OpenAiError to 502 with the failure copy`
- [ ] **Step 6: Run** `docker compose --profile test run --rm test npm test` and `... npm run lint`. Expected: all pass, no lint errors.
- [ ] **Step 7: Leave unstaged for review.** Suggested message: `feat: add AI day analysis endpoint`

---

### Task 4: "Analyse day" button and analysis sheet

**Files:**
- Create: `public/js/ui/day-analysis.js`
- Modify:
  - `public/js/views/day.js`: `render` and `summary()`
  - `public/css/app.css`: new `.chip-ai` and `.analysis*` rules, next to `.macros`

**Interfaces:**
- Consumes:
  - `GET /api/analysis/status`
  - `POST /api/days/:date/analysis` (Task 3)
  - `openSheet` from `../ui/sheet.js`
  - `h` from `../ui/dom.js`
- Produces:
  - `analysisEnabled(): Promise<boolean>`. It is fetched once per page load and cached in a module-level promise. A failed status call logs with `console.error` and resolves to `false`, so the Day screen never breaks.
  - `openDayAnalysis({ date: string }): void`

- [ ] **Step 1: Implement `day-analysis.js`.** `openDayAnalysis` opens a sheet titled `Day analysis` and then:
  - shows a loading state while it calls the endpoint (reuse `.skeleton` blocks),
  - renders `Your day` (the summary paragraph) and `More protein` (a bullet list),
  - renders `Fewer calories` (a bullet list) only when `calories.length > 0`,
  - shows a `Refresh` button (`btn btn-soft btn-block`) that re-runs the request.

  On error, it shows the server's message in the sheet (`ApiError.message`), with Refresh. All AI text goes through `h()` as text.
- [ ] **Step 2: Add the button in `day.js`.**
  - In `render`, load the day and `analysisEnabled()` with `Promise.all`.
  - In `summary()`, add `h('button', { class: 'chip-ai', type: 'button', onclick: () => openDayAnalysis({ date }) }, '✦ Analyse day')` below `.macros`. Show it only when `enabled && date >= today` and at least one slot has entries (`MEAL_SLOTS.some((slot) => day.slots[slot].entries.length > 0)`).
- [ ] **Step 3: Add the CSS.**
  - `.chip-ai`: the indigo soft pill from the mockup (`background: var(--indigo-soft)`, `color: var(--indigo)`, weight 700, 13–14px, `border-radius: 999px`, padding `7px 12px`, no border).
  - `.analysis` sections: `.section-label` headings and a tight list.
- [ ] **Step 4: Run** `docker compose --profile test run --rm test npm run lint`. Expected: no errors.
- [ ] **Step 5: Check it by hand in the running app** (`docker compose --profile test run --rm -p 8081:8080 -e OPENAI_API_KEY="$(grep '^OPENAI_API_KEY=' .env | cut -d= -f2-)" test npm start`):
  - the button shows on today and tomorrow and is hidden on yesterday,
  - it's hidden when no key is set,
  - the sheet loads, renders and refreshes,
  - with a bad key, the failure text appears.
- [ ] **Step 6: Leave unstaged for review.** Suggested message: `feat: add Analyse day sheet to the day planner`
