/**
 * OpenAI Responses API client that returns JSON matching a given schema
 * (structured outputs). Domain modules own their prompts and schemas.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const DEFAULT_MODEL = 'gpt-6-luna';
// Short coaching answers need little reasoning; medium effort ran past 30 s.
const REASONING_EFFORT = 'low';

/** Any failure talking to OpenAI. The message is for logs, never for users. */
export class OpenAiError extends Error {}

/**
 * @param {{apiKey: string, model: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createOpenAiClient({ apiKey, model, fetchImpl = fetch, timeoutMs = 60_000 }) {
  /**
   * Logs with context, then returns the error for the caller to throw.
   * Error texts can echo the key (a 401 message, an invalid header value),
   * so it is redacted from everything logged.
   * @param {string} message
   * @param {unknown} [cause]
   * @returns {OpenAiError}
   */
  function failure(message, cause) {
    const detail = cause === undefined ? message : `${message} (${cause?.name ?? 'Error'}: ${cause?.message ?? cause})`;
    const safe = detail.replaceAll(apiKey, '[redacted]');
    console.error(`OpenAI: ${safe}`);
    return new OpenAiError(safe);
  }

  /**
   * Pulls the JSON text out of a completed Responses API reply.
   * @param {any} data
   * @returns {any} the parsed JSON
   */
  function parseReply(data) {
    if (data?.status !== 'completed') {
      throw failure(`response not completed (status ${data?.status}, reason ${data?.incomplete_details?.reason})`);
    }
    const message = (data.output ?? []).find((item) => item?.type === 'message');
    const parts = message?.content ?? [];
    const refusal = parts.find((part) => part?.type === 'refusal');
    if (refusal) throw failure(`model refused: ${refusal.refusal}`);
    const text = parts.find((part) => part?.type === 'output_text')?.text;
    if (typeof text !== 'string') throw failure('response has no output text');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw failure('response text is not valid JSON', error);
    }
  }

  /**
   * @param {{name: string, schema: object, instructions: string, input: string}} request
   * @returns {Promise<any>} JSON matching `schema`
   */
  async function generateJson({ name, schema, instructions, input }) {
    let response;
    try {
      response = await fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          instructions,
          input,
          reasoning: { effort: REASONING_EFFORT },
          text: { format: { type: 'json_schema', name, schema, strict: true } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw failure('request failed', error);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      // An error status without a JSON body is still reported by its status below.
      if (response.ok) throw failure(`response body unreadable (status ${response.status})`, error);
      data = null;
    }
    if (!response.ok) {
      throw failure(`returned ${response.status}: ${data?.error?.message ?? 'no error message'}`);
    }
    return parseReply(data);
  }

  return { generateJson };
}
