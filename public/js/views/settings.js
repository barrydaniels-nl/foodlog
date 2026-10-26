/** Settings: daily targets, Open Food Facts region and backups. */
import { api } from '../api.js';
import { OFF_COUNTRIES, OFF_WORLD } from '../shared/constants.js';
import { toIsoDate } from '../shared/dates.js';
import { parseNumber } from '../shared/nutrition.js';
import { h, guarded } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { nutrientRows } from '../ui/nutrient-rows.js';
import { segmented } from '../ui/sheet.js';
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
 * Sex, birth year and own nutrient amounts: what the Micros page compares your intake with.
 * @param {{sex: string|null, birthYear: number|null, microTargets: Record<string, number>}} settings
 * @returns {HTMLElement}
 */
function profileCard({ sex, birthYear, microTargets }) {
  let selectedSex = sex;
  const sexControl = segmented(
    [
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
    ],
    selectedSex,
    (value) => (selectedSex = value),
  );
  const year = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: 'e.g. 1985',
    value: birthYear ?? '',
  });
  const amounts = nutrientRows({ values: microTargets });

  const save = guarded(async () => {
    const yearText = year.value.trim();
    const parsedYear = yearText === '' ? null : parseNumber(yearText);
    if (yearText !== '' && (parsedYear === null || !Number.isInteger(parsedYear))) {
      toast('Enter your birth year as a whole number.', { type: 'error' });
      return;
    }
    try {
      await api.put('/api/settings', { sex: selectedSex, birthYear: parsedYear, microTargets: amounts.collect() });
      toast('Profile saved');
    } catch (error) {
      toastError(error);
    }
  });

  return h(
    'section',
    { class: 'card settings-card' },
    h('h2', {}, 'Profile'),
    h('p', {}, 'Used to work out how much of each vitamin and mineral you need.'),
    h('span', { class: 'field-label' }, 'Sex'),
    sexControl,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Birth year'), year),
    h('div', { class: 'per100' }, 'Your own amounts'),
    h('p', { class: 'muted', style: { margin: '0 0 10px', fontSize: '13px' } }, 'Replace the recommended amount for a nutrient.'),
    amounts.element,
    h('button', { class: 'btn btn-block', type: 'button', onclick: save }, 'Save profile'),
  );
}

/** Settings card for uploading the NEVO dataset (RIVM's Dutch food table). */
function nevoCard(status) {
  const fileInput = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    hidden: true,
    onchange: async () => {
      const [file] = fileInput.files;
      fileInput.value = '';
      if (!file) return;
      try {
        const result = await api.post('/api/reference/nevo', { csv: await file.text() });
        toast(`Loaded ${result.count.toLocaleString('en-GB')} basic foods (NEVO ${result.version})`);
        setTimeout(() => location.reload(), 1200);
      } catch (error) {
        toastError(error);
      }
    },
  });
  return h(
    'section',
    { class: 'card settings-card' },
    h('h2', {}, 'Basic foods (NEVO)'),
    h(
      'p',
      {},
      status
        ? `${status.count.toLocaleString('en-GB')} foods from NEVO online ${status.version} are searchable when you add food.`
        : 'Add values for fresh foods like eggs and vegetables: request the free NEVO dataset from RIVM, then upload the file named like NEVO2025_v9.0.csv.',
    ),
    status && status.hasMicros === false ? h('p', { class: 'notice' }, 'Upload the NEVO file again to add micronutrients') : null,
    h(
      'div',
      { class: 'actions', style: { marginTop: 0 } },
      h(
        'button',
        { class: 'btn btn-soft', type: 'button', onclick: () => fileInput.click() },
        icon('upload', 18),
        status ? 'Upload newer file' : 'Upload NEVO file',
      ),
    ),
    fileInput,
    h(
      'p',
      { class: 'muted', style: { margin: '12px 0 0', fontSize: '13px' } },
      status ? `${status.credit}. ` : '',
      h(
        'a',
        { href: 'https://www.rivm.nl/en/dutch-food-composition-database/nevo-online-request-dataset', target: '_blank', rel: 'noopener' },
        status ? 'NEVO at RIVM' : 'Request the NEVO dataset',
      ),
    ),
  );
}

/**
 * @param {HTMLElement} container
 */
export async function render(container) {
  const [settings, reference] = await Promise.all([api.get('/api/settings'), api.get('/api/reference/status')]);

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
      profileCard(settings),
      nevoCard(reference.nevo),
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
