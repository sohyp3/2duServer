import { afterEach, expect, test } from 'bun:test';
import { createApp } from '../src/app';

const ai = { baseUrl: 'http://ai.test/v1', apiKey: 'k', model: 'm' };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

// Fake provider: replies with the scripted messages in order, then plain text.
function provider(messages: Record<string, unknown>[] = []) {
  const calls: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const message = messages.shift() ?? {
      role: 'assistant',
      content: 'Done.',
    };
    return Response.json({ choices: [{ message }] });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function setup(
  options: Record<string, unknown> = { ai },
  fake = provider()
) {
  const app = createApp(
    ':memory:',
    { allowRegistration: true, ...options },
    { fetch: fake.fetch }
  );
  apps.push(app);
  const register = await app.fetch(
    new Request('http://localhost/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'agent_route',
        password: 'long-test-password',
      }),
    })
  );
  const token = ((await register.json()) as { token: string }).token;
  return { app, token, calls: fake.calls };
}

const call = (
  app: ReturnType<typeof createApp>,
  token: string | null,
  body: unknown,
  path = '/v1/agent'
) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
const valid = {
  messages: [{ role: 'user', content: 'add a dentist call' }],
  tz: 'Asia/Riyadh',
};

test('a scripted create_todo run changes the tasks the device can read', async () => {
  const fake = provider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'create_todo',
            arguments: JSON.stringify({ name: 'Dentist call' }),
          },
        },
      ],
    },
    { role: 'assistant', content: 'Added it.' },
  ]);
  const { app, token } = await setup({ ai }, fake);
  const response = await call(app, token, valid);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ reply: 'Added it.', changed: true });
  const todos = await app.fetch(
    new Request('http://localhost/v1/todos', {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
  const names = ((await todos.json()) as { name: string }[]).map((t) => t.name);
  expect(names).toEqual(['Dentist call']);
});

test('without an AI provider the route answers 503', async () => {
  const { app, token } = await setup({ ai: null });
  const response = await call(app, token, valid);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'The agent is not configured on this server',
  });
});

test('read-only keys get 403 and anonymous callers get 401', async () => {
  const { app, token } = await setup();
  const key = (await (
    await app.fetch(
      new Request('http://localhost/v1/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'reader', scope: 'read' }),
      })
    )
  ).json()) as { key: string };
  expect((await call(app, key.key, valid)).status).toBe(403);
  expect((await call(app, null, valid)).status).toBe(401);
});

test('invalid agent bodies get 400', async () => {
  const { app, token } = await setup();
  const bad = [
    '{"messages":[],"tz":"Asia/Riyadh"}',
    '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}],"tz":"Asia/Riyadh"}',
    '{"messages":[{"role":"user","content":""}],"tz":"Asia/Riyadh"}',
    `{"messages":[{"role":"user","content":"${'x'.repeat(8001)}"}],"tz":"Asia/Riyadh"}`,
    '{"messages":[{"role":"user","content":"hi","extra":1}],"tz":"Asia/Riyadh"}',
    '{"messages":[{"role":"user","content":"hi"}],"tz":"Not/AZone"}',
    '{"messages":[{"role":"user","content":"hi"}],"tz":"Asia/Riyadh","extra":true}',
    '{"messages":[{"role":"user","content":"hi"}]}',
  ];
  for (const body of bad) {
    const response = await call(app, token, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid agent request' });
  }
});

test('the 21st agent request within a minute gets 429', async () => {
  const { app, token } = await setup();
  for (let i = 0; i < 20; i++)
    expect((await call(app, token, valid)).status).toBe(200);
  const limited = await call(app, token, valid);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect(await limited.json()).toEqual({ error: 'Too many agent requests' });
});
