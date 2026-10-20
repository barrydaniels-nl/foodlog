/** Settings: daily targets, Open Food Facts region and backups. */
import { api } from '../api.js';
import { OFF_COUNTRIES, OFF_WORLD } from '../shared/constants.js';
import { toIsoDate } from '../shared/dates.js';
import { parseNumber } from '../shared/nutrition.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';

const REGION_LABELS = {
  nl: 'Netherlands',
  be: 'Belgium',
  de: 'Germany',
  uk: 'United Kingdom',
  fr: 'France',
  [OFF_WORLD]: 'Worldwide',
};

/** Triggers a browser download of a full export. */
function downloadExport() {
  const link = h('a', { href: '/api/export', download: `foodlog-${toIsoDate(new Date())}.json` });
  document.body.append(link);
  link.click();
  link.remove();
}

function numberField(label, value, unit) {
  const input = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: String(value) });
  return {
    input,
    element: h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h('div', { class: 'input-wrap' }, input, h('span', { class: 'input-suffix' }, unit)),
    ),
  };
}

/**
 * @param {HTMLElement} container
 */
export async function render(container) {
  const settings = await api.get('/api/settings');

  const kcal = numberField('Calories per day', settings.kcalTarget, 'kcal');
  const protein = numberField('Protein per day', settings.proteinTarget, 'g');
  const targetsForm = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const kcalTarget = parseNumber(kcal.input.value);
        const proteinTarget = parseNumber(protein.input.value);
        if (kcalTarget === null || proteinTarget === null) {
          toast('Enter both targets as numbers.', { type: 'error' });
          return;
        }
        try {
          await api.put('/api/settings', { kcalTarget, proteinTarget });
          toast('Targets saved');
        } catch (error) {
          toastError(error);
        }
      },
    },
    h('div', { class: 'grid-2' }, kcal.element, protein.element),
    h('button', { class: 'btn btn-block', type: 'submit' }, 'Save targets'),
  );

  const region = h(
    'select',
    {
      class: 'input',
      'aria-label': 'Open Food Facts region',
      onchange: async () => {
        try {
          await api.put('/api/settings', { offCountry: region.value });
          toast(`Searching ${REGION_LABELS[region.value]} first`);
        } catch (error) {
          toastError(error);
        }
      },
    },
    [...Object.keys(OFF_COUNTRIES), OFF_WORLD].map((code) =>
      h('option', { value: code, selected: code === settings.offCountry }, REGION_LABELS[code]),
    ),
  );

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const [file] = fileInput.files;
      fileInput.value = '';
      if (!file) return;
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        toast('That file is not valid JSON.', { type: 'error' });
        return;
      }
      if (!confirm('This replaces ALL your foods, meals and planned days with the backup. Your current data is saved on the server first. Continue?')) {
        return;
      }
      try {
        const counts = await api.post('/api/import', backup);
        toast(`Restored ${counts.ingredients} foods, ${counts.meals} meals and ${counts.entries} entries. Previous data saved as ${counts.snapshot}`);
        setTimeout(() => location.reload(), 1200);
      } catch (error) {
        toastError(error);
      }
    },
  });

  const card = (title, text, ...children) =>
    h('section', { class: 'card settings-card' }, h('h2', {}, title), h('p', {}, text), ...children);

  container.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'page-title' }, 'Settings'))),
    h(
      'div',
      { class: 'stagger' },
      card('Daily targets', 'The day screen measures your plan against these.', targetsForm),
      card('Food search region', 'Open Food Facts results from this country are shown first.', region),
      card(
        'Backup',
        'Download everything as one file, or restore from an earlier backup.',
        h(
          'div',
          { class: 'actions', style: { marginTop: 0 } },
          h('button', { class: 'btn btn-soft', type: 'button', onclick: downloadExport }, icon('download', 18), 'Export'),
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => fileInput.click() }, icon('upload', 18), 'Import'),
        ),
        fileInput,
      ),
    ),
    h(
      'p',
      { class: 'about' },
      'Product data from ',
      h('a', { href: 'https://world.openfoodfacts.org', target: '_blank', rel: 'noopener' }, 'Open Food Facts'),
      ', available under the Open Database License.',
    ),
  );
}
