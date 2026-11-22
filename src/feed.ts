/** The todo fields the ICS feed reads. */
export interface Todo {
  id: string;
  name: string;
  description?: string | null;
  datetime: string;
  time_needed?: number | null;
  status: string;
  parent_id?: string | null;
  calendar_id?: string | null;
  updated_at: string;
}

const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

/** UTC `YYYYMMDDTHHMMSSZ`. */
const stamp = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545 TEXT escaping. */
const escape = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');

/** Folds a line at 75 UTF-8 octets without splitting a character. */
function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  // Continuation lines start with a space, which counts toward the 75.
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function buildIcs(
  todos: Todo[],
  opts: { name: string; now: Date; calendarIds?: string[] }
): string {
  const now = opts.now.getTime();
  const from = now - 60 * DAY_MS;
  const to = now + 365 * DAY_MS;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//2du//feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(opts.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
    'X-PUBLISHED-TTL:PT30M',
  ];
  for (const t of todos) {
    const start = Date.parse(t.datetime);
    if (
      t.status === 'cancelled' ||
      !Number.isFinite(start) ||
      start < from ||
      start > to ||
      (opts.calendarIds !== undefined &&
        !opts.calendarIds.includes(t.calendar_id as string)) ||
      t.parent_id
    )
      continue;
    const updated = Date.parse(t.updated_at);
    const minutes = t.time_needed || 30;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escape(t.id)}@2du`,
      `DTSTAMP:${stamp(Number.isFinite(updated) ? updated : now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(start + minutes * 60_000)}`,
      `SUMMARY:${escape((t.status === 'completed' ? '✓ ' : '') + t.name)}`
    );
    if (t.description) lines.push(`DESCRIPTION:${escape(t.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
