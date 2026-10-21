import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiClient, OpenAiError } from '../server/openai.js';

const REQUEST = { name: 'thing', schema: { type: 'object' }, instructions: 'Be brief.', input: '{"x":1}' };

/** A completed Responses API reply carrying `text` as the model's output. */
function completed(text) {
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
}

/** Fake fetch that answers every request with `answer(init)` and records the calls. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const result = await answer(init);
    if (result instanceof Error) throw result;
    const { status = 200, body } = result;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

const client = (fetchImpl, options = {}) => createOpenAiClient({ apiKey: 'sk-test', model: 'test-model', fetchImpl, ...options });

beforeEach((t) => t.mock.method(console, 'error', () => {}));

test('sends model, instructions and a strict json_schema format with a bearer key', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: completed('{}') }));
  await client(impl).generateJson(REQUEST);
  const [call] = calls;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'test-model');
  assert.equal(call.body.instructions, 'Be brief.');
  assert.equal(call.body.input, '{"x":1}');
  assert.deepEqual(call.body.text.format, { type: 'json_schema', name: 'thing', schema: { type: 'object' }, strict: true });
  assert.ok(call.init.signal instanceof AbortSignal);
});

test('returns the parsed output_text JSON', async () => {
  const { impl } = fakeFetch(() => ({ body: completed('{"a":1}') }));
  assert.deepEqual(await client(impl).generateJson(REQUEST), { a: 1 });
});

test('rejects a refusal', async () => {
  const body = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] };
  const { impl } = fakeFetch(() => ({ body }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('rejects an incomplete response', async () => {
  const body = { ...completed('{"a":'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const { impl } = fakeFetch(() => ({ body }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('rejects a non-2xx answer', async () => {
  const { impl } = fakeFetch(() => ({ status: 500, body: { error: { message: 'Server error' } } }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('rejects invalid JSON text', async () => {
  const { impl } = fakeFetch(() => ({ body: completed('not json') }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('rejects a reply without output text', async () => {
  const { impl } = fakeFetch(() => ({ body: { status: 'completed', output: [] } }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('rejects a network failure', async () => {
  const { impl } = fakeFetch(() => new TypeError('fetch failed'));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
});

test('aborts after timeoutMs', async () => {
  const { impl } = fakeFetch(
    (init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  );
  await assert.rejects(client(impl, { timeoutMs: 20 }).generateJson(REQUEST), OpenAiError);
});

test('never logs the api key', async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-test.' } } }));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
  const logged = console.error.mock.calls.flatMap((call) => call.arguments.map((arg) => String(arg?.stack ?? arg)));
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes('sk-test')), logged.join('\n'));
});

test('never logs the api key when the request itself fails', async () => {
  const { impl } = fakeFetch(() => new TypeError('Headers.append: "Bearer sk-test" is an invalid header value.'));
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
  const logged = console.error.mock.calls.flatMap((call) => call.arguments.map((arg) => String(arg?.stack ?? arg)));
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes('sk-test')), logged.join('\n'));
});

test('logs why a response body could not be read', async () => {
  const impl = async () => new Response('<html>oops</html>', { status: 200 });
  await assert.rejects(client(impl).generateJson(REQUEST), OpenAiError);
  const logged = console.error.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.match(logged, /body/i);
  assert.doesNotMatch(logged, /not completed/);
});
