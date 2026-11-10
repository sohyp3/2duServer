import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import {
  pick,
  scoreCandidates,
  type PickGoal,
  type PickTodo,
} from '../src/pick';

const DAY = 86_400_000;
const now = new Date('2026-11-04T12:00:00.000Z'); // Wednesday
const weekStart = new Date('2026-11-02T00:00:00.000Z');
const iso = (offsetDays: number) =>
  new Date(now.getTime() + offsetDays * DAY).toISOString();
const todo = (id: string, o: Partial<PickTodo> = {}): PickTodo => ({
  id,
  name: id,
  datetime: iso(2),
  status: 'pending',
  priority: 'moderate',
  time_needed: null,
  goal_id: null,
  updated_at: iso(-30),
  ...o,
});
const goal = (id: string, o: Partial<PickGoal> = {}): PickGoal => ({
  id,
  name: id,
  importance: 5,
  weekly_target: null,
  status: 'active',
  ...o,
});
const score = (
  todos: PickTodo[],
  goals: PickGoal[] = [],
  minutes?: number
) => scoreCandidates({ todos, goals, now, weekStart, minutes });

test('overdue beats later tasks', () => {
  const r = score([todo('a', { datetime: iso(-1) }), todo('b')]);
  expect(r[0].id).toBe('a');
  expect(r[0].weight).toBe(15);
  expect(r[0].reasons).toContain('overdue');
});
test('linked todos use goal importance', () => {
  const r = score(
    [todo('a', { goal_id: 'g', priority: 'low' })],
    [goal('g', { importance: 9 })]
  );
  expect(r[0].reasons[0]).toBe('importance 9');
  expect(r[0].weight).toBeCloseTo(9 * 1.8 * 1 * 2);
});
test('minutes filter and 7-day horizon', () => {
  const r = score(
    [
      todo('long', { time_needed: 60 }),
      todo('short', { time_needed: 30 }),
      todo('unknown'),
      todo('far', { datetime: iso(8) }),
    ],
    [],
    45
  );
  expect(r.map((c) => c.id).sort()).toEqual(['short', 'unknown']);
  expect(r.find((c) => c.id === 'short')!.reasons).toContain('fits 30 min');
});
test('paused goal tasks skipped, unknown goal unlinked', () => {
  const r = score(
    [todo('a', { goal_id: 'p' }), todo('b', { goal_id: 'missing' })],
    [goal('p', { status: 'paused' })]
  );
  expect(r.map((c) => c.id)).toEqual(['b']);
});
test('weekly target grows with the week and floors at 0.25', () => {
  const g = goal('g', { weekly_target: 3 });
  const t = [todo('a', { goal_id: 'g', datetime: iso(2) })];
  const late = scoreCandidates({ todos: t, goals: [g], now, weekStart })[0];
  const early = scoreCandidates({
    todos: t,
    goals: [g],
    now: new Date(weekStart.getTime() + DAY / 10),
    weekStart,
  })[0];
  expect(late.weight).toBeGreaterThan(early.weight);
  expect(late.reasons).toContain('weekly target 0 of 3 done');
  const finished = [1, 2, 3].map((i) =>
    todo('d' + i, {
      goal_id: 'g',
      status: 'completed',
      updated_at: iso(-0.5),
    })
  );
  const done = score([...finished, ...t], [g])[0];
  expect(done.weight).toBeCloseTo(5 * 1.8 * 0.25 * (1 + 0.5 / 14));
});
test('neglect raises weight', () => {
  const g = [goal('g')];
  const fresh = score(
    [
      todo('a', { goal_id: 'g' }),
      todo('d', { goal_id: 'g', status: 'completed', updated_at: iso(0) }),
    ],
    g
  ).find((c) => c.id === 'a')!;
  const stale = score([todo('a', { goal_id: 'g' })], g)[0];
  expect(stale.weight).toBeGreaterThan(fresh.weight);
  expect(stale.reasons).toContain('untouched for 14 days');
});
test('goal candidate only without active todos', () => {
  const withTodo = score([todo('a', { goal_id: 'g' })], [goal('g')]);
  expect(withTodo.map((c) => c.kind)).toEqual(['todo']);
  const without = score([], [goal('g', { importance: 4 })]);
  expect(without).toHaveLength(1);
  expect(without[0]).toMatchObject({ kind: 'goal', id: 'g', goal_id: 'g' });
  expect(without[0].weight).toBeCloseTo(4 * 2);
});
test('pick draws by weight', () => {
  const c = score([todo('a', { datetime: iso(-1) }), todo('b')]);
  expect(pick(c, () => 0).choice!.id).toBe('a');
  expect(pick(c, () => 0.999999).choice!.id).toBe('b');
  expect(pick(c, () => 0).alternatives.map((x) => x.id)).toEqual(['b']);
  expect(pick([])).toEqual({ choice: null, alternatives: [] });
});

let app: ReturnType<typeof createApp>;
let token: string;
const request = async (path: string, method = 'GET', body?: unknown) => {
  const r = await app.fetch(
    new Request(`http://localhost/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: r.status, body: await r.json() };
};
beforeEach(async () => {
  app = createApp(':memory:', { allowRegistration: true });
  token = '';
  token = (
    await request('auth/register', 'POST', {
      username: 'owner',
      password: 'long-test-password',
    })
  ).body.token;
});
afterEach(() => app.db.close());

test('GET /v1/pick route', async () => {
  expect((await request('pick')).body).toEqual({
    choice: null,
    alternatives: [],
  });
  await request('todos', 'POST', {
    name: 'only one',
    datetime: new Date().toISOString(),
  });
  const r = await request('pick');
  expect(r.status).toBe(200);
  expect(r.body.choice.name).toBe('only one');
  expect((await request('pick?minutes=0')).status).toBe(400);
  expect((await request('pick?minutes=30')).status).toBe(200);
  expect((await request('pick?week_start=yesterday')).status).toBe(400);
  expect(
    (await request('pick?week_start=2026-11-02T00:00:00.000Z')).status
  ).toBe(200);
});
