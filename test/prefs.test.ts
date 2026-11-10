import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';

let app: ReturnType<typeof createApp>;
let token = '';
const request = async (path: string, method = 'GET', body?: unknown, auth = token) => {
  const r = await app.fetch(
    new Request(`http://localhost/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: r.status, body: await r.json() };
};
const register = async (username: string) =>
  (await request('auth/register', 'POST', { username, password: 'long-test-password' }, '')).body.token;
beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  token = await register('owner');
});
afterEach(() => app.db.close());

const defaults = { brief_enabled: false, brief_time: '07:00', brief_lang: 'en', tz: 'UTC' };
test('defaults and persistence', async () => {
  expect((await request('prefs')).body).toEqual(defaults);
  const r = await request('prefs', 'PATCH', { brief_enabled: true, tz: 'Asia/Riyadh' });
  expect(r.status).toBe(200);
  expect((await request('prefs')).body).toEqual({ ...defaults, brief_enabled: true, tz: 'Asia/Riyadh' });
});
test('invalid values change nothing', async () => {
  for (const bad of [
    { brief_time: '24:00' },
    { tz: 'Not/AZone' },
    { other: 1 },
    { brief_enabled: 'yes' },
    { brief_lang: 'fr' },
  ])
    expect((await request('prefs', 'PATCH', bad)).status).toBe(400);
  expect((await request('prefs')).body).toEqual(defaults);
});
test('api keys get 403 and users are isolated', async () => {
  const key = (await request('keys', 'POST', { name: 'k', scope: 'write' })).body;
  expect((await request('prefs', 'GET', undefined, key.token ?? key.key)).status).toBe(403);
  await request('prefs', 'PATCH', { brief_lang: 'ar' });
  const other = await register('second');
  expect((await request('prefs', 'GET', undefined, other)).body.brief_lang).toBe('en');
});
