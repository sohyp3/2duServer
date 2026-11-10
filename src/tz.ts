const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(at)) o[p.type] = p.value;
  return o;
}

/** Calendar date in the zone, as 'YYYY-MM-DD'. */
export function localDate(at: Date, tz: string): string {
  const p = parts(at, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
/** Wall-clock 'HH:MM' in the zone. */
export function localTime(at: Date, tz: string): string {
  const p = parts(at, tz);
  return `${p.hour}:${p.minute}`;
}
/** Day of week in the zone, 0 = Sunday. */
export function localWeekday(at: Date, tz: string): number {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts(at, tz).weekday
  );
}

function offsetMs(at: Date, tz: string): number {
  const p = parts(at, tz);
  const wall = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour,
    +p.minute,
    +p.second
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock date and time in the zone. For a time skipped by a
 *  daylight-saving jump, returns the first valid instant after it. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  const want = `${date} ${time}`;
  const at = new Date(t);
  const got = `${localDate(at, tz)} ${localTime(at, tz)}`;
  if (got === want) return at;
  // Skipped wall time: walk forward to the first instant at or after it.
  let probe = t - 3 * 3_600_000;
  for (let i = 0; i < 6 * 60; i++, probe += 60_000) {
    const pa = new Date(probe);
    if (`${localDate(pa, tz)} ${localTime(pa, tz)}` >= want) return pa;
  }
  return at;
}
