/** Your ingredient database: search, add, edit, delete (archive) and restore. */
import { api } from '../api.js';
import { adoptReference, resolveBarcode, saveIngredient } from '../food-lookup.js';
import { h, fmt, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openSheet } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';
import { ingredientForm } from '../ui/ingredient-form.js';
import { foodSearch } from '../ui/food-search.js';
import { scanBarcode } from '../scanner.js';

/**
 * @param {HTMLElement} container
 */
export async function render(container) {
  let showArchived = false;
  let sequence = 0;

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search your foods',
    'aria-label': 'Search your foods',
    autocomplete: 'off',
    oninput: debounce(() => load(), 200),
  });
  const list = h('div', { class: 'list' });
  const count = h('p', { class: 'page-sub' });

  async function load() {
    const mySequence = ++sequence;
    const params = new URLSearchParams({ q: search.value.trim() });
    if (showArchived) params.set('archived', '1');
    try {
      const items = await api.get(`/api/ingredients?${params}`);
      if (mySequence !== sequence) return;
      count.textContent = `${items.length} ${items.length === 1 ? 'food' : 'foods'}${items.length === 50 ? '+' : ''}`;
      list.className = 'list stagger';
      list.replaceChildren(
        ...(items.length
          ? items.map((item, i) => row(item, i))
          : [
              h(
                'div',
                { class: 'empty-state' },
                h('h2', {}, search.value.trim() ? 'No matches' : 'No foods yet'),
                h('p', {}, 'Add foods by hand, find them on Open Food Facts, or scan a barcode.'),
              ),
            ]),
      );
    } catch (error) {
      toastError(error);
    }
  }

  function row(item, index) {
    const sub = [item.brand, `${fmt(item.protein, 1)} g protein`, item.portions.map((p) => p.label).join(', ')]
      .filter(Boolean)
      .join(' · ');
    const main = [
      h('span', { class: 'thumb thumb-placeholder' }, icon('leaf')),
      h(
        'span',
        { class: 'list-main' },
        h(
          'span',
          { class: 'list-title', style: { display: 'block' } },
          item.name,
          item.archived ? h('span', { class: 'badge badge-muted', style: { marginLeft: '6px' } }, 'Deleted') : null,
          item.referenceCode ? h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, 'NEVO') : null,
        ),
        h('span', { class: 'list-sub', style: { display: 'block' } }, sub),
      ),
    ];
    if (item.archived) {
      return h(
        'div',
        { class: 'list-item', style: { '--i': index } },
        h('span', { class: 'archived', style: { display: 'contents' } }, main),
        h(
          'button',
          {
            class: 'btn btn-soft btn-sm',
            type: 'button',
            onclick: async () => {
              try {
                await api.post(`/api/ingredients/${item.id}/restore`);
                toast(`Restored ${item.name}`);
                load();
              } catch (error) {
                toastError(error);
              }
            },
          },
          icon('restore', 16),
          'Restore',
        ),
      );
    }
    return h(
      'button',
      { class: 'list-item', type: 'button', style: { '--i': index }, onclick: () => openEditor(item) },
      main,
      h('span', { class: 'list-side' }, h('strong', {}, fmt(item.kcal)), 'kcal/100g'),
    );
  }

  function openEditor(item) {
    const sheet = openSheet({ title: item.name, content: h('div') });
    sheet.setContent(
      ingredientForm({
        initial: item,
        submitLabel: 'Save changes',
        onSubmit: async (input) => {
          await api.put(`/api/ingredients/${item.id}`, input);
          sheet.close();
          toast(`Saved ${input.name}`);
          load();
        },
        onDelete: async () => {
          if (!confirm(`Delete ${item.name}? Days you already planned keep it.`)) return;
          await api.del(`/api/ingredients/${item.id}`);
          sheet.close();
          toast(`Deleted ${item.name}`);
          load();
        },
      }),
    );
  }

  function openCreate(initial = {}, notice) {
    const sheet = openSheet({ title: initial.name ? 'Add to your foods' : 'New food', content: h('div') });
    sheet.setContent(
      ingredientForm({
        initial,
        notice,
        submitLabel: 'Save food',
        onSubmit: async (input) => {
          const saved = await saveIngredient(input);
          sheet.close();
          toast(`${saved.name} is in your foods`);
          load();
        },
      }),
    );
  }

  async function handleBarcode(code, sheet) {
    try {
      const result = await resolveBarcode(code);
      sheet?.close();
      if (result.ingredient) {
        toast(`${result.ingredient.name} is already in your foods`);
        openEditor(result.ingredient);
      } else {
        openCreate(result.candidate, result.notice);
      }
    } catch (error) {
      toastError(error);
    }
  }

  function openFinder() {
    const sheet = openSheet({ title: 'Find a food', content: h('div') });
    sheet.setContent(
      foodSearch({
        onPickIngredient: (ingredient) => {
          sheet.close();
          openEditor(ingredient);
        },
        onPickCandidate: (candidate, notice) => {
          sheet.close();
          openCreate(candidate, notice);
        },
        onPickReference: async (food) => {
          try {
            const ingredient = await adoptReference(food);
            sheet.close();
            toast(`${ingredient.name} is in your foods`);
            load();
            openEditor(ingredient);
          } catch (error) {
            toastError(error);
          }
        },
        onScanned: (code) => handleBarcode(code, sheet),
      }),
    );
  }

  container.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title' }, 'Foods'), count),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openCreate() }, icon('plus', 18), 'New'),
    ),
    h('div', { class: 'search-row' }, h('div', { class: 'search-input' }, icon('search', 18), search)),
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn btn-soft btn-sm', type: 'button', onclick: openFinder }, icon('globe', 16), 'Find online'),
      h(
        'button',
        {
          class: 'btn btn-soft btn-sm',
          type: 'button',
          onclick: async () => {
            const code = await scanBarcode();
            if (code) handleBarcode(code);
          },
        },
        icon('scan', 16),
        'Scan',
      ),
      h('span', { class: 'spacer' }),
      h(
        'label',
        { class: 'toggle' },
        h('input', {
          type: 'checkbox',
          onchange: (event) => {
            showArchived = event.target.checked;
            load();
          },
        }),
        'Show deleted',
      ),
    ),
    list,
  );
  await load();
}
