/** Create or edit an ingredient (values per 100 g, plus optional portions). */
import { parseAmount, parseNumber } from '../shared/nutrition.js';
import { h, guarded } from './dom.js';
import { icon } from './icons.js';

const NUTRIENT_FIELDS = [
  { key: 'kcal', label: 'Energy', unit: 'kcal', required: true },
  { key: 'protein', label: 'Protein', unit: 'g', required: true },
  { key: 'carbs', label: 'Carbs', unit: 'g', required: true },
  { key: 'fat', label: 'Fat', unit: 'g', required: true },
  { key: 'fiber', label: 'Fibre', unit: 'g', required: false },
];

function displayNumber(value) {
  return value === null || value === undefined ? '' : String(value).replace('.', ',');
}

function textField(label, attrs) {
  const input = h('input', { class: 'input', type: 'text', ...attrs });
  return { input, element: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input) };
}

/**
 * @param {{
 *   initial?: object,
 *   notice?: string,
 *   submitLabel: string,
 *   onSubmit: (input: object) => Promise<void>,
 *   onDelete?: () => Promise<void>,
 * }} options `initial` may be a saved ingredient or an Open Food Facts candidate
 * @returns {HTMLElement}
 */
export function ingredientForm({ initial = {}, notice, submitLabel, onSubmit, onDelete }) {
  const fromOff = 'complete' in initial;
  const name = textField('Name', { value: initial.name ?? '', maxlength: '120', autocomplete: 'off', required: true });
  const brand = textField('Brand (optional)', { value: initial.brand ?? '', maxlength: '80', autocomplete: 'off' });
  const barcode = textField('Barcode (optional)', {
    value: initial.barcode ?? '',
    inputmode: 'numeric',
    maxlength: '14',
    autocomplete: 'off',
  });

  const nutrientInputs = {};
  const nutrientFields = NUTRIENT_FIELDS.map(({ key, label, unit, required }) => {
    const missing = required && (initial[key] === null || (fromOff && initial[key] === undefined));
    const input = h('input', {
      class: ['input', missing && 'needs'],
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      value: displayNumber(initial[key]),
      placeholder: required ? '' : '0',
      oninput: () => input.classList.remove('needs'),
    });
    nutrientInputs[key] = input;
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h('div', { class: 'input-wrap' }, input, h('span', { class: 'input-suffix' }, unit)),
    );
  });

  const portionRows = h('div');
  function addPortionRow(portion = { label: '', grams: '' }) {
    const label = h('input', { class: 'input', type: 'text', placeholder: 'e.g. 1 pot', maxlength: '40', value: portion.label });
    const grams = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'grams', value: displayNumber(portion.grams) });
    const row = h(
      'div',
      { class: 'portion-row' },
      label,
      grams,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove portion', onclick: () => row.remove() }, icon('x', 18)),
    );
    row.portion = { label, grams };
    portionRows.append(row);
  }
  for (const portion of initial.portions ?? []) addPortionRow(portion);

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-block', type: 'submit' }, submitLabel);

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function collect() {
    const input = {
      name: name.input.value.trim(),
      brand: brand.input.value.trim() || null,
      barcode: barcode.input.value.trim() || null,
      source: initial.source ?? (fromOff ? 'off' : 'manual'),
      portions: [],
    };
    if (!input.name) throw new Error('Give the food a name.');
    for (const { key, label, required } of NUTRIENT_FIELDS) {
      const raw = nutrientInputs[key].value;
      const value = raw.trim() === '' && !required ? 0 : parseNumber(raw);
      if (value === null) {
        nutrientInputs[key].classList.add('needs');
        throw new Error(`Enter ${label.toLowerCase()} per 100 g.`);
      }
      input[key] = value;
    }
    for (const row of portionRows.children) {
      const label = row.portion.label.value.trim();
      const gramsRaw = row.portion.grams.value;
      if (!label && !gramsRaw.trim()) continue;
      const grams = parseAmount(gramsRaw);
      if (!label || grams === null) throw new Error('Each portion needs a name and an amount in grams.');
      input.portions.push({ label, grams });
    }
    return input;
  }

  const form = h(
    'form',
    {
      novalidate: true,
      onsubmit: guarded(async (event) => {
        event.preventDefault();
        errorBox.hidden = true;
        let input;
        try {
          input = collect();
        } catch (error) {
          showError(error.message);
          return;
        }
        submit.classList.add('loading');
        try {
          await onSubmit(input);
        } catch (error) {
          console.error(error);
          showError(error.message);
        } finally {
          submit.classList.remove('loading');
        }
      }),
    },
    notice ? h('p', { class: 'notice' }, notice) : null,
    initial.referenceCode
      ? h('p', { class: 'muted', style: { margin: '0 0 12px', fontSize: '13px' } }, 'From NEVO (RIVM). Changing its values makes it your own food.')
      : null,
    fromOff && !initial.complete && !notice
      ? h('p', { class: 'notice' }, 'Open Food Facts is missing some values. Fill in the highlighted ones from the label.')
      : null,
    initial.imageUrl ? h('img', { class: 'product-image', src: initial.imageUrl, alt: '', referrerpolicy: 'no-referrer' }) : null,
    errorBox,
    name.element,
    brand.element,
    h('div', { class: 'per100' }, 'Per 100 g'),
    h('div', { class: 'grid-2' }, nutrientFields),
    h('div', { class: 'per100' }, 'Portions'),
    portionRows,
    h(
      'button',
      { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => addPortionRow(), style: { marginBottom: '14px' } },
      icon('plus', 16),
      'Add portion',
    ),
    barcode.element,
    submit,
    onDelete
      ? h(
          'button',
          {
            class: 'btn btn-danger btn-block',
            type: 'button',
            style: { marginTop: '10px' },
            onclick: async () => {
              try {
                await onDelete();
              } catch (error) {
                console.error(error);
                showError(error.message);
              }
            },
          },
          icon('trash', 18),
          'Delete',
        )
      : null,
  );
  if (!initial.name) setTimeout(() => name.input.focus({ preventScroll: true }), 320);
  return form;
}
