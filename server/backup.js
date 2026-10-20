/** Whole-database JSON export and replace-all import. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEAL_SLOTS } from '../public/js/shared/constants.js';
import { isIsoDate } from '../public/js/shared/dates.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';

const BACKUP_APP = 'foodlog';
const BACKUP_VERSION = 1;
const IMPORT_BODY_LIMIT = 20_000_000;

const isText = (v) => typeof v === 'string' && v.length > 0;
const isNullableText = (v) => v === null || typeof v === 'string';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => Number.isInteger(v) && v > 0;
const isBoolean = (v) => typeof v === 'boolean';

const ROW_SHAPES = {
  ingredients: {
    id: isId,
    name: isText,
    brand: isNullableText,
    barcode: isNullableText,
    kcal: isNumber,
    protein: isNumber,
    carbs: isNumber,
    fat: isNumber,
    fiber: isNumber,
    source: isText,
    archived: isBoolean,
    portions: Array.isArray,
  },
  portions: { label: isText, grams: isNumber },
  meals: { id: isId, name: isText, items: Array.isArray },
  items: { ingredientId: isId, grams: isNumber },
  entries: {
    id: isId,
    date: isIsoDate,
    slot: (v) => MEAL_SLOTS.includes(v),
    ingredientId: isId,
    name: isText,
    brand: isNullableText,
    grams: isNumber,
    kcal: isNumber,
    protein: isNumber,
    carbs: isNumber,
    fat: isNumber,
    fiber: isNumber,
    position: Number.isInteger,
  },
};

function checkRows(rows, shape, path) {
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') throw new HttpError(400, `Invalid backup: ${path}[${i}] is not an object`);
    for (const [field, isValid] of Object.entries(shape)) {
      if (!isValid(row[field])) throw new HttpError(400, `Invalid backup: ${path}[${i}].${field} is missing or invalid`);
    }
  });
}

/** Validates the whole file up front so a bad backup never deletes anything. */
function validateBackup(backup) {
  if (!backup || backup.app !== BACKUP_APP) throw new HttpError(400, 'This is not a Foodlog backup file');
  if (backup.version !== BACKUP_VERSION) throw new HttpError(400, `Unsupported backup version: ${backup.version}`);
  for (const key of ['ingredients', 'meals', 'entries']) {
    if (!Array.isArray(backup[key])) throw new HttpError(400, `Invalid backup: ${key} must be a list`);
  }
  if (!backup.settings || typeof backup.settings !== 'object') throw new HttpError(400, 'Invalid backup: settings missing');

  checkRows(backup.ingredients, ROW_SHAPES.ingredients, 'ingredients');
  backup.ingredients.forEach((ing, i) => checkRows(ing.portions, ROW_SHAPES.portions, `ingredients[${i}].portions`));
  checkRows(backup.meals, ROW_SHAPES.meals, 'meals');
  backup.meals.forEach((meal, i) => checkRows(meal.items, ROW_SHAPES.items, `meals[${i}].items`));
  checkRows(backup.entries, ROW_SHAPES.entries, 'entries');

  const ingredientIds = new Set(backup.ingredients.map((ing) => ing.id));
  const references = [
    ...backup.meals.flatMap((meal, i) => meal.items.map((item, j) => [item.ingredientId, `meals[${i}].items[${j}]`])),
    ...backup.entries.map((entry, i) => [entry.ingredientId, `entries[${i}]`]),
  ];
  for (const [id, path] of references) {
    if (!ingredientIds.has(id)) throw new HttpError(400, `Invalid backup: ${path} refers to a missing ingredient`);
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   settings: {get: () => object, update: (patch: object) => object},
 *   today: () => string,
 *   backupDir: string,
 * }} deps `backupDir` receives a snapshot before every import
 */
export function createBackup(db, { settings, today, backupDir }) {
  const select = {
    ingredients: db.prepare('SELECT * FROM ingredients ORDER BY id'),
    portions: db.prepare('SELECT ingredient_id, label, grams FROM portions ORDER BY id'),
    meals: db.prepare('SELECT id, name FROM meals ORDER BY id'),
    items: db.prepare('SELECT meal_id, ingredient_id, grams FROM meal_items ORDER BY position, id'),
    entries: db.prepare('SELECT * FROM entries ORDER BY id'),
  };
  const insert = {
    ingredient: db.prepare(
      `INSERT INTO ingredients (id, name, brand, barcode, kcal, protein, carbs, fat, fiber, source, archived)
       VALUES (:id, :name, :brand, :barcode, :kcal, :protein, :carbs, :fat, :fiber, :source, :archived)`,
    ),
    portion: db.prepare('INSERT INTO portions (ingredient_id, label, grams) VALUES (?, ?, ?)'),
    meal: db.prepare('INSERT INTO meals (id, name) VALUES (?, ?)'),
    item: db.prepare('INSERT INTO meal_items (meal_id, ingredient_id, grams, position) VALUES (?, ?, ?, ?)'),
    entry: db.prepare(
      `INSERT INTO entries (id, date, slot, ingredient_id, name, brand, grams, kcal, protein, carbs, fat, fiber, position)
       VALUES (:id, :date, :slot, :ingredientId, :name, :brand, :grams, :kcal, :protein, :carbs, :fat, :fiber, :position)`,
    ),
  };

  function groupBy(rows, key) {
    const groups = new Map();
    for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
    return groups;
  }

  function exportAll() {
    const portions = groupBy(select.portions.all(), 'ingredient_id');
    const items = groupBy(select.items.all(), 'meal_id');
    return {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: settings.get(),
      ingredients: select.ingredients.all().map((row) => ({
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
        archived: row.archived === 1,
        portions: (portions.get(row.id) ?? []).map(({ label, grams }) => ({ label, grams })),
      })),
      meals: select.meals.all().map((row) => ({
        id: row.id,
        name: row.name,
        items: (items.get(row.id) ?? []).map((item) => ({ ingredientId: item.ingredient_id, grams: item.grams })),
      })),
      entries: select.entries.all().map((row) => ({
        id: row.id,
        date: row.date,
        slot: row.slot,
        ingredientId: row.ingredient_id,
        name: row.name,
        brand: row.brand,
        grams: row.grams,
        kcal: row.kcal,
        protein: row.protein,
        carbs: row.carbs,
        fat: row.fat,
        fiber: row.fiber,
        position: row.position,
      })),
    };
  }

  /**
   * Writes the current data to `backupDir` so an import can always be undone,
   * whatever the browser did with its own download.
   * @returns {string} the snapshot file name
   */
  function writeSnapshot() {
    mkdirSync(backupDir, { recursive: true });
    const name = `pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(path.join(backupDir, name), JSON.stringify(exportAll()));
    return name;
  }

  /** @returns {{ingredients: number, meals: number, entries: number, snapshot: string}} */
  function importAll(backup) {
    validateBackup(backup);
    const snapshot = writeSnapshot();
    try {
      transaction(db, () => {
        db.exec('DELETE FROM entries; DELETE FROM meal_items; DELETE FROM meals; DELETE FROM portions; DELETE FROM ingredients; DELETE FROM settings;');
        settings.update(backup.settings);
        for (const { portions, archived, ...ingredient } of backup.ingredients) {
          insert.ingredient.run({ ...ingredient, archived: archived ? 1 : 0 });
          for (const portion of portions) insert.portion.run(ingredient.id, portion.label, portion.grams);
        }
        for (const meal of backup.meals) {
          insert.meal.run(meal.id, meal.name);
          meal.items.forEach((item, position) => insert.item.run(meal.id, item.ingredientId, item.grams, position));
        }
        for (const entry of backup.entries) insert.entry.run(entry);
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Constraint errors (e.g. duplicate barcodes) mean the file is inconsistent.
      console.error('Backup import failed and was rolled back', error);
      throw new HttpError(400, `Invalid backup: ${error.message}`);
    }
    return {
      ingredients: backup.ingredients.length,
      meals: backup.meals.length,
      entries: backup.entries.length,
      snapshot,
    };
  }

  /**
   * @param {ReturnType<import('./router.js').createRouter>} router
   */
  function registerRoutes(router) {
    router.add(
      'GET',
      '/api/export',
      ({ res }) => {
        const payload = JSON.stringify(exportAll(), null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="foodlog-${today()}.json"`,
          'cache-control': 'no-store',
        });
        res.end(payload);
      },
      { raw: true },
    );
    router.add('POST', '/api/import', ({ body }) => importAll(body), { bodyLimit: IMPORT_BODY_LIMIT });
  }

  return { exportAll, importAll, registerRoutes };
}
