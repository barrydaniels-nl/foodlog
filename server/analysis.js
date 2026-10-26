/**
 * AI day analysis: a short written review of a planned day with tips to
 * raise protein and, when needed, lower calories. Nothing is stored.
 */
import { MEAL_SLOTS } from '../public/js/shared/constants.js';
import { slotsAhead } from '../public/js/shared/meal-time.js';
import { HttpError } from './http.js';
import { OpenAiError } from './openai.js';
import { requireDate } from './validate.js';

const FOOD_LIMIT = 300;
const MAX_TIPS = 4;

const OFF_MESSAGE = 'Day analysis is off. Set OPENAI_API_KEY to turn it on.';
const PAST_MESSAGE = 'Only today and future days can be analysed';
const EMPTY_MESSAGE = 'Plan some food first';
const FAILED_MESSAGE = "Couldn't analyse your day right now. Try again in a moment.";

const tipList = { type: 'array', items: { type: 'string' } };

/** Structured-output schema: an empty `calories` list means no calorie tips. */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'protein', 'calories', 'micronutrients'],
  properties: { summary: { type: 'string' }, protein: tipList, calories: tipList, micronutrients: tipList },
};

export const ANALYSIS_INSTRUCTIONS = `You are a practical nutrition coach reviewing one planned day of food.
The user often reaches their calorie target before their protein target. Help them get more protein within their calories.

The input is JSON:
- targets: daily kcal and protein targets; totals: the whole day's planned totals.
- meals: planned foods per meal with grams, kcal and protein for that amount, and per100 values (per 100 g).
- foods: the user's own food list with per-100 g values.
- micronutrients: per nutrient the amount from food and from supplements, the recommended amount and upper limit (left out when unknown), percent of the recommended amount, overLimit, estimatedShare (0-1, the part that comes from estimated values), ulBasis and limitAmount (what the upper limit applies to and that amount), and unknownGrams (grams of planned food with no data for this nutrient, left out when 0).
- supplements: items with name, units and unitLabel. logged is true when the user logged them for this day; false means items is their usual daily set and they may not take it.
- time and mealsAhead: only present when the day is today.

Write in English and answer with JSON that matches the schema:
- summary: 1-2 sentences on kcal and protein against the targets and which foods supply most of the calories.
- protein: 2-4 tips that raise protein. Each tip is one sentence and names a concrete swap, amount change or addition, tied to the planned foods and grams. Prefer foods from the foods list; other common foods are allowed.
- calories: 2-4 one-sentence tips to lower calories, only when the totals exceed the kcal target or would exceed it after following the protein tips. Otherwise an empty list.
- micronutrients: 0-4 one-sentence tips for nutrients below 66% of the recommended amount or above the upper limit. For a nutrient that is too low, suggest food changes first and supplements only after that. An empty list when nothing stands out.

Rules:
- Never advise going above an upper limit or taking medication.
- overLimit is authoritative: only call a nutrient above its upper limit when overLimit is true. The upper limit is compared with limitAmount, never with the total: for ulBasis "supplement" (magnesium, folic acid, niacin) only the supplements count, for "retinol" (vitamin A) only preformed retinol counts.
- An amount with unknownGrams is a lower bound. When unknownGrams is large compared with the day's food, say the amount is uncertain instead of advising a supplement for it.
- Any number you estimate (not taken from the input) starts with "≈", for example "≈ +15 g protein".
- When mealsAhead is given, only suggest changes to foods in those meals; meals not listed have been eaten. Still count every meal in the totals.
- No generic advice such as "eat more protein"; every tip refers to this day's plan.`;

/** @param {Date} date @returns {string} local time as HH:MM */
function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** @returns {object} a copy without the null fields, to keep the prompt short */
const withoutNulls = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null));

/**
 * What the model sees of the day's supplements: the entries when any were
 * logged, otherwise the daily set so it knows what the user usually takes.
 * @param {import('./micros.js').MicroDay} microDay
 * @param {import('./supplements.js').SetItem[]} supplementSet
 * @returns {{logged: boolean, items: Array<{name: string, units: number, unitLabel: string}>}}
 */
function supplementsInput(microDay, supplementSet) {
  const logged = microDay.supplements.length > 0;
  const source = logged ? microDay.supplements : supplementSet;
  return { logged, items: source.map(({ name, units, unitLabel }) => ({ name, units, unitLabel })) };
}

/**
 * The prompt input: only the data the analysis needs.
 * @param {{
 *   day: import('./days.js').Day,
 *   foods: object[],
 *   isToday: boolean,
 *   now: Date,
 *   microDay: import('./micros.js').MicroDay,
 *   supplementSet: import('./supplements.js').SetItem[],
 * }} options
 * @returns {object}
 */
export function buildAnalysisInput({ day, foods, isToday, now, microDay, supplementSet }) {
  const meals = Object.fromEntries(
    MEAL_SLOTS.map((slot) => [
      slot,
      day.slots[slot].entries.map(({ name, brand, grams, nutrients, per100 }) => ({
        name,
        brand,
        grams,
        kcal: nutrients.kcal,
        protein: nutrients.protein,
        per100: { kcal: per100.kcal, protein: per100.protein, carbs: per100.carbs, fat: per100.fat },
      })),
    ]),
  );
  return {
    date: day.date,
    targets: day.targets,
    totals: day.totals,
    time: isToday ? formatTime(now) : null,
    mealsAhead: isToday ? slotsAhead(now) : null,
    meals,
    foods,
    micronutrients: microDay.nutrients.map(
      ({ key, unit, food, supplements, recommended, upperLimit, ulBasis, limitAmount, percent, overLimit, estimatedShare, unknownGrams }) =>
        withoutNulls({
          key,
          unit,
          food,
          supplements,
          recommended,
          upperLimit,
          ulBasis,
          limitAmount,
          percent,
          overLimit,
          estimatedShare,
          unknownGrams: unknownGrams > 0 ? unknownGrams : null,
        }),
    ),
    supplements: supplementsInput(microDay, supplementSet),
  };
}

/** @returns {string[]} trimmed, non-empty, at most MAX_TIPS */
function cleanTips(value, field) {
  if (!Array.isArray(value)) throw new OpenAiError(`analysis ${field} is not a list`);
  return value
    .filter((tip) => typeof tip === 'string')
    .map((tip) => tip.trim())
    .filter(Boolean)
    .slice(0, MAX_TIPS);
}

/**
 * @param {unknown} raw the model's JSON
 * @returns {{summary: string, protein: string[], calories: string[], micronutrients: string[]}}
 */
export function parseAnalysis(raw) {
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) throw new OpenAiError('analysis has no summary');
  return {
    summary,
    protein: cleanTips(raw.protein, 'protein'),
    calories: cleanTips(raw.calories, 'calories'),
    micronutrients: cleanTips(raw.micronutrients, 'micronutrients'),
  };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{
 *   openAi: {generateJson: (request: object) => Promise<any>}|null,
 *   days: {getDay: (date: string) => import('./days.js').Day},
 *   ingredients: {listByRecentUse: (limit: number) => object[]},
 *   micros: {getDay: (date: string) => import('./micros.js').MicroDay},
 *   supplements: {getSet: () => import('./supplements.js').SetItem[]},
 *   today: () => string,
 *   now: () => Date,
 * }} deps
 */
export function registerAnalysisRoutes(router, { openAi, days, ingredients, micros, supplements, today, now }) {
  router.add('GET', '/api/analysis/status', () => ({ enabled: openAi !== null }));

  router.add('POST', '/api/days/:date/analysis', async ({ params }) => {
    const date = requireDate(params.date);
    if (!openAi) throw new HttpError(503, OFF_MESSAGE);
    const todayIso = today();
    if (date < todayIso) throw new HttpError(400, PAST_MESSAGE);
    const day = days.getDay(date);
    if (MEAL_SLOTS.every((slot) => day.slots[slot].entries.length === 0)) throw new HttpError(400, EMPTY_MESSAGE);

    const input = buildAnalysisInput({
      day,
      foods: ingredients.listByRecentUse(FOOD_LIMIT),
      isToday: date === todayIso,
      now: now(),
      microDay: micros.getDay(date),
      supplementSet: supplements.getSet(),
    });
    try {
      const raw = await openAi.generateJson({
        name: 'day_analysis',
        schema: ANALYSIS_SCHEMA,
        instructions: ANALYSIS_INSTRUCTIONS,
        input: JSON.stringify(input),
      });
      return parseAnalysis(raw);
    } catch (error) {
      if (!(error instanceof OpenAiError)) throw error;
      console.error(`Day analysis for ${date} failed: ${error.message}`);
      throw new HttpError(502, FAILED_MESSAGE);
    }
  });
}
