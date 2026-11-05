/**
 * AI lookup of a new food's values per 100 g, by name. The answer only fills
 * in the form for the user to check; nothing is stored here. Only the name and
 * brand are sent to OpenAI.
 */
import { NUTRIENT_KEYS } from '../public/js/shared/constants.js';
import { roundNutrients } from '../public/js/shared/nutrition.js';
import { HttpError } from './http.js';
import { NUTRIENT_MAX } from './ingredients.js';
import { OpenAiError } from './openai.js';
import { optionalString, requireString } from './validate.js';

const OFF_MESSAGE = 'AI lookup is off. Set OPENAI_API_KEY to turn it on.';
const FAILED_MESSAGE = "Couldn't look up this food right now. Try again in a moment.";
const UNKNOWN_MESSAGE = "The AI doesn't recognise this food. Try a more specific name.";

/** Structured-output schema; `recognised` false means the nutrient values mean nothing. */
export const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recognised', ...NUTRIENT_KEYS],
  properties: {
    recognised: { type: 'boolean' },
    ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, { type: 'number' }])),
  },
};

export const ESTIMATE_INSTRUCTIONS = `You estimate the nutrition values of a food for a personal food list.

The input is JSON with the food's name, which may be Dutch or English, and its brand (null when unknown).

Answer with typical values per 100 g of the food as sold:
- kcal in kilocalories; protein, carbs, fat and fiber in grams. Carbs exclude fibre, as on a European label.

Rules:
- Prefer typical values for the product on the Dutch market.
- Assume the raw or unprepared food unless the name says it is prepared (cooked, fried, baked and so on).
- Set recognised to false, with every value 0, when the name is not a food or is too vague to estimate.`;

/**
 * @param {unknown} raw the model's JSON
 * @returns {Record<string, number>|null} rounded values per 100 g, or null when the model doesn't recognise the food
 */
export function parseEstimate(raw) {
  if (raw?.recognised === false) return null;
  if (raw?.recognised !== true) throw new OpenAiError('estimate has no recognised flag');
  for (const key of NUTRIENT_KEYS) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > NUTRIENT_MAX[key]) {
      throw new OpenAiError(`estimated ${key} is out of range: ${value}`);
    }
  }
  return roundNutrients(raw);
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{openAi: {generateJson: (request: object) => Promise<any>}|null}} deps
 */
export function registerFoodEstimateRoutes(router, { openAi }) {
  router.add('POST', '/api/ingredients/estimate', async ({ body }) => {
    const name = requireString(body?.name, 'name', { maxLength: 120 });
    const brand = optionalString(body?.brand, 'brand', { maxLength: 80 });
    if (!openAi) throw new HttpError(503, OFF_MESSAGE);

    let estimate;
    try {
      const raw = await openAi.generateJson({
        name: 'food_estimate',
        schema: ESTIMATE_SCHEMA,
        instructions: ESTIMATE_INSTRUCTIONS,
        input: JSON.stringify({ name, brand }),
      });
      estimate = parseEstimate(raw);
    } catch (error) {
      if (!(error instanceof OpenAiError)) throw error;
      console.error(`Food estimate for "${name}" failed: ${error.message}`);
      throw new HttpError(502, FAILED_MESSAGE);
    }
    if (!estimate) throw new HttpError(422, UNKNOWN_MESSAGE);
    return estimate;
  });
}
