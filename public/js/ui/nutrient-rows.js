/**
 * Editable "nutrient + amount" rows (add and remove), shared by the supplement
 * form and the profile card in Settings. The nutrient list comes from the
 * shared micronutrient definitions, so there is no second copy to keep in sync.
 */
import { MICRO_BY_KEY, MICRO_KEYS, MICRONUTRIENTS, VitaminDUnit, vitaminDFromUg, vitaminDToUg } from '../shared/micronutrients.js';
import { parseNumber } from '../shared/nutrition.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { segmented } from './sheet.js';

const VITAMIN_D = 'vitaminD';

/**
 * @param {{label: string, unit: string}} micro
 * @returns {string} e.g. "Vitamin C (mg)"
 */
export function nutrientOptionLabel(micro) {
  return `${micro.label} (${micro.unit})`;
}

/**
 * @param {number|null|undefined} value
 * @returns {string} the value as typed on a Dutch keyboard, "" when unset
 */
export function displayAmount(value) {
  return value === null || value === undefined ? '' : String(value).replace('.', ',');
}

/**
 * @param {{
 *   values?: Record<string, number>,
 *   optionLabel?: (micro: object) => string,
 *   iuForVitaminD?: boolean,
 * }} [options] `iuForVitaminD` adds a µg | IU toggle to the vitamin D row; IU is converted to µg on collect
 * @returns {{element: HTMLElement, collect: () => Record<string, number>}}
 *   `collect` throws an Error with a user-facing message when a row is invalid; rows with a blank amount are skipped
 */
export function nutrientRows({ values = {}, optionLabel = nutrientOptionLabel, iuForVitaminD = false } = {}) {
  const rows = h('div');

  const usedKeys = () => [...rows.children].map((row) => row.nutrient.select.value);

  function addRow(key, amount = '') {
    const chosen = key ?? MICRO_KEYS.find((candidate) => !usedKeys().includes(candidate)) ?? MICRO_KEYS[0];
    let unit = VitaminDUnit.MICROGRAM;
    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Nutrient', onchange: syncToggle },
      MICRONUTRIENTS.map((micro) => h('option', { value: micro.key, selected: micro.key === chosen }, optionLabel(micro))),
    );
    const input = h('input', {
      class: 'input',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      placeholder: 'amount',
      'aria-label': 'Amount',
      value: displayAmount(amount),
    });
    /** Rewrites a typed amount into the new unit, so flipping the toggle never changes what is stored. */
    function switchUnit(value) {
      if (value === unit) return;
      const typed = parseNumber(input.value);
      if (typed !== null) input.value = displayAmount(vitaminDFromUg(vitaminDToUg(typed, unit), value));
      unit = value;
    }
    const toggle = iuForVitaminD
      ? segmented(
          [
            { value: VitaminDUnit.MICROGRAM, label: 'µg' },
            { value: VitaminDUnit.IU, label: 'IU' },
          ],
          unit,
          switchUnit,
        )
      : null;
    function syncToggle() {
      if (toggle) toggle.hidden = select.value !== VITAMIN_D;
    }
    const row = h(
      'div',
      { class: 'nutrient-row' },
      select,
      input,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove nutrient', onclick: () => row.remove() }, icon('x', 18)),
      toggle,
    );
    // IU only applies while the row is on vitamin D; switching nutrient must not leave a stale IU conversion behind.
    row.nutrient = { select, input, toStored: (amount) => (select.value === VITAMIN_D ? vitaminDToUg(amount, unit) : amount) };
    syncToggle();
    rows.append(row);
  }

  for (const [key, amount] of Object.entries(values)) addRow(key, amount);

  function collect() {
    const result = {};
    for (const { nutrient } of rows.children) {
      const micro = MICRO_BY_KEY[nutrient.select.value];
      if (nutrient.input.value.trim() === '') continue;
      const amount = parseNumber(nutrient.input.value);
      if (amount === null || amount <= 0) {
        nutrient.input.classList.add('needs');
        throw new Error(`Enter an amount above 0 for ${micro.label}.`);
      }
      if (micro.key in result) throw new Error(`${micro.label} is listed twice.`);
      result[micro.key] = nutrient.toStored(amount);
    }
    return result;
  }

  const element = h(
    'div',
    {},
    rows,
    h(
      'button',
      { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => addRow(), style: { marginBottom: '14px' } },
      icon('plus', 16),
      'Add nutrient',
    ),
  );
  return { element, collect };
}
