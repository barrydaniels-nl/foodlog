/**
 * Read-only diet report in Markdown, meant to be pasted as a link into an
 * LLM chat. Markdown because browsing models read it more reliably than JSON.
 */
import { MEAL_SLOTS, SLOT_LABELS } from '../public/js/shared/constants.js';
import { addDays, formatDayTitle } from '../public/js/shared/dates.js';
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

/**
 * @param {import('./days.js').Day} day
 * @param {string} todayIso
 * @returns {string[]} the day's Markdown section
 */
function dayLines(day, todayIso) {
  const label = day.date === todayIso ? ' (today, may be incomplete)' : '';
  const lines = ['', `## ${day.date} · ${formatDayTitle(day.date, todayIso).subtitle}${label}`, ''];
  if (!hasFood(day)) return [...lines, 'Nothing logged.'];

  const { totals, targets } = day;
  lines.push(`Total: ${totals.kcal} / ${targets.kcal} kcal · ${totals.protein} / ${targets.protein} g protein · `
    + `${totals.carbs} g carbs · ${totals.fat} g fat · ${totals.fiber} g fibre`);
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
 * @param {{days: import('./days.js').Day[], todayIso: string}} options days newest first, ending today
 * @returns {string} the report as Markdown
 */
export function buildDietReport({ days, todayIso }) {
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
    '',
    '## Summary',
    '',
    `- Days with food logged: ${logged.length} of ${days.length}`,
    ...summaryLines(completeDays, targets),
    ...days.flatMap((day) => dayLines(day, todayIso)),
    '',
  ].join('\n');
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {{days: {getDay: (date: string) => import('./days.js').Day}, today: () => string}} deps
 */
export function registerDietExportRoutes(router, { days, today }) {
  router.add(
    'GET',
    '/api/diet',
    ({ res, query }) => {
      const count = requireDays(query.get('days'));
      const todayIso = today();
      const report = buildDietReport({
        days: Array.from({ length: count }, (_, i) => days.getDay(addDays(todayIso, -i))),
        todayIso,
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
