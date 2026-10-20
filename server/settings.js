/** User settings: daily targets and the Open Food Facts search region. */
import { DEFAULT_SETTINGS, OFF_COUNTRIES, OFF_WORLD } from '../public/js/shared/constants.js';
import { HttpError } from './http.js';
import { requireNumber } from './validate.js';

function validatePatch(patch) {
  const clean = {};
  if (patch.kcalTarget !== undefined) {
    clean.kcalTarget = Math.round(requireNumber(patch.kcalTarget, 'kcalTarget', { min: 500, max: 10000 }));
  }
  if (patch.proteinTarget !== undefined) {
    clean.proteinTarget = Math.round(requireNumber(patch.proteinTarget, 'proteinTarget', { min: 0, max: 500 }));
  }
  if (patch.offCountry !== undefined) {
    if (patch.offCountry !== OFF_WORLD && !Object.hasOwn(OFF_COUNTRIES, patch.offCountry)) {
      throw new HttpError(400, `offCountry must be one of: ${[...Object.keys(OFF_COUNTRIES), OFF_WORLD].join(', ')}`);
    }
    clean.offCountry = patch.offCountry;
  }
  return clean;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSettingsRepo(db) {
  const selectAll = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  /** @returns {{kcalTarget: number, proteinTarget: number, offCountry: string}} */
  function get() {
    const stored = Object.fromEntries(selectAll.all().map((row) => [row.key, JSON.parse(row.value)]));
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in stored) settings[key] = stored[key];
    }
    return settings;
  }

  function update(patch) {
    const clean = validatePatch(patch ?? {});
    for (const [key, value] of Object.entries(clean)) upsert.run(key, JSON.stringify(value));
    return get();
  }

  return { get, update };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createSettingsRepo>} settings
 */
export function registerSettingsRoutes(router, settings) {
  router.add('GET', '/api/settings', () => settings.get());
  router.add('PUT', '/api/settings', ({ body }) => settings.update(body));
}
