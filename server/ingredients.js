/** The personal ingredient database: values per 100 g, portions, soft delete. */
import { NUTRIENT_KEYS } from '../public/js/shared/constants.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { optionalString, requireId, requireNumber, requireString } from './validate.js';

const BARCODE_PATTERN = /^\d{8,14}$/;
const SOURCES = new Set(['manual', 'off', 'nevo']);
const MAX_PORTIONS = 10;
const LIST_LIMIT = 50;
const RECENT_LIMIT = 8;

/**
 * @typedef {object} Ingredient
 * @property {number} id
 * @property {string} name
 * @property {string|null} brand
 * @property {string|null} barcode
 * @property {number} kcal
 * @property {number} protein
 * @property {number} carbs
 * @property {number} fat
 * @property {number} fiber
 * @property {'manual'|'off'|'nevo'} source
 * @property {string|null} referenceCode e.g. 'nevo:83' while the values are unchanged
 * @property {boolean} archived
 * @property {Array<{id: number, label: string, grams: number}>} portions
 */

/**
 * @param {unknown} value
 * @returns {string|null}
 */
export function validateBarcode(value) {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim();
  if (!BARCODE_PATTERN.test(code)) throw new HttpError(400, 'barcode must be 8 to 14 digits');
  return code;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Ingredient data is required');
  const portions = input.portions ?? [];
  if (!Array.isArray(portions) || portions.length > MAX_PORTIONS) {
    throw new HttpError(400, `portions must be a list of at most ${MAX_PORTIONS} items`);
  }
  const source = input.source ?? 'manual';
  if (!SOURCES.has(source)) throw new HttpError(400, `source must be one of: ${[...SOURCES].join(', ')}`);
  return {
    name: requireString(input.name, 'name', { maxLength: 120 }),
    brand: optionalString(input.brand, 'brand', { maxLength: 80 }),
    barcode: validateBarcode(input.barcode),
    kcal: requireNumber(input.kcal, 'kcal', { min: 0, max: 1000 }),
    protein: requireNumber(input.protein, 'protein', { min: 0, max: 100 }),
    carbs: requireNumber(input.carbs, 'carbs', { min: 0, max: 100 }),
    fat: requireNumber(input.fat, 'fat', { min: 0, max: 100 }),
    fiber: input.fiber === undefined || input.fiber === null ? 0 : requireNumber(input.fiber, 'fiber', { min: 0, max: 100 }),
    source,
    portions: portions.map((portion, i) => ({
      label: requireString(portion?.label, `portions[${i}].label`, { maxLength: 40 }),
      grams: requireNumber(portion?.grams, `portions[${i}].grams`, { min: 0.1, max: 5000 }),
    })),
  };
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{today: () => string}} deps
 */
export function createIngredientsRepo(db, { today }) {
  const statements = {
    byId: db.prepare('SELECT * FROM ingredients WHERE id = ?'),
    byBarcode: db.prepare('SELECT * FROM ingredients WHERE barcode = ?'),
    byReference: db.prepare('SELECT * FROM ingredients WHERE reference_code = ?'),
    portions: db.prepare('SELECT id, label, grams FROM portions WHERE ingredient_id = ? ORDER BY id'),
    insert: db.prepare(
      `INSERT INTO ingredients (name, brand, barcode, kcal, protein, carbs, fat, fiber, source, reference_code)
       VALUES (:name, :brand, :barcode, :kcal, :protein, :carbs, :fat, :fiber, :source, :referenceCode)`,
    ),
    update: db.prepare(
      `UPDATE ingredients SET name = :name, brand = :brand, barcode = :barcode, kcal = :kcal, protein = :protein,
         carbs = :carbs, fat = :fat, fiber = :fiber, source = :source, reference_code = :referenceCode,
         updated_at = datetime('now')
       WHERE id = :id`,
    ),
    deletePortions: db.prepare('DELETE FROM portions WHERE ingredient_id = ?'),
    insertPortion: db.prepare('INSERT INTO portions (ingredient_id, label, grams) VALUES (?, ?, ?)'),
    setArchived: db.prepare("UPDATE ingredients SET archived = ?, updated_at = datetime('now') WHERE id = ?"),
    // Planned days follow ingredient fixes; history stays as it was eaten.
    refreshEntries: db.prepare(
      `UPDATE entries SET name = :name, brand = :brand, kcal = :kcal, protein = :protein, carbs = :carbs,
         fat = :fat, fiber = :fiber
       WHERE ingredient_id = :id AND date >= :fromDate`,
    ),
    recent: db.prepare(
      `SELECT i.* FROM ingredients i
       JOIN (SELECT ingredient_id, MAX(id) AS last_entry FROM entries GROUP BY ingredient_id) e
         ON e.ingredient_id = i.id
       WHERE i.archived = 0
       ORDER BY e.last_entry DESC
       LIMIT ${RECENT_LIMIT}`,
    ),
    // Compact rows for the AI day analysis: no portions, never-planned foods last.
    byRecentUse: db.prepare(
      `SELECT i.name, i.brand, i.kcal, i.protein, i.carbs, i.fat FROM ingredients i
       LEFT JOIN (SELECT ingredient_id, MAX(id) AS last_entry FROM entries GROUP BY ingredient_id) e
         ON e.ingredient_id = i.id
       WHERE i.archived = 0
       ORDER BY e.last_entry IS NULL, e.last_entry DESC, i.name COLLATE NOCASE
       LIMIT ?`,
    ),
    search: db.prepare(
      `SELECT * FROM ingredients
       WHERE (:includeArchived = 1 OR archived = 0)
         AND (:pattern IS NULL OR name LIKE :pattern ESCAPE '\\' OR brand LIKE :pattern ESCAPE '\\')
       ORDER BY (:prefix IS NOT NULL AND name LIKE :prefix ESCAPE '\\') DESC, name COLLATE NOCASE, id
       LIMIT ${LIST_LIMIT}`,
    ),
  };

  /** @returns {Ingredient} */
  function hydrate(row) {
    return {
      id: row.id,
      name: row.name,
      brand: row.brand,
      barcode: row.barcode,
      kcal: row.kcal,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      fiber: row.fiber,
      source: row.source,
      referenceCode: row.reference_code,
      archived: row.archived === 1,
      portions: statements.portions.all(row.id).map((p) => ({ ...p })),
    };
  }

  function assertBarcodeFree(barcode, ownId = null) {
    if (!barcode) return;
    const existing = statements.byBarcode.get(barcode);
    if (existing && existing.id !== ownId) {
      throw new HttpError(409, 'An ingredient with this barcode already exists', { existingId: existing.id });
    }
  }

  function writePortions(id, portions) {
    statements.deletePortions.run(id);
    for (const { label, grams } of portions) statements.insertPortion.run(id, label, grams);
  }

  /** @returns {Ingredient} */
  function get(id) {
    const row = statements.byId.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Ingredient not found');
    return hydrate(row);
  }

  /** @returns {Ingredient|null} includes archived ingredients */
  function findByBarcode(code) {
    const row = statements.byBarcode.get(validateBarcode(code));
    return row ? hydrate(row) : null;
  }

  /** @returns {Ingredient|null} includes archived ingredients */
  function findByReference(referenceCode) {
    const row = statements.byReference.get(referenceCode);
    return row ? hydrate(row) : null;
  }

  /** @returns {Ingredient[]} */
  function list({ q = '', includeArchived = false } = {}) {
    const term = q.trim();
    const params = {
      includeArchived: includeArchived ? 1 : 0,
      pattern: term ? `%${escapeLike(term)}%` : null,
      prefix: term ? `${escapeLike(term)}%` : null,
    };
    return statements.search.all(params).map(hydrate);
  }

  /**
   * @param {object} input
   * @param {{referenceCode?: string|null}} [link] set when copied from a reference table
   * @returns {Ingredient}
   */
  function create(input, { referenceCode = null } = {}) {
    const clean = validateInput(input);
    assertBarcodeFree(clean.barcode);
    const id = transaction(db, () => {
      const { portions, ...fields } = clean;
      const { lastInsertRowid } = statements.insert.run({ ...fields, referenceCode });
      writePortions(lastInsertRowid, portions);
      return Number(lastInsertRowid);
    });
    return get(id);
  }

  /** @returns {Ingredient} */
  function update(id, input) {
    const existing = get(id);
    const clean = validateInput(input);
    assertBarcodeFree(clean.barcode, existing.id);
    // Reference data may only be used unchanged: edited values make it your own food.
    const keepsReference =
      existing.referenceCode !== null && NUTRIENT_KEYS.every((key) => clean[key] === existing[key]);
    const link = keepsReference
      ? { referenceCode: existing.referenceCode, source: existing.source }
      : { referenceCode: null, source: existing.referenceCode ? 'manual' : clean.source };
    transaction(db, () => {
      const { portions, ...fields } = clean;
      statements.update.run({ ...fields, ...link, id: existing.id });
      writePortions(existing.id, portions);
      const { name, brand, kcal, protein, carbs, fat, fiber } = fields;
      statements.refreshEntries.run({ id: existing.id, fromDate: today(), name, brand, kcal, protein, carbs, fat, fiber });
    });
    return get(existing.id);
  }

  function setArchived(id, archived) {
    const existing = get(id);
    statements.setArchived.run(archived ? 1 : 0, existing.id);
    return get(existing.id);
  }

  /** @returns {Ingredient[]} most recently planned first */
  function recent() {
    return statements.recent.all().map(hydrate);
  }

  /**
   * @param {number} limit
   * @returns {Array<{name: string, brand: string|null, kcal: number, protein: number, carbs: number, fat: number}>}
   *   non-archived foods, most recently planned first
   */
  function listByRecentUse(limit) {
    return statements.byRecentUse.all(limit).map((row) => ({ ...row }));
  }

  return {
    get,
    findByBarcode,
    findByReference,
    list,
    recent,
    listByRecentUse,
    create,
    update,
    archive: (id) => setArchived(id, true),
    restore: (id) => setArchived(id, false),
  };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createIngredientsRepo>} ingredients
 */
export function registerIngredientRoutes(router, ingredients) {
  router.add('GET', '/api/ingredients', ({ query }) => {
    if (query.get('recent') === '1') return ingredients.recent();
    return ingredients.list({ q: query.get('q') ?? '', includeArchived: query.get('archived') === '1' });
  });
  router.add('POST', '/api/ingredients', ({ body }) => ingredients.create(body), { status: 201 });
  router.add('GET', '/api/ingredients/barcode/:code', ({ params }) => {
    const found = ingredients.findByBarcode(params.code);
    if (!found) throw new HttpError(404, 'No ingredient with this barcode');
    return found;
  });
  router.add('GET', '/api/ingredients/:id', ({ params }) => ingredients.get(params.id));
  router.add('PUT', '/api/ingredients/:id', ({ params, body }) => ingredients.update(params.id, body));
  router.add('DELETE', '/api/ingredients/:id', ({ params }) => void ingredients.archive(params.id), { status: 204 });
  router.add('POST', '/api/ingredients/:id/restore', ({ params }) => ingredients.restore(params.id));
}
