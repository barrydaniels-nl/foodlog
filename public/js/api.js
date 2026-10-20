/** JSON client for the Foodlog API. */

export class ApiError extends Error {
  /**
   * @param {number} status 0 when the server could not be reached
   * @param {string} message the server's user-facing error text
   * @param {object} [extra] any other fields of the error body
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach Foodlog. Check your connection.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const { error, ...extra } = data ?? {};
    throw new ApiError(response.status, error ?? `Request failed (${response.status})`, extra);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
