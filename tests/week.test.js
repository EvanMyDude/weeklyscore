import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekKey,
  weekKeyForDate,
  weeksInYear,
  parseWeekKey,
  isWeekKey,
  mondayOf,
  addWeeks,
  formatWeekLabel,
  formatWeekRange,
} from '../week.js';

const local = (y, m, d) => new Date(y, m - 1, d, 12);

test('weekKeyForDate matches ISO 8601 at year boundaries', () => {
  const cases = [
    [local(2026, 11, 18), '2026-W47'],
    [local(2026, 11, 16), '2026-W47'], // Monday
    [local(2026, 11, 22), '2026-W47'], // Sunday
    [local(2026, 11, 23), '2026-W48'],
    [local(2026, 1, 1), '2026-W01'], // Thursday
    [local(2025, 12, 29), '2026-W01'], // Monday of 2026-W01
    [local(2021, 1, 3), '2020-W53'],
    [local(2021, 1, 4), '2021-W01'],
    [local(2024, 12, 30), '2025-W01'],
    [local(2027, 1, 3), '2026-W53'],
    [local(2027, 1, 4), '2027-W01'],
  ];
  for (const [date, expected] of cases) {
    assert.equal(weekKeyForDate(date), expected, date.toDateString());
  }
});

test('weekKeyForDate uses the local calendar date, not UTC', () => {
  // Sunday 23:30 local time is still the same ISO week everywhere.
  assert.equal(weekKeyForDate(new Date(2026, 10, 22, 23, 30)), '2026-W47');
  assert.equal(weekKeyForDate(new Date(2026, 10, 23, 0, 15)), '2026-W48');
});

test('weeksInYear', () => {
  assert.equal(weeksInYear(2020), 53);
  assert.equal(weeksInYear(2021), 52);
  assert.equal(weeksInYear(2025), 52);
  assert.equal(weeksInYear(2026), 53);
  assert.equal(weeksInYear(2032), 53);
});

test('parseWeekKey validates format and range', () => {
  assert.deepEqual(parseWeekKey('2026-W47'), { year: 2026, week: 47 });
  assert.deepEqual(parseWeekKey('2026-W53'), { year: 2026, week: 53 });
  assert.equal(parseWeekKey('2025-W53'), null);
  assert.equal(parseWeekKey('2026-W00'), null);
  assert.equal(parseWeekKey('2026-W7'), null);
  assert.equal(parseWeekKey(''), null);
  assert.equal(parseWeekKey(undefined), null);
  assert.equal(isWeekKey('2026-W47'), true);
  assert.equal(isWeekKey('nope'), false);
  assert.equal(weekKey(2026, 7), '2026-W07');
});

test('mondayOf', () => {
  assert.equal(mondayOf('2026-W47').toISOString().slice(0, 10), '2026-11-16');
  assert.equal(mondayOf('2026-W01').toISOString().slice(0, 10), '2025-12-29');
  assert.equal(mondayOf('2020-W53').toISOString().slice(0, 10), '2020-12-28');
  assert.throws(() => mondayOf('2025-W53'), RangeError);
});

test('addWeeks crosses year boundaries both ways', () => {
  assert.equal(addWeeks('2026-W47', 1), '2026-W48');
  assert.equal(addWeeks('2026-W52', 1), '2026-W53');
  assert.equal(addWeeks('2026-W53', 1), '2027-W01');
  assert.equal(addWeeks('2027-W01', -1), '2026-W53');
  assert.equal(addWeeks('2025-W52', 1), '2026-W01');
  assert.equal(addWeeks('2026-W47', -52), '2025-W47');
});

test('labels and ranges', () => {
  assert.equal(formatWeekLabel('2026-W47'), 'Week 47, 2026');
  assert.equal(formatWeekRange('2026-W47'), 'Nov 16 – 22, 2026');
  assert.equal(formatWeekRange('2026-W49'), 'Nov 30 – Dec 6, 2026');
  assert.equal(formatWeekRange('2026-W53'), 'Dec 28, 2026 – Jan 3, 2027');
});
