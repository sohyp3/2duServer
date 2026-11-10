import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { RateLimiter, readObject } from '../src/security';
import { validateChange } from '../src/records';

let app: ReturnType<typeof createApp>;
let token: string;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  auth = token,
  ip = 'test'
) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ip
  );
}
beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  token = (
    await (
      await request(
        '/v1/auth/register',
        'POST',
        { username: 'owner', password: 'long-test-password' },
        ''
      )
    ).json()
  ).token;
});
afterEach(() => app.db.close());

test('secure configuration defaults and invalid configuration rejection', () => {
  expect(loadConfig({}).allowRegistration).toBe(false);
  expect(loadConfig({}).host).toBe('127.0.0.1');
  for (const env of [
    { PORT: 'NaN' },
    { PORT: '0' },
    { ALLOW_REGISTRATION: 'yes' },
    { ALLOWED_ORIGINS: '*' },
    { ALLOWED_ORIGINS: 'https://example.com/path' },
  ])
    expect(() => loadConfig(env)).toThrow();
});

test('Argon2id passwords and hashed random tokens; secrets never returned by key lists', async () => {
  const user = app.db.query('SELECT password FROM users').get() as {
    password: string;
  };
  expect(user.password.startsWith('$argon2id$')).toBe(true);
  expect(user.password).not.toContain('long-test-password');
  expect(app.db.query('SELECT hash FROM tokens').get()).toEqual({
    hash: hash(token),
  });
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const key = await (
    await request('/v1/keys', 'POST', { name: 'agent', scope: 'write' })
  ).json();
  const list = await (await request('/v1/keys')).text();
  expect(list).not.toContain(key.key);
  expect(list).toContain(key.id);
});

test('expired sessions, malformed bearer tokens, logout and immediate key revocation', async () => {
  for (const auth of ['', 'not-a-token', token.toUpperCase()])
    expect((await request('/v1/notes', 'GET', undefined, auth)).status).toBe(
      401
    );
  app.db
    .query('UPDATE tokens SET expires=? WHERE hash=?')
    .run(Date.now(), hash(token));
  expect((await request('/v1/notes')).status).toBe(401);
  token = (
    await (
      await request(
        '/v1/auth/login',
        'POST',
        { username: 'OWNER', password: 'long-test-password' },
        ''
      )
    ).json()
  ).token;
  expect((await request('/v1/session', 'DELETE')).status).toBe(200);
  expect((await request('/v1/notes')).status).toBe(401);
});

test('agent keys cannot sync, manage sessions or create more keys', async () => {
  for (const scope of ['read', 'write']) {
    const key = (
      await (await request('/v1/keys', 'POST', { name: 'agent', scope })).json()
    ).key;
    for (const [path, method, body] of [
      ['sync', 'POST', { changes: [] }],
      ['keys', 'GET', undefined],
      ['keys', 'POST', { name: 'escape', scope: 'write' }],
      ['session', 'DELETE', undefined],
    ] as const)
      expect((await request(`/v1/${path}`, method, body, key)).status).toBe(
        403
      );
  }
});

test('cross-account key deletion and history access stay scoped', async () => {
  const key = await (
    await request('/v1/keys', 'POST', { name: 'agent', scope: 'write' })
  ).json();
  const note = await (
    await request('/v1/notes', 'POST', { title: 'private' })
  ).json();
  await request(`/v1/notes/${note.id}`, 'PATCH', { title: 'private revised' });
  const other = (
    await (
      await request(
        '/v1/auth/register',
        'POST',
        { username: 'other', password: 'long-test-password' },
        ''
      )
    ).json()
  ).token;
  expect(
    await (await request('/v1/history', 'GET', undefined, other)).json()
  ).toEqual([]);
  await request(`/v1/keys/${key.id}`, 'DELETE', undefined, other);
  expect((await request('/v1/notes', 'GET', undefined, key.key)).status).toBe(
    200
  );
});

test('strict route matching prevents mutations through suffixes and malformed IDs', async () => {
  const note = await (
    await request('/v1/notes', 'POST', { title: 'safe' })
  ).json();
  for (const path of [
    `/v1/notes/${note.id}/extra`,
    `/v1/notes/${note.id}/`,
    '/v1//notes',
    '/v1/notes/%27OR%201=1',
    '/v1/auth/login/extra',
  ])
    expect((await request(path, 'DELETE')).status).toBe(404);
  expect((await (await request(`/v1/notes/${note.id}`)).json()).title).toBe(
    'safe'
  );
});

test('bad JSON shapes, unknown fields, unsupported media types and byte limits are rejected', async () => {
  for (const body of [
    null,
    [],
    42,
    'text',
    { title: 'x', id: 'injected' },
    { title: 'x', created_at: 'fake' },
    JSON.parse('{"title":"x","__proto__":{"polluted":true}}'),
  ])
    expect((await request('/v1/notes', 'POST', body)).status).toBe(400);
  expect(
    (
      await request('/v1/keys', 'POST', {
        name: 'x',
        scope: 'write',
        user_id: 'other',
      })
    ).status
  ).toBe(400);
  expect(
    (
      await app.fetch(
        new Request('http://localhost/v1/notes', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: '{}',
        })
      )
    ).status
  ).toBe(415);
  for (const raw of ['{broken', '"' + 'é'.repeat(500_000) + '"']) {
    const response = await app.fetch(
      new Request('http://localhost/v1/notes', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: raw,
      })
    );
    expect(response.status).toBe(raw === '{broken' ? 400 : 413);
  }
  const chunked = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(11));
        c.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  await expect(readObject(chunked, 10)).rejects.toMatchObject({ status: 413 });
});

test('CORS restricts browsers while allowing native clients; all responses have security headers', async () => {
  for (const origin of [
    'https://evil.example',
    'null',
    'http://localhost:8081.evil.example',
  ])
    expect(
      (
        await app.fetch(
          new Request('http://localhost/health', {
            headers: { Origin: origin },
          })
        )
      ).status
    ).toBe(403);
  const allowed = await app.fetch(
    new Request('https://localhost/health', {
      headers: { Origin: 'http://localhost:8081' },
    })
  );
  expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
    'http://localhost:8081'
  );
  expect(allowed.headers.get('Strict-Transport-Security')).toContain(
    'max-age='
  );
  const unauthorized = await request('/v1/notes', 'GET', undefined, '');
  expect(unauthorized.headers.get('Cache-Control')).toBe('no-store');
  expect(unauthorized.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(
    (
      await app.fetch(
        new Request('http://localhost/v1/notes', {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:8081' },
        })
      )
    ).status
  ).toBe(200);
});

test('authentication throttles usernames across source IPs and does not trust forwarded headers', async () => {
  for (let n = 0; n < 9; n++)
    expect(
      (
        await request(
          '/v1/auth/login',
          'POST',
          { username: 'owner', password: 'wrong-password' },
          '',
          `ip-${n}`
        )
      ).status
    ).toBe(401);
  const response = await request(
    '/v1/auth/login',
    'POST',
    { username: 'owner', password: 'wrong-password' },
    '',
    'different-ip'
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('900');
  for (let n = 0; n < 31; n++) {
    const spoofed = await app.fetch(
      new Request('http://localhost/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `192.0.2.${n}`,
          Forwarded: `for=192.0.2.${n}`,
        },
        body: JSON.stringify({ username: 'different', password: 'short' }),
      }),
      'same-socket-ip'
    );
    expect(spoofed.status).toBe(n < 30 ? 400 : 429);
  }
});

test('rate limiter fails closed at capacity and enforces its window', () => {
  const limiter = new RateLimiter(2);
  expect(limiter.allow('one', 1, 60000)).toBe(true);
  expect(limiter.allow('one', 1, 60000)).toBe(false);
  expect(limiter.allow('two', 1, 60000)).toBe(true);
  expect(limiter.allow('three', 1, 60000)).toBe(false);
});

test('malformed sync batches are atomic, including a valid edit followed by an invalid one', async () => {
  const note = await (
    await request('/v1/notes', 'POST', { title: 'original' })
  ).json();
  const change = {
    entity: 'notes',
    id: note.id,
    data: { ...note, title: 'injected' },
    updated_at: note.updated_at,
  };
  expect(
    (
      await request('/v1/sync', 'POST', {
        changes: [change, { ...change, id: 'invalid id' }],
      })
    ).status
  ).toBe(400);
  expect((await (await request(`/v1/notes/${note.id}`)).json()).title).toBe(
    'original'
  );
  expect(
    (
      await request('/v1/sync', 'POST', {
        changes: [
          {
            ...change,
            data: null,
            updated_at: new Date(Date.now() + 600000).toISOString(),
          },
        ],
      })
    ).status
  ).toBe(400);
  expect(() => validateChange({ ...change, unexpected: 1 })).toThrow();
  expect(() =>
    validateChange({ ...change, updated_at: '+100000-01-01T00:00:00.000Z' })
  ).toThrow();
});

test('equal-time deletions win, reordered JSON converges, stale retries do not duplicate history', async () => {
  const note = await (
    await request('/v1/notes', 'POST', { title: 'original' })
  ).json();
  const change = {
    entity: 'notes',
    id: note.id,
    data: note,
    updated_at: note.updated_at,
  };
  const reordered = Object.fromEntries(Object.entries(note).reverse());
  await request('/v1/sync', 'POST', {
    changes: [{ ...change, data: reordered }],
  });
  expect(await (await request('/v1/history')).json()).toEqual([]);
  await request('/v1/sync', 'POST', { changes: [{ ...change, data: null }] });
  for (let n = 0; n < 3; n++)
    await request('/v1/sync', 'POST', { changes: [change] });
  expect((await request(`/v1/notes/${note.id}`)).status).toBe(404);
  expect(await (await request('/v1/history')).json()).toHaveLength(1);
});

test('server edits and deletes win over accepted future device timestamps', async () => {
  const note = await (
    await request('/v1/notes', 'POST', { title: 'original' })
  ).json();
  const future = new Date(Date.now() + 60000).toISOString();
  await request('/v1/sync', 'POST', {
    changes: [
      {
        entity: 'notes',
        id: note.id,
        data: { ...note, title: 'future', updated_at: future },
        updated_at: future,
      },
    ],
  });
  const patched = await (
    await request(`/v1/notes/${note.id}`, 'PATCH', { title: 'server edit' })
  ).json();
  expect(patched.updated_at > future).toBe(true);
  expect((await (await request(`/v1/notes/${note.id}`)).json()).title).toBe(
    'server edit'
  );
  await request(`/v1/notes/${note.id}`, 'DELETE');
  expect((await request(`/v1/notes/${note.id}`)).status).toBe(404);
});

test('record limit rolls back the complete batch when quota is exceeded', async () => {
  const uid = (app.db.query('SELECT id FROM users').get() as { id: string }).id;
  app.db
    .query(
      `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<19999)
    INSERT INTO records(user_id,entity,id,data,updated_at) SELECT ?, 'notes', 'seed-'||n, NULL, '2026-01-01T00:00:00.000Z' FROM ids`
    )
    .run(uid);
  const now = new Date().toISOString();
  const changes = ['first', 'second'].map((id) => ({
    entity: 'notes',
    id,
    data: {
      id,
      title: 'quota',
      content: '',
      pinned: false,
      created_at: now,
      updated_at: now,
    },
    updated_at: now,
  }));
  expect((await request('/v1/sync', 'POST', { changes })).status).toBe(409);
  expect(
    app.db.query("SELECT id FROM records WHERE id IN ('first','second')").all()
  ).toEqual([]);
});

test('history retention is bounded while preserving the most recent recovery version', async () => {
  const uid = (app.db.query('SELECT id FROM users').get() as { id: string }).id;
  app.db
    .query(
      `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<2001)
    INSERT INTO history SELECT ?, 'notes', 'old-'||n, NULL, '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z' FROM ids`
    )
    .run(uid);
  const note = await (
    await request('/v1/notes', 'POST', { title: 'recover me' })
  ).json();
  await request(`/v1/notes/${note.id}`, 'PATCH', { title: 'new title' });
  expect(app.db.query('SELECT COUNT(*) AS n FROM history').get()).toEqual({
    n: 2000,
  });
  expect((await (await request('/v1/history')).json())[0].data.title).toBe(
    'recover me'
  );
});

test('general per-account request limit returns 429', async () => {
  for (let n = 0; n < 300; n++)
    expect((await request('/v1/notes')).status).toBe(200);
  expect((await request('/v1/notes')).status).toBe(429);
});

test('concurrent registration cannot create duplicate users', async () => {
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      request(
        '/v1/auth/register',
        'POST',
        { username: 'racing', password: 'long-test-password' },
        ''
      )
    )
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    app.db
      .query("SELECT COUNT(*) AS n FROM users WHERE username='racing'")
      .get()
  ).toEqual({ n: 1 });
});

test('AI and speech providers are off unless configured', () => {
  const config = loadConfig({});
  expect(config.ai).toBeNull();
  expect(config.stt).toBeNull();
});

test('AI provider needs all three variables and drops a trailing slash', () => {
  expect(
    loadConfig({
      AI_BASE_URL: 'https://api.example.com/v1/',
      AI_API_KEY: 'key',
      AI_MODEL: 'model',
    }).ai
  ).toEqual({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'model',
  });
  for (const env of [
    { AI_BASE_URL: 'https://api.example.com/v1' },
    { AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'key' },
    { AI_BASE_URL: 'ftp://api.example.com', AI_API_KEY: 'k', AI_MODEL: 'm' },
    { AI_BASE_URL: 'not a url', AI_API_KEY: 'k', AI_MODEL: 'm' },
  ])
    expect(() => loadConfig(env)).toThrow();
});

test('speech provider inherits the AI base URL and key', () => {
  const config = loadConfig({
    AI_BASE_URL: 'https://api.example.com/v1',
    AI_API_KEY: 'key',
    AI_MODEL: 'model',
    STT_MODEL: 'whisper',
  });
  expect(config.stt).toEqual({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'whisper',
  });
  expect(() => loadConfig({ STT_MODEL: 'whisper' })).toThrow(
    'STT needs a base URL and an API key'
  );
});
