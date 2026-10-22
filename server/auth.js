/**
 * Optional password gate: one shared password from the environment, remembered
 * per device in a cookie. The diet export can also be opened with its own
 * link token, so an AI chat can read it without logging in.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, sendJson } from './http.js';

export const LOGIN_PAGE = '/login.html';
const COOKIE = 'foodlog_session';
// Browsers cap cookie lifetimes at 400 days.
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
// Reachable without logging in: the login page and what it loads, plus the Docker health check.
const PUBLIC_PATHS = new Set([LOGIN_PAGE, '/js/login.js', '/css/app.css', '/manifest.webmanifest', '/api/health', '/api/login']);
const PUBLIC_PREFIXES = ['/icons/'];

/** Hashing first gives equal-length buffers, which timingSafeEqual requires. */
const digest = (value) => createHash('sha256').update(value).digest();
const sameSecret = (given, expected) => timingSafeEqual(digest(given), digest(expected));

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string|null}
 */
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

const isPublic = (pathname) => PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

/**
 * @param {{password: string, dietToken?: string|null}} options
 */
export function createAuth({ password, dietToken = null }) {
  // Derived from the password, so changing APP_PASSWORD logs every device out.
  const sessionToken = createHmac('sha256', password).update('foodlog-session').digest('base64url');

  const isLoggedIn = (req) => {
    const cookie = readCookie(req, COOKIE);
    return cookie !== null && sameSecret(cookie, sessionToken);
  };

  const hasDietToken = (url) =>
    dietToken !== null && url.pathname === '/api/diet' && sameSecret(url.searchParams.get('token') ?? '', dietToken);

  /**
   * Lets public and logged-in requests through. Otherwise API calls get a 401
   * and pages are sent to the login page.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean} true when the request was answered here
   */
  function guard(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (isPublic(url.pathname) || isLoggedIn(req) || hasDietToken(url)) return false;
    if (url.pathname.startsWith('/api/')) throw new HttpError(401, 'Log in to use Foodlog');
    res.writeHead(302, { location: LOGIN_PAGE, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  /** @param {ReturnType<import('./router.js').createRouter>} router */
  function registerRoutes(router) {
    router.add(
      'POST',
      '/api/login',
      ({ res, body }) => {
        if (typeof body?.password !== 'string' || !sameSecret(body.password, password)) {
          throw new HttpError(401, 'Wrong password');
        }
        sendJson(res, 204, null, {
          'set-cookie': `${COOKIE}=${sessionToken}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
        });
      },
      { raw: true },
    );
  }

  return { guard, registerRoutes };
}
