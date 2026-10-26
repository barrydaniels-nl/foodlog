/**
 * Micronutrient summaries for a day, a month or any set of dates: food and
 * supplement amounts per nutrient against the user's recommended amount and
 * upper limit, plus the estimated share, the top sources and data coverage.
 * Everything is computed from the current food and supplement values, never
 * from entry snapshots, so better data improves past days too.
 */
import { LOW_PERCENT, MICRONUTRIENTS, Origin, UlBasis, roundMicro, statusFor } from '../public/js/shared/micronutrients.js';
import { ageOn, targetsFor } from '../public/js/shared/reference-values.js';
import { monthDates } from '../public/js/shared/dates.js';
import { FoodMicroStatus } from './food-micros.js';
import { requireDate, requireMonth } from './validate.js';

/** What a top-sources row stands for; `other` sums everything below the top rows. */
export const SourceKind = Object.freeze({ FOOD: 'food', SUPPLEMENT: 'supplement', OTHER: 'other' });

const MAX_SOURCES = 8;
const NO_TARGET = Object.freeze({ recommended: null, upperLimit: null, limitKind: null, indicative: false });

/**
 * @typedef {object} Source
 * @property {string} kind a SourceKind
 * @property {number|null} id ingredient or supplement id, null for `other`
 * @property {string} name
 * @property {number} amount
 * @property {number} share of the total, 0..1 with 2 decimals
 *
 * @typedef {object} MicroNutrientRow
 * @property {string} key
 * @property {string} label
 * @property {string} unit
 * @property {string} group
 * @property {number} food
 * @property {number} supplements counted amount (folic acid as DFE)
 * @property {number} total
 * @property {number|null} recommended null for salt, or without a profile
 * @property {boolean} indicative
 * @property {number|null} upperLimit
 * @property {string|null} limitKind
 * @property {string} ulBasis
 * @property {number|null} limitAmount the amount compared with the upper limit, null for basis `none`
 * @property {number|null} percent whole number
 * @property {string|null} status a MicroStatus
 * @property {boolean} overLimit
 * @property {number} estimatedShare 0..1 with 2 decimals
 * @property {number} unknownGrams whole grams of food eaten that have no value for this nutrient
 * @property {number} unknownShare unknownGrams as a share of all food grams, 0..1 with 2 decimals; 0 without food
 * @property {Source[]} sources
 *
 * @typedef {{missingFoods: number, missingGrams: number}} Coverage foods with no micronutrient data at all
 *
 * @typedef {object} MicroDay
 * @property {string} date
 * @property {{sex: string, age: number}|null} profile
 * @property {import('./supplements.js').SupplementEntry[]} supplements
 * @property {MicroNutrientRow[]} nutrients
 * @property {Coverage} coverage
 *
 * @typedef {object} MicroSummary averages over the completed days
 * @property {number} completedDays
 * @property {{sex: string, age: number}|null} profile
 * @property {Array<MicroNutrientRow & {daysBelow: number, daysOverLimit: number}>} nutrients
 * @property {Coverage} coverage
 *
 * @typedef {object} Tally unrounded amounts of one nutrient for one day, or their average over days
 * @property {number} food
 * @property {number} supplements
 * @property {number|null} limitAmount
 * @property {number} estimated
 * @property {number} unknownGrams food grams without a value for this nutrient
 * @property {number} foodGrams all food grams
 * @property {Map<string, Omit<Source, 'share'>>} sources
 * @property {{recommended: number|null, upperLimit: number|null, limitKind: string|null, indicative: boolean}} target
 */

const sum = (values) => values.reduce((a, b) => a + b, 0);
const round2 = (value) => Math.round(value * 100) / 100;
const roundOrNull = (value) => (value === null ? null : roundMicro(value));

/** @returns {number|null} unrounded, so the status never flips on a rounding boundary */
const percentOf = (total, recommended) => (recommended ? (total / recommended) * 100 : null);

const isOverLimit = (limitAmount, upperLimit) => limitAmount !== null && upperLimit !== null && limitAmount > upperLimit;

/** AI estimates, and twins the user hasn't approved yet, are guesses rather than measured values. */
const isEstimated = (origin, foodStatus) =>
  origin === Origin.AI || (origin === Origin.NEVO && foodStatus === FoodMicroStatus.UNCONFIRMED);

const profileOn = ({ sex, birthYear }, date) => (sex && birthYear ? { sex, age: ageOn(birthYear, date) } : null);

/** Later calls overwrite the name, so callers going oldest-first end with the most recent one. */
function addSource(sources, kind, id, name, amount) {
  const key = `${kind}:${id}`;
  const source = sources.get(key) ?? { kind, id, name, amount: 0 };
  source.name = name;
  source.amount += amount;
  sources.set(key, source);
}

/**
 * @param {Map<string, Omit<Source, 'share'>>} sources
 * @param {number} total
 * @returns {Source[]} the largest first, at most MAX_SOURCES plus one `other` row
 */
function topSources(sources, total) {
  const sorted = [...sources.values()]
    .filter((source) => source.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  // A source with an amount makes the total positive, so the division is safe.
  const toSource = ({ kind, id, name, amount }) => ({ kind, id, name, amount: roundMicro(amount), share: round2(amount / total) });
  const top = sorted.slice(0, MAX_SOURCES).map(toSource);
  const rest = sorted.slice(MAX_SOURCES);
  if (rest.length > 0) {
    top.push(toSource({ kind: SourceKind.OTHER, id: null, name: 'Others', amount: sum(rest.map((s) => s.amount)) }));
  }
  return top;
}

/**
 * @param {(typeof MICRONUTRIENTS)[number]} micro
 * @param {Tally} tally
 * @returns {MicroNutrientRow}
 */
function toRow(micro, { food, supplements, limitAmount, estimated, unknownGrams, foodGrams, sources, target }) {
  const total = food + supplements;
  const percent = percentOf(total, target.recommended);
  return {
    key: micro.key,
    label: micro.label,
    unit: micro.unit,
    group: micro.group,
    food: roundMicro(food),
    supplements: roundMicro(supplements),
    total: roundMicro(total),
    recommended: roundOrNull(target.recommended),
    indicative: target.indicative,
    upperLimit: roundOrNull(target.upperLimit),
    limitKind: target.limitKind,
    ulBasis: micro.ulBasis,
    limitAmount: roundOrNull(limitAmount),
    percent: percent === null ? null : Math.round(percent),
    status: statusFor(percent),
    overLimit: isOverLimit(limitAmount, target.upperLimit),
    estimatedShare: total > 0 ? round2(estimated / total) : 0,
    unknownGrams: Math.round(unknownGrams),
    unknownShare: foodGrams > 0 ? round2(unknownGrams / foodGrams) : 0,
    sources: topSources(sources, total),
  };
}

/**
 * @param {Tally[]} tallies one per completed day, oldest first
 * @param {(typeof MICRONUTRIENTS)[number]} micro
 * @returns {Tally} the daily average; with no days every amount is 0 and there is no target
 */
function averageTallies(tallies, micro) {
  const count = tallies.length;
  const mean = (pick) => (count === 0 ? 0 : sum(tallies.map(pick)) / count);
  // The profile is the same for every day, so a target is either known on all of them or on none.
  const meanTarget = (pick) => (tallies.some((t) => pick(t) === null) ? null : mean(pick));

  const sources = new Map();
  for (const tally of tallies) {
    for (const { kind, id, name, amount } of tally.sources.values()) addSource(sources, kind, id, name, amount / count);
  }
  const last = tallies.at(-1)?.target;
  return {
    food: mean((t) => t.food),
    supplements: mean((t) => t.supplements),
    limitAmount: micro.ulBasis === UlBasis.NONE ? null : mean((t) => t.limitAmount),
    estimated: mean((t) => t.estimated),
    unknownGrams: mean((t) => t.unknownGrams),
    foodGrams: mean((t) => t.foodGrams),
    sources,
    target:
      count === 0
        ? NO_TARGET
        : {
            recommended: meanTarget((t) => t.target.recommended),
            upperLimit: meanTarget((t) => t.target.upperLimit),
            limitKind: last.limitKind,
            indicative: last.indicative,
          },
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   settings: {get: () => {kcalTarget: number, sex: string|null, birthYear: number|null, microTargets: Record<string, number>}},
 *   foodMicros: {resolve: (ids: number[]) => Map<number, import('./food-micros.js').ResolvedFood>},
 *   supplements: {
 *     entriesForRange: (from: string, to: string) => import('./supplements.js').SupplementEntry[],
 *     nutrientsFor: (ids: number[]) => Map<number, Record<string, number>>,
 *   },
 *   today: () => string,
 * }} deps
 */
export function createMicrosService(db, { settings, foodMicros, supplements, today }) {
  // Oldest first, so the last name seen for an ingredient is its most recent one.
  const entriesInRange = db.prepare(
    'SELECT date, ingredient_id, name, grams FROM entries WHERE date BETWEEN ? AND ? ORDER BY date, id',
  );

  /** Everything a summary needs for a date range, with each food and supplement resolved once. */
  function load(from, to) {
    const foodRows = entriesInRange.all(from, to);
    const supplementRows = supplements.entriesForRange(from, to);
    return {
      foods: foodMicros.resolve(foodRows.map((row) => row.ingredient_id)),
      perUnit: supplements.nutrientsFor([...new Set(supplementRows.map((row) => row.supplementId))]),
      foodByDate: Map.groupBy(foodRows, (row) => row.date),
      supplementsByDate: Map.groupBy(supplementRows, (row) => row.date),
    };
  }

  /**
   * @param {string} date
   * @param {ReturnType<typeof load>} data
   * @param {ReturnType<typeof settings.get>} current
   * @returns {Record<string, Tally>} per nutrient key
   */
  function tallyDay(date, { foods, perUnit, foodByDate, supplementsByDate }, current) {
    const foodRows = foodByDate.get(date) ?? [];
    const supplementRows = supplementsByDate.get(date) ?? [];
    const targets = targetsFor(current, date, current.kcalTarget);
    const foodGrams = sum(foodRows.map((row) => row.grams));
    // The vitamin A limit is about preformed retinol, not the RAE total that includes carotenoids.
    const retinol =
      sum(foodRows.map((row) => ((foods.get(row.ingredient_id)?.retinol ?? 0) * row.grams) / 100)) +
      sum(supplementRows.map((row) => (perUnit.get(row.supplementId).vitaminA ?? 0) * row.units));

    return Object.fromEntries(
      MICRONUTRIENTS.map((micro) => {
        // A blank is unknown, not zero: its grams are tracked so the total reads as a lower bound.
        const tally = { food: 0, supplements: 0, estimated: 0, unknownGrams: 0, foodGrams, sources: new Map() };
        // The supplement-only limits apply to the amount as entered (folic acid, not DFE).
        let supplementRaw = 0;
        for (const row of foodRows) {
          const food = foods.get(row.ingredient_id);
          const value = food?.values[micro.key];
          if (!value) {
            tally.unknownGrams += row.grams;
            continue;
          }
          const amount = (value.amount * row.grams) / 100;
          tally.food += amount;
          if (isEstimated(value.origin, food.status)) tally.estimated += amount;
          addSource(tally.sources, SourceKind.FOOD, row.ingredient_id, row.name, amount);
        }
        for (const row of supplementRows) {
          const perUnitAmount = perUnit.get(row.supplementId)[micro.key];
          if (perUnitAmount === undefined) continue;
          const raw = perUnitAmount * row.units;
          supplementRaw += raw;
          tally.supplements += raw * micro.supplementFactor;
          addSource(tally.sources, SourceKind.SUPPLEMENT, row.supplementId, row.name, raw * micro.supplementFactor);
        }
        const limitAmount = {
          [UlBasis.TOTAL]: tally.food + tally.supplements,
          [UlBasis.SUPPLEMENT]: supplementRaw,
          [UlBasis.RETINOL]: retinol,
          [UlBasis.NONE]: null,
        }[micro.ulBasis];
        return [micro.key, { ...tally, limitAmount, target: targets?.[micro.key] ?? NO_TARGET }];
      }),
    );
  }

  /**
   * Each food without any micronutrient data counts once, however often it was eaten.
   * @returns {Coverage}
   */
  function coverageOf(dates, { foods, foodByDate }) {
    const missing = new Set();
    let grams = 0;
    for (const date of dates) {
      for (const row of foodByDate.get(date) ?? []) {
        if (foods.get(row.ingredient_id)?.hasData) continue;
        missing.add(row.ingredient_id);
        grams += row.grams;
      }
    }
    return { missingFoods: missing.size, missingGrams: Math.round(grams) };
  }

  /** @returns {MicroDay} */
  function getDay(date) {
    const day = requireDate(date);
    const current = settings.get();
    const data = load(day, day);
    const tallies = tallyDay(day, data, current);
    return {
      date: day,
      profile: profileOn(current, day),
      supplements: data.supplementsByDate.get(day) ?? [],
      nutrients: MICRONUTRIENTS.map((micro) => toRow(micro, tallies[micro.key])),
      coverage: coverageOf([day], data),
    };
  }

  /**
   * Daily averages over the completed days in `dates`: days before today with
   * food logged. Supplement-only days don't count, because a day without food
   * isn't a real day of eating.
   * @param {string[]} dates
   * @returns {MicroSummary}
   */
  function getRange(dates) {
    const days = [...new Set(dates.map((date) => requireDate(date)))].sort();
    const current = settings.get();
    const todayIso = today();
    const lastDay = days.at(-1) ?? todayIso;
    const data = load(days[0] ?? lastDay, lastDay);
    const completed = days.filter((date) => date < todayIso && data.foodByDate.has(date));
    const tallies = completed.map((date) => tallyDay(date, data, current));

    return {
      completedDays: completed.length,
      profile: profileOn(current, lastDay),
      nutrients: MICRONUTRIENTS.map((micro) => {
        const perDay = tallies.map((byKey) => byKey[micro.key]);
        const isBelow = (t) => {
          const percent = percentOf(t.food + t.supplements, t.target.recommended);
          return percent !== null && percent < LOW_PERCENT;
        };
        return {
          ...toRow(micro, averageTallies(perDay, micro)),
          daysBelow: perDay.filter(isBelow).length,
          daysOverLimit: perDay.filter((t) => isOverLimit(t.limitAmount, t.target.upperLimit)).length,
        };
      }),
      coverage: coverageOf(completed, data),
    };
  }

  /** @returns {MicroSummary & {month: string}} */
  function getMonth(month) {
    return { month, ...getRange(monthDates(requireMonth(month))) };
  }

  return { getDay, getRange, getMonth };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createMicrosService>} micros
 */
export function registerMicrosRoutes(router, micros) {
  router.add('GET', '/api/micros/days/:date', ({ params }) => micros.getDay(params.date));
  router.add('GET', '/api/micros/months/:month', ({ params }) => micros.getMonth(params.month));
}
