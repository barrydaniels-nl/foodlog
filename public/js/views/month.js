/** Month overview: kcal, protein, fibre and fat per day, linking to each day. */
import { api } from '../api.js';
import { addMonths, formatMonthTitle, formatShortDay, toIsoDate, weekdayIndex } from '../shared/dates.js';
import { averageNutrients, roundNutrients } from '../shared/nutrition.js';
import { h, fmt } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const COLUMNS = [
  { key: 'kcal', label: 'kcal', unit: '' },
  { key: 'protein', label: 'protein', unit: ' g' },
  { key: 'fiber', label: 'fibre', unit: ' g' },
  { key: 'fat', label: 'fat', unit: ' g' },
];

function goToMonth(month) {
  location.hash = `#/month/${month}`;
}

/**
 * @param {HTMLElement} container
 * @param {{month?: string}} params defaults to the current month
 */
export async function render(container, { month = toIsoDate(new Date()).slice(0, 7) }) {
  const today = toIsoDate(new Date());
  const thisMonth = today.slice(0, 7);
  const { days, targets } = await api.get(`/api/months/${month}`);
  const logged = days.filter((day) => day.entryCount > 0);
  // Today and future days are still being planned, so they would skew the average.
  const complete = logged.filter((day) => day.date < today);

  container.replaceChildren(header(), averages(), legend(), grid());

  function header() {
    return h(
      'div',
      { class: 'day-head' },
      h(
        'div',
        { class: 'day-titles' },
        h('h1', { class: 'page-title' }, formatMonthTitle(month)),
        h('p', { class: 'page-sub' }, `${logged.length} of ${days.length} days logged`),
      ),
      month !== thisMonth
        ? h('button', { class: 'btn btn-soft btn-sm today-pill', type: 'button', onclick: () => goToMonth(thisMonth) }, 'This month')
        : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onclick: () => goToMonth(addMonths(month, -1)) }, icon('left')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onclick: () => goToMonth(addMonths(month, 1)) }, icon('right')),
    );
  }

  function averages() {
    if (complete.length === 0) return null;
    const average = roundNutrients(averageNutrients(complete.map((day) => day.totals)));
    return h(
      'div',
      {},
      h('p', { class: 'section-label' }, `Daily average · ${complete.length} completed ${complete.length === 1 ? 'day' : 'days'}`),
      h(
        'div',
        { class: 'stats' },
        COLUMNS.map(({ key, label, unit }) =>
          h('div', { class: ['stat', key] }, h('b', {}, `${fmt(average[key], key === 'kcal' ? 0 : 1)}${unit}`), h('span', {}, label)),
        ),
      ),
    );
  }

  function legend() {
    const key = (flag, text) => h('span', { class: 'month-key' }, h('span', { class: ['month-swatch', flag], 'aria-hidden': 'true' }), text);
    return h(
      'p',
      { class: 'month-legend' },
      key('over', `Over ${fmt(targets.kcal)} kcal`),
      key('met', `${fmt(targets.protein)} g protein reached`),
    );
  }

  function grid() {
    // Blank cells line the 1st up under its weekday; the phone list hides them.
    const blanks = Array.from({ length: weekdayIndex(days[0].date) }, () => h('span', { class: 'month-blank', 'aria-hidden': 'true' }));
    return h(
      'div',
      { class: 'month-grid stagger' },
      WEEKDAY_HEADS.map((name) => h('span', { class: 'month-weekday', 'aria-hidden': 'true' }, name)),
      blanks,
      days.map((day, i) => dayCell(day, i)),
    );
  }

  function dayCell({ date, entryCount, totals }, index) {
    const [weekday, dayNumber] = formatShortDay(date).split(' ');
    const flags = {
      kcal: totals.kcal > targets.kcal && 'over',
      protein: totals.protein >= targets.protein && 'met',
    };
    return h(
      'a',
      {
        class: ['month-day', date === today && 'is-today', date > today && 'is-future', entryCount === 0 && 'is-empty'],
        href: `#/day/${date}`,
        style: { '--i': Math.min(index, 12) },
        'aria-current': date === today ? 'date' : null,
      },
      h('span', { class: 'month-date' }, h('span', { class: 'month-date-weekday' }, weekday), h('b', {}, dayNumber)),
      entryCount === 0
        ? h('span', { class: 'month-nothing' }, '—')
        : h(
            'span',
            { class: 'month-values' },
            COLUMNS.map(({ key, label, unit }) =>
              h(
                'span',
                { class: ['month-value', `month-${key}`, flags[key]] },
                h('b', {}, `${fmt(totals[key])}${unit}`),
                h('span', {}, label),
              ),
            ),
          ),
    );
  }
}
