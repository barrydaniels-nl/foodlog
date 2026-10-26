/** Micronutrient rows grouped as Vitamins / Minerals / Fatty acids, each with a progress bar. */
import { ESTIMATED_SHARE_LIMIT, LOW_PERCENT, MicroGroup, UNKNOWN_SHARE_LIMIT, UlBasis } from '../shared/micronutrients.js';
import { LimitKind } from '../shared/reference-values.js';
import { h, fmt } from './dom.js';
import { openSheet } from './sheet.js';

const GROUP_TITLES = [
  { group: MicroGroup.VITAMINS, title: 'Vitamins' },
  { group: MicroGroup.MINERALS, title: 'Minerals' },
  { group: MicroGroup.FATTY_ACIDS, title: 'Fatty acids' },
];

const OVER_LIMIT_LABELS = Object.freeze({
  [LimitKind.UL]: '⚠ above upper limit',
  [LimitKind.SAFE]: '⚠ above safe level',
  [LimitKind.GUIDELINE]: '⚠ above guideline maximum',
});

const LIMIT_NAMES = Object.freeze({
  [LimitKind.UL]: 'Upper limit',
  [LimitKind.SAFE]: 'Safe level',
  [LimitKind.GUIDELINE]: 'Guideline maximum',
});

/** What the amount compared with the upper limit is made of. */
const LIMIT_BASIS_LABELS = Object.freeze({
  [UlBasis.TOTAL]: 'food + supplements',
  [UlBasis.SUPPLEMENT]: 'from supplements only',
  [UlBasis.RETINOL]: 'retinol',
});

/** The bar is full at this share of its scale, so a big overshoot cannot squash the other rows' bars. */
const BAR_CAP = 1.5;

/**
 * Amounts span from 0.05 mg to 3000 µg, so the decimals depend on magnitude.
 * @param {number} value
 * @returns {string}
 */
export function formatAmount(value) {
  return fmt(value, value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

/**
 * The status colour, or null for a neutral row: without a recommendation
 * there is nothing to judge, and when most food has no value the total is
 * only a lower bound.
 * @param {object} row
 * @returns {string|null} a MicroStatus
 */
const toneOf = (row) => (row.recommended === null || row.unknownShare >= UNKNOWN_SHARE_LIMIT ? null : row.status);

/** @param {number} amount @param {number} scale @returns {number} width as a 0-100 percentage */
const widthPercent = (amount, scale) => Math.min((amount / scale) * 100, 100);

/**
 * Food and supplement segments as a share of the bar's scale: 150% of the
 * recommended amount, or of the upper limit when there is no recommendation.
 * @param {object} row
 * @returns {HTMLElement|null} null when the row has nothing to scale against
 */
function bar(row) {
  const reference = row.recommended ?? row.upperLimit;
  if (!reference) return null;
  const scale = reference * BAR_CAP;
  const food = widthPercent(row.food, scale);
  const supplements = Math.min(widthPercent(row.supplements, scale), 100 - food);
  const tone = toneOf(row);
  return h(
    'span',
    { class: ['micro-bar', tone === null ? 'micro-neutral' : `micro-${tone}`], 'aria-hidden': 'true' },
    h('span', { class: 'micro-bar-food', style: { width: `${food}%` } }),
    h('span', { class: 'micro-bar-supp', style: { width: `${supplements}%` } }),
    h('span', { class: 'micro-bar-mark', style: { left: `${100 / BAR_CAP}%` } }),
  );
}

function valueText(row) {
  const amount = `${formatAmount(row.total)} ${row.unit}`;
  return row.percent === null ? amount : `${amount} · ${row.percent}%`;
}

/** @returns {HTMLElement|null} the recommended amount, or the upper limit when that is all there is */
function targetText(row) {
  if (row.recommended !== null) {
    return h(
      'span',
      {},
      `of ${formatAmount(row.recommended)} ${row.unit}`,
      row.indicative ? h('span', { class: 'micro-indicative' }, ' indicative') : null,
    );
  }
  return row.upperLimit !== null ? h('span', {}, `limit ${formatAmount(row.upperLimit)} ${row.unit}`) : null;
}

function monthStats(row, completedDays) {
  return [
    row.recommended !== null
      ? h('span', {}, `days below ${LOW_PERCENT}%: ${row.daysBelow} / ${completedDays}`)
      : null,
    row.daysOverLimit > 0 ? h('span', { class: 'micro-over' }, `days over limit: ${row.daysOverLimit} / ${completedDays}`) : null,
  ];
}

function microRow(row, { mode, completedDays, onOpen }) {
  const tone = toneOf(row);
  const status = tone === null ? null : `micro-${tone}`;
  return h(
    'button',
    { class: ['micro-row', status], type: 'button', onclick: () => onOpen(row), 'aria-label': `${row.label}, show sources` },
    h(
      'span',
      { class: 'micro-head' },
      h('span', { class: 'micro-label' }, row.label, row.estimatedShare > ESTIMATED_SHARE_LIMIT ? h('span', { class: 'micro-estimated', title: 'Partly estimated' }, ' ≈') : null),
      h('span', { class: 'micro-value' }, valueText(row)),
    ),
    bar(row),
    h(
      'span',
      { class: 'micro-meta' },
      targetText(row),
      row.overLimit ? h('span', { class: 'micro-over' }, OVER_LIMIT_LABELS[row.limitKind]) : null,
      row.unknownGrams > 0 ? h('span', {}, `? ${fmt(row.unknownGrams)} g without data`) : null,
      mode === 'month' ? monthStats(row, completedDays) : null,
    ),
  );
}

/**
 * @param {object[]} nutrients rows from `/api/micros/days/:date` or `/api/micros/months/:month`
 * @param {{mode: 'day'|'month', completedDays?: number, onOpen?: (row: object) => void}} options
 * @returns {HTMLElement}
 */
export function microRows(nutrients, { mode, completedDays = 0, onOpen = openSourcesSheet }) {
  return h(
    'div',
    { class: 'micro-groups' },
    GROUP_TITLES.map(({ group, title }) => {
      const rows = nutrients.filter((row) => row.group === group);
      if (rows.length === 0) return null;
      return h(
        'section',
        {},
        h('h2', { class: 'section-label' }, title),
        h('div', { class: 'card micro-card' }, rows.map((row) => microRow(row, { mode, completedDays, onOpen }))),
      );
    }),
  );
}

/**
 * @param {object} row a nutrient row
 * @returns {string|null} e.g. "Upper limit 250 mg (from supplements only: 300 mg)", null without a limit
 */
function limitText(row) {
  if (row.upperLimit === null) return null;
  const limit = `${LIMIT_NAMES[row.limitKind]} ${formatAmount(row.upperLimit)} ${row.unit}`;
  const basis = LIMIT_BASIS_LABELS[row.ulBasis];
  return basis && row.limitAmount !== null ? `${limit} (${basis}: ${formatAmount(row.limitAmount)} ${row.unit})` : limit;
}

/**
 * Lists where a nutrient came from: the foods and supplements that contribute most.
 * @param {object} row a nutrient row
 */
export function openSourcesSheet(row) {
  const limit = limitText(row);
  const sources = row.sources.map((source) =>
    h(
      'li',
      { class: 'micro-source' },
      h('span', { class: 'micro-source-name' }, source.name),
      h('span', { class: 'micro-source-amount' }, `${formatAmount(source.amount)} ${row.unit} · ${Math.round(source.share * 100)}%`),
    ),
  );
  openSheet({
    title: row.label,
    content: h(
      'div',
      {},
      h('p', { class: 'muted', style: { marginTop: 0 } }, `Total ${formatAmount(row.total)} ${row.unit}`),
      limit ? h('p', { class: row.overLimit ? 'micro-over' : 'muted' }, limit) : null,
      sources.length > 0 ? h('ul', { class: 'micro-sources' }, sources) : h('p', { class: 'muted' }, 'Nothing logged for this nutrient yet.'),
    ),
  });
}
