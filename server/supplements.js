/**
 * Supplements: a catalogue of label values per unit, the single "My daily
 * supplements" set, and the per-day log of what was taken.
 */
import { MICRO_KEYS } from '../public/js/shared/micronutrients.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { validateMicroValues } from './food-micros.js';
import { optionalString, requireDate, requireId, requireNumber, requireString } from './validate.js';

const MAX_SET_ITEMS = 50;
/** A label can legitimately list large amounts (e.g. IU-based or megadose products), so this is a sanity ceiling only. */
const MAX_AMOUNT = 100000;

const requireUnits = (value, field = 'units') => requireNumber(value, field, { min: 0.25, max: 20 });

/**
 * @typedef {object} Supplement
 * @property {number} id
 * @property {string} name
 * @property {string|null} brand
 * @property {string} unitLabel what one unit is, e.g. "capsule"
 * @property {boolean} archived
 * @property {Record<string, number>} nutrients raw label amounts per unit (folate as folic acid)
 *
 * @typedef {object} SetItem
 * @property {number} supplementId
 * @property {string} name
 * @property {string} unitLabel
 * @property {number} units
 *
 * @typedef {object} SupplementEntry
 * @property {number} id
 * @property {string} date
 * @property {number} supplementId
 * @property {string} name
 * @property {string|null} brand
 * @property {string} unitLabel
 * @property {number} units
 * @property {number} position
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSupplementsRepo(db) {
  const statements = {
    all: db.prepare(
      'SELECT * FROM supplements WHERE (:includeArchived = 1 OR archived = 0) ORDER BY name COLLATE NOCASE, id',
    ),
    byId: db.prepare('SELECT * FROM supplements WHERE id = ?'),
    nutrients: db.prepare(
      'SELECT supplement_id, nutrient, amount FROM supplement_nutrients WHERE supplement_id IN (SELECT value FROM json_each(?))',
    ),
    insert: db.prepare('INSERT INTO supplements (name, brand, unit_label) VALUES (?, ?, ?)'),
    update: db.prepare(
      "UPDATE supplements SET name = ?, brand = ?, unit_label = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    setArchived: db.prepare("UPDATE supplements SET archived = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteNutrients: db.prepare('DELETE FROM supplement_nutrients WHERE supplement_id = ?'),
    insertNutrient: db.prepare('INSERT INTO supplement_nutrients (supplement_id, nutrient, amount) VALUES (?, ?, ?)'),

    set: db.prepare(
      `SELECT s.supplement_id, s.units, p.name, p.unit_label, p.archived FROM supplement_set s
       JOIN supplements p ON p.id = s.supplement_id ORDER BY s.position`,
    ),
    clearSet: db.prepare('DELETE FROM supplement_set'),
    insertSetItem: db.prepare('INSERT INTO supplement_set (supplement_id, units, position) VALUES (?, ?, ?)'),

    range: db.prepare(
      `SELECT e.id, e.date, e.supplement_id, e.units, e.position, s.name, s.brand, s.unit_label
       FROM supplement_entries e JOIN supplements s ON s.id = e.supplement_id
       WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.position, e.id`,
    ),
    entryById: db.prepare('SELECT * FROM supplement_entries WHERE id = ?'),
    nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM supplement_entries WHERE date = ?'),
    insertEntry: db.prepare(
      'INSERT INTO supplement_entries (date, supplement_id, units, position) VALUES (?, ?, ?, ?)',
    ),
    updateEntry: db.prepare('UPDATE supplement_entries SET units = ? WHERE id = ?'),
    removeEntry: db.prepare('DELETE FROM supplement_entries WHERE id = ?'),
    dayEntries: db.prepare('SELECT supplement_id, units FROM supplement_entries WHERE date = ? ORDER BY position, id'),
  };

  /**
   * @param {number[]} ids
   * @returns {Map<number, Record<string, number>>} raw per-unit amounts in display order; every id is present
   */
  function nutrientsFor(ids) {
    const byId = new Map(ids.map((id) => [id, new Map()]));
    for (const row of statements.nutrients.all(JSON.stringify(ids))) {
      byId.get(row.supplement_id).set(row.nutrient, row.amount);
    }
    return new Map(
      [...byId].map(([id, amounts]) => [
        id,
        Object.fromEntries(MICRO_KEYS.filter((key) => amounts.has(key)).map((key) => [key, amounts.get(key)])),
      ]),
    );
  }

  /** @returns {Supplement[]} */
  function hydrateAll(rows) {
    const nutrients = nutrientsFor(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      brand: row.brand,
      unitLabel: row.unit_label,
      archived: row.archived === 1,
      nutrients: nutrients.get(row.id),
    }));
  }

  /** @returns {Supplement} */
  function get(id) {
    const row = statements.byId.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Supplement not found');
    return hydrateAll([row])[0];
  }

  function validateInput(input) {
    const nutrients = validateMicroValues(input?.nutrients, 'nutrients', { maxFor: () => MAX_AMOUNT });
    if (Object.keys(nutrients).length === 0) throw new HttpError(400, 'A supplement needs at least one nutrient');
    return {
      name: requireString(input.name, 'name', { maxLength: 120 }),
      brand: optionalString(input.brand, 'brand', { maxLength: 80 }),
      unitLabel: requireString(input.unitLabel, 'unitLabel', { maxLength: 30 }),
      nutrients,
    };
  }

  function writeNutrients(id, nutrients) {
    statements.deleteNutrients.run(id);
    for (const [key, amount] of Object.entries(nutrients)) statements.insertNutrient.run(id, key, amount);
  }

  /** @returns {Supplement[]} */
  function list({ includeArchived = false } = {}) {
    return hydrateAll(statements.all.all({ includeArchived: includeArchived ? 1 : 0 }));
  }

  /** @returns {Supplement} */
  function create(input) {
    const clean = validateInput(input);
    const id = transaction(db, () => {
      const { lastInsertRowid } = statements.insert.run(clean.name, clean.brand, clean.unitLabel);
      writeNutrients(lastInsertRowid, clean.nutrients);
      return Number(lastInsertRowid);
    });
    return get(id);
  }

  /** @returns {Supplement} */
  function update(id, input) {
    const existing = get(id);
    const clean = validateInput(input);
    transaction(db, () => {
      statements.update.run(clean.name, clean.brand, clean.unitLabel, existing.id);
      writeNutrients(existing.id, clean.nutrients);
    });
    return get(existing.id);
  }

  function setArchived(id, archived) {
    const existing = get(id);
    statements.setArchived.run(archived ? 1 : 0, existing.id);
    return get(existing.id);
  }

  /** @returns {SetItem[]} in the user's order; archived supplements stay in until the user removes them */
  function getSet() {
    return statements.set.all().map((row) => ({
      supplementId: row.supplement_id,
      name: row.name,
      unitLabel: row.unit_label,
      units: row.units,
    }));
  }

  /**
   * Replaces the whole set. An archived supplement may stay if it was already
   * in the set, but cannot be newly added.
   * @param {Array<{supplementId: number, units: number}>} items
   * @returns {SetItem[]}
   */
  function putSet(items) {
    if (!Array.isArray(items) || items.length > MAX_SET_ITEMS) {
      throw new HttpError(400, `items must be a list of at most ${MAX_SET_ITEMS} supplements`);
    }
    const inSet = new Set(statements.set.all().map((row) => row.supplement_id));
    const seen = new Set();
    const clean = items.map((item, i) => {
      const supplementId = requireId(item?.supplementId, `items[${i}].supplementId`);
      // supplement_id is the set's primary key, so a repeat cannot be stored; say so instead of dropping it.
      if (seen.has(supplementId)) throw new HttpError(400, `items[${i}] repeats a supplement already in the set`);
      seen.add(supplementId);
      const supplement = statements.byId.get(supplementId);
      if (!supplement) throw new HttpError(400, `items[${i}] refers to an unknown supplement`);
      if (supplement.archived === 1 && !inSet.has(supplementId)) {
        throw new HttpError(400, `items[${i}] refers to a deleted supplement`);
      }
      return { supplementId, units: requireUnits(item?.units, `items[${i}].units`) };
    });
    transaction(db, () => {
      statements.clearSet.run();
      clean.forEach((item, position) => statements.insertSetItem.run(item.supplementId, item.units, position));
    });
    return getSet();
  }

  /**
   * @param {string} from first date, inclusive
   * @param {string} to last date, inclusive
   * @returns {SupplementEntry[]} ordered by date, then position
   */
  function entriesForRange(from, to) {
    return statements.range.all(from, to).map((row) => ({
      id: row.id,
      date: row.date,
      supplementId: row.supplement_id,
      name: row.name,
      brand: row.brand,
      unitLabel: row.unit_label,
      units: row.units,
      position: row.position,
    }));
  }

  const entriesFor = (date) => entriesForRange(date, date);

  function insertEntry(date, supplementId, units) {
    const { next } = statements.nextPosition.get(date);
    statements.insertEntry.run(date, supplementId, units, next);
  }

  function getEntryRow(id) {
    const row = statements.entryById.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Supplement entry not found');
    return row;
  }

  /** @returns {SupplementEntry[]} the day's entries */
  function addEntry(date, { supplementId, units } = {}) {
    const day = requireDate(date);
    const supplement = get(requireId(supplementId, 'supplementId'));
    if (supplement.archived) throw new HttpError(400, `${supplement.name} has been deleted and can't be added`);
    insertEntry(day, supplement.id, requireUnits(units));
    return entriesFor(day);
  }

  /** @returns {SupplementEntry[]} the day's entries */
  function updateEntry(id, { units } = {}) {
    const row = getEntryRow(id);
    statements.updateEntry.run(requireUnits(units), row.id);
    return entriesFor(row.date);
  }

  /** @returns {SupplementEntry[]} the day's entries */
  function removeEntry(id) {
    const row = getEntryRow(id);
    statements.removeEntry.run(row.id);
    return entriesFor(row.date);
  }

  /**
   * Appends the daily set to a day. Archived supplements in the set are
   * skipped, since they can't be newly added.
   * @returns {SupplementEntry[]} the day's entries
   */
  function addSet(date) {
    const day = requireDate(date);
    const items = statements.set.all().filter((row) => row.archived === 0);
    if (items.length === 0) throw new HttpError(400, 'Your daily supplements set is empty');
    transaction(db, () => {
      for (const item of items) insertEntry(day, item.supplement_id, item.units);
    });
    return entriesFor(day);
  }

  /**
   * Appends every entry of `fromDate` to `date`, archived supplements
   * included: a copy reflects what was taken.
   * @returns {SupplementEntry[]} the day's entries
   */
  function copyDay(date, { fromDate } = {}) {
    const day = requireDate(date);
    const source = requireDate(fromDate, 'fromDate');
    if (source === day) throw new HttpError(400, 'Pick a different day to copy from');
    const rows = statements.dayEntries.all(source);
    if (rows.length === 0) throw new HttpError(400, 'Nothing planned on that day');
    transaction(db, () => {
      for (const row of rows) insertEntry(day, row.supplement_id, row.units);
    });
    return entriesFor(day);
  }

  return {
    list,
    get,
    create,
    update,
    archive: (id) => setArchived(id, true),
    restore: (id) => setArchived(id, false),
    getSet,
    putSet,
    entriesForRange,
    addEntry,
    updateEntry,
    removeEntry,
    addSet,
    copyDay,
    nutrientsFor,
  };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createSupplementsRepo>} supplements
 */
export function registerSupplementRoutes(router, supplements) {
  router.add('GET', '/api/supplements', ({ query }) =>
    supplements.list({ includeArchived: query.get('archived') === '1' }),
  );
  router.add('POST', '/api/supplements', ({ body }) => supplements.create(body), { status: 201 });
  router.add('GET', '/api/supplements/:id', ({ params }) => supplements.get(params.id));
  router.add('PUT', '/api/supplements/:id', ({ params, body }) => supplements.update(params.id, body));
  router.add('DELETE', '/api/supplements/:id', ({ params }) => void supplements.archive(params.id), { status: 204 });
  router.add('POST', '/api/supplements/:id/restore', ({ params }) => supplements.restore(params.id));

  router.add('GET', '/api/supplement-set', () => supplements.getSet());
  router.add('PUT', '/api/supplement-set', ({ body }) => supplements.putSet(body?.items));

  router.add('POST', '/api/days/:date/supplements', ({ params, body }) => supplements.addEntry(params.date, body), {
    status: 201,
  });
  router.add('POST', '/api/days/:date/supplements/set', ({ params }) => supplements.addSet(params.date), {
    status: 201,
  });
  router.add('POST', '/api/days/:date/supplements/copy', ({ params, body }) => supplements.copyDay(params.date, body));
  router.add('PATCH', '/api/supplement-entries/:id', ({ params, body }) => supplements.updateEntry(params.id, body));
  router.add('DELETE', '/api/supplement-entries/:id', ({ params }) => supplements.removeEntry(params.id));
}
