import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import { buildIcs, type Todo } from '../src/feed';

let app: ReturnType<typeof createApp>;
let alice: string;
let bob: string;
const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
  auth = alice
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
const register = async (username: string) =>
  (
    await request(
      'auth/register',
      'POST',
      { username, password: 'long-test-password' },
      ''
    )
  ).body.token as string;
const newKey = async (body: Record<string, unknown>, auth = alice) =>
  (await request('keys', 'POST', { name: 'feed', ...body }, auth)).body;
const feed = (key: string) =>
  app.fetch(new Request(`http://localhost/feed/${key}.ics`));

beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  alice = await register('alice');
  bob = await register('bob');
});
afterEach(() => app.db.close());

const base: Todo = {
  id: 't1',
  name: 'Dentist',
  description: null,
  datetime: '2026-03-02T09:00:00.000Z',
  time_needed: 45,
  status: 'pending',
  parent_id: null,
  calendar_id: 'daily',
  updated_at: '2026-03-01T08:30:00.000Z',
};

test('buildIcs golden output', () => {
  const longName =
    'Call the bank, then the school, then the plumber; and finally relax 🎉 at home with tea';
  const ics = buildIcs(
    [
      base,
      {
        ...base,
        id: 't2',
        name: 'Done thing',
        status: 'completed',
        time_needed: null,
        description: 'line one\nline two',
      },
      { ...base, id: 'far', datetime: '2027-04-06T09:00:00.000Z' },
      { ...base, id: 'gone', status: 'cancelled' },
      { ...base, id: 'sub', parent_id: 't1' },
      { ...base, id: 't3', name: longName },
    ],
    { name: '2du', now: new Date('2026-03-01T00:00:00.000Z') }
  );
  expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  const lines = ics.split('\r\n');
  for (const line of lines)
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  expect(ics).not.toContain('UID:far@2du');
  expect(ics).not.toContain('UID:gone@2du');
  expect(ics).not.toContain('UID:sub@2du');
  // Unfold to check the long summary's escaping survived intact.
  const unfolded = ics.replace(/\r\n /g, '');
  expect(unfolded).toContain(
    'SUMMARY:Call the bank\\, then the school\\, then the plumber\\; and finally relax 🎉 at home with tea'
  );
  expect(ics).toContain('\r\n ');
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//2du//feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:2du',
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
    'X-PUBLISHED-TTL:PT30M',
  ];
  expect(lines.slice(0, head.length)).toEqual(head);
  expect(unfolded).toContain(
    [
      'BEGIN:VEVENT',
      'UID:t1@2du',
      'DTSTAMP:20260301T083000Z',
      'DTSTART:20260302T090000Z',
      'DTEND:20260302T094500Z',
      'SUMMARY:Dentist',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:t2@2du',
      'DTSTAMP:20260301T083000Z',
      'DTSTART:20260302T090000Z',
      'DTEND:20260302T093000Z',
      'SUMMARY:✓ Done thing',
      'DESCRIPTION:line one\\nline two',
      'END:VEVENT',
    ].join('\r\n')
  );
});

test('folding never splits a multi-byte character', () => {
  const ics = buildIcs([{ ...base, name: '🎉'.repeat(60) }], {
    name: '2du',
    now: new Date('2026-03-01T00:00:00.000Z'),
  });
  for (const line of ics.split('\r\n')) {
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(line).not.toContain('�');
  }
  expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'🎉'.repeat(60)}`);
});

test('feed route serves the account tasks as text/calendar', async () => {
  const soon = new Date(Date.now() + 86400000).toISOString();
  await request('todos', 'POST', { name: 'Alice task', datetime: soon });
  await request('todos', 'POST', { name: 'Bob task', datetime: soon }, bob);
  const { key, id } = await newKey({ scope: 'feed' });
  const res = await feed(key);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  expect(res.headers.get('content-disposition')).toBe(
    'inline; filename="2du.ics"'
  );
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  const ics = await res.text();
  expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(ics).toContain('X-WR-CALNAME:2du\r\n');
  expect(ics).toContain('SUMMARY:Alice task');
  expect(ics).not.toContain('Bob task');
  const listed = (await request('keys')).body.find((k: any) => k.id === id);
  expect(listed.last_used).toBeString();
});

test('calendar filter lists only the chosen calendars', async () => {
  const soon = new Date(Date.now() + 86400000).toISOString();
  const work = (
    await request('calendars', 'POST', { name: 'Work', color: '#bb8ed6' })
  ).body;
  await request('todos', 'POST', {
    name: 'Work task',
    datetime: soon,
    calendar_id: work.id,
  });
  await request('todos', 'POST', { name: 'Home task', datetime: soon });
  const { key } = await newKey({ scope: 'feed', calendar_ids: [work.id] });
  const ics = await (await feed(key)).text();
  expect(ics).toContain('SUMMARY:Work task');
  expect(ics).not.toContain('Home task');
  expect(ics).toContain('X-WR-CALNAME:2du (Work)');
});

test('non-feed and expired keys get 404', async () => {
  const read = await newKey({ scope: 'read' });
  const res = await feed(read.key);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'Not found' });
  expect((await feed(alice)).status).toBe(404);
  expect((await feed('a'.repeat(64))).status).toBe(404);
  const f = await newKey({ scope: 'feed' });
  app.db.query('UPDATE tokens SET expires=1 WHERE hash=?').run(f.id);
  expect((await feed(f.key)).status).toBe(404);
  expect(
    (await app.fetch(new Request(`http://localhost/feed/${f.key}`))).status
  ).toBe(404);
});

test('a feed key used as a bearer on /v1 gets 403', async () => {
  const { key } = await newKey({ scope: 'feed' });
  expect((await request('todos', 'GET', undefined, key)).status).toBe(403);
});
