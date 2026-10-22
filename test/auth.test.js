import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { createAuth } from '../server/auth.js';

const PASSWORD = 'correct horse';
const DIET_TOKEN = 'diet-token-123';

let server;

before(async () => {
  server = await startTestServer({ auth: createAuth({ password: PASSWORD, dietToken: DIET_TOKEN }) });
});
after(() => server.close());

const get = (path, headers = {}) => fetch(server.url + path, { headers, redirect: 'manual' });

const login = (password) =>
  fetch(server.url + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

/** @returns {Promise<string>} the `name=value` part of the session cookie */
async function sessionCookie() {
  const response = await login(PASSWORD);
  return response.headers.get('set-cookie').split(';')[0];
}

test('the API refuses requests without a session', async () => {
  for (const path of ['/api/settings', '/api/diet', '/api/days/2026-10-21']) {
    const response = await get(path);
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).error, 'Log in to use Foodlog');
  }
});

test('pages redirect to the login screen without a session', async () => {
  for (const path of ['/', '/index.html', '/js/app.js']) {
    const response = await get(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/login.html');
  }
});

test('the login screen, its assets and the health check stay public', async () => {
  for (const path of ['/login.html', '/js/login.js', '/css/app.css', '/manifest.webmanifest', '/icons/icon-192.png', '/api/health']) {
    assert.equal((await get(path)).status, 200, path);
  }
});

test('a wrong or missing password is refused', async (t) => {
  for (const password of ['wrong', '', undefined, 42]) {
    await t.test(String(password), async () => {
      const response = await login(password);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal((await response.json()).error, 'Wrong password');
    });
  }
});

test('a non-object login body is refused without crashing', async () => {
  const response = await fetch(server.url + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  });
  assert.equal(response.status, 401);
});

test('the right password sets a long-lived HttpOnly session cookie', async () => {
  const response = await login(PASSWORD);
  assert.equal(response.status, 204);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^foodlog_session=[\w-]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=34560000/);
});

test('the session cookie opens the app and the API', async () => {
  const cookie = await sessionCookie();
  assert.equal((await get('/', { cookie })).status, 200);
  assert.equal((await get('/api/settings', { cookie })).status, 200);
  assert.equal((await get('/api/settings', { cookie: `other=1; ${cookie}` })).status, 200);
});

test('a forged session cookie is refused', async () => {
  for (const cookie of ['foodlog_session=forged', 'foodlog_session=', 'foodlog_session']) {
    assert.equal((await get('/api/settings', { cookie })).status, 401, cookie);
  }
});

test('a session from another password is refused', async () => {
  const other = await startTestServer({ auth: createAuth({ password: 'different' }) });
  try {
    assert.equal((await get('/api/settings', { cookie: await sessionCookie() })).status, 200);
    const response = await fetch(other.url + '/api/settings', { headers: { cookie: await sessionCookie() } });
    assert.equal(response.status, 401);
  } finally {
    await other.close();
  }
});

test('the diet token opens only the diet export', async () => {
  const diet = await get(`/api/diet?days=3&token=${DIET_TOKEN}`);
  assert.equal(diet.status, 200);
  assert.match(await diet.text(), /^# Food diary/);
  assert.equal((await get(`/api/settings?token=${DIET_TOKEN}`)).status, 401);
  assert.equal((await get('/api/diet?token=wrong')).status, 401);
});

test('without a diet token configured, the diet export needs a session', async () => {
  const noToken = await startTestServer({ auth: createAuth({ password: PASSWORD }) });
  try {
    assert.equal((await fetch(`${noToken.url}/api/diet?token=`)).status, 401);
  } finally {
    await noToken.close();
  }
});

test('without auth the app stays open', async () => {
  const open = await startTestServer();
  try {
    assert.equal((await fetch(open.url + '/api/settings')).status, 200);
    assert.equal((await fetch(open.url + '/api/login', { method: 'POST' })).status, 404);
  } finally {
    await open.close();
  }
});
