/**
 * Open Food Facts lookup. Results are candidates only; the user confirms them
 * before they are copied into the local ingredient database.
 */
import { OFF_COUNTRIES, OFF_WORLD } from '../public/js/shared/constants.js';
import { MICRO_BY_KEY, roundMicro } from '../public/js/shared/micronutrients.js';
import { HttpError } from './http.js';
import { validateBarcode } from './ingredients.js';

const USER_AGENT = 'Foodlog/1.0 (self-hosted personal app)';
// search-a-licious: the legacy cgi/search.pl endpoint is rate-limited to the point of returning 503s.
const SEARCH_URL = 'https://search.openfoodfacts.org/search';
const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product';
// Lucene query syntax characters; users type product names, not queries.
const QUERY_SYNTAX = /[+\-&|!(){}[\]^"~*?:\\/]+/g;
const KJ_PER_KCAL = 4.184;
const MIN_COUNTRY_RESULTS = 10;
const PAGE_SIZE = 20;
const FIELDS = [
  'code',
  'product_name',
  'product_name_nl',
  'generic_name',
  'brands',
  'nutriments',
  'serving_size',
  'serving_quantity',
  'product_quantity',
  'image_small_url',
].join(',');
const UNAVAILABLE = 'Open Food Facts is unavailable right now. Try again in a moment.';
/** OFF nutriment name → our micronutrient key. OFF's folate is taken as dietary folate equivalents. */
const OFF_MICROS = {
  'vitamin-d': 'vitaminD',
  calcium: 'calcium',
  iron: 'iron',
  salt: 'salt',
  potassium: 'potassium',
  magnesium: 'magnesium',
  zinc: 'zinc',
  'vitamin-b12': 'vitaminB12',
  'vitamin-c': 'vitaminC',
  folates: 'folate',
};
/** OFF stores every `_100g` amount in grams. */
const FROM_GRAMS = { g: 1, mg: 1000, 'µg': 1_000_000 };

/**
 * @typedef {object} OffCandidate
 * @property {string|null} barcode
 * @property {string} name
 * @property {string|null} brand
 * @property {number|null} kcal
 * @property {number|null} protein
 * @property {number|null} carbs
 * @property {number|null} fat
 * @property {number} fiber
 * @property {Array<{label: string, grams: number}>} portions
 * @property {string|null} imageUrl
 * @property {Record<string, number>} micros label micronutrients per 100 g, in each nutrient's unit
 * @property {boolean} complete true when every required nutrient is known
 */

function numberOrNull(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function energyKcal(nutriments) {
  const kcal = numberOrNull(nutriments['energy-kcal_100g']);
  if (kcal !== null) return kcal;
  const kj = numberOrNull(nutriments['energy-kj_100g']) ?? numberOrNull(nutriments.energy_100g);
  return kj === null ? null : kj / KJ_PER_KCAL;
}

/**
 * @param {Record<string, unknown>} nutriments
 * @returns {Record<string, number>} the known micronutrients, converted from grams
 */
function offMicros(nutriments) {
  const micros = {};
  for (const [offName, key] of Object.entries(OFF_MICROS)) {
    const raw = nutriments[`${offName}_100g`];
    // A blank is unknown; Number('') would turn it into a label value of 0 that masks the NEVO twin.
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const grams = numberOrNull(raw);
    if (grams === null) continue;
    const { unit, max } = MICRO_BY_KEY[key];
    const amount = roundMicro(grams * FROM_GRAMS[unit]);
    // Crowd-sourced data has unit mix-ups; an implausible value would make the food impossible to save.
    if (amount <= max) micros[key] = amount;
  }
  return micros;
}

/**
 * Maps a raw OFF product onto our per-100 g shape. OFF lists drinks per
 * 100 ml under the same `_100g` keys; we treat those as per 100 g.
 * @param {any} raw
 * @returns {OffCandidate|null} null when the product has no usable name
 */
export function mapOffProduct(raw) {
  const name = firstText(raw?.product_name_nl, raw?.product_name, raw?.generic_name);
  if (!name) return null;
  const nutriments = raw.nutriments ?? {};
  const candidate = {
    barcode: firstText(raw.code),
    name,
    brand: firstText(Array.isArray(raw.brands) ? raw.brands[0] : raw.brands?.split(',')[0]),
    kcal: round1(energyKcal(nutriments)),
    protein: round1(numberOrNull(nutriments.proteins_100g)),
    carbs: round1(numberOrNull(nutriments.carbohydrates_100g)),
    fat: round1(numberOrNull(nutriments.fat_100g)),
    fiber: round1(numberOrNull(nutriments.fiber_100g)) ?? 0,
    portions: [],
    imageUrl: firstText(raw.image_small_url),
    micros: offMicros(nutriments),
  };
  const serving = numberOrNull(raw.serving_quantity);
  if (serving) candidate.portions.push({ label: firstText(raw.serving_size) ?? 'Serving', grams: serving });
  const pack = numberOrNull(raw.product_quantity);
  if (pack) candidate.portions.push({ label: 'Whole package', grams: pack });
  candidate.complete = ['kcal', 'protein', 'carbs', 'fat'].every((key) => candidate[key] !== null);
  return candidate;
}

/**
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export function createOffClient({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  async function getJson(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`Open Food Facts request failed: ${url}`, error);
      throw new HttpError(502, UNAVAILABLE);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error(`Open Food Facts returned ${response.status}: ${url}`);
      throw new HttpError(502, UNAVAILABLE);
    }
    try {
      return await response.json();
    } catch (error) {
      console.error(`Open Food Facts sent invalid JSON: ${url}`, error);
      throw new HttpError(502, UNAVAILABLE);
    }
  }

  async function searchIn(query, country) {
    const filter = country === OFF_WORLD ? '' : ` countries_tags:"en:${OFF_COUNTRIES[country]}"`;
    const params = new URLSearchParams({ q: `${query}${filter}`, page_size: String(PAGE_SIZE), fields: FIELDS });
    const data = await getJson(`${SEARCH_URL}?${params}`);
    return (data?.hits ?? []).map(mapOffProduct).filter(Boolean);
  }

  /**
   * Searches the user's country first and tops up with worldwide results.
   * @param {string} rawQuery what the user typed
   * @param {string} country a key of OFF_COUNTRIES or OFF_WORLD
   * @returns {Promise<OffCandidate[]>}
   */
  async function search(rawQuery, country) {
    const query = rawQuery.replace(QUERY_SYNTAX, ' ').replace(/\s+/g, ' ').trim();
    if (!query) return [];
    const region = Object.hasOwn(OFF_COUNTRIES, country) ? country : OFF_WORLD;
    const results = await searchIn(query, region);
    if (region === OFF_WORLD || results.length >= MIN_COUNTRY_RESULTS) return results;
    let world;
    try {
      world = await searchIn(query, OFF_WORLD);
    } catch (error) {
      // Country results are still useful on their own.
      if (results.length > 0 && error instanceof HttpError) return results;
      throw error;
    }
    const seen = new Set(results.map((p) => p.barcode).filter(Boolean));
    for (const item of world) {
      if (item.barcode && seen.has(item.barcode)) continue;
      if (item.barcode) seen.add(item.barcode);
      results.push(item);
    }
    return results;
  }

  /** @returns {Promise<OffCandidate|null>} */
  async function product(barcode) {
    const data = await getJson(`${PRODUCT_URL}/${barcode}?fields=${FIELDS}`);
    if (!data || data.status !== 1 || !data.product) return null;
    return mapOffProduct({ code: barcode, ...data.product });
  }

  return { search, product };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{offClient: ReturnType<typeof createOffClient>, settings: {get: () => {offCountry: string}}}} deps
 */
export function registerOffRoutes(router, { offClient, settings }) {
  router.add('GET', '/api/off/search', ({ query }) => {
    const q = (query.get('q') ?? '').trim();
    if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters to search');
    return offClient.search(q, settings.get().offCountry);
  });
  router.add('GET', '/api/off/product/:barcode', async ({ params }) => {
    const code = validateBarcode(params.barcode);
    if (!code) throw new HttpError(400, 'barcode must be 8 to 14 digits');
    const found = await offClient.product(code);
    if (!found) throw new HttpError(404, 'Product not found on Open Food Facts');
    return found;
  });
}
