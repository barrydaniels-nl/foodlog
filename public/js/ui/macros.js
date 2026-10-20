/** Reference-style nutrition displays: flame kcal line and macro columns. */
import { h, fmt } from './dom.js';

const KCAL_PER_GRAM = { protein: 4, fat: 9, carbs: 4 };
const MACROS = [
  { key: 'protein', label: 'Protein' },
  { key: 'fat', label: 'Fats' },
  { key: 'carbs', label: 'Carbs' },
];
const AVATAR_COLORS = ['#e3f1e7', '#fde8dc', '#fdf3cf', '#e8e9f6', '#e0f0f6'];

/**
 * "🔥 228 kcal · 60 g"
 * @param {number} kcal
 * @param {string} [detail] text after the kcal, e.g. "60 g"
 * @returns {HTMLElement}
 */
export function kcalLine(kcal, detail) {
  return h(
    'span',
    { class: 'kcal-line' },
    h('span', { 'aria-hidden': 'true' }, '🔥'),
    ` ${fmt(kcal)} kcal`,
    detail ? h('span', { class: 'kcal-detail' }, ` · ${detail}`) : null,
  );
}

/** Share of energy as a bar height; a small visible minimum for any non-zero amount. */
function barPercent(part, total) {
  if (!total || part <= 0) return 0;
  return Math.max(8, Math.round((part / total) * 100));
}

/**
 * Protein / Fats / Carbs in grams, each with a small bar showing that macro's
 * share of the food's energy — so a glance tells you what the food mostly is.
 * @param {Record<string, number>} nutrients rounded grams
 * @returns {HTMLElement}
 */
export function macroColumns(nutrients) {
  const energy = Object.fromEntries(MACROS.map(({ key }) => [key, (nutrients[key] ?? 0) * KCAL_PER_GRAM[key]]));
  const total = Object.values(energy).reduce((sum, value) => sum + value, 0);
  return h(
    'span',
    { class: 'macro-cols' },
    MACROS.map(({ key, label }) =>
      h(
        'span',
        { class: ['macro-col', `macro-${key}`] },
        h(
          'span',
          { class: 'macro-bar', 'aria-hidden': 'true' },
          h('i', { style: { height: `${barPercent(energy[key], total)}%` } }),
        ),
        h('span', { class: 'macro-text' }, h('b', {}, `${fmt(nutrients[key], 1)}g`), h('span', {}, label)),
      ),
    ),
  );
}

/**
 * A round initial badge with a soft colour that stays the same per name.
 * @param {string} name
 * @returns {HTMLElement}
 */
export function foodAvatar(name) {
  const hash = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0);
  return h(
    'span',
    { class: 'food-avatar', style: { background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }, 'aria-hidden': 'true' },
    name.trim().charAt(0).toUpperCase(),
  );
}
