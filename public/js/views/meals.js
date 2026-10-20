/** Saved meals: the list (#/meals) and the editor (#/meals/new, #/meals/:id). */
import { api } from '../api.js';
import { roundNutrients, scaleNutrients, sumNutrients } from '../shared/nutrition.js';
import { h, fmt } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openSheet } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';
import { amountStep, per100Of, statTiles } from '../ui/amount-step.js';
import { openFoodPicker } from '../ui/add-food.js';

/**
 * @param {HTMLElement} container
 * @param {{id?: string}} params
 */
export async function render(container, { id }) {
  if (id) return renderEditor(container, id);
  return renderList(container);
}

async function renderList(container) {
  const meals = await api.get('/api/meals');
  container.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', { class: 'page-title' }, 'Meals'),
        h('p', { class: 'page-sub' }, 'Your usual meals, ready to add in one tap.'),
      ),
      h('a', { class: 'btn btn-sm', href: '#/meals/new' }, icon('plus', 18), 'New meal'),
    ),
    meals.length
      ? h(
          'div',
          { class: 'meal-list stagger' },
          meals.map((meal, index) =>
            h(
              'a',
              { class: 'meal-tile', href: `#/meals/${meal.id}`, style: { '--i': index, color: 'inherit', textDecoration: 'none' } },
              h('h3', {}, meal.name),
              h('p', {}, meal.items.map((item) => item.name).join(', ')),
              h(
                'div',
                { class: 'meal-tile-stats' },
                h('span', { class: 'kcal-text' }, `${fmt(meal.totals.kcal)} kcal`),
                h('span', { class: 'protein-text' }, `${fmt(meal.totals.protein, 1)} g protein`),
                h('span', { class: 'muted' }, `${fmt(meal.totals.carbs)} g carbs · ${fmt(meal.totals.fat)} g fat`),
              ),
            ),
          ),
        )
      : h(
          'div',
          { class: 'empty-state' },
          h('h2', {}, 'No saved meals yet'),
          h('p', {}, 'Build your usual breakfast once, then add it to any day with one tap.'),
          h('a', { class: 'btn', href: '#/meals/new' }, icon('plus', 18), 'Create a meal'),
        ),
  );
}

/** @returns {Record<string, number>} rounded totals for editor items */
function totalsOf(items) {
  return roundNutrients(sumNutrients(items.map((item) => scaleNutrients(item.per100, item.grams))));
}

async function renderEditor(container, id) {
  const isNew = id === 'new';
  const meal = isNew ? { name: '', items: [] } : await api.get(`/api/meals/${id}`);
  const items = meal.items.map((item) => ({ ...item }));

  const name = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '80',
    placeholder: 'e.g. Chicken rice bowl',
    value: meal.name,
    'aria-label': 'Meal name',
    style: { fontSize: '20px', fontWeight: '700' },
  });
  const totalsHost = h('div', { class: 'sticky-totals' });
  const itemsHost = h('div', { class: 'list' });
  const saveButton = h('button', { class: 'btn btn-block', type: 'button', onclick: save }, icon('check', 18), 'Save meal');

  function draw() {
    totalsHost.replaceChildren(statTiles(totalsOf(items)));
    itemsHost.replaceChildren(
      ...(items.length
        ? items.map((item, index) =>
            h(
              'button',
              { class: 'list-item', type: 'button', onclick: () => editItem(index) },
              h(
                'span',
                { class: 'list-main' },
                h(
                  'span',
                  { class: 'list-title', style: { display: 'block' } },
                  item.name,
                  item.archived ? h('span', { class: 'badge badge-muted', style: { marginLeft: '6px' } }, 'archived') : null,
                ),
                h('span', { class: 'list-sub', style: { display: 'block' } }, `${fmt(item.grams, 1)} g`),
              ),
              h(
                'span',
                { class: 'list-side' },
                h('strong', {}, fmt(roundNutrients(scaleNutrients(item.per100, item.grams)).kcal)),
                'kcal',
              ),
            ),
          )
        : [h('p', { class: 'muted', style: { margin: '4px' } }, 'No ingredients yet.')]),
    );
  }

  function editItem(index) {
    const item = items[index];
    const sheet = openSheet({ title: 'Edit amount', content: h('div') });
    sheet.setContent(
      h(
        'div',
        {},
        amountStep({
          ingredient: item,
          initialGrams: item.grams,
          confirmLabel: 'Update',
          onConfirm: (grams) => {
            item.grams = grams;
            draw();
            sheet.close();
          },
        }),
        h(
          'button',
          {
            class: 'btn btn-danger btn-block',
            type: 'button',
            style: { marginTop: '10px' },
            onclick: () => {
              items.splice(index, 1);
              draw();
              sheet.close();
            },
          },
          icon('trash', 18),
          'Remove from meal',
        ),
      ),
    );
  }

  function addIngredient() {
    openFoodPicker({
      title: 'Add ingredient',
      confirmLabel: () => 'Add to meal',
      onAddIngredient: async (ingredient, grams) => {
        items.push({
          ingredientId: ingredient.id,
          name: ingredient.name,
          brand: ingredient.brand,
          grams,
          archived: false,
          per100: per100Of(ingredient),
          portions: ingredient.portions,
        });
        draw();
      },
    });
  }

  async function save() {
    saveButton.classList.add('loading');
    try {
      const body = { name: name.value, items: items.map(({ ingredientId, grams }) => ({ ingredientId, grams })) };
      const saved = isNew ? await api.post('/api/meals', body) : await api.put(`/api/meals/${id}`, body);
      toast(`Saved “${saved.name}”`);
      location.hash = '#/meals';
    } catch (error) {
      toastError(error);
    } finally {
      saveButton.classList.remove('loading');
    }
  }

  async function remove() {
    if (!confirm(`Delete “${meal.name}”? Days you already planned keep their foods.`)) return;
    try {
      await api.del(`/api/meals/${id}`);
      toast(`Deleted “${meal.name}”`);
      location.hash = '#/meals';
    } catch (error) {
      toastError(error);
    }
  }

  draw();
  container.replaceChildren(
    h('a', { class: 'back-link', href: '#/meals', style: { textDecoration: 'none' } }, icon('back', 16), 'Meals'),
    h('div', { class: 'field' }, name),
    totalsHost,
    h('div', { class: 'section-label' }, 'Ingredients'),
    itemsHost,
    h(
      'button',
      { class: 'btn btn-soft btn-block', type: 'button', style: { marginTop: '10px' }, onclick: addIngredient },
      icon('plus', 18),
      'Add ingredient',
    ),
    h(
      'div',
      { class: 'actions', style: { flexDirection: 'column' } },
      saveButton,
      isNew ? null : h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: remove }, icon('trash', 18), 'Delete meal'),
    ),
  );
  if (isNew) setTimeout(() => name.focus({ preventScroll: true }), 50);
}
