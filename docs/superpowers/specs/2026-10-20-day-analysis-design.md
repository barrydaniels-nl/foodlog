# Day analysis (AI) — Design

Date: 2026-10-20
Status: Draft, awaiting approval

## Intent

The user plans their day in Foodlog and keeps running into the same problem:
**the calorie target is reached before the protein target**. They want an AI
to look at the day they are planning and write short, practical advice:

- food adjustments or additions that raise protein,
- tips to lower calories when the day is, or would be, over the kcal target.

The user reads the advice and makes the changes themselves in the planner.
The point is fixing a plan while making it, not analysing history.

## Goals

- From the Day screen, ask for an analysis of the day being planned.
- Get a short, readable analysis in three parts:
  1. **How the day looks:** one or two sentences on kcal and protein against
     the targets, and where the calories come from.
  2. **More protein:** 2–4 concrete adjustments or additions, tied to the
     planned foods where possible. For example: "Swap the Greek yogurt at
     breakfast for magere kwark (≈ +16 g protein, ≈ −75 kcal)."
  3. **Fewer calories:** 2–4 tips, shown **only** when the day is over the kcal
     target, or would be once the protein tips are followed.
- Re-run the analysis after changing the plan.

## Non-goals

- Applying suggestions automatically, or adding foods to the user's list from
  the analysis.
- Looking back over past days or weeks, or charts.
- Targets for carbs, fat or fibre.
- Food preferences or dislikes. The user said nothing in particular needs
  avoiding.
- A chat or conversation with the AI.

## Anti-goals (a failure even if it technically works)

- AI-estimated numbers presented as facts, or stored anywhere. Estimates are
  marked "≈". The real totals always come from the user's own data.
- Vague, generic advice ("eat more protein") instead of changes tied to this
  day's plan.
- Leaking the API key to the browser or the logs, or sending more than is
  needed to OpenAI.
- A wall of text. It must be quick to read on a phone.

## Decided by the user

- **Text analysis, not appliable changes.** The user makes changes themselves.
- **Protein first, plus calorie-lowering tips when needed.**
- **Scope:** the day on screen, on **today and any future day**. Past days don't
  get it.
- **Layout: "A · Bottom sheet".** A button under the rings opens the app's
  existing sheet, which shows the analysis. The sheet is a centred dialog on
  desktop.
- **OpenAI**, with the key in `OPENAI_API_KEY` in `.env`.

## Decided by Claude (user can override)

- **Button label:** "Analyse day", styled as the indigo chip from the mockup
  ("✦ Analyse day"), placed under the rings and macro totals.
- **Sheet content:** the three parts as small headed sections ("Your day",
  "More protein", "Fewer calories"), with tips as short bullet items. The
  "Fewer calories" section appears only when the AI includes it. A
  **"Refresh"** button at the bottom re-runs the analysis for the current plan.
  The sheet shows a loading state while waiting.
- **No new dependencies.** OpenAI is called with Node's built-in `fetch`, in
  the same style as the Open Food Facts client (`server/off.js`): injectable
  `fetchImpl`, a timeout, logged failures and a friendly `HttpError(502)`.
- **Configuration.** `docker-compose.yml` passes `OPENAI_API_KEY` and
  `OPENAI_MODEL` from `.env` into the `app` container. `OPENAI_MODEL` is
  optional and defaults to a small, cheap model. The builder checks the
  current OpenAI model name at build time. The README configuration table
  documents both.
- **Feature off without a key.** With no key, the button is hidden and the
  analysis route answers 503 with a clear message. The frontend learns
  whether the feature is on from a small status endpoint. The key is never
  sent to the browser.
- **What is sent to OpenAI, and nothing else:**
  - the day's entries per meal section (name, grams, kcal and protein for that
    amount, plus per-100 g values),
  - the day's totals and the kcal and protein targets,
  - the user's own foods (non-archived: name, brand, per-100 g values), so
    advice prefers foods they already have. They are sent as compact rows,
    capped at **300**, with the most recently planned first. That's a few
    thousand tokens at most, which is cheap on a small model.
  - on **today only**, the current local time and which meal sections are
    still ahead. That uses the existing `slotForTime` logic, moved from
    `public/js/views/day.js` into `public/js/shared/` so the server can use it
    too. The current section and every later one count as ahead. **Snacks is
    always ahead.** The prompt says to leave sections that have been eaten
    alone, while still counting them in the totals.
- **Timeout:** 60 seconds for the OpenAI call, with reasoning effort `low`.
  The default (medium) effort ran past 30 s on a real day.
- **Structured output.** The model returns JSON with a fixed schema (JSON-schema
  structured output): a `summary` string, a `protein` list and an optional
  `calories` list of short tip strings. The server checks the shape and caps
  the list lengths. The frontend renders the strings as **plain text**, never
  as HTML.
- **Prompt rules:**
  - Write in English.
  - Be concrete and tied to the planned foods and amounts.
  - New foods are allowed.
  - Prefix any number that isn't from the provided data with "≈".
  - Keep each tip to one sentence.
  - Include calorie tips only when over, or would be over, the target.
- **Not stored.** Each analysis is generated on request and not saved. The
  sheet keeps it only while open.
- **Past days:** the button is hidden, and the server rejects dates before
  today with 400.
- **Empty day:** the button is hidden when nothing is planned. The server
  answers 400 for an empty day.
- **Errors.** OpenAI timeouts, bad responses and refusals are logged on the
  server (never the key). The sheet shows "Couldn't analyse your day right
  now. Try again in a moment." with the Refresh button.
- **Naming in code:** "analysis", e.g. `server/analysis.js`,
  `POST /api/days/:date/analysis`.

## Quality bar

- `node:test` tests for:
  - building the prompt input (today vs future day, meal sections still ahead),
  - parsing the OpenAI response (valid, malformed, refusal, over-long lists),
  - the route: past-day and empty-day rejection, a missing key (503), an
    OpenAI failure (502), and a successful response.
- OpenAI is always mocked in tests. Tests never make real network calls.
- Tests and lint run through `docker compose --profile test`.
- The README gets a short section: what the feature does, what it sends to
  OpenAI, and how to enable it.

## Left to the builder

- Exact OpenAI endpoint (Responses or Chat Completions), prompt wording, JSON
  schema and default model name.
- Status endpoint shape.
- Sheet internals and the exact styling within "A · Fresh".
