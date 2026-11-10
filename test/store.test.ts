import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApp } from '../src/app';

let app: ReturnType<typeof createApp>;
let uid: string;

beforeEach(() => {
  app = createApp(':memory:', { allowRegistration: true });
  app.db
    .query('INSERT INTO users VALUES(?,?,?)')
    .run('user-1', 'store_user', 'x');
  uid = 'user-1';
});
afterEach(() => app.db.close());

test('store creates, reads, patches and removes records', () => {
  const { store } = app;
  const { data, created } = store.save(uid, 'notes', null, {
    title: 'First',
  });
  expect(created).toBe(true);
  expect(data).toMatchObject({ title: 'First', content: '', pinned: false });
  const id = data.id as string;
  expect(store.get(uid, 'notes', id)).toEqual(data);

  const patched = store.save(uid, 'notes', id, { title: 'Second' });
  expect(patched.created).toBe(false);
  expect(patched.data.title).toBe('Second');
  expect(patched.data.created_at).toBe(data.created_at);
  expect(Date.parse(patched.data.updated_at as string)).toBeGreaterThan(
    Date.parse(data.updated_at as string)
  );

  store.remove(uid, 'notes', id);
  expect(store.get(uid, 'notes', id)).toBeNull();
  expect(store.list(uid, 'notes')).toEqual([]);
});

test('store lists todos with each filter and a text query', () => {
  const { store } = app;
  const cal = store.save(uid, 'calendars', null, { name: 'Work' }).data;
  const a = store.save(uid, 'todos', null, {
    name: 'Alpha report',
    calendar_id: cal.id,
    datetime: '2026-11-10T09:00:00.000Z',
    status: 'pending',
  }).data;
  store.save(uid, 'todos', null, {
    name: 'Beta',
    calendar_id: 'daily',
    datetime: '2026-11-12T09:00:00.000Z',
    status: 'completed',
  });
  const names = (rows: Record<string, unknown>[]) =>
    rows.map((r) => r.name).sort();
  expect(names(store.list(uid, 'todos'))).toEqual(['Alpha report', 'Beta']);
  expect(
    names(store.list(uid, 'todos', { calendar_id: cal.id as string }))
  ).toEqual(['Alpha report']);
  expect(
    names(store.list(uid, 'todos', { from: '2026-11-11T00:00:00.000Z' }))
  ).toEqual(['Beta']);
  expect(
    names(store.list(uid, 'todos', { to: '2026-11-11T00:00:00.000Z' }))
  ).toEqual(['Alpha report']);
  expect(names(store.list(uid, 'todos', { status: 'completed' }))).toEqual([
    'Beta',
  ]);
  expect(names(store.list(uid, 'todos', { q: 'ALPHA' }))).toEqual([
    'Alpha report',
  ]);
  expect(a.id).toBeDefined();
});

test('store rejects unknown fields and missing records', () => {
  const { store } = app;
  expect(() =>
    store.save(uid, 'notes', null, { title: 'x', bogus: 1 })
  ).toThrow('Invalid fields');
  expect(() =>
    store.save(uid, 'notes', null, { title: 'x', id: 'forced' })
  ).toThrow('Invalid fields');
  expect(() =>
    store.save(uid, 'notes', 'missing-id', { title: 'x' })
  ).toThrow('Not found');
  expect(() => store.remove(uid, 'notes', 'missing-id')).toThrow('Not found');
});

test('store refuses to delete a calendar that still has tasks', () => {
  const { store } = app;
  const cal = store.save(uid, 'calendars', null, { name: 'Busy' }).data;
  store.save(uid, 'todos', null, { name: 'Task', calendar_id: cal.id });
  expect(() => store.remove(uid, 'calendars', cal.id as string)).toThrow(
    'Move tasks out of this calendar before deleting it'
  );
});
