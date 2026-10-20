/** Saved (pre-configured) meals: named lists of ingredients with grams. */
import { roundNutrients, scaleNutrients, sumNutrients } from '../public/js/shared/nutrition.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { requireDate, requireId, requireNumber, requireSlot, requireString } from './validate.js';

const MAX_ITEMS = 50;

/**
 * @typedef {object} MealItem
 * @property {number} id
 * @property {number} ingredientId
 * @property {string} name
 * @property {string|null} brand
 * @property {number} grams
 * @property {boolean} archived
 * @property {Record<string, number>} per100
 * @property {Record<string, number>} nutrients rounded, from current ingredient values
 *
 * @typedef {object} Meal
 * @property {number} id
 * @property {string} name
 * @property {MealItem[]} items
 * @property {Record<string, number>} totals rounded
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createMealsRepo(db) {
  const statements = {
    all: db.prepare('SELECT id, name FROM meals ORDER BY name COLLATE NOCASE, id'),
    byId: db.prepare('SELECT id, name FROM meals WHERE id = ?'),
    items: db.prepare(
      `SELECT mi.id, mi.ingredient_id, mi.grams, i.name, i.brand, i.archived,
              i.kcal, i.protein, i.carbs, i.fat, i.fiber
       FROM meal_items mi JOIN ingredients i ON i.id = mi.ingredient_id
       WHERE mi.meal_id = ? ORDER BY mi.position, mi.id`,
    ),
    ingredient: db.prepare('SELECT id, archived FROM ingredients WHERE id = ?'),
    insert: db.prepare('INSERT INTO meals (name) VALUES (?)'),
    rename: db.prepare("UPDATE meals SET name = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteItems: db.prepare('DELETE FROM meal_items WHERE meal_id = ?'),
    insertItem: db.prepare('INSERT INTO meal_items (meal_id, ingredient_id, grams, position) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM meals WHERE id = ?'),
    slotEntries: db.prepare('SELECT ingredient_id, grams FROM entries WHERE date = ? AND slot = ? ORDER BY position, id'),
  };

  /** @returns {Meal} */
  function hydrate(row) {
    const items = statements.items.all(row.id).map((item) => {
      const per100 = { kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat, fiber: item.fiber };
      return {
        id: item.id,
        ingredientId: item.ingredient_id,
        name: item.name,
        brand: item.brand,
        grams: item.grams,
        archived: item.archived === 1,
        per100,
        nutrients: scaleNutrients(per100, item.grams),
      };
    });
    const totals = roundNutrients(sumNutrients(items.map((item) => item.nutrients)));
    for (const item of items) item.nutrients = roundNutrients(item.nutrients);
    return { id: row.id, name: row.name, items, totals };
  }

  /**
   * @param {object} input
   * @param {Set<number>} allowedArchived ingredient ids already in the meal
   */
  function validateInput(input, allowedArchived = new Set()) {
    const name = requireString(input?.name, 'name', { maxLength: 80 });
    const items = input?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      throw new HttpError(400, `A meal needs between 1 and ${MAX_ITEMS} ingredients`);
    }
    return {
      name,
      items: items.map((item, i) => {
        const ingredientId = requireId(item?.ingredientId, `items[${i}].ingredientId`);
        const ingredient = statements.ingredient.get(ingredientId);
        if (!ingredient) throw new HttpError(400, `items[${i}] refers to an unknown ingredient`);
        if (ingredient.archived === 1 && !allowedArchived.has(ingredientId)) {
          throw new HttpError(400, `items[${i}] refers to a deleted ingredient`);
        }
        return { ingredientId, grams: requireNumber(item?.grams, `items[${i}].grams`, { min: 0.1, max: 5000 }) };
      }),
    };
  }

  function writeItems(mealId, items) {
    statements.deleteItems.run(mealId);
    items.forEach((item, position) => statements.insertItem.run(mealId, item.ingredientId, item.grams, position));
  }

  /** @returns {Meal} */
  function get(id) {
    const row = statements.byId.get(requireId(id, 'id'));
    if (!row) throw new HttpError(404, 'Meal not found');
    return hydrate(row);
  }

  /** @returns {Meal} */
  function create(input) {
    const clean = validateInput(input);
    const id = transaction(db, () => {
      const { lastInsertRowid } = statements.insert.run(clean.name);
      writeItems(lastInsertRowid, clean.items);
      return Number(lastInsertRowid);
    });
    return get(id);
  }

  /** @returns {Meal} */
  function update(id, input) {
    const existing = get(id);
    const clean = validateInput(input, new Set(existing.items.map((item) => item.ingredientId)));
    transaction(db, () => {
      statements.rename.run(clean.name, existing.id);
      writeItems(existing.id, clean.items);
    });
    return get(existing.id);
  }

  function remove(id) {
    const existing = get(id);
    statements.remove.run(existing.id);
  }

  /** @returns {Meal} */
  function createFromSlot({ date, slot, name } = {}) {
    const entries = statements.slotEntries.all(requireDate(date), requireSlot(slot));
    if (entries.length === 0) throw new HttpError(400, 'Nothing to save in this meal');
    const ingredientIds = new Set(entries.map((entry) => entry.ingredient_id));
    const clean = validateInput(
      { name, items: entries.map((entry) => ({ ingredientId: entry.ingredient_id, grams: entry.grams })) },
      ingredientIds,
    );
    const id = transaction(db, () => {
      const { lastInsertRowid } = statements.insert.run(clean.name);
      writeItems(lastInsertRowid, clean.items);
      return Number(lastInsertRowid);
    });
    return get(id);
  }

  return { list: () => statements.all.all().map(hydrate), get, create, update, remove, createFromSlot };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createMealsRepo>} meals
 */
export function registerMealRoutes(router, meals) {
  router.add('GET', '/api/meals', () => meals.list());
  router.add('POST', '/api/meals', ({ body }) => meals.create(body), { status: 201 });
  router.add('POST', '/api/meals/from-slot', ({ body }) => meals.createFromSlot(body), { status: 201 });
  router.add('GET', '/api/meals/:id', ({ params }) => meals.get(params.id));
  router.add('PUT', '/api/meals/:id', ({ params, body }) => meals.update(params.id, body));
  router.add('DELETE', '/api/meals/:id', ({ params }) => void meals.remove(params.id), { status: 204 });
}
