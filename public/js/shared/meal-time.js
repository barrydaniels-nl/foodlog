/** Which meal fits a time of day, shared by the server and the browser. */
import { MEAL_SLOTS, MealSlot } from './constants.js';

/**
 * Picks the meal you are most likely planning right now.
 * @param {Date} now
 * @returns {string} one of MEAL_SLOTS
 */
export function slotForTime(now) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 10 * 60 + 30) return MealSlot.BREAKFAST;
  if (minutes < 15 * 60) return MealSlot.LUNCH;
  if (minutes < 21 * 60) return MealSlot.DINNER;
  return MealSlot.SNACKS;
}

/**
 * Meals that haven't been eaten yet: the current one and every later one.
 * Snacks is last, so it is always included.
 * @param {Date} now
 * @returns {string[]}
 */
export function slotsAhead(now) {
  return MEAL_SLOTS.slice(MEAL_SLOTS.indexOf(slotForTime(now)));
}
