/**
 * Search box over saved meals, your own foods and Open Food Facts, with an
 * optional barcode-scan button. It only reports picks; the host decides what
 * happens next.
 */
import { api } from '../api.js';
import { h, fmt, debounce } from './dom.js';
import { icon } from './icons.js';
import { scanBarcode, scannerAvailable } from '../scanner.js';

const DEBOUNCE_MS = 200;
const OFF_MIN_CHARS = 2;

function ingredientItem(ingredient, onPick) {
  return h(
    'button',
    { class: 'list-item', type: 'button', onclick: () => onPick(ingredient) },
    h('span', { class: 'thumb thumb-placeholder' }, icon('leaf')),
    h(
      'span',
      { class: 'list-main' },
      h('span', { class: 'list-title', style: { display: 'block' } }, ingredient.name),
      h(
        'span',
        { class: 'list-sub', style: { display: 'block' } },
        [ingredient.brand, `${fmt(ingredient.protein, 1)} g protein`].filter(Boolean).join(' · '),
      ),
    ),
    h('span', { class: 'list-side' }, h('strong', {}, fmt(ingredient.kcal)), 'kcal/100g'),
  );
}

function mealItem(meal, onPick) {
  return h(
    'button',
    { class: 'list-item', type: 'button', onclick: () => onPick(meal) },
    h('span', { class: 'thumb thumb-placeholder', style: { color: 'var(--indigo)' } }, icon('bowl')),
    h(
      'span',
      { class: 'list-main' },
      h('span', { class: 'list-title', style: { display: 'block' } }, meal.name, ' ', h('span', { class: 'badge badge-meal' }, 'Meal')),
      h('span', { class: 'list-sub', style: { display: 'block' } }, meal.items.map((item) => item.name).join(', ')),
    ),
    h('span', { class: 'list-side' }, h('strong', {}, fmt(meal.totals.kcal)), 'kcal'),
  );
}

function candidateItem(candidate, onPick) {
  return h(
    'button',
    { class: 'list-item', type: 'button', onclick: () => onPick(candidate) },
    candidate.imageUrl
      ? h('img', { class: 'thumb', src: candidate.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('span', { class: 'thumb thumb-placeholder' }, icon('globe')),
    h(
      'span',
      { class: 'list-main' },
      h('span', { class: 'list-title', style: { display: 'block' } }, candidate.name),
      h(
        'span',
        { class: 'list-sub', style: { display: 'block' } },
        candidate.brand ?? '',
        candidate.complete ? null : h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, 'needs values'),
      ),
    ),
    h('span', { class: 'list-side' }, h('strong', {}, candidate.kcal === null ? '–' : fmt(candidate.kcal)), 'kcal/100g'),
  );
}

/**
 * @param {{
 *   includeMeals?: boolean,
 *   onPickIngredient: (ingredient: object) => void,
 *   onPickMeal?: (meal: object) => void,
 *   onPickCandidate: (candidate: object, notice?: string) => void,
 *   onScanned?: (barcode: string) => void,
 * }} options
 * @returns {HTMLElement}
 */
export function foodSearch({ includeMeals = false, onPickIngredient, onPickMeal, onPickCandidate, onScanned }) {
  let localSequence = 0;
  let offSequence = 0;
  // The query whose Open Food Facts results are loading or shown.
  let offQuery = null;
  const mealsPromise = includeMeals ? api.get('/api/meals').catch(() => []) : Promise.resolve([]);

  const input = h('input', {
    class: 'input',
    type: 'search',
    placeholder: includeMeals ? 'Search meals and foods' : 'Search your foods',
    'aria-label': 'Search',
    autocomplete: 'off',
    enterkeyhint: 'search',
    oninput: debounce(() => safeRefresh(), DEBOUNCE_MS),
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (input.value.trim().length >= OFF_MIN_CHARS) searchOff();
      }
    },
  });
  const local = h('div', { class: 'results' });
  const off = h('div', { class: 'off-block' });

  const scanButton =
    onScanned && scannerAvailable()
      ? h(
          'button',
          {
            class: 'icon-btn boxed',
            type: 'button',
            'aria-label': 'Scan barcode',
            style: { width: '48px', height: '48px' },
            onclick: async () => {
              const code = await scanBarcode();
              if (code) onScanned(code);
            },
          },
          icon('scan', 22),
        )
      : null;

  function section(label, items) {
    return items.length ? [h('div', { class: 'section-label' }, label), h('div', { class: 'list' }, items)] : [];
  }

  async function refresh() {
    const mySequence = ++localSequence;
    const q = input.value.trim();
    let ingredients;
    let heading = 'Your foods';
    if (q) {
      ingredients = await api.get(`/api/ingredients?q=${encodeURIComponent(q)}`);
    } else {
      ingredients = await api.get('/api/ingredients?recent=1');
      heading = 'Recent';
      if (ingredients.length === 0) {
        ingredients = await api.get('/api/ingredients');
        heading = 'Your foods';
      }
    }
    const meals = (await mealsPromise).filter((meal) => !q || meal.name.toLowerCase().includes(q.toLowerCase()));
    if (mySequence !== localSequence) return;

    const nothing = !ingredients.length && !meals.length;
    const hint = q ? `No “${q}” in your foods yet.` : 'Your food list is empty. Search Open Food Facts or create a food.';
    local.replaceChildren(
      ...section('Meals', meals.map((meal) => mealItem(meal, onPickMeal))),
      ...section(heading, ingredients.map((ingredient) => ingredientItem(ingredient, onPickIngredient))),
      ...(nothing ? [h('p', { class: 'muted', style: { margin: '14px 4px 0' } }, hint)] : []),
    );
    if (q !== offQuery) {
      offSequence += 1;
      offQuery = null;
      off.replaceChildren(offActions(q));
    }
  }

  function offActions(q) {
    return h(
      'div',
      { class: 'chips', style: { gap: '8px' } },
      q.length >= OFF_MIN_CHARS
        ? h('button', { class: 'btn btn-soft btn-sm', type: 'button', onclick: searchOff }, icon('globe', 16), `Search Open Food Facts`)
        : null,
      h(
        'button',
        { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => onPickCandidate({ name: q }) },
        icon('plus', 16),
        q ? `Create “${q}”` : 'Create a food',
      ),
    );
  }

  async function searchOff() {
    const q = input.value.trim();
    const mySequence = ++offSequence;
    offQuery = q;
    off.replaceChildren(
      h('div', { class: 'section-label' }, 'Open Food Facts'),
      h('div', { class: 'skeleton' }),
      h('div', { class: 'skeleton' }),
      h('div', { class: 'skeleton' }),
    );
    try {
      const candidates = await api.get(`/api/off/search?q=${encodeURIComponent(q)}`);
      if (mySequence !== offSequence) return;
      off.replaceChildren(
        h('div', { class: 'section-label' }, 'Open Food Facts'),
        candidates.length
          ? h('div', { class: 'list' }, candidates.map((candidate) => candidateItem(candidate, onPickCandidate)))
          : h('p', { class: 'muted', style: { margin: '4px' } }, 'No products found.'),
        h('div', { style: { marginTop: '12px' } }, offActions('')),
      );
    } catch (error) {
      if (mySequence !== offSequence) return;
      off.replaceChildren(
        h('p', { class: 'form-error' }, error.message),
        h('button', { class: 'btn btn-soft btn-sm', type: 'button', onclick: searchOff }, 'Try again'),
      );
    }
  }

  function safeRefresh() {
    refresh().catch((error) => {
      console.error(error);
      local.replaceChildren(h('p', { class: 'form-error' }, error.message));
    });
  }

  safeRefresh();
  setTimeout(() => input.focus({ preventScroll: true }), 320);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'search-row' },
      h('div', { class: 'search-input' }, icon('search', 18), input),
      scanButton,
    ),
    local,
    off,
  );
}
