/**
 * Read-only diet report in Markdown, meant to be pasted as a link into an
 * LLM chat. Markdown because browsing models read it more reliably than JSON.
 */
import { MEAL_SLOTS, SLOT_LABELS } from '../public/js/shared/constants.js';
import { addDays, formatDayTitle } from '../public/js/shared/dates.js';
import { ESTIMATED_SHARE_LIMIT, LOW_PERCENT, UlBasis } from '../public/js/shared/micronutrients.js';
import { averageNutrients, roundNutrients } from '../public/js/shared/nutrition.js';
import { HttpError } from './http.js';
import { requireNumber } from './validate.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * @param {unknown} value the `days` query parameter, null when absent
 * @returns {number} a whole number of days within 1..MAX_DAYS
 */
function requireDays(value) {
  const days = requireNumber(value ?? DEFAULT_DAYS, 'days', { min: 1, max: MAX_DAYS });
  if (!Number.isInteger(days)) throw new HttpError(400, 'days must be a whole number');
  return days;
}

/** @param {import('./days.js').Day} day */
const hasFood = (day) => MEAL_SLOTS.some((slot) => day.slots[slot].entries.length > 0);

/** @param {Record<string, number>} n */
const formatMacros = (n) => `${n.protein} g protein · ${n.carbs} g carbs · ${n.fat} g fat · ${n.fiber} g fibre`;

/** @param {Record<string, number>} n */
const formatNutrients = (n) => `${n.kcal} kcal · ${formatMacros(n)}`;

/**
 * @param {import('./days.js').Day[]} completeDays logged days before today
 * @param {{kcal: number, protein: number}} targets
 * @returns {string[]} summary lines
 */
function summaryLines(completeDays, targets) {
  const count = completeDays.length;
  if (count === 0) return ['- No completed days with food logged in this period.'];
  const average = roundNutrients(averageNutrients(completeDays.map((day) => day.totals)));
  const overKcal = completeDays.filter((day) => day.totals.kcal > targets.kcal).length;
  const underProtein = completeDays.filter((day) => day.totals.protein < targets.protein).length;
  return [
    `- Average per logged day (excluding today): ${formatNutrients(average)}`,
    `- Over the kcal target: ${overKcal} of ${count} days`,
    `- Under the protein target: ${underProtein} of ${count} days`,
  ];
}

const NO_VALUE = '—';

/** @param {{sex: string, age: number}|null} profile */
const formatProfile = (profile) => (profile ? `${profile.sex}, ${profile.age}` : 'not set');

/** @param {number|null} amount @param {string} unit */
const formatAmount = (amount, unit) => (amount === null ? NO_VALUE : `${amount} ${unit}`);

/** How the amount compared with a non-total upper limit is named; a total-based limit needs no note. */
const LIMIT_BASIS_LABELS = Object.freeze({ [UlBasis.SUPPLEMENT]: 'supplements', [UlBasis.RETINOL]: 'retinol' });

/**
 * @param {import('./micros.js').MicroNutrientRow} row
 * @returns {string} the limit, with the amount it was compared with when that is not the total
 */
function formatLimit({ upperLimit, unit, ulBasis, limitAmount, overLimit }) {
  const basis = LIMIT_BASIS_LABELS[ulBasis];
  const note = upperLimit !== null && basis && limitAmount !== null ? ` (${basis}: ${formatAmount(limitAmount, unit)})` : '';
  return `${overLimit ? '⚠ ' : ''}${formatAmount(upperLimit, unit)}${note}`;
}

/**
 * @param {import('./micros.js').MicroSummary['nutrients'][number]} row
 * @param {number} completedDays
 * @returns {string} one Markdown table row
 */
function microRow(row, completedDays) {
  const { unit } = row;
  const estimated = row.estimatedShare > ESTIMATED_SHARE_LIMIT ? '≈ ' : '';
  return `| ${[
    row.label,
    formatAmount(row.food, unit),
    formatAmount(row.supplements, unit),
    `${estimated}${formatAmount(row.total, unit)}`,
    formatAmount(row.recommended, unit),
    row.percent === null ? NO_VALUE : `${row.percent}%`,
    formatLimit(row),
    `${row.daysBelow} / ${completedDays}`,
    `${Math.round(row.estimatedShare * 100)}%`,
    row.unknownGrams > 0 ? `${row.unknownGrams} g` : NO_VALUE,
  ].join(' | ')} |`;
}

/**
 * @param {import('./micros.js').MicroSummary} summary
 * @returns {string[]} the micronutrient section, a table unless no day is complete
 */
function microLines({ completedDays, nutrients }) {
  const heading = ['', '## Micronutrients (average per completed day)', ''];
  if (completedDays === 0) return [...heading, '- No completed days with food logged in this period.'];
  return [
    ...heading,
    `| Nutrient | Food | Supplements | Total | Recommended | % | Upper limit | Days below ${LOW_PERCENT}% | Estimated | Without data |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...nutrients.map((row) => microRow(row, completedDays)),
  ];
}

/** @param {import('./supplements.js').SupplementEntry[]} entries */
const supplementsLine = (entries) =>
  `Supplements: ${entries.map(({ name, units, unitLabel }) => `${name} × ${units} ${unitLabel}`).join(', ')}`;

/**
 * @param {import('./days.js').Day} day
 * @param {string} todayIso
 * @param {import('./supplements.js').SupplementEntry[]} supplementEntries what was taken that day
 * @returns {string[]} the day's Markdown section
 */
function dayLines(day, todayIso, supplementEntries) {
  const label = day.date === todayIso ? ' (today, may be incomplete)' : '';
  const lines = ['', `## ${day.date} · ${formatDayTitle(day.date, todayIso).subtitle}${label}`, ''];
  const supplementLines = supplementEntries.length > 0 ? [supplementsLine(supplementEntries)] : [];
  if (!hasFood(day)) return [...lines, 'Nothing logged.', ...supplementLines];

  const { totals, targets } = day;
  lines.push(`Total: ${totals.kcal} / ${targets.kcal} kcal · ${totals.protein} / ${targets.protein} g protein · `
    + `${totals.carbs} g carbs · ${totals.fat} g fat · ${totals.fiber} g fibre`);
  lines.push(...supplementLines);
  for (const slot of MEAL_SLOTS) {
    const { entries, totals: slotTotals } = day.slots[slot];
    if (entries.length === 0) continue;
    lines.push('', `### ${SLOT_LABELS[slot]} (${slotTotals.kcal} kcal · ${slotTotals.protein} g protein)`);
    for (const { name, brand, grams, nutrients } of entries) {
      lines.push(`- ${name}${brand ? ` (${brand})` : ''}, ${grams} g: ${formatNutrients(nutrients)}`);
    }
  }
  return lines;
}

/**
 * @param {{
 *   days: import('./days.js').Day[],
 *   todayIso: string,
 *   micros: {byDate: Map<string, import('./micros.js').MicroDay>, summary: import('./micros.js').MicroSummary},
 * }} options days newest first, ending today
 * @returns {string} the report as Markdown
 */
export function buildDietReport({ days, todayIso, micros }) {
  const { targets } = days[0];
  const logged = days.filter(hasFood);
  const completeDays = logged.filter((day) => day.date !== todayIso);
  return [
    `# Food diary: ${days.at(-1).date} to ${days[0].date}`,
    '',
    `Exported from Foodlog on ${todayIso}. Covers the last ${days.length} days, newest first.`,
    'Foods are what was planned in the app; past days count as eaten. Today may be incomplete.',
    'A day marked "Nothing logged" has no data; it does not mean nothing was eaten.',
    `Targets are the current settings (no history is kept): ${targets.kcal} kcal and ${targets.protein} g protein per day.`,
    `Profile: ${formatProfile(micros.summary.profile)}`,
    `Micronutrients use the current best values per food, not snapshots; "≈" marks values that are more than ${ESTIMATED_SHARE_LIMIT * 100}% estimated.`,
    'Amounts are lower bounds where foods lack data: "Without data" is the grams of food per day with no value for that nutrient.',
    '',
    '## Summary',
    '',
    `- Days with food logged: ${logged.length} of ${days.length}`,
    ...summaryLines(completeDays, targets),
    ...microLines(micros.summary),
    ...days.flatMap((day) => dayLines(day, todayIso, micros.byDate.get(day.date).supplements)),
    '',
  ].join('\n');
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{
 *   days: {getDay: (date: string) => import('./days.js').Day},
 *   micros: Pick<ReturnType<import('./micros.js').createMicrosService>, 'getDay' | 'getRange'>,
 *   today: () => string,
 * }} deps
 */
export function registerDietExportRoutes(router, { days, micros, today }) {
  router.add(
    'GET',
    '/api/diet',
    ({ res, query }) => {
      const count = requireDays(query.get('days'));
      const todayIso = today();
      const dates = Array.from({ length: count }, (_, i) => addDays(todayIso, -i));
      const report = buildDietReport({
        days: dates.map((date) => days.getDay(date)),
        todayIso,
        micros: { byDate: new Map(dates.map((date) => [date, micros.getDay(date)])), summary: micros.getRange(dates) },
      });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': Buffer.byteLength(report),
        'cache-control': 'no-store',
      });
      res.end(report);
    },
    { raw: true },
  );
}
