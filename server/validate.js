/** Request-value validators that throw a 400 HttpError naming the field. */
import { MEAL_SLOTS } from '../public/js/shared/constants.js';
import { isIsoDate, isIsoMonth } from '../public/js/shared/dates.js';
import { HttpError } from './http.js';

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{min?: number, max?: number}} [range]
 * @returns {number}
 */
export function requireNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  if (number < min || number > max) {
    throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  }
  return number;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{maxLength?: number}} [options]
 * @returns {string} trimmed, non-empty
 */
export function requireString(value, field, { maxLength = 200 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{maxLength?: number}} [options]
 * @returns {string|null} trimmed string, or null when empty or absent
 */
export function optionalString(value, field, options) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return requireString(value, field, options);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number} a positive integer id
 */
export function requireId(value, field) {
  const id = requireNumber(value, field, { min: 1 });
  if (!Number.isInteger(id)) throw new HttpError(400, `${field} must be a whole number`);
  return id;
}

/**
 * @param {unknown} value
 * @returns {string} one of MEAL_SLOTS
 */
export function requireSlot(value) {
  if (!MEAL_SLOTS.includes(value)) throw new HttpError(400, `slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string} a valid YYYY-MM-DD date
 */
export function requireDate(value, field = 'date') {
  if (!isIsoDate(value)) throw new HttpError(400, `${field} must be a date like 2026-10-21`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {string} a valid YYYY-MM month
 */
export function requireMonth(value) {
  if (!isIsoMonth(value)) throw new HttpError(400, 'month must be a month like 2026-10');
  return value;
}
