/** Client-side ingredient resolution shared by every "find or create a food" flow. */
import { api } from './api.js';

/**
 * Creates an ingredient. If its barcode already exists, returns (and if
 * needed restores) the existing one instead, so a re-scan never fails.
 * @param {object} input ingredient fields
 * @returns {Promise<object>} the ingredient
 */
export async function saveIngredient(input) {
  try {
    return await api.post('/api/ingredients', input);
  } catch (error) {
    if (error.status !== 409 || !error.extra?.existingId) throw error;
    const existing = await api.get(`/api/ingredients/${error.extra.existingId}`);
    return existing.archived ? api.post(`/api/ingredients/${existing.id}/restore`) : existing;
  }
}

/**
 * Copies a NEVO basic food into your foods (or returns the copy you already have).
 * @param {{source: string, code: number}} food a /api/reference/search result
 * @returns {Promise<object>} the ingredient
 */
export function adoptReference(food) {
  return api.post(`/api/reference/${food.source}/${food.code}/adopt`);
}

/**
 * Finds what a scanned barcode refers to: a saved ingredient, an Open Food
 * Facts candidate to confirm, or an empty form to fill in by hand.
 * @param {string} code
 * @returns {Promise<{ingredient: object} | {candidate: object, notice?: string}>}
 */
export async function resolveBarcode(code) {
  try {
    const found = await api.get(`/api/ingredients/barcode/${code}`);
    return { ingredient: found.archived ? await api.post(`/api/ingredients/${found.id}/restore`) : found };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  try {
    return { candidate: await api.get(`/api/off/product/${code}`) };
  } catch (error) {
    if (error.status !== 404) throw error;
    return {
      candidate: { barcode: code },
      notice: 'Not found on Open Food Facts. Enter the values from the label.',
    };
  }
}
