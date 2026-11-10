import type { BookingLink } from './booking';
import { localDate, localWeekday, zonedToUtc } from './tz';

export interface Busy {
  start: number;
  end: number;
}
const MIN = 60_000;
const DAY = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY)
    .toISOString()
    .slice(0, 10);

/** Slot start times as UTC ISO strings, ascending. */
export function computeSlots(
  link: BookingLink,
  busy: Busy[],
  now: Date,
  from: string,
  days: number
): string[] {
  if (!link.enabled) return [];
  const out: string[] = [];
  const earliest = now.getTime() + link.notice_min * MIN;
  const latest = now.getTime() + link.horizon_days * DAY;
  const len = link.duration_min * MIN;
  const buf = link.buffer_min * MIN;
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const open = zonedToUtc(date, link.start, link.tz);
    if (!link.days.includes(localWeekday(open, link.tz))) continue;
    const close = zonedToUtc(date, link.end, link.tz).getTime();
    for (let s = open.getTime(); s + len <= close; s += len) {
      if (s < earliest || s >= latest) continue;
      const a = s - buf,
        b = s + len + buf;
      if (busy.some((x) => a < x.end && x.start < b)) continue;
      out.push(new Date(s).toISOString());
    }
  }
  return out;
}

export function busyFromTodos(todos: Record<string, unknown>[]): Busy[] {
  const out: Busy[] = [];
  for (const t of todos) {
    const m = t.time_needed;
    if (
      (t.status === 'pending' || t.status === 'in_progress') &&
      typeof m === 'number' &&
      Number.isInteger(m) &&
      m > 0
    ) {
      const start = Date.parse(String(t.datetime));
      if (Number.isFinite(start)) out.push({ start, end: start + m * MIN });
    }
  }
  return out;
}

export function isSlotFree(
  link: BookingLink,
  busy: Busy[],
  now: Date,
  startIso: string
): boolean {
  const t = Date.parse(startIso);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== startIso)
    return false;
  return computeSlots(
    link,
    busy,
    now,
    localDate(new Date(t), link.tz),
    1
  ).includes(startIso);
}
