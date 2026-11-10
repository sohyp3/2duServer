import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { runAgent } from '../src/agent';

const provider = { baseUrl: 'http://ai.test/v1', apiKey: 'secret-key', model: 'm' };
const now = new Date('2026-11-10T09:00:00.000Z');
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(':memory:', { allowRegistration: true });
  app.db.query('INSERT INTO users VALUES(?,?,?)').run('u1', 'agent_user', 'x');
});
afterEach(() => app.db.close());

// Each call to fetch returns the next scripted assistant message.
function scripted(messages: Record<string, unknown>[]) {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push({ init, body: JSON.parse(String(init.body)) });
    const next = messages.shift();
    if (!next) throw new Error('script exhausted');
    return Response.json({ choices: [{ message: next }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}
const toolCall = (name: string, args: string, id = `call_${name}`) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const text = (content: string) => ({ role: 'assistant', content });
const run = (fetchImpl: typeof fetch, content = 'hello') =>
  runAgent({
    store: app.store,
    provider,
    fetchImpl,
    uid: 'u1',
    messages: [{ role: 'user', content }],
    tz: 'Asia/Riyadh',
    now,
  });

test('a create_todo call writes the record and reports a change', async () => {
  const { fetchImpl } = scripted([
    toolCall('create_todo', JSON.stringify({ name: 'Call dentist' })),
    text('Added the dentist call.'),
  ]);
  const result = await run(fetchImpl, 'add a dentist call');
  expect(result).toEqual({ reply: 'Added the dentist call.', changed: true });
  expect(app.store.list('u1', 'todos')).toHaveLength(1);
});

test('a read-only conversation reports no change', async () => {
  const { fetchImpl } = scripted([
    toolCall('list_notes', '{}'),
    text('You have no notes.'),
  ]);
  expect(await run(fetchImpl)).toEqual({
    reply: 'You have no notes.',
    changed: false,
  });
});

test('unknown tools and bad arguments are fed back as tool errors', async () => {
  const { fetchImpl, requests } = scripted([
    toolCall('launch_rocket', '{}', 'c1'),
    toolCall('create_todo', 'not json', 'c2'),
    text('Sorry, that did not work.'),
  ]);
  const result = await run(fetchImpl);
  expect(result.changed).toBe(false);
  expect(result.reply).toBe('Sorry, that did not work.');
  const tools = requests[2].body.messages.filter(
    (m: any) => m.role === 'tool'
  );
  expect(tools.map((m: any) => JSON.parse(m.content))).toEqual([
    { error: 'Unknown tool' },
    { error: 'Tool arguments must be JSON' },
  ]);
  expect(tools.map((m: any) => m.tool_call_id)).toEqual(['c1', 'c2']);
});

test('nine tool-calling answers in a row stop with the fallback reply', async () => {
  const answers = Array.from({ length: 9 }, (_, i) =>
    toolCall('list_notes', '{}', `c${i}`)
  );
  const { fetchImpl, requests } = scripted(answers);
  const result = await run(fetchImpl);
  expect(result).toEqual({
    reply: 'I could not finish that. Try a smaller request.',
    changed: false,
  });
  expect(requests).toHaveLength(8);
});

test('the first request carries the system prompt, time zone and bearer key', async () => {
  const { fetchImpl, requests } = scripted([text('hi')]);
  await run(fetchImpl);
  const [first] = requests;
  expect(first.init.headers.Authorization).toBe('Bearer secret-key');
  const system = first.body.messages[0];
  expect(system.role).toBe('system');
  expect(system.content).toContain('Asia/Riyadh');
  expect(system.content).toContain('2026-11-10T09:00:00.000Z');
  expect(first.body.model).toBe('m');
  expect(first.body.tools.length).toBeGreaterThan(0);
});

test('a provider 500 rejects with an HttpError of status 502', async () => {
  const fetchImpl = (async () =>
    new Response('boom', { status: 500 })) as unknown as typeof fetch;
  await expect(run(fetchImpl)).rejects.toMatchObject({
    status: 502,
    message: 'The AI provider is unavailable',
  });
});
