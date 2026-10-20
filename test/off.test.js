import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';
import { createOffClient, mapOffProduct } from '../server/off.js';

let server;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function product(overrides = {}, nutriments = {}) {
  return {
    code: '5711953068881',
    product_name: 'Skyr',
    brands: 'Arla',
    nutriments: {
      'energy-kcal_100g': 63,
      proteins_100g: 11,
      carbohydrates_100g: 4,
      fat_100g: 0.2,
      fiber_100g: 0,
      ...nutriments,
    },
    ...overrides,
  };
}

/** Fake fetch that answers by hostname/path and records every request. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const { hostname, pathname } = new URL(url);
    const answer = routes(hostname, pathname, String(url));
    if (answer instanceof Error) throw answer;
    const { status = 200, body } = answer;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

async function startWith(fetchImpl) {
  server = await startTestServer({ offClient: createOffClient({ fetchImpl }) });
  return api(server.url);
}

test('kJ-only energy is converted to kcal', () => {
  const mapped = mapOffProduct(product({}, { 'energy-kcal_100g': undefined, 'energy-kj_100g': 418.4 }));
  assert.equal(mapped.kcal, 100);
});

test('energy_100g (kJ) is the last fallback', () => {
  const mapped = mapOffProduct(product({}, { 'energy-kcal_100g': undefined, energy_100g: 836.8 }));
  assert.equal(mapped.kcal, 200);
});

test('missing fat makes the candidate incomplete', () => {
  const mapped = mapOffProduct(product({}, { fat_100g: undefined }));
  assert.equal(mapped.fat, null);
  assert.equal(mapped.complete, false);
});

test('complete product maps all fields', () => {
  const mapped = mapOffProduct(product());
  assert.equal(mapped.complete, true);
  assert.equal(mapped.barcode, '5711953068881');
  assert.equal(mapped.brand, 'Arla');
});

test('missing fiber defaults to 0 and does not make it incomplete', () => {
  const mapped = mapOffProduct(product({}, { fiber_100g: undefined }));
  assert.equal(mapped.fiber, 0);
  assert.equal(mapped.complete, true);
});

test('Dutch product name is preferred', () => {
  assert.equal(mapOffProduct(product({ product_name_nl: 'Skyr naturel' })).name, 'Skyr naturel');
});

test('first brand of a comma-separated list is used', () => {
  assert.equal(mapOffProduct(product({ brands: 'Arla,Arla Foods' })).brand, 'Arla');
});

test('product without any name is dropped', () => {
  assert.equal(mapOffProduct(product({ product_name: '' })), null);
});

test('serving and package sizes become portions', () => {
  const mapped = mapOffProduct(product({ serving_size: '1 pot (150 g)', serving_quantity: 150, product_quantity: 450 }));
  assert.deepEqual(mapped.portions, [
    { label: '1 pot (150 g)', grams: 150 },
    { label: 'Whole package', grams: 450 },
  ]);
});

function searchUrl(call) {
  const url = new URL(call.url);
  return { host: url.hostname, path: url.pathname, q: url.searchParams.get('q') };
}

test('search falls back to world results, deduped, country first', async () => {
  const { impl, calls } = fakeFetch((hostname, pathname, url) => {
    const q = new URL(url).searchParams.get('q');
    if (q.includes('countries_tags')) {
      return { body: { hits: [product({ code: '111111111' }), product({ code: '222222222' }), product({ code: '333333333' })] } };
    }
    return { body: { hits: [product({ code: '222222222' }), product({ code: '444444444', product_name: 'World skyr' })] } };
  });
  const client = await startWith(impl);
  const res = await client.get('/api/off/search?q=skyr');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((p) => p.barcode),
    ['111111111', '222222222', '333333333', '444444444'],
  );
  assert.deepEqual(calls.map(searchUrl), [
    { host: 'search.openfoodfacts.org', path: '/search', q: 'skyr countries_tags:"en:netherlands"' },
    { host: 'search.openfoodfacts.org', path: '/search', q: 'skyr' },
  ]);
  for (const call of calls) assert.match(call.headers['User-Agent'], /^Foodlog\/1\.0/);
});

test('search uses the configured country', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { hits: [] } }));
  const client = await startWith(impl);
  await client.put('/api/settings', { offCountry: 'be' });
  await client.get('/api/off/search?q=skyr');
  assert.equal(searchUrl(calls[0]).q, 'skyr countries_tags:"en:belgium"');
});

test('search with "world" makes a single unfiltered call', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { hits: [] } }));
  const client = await startWith(impl);
  await client.put('/api/settings', { offCountry: 'world' });
  await client.get('/api/off/search?q=skyr');
  assert.deepEqual(calls.map((c) => searchUrl(c).q), ['skyr']);
});

test('search query syntax characters are neutralised', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { hits: [] } }));
  const client = await startWith(impl);
  await client.put('/api/settings', { offCountry: 'world' });
  await client.get(`/api/off/search?q=${encodeURIComponent('ben & jerry\'s: "cookie" (dough)')}`);
  assert.equal(searchUrl(calls[0]).q, "ben jerry's cookie dough");
});

test('brands given as a list use the first brand', () => {
  assert.equal(mapOffProduct(product({ brands: ['Isey Skyr', 'Other'] })).brand, 'Isey Skyr');
});

test('search query must be at least 2 characters', async () => {
  const { impl } = fakeFetch(() => ({ body: { products: [] } }));
  const client = await startWith(impl);
  assert.equal((await client.get('/api/off/search?q=a')).status, 400);
});

test('OFF outage is a 502 and local search keeps working', async () => {
  const { impl } = fakeFetch(() => new DOMException('The operation timed out', 'TimeoutError'));
  const client = await startWith(impl);
  const res = await client.get('/api/off/search?q=skyr');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Open Food Facts is unavailable right now. Try again in a moment.');
  assert.equal((await client.get('/api/ingredients?q=x')).status, 200);
});

test('OFF 5xx is a 502', async () => {
  const { impl } = fakeFetch(() => ({ status: 503, body: {} }));
  const client = await startWith(impl);
  assert.equal((await client.get('/api/off/product/5711953068881')).status, 502);
});

test('product lookup by barcode', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { status: 1, product: product() } }));
  const client = await startWith(impl);
  const res = await client.get('/api/off/product/5711953068881');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Skyr');
  assert.match(calls[0].url, /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/5711953068881\?fields=/);
});

test('unknown barcode is 404', async () => {
  const { impl } = fakeFetch(() => ({ status: 404, body: { status: 0 } }));
  const client = await startWith(impl);
  assert.equal((await client.get('/api/off/product/5711953068881')).status, 404);
});

test('invalid barcode is 400 without calling OFF', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: {} }));
  const client = await startWith(impl);
  assert.equal((await client.get('/api/off/product/abc')).status, 400);
  assert.equal(calls.length, 0);
});
