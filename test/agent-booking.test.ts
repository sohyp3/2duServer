import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createApp } from '../src/app';

let app: ReturnType<typeof createApp>;
let session = '';
const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
  auth = session
) => {
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
const register = async (u: string) =>
  (
    await request(
      'auth/register',
      'POST',
      { username: u, password: 'long-test-password' },
      ''
    )
  ).body.token;
const link = {
  slug: 'coffee',
  title: 'Coffee chat',
  duration_min: 30,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '09:00',
  end: '12:00',
  tz: 'UTC',
  buffer_min: 0,
  notice_min: 0,
  horizon_days: 30,
  calendar_id: 'daily',
  enabled: true,
};
const tomorrow = () =>
  new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
let key = '';
beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  session = await register('owner');
  expect((await request('booking', 'POST', link)).status).toBe(201);
  const k = await request('keys', 'POST', { name: 'n8n', scope: 'book' });
  expect(k.status).toBe(201);
  key = k.body.key;
});
afterEach(() => app.db.close());

test('book key lists links, reads slots, books', async () => {
  const list = await request('agent/booking', 'GET', undefined, key);
  expect(list.status).toBe(200);
  expect(list.body).toEqual([
    {
      slug: 'coffee',
      title: 'Coffee chat',
      duration_min: 30,
      tz: 'UTC',
      url: 'http://localhost/book/coffee',
    },
  ]);
  const s = await request(
    `agent/booking/coffee?from=${tomorrow()}&days=2`,
    'GET',
    undefined,
    key
  );
  expect(s.status).toBe(200);
  expect(s.body.days).toBe(2);
  expect(s.body.slots.length).toBe(12);
  const start = s.body.slots[0];
  const b = await request(
    'agent/booking/coffee',
    'POST',
    { start, name: 'Sara', contact: 'sara@example.com', note: 'Pricing call' },
    key
  );
  expect(b.status).toBe(201);
  expect(b.body.end).toBe(
    new Date(Date.parse(start) + 30 * 60_000).toISOString()
  );
  // Same slot again is taken.
  expect(
    (
      await request(
        'agent/booking/coffee',
        'POST',
        { start, name: 'Bob', contact: 'bob@x.io' },
        key
      )
    ).status
  ).toBe(409);
  const todos = (await request('todos')).body;
  expect(todos.length).toBe(1);
  expect(todos[0].name).toBe('Meeting: Sara');
  expect(todos[0].description).toContain('by agent "n8n"');
});

test('book key cannot touch anything else', async () => {
  for (const [path, method] of [
    ['todos', 'GET'],
    ['todos', 'POST'],
    ['notes', 'GET'],
    ['calendars', 'GET'],
    ['booking', 'GET'],
    ['keys', 'GET'],
    ['history', 'GET'],
    ['pick', 'GET'],
    ['brief', 'POST'],
    ['sync', 'POST'],
  ])
    expect(
      (await request(path, method, method === 'GET' ? undefined : {}, key))
        .status
    ).toBe(403);
});

test('read/write keys cannot use agent routes; other owners links are hidden', async () => {
  const w = (await request('keys', 'POST', { name: 'w', scope: 'write' })).body
    .key;
  expect((await request('agent/booking', 'GET', undefined, w)).status).toBe(
    403
  );
  const other = await register('other');
  const k2 = (
    await request('keys', 'POST', { name: 'x', scope: 'book' }, other)
  ).body.key;
  expect((await request('agent/booking', 'GET', undefined, k2)).body).toEqual(
    []
  );
  expect(
    (await request('agent/booking/coffee', 'GET', undefined, k2)).status
  ).toBe(404);
});

test('rejects bad bookings', async () => {
  const bad = async (body: unknown) =>
    (await request('agent/booking/coffee', 'POST', body, key)).status;
  expect(await bad({ start: 'soon', name: 'A', contact: 'abc' })).toBe(400);
  expect(
    await bad({
      start: new Date().toISOString(),
      name: 'A',
      contact: 'abc',
      x: 1,
    })
  ).toBe(400);
  expect(
    await bad({
      start: `${tomorrow()}T13:00:00.000Z`,
      name: 'A',
      contact: 'abc',
    })
  ).toBe(409);
  expect(
    (await request('agent/booking/coffee?days=30', 'GET', undefined, key))
      .status
  ).toBe(400);
});

test('migrates an old tokens table to allow book scope', () => {
  const path = `/tmp/claude-1000/2du-mig-${Date.now()}.sqlite`;
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE tokens(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('session','read','write')), expires INTEGER, created_at TEXT NOT NULL);
    INSERT INTO users VALUES('u','u','x');
    INSERT INTO tokens VALUES('h','u','k','write',NULL,'now');`);
  old.close();
  const a = createApp(path);
  a.db.query("INSERT INTO tokens VALUES('h2','u','b','book',NULL,'now')").run();
  expect((a.db.query('SELECT COUNT(*) AS n FROM tokens').get() as any).n).toBe(
    2
  );
  a.db.close();
});
