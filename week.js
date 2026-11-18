// ISO 8601 week helpers. Weeks run Monday to Sunday, and week 1 is the week
// that contains the year's first Thursday. Keys look like "2026-W47", the
// same format <input type="week"> reads and writes.

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEY_PATTERN = /^(\d{4})-W(\d{2})$/;

function utcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

// Monday = 0 ... Sunday = 6
function isoWeekday(date) {
  return (date.getUTCDay() + 6) % 7;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function keyForUtcDate(date) {
  const thursday = addDays(date, 3 - isoWeekday(date));
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday - utcDate(year, 0, 1)) / DAY_MS);
  return weekKey(year, 1 + Math.floor(dayOfYear / 7));
}

export function weekKey(year, week) {
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

// Uses the local calendar date, so "this week" matches the viewer's clock.
export function weekKeyForDate(date) {
  return keyForUtcDate(utcDate(date.getFullYear(), date.getMonth(), date.getDate()));
}

// December 28 always falls in the last ISO week of its year.
export function weeksInYear(year) {
  return parseWeekKey(keyForUtcDate(utcDate(year, 11, 28)), { checkRange: false }).week;
}

export function parseWeekKey(key, { checkRange = true } = {}) {
  const match = KEY_PATTERN.exec(String(key ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || (checkRange && week > weeksInYear(year))) return null;
  return { year, week };
}

export function isWeekKey(key) {
  return parseWeekKey(key) !== null;
}

// Monday of the week, as a UTC midnight Date.
export function mondayOf(key) {
  const parsed = parseWeekKey(key);
  if (!parsed) throw new RangeError(`Not an ISO week key: ${key}`);
  const jan4 = utcDate(parsed.year, 0, 4);
  return addDays(jan4, (parsed.week - 1) * 7 - isoWeekday(jan4));
}

export function addWeeks(key, count) {
  return keyForUtcDate(addDays(mondayOf(key), count * 7));
}

export function formatWeekLabel(key) {
  const { year, week } = parseWeekKey(key);
  return `Week ${week}, ${year}`;
}

// "Nov 16 – 22, 2026", "Nov 30 – Dec 6, 2026", "Dec 28, 2026 – Jan 3, 2027"
export function formatWeekRange(key) {
  const start = mondayOf(key);
  const end = addDays(start, 6);
  const sMonth = MONTHS[start.getUTCMonth()];
  const eMonth = MONTHS[end.getUTCMonth()];
  const sYear = start.getUTCFullYear();
  const eYear = end.getUTCFullYear();
  if (sYear !== eYear) {
    return `${sMonth} ${start.getUTCDate()}, ${sYear} – ${eMonth} ${end.getUTCDate()}, ${eYear}`;
  }
  if (sMonth !== eMonth) {
    return `${sMonth} ${start.getUTCDate()} – ${eMonth} ${end.getUTCDate()}, ${eYear}`;
  }
  return `${sMonth} ${start.getUTCDate()} – ${end.getUTCDate()}, ${eYear}`;
}
