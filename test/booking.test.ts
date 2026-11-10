import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import { computeSlots, busyFromTodos, isSlotFree } from '../src/slots';
import type { BookingLink } from '../src/booking';

let app: ReturnType<typeof createApp>;
let token = '';
const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
  auth = token,
  ip = 'local'
) => {
  const r = await app.fetch(
    new Request(`http://localhost/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ip
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
beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  token = await register('owner');
});
afterEach(() => app.db.close());

const link = (o: Partial<BookingLink> = {}): BookingLink => ({
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
  ...o,
});

test('owner CRUD and validation', async () => {
  expect((await request('booking', 'POST', link())).status).toBe(201);
  expect((await request('booking')).body).toHaveLength(1);
  expect((await request('booking/coffee', 'PATCH', { title: 'New' })).body.title).toBe('New');
  for (const bad of [
    { slug: 'Bad Slug' },
    { slug: 'api' },
    { end: '08:00' },
    { days: [] },
    { days: [1, 1] },
    { tz: 'Nope/Zone' },
    { duration_min: 25 },
    { extra: 1 },
  ])
    expect((await request('booking', 'POST', { ...link({ slug: 'other-one' }), ...bad })).status).toBe(400);
  expect((await request('booking/coffee', 'PATCH', { slug: 'x-y-z' })).status).toBe(400);
  expect((await request('booking/coffee', 'DELETE')).status).toBe(200);
  expect((await request('booking')).body).toHaveLength(0);
});
test('duplicates, limit, isolation, api keys', async () => {
  await request('booking', 'POST', link());
  expect((await request('booking', 'POST', link())).status).toBe(409);
  const other = await register('second');
  expect((await request('booking', 'POST', link(), other)).status).toBe(409);
  expect((await request('booking/coffee', 'PATCH', { title: 'x' }, other)).status).toBe(404);
  expect((await request('booking/coffee', 'DELETE', undefined, other)).status).toBe(404);
  for (let i = 0; i < 9; i++)
    expect((await request('booking', 'POST', link({ slug: `link-${i}` }))).status).toBe(201);
  expect((await request('booking', 'POST', link({ slug: 'link-11' }))).status).toBe(409);
  const key = (await request('keys', 'POST', { name: 'k', scope: 'write' })).body;
  expect((await request('booking', 'GET', undefined, key.token ?? key.key)).status).toBe(403);
});

// ---- slots ----
const now = new Date('2026-11-10T00:00:00.000Z');
test('slot computation', () => {
  expect(computeSlots(link(), [], now, '2026-11-11', 1)).toHaveLength(6);
  expect(computeSlots(link({ duration_min: 45 }), [], now, '2026-11-11', 1)).toHaveLength(4);
  expect(computeSlots(link({ days: [1] }), [], now, '2026-11-11', 1)).toEqual([]);
  const busy = [{ start: Date.parse('2026-11-11T10:00:00Z'), end: Date.parse('2026-11-11T10:30:00Z') }];
  expect(computeSlots(link(), busy, now, '2026-11-11', 1)).toHaveLength(5);
  expect(computeSlots(link({ buffer_min: 15 }), busy, now, '2026-11-11', 1)).toHaveLength(3);
  expect(computeSlots(link({ notice_min: 120 }), [], new Date('2026-11-11T09:00:00Z'), '2026-11-11', 1)).toHaveLength(2);
  expect(computeSlots(link({ horizon_days: 2 }), [], now, '2026-11-10', 5)).toHaveLength(12);
  expect(computeSlots(link({ tz: 'Asia/Riyadh' }), [], now, '2026-11-11', 1)[0]).toBe('2026-11-11T06:00:00.000Z');
  const ny = computeSlots(link({ tz: 'America/New_York' }), [], new Date('2026-03-01T00:00:00Z'), '2026-03-08', 1);
  expect(ny[0]).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT
  expect(computeSlots(link({ enabled: false }), [], now, '2026-11-11', 1)).toEqual([]);
});
test('busy and isSlotFree', () => {
  const todos = [
    { status: 'completed', datetime: '2026-11-11T09:00:00.000Z', time_needed: 30 },
    { status: 'pending', datetime: '2026-11-11T09:30:00.000Z', time_needed: null },
    { status: 'pending', datetime: '2026-11-11T10:00:00.000Z', time_needed: 30 },
  ];
  const busy = busyFromTodos(todos);
  expect(busy).toHaveLength(1);
  const s = computeSlots(link(), busy, now, '2026-11-11', 1);
  expect(s).toContain('2026-11-11T09:00:00.000Z');
  expect(s).toContain('2026-11-11T09:30:00.000Z');
  expect(isSlotFree(link(), busy, now, '2026-11-11T09:00:00.000Z')).toBe(true);
  expect(isSlotFree(link(), busy, now, '2026-11-11T09:10:00.000Z')).toBe(false);
  expect(isSlotFree(link(), busy, now, '2026-11-11T10:00:00.000Z')).toBe(false);
  expect(isSlotFree(link(), busy, now, '2026-11-09T09:00:00.000Z')).toBe(false);
  expect(isSlotFree(link({ enabled: false }), [], now, '2026-11-11T09:00:00.000Z')).toBe(false);
});

// ---- public ----
const day = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const form = (start: string, o: object = {}) => ({
  start, name: 'Sam', contact: 'sam@example.com', note: 'hello', website: '', ...o,
});
const publicGet = (from = day()) => request(`public/booking/coffee?from=${from}`, 'GET', undefined, '');
let n = 0;
const publicPost = (b: unknown, ip = `10.0.0.${++n}`) => request('public/booking/coffee', 'POST', b, '', ip);

test('public GET', async () => {
  await request('booking', 'POST', link());
  const r = await publicGet();
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(['days', 'duration_min', 'from', 'slots', 'title', 'tz']);
  expect(r.body.slots.length).toBeGreaterThan(0);
  expect((await request('public/booking/nothere', 'GET', undefined, '')).status).toBe(404);
  await request('booking/coffee', 'PATCH', { enabled: false });
  expect((await publicGet()).status).toBe(404);
  await request('booking/coffee', 'PATCH', { enabled: true });
  expect((await publicGet('2026-13-45')).status).toBe(400);
});
test('public booking creates a task and removes the slot', async () => {
  await request('booking', 'POST', link());
  const slot = (await publicGet()).body.slots[0];
  const r = await publicPost(form(slot));
  expect(r.status).toBe(201);
  const todos = (await request('todos')).body;
  expect(todos).toHaveLength(1);
  expect(todos[0]).toMatchObject({
    name: 'Meeting: Sam', datetime: slot, time_needed: 30, calendar_id: 'daily',
    priority: 'moderate', status: 'pending', remind_me: true,
  });
  expect(todos[0].description).toBe('Booked through "Coffee chat"\nContact: sam@example.com\n\nhello');
  expect((await publicGet()).body.slots).not.toContain(slot);
  expect((await publicPost(form(slot))).status).toBe(409);
  expect((await request('todos')).body).toHaveLength(1);
});
test('honeypot, invalid input, allowed origin', async () => {
  await request('booking', 'POST', link());
  const slot = (await publicGet()).body.slots[1];
  expect((await publicPost(form(slot, { website: 'spam' }))).status).toBe(201);
  expect((await request('todos')).body).toHaveLength(0);
  const off = new Date(Date.parse(slot) + 600000).toISOString();
  expect((await publicPost(form(off))).status).toBe(409);
  expect((await publicPost(form('2020-01-01T09:00:00.000Z'))).status).toBe(409);
  expect((await publicPost(form('tomorrow'))).status).toBe(400);
  expect((await publicPost(form(slot, { name: ' ' }))).status).toBe(400);
  expect((await publicPost({ ...form(slot), extra: 'x' })).status).toBe(400);
  const r = await app.fetch(
    new Request('http://localhost/v1/public/booking/coffee', { headers: { Origin: 'https://evil.example' } })
  );
  expect(r.status).toBe(403);
});
test('booking rate limit per IP', async () => {
  await request('booking', 'POST', link());
  const slots = (await publicGet()).body.slots;
  for (let i = 0; i < 5; i++)
    expect((await publicPost(form(slots[i]), '9.9.9.9')).status).toBe(201);
  expect((await publicPost(form(slots[5]), '9.9.9.9')).status).toBe(429);
});
