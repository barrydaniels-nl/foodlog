/** Wires repositories and routes into a single request handler. */
import { fileURLToPath } from 'node:url';
import { createRouter } from './router.js';
import { HttpError, assertSameOrigin, sendJson, serveStatic } from './http.js';
import { createSettingsRepo, registerSettingsRoutes } from './settings.js';
import { createIngredientsRepo, registerIngredientRoutes } from './ingredients.js';
import { createFoodMicrosRepo, registerFoodMicroRoutes } from './food-micros.js';
import { registerOffRoutes } from './off.js';
import { createMealsRepo, registerMealRoutes } from './meals.js';
import { createDaysRepo, registerDayRoutes } from './days.js';
import { createSupplementsRepo, registerSupplementRoutes } from './supplements.js';
import { createMicrosService, registerMicrosRoutes } from './micros.js';
import { createMicroMatcher } from './micro-matcher.js';
import { createBackup } from './backup.js';
import { createReferenceRepo, registerReferenceRoutes } from './nevo.js';
import { registerAnalysisRoutes } from './analysis.js';
import { registerDietExportRoutes } from './diet-export.js';

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
 *   openAi?: {generateJson: (request: object) => Promise<any>}|null,
 *   today: () => string,
 *   now?: () => Date,
 *   auth?: ReturnType<import('./auth.js').createAuth>|null,
 *   publicDir: string,
 *   backupDir: string,
 *   startMatcher?: boolean,
 * }} deps
 * `startMatcher` runs the background micronutrient matcher; it needs `openAi`. Off by default so tests stay quiet.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp({
  db,
  offClient,
  openAi = null,
  today,
  now = () => new Date(),
  auth = null,
  publicDir,
  backupDir,
  startMatcher = false,
}) {
  const settings = createSettingsRepo(db, { today });
  const reference = createReferenceRepo(db);
  const foodMicros = createFoodMicrosRepo(db, { reference });
  const ingredients = createIngredientsRepo(db, { today, foodMicros });
  const meals = createMealsRepo(db);
  const days = createDaysRepo(db, { settings, ingredients, meals });
  const supplements = createSupplementsRepo(db);
  const micros = createMicrosService(db, { settings, foodMicros, supplements, today });
  if (startMatcher && openAi) createMicroMatcher({ db, openAi, reference, foodMicros }).start();

  const router = createRouter();
  router.add('GET', '/api/health', () => ({ ok: true }));
  registerSettingsRoutes(router, settings);
  registerIngredientRoutes(router, ingredients);
  registerMealRoutes(router, meals);
  registerDayRoutes(router, days);
  registerSupplementRoutes(router, supplements);
  registerReferenceRoutes(router, { reference, ingredients });
  registerFoodMicroRoutes(router, { foodMicros });
  registerMicrosRoutes(router, micros);
  createBackup(db, { settings, today, backupDir }).registerRoutes(router);
  if (offClient) registerOffRoutes(router, { offClient, settings });
  registerAnalysisRoutes(router, { openAi, days, ingredients, micros, supplements, today, now });
  registerDietExportRoutes(router, { days, micros, today });
  auth?.registerRoutes(router);

  return async function handleRequest(req, res) {
    try {
      assertSameOrigin(req);
      if (auth?.guard(req, res)) return;
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
