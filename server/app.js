/** Wires repositories and routes into a single request handler. */
import { fileURLToPath } from 'node:url';
import { createRouter } from './router.js';
import { HttpError, assertSameOrigin, sendJson, serveStatic } from './http.js';
import { createSettingsRepo, registerSettingsRoutes } from './settings.js';
import { createIngredientsRepo, registerIngredientRoutes } from './ingredients.js';
import { registerOffRoutes } from './off.js';
import { createMealsRepo, registerMealRoutes } from './meals.js';
import { createDaysRepo, registerDayRoutes } from './days.js';
import { createBackup } from './backup.js';
import { createReferenceRepo, registerReferenceRoutes } from './nevo.js';

const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

/** Barcode-scanner files served from node_modules so the app never needs a CDN. */
const VENDOR_MOUNTS = {
  '/vendor/barcode-detector.js': `${NODE_MODULES}barcode-detector/dist/iife/ponyfill.js`,
  '/vendor/zxing_reader.wasm': `${NODE_MODULES}zxing-wasm/dist/reader/zxing_reader.wasm`,
};

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   offClient: object|null,
 *   today: () => string,
 *   publicDir: string,
 *   backupDir: string,
 * }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp({ db, offClient, today, publicDir, backupDir }) {
  const settings = createSettingsRepo(db);
  const ingredients = createIngredientsRepo(db, { today });
  const meals = createMealsRepo(db);
  const days = createDaysRepo(db, { settings, ingredients, meals });

  const router = createRouter();
  router.add('GET', '/api/health', () => ({ ok: true }));
  registerSettingsRoutes(router, settings);
  registerIngredientRoutes(router, ingredients);
  registerMealRoutes(router, meals);
  registerDayRoutes(router, days);
  registerReferenceRoutes(router, { reference: createReferenceRepo(db), ingredients });
  createBackup(db, { settings, today, backupDir }).registerRoutes(router);
  if (offClient) registerOffRoutes(router, { offClient, settings });

  return async function handleRequest(req, res) {
    try {
      assertSameOrigin(req);
      if (await router.handle(req, res)) return;
      if (req.url.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (await serveStatic(req, res, { root: publicDir, mounts: VENDOR_MOUNTS })) return;
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (res.headersSent) {
        console.error(`${req.method} ${req.url} failed after response started`, error);
        res.destroy(error);
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, ...error.extra });
        return;
      }
      console.error(`${req.method} ${req.url} failed`, error);
      sendJson(res, 500, { error: 'Something went wrong' });
    }
  };
}
