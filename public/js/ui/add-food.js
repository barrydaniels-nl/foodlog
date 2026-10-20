/**
 * The "pick a food and an amount" flow, in one sheet: search → (create or
 * confirm a food) → amount → done. Used by the day planner and the meal editor.
 */
import { api } from '../api.js';
import { MEAL_SLOTS, NUTRIENT_KEYS, SLOT_LABELS } from '../shared/constants.js';
import { roundNutrients } from '../shared/nutrition.js';
import { resolveBarcode, saveIngredient } from '../food-lookup.js';
import { h, fmt, guarded } from './dom.js';
import { icon } from './icons.js';
import { openSheet, segmented } from './sheet.js';
import { toast, toastError } from './toast.js';
import { amountStep, statTiles } from './amount-step.js';
import { foodSearch } from './food-search.js';
import { ingredientForm } from './ingredient-form.js';

const MEAL_SCALES = [0.5, 1, 1.5, 2];

/**
 * @param {{
 *   title: string,
 *   includeMeals?: boolean,
 *   header?: Node,
 *   confirmLabel: () => string,
 *   onAddIngredient: (ingredient: object, grams: number) => Promise<void>,
 *   onAddMeal?: (meal: object, scale: number) => Promise<void>,
 * }} options
 * @returns {{refreshLabels: () => void}}
 */
export function openFoodPicker({ title, includeMeals = false, header, confirmLabel, onAddIngredient, onAddMeal }) {
  const host = h('div');
  const sheet = openSheet({ title, content: h('div', {}, header, host) });

  function show(node) {
    host.replaceChildren(node);
    sheet.body.scrollTop = 0;
  }

  const backLink = () =>
    h('button', { class: 'back-link', type: 'button', onclick: showSearch }, icon('back', 16), 'Back to search');

  async function run(action) {
    try {
      await action();
      sheet.close();
    } catch (error) {
      toastError(error);
    }
  }

  function showSearch() {
    show(
      foodSearch({
        includeMeals,
        onPickIngredient: showAmount,
        onPickMeal: showMeal,
        onPickCandidate: showForm,
        onScanned: handleBarcode,
      }),
    );
  }

  function showAmount(ingredient) {
    const step = amountStep({
      ingredient,
      confirmLabel: confirmLabel(),
      onConfirm: (grams) => run(() => onAddIngredient(ingredient, grams)),
    });
    step.querySelector('.actions .btn').dataset.confirm = '';
    show(h('div', {}, backLink(), step));
  }

  function showMeal(meal) {
    let scale = 1;
    const preview = h('div');
    const draw = () => {
      const totals = Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, meal.totals[key] * scale]));
      preview.replaceChildren(
        statTiles(roundNutrients(totals)),
        h(
          'div',
          { class: 'list' },
          meal.items.map((item) =>
            h(
              'div',
              { class: 'list-item' },
              h('span', { class: 'list-main' }, h('span', { class: 'list-title', style: { display: 'block' } }, item.name)),
              h('span', { class: 'list-side' }, `${fmt(item.grams * scale, 1)} g`),
            ),
          ),
        ),
      );
    };
    draw();
    const button = h(
      'button',
      {
        class: 'btn btn-block',
        type: 'button',
        'data-confirm': '',
        onclick: guarded(() => run(() => onAddMeal(meal, scale))),
      },
      confirmLabel(),
    );
    show(
      h(
        'div',
        {},
        backLink(),
        h('div', { class: 'food-head' }, h('h3', { class: 'food-head-name' }, meal.name), h('p', { class: 'food-head-sub' }, 'Saved meal')),
        h('div', { class: 'field-label', style: { marginBottom: '8px' } }, 'Portion size'),
        segmented(
          MEAL_SCALES.map((value) => ({ value: String(value), label: `×${value}` })),
          '1',
          (value) => {
            scale = Number(value);
            draw();
          },
        ),
        preview,
        h('div', { class: 'actions' }, button),
      ),
    );
  }

  function showForm(candidate, notice) {
    show(
      h(
        'div',
        {},
        backLink(),
        ingredientForm({
          initial: candidate,
          notice,
          submitLabel: 'Save and continue',
          onSubmit: async (input) => {
            const ingredient = await saveIngredient(input);
            toast(`${ingredient.name} is in your foods`);
            showAmount(ingredient);
          },
        }),
      ),
    );
  }

  async function handleBarcode(code) {
    try {
      const result = await resolveBarcode(code);
      if (result.ingredient) showAmount(result.ingredient);
      else showForm(result.candidate, result.notice);
    } catch (error) {
      toastError(error);
    }
  }

  showSearch();
  return {
    refreshLabels() {
      for (const button of host.querySelectorAll('[data-confirm]')) button.textContent = confirmLabel();
    },
  };
}

/**
 * Adds a food or saved meal to one meal slot of a day.
 * @param {{date: string, slot: string, onDay: (day: object) => void}} options
 */
export function openAddFood({ date, slot, onDay }) {
  let current = slot;
  const label = () => SLOT_LABELS[current];
  const picker = openFoodPicker({
    title: 'Add food',
    includeMeals: true,
    header: segmented(
      MEAL_SLOTS.map((value) => ({ value, label: SLOT_LABELS[value] })),
      current,
      (value) => {
        current = value;
        picker.refreshLabels();
      },
    ),
    confirmLabel: () => `Add to ${label()}`,
    onAddIngredient: async (ingredient, grams) => {
      onDay(await api.post(`/api/days/${date}/entries`, { slot: current, ingredientId: ingredient.id, grams }));
      toast(`Added ${ingredient.name} to ${label()}`);
    },
    onAddMeal: async (meal, scale) => {
      onDay(await api.post(`/api/days/${date}/meals`, { slot: current, mealId: meal.id, scale }));
      toast(`Added ${meal.name} to ${label()}`);
    },
  });
}
