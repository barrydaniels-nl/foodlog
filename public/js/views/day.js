/** The day planner: target rings plus Breakfast / Lunch / Dinner / Snacks. */
import { api } from '../api.js';
import { MEAL_SLOTS, SLOT_LABELS } from '../shared/constants.js';
import { addDays, formatDayTitle, isIsoDate, toIsoDate } from '../shared/dates.js';
import { h, fmt, guarded } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { ring } from '../ui/ring.js';
import { openSheet, segmented } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';
import { amountStep } from '../ui/amount-step.js';
import { openAddFood } from '../ui/add-food.js';
import { foodAvatar, kcalLine, macroColumns } from '../ui/macros.js';

const SWIPE_MIN_X = 60;
const SWIPE_MAX_Y = 40;

/**
 * Picks the meal you are most likely planning right now.
 * @param {Date} now
 * @returns {string}
 */
function slotForTime(now) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 10 * 60 + 30) return 'breakfast';
  if (minutes < 15 * 60) return 'lunch';
  if (minutes < 21 * 60) return 'dinner';
  return 'snacks';
}

function goToDate(date) {
  location.hash = `#/day/${date}`;
}

/**
 * @param {HTMLElement} container
 * @param {{date: string}} params
 */
export async function render(container, { date }) {
  const today = toIsoDate(new Date());
  let day = await api.get(`/api/days/${date}`);

  const addNow = () => openAddFood({ date, slot: slotForTime(new Date()), onDay: update });
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'Add food', onclick: addNow }, icon('plus', 28));
  const content = h('div');
  container.replaceChildren(content, fab);

  function update(newDay) {
    day = newDay;
    draw(false);
  }

  function draw(animate = true) {
    content.replaceChildren(header(), summary(), meals(animate));
  }

  function header() {
    const { title, subtitle } = formatDayTitle(date, today);
    return h(
      'div',
      { class: 'day-head' },
      h(
        'div',
        { class: 'day-titles' },
        h('h1', { class: 'page-title' }, title),
        h('p', { class: 'page-sub' }, subtitle),
      ),
      date !== today
        ? h('button', { class: 'btn btn-soft btn-sm today-pill', type: 'button', onclick: () => goToDate(today) }, 'Today')
        : null,
      h('button', { class: 'btn btn-sm desktop-only', type: 'button', onclick: addNow }, icon('plus', 18), 'Add food'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous day', onclick: () => goToDate(addDays(date, -1)) }, icon('left')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next day', onclick: () => goToDate(addDays(date, 1)) }, icon('right')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Day options', onclick: openDayMenu }, icon('more')),
    );
  }

  function summary() {
    const { totals, targets } = day;
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'rings' },
        ring({ value: totals.kcal, target: targets.kcal, color: '#3f9c5f', track: '#e5ece6', label: 'kcal' }),
        ring({ value: Math.round(totals.protein), target: targets.protein, color: '#5b6cf0', track: '#e8e9f6', label: 'protein', unit: ' g' }),
      ),
      h(
        'div',
        { class: 'macros' },
        h('div', {}, 'Carbs ', h('b', {}, `${fmt(totals.carbs)} g`)),
        h('div', {}, 'Fat ', h('b', {}, `${fmt(totals.fat)} g`)),
        h('div', {}, 'Fibre ', h('b', {}, `${fmt(totals.fiber)} g`)),
      ),
    );
  }

  function meals(animate) {
    return h(
      'div',
      { class: ['meal-grid', animate && 'stagger'] },
      MEAL_SLOTS.map((slot, i) => mealCard(slot, i)),
    );
  }

  function mealCard(slot, index) {
    const { entries, totals } = day.slots[slot];
    return h(
      'section',
      { class: 'meal-card', style: { '--i': index }, 'aria-label': SLOT_LABELS[slot] },
      h(
        'div',
        { class: 'meal-head' },
        h('h2', { class: 'meal-name' }, SLOT_LABELS[slot]),
        entries.length ? kcalLine(totals.kcal) : null,
        entries.length
          ? h(
              'button',
              { class: 'icon-btn', type: 'button', 'aria-label': `${SLOT_LABELS[slot]} options`, onclick: () => openSlotMenu(slot) },
              icon('more', 18),
            )
          : null,
      ),
      entries.length ? h('div', { class: 'meal-summary' }, macroColumns(totals)) : null,
      entries.length
        ? h(
            'div',
            { class: 'food-cards' },
            entries.map((entry) =>
              h(
                'button',
                { class: 'food-card', type: 'button', onclick: () => openEntry(entry) },
                foodAvatar(entry.name),
                h(
                  'span',
                  { class: 'food-main' },
                  h('span', { class: 'food-name' }, entry.name),
                  kcalLine(entry.nutrients.kcal, `${fmt(entry.grams, 1)} g`),
                ),
                h('span', { class: 'food-more', 'aria-hidden': 'true' }, icon('more', 18)),
                macroColumns(entry.nutrients),
              ),
            ),
          )
        : h('p', { class: 'meal-empty' }, 'Nothing planned yet'),
      h(
        'button',
        { class: 'meal-add', type: 'button', onclick: () => openAddFood({ date, slot, onDay: update }) },
        icon('plus', 16),
        'Add food',
      ),
    );
  }

  async function openEntry(entry) {
    let slot = entry.slot;
    // Portions live on the ingredient; the entry still works if that lookup fails.
    const ingredient = await api.get(`/api/ingredients/${entry.ingredientId}`).catch(() => null);
    const sheet = openSheet({ title: 'Edit', content: h('div') });
    const remove = h(
      'button',
      {
        class: 'btn btn-danger btn-block',
        type: 'button',
        style: { marginTop: '10px' },
        onclick: guarded(async () => {
          try {
            update(await api.del(`/api/entries/${entry.id}`));
            sheet.close();
            toast(`Removed ${entry.name}`);
          } catch (error) {
            toastError(error);
          }
        }),
      },
      icon('trash', 18),
      'Remove',
    );
    sheet.setContent(
      h(
        'div',
        {},
        amountStep({
          ingredient: { ...entry, portions: ingredient?.portions ?? [] },
          initialGrams: entry.grams,
          confirmLabel: 'Save',
          extra: h(
            'div',
            {},
            h('div', { class: 'field-label', style: { margin: '4px 0 8px' } }, 'Meal'),
            segmented(
              MEAL_SLOTS.map((value) => ({ value, label: SLOT_LABELS[value] })),
              slot,
              (value) => (slot = value),
            ),
          ),
          onConfirm: async (grams) => {
            try {
              update(await api.patch(`/api/entries/${entry.id}`, { grams, slot }));
              sheet.close();
            } catch (error) {
              toastError(error);
            }
          },
        }),
        remove,
      ),
    );
  }

  function openSlotMenu(slot) {
    const name = h('input', {
      class: 'input',
      type: 'text',
      maxlength: '80',
      value: `My ${SLOT_LABELS[slot].toLowerCase()}`,
      'aria-label': 'Meal name',
    });
    const sheet = openSheet({
      title: `Save ${SLOT_LABELS[slot].toLowerCase()} as a meal`,
      content: h(
        'form',
        {
          onsubmit: guarded(async (event) => {
            event.preventDefault();
            try {
              const meal = await api.post('/api/meals/from-slot', { date, slot, name: name.value });
              sheet.close();
              toast(`Saved “${meal.name}” to Meals`);
            } catch (error) {
              toastError(error);
            }
          }),
        },
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'Reuse these foods with one tap next time.'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
        h('button', { class: 'btn btn-block', type: 'submit' }, icon('bookmark', 18), 'Save meal'),
      ),
    });
    setTimeout(() => name.select(), 320);
  }

  function openDayMenu() {
    const otherDate = h('input', { class: 'input', type: 'date', value: addDays(date, -7), 'aria-label': 'Day to copy' });
    const sheet = openSheet({ title: 'Plan options', content: h('div') });

    const copyFrom = guarded(async (fromDate) => {
      if (!isIsoDate(fromDate)) return;
      try {
        update(await api.post(`/api/days/${date}/copy`, { fromDate }));
        sheet.close();
        toast(`Copied ${formatDayTitle(fromDate, today).subtitle}`);
      } catch (error) {
        toastError(error);
      }
    });

    sheet.setContent(
      h(
        'div',
        {},
        h(
          'button',
          { class: 'list-item', type: 'button', onclick: () => copyFrom(addDays(date, -1)) },
          h('span', { class: 'thumb thumb-placeholder' }, icon('copy')),
          h(
            'span',
            { class: 'list-main' },
            h('span', { class: 'list-title', style: { display: 'block' } }, 'Copy the day before'),
            h('span', { class: 'list-sub', style: { display: 'block' } }, `Adds everything from ${formatDayTitle(addDays(date, -1), today).subtitle}`),
          ),
        ),
        h('div', { class: 'section-label' }, 'Copy from another day'),
        h(
          'div',
          { class: 'search-row' },
          h('div', { style: { flex: 1 } }, otherDate),
          h('button', { class: 'btn', type: 'button', onclick: () => copyFrom(otherDate.value) }, 'Copy'),
        ),
      ),
    );
  }

  // Swipe left/right to change day; arrow keys on desktop.
  let touchStart = null;
  container.addEventListener(
    'touchstart',
    (e) => (touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }),
    { passive: true },
  );
  container.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > SWIPE_MIN_X && Math.abs(dy) < SWIPE_MAX_Y) goToDate(addDays(date, dx < 0 ? 1 : -1));
  });
  function onKey(event) {
    if (document.querySelector('.sheet-backdrop') || event.target.closest('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') goToDate(addDays(date, -1));
    if (event.key === 'ArrowRight') goToDate(addDays(date, 1));
  }
  document.addEventListener('keydown', onKey);

  // A home-screen app can stay open overnight; re-render when the date changed.
  function onResume() {
    if (document.visibilityState !== 'visible') return;
    const now = toIsoDate(new Date());
    if (now === today) return;
    if (date === today) goToDate(now);
    else window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('pageshow', onResume);

  draw();
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onResume);
    window.removeEventListener('pageshow', onResume);
  };
}
