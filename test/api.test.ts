import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
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
