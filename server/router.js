/** A tiny method + path router with `:param` segments. */
import { readJson, sendJson } from './http.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

/**
 * @typedef {object} RouteContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {Record<string, string>} params
 * @property {URLSearchParams} query
 * @property {any} body parsed JSON for POST/PUT/PATCH, otherwise undefined
 */

/**
 * @returns {{
 *   add: (method: string, pattern: string, handler: (ctx: RouteContext) => unknown,
 *         options?: {status?: number, bodyLimit?: number, raw?: boolean}) => void,
 *   handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>
 * }}
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler, { status = 200, bodyLimit, raw = false } = {}) {
    routes.push({ method, ...compile(pattern), handler, status, bodyLimit, raw });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      const body = BODY_METHODS.has(req.method) ? await readJson(req, { limit: route.bodyLimit }) : undefined;
      const result = await route.handler({ req, res, params, query: url.searchParams, body });
      // Raw handlers write their own response (e.g. file downloads).
      if (!route.raw) sendJson(res, route.status, result ?? null);
      return true;
    }
    return false;
  }

  return { add, handle };
}
