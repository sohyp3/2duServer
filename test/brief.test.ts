import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '../src/app';
import { buildBrief, collectBrief, renderBrief } from '../src/brief';

let app: ReturnType<typeof createApp>;
let token = '';
let uid = '';
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
  return { status: r.status, headers: r.headers, body: await r.json() };
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
  uid = (app.db.query('SELECT id FROM users').get() as any).id;
});
afterEach(() => app.db.close());

const tz = 'Asia/Riyadh';
// 2026-11-10 is a Tuesday. Noon Riyadh = 09:00Z.
const now = new Date('2026-11-10T09:00:00.000Z');
const add = (name: string, datetime: string, extra: object = {}) =>
  app.store.save(uid, 'todos', null, { name, datetime, ...extra });

test('today bounds use the local day', () => {
  add('late tonight', '2026-11-10T20:30:00.000Z'); // 23:30 local
  add('after midnight', '2026-11-10T21:30:00.000Z'); // 00:30 next local day
  add('early', '2026-11-10T00:00:00.000Z'); // 03:00 local
  const d = collectBrief(app.store, uid, tz, now, () => 0);
  expect(d.date).toBe('2026-11-10');
  expect(d.today.map((t) => t.name)).toEqual(['early', 'late tonight']);
  expect(d.today[1].time).toBe('23:30');
});
test('overdue order and cap', () => {
  for (let i = 1; i <= 12; i++)
    add(`o${i}`, `2026-10-${String(i).padStart(2, '0')}T09:00:00.000Z`);
  const d = collectBrief(app.store, uid, tz, now, () => 0);
  expect(d.overdue).toHaveLength(10);
  expect(d.overdue[0].name).toBe('o1');
  expect(d.overdueCount).toBe(12);
  expect(renderBrief(d, 'en')).toContain('+2 more');
});
test('goal progress counts completed this week', () => {
  const g = app.store.save(uid, 'goals', null, {
    name: 'Fit',
    importance: 7,
    weekly_target: 3,
  }).data;
  add('run', '2026-11-10T10:00:00.000Z', { goal_id: g.id, status: 'completed' });
  const d = collectBrief(app.store, uid, tz, new Date(), () => 0);
  expect(d.goals[0]).toMatchObject({ name: 'Fit', done: 1, target: 3 });
});
test('render en and ar, omitting empty sections', () => {
  add('write report', '2026-11-10T06:00:00.000Z');
  const d = collectBrief(app.store, uid, tz, now, () => 0);
  const en = renderBrief(d, 'en');
  const ar = renderBrief(d, 'ar');
  expect(en).toContain('write report');
  expect(ar).toContain('write report');
  expect(en).toContain('## Today');
  expect(ar).toContain('## اليوم');
  expect(ar.split('\n')[0]).toContain(`، ${d.date}`);
  expect(en.split('\n')[0]).toContain(`, ${d.date}`);
  expect(en).not.toContain('Overdue');
  expect(en).not.toContain('Goals this week');
  expect(renderBrief({ ...d, today: [], suggestion: null }, 'en')).toContain(
    'Nothing scheduled.'
  );
});
test('buildBrief equals render of collect', () => {
  add('x', '2026-11-10T06:00:00.000Z');
  const a = buildBrief({
    store: app.store,
    uid,
    tz,
    lang: 'en',
    now,
    rng: () => 0,
  });
  expect(a.content).toBe(
    renderBrief(collectBrief(app.store, uid, tz, now, () => 0), 'en')
  );
});
test('POST /v1/brief stores one record per day, replaced on repeat, rate limited', async () => {
  const a = await request('brief', 'POST', {});
  expect(a.status).toBe(200);
  expect(a.body.id).toBe(a.body.date);
  const b = await request('brief', 'POST', {});
  expect(b.body.id).toBe(a.body.id);
  expect((await request('briefs')).body).toHaveLength(1);
  for (let i = 0; i < 4; i++) await request('brief', 'POST', {});
  const last = await request('brief', 'POST', {});
  expect(last.status).toBe(429);
  expect(last.headers.get('retry-after')).toBe('600');
});
