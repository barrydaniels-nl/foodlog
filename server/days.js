/** Planned days: entries per meal slot, saved-meal insertion and copy-day. */
import { MEAL_SLOTS, NUTRIENT_KEYS } from '../public/js/shared/constants.js';
import { roundNutrients, scaleNutrients, sumNutrients } from '../public/js/shared/nutrition.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { requireDate, requireId, requireNumber, requireSlot } from './validate.js';

/**
 * @typedef {object} Entry
 * @property {number} id
 * @property {string} date
 * @property {string} slot
 * @property {number} ingredientId
 * @property {string} name
 * @property {string|null} brand
 * @property {number} grams
 * @property {Record<string, number>} per100 snapshot taken when planned
 * @property {Record<string, number>} nutrients rounded
 *
 * @typedef {object} Day
 * @property {string} date
 * @property {Record<string, {entries: Entry[], totals: Record<string, number>}>} slots every slot present
 * @property {Record<string, number>} totals rounded
 * @property {{kcal: number, protein: number}} targets
 */

const requireGrams = (value) => requireNumber(value, 'grams', { min: 0.1, max: 5000 });

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   settings: {get: () => {kcalTarget: number, proteinTarget: number}},
 *   ingredients: {get: (id: unknown) => {id: number, name: string, brand: string|null}},
 *   meals: {get: (id: unknown) => {items: Array<{ingredientId: number, grams: number}>}},
 * }} deps
 */
export function createDaysRepo(db, { settings, ingredients, meals }) {
  const statements = {
    forDate: db.prepare('SELECT * FROM entries WHERE date = ? ORDER BY position, id'),
    byId: db.prepare('SELECT * FROM entries WHERE id = ?'),
    nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM entries WHERE date = ? AND slot = ?'),
    insert: db.prepare(
      `INSERT INTO entries (date, slot, ingredient_id, name, brand, grams, kcal, protein, carbs, fat, fiber, position)
       VALUES (:date, :slot, :ingredientId, :name, :brand, :grams, :kcal, :protein, :carbs, :fat, :fiber, :position)`,
    ),
    update: db.prepare('UPDATE entries SET grams = ?, slot = ?, position = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM entries WHERE id = ?'),
  };

  /** @returns {Entry} */
  function toEntry(row) {
    const per100 = Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, row[key]]));
    return {
      id: row.id,
      date: row.date,
      slot: row.slot,
      ingredientId: row.ingredient_id,
      name: row.name,
      brand: row.brand,
      grams: row.grams,
      per100,
      nutrients: scaleNutrients(per100, row.grams),
    };
  }

  /** @returns {Day} */
  function getDay(date) {
    const entries = statements.forDate.all(requireDate(date)).map(toEntry);
    const slots = {};
    for (const slot of MEAL_SLOTS) {
      const inSlot = entries.filter((entry) => entry.slot === slot);
      slots[slot] = { entries: inSlot, totals: roundNutrients(sumNutrients(inSlot.map((e) => e.nutrients))) };
    }
    const totals = roundNutrients(sumNutrients(entries.map((e) => e.nutrients)));
    for (const entry of entries) entry.nutrients = roundNutrients(entry.nutrients);
    const { kcalTarget, proteinTarget } = settings.get();
    return { date, slots, totals, targets: { kcal: kcalTarget, protein: proteinTarget } };
  }

  /** Snapshots the ingredient's current values into a new entry. */
  function insertEntry(date, slot, ingredientId, grams) {
    const ingredient = ingredients.get(ingredientId);
    const { next } = statements.nextPosition.get(date, slot);
    statements.insert.run({
      date,
      slot,
      ingredientId: ingredient.id,
      name: ingredient.name,
      brand: ingredient.brand,
      grams,
      ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, ingredient[key]])),
      position: next,
    });
  }

  function getEntryRow(id) {
    const row = statements.byId.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Entry not found');
    return row;
  }

  /** @returns {Day} */
  function addEntry(date, { slot, ingredientId, grams } = {}) {
    const day = requireDate(date);
    insertEntry(day, requireSlot(slot), ingredientId, requireGrams(grams));
    return getDay(day);
  }

  /** @returns {Day} */
  function updateEntry(id, { grams, slot } = {}) {
    const row = getEntryRow(id);
    const newSlot = slot === undefined ? row.slot : requireSlot(slot);
    const newGrams = grams === undefined ? row.grams : requireGrams(grams);
    const position = newSlot === row.slot ? row.position : statements.nextPosition.get(row.date, newSlot).next;
    statements.update.run(newGrams, newSlot, position, row.id);
    return getDay(row.date);
  }

  /** @returns {Day} */
  function removeEntry(id) {
    const row = getEntryRow(id);
    statements.remove.run(row.id);
    return getDay(row.date);
  }

  /** @returns {Day} */
  function addMeal(date, { slot, mealId, scale = 1 } = {}) {
    const day = requireDate(date);
    const targetSlot = requireSlot(slot);
    const factor = requireNumber(scale, 'scale', { min: 0.25, max: 10 });
    const meal = meals.get(mealId);
    transaction(db, () => {
      for (const item of meal.items) insertEntry(day, targetSlot, item.ingredientId, item.grams * factor);
    });
    return getDay(day);
  }

  /**
   * Appends every entry of `fromDate` to `date`, re-snapshotting current
   * ingredient values because a copied plan is a new plan.
   * @returns {Day}
   */
  function copyDay(date, { fromDate } = {}) {
    const day = requireDate(date);
    const source = requireDate(fromDate, 'fromDate');
    if (source === day) throw new HttpError(400, 'Pick a different day to copy from');
    const rows = statements.forDate.all(source);
    if (rows.length === 0) throw new HttpError(400, 'Nothing planned on that day');
    transaction(db, () => {
      for (const row of rows) insertEntry(day, row.slot, row.ingredient_id, row.grams);
    });
    return getDay(day);
  }

  return { getDay, addEntry, updateEntry, removeEntry, addMeal, copyDay };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createDaysRepo>} days
 */
export function registerDayRoutes(router, days) {
  router.add('GET', '/api/days/:date', ({ params }) => days.getDay(params.date));
  router.add('POST', '/api/days/:date/entries', ({ params, body }) => days.addEntry(params.date, body), { status: 201 });
  router.add('POST', '/api/days/:date/meals', ({ params, body }) => days.addMeal(params.date, body), { status: 201 });
  router.add('POST', '/api/days/:date/copy', ({ params, body }) => days.copyDay(params.date, body));
  router.add('PATCH', '/api/entries/:id', ({ params, body }) => days.updateEntry(params.id, body));
  router.add('DELETE', '/api/entries/:id', ({ params }) => days.removeEntry(params.id));
}
