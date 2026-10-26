/**
 * Background AI matcher: links each queued food to a NEVO "twin" and asks for
 * estimates of the nutrients that neither its label nor its twin knows.
 * Only the food's name, brand and per-100 g macros, plus the NEVO candidates,
 * are sent to OpenAI. Runs one food at a time and never inside a request.
 */
import { MICRO_BY_KEY, MICRO_KEYS, roundMicro } from '../public/js/shared/micronutrients.js';
import { FoodMicroStatus, MicroJob } from './food-micros.js';
import { nevoReferenceCode } from './nevo.js';
import { OpenAiError, OpenAiErrorKind } from './openai.js';

const MAX_SEARCH_TERMS = 6;
const MAX_CANDIDATES = 40;
const QUEUE_PAGE = 50;

/** Structured-output schema for the NEVO search terms. */
export const SEARCH_TERMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['terms'],
  properties: { terms: { type: 'array', items: { type: 'string' } } },
};

/** Structured-output schema for the twin choice; null means no candidate fits. */
export const TWIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: { type: ['integer', 'null'] } },
};

/**
 * Structured-output schema for estimates. The key enum keeps the model to the
 * nutrients that were asked for.
 * @param {string[]} gaps nutrient keys to estimate
 * @returns {object}
 */
export function estimateSchema(gaps) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['values'],
    properties: {
      values: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'amount'],
          properties: { key: { type: 'string', enum: gaps }, amount: { type: 'number' } },
        },
      },
    },
  };
}

export const SEARCH_TERMS_INSTRUCTIONS = `You help link a food from a personal food list to the Dutch food composition table NEVO.

The input is JSON with the food's name, brand and macros per 100 g.

Answer with 1-6 short search terms that would find the same food, or the closest one, in NEVO:
- Give both Dutch terms (NEVO names are Dutch, for example "kwark mager" or "brood volkoren") and English terms.
- Use generic food words; leave out brand names and marketing words.
- Prefer terms for the raw or unprepared food unless the name says it is prepared (cooked, fried, baked and so on).`;

export const TWIN_INSTRUCTIONS = `You pick the NEVO food whose micronutrients best represent a food from a personal food list.

The input is JSON:
- food: the food's name, brand and macros per 100 g.
- candidates: NEVO foods with their code, Dutch name, English name, food group and macros per 100 g.

Answer with the code of the best candidate, or null when no candidate is the same kind of food.

Rules:
- The same kind of food matters most; use the macros to choose between similar candidates (for example full-fat or low-fat).
- Prefer the product as sold on the Dutch market.
- Prefer a raw or unprepared candidate unless the food's name says it is prepared (cooked, fried, baked and so on).
- Only answer a code from the candidates.`;

export const ESTIMATE_INSTRUCTIONS = `You estimate micronutrients of a food from a personal food list.

The input is JSON:
- food: the food's name, brand and macros per 100 g.
- nutrients: the nutrients to estimate, each with its key, name and unit.

Answer with one value per nutrient you can estimate: the amount per 100 g of the food as sold, in the given unit.

Rules:
- Prefer typical values for the product on the Dutch market, including fortification that is usual there.
- Assume the raw or unprepared food unless the name says it is prepared (cooked, fried, baked and so on).
- Leave out a nutrient you cannot estimate sensibly; never invent one that was not asked for.`;

/**
 * What OpenAI may know about a food: nothing beyond its name, brand and macros.
 * @param {{name: string, brand: string|null, kcal: number, protein: number, carbs: number, fat: number}} food
 * @returns {object}
 */
export function buildFoodInput({ name, brand, kcal, protein, carbs, fat }) {
  return { name, brand, per100g: { kcal, protein, carbs, fat } };
}

/**
 * @param {unknown} raw the model's JSON
 * @returns {string[]} trimmed, non-empty, at most MAX_SEARCH_TERMS
 */
export function parseSearchTerms(raw) {
  if (!Array.isArray(raw?.terms)) throw new OpenAiError('search terms are not a list');
  return raw.terms
    .filter((term) => typeof term === 'string')
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
}

/**
 * Keeps estimates for asked-for nutrients within their plausible range; the
 * first answer per nutrient wins.
 * @param {unknown} raw the model's JSON
 * @param {string[]} gaps nutrient keys that were asked for
 * @returns {{values: Record<string, number>, dropped: number}}
 */
export function parseEstimates(raw, gaps) {
  if (!Array.isArray(raw?.values)) throw new OpenAiError('estimates are not a list');
  const asked = new Set(gaps);
  const values = {};
  let dropped = 0;
  for (const item of raw.values) {
    const key = item?.key;
    const amount = item?.amount;
    const valid =
      asked.has(key) &&
      !(key in values) &&
      typeof amount === 'number' &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      amount <= MICRO_BY_KEY[key].max;
    if (valid) values[key] = roundMicro(amount);
    else dropped += 1;
  }
  return { values, dropped };
}

/**
 * @param {{
 *   db?: import('node:sqlite').DatabaseSync,
 *   openAi: {generateJson: (request: object) => Promise<any>},
 *   reference: ReturnType<import('./nevo.js').createReferenceRepo>,
 *   foodMicros: ReturnType<import('./food-micros.js').createFoodMicrosRepo>,
 *   intervalMs?: number,
 * }} deps
 * `db` is accepted for signature compatibility but unused: all reads and writes go through the repos.
 * @returns {{runOnce: () => Promise<number>, start: () => void, stop: () => void}}
 */
export function createMicroMatcher({ openAi, reference, foodMicros, intervalMs = 30_000 }) {
  /**
   * @param {object} food a queue item
   * @param {string[]} gaps nutrient keys without a label or twin value
   * @returns {Promise<Record<string, number>>} the usable estimates
   */
  async function estimate(food, gaps) {
    if (gaps.length === 0) return {};
    const raw = await openAi.generateJson({
      name: 'micro_estimate',
      schema: estimateSchema(gaps),
      instructions: ESTIMATE_INSTRUCTIONS,
      input: JSON.stringify({
        food: buildFoodInput(food),
        nutrients: gaps.map((key) => ({ key, label: MICRO_BY_KEY[key].label, unit: MICRO_BY_KEY[key].unit })),
      }),
    });
    const { values, dropped } = parseEstimates(raw, gaps);
    if (dropped > 0) console.warn(`Micronutrient matching for ingredient ${food.id}: dropped ${dropped} invalid estimate(s)`);
    return values;
  }

  /**
   * @returns {Promise<{code: number, name: string}|null>} a candidate, or null when none fits
   */
  async function pickTwin(food) {
    const raw = await openAi.generateJson({
      name: 'micro_search_terms',
      schema: SEARCH_TERMS_SCHEMA,
      instructions: SEARCH_TERMS_INSTRUCTIONS,
      input: JSON.stringify({ food: buildFoodInput(food) }),
    });
    const terms = parseSearchTerms(raw);
    const candidates = terms.length === 0 ? [] : reference.searchCandidates(terms, MAX_CANDIDATES);
    if (candidates.length === 0) return null;

    const answer = await openAi.generateJson({
      name: 'micro_twin',
      schema: TWIN_SCHEMA,
      instructions: TWIN_INSTRUCTIONS,
      input: JSON.stringify({ food: buildFoodInput(food), candidates }),
    });
    // A missing or malformed code falls through to "not one of the candidates".
    const code = answer?.code;
    if (code === null) return null;
    const twin = candidates.find((candidate) => candidate.code === code);
    if (!twin) throw new OpenAiError(`twin code ${code} is not one of the candidates`);
    return twin;
  }

  /** Picks a twin, then estimates what neither the label nor the twin knows. Old AI rows are re-estimated. */
  async function match(food) {
    const { label } = foodMicros.info(food.id);
    const twin = await pickTwin(food);
    const twinValues = twin ? reference.getMicros(twin.code) : {};
    const gaps = MICRO_KEYS.filter((key) => label[key] === undefined && twinValues[key] === undefined);
    const aiValues = await estimate(food, gaps);
    return { twinCode: twin ? nevoReferenceCode(twin.code) : null, status: FoodMicroStatus.UNCONFIRMED, aiValues };
  }

  /** Estimates only nutrients unknown from every origin; no twin or status means both are kept. */
  async function fill(food) {
    const { values } = foodMicros.resolve([food.id]).get(food.id);
    const aiValues = await estimate(food, MICRO_KEYS.filter((key) => values[key] === undefined));
    return { aiValues };
  }

  /**
   * The writes only apply while the food still has the job (and name) it was
   * queued with; when the user changed it meanwhile, their change wins.
   * @param {ReturnType<typeof foodMicros.queue>[number]} food
   * @returns {Promise<boolean>} false when OpenAI is unavailable, so the run should stop
   */
  async function processFood(food) {
    const expected = { expectJob: food.job, expectTwinCode: food.twinCode, expectName: food.name };
    let result;
    try {
      result = food.job === MicroJob.MATCH ? await match(food) : await fill(food);
    } catch (error) {
      if (!(error instanceof OpenAiError)) throw error;
      // An outage is not the food's fault: counting it would give up the whole queue within one run.
      if (error.kind === OpenAiErrorKind.UNAVAILABLE) {
        console.error(`Micronutrient matching paused at ingredient ${food.id}, OpenAI unavailable: ${error.message}`);
        return false;
      }
      console.error(`Micronutrient matching for ingredient ${food.id} failed: ${error.message}`);
      if (!foodMicros.failJob(food.id, expected)) warnSkipped(food);
      return true;
    }
    if (!foodMicros.finishJob(food.id, { ...expected, ...result })) warnSkipped(food);
    return true;
  }

  function warnSkipped(food) {
    console.warn(`Micronutrient matching for ingredient ${food.id} skipped: the food changed while matching`);
  }

  /**
   * Works through the whole queue, each food at most once per run, so a food
   * that keeps failing can't loop forever. Stops early while OpenAI is
   * unavailable; the next tick tries again.
   * @returns {Promise<number>} the number of foods attempted
   */
  async function runOnce() {
    if (!reference.hasMicros()) return 0;
    const seen = new Set();
    for (;;) {
      // Asking for the seen foods plus a page means unseen ones are never hidden behind failing ones.
      const next = foodMicros.queue(seen.size + QUEUE_PAGE).filter((food) => !seen.has(food.id));
      if (next.length === 0) return seen.size;
      for (const food of next) {
        seen.add(food.id);
        if (!(await processFood(food))) return seen.size;
      }
    }
  }

  let timer = null;
  let running = false;

  /** One run at a time: a tick while a run is busy is skipped. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      console.error('Micronutrient matcher run failed', error);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, intervalMs);
    // The matcher alone must not keep the process alive.
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}
