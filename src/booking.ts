import type { Database } from 'bun:sqlite';
import { HttpError } from './security';

export interface BookingLink {
  slug: string;
  title: string;
  duration_min: number;
  days: number[];
  start: string;
  end: string;
  tz: string;
  buffer_min: number;
  notice_min: number;
  horizon_days: number;
  calendar_id: string;
  enabled: boolean;
}

const keys = [
  'slug',
  'title',
  'duration_min',
  'days',
  'start',
  'end',
  'tz',
  'buffer_min',
  'notice_min',
  'horizon_days',
  'calendar_id',
  'enabled',
];
const reserved = ['app', 'api', 'v1', 'assets', 'static'];
const bad = () => new HttpError(400, 'Invalid booking link');
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
const int = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function validateLink(input: Record<string, unknown>): BookingLink {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad();
  if (Object.keys(input).some((k) => !keys.includes(k))) throw bad();
  const l = input as Record<string, any>;
  if (
    typeof l.slug !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(l.slug) ||
    reserved.includes(l.slug) ||
    typeof l.title !== 'string' ||
    !l.title.trim() ||
    l.title.length > 100 ||
    ![15, 20, 30, 45, 60, 90, 120].includes(l.duration_min) ||
    !Array.isArray(l.days) ||
    !l.days.length ||
    l.days.some((d: unknown) => !int(d, 0, 6)) ||
    new Set(l.days).size !== l.days.length ||
    typeof l.start !== 'string' ||
    !hhmm.test(l.start) ||
    typeof l.end !== 'string' ||
    !hhmm.test(l.end) ||
    l.end <= l.start ||
    typeof l.tz !== 'string' ||
    l.tz.length > 64 ||
    !int(l.buffer_min, 0, 120) ||
    !int(l.notice_min, 0, 10080) ||
    !int(l.horizon_days, 1, 60) ||
    typeof l.calendar_id !== 'string' ||
    l.calendar_id.length < 1 ||
    l.calendar_id.length > 128 ||
    typeof l.enabled !== 'boolean'
  )
    throw bad();
  try {
    new Intl.DateTimeFormat('en', { timeZone: l.tz });
  } catch {
    throw bad();
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = l[k];
  return out as unknown as BookingLink;
}

export function listLinks(db: Database, uid: string): BookingLink[] {
  return (
    db
      .query('SELECT data FROM booking_links WHERE user_id=? ORDER BY created_at')
      .all(uid) as { data: string }[]
  ).map((r) => JSON.parse(r.data));
}

export function getLink(
  db: Database,
  slug: string
): { link: BookingLink; uid: string } | null {
  const r = db
    .query('SELECT data,user_id FROM booking_links WHERE slug=?')
    .get(slug) as { data: string; user_id: string } | null;
  return r ? { link: JSON.parse(r.data), uid: r.user_id } : null;
}

export function createLink(db: Database, uid: string, link: BookingLink) {
  db.transaction(() => {
    if (db.query('SELECT 1 FROM booking_links WHERE slug=?').get(link.slug))
      throw new HttpError(409, 'That link name is taken');
    const n = db
      .query('SELECT COUNT(*) AS n FROM booking_links WHERE user_id=?')
      .get(uid) as { n: number };
    if (n.n >= 10) throw new HttpError(409, 'Booking link limit reached');
    db.query('INSERT INTO booking_links VALUES(?,?,?,?)').run(
      link.slug,
      uid,
      JSON.stringify(link),
      new Date().toISOString()
    );
  })();
}

export function updateLink(
  db: Database,
  uid: string,
  slug: string,
  patch: Record<string, unknown>
): BookingLink {
  const row = db
    .query('SELECT data FROM booking_links WHERE slug=? AND user_id=?')
    .get(slug, uid) as { data: string } | null;
  if (!row) throw new HttpError(404, 'Not found');
  if (!patch || typeof patch !== 'object' || 'slug' in patch) throw bad();
  const link = validateLink({ ...JSON.parse(row.data), ...patch });
  db.query('UPDATE booking_links SET data=? WHERE slug=? AND user_id=?').run(
    JSON.stringify(link),
    slug,
    uid
  );
  return link;
}

export function deleteLink(db: Database, uid: string, slug: string) {
  const r = db
    .query('DELETE FROM booking_links WHERE slug=? AND user_id=?')
    .run(slug, uid);
  if (!r.changes) throw new HttpError(404, 'Not found');
}
