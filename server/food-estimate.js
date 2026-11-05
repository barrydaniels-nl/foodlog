/**
 * AI lookup of a new food's values per 100 g and the weight of one item, by
 * name. The answer only fills in the form for the user to check; nothing is stored here. Only the name and
 * brand are sent to OpenAI.
 */
import { NUTRIENT_KEYS } from '../public/js/shared/constants.js';
import { roundNutrients } from '../public/js/shared/nutrition.js';
import { HttpError } from './http.js';
import { MAX_PORTION_GRAMS, MAX_PORTION_LABEL, NUTRIENT_MAX } from './ingredients.js';
import { OpenAiError } from './openai.js';
import { optionalString, requireString } from './validate.js';

const OFF_MESSAGE = 'AI lookup is off. Set OPENAI_API_KEY to turn it on.';
const FAILED_MESSAGE = "Couldn't look up this food right now. Try again in a moment.";
const UNKNOWN_MESSAGE = "The AI doesn't recognise this food. Try a more specific name.";
const MIN_PORTION_GRAMS = 1;

/**
 * Structured-output schema; `recognised` false means the nutrient values mean
 * nothing, and a null portion means the food isn't counted in items.
 */
export const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recognised', ...NUTRIENT_KEYS, 'portionLabel', 'portionGrams'],
  properties: {
    recognised: { type: 'boolean' },
    ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, { type: 'number' }])),
    portionLabel: { type: ['string', 'null'] },
    portionGrams: { type: ['number', 'null'] },
  },
};

export const ESTIMATE_INSTRUCTIONS = `You estimate the nutrition values of a food for a personal food list.

The input is JSON with the food's name, which may be Dutch or English, and its brand (null when unknown).

Answer with typical values per 100 g of the food as sold:
- kcal in kilocalories; protein, carbs, fat and fiber in grams. Carbs exclude fibre, as on a European label.

When the food is counted in items (an onion, a cucumber, an egg, a banana, a slice of bread), also answer with one average item:
- portionLabel: "1" plus the item's name, in the language of the food's name, for example "1 onion" or "1 komkommer".
- portionGrams: the average weight of one item in grams, counting only the part you eat (no peel, stone or shell), because the values per 100 g are for that part.
Set both to null for food that is measured instead of counted, such as milk, rice, flour or mince.

Rules:
- Prefer typical values for the product on the Dutch market.
- Assume the raw or unprepared food unless the name says it is prepared (cooked, fried, baked and so on).
- Set recognised to false, with every value 0, when the name is not a food or is too vague to estimate.`;

/**
 * A bad portion is dropped rather than failing the lookup: the values per 100 g are still good.
 * @param {unknown} raw the model's JSON
 * @returns {{label: string, grams: number}|null} one average item, or null when there is no usable one
 */
function parsePortion(raw) {
  if (raw.portionLabel === null && raw.portionGrams === null) return null;
  const label = typeof raw.portionLabel === 'string' ? raw.portionLabel.trim() : '';
  const grams = typeof raw.portionGrams === 'number' && Number.isFinite(raw.portionGrams) ? Math.round(raw.portionGrams) : null;
  if (label && label.length <= MAX_PORTION_LABEL && grams !== null && grams >= MIN_PORTION_GRAMS && grams <= MAX_PORTION_GRAMS) {
    return { label, grams };
  }
  console.warn(`Food estimate: dropped invalid portion ${JSON.stringify([raw.portionLabel, raw.portionGrams])}`);
  return null;
}

/**
 * @param {unknown} raw the model's JSON
 * @returns {(Record<string, number> & {portion: {label: string, grams: number}|null})|null}
 *   rounded values per 100 g and one average item, or null when the model doesn't recognise the food
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
  return { ...roundNutrients(raw), portion: parsePortion(raw) };
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
