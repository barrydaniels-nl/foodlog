/**
 * Where each food's micronutrients come from: its NEVO "twin", its own label
 * values and AI estimates. Values are resolved when read, never copied, so a
 * twin change or a NEVO re-upload shows up everywhere at once.
 */
import { MICRO_BY_KEY, MICRO_KEYS, Origin, RETINOL_KEY } from '../public/js/shared/micronutrients.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { nevoReferenceCode } from './nevo.js';
import { requireId, requireNumber } from './validate.js';

/** The matching state of an ingredient (`ingredients.micro_status`). */
export const FoodMicroStatus = Object.freeze({
  PENDING: 'pending',
  UNCONFIRMED: 'unconfirmed',
  CONFIRMED: 'confirmed',
  NONE: 'none',
});

/** Work waiting for the matcher (`ingredients.micro_job`); NULL means nothing to do. */
export const MicroJob = Object.freeze({ MATCH: 'match', FILL: 'fill' });

/** After this many failed matcher runs a food stops being retried. */
export const MAX_ATTEMPTS = 3;

const MICRO_KEY_SET = new Set(MICRO_KEYS);
/** Per nutrient, the first origin with a value wins: the label, then the NEVO twin, then the AI estimate. */
const PRIORITY = [Origin.LABEL, Origin.NEVO, Origin.AI];
const IDS = 'SELECT value FROM json_each(:ids)';

/**
 * Twin codes look like 'nevo:83'. Splitting one into source and number lets
 * SQLite use the (source, code) primary key of the reference tables instead
 * of scanning them.
 * @param {string} alias the reference table alias; the ingredient is `i`
 * @returns {string} SQL join condition
 */
function twinMatches(alias) {
  return `${alias}.source = substr(i.micro_twin_code, 1, instr(i.micro_twin_code, ':') - 1)
    AND ${alias}.code = CAST(substr(i.micro_twin_code, instr(i.micro_twin_code, ':') + 1) AS INTEGER)`;
}

/**
 * @typedef {object} ResolvedFood
 * @property {string} status a FoodMicroStatus
 * @property {string|null} twinCode e.g. 'nevo:83'
 * @property {Record<string, {amount: number, origin: string}>} values per 100 g; unknown keys are absent
 * @property {number|null} retinol µg per 100 g from the twin, null when unknown
 * @property {boolean} hasData true when at least one nutrient is known
 */

/**
 * @param {unknown} input
 * @param {string} field name used in error messages
 * @param {{maxFor?: (key: string) => number}} [options] per-key ceiling; amounts above it are rejected
 * @returns {Record<string, number>} amounts per nutrient key
 */
export function validateMicroValues(input, field, { maxFor = (key) => MICRO_BY_KEY[key].max } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, `${field} must be an object of nutrient amounts`);
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, amount]) => {
      if (!MICRO_KEY_SET.has(key)) throw new HttpError(400, `${field}.${key} is not a known nutrient`);
      return [key, requireNumber(amount, `${field}.${key}`, { min: 0, max: maxFor(key) })];
    }),
  );
}

/**
 * @param {Array<{nutrient: string, amount: number}>} rows
 * @returns {Record<string, number>} in display order
 */
function toRecord(rows) {
  const byKey = new Map(rows.map((row) => [row.nutrient, row.amount]));
  return Object.fromEntries(MICRO_KEYS.filter((key) => byKey.has(key)).map((key) => [key, byKey.get(key)]));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{reference: ReturnType<import('./nevo.js').createReferenceRepo>}} deps
 */
export function createFoodMicrosRepo(db, { reference }) {
  // A food with no data at all (as `resolve` sees it, so a twin with only the hidden retinol counts as none)
  // stays listed whatever its status, so the coverage line's "Review matches" link is never a dead end.
  const reviewFilter = `i.archived = 0 AND (
    i.micro_status IN (:unconfirmed, :pending, :none)
    OR (NOT EXISTS (SELECT 1 FROM ingredient_micros own WHERE own.ingredient_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM reference_micros twin WHERE ${twinMatches('twin')} AND twin.nutrient != :retinol))
  )`;
  const reviewParams = {
    unconfirmed: FoodMicroStatus.UNCONFIRMED,
    pending: FoodMicroStatus.PENDING,
    none: FoodMicroStatus.NONE,
    retinol: RETINOL_KEY,
  };

  /**
   * The matcher's writes only apply while the food still has the job, twin
   * and name it started with: a twin the user picks, an archive or a deletion
   * during the AI calls wins. The name catches a backup import that reused
   * the id for another food.
   */
  const unchangedJob =
    'id = :id AND archived = 0 AND micro_job IS :expectJob AND micro_twin_code IS :expectTwinCode AND name IS :expectName';

  const statements = {
    food: db.prepare(
      `SELECT i.id, i.micro_twin_code, i.micro_status, i.micro_job, r.name AS twin_name FROM ingredients i
       LEFT JOIN reference_foods r ON ${twinMatches('r')}
       WHERE i.id = ?`,
    ),
    values: db.prepare('SELECT nutrient, amount FROM ingredient_micros WHERE ingredient_id = ? AND origin = ?'),
    deleteOrigin: db.prepare('DELETE FROM ingredient_micros WHERE ingredient_id = ? AND origin = ?'),
    deleteValue: db.prepare('DELETE FROM ingredient_micros WHERE ingredient_id = ? AND nutrient = ? AND origin = ?'),
    upsertValue: db.prepare(
      `INSERT INTO ingredient_micros (ingredient_id, nutrient, amount, origin) VALUES (?, ?, ?, ?)
       ON CONFLICT (ingredient_id, nutrient, origin) DO UPDATE SET amount = excluded.amount`,
    ),
    resolveFoods: db.prepare(`SELECT id, micro_status, micro_twin_code FROM ingredients WHERE id IN (${IDS})`),
    // Own values and twin values in one pass; the per-key priority is applied in JS.
    resolveValues: db.prepare(
      `SELECT ingredient_id AS id, nutrient, amount, origin FROM ingredient_micros WHERE ingredient_id IN (${IDS})
       UNION ALL
       SELECT i.id, m.nutrient, m.amount, :nevo FROM ingredients i
       JOIN reference_micros m ON ${twinMatches('m')}
       WHERE i.id IN (${IDS})`,
    ),
    setTwin: db.prepare(
      `UPDATE ingredients SET micro_twin_code = :twinCode, micro_status = :status, micro_job = :job, micro_attempts = 0
       WHERE id = :id`,
    ),
    confirm: db.prepare('UPDATE ingredients SET micro_status = :confirmed WHERE id = :id AND micro_status = :unconfirmed'),
    queue: db.prepare(
      `SELECT id, name, brand, kcal, protein, carbs, fat, micro_job, micro_twin_code, micro_status FROM ingredients
       WHERE archived = 0 AND micro_job IS NOT NULL AND micro_attempts < :maxAttempts
       ORDER BY id
       LIMIT :limit`,
    ),
    finish: db.prepare(
      `UPDATE ingredients SET micro_twin_code = CASE WHEN :keepTwin THEN micro_twin_code ELSE :twinCode END,
         micro_status = COALESCE(:status, micro_status), micro_job = NULL, micro_attempts = 0
       WHERE ${unchangedJob}`,
    ),
    // A label value always wins, so an estimate for a labelled nutrient would only be a hidden, stale row.
    upsertAiValue: db.prepare(
      `INSERT INTO ingredient_micros (ingredient_id, nutrient, amount, origin)
       SELECT :id, :nutrient, :amount, :ai
       WHERE NOT EXISTS (
         SELECT 1 FROM ingredient_micros WHERE ingredient_id = :id AND nutrient = :nutrient AND origin = :label
       )
       ON CONFLICT (ingredient_id, nutrient, origin) DO UPDATE SET amount = excluded.amount`,
    ),
    fail: db.prepare(
      `UPDATE ingredients SET micro_attempts = micro_attempts + 1 WHERE ${unchangedJob} RETURNING micro_attempts`,
    ),
    // A food the matcher gave up on, with nothing to show, is "no data" rather than "waiting".
    giveUp: db.prepare(
      `UPDATE ingredients SET micro_job = NULL,
         micro_status = CASE
           WHEN micro_twin_code IS NULL AND NOT EXISTS (SELECT 1 FROM ingredient_micros m WHERE m.ingredient_id = ingredients.id)
           THEN :none ELSE micro_status END
       WHERE id = :id`,
    ),
    review: db.prepare(
      `SELECT i.id, i.name, i.brand, i.micro_status, i.micro_twin_code, r.name AS twin_name FROM ingredients i
       LEFT JOIN reference_foods r ON ${twinMatches('r')}
       WHERE ${reviewFilter}
       ORDER BY i.name COLLATE NOCASE, i.id`,
    ),
    reviewAiKeys: db.prepare(
      `SELECT m.ingredient_id, m.nutrient FROM ingredient_micros m JOIN ingredients i ON i.id = m.ingredient_id
       WHERE m.origin = :ai AND ${reviewFilter}`,
    ),
  };

  function requireFood(id) {
    const row = statements.food.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Ingredient not found');
    return row;
  }

  /** Inserts or overwrites the given keys for one origin, leaving other keys alone. */
  function upsertValues(id, values, origin) {
    for (const [key, amount] of Object.entries(values)) statements.upsertValue.run(id, key, amount, origin);
  }

  /**
   * @param {number[]} ids ingredient ids; unknown ids are left out of the result
   * @returns {Map<number, ResolvedFood>}
   */
  function resolve(ids) {
    const result = new Map();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return result;
    const params = { ids: JSON.stringify(unique) };

    const sources = new Map();
    for (const row of statements.resolveFoods.all(params)) {
      sources.set(row.id, { food: row, [Origin.LABEL]: {}, [Origin.NEVO]: {}, [Origin.AI]: {} });
    }
    for (const row of statements.resolveValues.all({ ...params, nevo: Origin.NEVO })) {
      sources.get(row.id)[row.origin][row.nutrient] = row.amount;
    }

    for (const [id, { food, ...byOrigin }] of sources) {
      const values = {};
      for (const key of MICRO_KEYS) {
        const origin = PRIORITY.find((o) => byOrigin[o][key] !== undefined);
        if (origin) values[key] = { amount: byOrigin[origin][key], origin };
      }
      result.set(id, {
        status: food.micro_status,
        twinCode: food.micro_twin_code,
        values,
        retinol: byOrigin[Origin.NEVO][RETINOL_KEY] ?? null,
        hasData: Object.keys(values).length > 0,
      });
    }
    return result;
  }

  /**
   * @returns {{twinCode: string|null, twinName: string|null, status: string, job: string|null,
   *   label: Record<string, number>, ai: Record<string, number>}}
   */
  function info(id) {
    const food = requireFood(id);
    return {
      twinCode: food.micro_twin_code,
      twinName: food.twin_name ?? null,
      status: food.micro_status,
      job: food.micro_job,
      label: toRecord(statements.values.all(food.id, Origin.LABEL)),
      ai: toRecord(statements.values.all(food.id, Origin.AI)),
    };
  }

  /**
   * Replaces all label values. Runs inside the caller's transaction (ingredient
   * create/update), so it opens none itself.
   * @param {number} id
   * @param {Record<string, number>} values already checked with validateMicroValues
   */
  function writeLabelValues(id, values) {
    statements.deleteOrigin.run(id, Origin.LABEL);
    upsertValues(id, values, Origin.LABEL);
  }

  /**
   * The user picks a twin (or none): it is approved by definition, and the
   * remaining gaps are queued for estimates. Old AI estimates no longer fit a
   * new twin, so they are dropped then; with no twin they are still the best
   * values there are, so they stay.
   * @param {number} id
   * @param {number|null} code NEVO code, or null for no twin
   */
  function setTwin(id, code) {
    const food = requireFood(id);
    const twinCode = code === null ? null : nevoReferenceCode(reference.get(code).code);
    transaction(db, () => {
      statements.setTwin.run({ id: food.id, twinCode, status: FoodMicroStatus.CONFIRMED, job: MicroJob.FILL });
      if (twinCode !== null) statements.deleteOrigin.run(food.id, Origin.AI);
    });
    return info(food.id);
  }

  /** Approves an AI match; any other status is left as it is. */
  function confirm(id) {
    const food = requireFood(id);
    statements.confirm.run({ id: food.id, confirmed: FoodMicroStatus.CONFIRMED, unconfirmed: FoodMicroStatus.UNCONFIRMED });
    return info(food.id);
  }

  /**
   * User edits: an edited value is the user's word, so it becomes a label value
   * and replaces the AI estimate for that nutrient.
   * @param {number} id
   * @param {unknown} input Record<key, number>
   */
  function saveValues(id, input) {
    const food = requireFood(id);
    const values = validateMicroValues(input, 'values');
    transaction(db, () => {
      upsertValues(food.id, values, Origin.LABEL);
      for (const key of Object.keys(values)) statements.deleteValue.run(food.id, key, Origin.AI);
    });
    return info(food.id);
  }

  /**
   * @param {number} limit
   * @returns {Array<{id: number, name: string, brand: string|null, kcal: number, protein: number, carbs: number,
   *   fat: number, job: string, twinCode: string|null, status: string}>} foods waiting for the matcher, oldest first
   */
  function queue(limit) {
    return statements.queue.all({ maxAttempts: MAX_ATTEMPTS, limit }).map((row) => ({
      id: row.id,
      name: row.name,
      brand: row.brand,
      kcal: row.kcal,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      job: row.micro_job,
      twinCode: row.micro_twin_code,
      status: row.micro_status,
    }));
  }

  /**
   * @typedef {object} ExpectedJob what the food looked like when the matcher took it from the queue
   * @property {string|null} expectJob
   * @property {string|null} expectTwinCode
   * @property {string} expectName
   */

  /**
   * Stores the matcher's result and takes the food off the queue, unless the
   * food changed since it was queued (see `unchangedJob`).
   * @param {number} id
   * @param {ExpectedJob & {twinCode?: string|null, status?: string, aiValues: Record<string, number>}} result
   *   `twinCode` undefined keeps the current twin; `status` undefined keeps the current status, so a confirm
   *   during the run sticks; `aiValues` replace the AI rows of those keys only, skipping labelled keys
   * @returns {boolean} whether the result was stored
   */
  function finishJob(id, { expectJob, expectTwinCode, expectName, twinCode, status, aiValues }) {
    return transaction(db, () => {
      const { changes } = statements.finish.run({
        id,
        expectJob,
        expectTwinCode,
        expectName,
        keepTwin: twinCode === undefined ? 1 : 0,
        twinCode: twinCode ?? null,
        status: status ?? null,
      });
      if (changes === 0) return false;
      for (const [nutrient, amount] of Object.entries(aiValues)) {
        statements.upsertAiValue.run({ id, nutrient, amount, ai: Origin.AI, label: Origin.LABEL });
      }
      return true;
    });
  }

  /**
   * Counts a failed matcher run, unless the food changed since it was queued;
   * after MAX_ATTEMPTS the food is no longer retried.
   * @param {number} id
   * @param {ExpectedJob} expected
   * @returns {boolean} whether the failure was counted
   */
  function failJob(id, { expectJob, expectTwinCode, expectName }) {
    const row = statements.fail.get({ id, expectJob, expectTwinCode, expectName });
    if (!row) return false;
    if (row.micro_attempts >= MAX_ATTEMPTS) statements.giveUp.run({ id, none: FoodMicroStatus.NONE });
    return true;
  }

  /**
   * @returns {Array<{id: number, name: string, brand: string|null, status: string, twinCode: string|null,
   *   twinName: string|null, aiKeys: string[]}>} foods whose micronutrients still need a look
   */
  function listForReview() {
    const aiKeys = new Map();
    for (const row of statements.reviewAiKeys.all({ ...reviewParams, ai: Origin.AI })) {
      if (!aiKeys.has(row.ingredient_id)) aiKeys.set(row.ingredient_id, new Set());
      aiKeys.get(row.ingredient_id).add(row.nutrient);
    }
    return statements.review.all(reviewParams).map((row) => ({
      id: row.id,
      name: row.name,
      brand: row.brand,
      status: row.micro_status,
      twinCode: row.micro_twin_code,
      twinName: row.twin_name ?? null,
      aiKeys: MICRO_KEYS.filter((key) => aiKeys.get(row.id)?.has(key)),
    }));
  }

  return { resolve, info, writeLabelValues, setTwin, confirm, saveValues, queue, finishJob, failJob, listForReview };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{foodMicros: ReturnType<typeof createFoodMicrosRepo>}} deps
 */
export function registerFoodMicroRoutes(router, { foodMicros }) {
  router.add('GET', '/api/micros/review', () => foodMicros.listForReview());
  router.add('GET', '/api/ingredients/:id/micros', ({ params }) => foodMicros.info(params.id));
  router.add('POST', '/api/ingredients/:id/micros/confirm', ({ params }) => foodMicros.confirm(params.id));
  router.add('PUT', '/api/ingredients/:id/micros/twin', ({ params, body }) => foodMicros.setTwin(params.id, body?.code));
  router.add('PUT', '/api/ingredients/:id/micros/values', ({ params, body }) => foodMicros.saveValues(params.id, body?.values));
}
