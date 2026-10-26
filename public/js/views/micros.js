/** Micros page: the 23 tracked micronutrients for one day or the daily average of a month. */
import { api } from '../api.js';
import { addDays, addMonths, formatDayTitle, formatMonthTitle, toIsoDate } from '../shared/dates.js';
import { h, fmt, guarded } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { microRows } from '../ui/micro-rows.js';
import { openSheet, segmented } from '../ui/sheet.js';
import { toast, toastError } from '../ui/toast.js';

const UNITS_STEP = 0.5;
const UNITS_MIN = 0.5;
const UNITS_MAX = 20;
const SUPPLEMENTS_HREF = '#/micros/supplements';
const REVIEW_HREF = '#/micros/review';

const Mode = Object.freeze({ DAY: 'day', MONTH: 'month' });

/** Keeps repeated +-0.5 steps free of floating-point noise. */
const roundUnits = (units) => Number(units.toFixed(2));

/**
 * Native replaceChildren would print an optional (null) child as the text "null".
 * @param {HTMLElement} element
 * @param {Array<Node|null>} children
 */
function setChildren(element, children) {
  element.replaceChildren(...children.filter(Boolean));
}

function goTo(hash) {
  location.hash = hash;
}

/** @returns {HTMLElement|null} a banner pointing at Settings when the sex/birth year profile is missing */
function profileBanner(profile) {
  if (profile) return null;
  return h(
    'p',
    { class: 'notice' },
    'Set your sex and birth year in ',
    h('a', { href: '#/settings' }, 'Settings'),
    ' to compare with what you need.',
  );
}

/**
 * @param {{missingFoods: number, missingGrams: number}} coverage
 * @returns {HTMLElement|null}
 */
function coverageLine({ missingFoods, missingGrams }) {
  if (missingFoods === 0) return null;
  const subject = missingFoods === 1 ? '1 food' : `${fmt(missingFoods)} foods`;
  const verb = missingFoods === 1 ? 'has' : 'have';
  return h(
    'p',
    { class: 'micro-coverage' },
    `${subject} (${fmt(missingGrams)} g) ${verb} no micronutrient data · `,
    h('a', { href: REVIEW_HREF }, 'Review matches'),
  );
}

/**
 * @param {HTMLElement} container
 * @param {{mode?: 'day'|'month', date?: string, month?: string}} params day mode defaults to today, month mode to this month
 */
export async function render(container, { mode = Mode.DAY, date, month }) {
  const today = toIsoDate(new Date());
  const thisMonth = today.slice(0, 7);
  return mode === Mode.MONTH
    ? renderMonth(container, { month: month ?? thisMonth, today, thisMonth })
    : renderDay(container, { date: date ?? today, today });
}

function modeSwitch(mode, onChange) {
  return segmented(
    [
      { value: Mode.DAY, label: 'Day' },
      { value: Mode.MONTH, label: 'Month' },
    ],
    mode,
    (value) => value !== mode && onChange(value),
  );
}

function pageHeader({ title, subtitle, pill, label, onPrevious, onNext }) {
  return h(
    'div',
    { class: 'day-head' },
    h('div', { class: 'day-titles' }, h('h1', { class: 'page-title' }, title), h('p', { class: 'page-sub' }, subtitle)),
    pill ? h('button', { class: 'btn btn-soft btn-sm today-pill', type: 'button', onclick: pill.onclick }, pill.label) : null,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Previous ${label}`, onclick: onPrevious }, icon('left')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Next ${label}`, onclick: onNext }, icon('right')),
  );
}

async function renderMonth(container, { month, today, thisMonth }) {
  const summary = await api.get(`/api/micros/months/${month}`);
  const { completedDays } = summary;

  setChildren(container, [
    pageHeader({
      title: formatMonthTitle(month),
      subtitle: 'Micronutrients',
      pill: month !== thisMonth ? { label: 'This month', onclick: () => goTo(`#/micros/month/${thisMonth}`) } : null,
      label: 'month',
      onPrevious: () => goTo(`#/micros/month/${addMonths(month, -1)}`),
      onNext: () => goTo(`#/micros/month/${addMonths(month, 1)}`),
    }),
    modeSwitch(Mode.MONTH, () => goTo(`#/micros/day/${month === thisMonth ? today : `${month}-01`}`)),
    profileBanner(summary.profile),
    coverageLine(summary.coverage),
    completedDays === 0
      ? h('p', { class: 'muted' }, 'No completed days yet this month.')
      : h(
          'div',
          {},
          h('p', { class: 'section-label' }, `Daily average · ${completedDays} completed ${completedDays === 1 ? 'day' : 'days'}`),
          microRows(summary.nutrients, { mode: Mode.MONTH, completedDays }),
        ),
  ]);
}

async function renderDay(container, { date, today }) {
  let day = await api.get(`/api/micros/days/${date}`);
  const content = h('div');
  container.replaceChildren(content);
  // Several quick taps can overlap; only the newest response may be drawn.
  let latest = 0;

  function draw() {
    const { title, subtitle } = formatDayTitle(date, today);
    setChildren(content, [
      pageHeader({
        title,
        subtitle,
        pill: date !== today ? { label: 'Today', onclick: () => goTo('#/micros') } : null,
        label: 'day',
        onPrevious: () => goTo(`#/micros/day/${addDays(date, -1)}`),
        onNext: () => goTo(`#/micros/day/${addDays(date, 1)}`),
      }),
      modeSwitch(Mode.DAY, () => goTo(`#/micros/month/${date.slice(0, 7)}`)),
      profileBanner(day.profile),
      supplementsCard(),
      coverageLine(day.coverage),
      microRows(day.nutrients, { mode: Mode.DAY }),
    ]);
  }

  async function reload() {
    const request = ++latest;
    const fresh = await api.get(`/api/micros/days/${date}`);
    if (request !== latest) return;
    day = fresh;
    draw();
  }

  /** Runs a supplement change, then refreshes the rows; failures surface as a toast. */
  async function change(action, { onDone } = {}) {
    try {
      await action();
      await reload();
      onDone?.();
    } catch (error) {
      toastError(error);
    }
  }

  function supplementsCard() {
    return h(
      'section',
      {},
      h('h2', { class: 'section-label' }, 'Supplements'),
      h(
        'div',
        { class: 'card supp-card' },
        day.supplements.length > 0 ? h('ul', { class: 'supp-list' }, day.supplements.map(supplementItem)) : h('p', { class: 'muted supp-empty' }, 'No supplements logged'),
        h(
          'div',
          { class: 'supp-actions' },
          h('button', { class: 'btn btn-soft btn-sm', type: 'button', onclick: openAddSupplement }, icon('plus', 16), 'Add supplement'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: addDailySet }, 'Add my daily supplements'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: copyPreviousDay }, icon('copy', 16), 'Copy from previous day'),
        ),
        h('a', { class: 'supp-manage', href: SUPPLEMENTS_HREF }, 'Manage supplements'),
      ),
    );
  }

  function supplementItem(entry) {
    const setUnits = guarded(async (units) => change(() => api.patch(`/api/supplement-entries/${entry.id}`, { units })));
    const remove = guarded(async () => change(() => api.del(`/api/supplement-entries/${entry.id}`)));
    return h(
      'li',
      { class: 'supp-item' },
      h(
        'span',
        { class: 'supp-main' },
        h('span', { class: 'supp-name' }, entry.name),
        entry.brand ? h('span', { class: 'supp-brand' }, entry.brand) : null,
      ),
      h(
        'span',
        { class: 'supp-stepper' },
        h(
          'button',
          {
            class: 'icon-btn boxed',
            type: 'button',
            'aria-label': `Fewer ${entry.name}`,
            disabled: entry.units <= UNITS_MIN,
            onclick: () => setUnits(Math.max(UNITS_MIN, roundUnits(entry.units - UNITS_STEP))),
          },
          '−',
        ),
        h('span', { class: 'supp-units' }, `${fmt(entry.units, 2)} ${entry.unitLabel}`),
        h(
          'button',
          {
            class: 'icon-btn boxed',
            type: 'button',
            'aria-label': `More ${entry.name}`,
            disabled: entry.units >= UNITS_MAX,
            onclick: () => setUnits(Math.min(UNITS_MAX, roundUnits(entry.units + UNITS_STEP))),
          },
          '+',
        ),
      ),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${entry.name}`, onclick: remove }, icon('x', 18)),
    );
  }

  async function openAddSupplement() {
    let catalogue;
    try {
      catalogue = await api.get('/api/supplements');
    } catch (error) {
      toastError(error);
      return;
    }
    const sheet = openSheet({ title: 'Add supplement', content: h('div') });
    const add = guarded(async (supplement) => {
      await change(() => api.post(`/api/days/${date}/supplements`, { supplementId: supplement.id, units: 1 }), {
        onDone: () => {
          sheet.close();
          toast(`Added ${supplement.name}`);
        },
      });
    });
    sheet.setContent(
      catalogue.length === 0
        ? h(
            'div',
            { class: 'empty-state' },
            h('p', {}, 'No supplements yet'),
            h('a', { class: 'btn btn-soft', href: SUPPLEMENTS_HREF, onclick: () => sheet.close() }, 'Manage supplements'),
          )
        : h(
            'div',
            { class: 'supp-catalogue' },
            catalogue.map((supplement) =>
              h(
                'button',
                { class: 'list-item', type: 'button', onclick: () => add(supplement) },
                h(
                  'span',
                  { class: 'list-main' },
                  h('span', { class: 'list-title', style: { display: 'block' } }, supplement.name),
                  supplement.brand ? h('span', { class: 'list-sub', style: { display: 'block' } }, supplement.brand) : null,
                ),
                h('span', { class: 'list-side' }, `1 ${supplement.unitLabel}`),
              ),
            ),
          ),
    );
  }

  const addDailySet = guarded(() => change(() => api.post(`/api/days/${date}/supplements/set`)));
  const copyPreviousDay = guarded(() =>
    change(() => api.post(`/api/days/${date}/supplements/copy`, { fromDate: addDays(date, -1) })),
  );

  draw();
}
