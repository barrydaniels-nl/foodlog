import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Starts the app on a random port with an in-memory database.
 * @param {{today?: string, offClient?: object, openAi?: object|null, now?: () => Date, auth?: object|null}} [options]
 * @returns {Promise<{url: string, db: import('node:sqlite').DatabaseSync, backupDir: string, close: () => Promise<void>}>}
 */
export async function startTestServer({
  offClient = null,
  openAi = null,
  today = '2026-10-21',
  now = () => new Date('2026-10-21T09:00:00'),
  auth = null,
} = {}) {
  const db = openDb(':memory:');
  const backupDir = path.join(mkdtempSync(path.join(tmpdir(), 'foodlog-test-')), 'backups');
  const handler = createApp({ db, offClient, openAi, today: () => today, now, auth, publicDir: PUBLIC_DIR, backupDir });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let closing = null;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    backupDir,
    // Idempotent: a second close must not try to close the database again.
    close: () =>
      (closing ??= new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      })),
  };
}

/**
 * Small JSON client for tests.
 * @param {string} baseUrl
 */
export function api(baseUrl) {
  const call = async (method, path, body, extraHeaders = {}) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body, headers) => call('POST', path, body, headers),
    put: (path, body) => call('PUT', path, body),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
  };
}
