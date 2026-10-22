/**
 * ISO calendar-date helpers (YYYY-MM-DD). Arithmetic runs in UTC on the date
 * parts so daylight-saving changes can never shift a day.
 */

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseIso(iso) {
  const match = ISO_PATTERN.exec(iso);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

function formatUtc(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {Date} date
 * @returns {string} the local calendar date of `date`
 */
export function toIsoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a real calendar date in YYYY-MM-DD form
 */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = parseIso(value);
  return date !== null && formatUtc(date) === value;
}

/**
 * @param {string} iso
 * @param {number} days may be negative
 * @returns {string}
 */
export function addDays(iso, days) {
  const date = parseIso(iso);
  if (!date) throw new RangeError(`Invalid date: ${iso}`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtc(date);
}

/**
 * @param {string} iso the day being shown
 * @param {string} todayIso
 * @returns {{title: string, subtitle: string}} e.g. {title: 'Today', subtitle: 'Wednesday 21 Oct'}
 */
export function formatDayTitle(iso, todayIso) {
  const date = parseIso(iso);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const subtitle = `${weekday} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  const relative = { [todayIso]: 'Today', [addDays(todayIso, 1)]: 'Tomorrow', [addDays(todayIso, -1)]: 'Yesterday' };
  return { title: relative[iso] ?? weekday, subtitle };
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/**
 * @param {unknown} value
 * @returns {boolean} true for a real month in YYYY-MM form
 */
export function isIsoMonth(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_PATTERN.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/**
 * @param {string} month YYYY-MM
 * @param {number} months may be negative
 * @returns {string} YYYY-MM
 */
export function addMonths(month, months) {
  if (!isIsoMonth(month)) throw new RangeError(`Invalid month: ${month}`);
  const date = parseIso(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return formatUtc(date).slice(0, 7);
}

/**
 * @param {string} month YYYY-MM
 * @returns {string[]} every date of the month, first to last
 */
export function monthDates(month) {
  const first = `${month}-01`;
  const count = Number(addDays(`${addMonths(month, 1)}-01`, -1).slice(8));
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/**
 * @param {string} iso
 * @returns {number} 0 for Monday through 6 for Sunday
 */
export function weekdayIndex(iso) {
  return (parseIso(iso).getUTCDay() + 6) % 7;
}

/**
 * @param {string} iso
 * @returns {string} e.g. "Wed 21"
 */
export function formatShortDay(iso) {
  const date = parseIso(iso);
  return `${WEEKDAYS[date.getUTCDay()].slice(0, 3)} ${date.getUTCDate()}`;
}

/**
 * @param {string} month YYYY-MM
 * @returns {string} e.g. "October 2026"
 */
export function formatMonthTitle(month) {
  return `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}
