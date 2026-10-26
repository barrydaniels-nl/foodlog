/** Supplement catalogue (add, edit, archive, restore) and the "My daily supplements" set. */
import { api } from '../api.js';
import { parseNumber } from '../shared/nutrition.js';
import { h, guarded } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openSheet } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';
import { displayAmount } from '../ui/nutrient-rows.js';
import { supplementForm } from '../ui/supplement-form.js';

const MIN_UNITS = 0.25;
const MAX_UNITS = 20;
const DEFAULT_SET_UNITS = 1;

/** Units are kept as typed so a redraw never loses what the user entered. */
function toDraft(items) {
  return items.map((item) => ({ ...item, units: displayAmount(item.units) }));
}

/**
 * @param {HTMLElement} container
 */
export async function render(container) {
  let showArchived = false;
  /** Every supplement, archived included; the set editor only offers the active ones. */
  let catalogue = await api.get('/api/supplements?archived=1');
  let setItems = toDraft(await api.get('/api/supplement-set'));

  const catalogueList = h('div', { class: 'list' });
  const setCard = h('section', { class: 'card supp-card' });

  async function loadCatalogue() {
    catalogue = await api.get('/api/supplements?archived=1');
    drawCatalogue();
    drawSet();
  }

  function drawCatalogue() {
    const visible = catalogue.filter((supplement) => showArchived || !supplement.archived);
    catalogueList.replaceChildren(
      ...(visible.length
        ? visible.map(catalogueRow)
        : [h('div', { class: 'empty-state' }, h('h2', {}, 'No supplements yet'), h('p', {}, 'Add what you take, with the amounts from the label.'))]),
    );
  }

  function catalogueRow(supplement) {
    const nutrientCount = Object.keys(supplement.nutrients).length;
    const main = [
      h('span', { class: 'thumb thumb-placeholder' }, icon('pill')),
      h(
        'span',
        { class: 'list-main' },
        h(
          'span',
          { class: 'list-title', style: { display: 'block' } },
          supplement.name,
          supplement.archived ? h('span', { class: 'badge badge-muted', style: { marginLeft: '6px' } }, 'Deleted') : null,
        ),
        h(
          'span',
          { class: 'list-sub', style: { display: 'block' } },
          [supplement.brand, `${nutrientCount} ${nutrientCount === 1 ? 'nutrient' : 'nutrients'} per ${supplement.unitLabel}`].filter(Boolean).join(' · '),
        ),
      ),
    ];
    if (supplement.archived) {
      return h(
        'div',
        { class: 'list-item' },
        h('span', { class: 'archived', style: { display: 'contents' } }, main),
        h(
          'button',
          {
            class: 'btn btn-soft btn-sm',
            type: 'button',
            onclick: guarded(async () => {
              try {
                await api.post(`/api/supplements/${supplement.id}/restore`);
                toast(`Restored ${supplement.name}`);
                await loadCatalogue();
              } catch (error) {
                toastError(error);
              }
            }),
          },
          icon('restore', 16),
          'Restore',
        ),
      );
    }
    return h('button', { class: 'list-item', type: 'button', onclick: () => openEditor(supplement) }, main);
  }

  function openCreate() {
    const sheet = openSheet({ title: 'New supplement', content: h('div') });
    sheet.setContent(
      supplementForm({
        onSubmit: async (input) => {
          await api.post('/api/supplements', input);
          sheet.close();
          toast(`Saved ${input.name}`);
          await loadCatalogue();
        },
      }),
    );
  }

  function openEditor(supplement) {
    const sheet = openSheet({ title: supplement.name, content: h('div') });
    sheet.setContent(
      supplementForm({
        initial: supplement,
        onSubmit: async (input) => {
          await api.put(`/api/supplements/${supplement.id}`, input);
          sheet.close();
          toast(`Saved ${input.name}`);
          await loadCatalogue();
        },
        onDelete: async () => {
          if (!confirm(`Delete ${supplement.name}? Days you already logged keep it.`)) return;
          await api.del(`/api/supplements/${supplement.id}`);
          sheet.close();
          toast(`Deleted ${supplement.name}`);
          await loadCatalogue();
        },
      }),
    );
  }

  /** Keeps set names in step with catalogue edits made while the set has unsaved changes. */
  function syncSetNames() {
    for (const item of setItems) {
      const supplement = catalogue.find((candidate) => candidate.id === item.supplementId);
      if (supplement) Object.assign(item, { name: supplement.name, unitLabel: supplement.unitLabel });
    }
  }

  function drawSet() {
    syncSetNames();
    const inSet = new Set(setItems.map((item) => item.supplementId));
    const available = catalogue.filter((supplement) => !supplement.archived && !inSet.has(supplement.id));
    const addSelect = h(
      'select',
      {
        class: 'input',
        'aria-label': 'Add from catalogue',
        disabled: available.length === 0,
        onchange: () => {
          const supplement = available.find((candidate) => String(candidate.id) === addSelect.value);
          if (!supplement) return;
          setItems.push({ supplementId: supplement.id, name: supplement.name, unitLabel: supplement.unitLabel, units: displayAmount(DEFAULT_SET_UNITS) });
          drawSet();
        },
      },
      h('option', { value: '' }, available.length ? 'Add from catalogue…' : 'Nothing left to add'),
      available.map((supplement) => h('option', { value: String(supplement.id) }, supplement.name)),
    );

    setCard.replaceChildren(
      setItems.length
        ? h('ul', { class: 'supp-list' }, setItems.map(setRow))
        : h('p', { class: 'muted supp-empty' }, 'No supplements in your daily set yet.'),
      addSelect,
      h('button', { class: 'btn btn-block', type: 'button', onclick: guarded(saveSet) }, 'Save'),
    );
  }

  function setRow(item) {
    const units = h('input', {
      class: 'input supp-units-input',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': `Units of ${item.name}`,
      value: item.units,
      oninput: () => {
        item.units = units.value;
        units.classList.remove('needs');
      },
    });
    item.input = units;
    return h(
      'li',
      { class: 'supp-item' },
      h('span', { class: 'supp-main' }, h('span', { class: 'supp-name' }, item.name)),
      units,
      h('span', { class: 'supp-unit-label' }, item.unitLabel),
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-label': `Remove ${item.name}`,
          onclick: () => {
            setItems = setItems.filter((candidate) => candidate !== item);
            drawSet();
          },
        },
        icon('x', 18),
      ),
    );
  }

  async function saveSet() {
    const items = [];
    for (const item of setItems) {
      const units = parseNumber(item.units);
      if (units === null || units < MIN_UNITS || units > MAX_UNITS) {
        item.input.classList.add('needs');
        toast(`Units for ${item.name} must be between ${displayAmount(MIN_UNITS)} and ${MAX_UNITS}.`, { type: 'error' });
        return;
      }
      items.push({ supplementId: item.supplementId, units });
    }
    try {
      setItems = toDraft(await api.put('/api/supplement-set', { items }));
      drawSet();
      toast('Daily supplements saved');
    } catch (error) {
      toastError(error);
    }
  }

  container.replaceChildren(
    h('a', { class: 'back-link', href: '#/micros', style: { textDecoration: 'none' } }, icon('back', 16), 'Micros'),
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title' }, 'Supplements')),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: openCreate }, icon('plus', 18), 'New'),
    ),
    h('h2', { class: 'section-label' }, 'My daily supplements'),
    setCard,
    h('h2', { class: 'section-label' }, 'Catalogue'),
    // Left-aligned: with nothing else in the toolbar, a right-aligned toggle put its text past the edge on phones.
    h(
      'div',
      { class: 'toolbar' },
      h(
        'label',
        { class: 'toggle' },
        h('input', {
          type: 'checkbox',
          onchange: (event) => {
            showArchived = event.target.checked;
            drawCatalogue();
          },
        }),
        'Show deleted',
      ),
    ),
    catalogueList,
  );
  drawCatalogue();
  drawSet();
}
