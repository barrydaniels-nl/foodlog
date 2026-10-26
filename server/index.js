/** Process entry point: reads env, opens the database and starts listening. */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createOffClient } from './off.js';
import { DEFAULT_MODEL, createOpenAiClient } from './openai.js';
import { toIsoDate } from '../public/js/shared/dates.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? path.join(rootDir, 'data', 'foodlog.db');

mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

const apiKey = process.env.OPENAI_API_KEY;
const openAi = apiKey ? createOpenAiClient({ apiKey, model: process.env.OPENAI_MODEL || DEFAULT_MODEL }) : null;

const password = process.env.APP_PASSWORD;
const auth = password ? createAuth({ password, dietToken: process.env.DIET_TOKEN || null }) : null;

const app = createApp({
  db,
  offClient: createOffClient(),
  openAi,
  auth,
  startMatcher: true,
  today: () => toIsoDate(new Date()),
  publicDir: path.join(rootDir, 'public'),
  backupDir: path.join(path.dirname(dbPath), 'backups'),
});

const server = createServer(app);
server.listen(port, () => {
  console.log(`Foodlog listening on http://0.0.0.0:${port} (db: ${dbPath})`);
  console.log(openAi ? 'Day analysis: on' : 'Day analysis: off (no OPENAI_API_KEY)');
  console.log(openAi ? 'Micronutrient matching: on' : 'Micronutrient matching: off (no OPENAI_API_KEY)');
  console.log(auth ? 'Password: on' : 'Password: off (no APP_PASSWORD)');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
