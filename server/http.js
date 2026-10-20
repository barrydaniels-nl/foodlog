/** Low-level HTTP helpers: errors, JSON bodies and static files. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message shown to the user
   * @param {object} [extra] additional JSON fields for the response body
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const DEFAULT_BODY_LIMIT = 1_000_000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * Refuses state-changing requests that a browser marks as coming from another
 * site, so a random web page cannot change or wipe your data.
 * @param {import('node:http').IncomingMessage} req
 */
export function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (!SAFE_METHODS.has(req.method) && site && !ALLOWED_FETCH_SITES.has(site)) {
    throw new HttpError(403, 'Cross-site requests are not allowed');
  }
}

/**
 * Reads and parses a JSON request body. An empty body yields `{}`.
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?: number}} [options]
 * @returns {Promise<any>}
 */
export async function readJson(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  // Browsers can send text/plain cross-site without a CORS preflight; JSON cannot.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Request body must be JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body omitted for 204
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

async function fileStat(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/**
 * Serves a file from `root` or from an explicit URL → file mount.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{root: string, mounts?: Record<string, string>}} options
 * @returns {Promise<boolean>} false when nothing matched
 */
export async function serveStatic(req, res, { root, mounts = {} }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return false;
  }

  let filePath = mounts[pathname];
  if (!filePath) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const resolvedRoot = path.resolve(root);
    filePath = path.resolve(resolvedRoot, relative);
    if (!filePath.startsWith(resolvedRoot + path.sep)) return false;
  }

  const info = await fileStat(filePath);
  if (!info) return false;

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': info.size,
    // Small app, no build step: revalidate every time so updates show up immediately.
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on('error', reject).on('end', resolve).pipe(res);
  });
  return true;
}
