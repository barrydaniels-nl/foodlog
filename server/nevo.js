/**
 * NEVO (Dutch food composition table, RIVM) as a read-only reference source.
 * The user uploads the dataset file once; foods are copied into the personal
 * ingredient list when picked, with their values unchanged as the NEVO terms
 * require.
 */
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { requireId, requireString } from './validate.js';

const SOURCE = 'nevo';
const UPLOAD_LIMIT = 10_000_000;
const SEARCH_LIMIT = 15;

/** Header → field, for the columns we use (names as in NEVO2025_v9.0.csv). */
const COLUMNS = {
  version: 'NEVO-versie/NEVO-version',
  group: 'Food group',
  code: 'NEVO-code',
  name: 'Voedingsmiddelnaam/Dutch food name',
  nameEn: 'Engelse naam/Food name',
  synonym: 'Synoniem',
  quantity: 'Hoeveelheid/Quantity',
  kcal: 'ENERCC (kcal)',
  protein: 'PROT (g)',
  carbs: 'CHO (g)',
  fat: 'FAT (g)',
  fiber: 'FIBT (g)',
};
const REQUIRED_NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'];
const NOT_NEVO = 'This is not the NEVO dataset. Upload the file named like NEVO2025_v9.0.csv.';

/** Splits one pipe-delimited line, honouring "quoted" fields and "" escapes. */
function splitLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === '|') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function toNumber(raw) {
  const text = raw.trim().replace(',', '.');
  return text === '' ? null : Number(text);
}

/** "NEVO-Online 2025 9.0" → "2025/9.0" (the form RIVM's citation uses). */
function formatVersion(raw) {
  const match = /(\d{4})\D+(\d+(?:\.\d+)?)/.exec(raw ?? '');
  return match ? `${match[1]}/${match[2]}` : raw?.trim() || 'unknown';
}

/**
 * @param {string} version e.g. "2025/9.0"
 * @returns {string} the reference RIVM requires on nutritional output
 */
export function nevoCredit(version) {
  return `Based on data from NEVO online version ${version}, RIVM, Bilthoven and other data sources`;
}

/**
 * @param {string} text contents of NEVO20xx_vX.csv
 * @returns {{version: string, foods: Array<{code: number, name: string, nameEn: string|null,
 *   synonym: string|null, group: string|null, per: '100g'|'100ml', kcal: number, protein: number,
 *   carbs: number, fat: number, fiber: number}>}}
 */
export function parseNevoCsv(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new HttpError(400, NOT_NEVO);

  const header = splitLine(lines[0]).map((name) => name.trim());
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, name]) => [key, header.indexOf(name)]));
  if (Object.values(index).some((i) => i === -1)) throw new HttpError(400, NOT_NEVO);

  const foods = lines.slice(1).map((line, row) => {
    const fields = splitLine(line);
    const text = (key) => fields[index[key]]?.trim() || null;
    const food = {
      code: Number(text('code')),
      name: text('name'),
      nameEn: text('nameEn'),
      synonym: text('synonym'),
      group: text('group'),
      per: text('quantity')?.includes('ml') ? '100ml' : '100g',
      kcal: toNumber(fields[index.kcal] ?? ''),
      protein: toNumber(fields[index.protein] ?? ''),
      carbs: toNumber(fields[index.carbs] ?? ''),
      fat: toNumber(fields[index.fat] ?? ''),
      fiber: toNumber(fields[index.fiber] ?? '') ?? 0,
    };
    const broken =
      !Number.isInteger(food.code) ||
      !food.name ||
      REQUIRED_NUTRIENTS.some((key) => food[key] === null || !Number.isFinite(food[key]));
    if (broken) throw new HttpError(400, `NEVO file has an unreadable row (line ${row + 2})`);
    return food;
  });
  return { version: formatVersion(splitLine(lines[1])[index.version]), foods };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createReferenceRepo(db) {
  const statements = {
    clear: db.prepare('DELETE FROM reference_foods WHERE source = ?'),
    insert: db.prepare(
      `INSERT INTO reference_foods (source, code, name, name_en, synonym, food_group, per, kcal, protein, carbs, fat, fiber)
       VALUES (:source, :code, :name, :nameEn, :synonym, :group, :per, :kcal, :protein, :carbs, :fat, :fiber)`,
    ),
    saveSource: db.prepare(
      `INSERT INTO reference_sources (source, version, count, imported_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(source) DO UPDATE SET version = excluded.version, count = excluded.count, imported_at = excluded.imported_at`,
    ),
    source: db.prepare('SELECT version, count, imported_at FROM reference_sources WHERE source = ?'),
    get: db.prepare('SELECT * FROM reference_foods WHERE source = ? AND code = ?'),
    // Foods already in the personal list are left out; that list shows them.
    search: db.prepare(
      `SELECT r.* FROM reference_foods r
       WHERE r.source = :source
         AND (r.name LIKE :pattern ESCAPE '\\' OR r.name_en LIKE :pattern ESCAPE '\\' OR r.synonym LIKE :pattern ESCAPE '\\')
         AND NOT EXISTS (
           SELECT 1 FROM ingredients i WHERE i.reference_code = r.source || ':' || r.code AND i.archived = 0
         )
       ORDER BY (r.name LIKE :prefix ESCAPE '\\') DESC, length(r.name), r.name COLLATE NOCASE
       LIMIT ${SEARCH_LIMIT}`,
    ),
  };

  function toFood(row) {
    return {
      source: row.source,
      code: row.code,
      name: row.name,
      nameEn: row.name_en,
      synonym: row.synonym,
      group: row.food_group,
      per: row.per,
      kcal: row.kcal,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      fiber: row.fiber,
    };
  }

  /** @returns {{version: string, count: number, importedAt: string, credit: string}|null} */
  function status() {
    const row = statements.source.get(SOURCE);
    return row ? { version: row.version, count: row.count, importedAt: row.imported_at, credit: nevoCredit(row.version) } : null;
  }

  /** Replaces the stored NEVO dataset with the uploaded file. */
  function importNevo(text) {
    const { version, foods } = parseNevoCsv(text);
    transaction(db, () => {
      statements.clear.run(SOURCE);
      for (const food of foods) statements.insert.run({ source: SOURCE, ...food });
      statements.saveSource.run(SOURCE, version, foods.length);
    });
    return status();
  }

  function search(query) {
    const term = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
    if (!term) return [];
    return statements.search.all({ source: SOURCE, pattern: `%${term}%`, prefix: `${term}%` }).map(toFood);
  }

  function get(code) {
    const row = statements.get.get(SOURCE, requireId(code, 'code'));
    if (!row) throw new HttpError(404, 'Food not found in NEVO');
    return toFood(row);
  }

  return { status, importNevo, search, get };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{reference: ReturnType<typeof createReferenceRepo>, ingredients: object}} deps
 */
export function registerReferenceRoutes(router, { reference, ingredients }) {
  router.add('GET', '/api/reference/status', () => ({ nevo: reference.status() }));
  router.add('GET', '/api/reference/search', ({ query }) => reference.search(query.get('q') ?? ''));
  router.add('POST', '/api/reference/nevo', ({ body }) => reference.importNevo(requireString(body?.csv, 'csv', { maxLength: UPLOAD_LIMIT })), {
    bodyLimit: UPLOAD_LIMIT,
  });
  // Copies a NEVO food into your foods (or returns the copy you already have).
  router.add('POST', '/api/reference/nevo/:code/adopt', ({ params }) => {
    const food = reference.get(params.code);
    const referenceCode = `${SOURCE}:${food.code}`;
    const existing = ingredients.findByReference(referenceCode);
    if (existing) return existing.archived ? ingredients.restore(existing.id) : existing;
    const { name, kcal, protein, carbs, fat, fiber } = food;
    return ingredients.create(
      { name: name.slice(0, 120), kcal, protein, carbs, fat, fiber, source: SOURCE, portions: [] },
      { referenceCode },
    );
  });
}
