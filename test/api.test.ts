import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import { createHash } from 'node:crypto';
let app: ReturnType<typeof createApp>;
let token: string;
const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
  auth = token
) => {
  const response = await app.fetch(
    new Request(`http://localhost/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json() };
};
beforeEach(async () => {
  process.env.ALLOW_REGISTRATION = 'true';
  app = createApp(':memory:', { allowRegistration: true });
  token = (
    await request(
      'auth/register',
      'POST',
      { username: 'owner', password: 'long-test-password' },
      ''
    )
  ).body.token;
});
afterEach(() => app.db.close());
test('agent CRUD, search, calendar filtering, scoped keys and revocation', async () => {
  const key = (
    await request('keys', 'POST', { name: 'assistant', scope: 'write' })
  ).body;
  const calendar = (
    await request(
      'calendars',
      'POST',
      { name: 'Work', color: '#bb8ed6' },
      key.key
    )
  ).body;
  const task = await request(
    'todos',
    'POST',
    { name: 'Ship it', calendar_id: calendar.id },
    key.key
  );
  expect(task.status).toBe(201);
  expect(
    (
      await request(
        `todos?calendar_id=${calendar.id}&q=ship`,
        'GET',
        undefined,
        key.key
      )
    ).body
  ).toHaveLength(1);
  expect(
    (
      await request(
        `todos/${task.body.id}`,
        'PATCH',
        { status: 'completed' },
        key.key
      )
    ).body.status
  ).toBe('completed');
  expect(
    (await request(`calendars/${calendar.id}`, 'DELETE', undefined, key.key))
      .status
  ).toBe(409);
  const reader = (
    await request('keys', 'POST', { name: 'read', scope: 'read' })
  ).body.key;
  expect((await request('notes', 'POST', { title: 'No' }, reader)).status).toBe(
    403
  );
  expect(
    (await request('keys', 'POST', { name: 'No', scope: 'write' }, key.key))
      .status
  ).toBe(403);
  expect(
    (await request(`todos/${task.body.id}`, 'DELETE', undefined, key.key))
      .status
  ).toBe(200);
  await request(`keys/${key.id}`, 'DELETE');
  expect((await request('todos', 'GET', undefined, key.key)).status).toBe(401);
});
test('separate users cannot see or edit another account', async () => {
  const note = (
    await request('notes', 'POST', { title: 'Private', content: 'secret' })
  ).body;
  const other = (
    await request(
      'auth/register',
      'POST',
      { username: 'another', password: 'long-test-password' },
      ''
    )
  ).body.token;
  expect((await request('notes', 'GET', undefined, other)).body).toEqual([]);
  expect(
    (await request(`notes/${note.id}`, 'PATCH', { title: 'attack' }, other))
      .status
  ).toBe(404);
  expect(
    (await request('sync', 'POST', { changes: [] }, other)).body.records
  ).toEqual([]);
});
test('offline edits, retries, conflicts and tombstones converge across devices', async () => {
  const note = (await request('notes', 'POST', { title: 'Original' })).body;
  const older = new Date(Date.now() - 10000).toISOString();
  const offline = { ...note, title: 'Stale edit', updated_at: older };
  const result = await request('sync', 'POST', {
    changes: [
      { entity: 'notes', id: note.id, data: offline, updated_at: older },
    ],
  });
  expect(result.body.records[0].data.title).toBe('Original');
  expect((await request('history')).body[0].data.title).toBe('Stale edit');
  const later = new Date(Date.now() + 10).toISOString();
  const deleted = {
    entity: 'notes',
    id: note.id,
    data: null,
    updated_at: later,
  };
  await request('sync', 'POST', { changes: [deleted] });
  await request('sync', 'POST', { changes: [deleted] });
  const secondDevice = await request('sync', 'POST', {
    changes: [
      { entity: 'notes', id: note.id, data: offline, updated_at: older },
    ],
  });
  expect(secondDevice.body.records[0].data).toBeNull();
  expect((await request('notes')).body).toEqual([]);
});
test('invalid batches are atomic; credentials, registration, CORS and schemas checked', async () => {
  expect(
    (await request('notes', 'POST', { title: 'x', unexpected: true })).status
  ).toBe(400);
  expect(
    (await request('notes', 'POST', { title: 'x', content: null })).status
  ).toBe(400);
  expect(
    (await request('todos', 'POST', { name: 'x', datetime: 'nonsense' })).status
  ).toBe(400);
  const before = await request('sync', 'POST', { changes: [] });
  expect(
    (
      await request('sync', 'POST', {
        changes: [
          {
            entity: 'notes',
            id: 'bad',
            data: { title: 'bad' },
            updated_at: 'bad',
          },
        ],
      })
    ).status
  ).toBe(400);
  expect((await request('sync', 'POST', { changes: [] })).body).toEqual(
    before.body
  );
  expect(
    (
      await request(
        'auth/login',
        'POST',
        { username: 'owner', password: 'incorrect-password' },
        ''
      )
    ).status
  ).toBe(401);
  app.config.allowRegistration = false;
  expect(
    (
      await request(
        'auth/register',
        'POST',
        { username: 'blocked', password: 'long-test-password' },
        ''
      )
    ).status
  ).toBe(403);
  const cors = await app.fetch(
    new Request('http://localhost/health', {
      headers: { origin: 'https://evil.example' },
    })
  );
  expect(cors.status).toBe(403);
});

test('device sessions slide forward while in use', async () => {
  const sessionHash = createHash('sha256').update(token).digest('hex');
  app.db
    .query('UPDATE tokens SET expires=? WHERE hash=?')
    .run(Date.now() + 5 * 86400000, sessionHash);
  expect((await request('todos')).status).toBe(200);
  const extended = app.db
    .query('SELECT expires FROM tokens WHERE hash=?')
    .get(sessionHash) as { expires: number };
  expect(extended.expires - Date.now()).toBeGreaterThan(80 * 86400000);
});

test('expired device sessions are rejected and not extended', async () => {
  const sessionHash = createHash('sha256').update(token).digest('hex');
  const past = Date.now() - 1000;
  app.db
    .query('UPDATE tokens SET expires=? WHERE hash=?')
    .run(past, sessionHash);
  expect((await request('todos')).status).toBe(401);
  const row = app.db
    .query('SELECT expires FROM tokens WHERE hash=?')
    .get(sessionHash) as { expires: number };
  expect(row.expires).toBe(past);
});

test('API keys keep a null expiry after a request', async () => {
  const key = (
    await request('keys', 'POST', { name: 'assistant', scope: 'write' })
  ).body;
  expect((await request('todos', 'GET', undefined, key.key)).status).toBe(200);
  const row = app.db
    .query('SELECT expires FROM tokens WHERE hash=?')
    .get(key.id) as { expires: number | null };
  expect(row.expires).toBeNull();
});

test('sync with a since cursor returns only changed records', async () => {
  const first = await request('sync', 'POST', { changes: [] });
  expect(first.body.cursor).toBe(0);
  const note = (await request('notes', 'POST', { title: 'Cursor' })).body;
  const full = await request('sync', 'POST', { changes: [] });
  expect(full.body.cursor).toBeGreaterThan(0);
  expect(full.body.records.map((r: any) => r.id)).toContain(note.id);
  expect(full.body.records[0].rev).toBeUndefined();
  const idle = await request('sync', 'POST', {
    changes: [],
    since: full.body.cursor,
  });
  expect(idle.body).toEqual({ records: [], cursor: full.body.cursor });
});

test('records written by agents appear in the next delta sync', async () => {
  const cursor = (await request('sync', 'POST', { changes: [] })).body.cursor;
  const key = (
    await request('keys', 'POST', { name: 'assistant', scope: 'write' })
  ).body;
  const todo = (await request('todos', 'POST', { name: 'Delta' }, key.key))
    .body;
  const delta = await request('sync', 'POST', { changes: [], since: cursor });
  expect(delta.body.records.map((r: any) => r.id)).toEqual([todo.id]);
  expect(delta.body.cursor).toBeGreaterThan(cursor);
});

test('a losing submitted change is echoed back for delta sync', async () => {
  const note = (await request('notes', 'POST', { title: 'Original' })).body;
  const cursor = (await request('sync', 'POST', { changes: [] })).body.cursor;
  const older = new Date(Date.now() - 10000).toISOString();
  const stale = { ...note, title: 'Stale edit', updated_at: older };
  const result = await request('sync', 'POST', {
    changes: [{ entity: 'notes', id: note.id, data: stale, updated_at: older }],
    since: cursor,
  });
  expect(result.body.records).toHaveLength(1);
  expect(result.body.records[0].id).toBe(note.id);
  expect(result.body.records[0].data.title).toBe('Original');
});

test('deletions reach a client syncing with an older cursor', async () => {
  const note = (await request('notes', 'POST', { title: 'Gone' })).body;
  const cursor = (await request('sync', 'POST', { changes: [] })).body.cursor;
  expect((await request(`notes/${note.id}`, 'DELETE')).status).toBe(200);
  const delta = await request('sync', 'POST', { changes: [], since: cursor });
  expect(delta.body.records).toEqual([
    { entity: 'notes', id: note.id, data: null, updated_at: expect.any(String) },
  ]);
});

test('invalid sync cursors are rejected', async () => {
  for (const since of [-1, 1.5, '3']) {
    expect(
      (await request('sync', 'POST', { changes: [], since })).status
    ).toBe(400);
  }
});

test('goals CRUD, validation, goal_id filter and sync', async () => {
  const g = await request('goals', 'POST', { name: 'Fitness' });
  expect(g.status).toBe(201);
  expect(g.body).toMatchObject({ importance: 5, weekly_target: null, status: 'active' });
  const id = g.body.id;
  expect((await request(`goals/${id}`, 'PATCH', { importance: 8, weekly_target: 3 })).body.importance).toBe(8);
  for (const bad of [
    { importance: 0 },
    { importance: 11 },
    { importance: 2.5 },
    { weekly_target: 0 },
    { status: 'nope' },
  ])
    expect((await request(`goals/${id}`, 'PATCH', bad)).status).toBe(400);
  const t = await request('todos', 'POST', { name: 'run', goal_id: id });
  expect(t.status).toBe(201);
  expect((await request(`todos?goal_id=${id}`)).body).toHaveLength(1);
  expect((await request('todos?goal_id=other')).body).toHaveLength(0);
  expect((await request(`goals/${id}`, 'DELETE')).status).toBe(200);
  expect((await request(`todos/${t.body.id}`)).body.goal_id).toBe(id);
  const now = new Date().toISOString();
  const sync = await request('sync', 'POST', {
    changes: [
      { entity: 'goals', id: 'g2', updated_at: now, data: { id: 'g2', name: 'Read', description: null, importance: 3, weekly_target: null, status: 'active', created_at: now, updated_at: now } },
      { entity: 'todos', id: 't2', updated_at: now, data: { id: 't2', name: 'x', description: null, time_needed: null, priority: 'low', datetime: now, status: 'pending', parent_id: null, remind_me: false, calendar_id: 'daily', goal_id: 'g2', created_at: now, updated_at: now } },
      { entity: 'todos', id: 't3', updated_at: now, data: { id: 't3', name: 'old', remind_me: false, priority: 'low', datetime: now, status: 'pending', created_at: now, updated_at: now } },
    ],
  });
  expect(sync).toMatchObject({ status: 200 });
});
