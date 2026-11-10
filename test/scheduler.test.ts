import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import { writePrefs } from '../src/prefs';
import { tick } from '../src/scheduler';

let app: ReturnType<typeof createApp>;
const user = (name: string) => {
  const id = crypto.randomUUID();
  app.db.query('INSERT INTO users VALUES(?,?,?)').run(id, name, 'x');
  return id;
};
beforeEach(() => {
  app = createApp(':memory:', { allowRegistration: true });
});
afterEach(() => app.db.close());

test('due at local time, once per day, next day again', () => {
  const u = user('a');
  writePrefs(app.db, u, {
    brief_enabled: true,
    brief_time: '07:00',
    tz: 'Asia/Riyadh',
  });
  expect(tick(app, new Date('2026-11-10T03:59:00Z'))).toBe(0);
  expect(tick(app, new Date('2026-11-10T04:00:00Z'))).toBe(1);
  expect(app.store.get(u, 'briefs', '2026-11-10')).not.toBeNull();
  expect(tick(app, new Date('2026-11-10T09:00:00Z'))).toBe(0);
  expect(tick(app, new Date('2026-11-11T04:00:00Z'))).toBe(1);
  expect(app.store.get(u, 'briefs', '2026-11-11')).not.toBeNull();
});
test('disabled users get nothing', () => {
  const u = user('b');
  writePrefs(app.db, u, { brief_enabled: false });
  expect(tick(app, new Date('2026-11-10T12:00:00Z'))).toBe(0);
});
test('one failure does not stop others', () => {
  const bad = user('bad');
  const good = user('good');
  writePrefs(app.db, bad, { brief_enabled: true });
  writePrefs(app.db, good, { brief_enabled: true });
  // Corrupt the bad user's tz row so generation throws.
  app.db
    .query("UPDATE prefs SET value='\"Nope/Zone\"' WHERE user_id=? AND key='tz'")
    .run(bad);
  app.db
    .query("INSERT INTO prefs VALUES(?, 'tz', '\"Nope/Zone\"') ON CONFLICT DO UPDATE SET value=excluded.value")
    .run(bad);
  const spy = console.error;
  let logged = 0;
  console.error = () => void logged++;
  try {
    expect(tick(app, new Date('2026-11-10T12:00:00Z'))).toBe(1);
  } finally {
    console.error = spy;
  }
  expect(logged).toBe(1);
  expect(app.store.get(good, 'briefs', '2026-11-10')).not.toBeNull();
});
