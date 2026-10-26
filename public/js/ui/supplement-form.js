/** Create or edit a supplement: its name and the label amounts in one unit (tablet, capsule, ...). */
import { h, guarded } from './dom.js';
import { icon } from './icons.js';
import { nutrientOptionLabel, nutrientRows } from './nutrient-rows.js';

const DEFAULT_UNIT_LABEL = 'tablet';

/** Folate is entered as folic acid from the label; the server counts it as dietary folate equivalents. */
function optionLabel(micro) {
  return micro.key === 'folate' ? 'Folic acid (µg)' : nutrientOptionLabel(micro);
}

function textField(label, attrs) {
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', ...attrs });
  return { input, element: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input) };
}

/**
 * @param {{
 *   initial?: {name?: string, brand?: string|null, unitLabel?: string, nutrients?: Record<string, number>},
 *   onSubmit: (input: {name: string, brand: string|null, unitLabel: string, nutrients: Record<string, number>}) => Promise<void>,
 *   onDelete?: () => Promise<void>,
 * }} options `initial.nutrients` are the stored amounts (µg for vitamin D and folic acid)
 * @returns {HTMLElement}
 */
export function supplementForm({ initial = {}, onSubmit, onDelete }) {
  const name = textField('Name', { value: initial.name ?? '', maxlength: '120', required: true });
  const brand = textField('Brand (optional)', { value: initial.brand ?? '', maxlength: '80' });
  const unitLabel = textField('Unit', { value: initial.unitLabel ?? DEFAULT_UNIT_LABEL, maxlength: '30', placeholder: 'e.g. tablet' });
  const nutrients = nutrientRows({ values: initial.nutrients, optionLabel, iuForVitaminD: true });

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-block', type: 'submit' }, initial.name ? 'Save changes' : 'Save supplement');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function collect() {
    const input = {
      name: name.input.value.trim(),
      brand: brand.input.value.trim() || null,
      unitLabel: unitLabel.input.value.trim(),
      nutrients: nutrients.collect(),
    };
    if (!input.name) throw new Error('Give the supplement a name.');
    if (!input.unitLabel) throw new Error('Say what one unit is, for example tablet.');
    if (Object.keys(input.nutrients).length === 0) throw new Error('Add at least one nutrient.');
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
        try {
          await onSubmit(input);
        } catch (error) {
          console.error(error);
          showError(error.message);
        }
      }),
    },
    errorBox,
    name.element,
    brand.element,
    unitLabel.element,
    h('div', { class: 'per100' }, 'Amount per unit'),
    nutrients.element,
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
