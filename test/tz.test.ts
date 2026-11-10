import { test, expect } from 'bun:test';
import { localDate, localTime, localWeekday, zonedToUtc } from '../src/tz';

test('Riyadh and UTC', () => {
  expect(zonedToUtc('2026-11-10', '07:00', 'Asia/Riyadh').toISOString()).toBe(
    '2026-11-10T04:00:00.000Z'
  );
  expect(zonedToUtc('2026-11-10', '07:00', 'UTC').toISOString()).toBe(
    '2026-11-10T07:00:00.000Z'
  );
  const at = new Date('2026-11-10T21:30:00Z');
  expect(localDate(at, 'Asia/Riyadh')).toBe('2026-11-11');
  expect(localTime(at, 'Asia/Riyadh')).toBe('00:30');
  expect(localWeekday(at, 'Asia/Riyadh')).toBe(3);
  expect(localWeekday(at, 'UTC')).toBe(2);
});
test('New York across daylight-saving changes', () => {
  const ny = 'America/New_York';
  expect(zonedToUtc('2026-03-07', '12:00', ny).toISOString()).toBe(
    '2026-03-07T17:00:00.000Z'
  );
  expect(zonedToUtc('2026-03-09', '12:00', ny).toISOString()).toBe(
    '2026-03-09T16:00:00.000Z'
  );
  // 02:30 on 2026-03-08 does not exist: first instant after is 03:00 EDT.
  expect(zonedToUtc('2026-03-08', '02:30', ny).toISOString()).toBe(
    '2026-03-08T07:00:00.000Z'
  );
  expect(zonedToUtc('2026-10-31', '12:00', ny).toISOString()).toBe(
    '2026-10-31T16:00:00.000Z'
  );
  expect(zonedToUtc('2026-11-02', '12:00', ny).toISOString()).toBe(
    '2026-11-02T17:00:00.000Z'
  );
  expect(zonedToUtc('2026-11-01', '00:00', ny).toISOString()).toBe(
    '2026-11-01T04:00:00.000Z'
  );
});
test('midnight round trip', () => {
  for (const tz of ['UTC', 'Asia/Riyadh', 'America/New_York', 'Pacific/Auckland'])
    for (const d of ['2026-03-08', '2026-11-01', '2026-12-31', '2026-01-01'])
      expect(localDate(zonedToUtc(d, '00:00', tz), tz)).toBe(d);
});
