/** Shared constants used by both the server and the browser. */

export const MealSlot = Object.freeze({
  BREAKFAST: 'breakfast',
  LUNCH: 'lunch',
  DINNER: 'dinner',
  SNACKS: 'snacks',
});

export const MEAL_SLOTS = Object.freeze([MealSlot.BREAKFAST, MealSlot.LUNCH, MealSlot.DINNER, MealSlot.SNACKS]);

export const SLOT_LABELS = Object.freeze({
  [MealSlot.BREAKFAST]: 'Breakfast',
  [MealSlot.LUNCH]: 'Lunch',
  [MealSlot.DINNER]: 'Dinner',
  [MealSlot.SNACKS]: 'Snacks',
});

/** Nutrient fields, always expressed per 100 g in storage. */
export const NUTRIENT_KEYS = Object.freeze(['kcal', 'protein', 'carbs', 'fat', 'fiber']);

export const DEFAULT_SETTINGS = Object.freeze({
  kcalTarget: 2000,
  proteinTarget: 120,
  offCountry: 'nl',
  sex: null,
  birthYear: null,
  microTargets: Object.freeze({}),
});

/** Open Food Facts search regions: code → OFF country tag name. */
export const OFF_COUNTRIES = Object.freeze({
  nl: 'netherlands',
  be: 'belgium',
  de: 'germany',
  uk: 'united-kingdom',
  fr: 'france',
});
export const OFF_WORLD = 'world';
