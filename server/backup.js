/** Whole-database JSON export and replace-all import. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEAL_SLOTS } from '../public/js/shared/constants.js';
import { isIsoDate } from '../public/js/shared/dates.js';
import { MICRO_KEYS, Origin } from '../public/js/shared/micronutrients.js';
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { FoodMicroStatus, MicroJob } from './food-micros.js';

const BACKUP_APP = 'foodlog';
const BACKUP_VERSION = 2;
/** Version 1 predates micronutrients and supplements; its files still import. */
const SUPPORTED_VERSIONS = [1, 2];
const BACKUP_ORIGINS = [Origin.LABEL, Origin.AI];
const MICRO_KEY_SET = new Set(MICRO_KEYS);
const IMPORT_BODY_LIMIT = 20_000_000;

const isText = (v) => typeof v === 'string' && v.length > 0;
const isNullableText = (v) => v === null || typeof v === 'string';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => Number.isInteger(v) && v > 0;
const isBoolean = (v) => typeof v === 'boolean';
// Optional so backups made before the field existed still import.
const isOptionalText = (v) => v === undefined || isNullableText(v);
const isAmount = (v) => isNumber(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
    referenceCode: isOptionalText,
    archived: isBoolean,
    portions: Array.isArray,
  },
  // Only version 2 files carry these; see validateBackup.
  micro: {
    twinCode: isNullableText,
    status: (v) => Object.values(FoodMicroStatus).includes(v),
    values: Array.isArray,
  },
  microValues: {
    nutrient: (v) => MICRO_KEY_SET.has(v),
    amount: isAmount,
    origin: (v) => BACKUP_ORIGINS.includes(v),
  },
  supplements: { id: isId, name: isText, brand: isNullableText, unitLabel: isText, archived: isBoolean, nutrients: isPlainObject },
  supplementSet: { supplementId: isId, units: isNumber },
  supplementEntries: { id: isId, date: isIsoDate, supplementId: isId, units: isNumber, position: Number.isInteger },
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

function checkRow(row, shape, path) {
  if (!row || typeof row !== 'object') throw new HttpError(400, `Invalid backup: ${path} is not an object`);
  for (const [field, isValid] of Object.entries(shape)) {
    if (!isValid(row[field])) throw new HttpError(400, `Invalid backup: ${path}.${field} is missing or invalid`);
  }
}

function checkRows(rows, shape, path) {
  rows.forEach((row, i) => checkRow(row, shape, `${path}[${i}]`));
}

/** Supplement amounts are keyed by nutrient, so each key and value is checked on its own. */
function checkSupplementNutrients(nutrients, path) {
  for (const [key, amount] of Object.entries(nutrients)) {
    if (!MICRO_KEY_SET.has(key)) throw new HttpError(400, `Invalid backup: ${path}.${key} is not a known nutrient`);
    if (!isAmount(amount)) throw new HttpError(400, `Invalid backup: ${path}.${key} is missing or invalid`);
  }
}

function checkMicros(ingredients) {
  ingredients.forEach((ingredient, i) => {
    const path = `ingredients[${i}].micro`;
    checkRow(ingredient.micro, ROW_SHAPES.micro, path);
    checkRows(ingredient.micro.values, ROW_SHAPES.microValues, `${path}.values`);
  });
}

function checkSupplements(backup) {
  checkRows(backup.supplements, ROW_SHAPES.supplements, 'supplements');
  backup.supplements.forEach((supplement, i) => checkSupplementNutrients(supplement.nutrients, `supplements[${i}].nutrients`));
  checkRows(backup.supplementSet, ROW_SHAPES.supplementSet, 'supplementSet');
  checkRows(backup.supplementEntries, ROW_SHAPES.supplementEntries, 'supplementEntries');

  const supplementIds = new Set(backup.supplements.map((supplement) => supplement.id));
  const references = [
    ...backup.supplementSet.map((item, i) => [item.supplementId, `supplementSet[${i}]`]),
    ...backup.supplementEntries.map((entry, i) => [entry.supplementId, `supplementEntries[${i}]`]),
  ];
  for (const [id, path] of references) {
    if (!supplementIds.has(id)) throw new HttpError(400, `Invalid backup: ${path} refers to a missing supplement`);
  }
}

/** Validates the whole file up front so a bad backup never deletes anything. */
function validateBackup(backup) {
  if (!backup || backup.app !== BACKUP_APP) throw new HttpError(400, 'This is not a Foodlog backup file');
  if (!SUPPORTED_VERSIONS.includes(backup.version)) throw new HttpError(400, `Unsupported backup version: ${backup.version}`);
  const isCurrent = backup.version === BACKUP_VERSION;
  const lists = ['ingredients', 'meals', 'entries', ...(isCurrent ? ['supplements', 'supplementSet', 'supplementEntries'] : [])];
  for (const key of lists) {
    if (!Array.isArray(backup[key])) throw new HttpError(400, `Invalid backup: ${key} must be a list`);
  }
  if (!backup.settings || typeof backup.settings !== 'object') throw new HttpError(400, 'Invalid backup: settings missing');

  checkRows(backup.ingredients, ROW_SHAPES.ingredients, 'ingredients');
  backup.ingredients.forEach((ing, i) => checkRows(ing.portions, ROW_SHAPES.portions, `ingredients[${i}].portions`));
  checkRows(backup.meals, ROW_SHAPES.meals, 'meals');
  backup.meals.forEach((meal, i) => checkRows(meal.items, ROW_SHAPES.items, `meals[${i}].items`));
  checkRows(backup.entries, ROW_SHAPES.entries, 'entries');
  if (isCurrent) {
    checkMicros(backup.ingredients);
    checkSupplements(backup);
  }

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
 * Version 1 files predate micronutrients and supplements, so those fields are
 * not validated there; dropping them means unchecked data is never imported.
 * @param {object} backup already validated
 * @returns {object} the backup with only the fields its version defines
 */
function fieldsOfVersion(backup) {
  if (backup.version === BACKUP_VERSION) return backup;
  return {
    ...backup,
    ingredients: backup.ingredients.map(({ micro: _micro, ...ingredient }) => ingredient),
    supplements: [],
    supplementSet: [],
    supplementEntries: [],
  };
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
    micros: db.prepare('SELECT ingredient_id, nutrient, amount, origin FROM ingredient_micros ORDER BY ingredient_id, nutrient, origin'),
    supplements: db.prepare('SELECT * FROM supplements ORDER BY id'),
    supplementNutrients: db.prepare('SELECT supplement_id, nutrient, amount FROM supplement_nutrients ORDER BY supplement_id, nutrient'),
    supplementSet: db.prepare('SELECT supplement_id, units FROM supplement_set ORDER BY position'),
    supplementEntries: db.prepare('SELECT * FROM supplement_entries ORDER BY id'),
  };
  const insert = {
    ingredient: db.prepare(
      `INSERT INTO ingredients (id, name, brand, barcode, kcal, protein, carbs, fat, fiber, source, reference_code, archived,
         micro_twin_code, micro_status, micro_job)
       VALUES (:id, :name, :brand, :barcode, :kcal, :protein, :carbs, :fat, :fiber, :source, :referenceCode, :archived,
         :twinCode, :status, :job)`,
    ),
    micro: db.prepare('INSERT INTO ingredient_micros (ingredient_id, nutrient, amount, origin) VALUES (?, ?, ?, ?)'),
    supplement: db.prepare('INSERT INTO supplements (id, name, brand, unit_label, archived) VALUES (?, ?, ?, ?, ?)'),
    supplementNutrient: db.prepare('INSERT INTO supplement_nutrients (supplement_id, nutrient, amount) VALUES (?, ?, ?)'),
    supplementSetItem: db.prepare('INSERT INTO supplement_set (supplement_id, units, position) VALUES (?, ?, ?)'),
    supplementEntry: db.prepare(
      'INSERT INTO supplement_entries (id, date, supplement_id, units, position) VALUES (:id, :date, :supplementId, :units, :position)',
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
    const micros = groupBy(select.micros.all(), 'ingredient_id');
    const supplementNutrients = groupBy(select.supplementNutrients.all(), 'supplement_id');
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
        referenceCode: row.reference_code,
        archived: row.archived === 1,
        portions: (portions.get(row.id) ?? []).map(({ label, grams }) => ({ label, grams })),
        micro: {
          twinCode: row.micro_twin_code,
          status: row.micro_status,
          values: (micros.get(row.id) ?? []).map(({ nutrient, amount, origin }) => ({ nutrient, amount, origin })),
        },
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
      supplements: select.supplements.all().map((row) => ({
        id: row.id,
        name: row.name,
        brand: row.brand,
        unitLabel: row.unit_label,
        archived: row.archived === 1,
        nutrients: Object.fromEntries(
          (supplementNutrients.get(row.id) ?? []).map(({ nutrient, amount }) => [nutrient, amount]),
        ),
      })),
      supplementSet: select.supplementSet.all().map((row) => ({ supplementId: row.supplement_id, units: row.units })),
      supplementEntries: select.supplementEntries.all().map((row) => ({
        id: row.id,
        date: row.date,
        supplementId: row.supplement_id,
        units: row.units,
        position: row.position,
      })),
    };
  }

  /**
   * Version 1 files have no matching state, so it is derived the way migration 3
   * does: a NEVO-linked food is its own confirmed twin, anything else waits for matching.
   * @param {{twinCode: string|null, status: string}|undefined} micro absent in version 1 files
   * @param {string|null|undefined} referenceCode
   * @returns {{twinCode: string|null, status: string, job: string|null}}
   */
  function microStateOf(micro, referenceCode) {
    const { twinCode, status } = micro ?? {
      twinCode: referenceCode ?? null,
      status: referenceCode ? FoodMicroStatus.CONFIRMED : FoodMicroStatus.PENDING,
    };
    if (status === FoodMicroStatus.PENDING) return { twinCode, status, job: MicroJob.MATCH };
    if (status === FoodMicroStatus.CONFIRMED && twinCode) return { twinCode, status, job: MicroJob.FILL };
    return { twinCode, status, job: null };
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

  /** @returns {{ingredients: number, meals: number, entries: number, supplements: number, supplementEntries: number, snapshot: string}} */
  function importAll(input) {
    validateBackup(input);
    const backup = fieldsOfVersion(input);
    const { supplements, supplementSet, supplementEntries } = backup;
    const snapshot = writeSnapshot();
    try {
      transaction(db, () => {
        // Children before parents; reference_foods and reference_micros are NEVO data, not part of a backup.
        db.exec(`DELETE FROM supplement_entries; DELETE FROM supplement_set; DELETE FROM supplement_nutrients; DELETE FROM supplements;
          DELETE FROM ingredient_micros; DELETE FROM entries; DELETE FROM meal_items; DELETE FROM meals; DELETE FROM portions;
          DELETE FROM ingredients; DELETE FROM settings;`);
        settings.update(backup.settings);
        for (const { portions, archived, micro, ...ingredient } of backup.ingredients) {
          const { twinCode, status, job } = microStateOf(micro, ingredient.referenceCode);
          insert.ingredient.run({ ...ingredient, referenceCode: ingredient.referenceCode ?? null, archived: archived ? 1 : 0, twinCode, status, job });
          for (const portion of portions) insert.portion.run(ingredient.id, portion.label, portion.grams);
          for (const value of micro?.values ?? []) insert.micro.run(ingredient.id, value.nutrient, value.amount, value.origin);
        }
        for (const supplement of supplements) {
          insert.supplement.run(supplement.id, supplement.name, supplement.brand, supplement.unitLabel, supplement.archived ? 1 : 0);
          for (const [nutrient, amount] of Object.entries(supplement.nutrients)) insert.supplementNutrient.run(supplement.id, nutrient, amount);
        }
        supplementSet.forEach((item, position) => insert.supplementSetItem.run(item.supplementId, item.units, position));
        for (const entry of supplementEntries) insert.supplementEntry.run(entry);
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
      supplements: supplements.length,
      supplementEntries: supplementEntries.length,
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
