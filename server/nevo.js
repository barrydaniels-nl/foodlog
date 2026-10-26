/**
 * NEVO (Dutch food composition table, RIVM) as a read-only reference source.
 * The user uploads the dataset file once; foods are copied into the personal
 * ingredient list when picked, with their values unchanged as the NEVO terms
 * require.
 */
import { HttpError } from './http.js';
import { transaction } from './db.js';
import { MICRONUTRIENTS, NEVO_RETINOL_COLUMN, RETINOL_KEY } from '../public/js/shared/micronutrients.js';
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

/**
 * Every NEVO header the micronutrient definitions read, found by running each
 * definition against a lookup that records what it asks for. This keeps the
 * definitions the only place that names NEVO columns.
 */
const MICRO_COLUMNS = (() => {
  const asked = new Set([NEVO_RETINOL_COLUMN]);
  for (const micro of MICRONUTRIENTS) {
    micro.fromNevo((column) => {
      asked.add(column);
      return null;
    });
  }
  return [...asked];
})();
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

/** A blank or unreadable cell is "unknown", never 0. */
function toKnownNumber(raw) {
  const value = toNumber(raw ?? '');
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * @param {string[]} fields one parsed row
 * @param {Map<string, number>} microIndex header → column position, for the micronutrient columns present
 * @returns {Record<string, number>} only the known values, including retinol
 */
function readMicros(fields, microIndex) {
  const lookup = (column) => (microIndex.has(column) ? toKnownNumber(fields[microIndex.get(column)]) : null);
  const micros = {};
  for (const { key, fromNevo } of MICRONUTRIENTS) {
    const amount = fromNevo(lookup);
    if (amount !== null) micros[key] = amount;
  }
  const retinol = lookup(NEVO_RETINOL_COLUMN);
  if (retinol !== null) micros[RETINOL_KEY] = retinol;
  return micros;
}

/** Escapes LIKE wildcards so a search term is matched literally. */
function likeTerm(term) {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** "NEVO-Online 2025 9.0" → "2025/9.0" (the form RIVM's citation uses). */
function formatVersion(raw) {
  const match = /(\d{4})\D+(\d+(?:\.\d+)?)/.exec(raw ?? '');
  return match ? `${match[1]}/${match[2]}` : raw?.trim() || 'unknown';
}

/**
 * @param {number} code NEVO-code
 * @returns {string} how ingredients point at a NEVO food, e.g. 'nevo:83'
 */
export function nevoReferenceCode(code) {
  return `${SOURCE}:${code}`;
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
 *   carbs: number, fat: number, fiber: number, micros: Record<string, number>}>, hasMicros: boolean}}
 * `hasMicros` is true when the file has at least one micronutrient column.
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
  // The micronutrient columns are optional: an older export still imports without them.
  const microIndex = new Map(MICRO_COLUMNS.filter((name) => header.includes(name)).map((name) => [name, header.indexOf(name)]));

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
      micros: readMicros(fields, microIndex),
    };
    const broken =
      !Number.isInteger(food.code) ||
      !food.name ||
      REQUIRED_NUTRIENTS.some((key) => food[key] === null || !Number.isFinite(food[key]));
    if (broken) throw new HttpError(400, `NEVO file has an unreadable row (line ${row + 2})`);
    return food;
  });
  return { version: formatVersion(splitLine(lines[1])[index.version]), foods, hasMicros: microIndex.size > 0 };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createReferenceRepo(db) {
  function prepareSearch(excludeAdopted) {
    return db.prepare(
      `SELECT r.* FROM reference_foods r
       WHERE r.source = :source
         AND (r.name LIKE :pattern ESCAPE '\\' OR r.name_en LIKE :pattern ESCAPE '\\' OR r.synonym LIKE :pattern ESCAPE '\\')
         ${
           excludeAdopted
             ? `AND NOT EXISTS (
           SELECT 1 FROM ingredients i WHERE i.reference_code = r.source || ':' || r.code AND i.archived = 0
         )`
             : ''
         }
       ORDER BY (r.name LIKE :prefix ESCAPE '\\') DESC, length(r.name), r.name COLLATE NOCASE
       LIMIT ${SEARCH_LIMIT}`,
    );
  }

  const statements = {
    clear: db.prepare('DELETE FROM reference_foods WHERE source = ?'),
    insertMicro: db.prepare('INSERT INTO reference_micros (source, code, nutrient, amount) VALUES (?, ?, ?, ?)'),
    micros: db.prepare('SELECT nutrient, amount FROM reference_micros WHERE source = ? AND code = ?'),
    insert: db.prepare(
      `INSERT INTO reference_foods (source, code, name, name_en, synonym, food_group, per, kcal, protein, carbs, fat, fiber)
       VALUES (:source, :code, :name, :nameEn, :synonym, :group, :per, :kcal, :protein, :carbs, :fat, :fiber)`,
    ),
    saveSource: db.prepare(
      `INSERT INTO reference_sources (source, version, count, imported_at, has_micros) VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(source) DO UPDATE SET version = excluded.version, count = excluded.count,
         imported_at = excluded.imported_at, has_micros = excluded.has_micros`,
    ),
    source: db.prepare('SELECT version, count, imported_at, has_micros FROM reference_sources WHERE source = ?'),
    get: db.prepare('SELECT * FROM reference_foods WHERE source = ? AND code = ?'),
    // The default search leaves out foods already in the personal list; that list shows them.
    search: prepareSearch(true),
    searchAll: prepareSearch(false),
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

  /** @returns {{version: string, count: number, importedAt: string, credit: string, hasMicros: boolean}|null} */
  function status() {
    const row = statements.source.get(SOURCE);
    return row
      ? {
          version: row.version,
          count: row.count,
          importedAt: row.imported_at,
          credit: nevoCredit(row.version),
          hasMicros: row.has_micros === 1,
        }
      : null;
  }

  /** @returns {boolean} whether the imported NEVO file carried micronutrient columns */
  function hasMicros() {
    return status()?.hasMicros ?? false;
  }

  /** Replaces the stored NEVO dataset with the uploaded file. */
  function importNevo(text) {
    const { version, foods, hasMicros: withMicros } = parseNevoCsv(text);
    transaction(db, () => {
      statements.clear.run(SOURCE);
      for (const { micros, ...food } of foods) {
        statements.insert.run({ source: SOURCE, ...food });
        for (const [nutrient, amount] of Object.entries(micros)) statements.insertMicro.run(SOURCE, food.code, nutrient, amount);
      }
      statements.saveSource.run(SOURCE, version, foods.length, withMicros ? 1 : 0);
    });
    return status();
  }

  /**
   * @param {string} query
   * @param {{all?: boolean}} [options] `all` also returns foods already in the personal list
   */
  function search(query, { all = false } = {}) {
    const term = likeTerm(query.trim());
    if (!term) return [];
    const statement = all ? statements.searchAll : statements.search;
    return statement.all({ source: SOURCE, pattern: `%${term}%`, prefix: `${term}%` }).map(toFood);
  }

  /**
   * Foods whose name, English name or synonym contains any of the terms,
   * whether or not they are already in the personal list.
   * @param {string[]} terms
   * @param {number} limit
   * @returns {Array<{code: number, name: string, nameEn: string|null, group: string|null,
   *   kcal: number, protein: number, carbs: number, fat: number}>}
   */
  function searchCandidates(terms, limit) {
    const likes = terms.map((term) => term.trim()).filter(Boolean).map((term) => `%${likeTerm(term)}%`);
    if (likes.length === 0) return [];
    const params = Object.fromEntries(likes.map((pattern, i) => [`p${i}`, pattern]));
    const matches = likes
      .map((_, i) => `r.name LIKE :p${i} ESCAPE '\\' OR r.name_en LIKE :p${i} ESCAPE '\\' OR r.synonym LIKE :p${i} ESCAPE '\\'`)
      .join(' OR ');
    const rows = db
      .prepare(
        `SELECT r.code, r.name, r.name_en, r.food_group, r.kcal, r.protein, r.carbs, r.fat FROM reference_foods r
         WHERE r.source = :source AND (${matches})
         ORDER BY length(r.name), r.name COLLATE NOCASE
         LIMIT :limit`,
      )
      .all({ source: SOURCE, limit, ...params });
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      nameEn: row.name_en,
      group: row.food_group,
      kcal: row.kcal,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
    }));
  }

  /** @returns {Record<string, number>} the known micronutrient values of one NEVO food, per 100 g/ml */
  function getMicros(code) {
    return Object.fromEntries(statements.micros.all(SOURCE, requireId(code, 'code')).map((row) => [row.nutrient, row.amount]));
  }

  function get(code) {
    const row = statements.get.get(SOURCE, requireId(code, 'code'));
    if (!row) throw new HttpError(404, 'Food not found in NEVO');
    return toFood(row);
  }

  return { status, hasMicros, importNevo, search, searchCandidates, get, getMicros };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{reference: ReturnType<typeof createReferenceRepo>, ingredients: object}} deps
 */
export function registerReferenceRoutes(router, { reference, ingredients }) {
  router.add('GET', '/api/reference/status', () => ({ nevo: reference.status() }));
  router.add('GET', '/api/reference/search', ({ query }) => reference.search(query.get('q') ?? '', { all: query.get('all') === '1' }));
  router.add('POST', '/api/reference/nevo', ({ body }) => reference.importNevo(requireString(body?.csv, 'csv', { maxLength: UPLOAD_LIMIT })), {
    bodyLimit: UPLOAD_LIMIT,
  });
  // Copies a NEVO food into your foods (or returns the copy you already have).
  // The copy is created as its own confirmed micronutrient twin (see createIngredientsRepo).
  router.add('POST', '/api/reference/nevo/:code/adopt', ({ params }) => {
    const food = reference.get(params.code);
    const referenceCode = nevoReferenceCode(food.code);
    const existing = ingredients.findByReference(referenceCode);
    if (existing) return existing.archived ? ingredients.restore(existing.id) : existing;
    const { name, kcal, protein, carbs, fat, fiber } = food;
    return ingredients.create(
      { name: name.slice(0, 120), kcal, protein, carbs, fat, fiber, source: SOURCE, portions: [] },
      { referenceCode },
    );
  });
}
