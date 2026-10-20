/** Choose how many grams of an ingredient, with portion shortcuts and a live preview. */
import { NUTRIENT_KEYS } from '../shared/constants.js';
import { parseAmount, roundNutrients, scaleNutrients } from '../shared/nutrition.js';
import { h, fmt } from './dom.js';

const MAX_GRAMS = 5000;

/**
 * @param {{name: string, brand?: string|null, per100?: object, portions?: Array<{label: string, grams: number}>}} ingredient
 *   per-100 g values either under `per100` or directly on the object
 * @returns {Record<string, number>}
 */
export function per100Of(ingredient) {
  const source = ingredient.per100 ?? ingredient;
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, source[key] ?? 0]));
}

/**
 * Header showing an ingredient's name and its per-100 g headline values.
 * @param {object} ingredient
 * @returns {HTMLElement}
 */
export function foodHead(ingredient) {
  const per100 = per100Of(ingredient);
  return h(
    'div',
    { class: 'food-head' },
    h('h3', { class: 'food-head-name' }, ingredient.name),
    h(
      'p',
      { class: 'food-head-sub' },
      [ingredient.brand, `per 100 g: ${fmt(per100.kcal)} kcal · ${fmt(per100.protein, 1)} g protein`].filter(Boolean).join(' · '),
    ),
  );
}

/**
 * Four stat tiles for kcal / protein / carbs / fat.
 * @param {Record<string, number>} nutrients rounded
 * @returns {HTMLElement}
 */
export function statTiles(nutrients) {
  const tile = (cls, value, label) => h('div', { class: ['stat', cls] }, h('b', {}, value), h('span', {}, label));
  return h(
    'div',
    { class: 'stats' },
    tile('kcal', fmt(nutrients.kcal), 'kcal'),
    tile('protein', `${fmt(nutrients.protein, 1)}g`, 'protein'),
    tile('', `${fmt(nutrients.carbs, 1)}g`, 'carbs'),
    tile('', `${fmt(nutrients.fat, 1)}g`, 'fat'),
  );
}

/**
 * @param {{
 *   ingredient: object,
 *   initialGrams?: number,
 *   confirmLabel: string,
 *   onConfirm: (grams: number) => Promise<void>|void,
 *   extra?: Node,
 * }} options
 * @returns {HTMLElement}
 */
export function amountStep({ ingredient, initialGrams, confirmLabel, onConfirm, extra }) {
  const per100 = per100Of(ingredient);
  const portions = ingredient.portions ?? [];
  const startGrams = initialGrams ?? portions[0]?.grams ?? 100;

  const input = h('input', {
    class: 'input amount-input',
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    'aria-label': 'Amount in grams',
    value: String(startGrams).replace('.', ','),
    oninput: update,
    onkeydown: (event) => {
      if (event.key === 'Enter') confirm();
    },
  });
  const statsHost = h('div');
  const button = h('button', { class: 'btn btn-block', type: 'button', onclick: confirm }, confirmLabel);

  function currentGrams() {
    const grams = parseAmount(input.value);
    return grams !== null && grams <= MAX_GRAMS ? grams : null;
  }

  function update() {
    const grams = currentGrams();
    statsHost.replaceChildren(statTiles(roundNutrients(scaleNutrients(per100, grams ?? 0))));
    button.disabled = grams === null;
  }

  async function confirm() {
    const grams = currentGrams();
    if (grams === null || button.classList.contains('loading')) return;
    button.classList.add('loading');
    try {
      await onConfirm(grams);
    } finally {
      button.classList.remove('loading');
    }
  }

  const portionChips = portions.length
    ? h(
        'div',
        { class: 'chips', style: { marginTop: '10px' } },
        portions.map((portion) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip',
              onclick: () => {
                input.value = String(portion.grams).replace('.', ',');
                update();
              },
            },
            `${portion.label} · ${fmt(portion.grams, 1)} g`,
          ),
        ),
      )
    : null;

  update();
  const element = h(
    'div',
    {},
    foodHead(ingredient),
    h('div', { class: 'input-wrap' }, input, h('span', { class: 'input-suffix' }, 'g')),
    portionChips,
    statsHost,
    extra,
    h('div', { class: 'actions' }, button),
  );
  // Select the amount so typing replaces it straight away.
  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.select();
  }, 320);
  return element;
}
