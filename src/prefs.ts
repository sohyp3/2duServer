import type { Database } from 'bun:sqlite';
import { HttpError } from './security';

export interface Prefs {
  brief_enabled: boolean;
  brief_time: string;
  brief_lang: 'en' | 'ar';
  tz: string;
}
export const defaultPrefs: Prefs = {
  brief_enabled: false,
  brief_time: '07:00',
  brief_lang: 'en',
  tz: 'UTC',
};

export function readPrefs(db: Database, uid: string): Prefs {
  const out: Record<string, unknown> = { ...defaultPrefs };
  const rows = db
    .query('SELECT key,value FROM prefs WHERE user_id=?')
    .all(uid) as { key: string; value: string }[];
  for (const r of rows)
    if (r.key in defaultPrefs) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {}
    }
  return out as unknown as Prefs;
}

const bad = () => new HttpError(400, 'Invalid preferences');
function validTz(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function writePrefs(
  db: Database,
  uid: string,
  patch: Record<string, unknown>
): Prefs {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in defaultPrefs)) throw bad();
    if (k === 'brief_enabled' && typeof v !== 'boolean') throw bad();
    if (
      k === 'brief_time' &&
      !(typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    )
      throw bad();
    if (k === 'brief_lang' && v !== 'en' && v !== 'ar') throw bad();
    if (k === 'tz' && !validTz(v)) throw bad();
  }
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch))
      db.query(
        'INSERT INTO prefs(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value'
      ).run(uid, k, JSON.stringify(v));
  })();
  return readPrefs(db, uid);
}
