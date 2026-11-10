import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createApp } from '../src/app';

test('real HTTP, restart persistence, consistent live backup, and restore', async () => {
  const directory = mkdtempSync(join(tmpdir(), '2du-server-'));
  const path = join(directory, 'data.sqlite');
  const backup = join(directory, 'backup.sqlite');
  let app = createApp(path, { allowRegistration: true });
  let server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => app.fetch(req, srv.requestIP(req)?.address ?? 'test'),
  });
  try {
    const call = (route: string, method = 'GET', body?: unknown, token = '') =>
      fetch(new URL(route, server.url), {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const registered = await call('/v1/auth/register', 'POST', {
      username: 'owner',
      password: 'long-test-password',
    });
    expect(registered.status).toBe(200);
    const { token } = await registered.json();
    const note = await (
      await call(
        '/v1/notes',
        'POST',
        { title: 'survives restart', content: 'persist me' },
        token
      )
    ).json();
    expect(note.id).toBeString();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const child = Bun.spawn(
      [process.execPath, 'run', 'scripts/backup.ts', backup],
      {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, DATABASE_PATH: path },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const backupExit = await child.exited;
    if (backupExit !== 0)
      throw new Error(await new Response(child.stderr).text());
    expect(backupExit).toBe(0);
    const snapshot = new Database(backup, { readonly: true });
    expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    snapshot.close();
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    await server.stop(true);
    app.db.close();
    app = createApp(path, { allowRegistration: false });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, srv) =>
        app.fetch(req, srv.requestIP(req)?.address ?? 'test'),
    });
    expect(
      (
        await (
          await call(`/v1/notes/${note.id}`, 'GET', undefined, token)
        ).json()
      ).content
    ).toBe('persist me');
    expect(
      (
        await call('/v1/auth/register', 'POST', {
          username: 'other',
          password: 'long-test-password',
        })
      ).status
    ).toBe(403);
    await server.stop(true);
    app.db.close();
    app = createApp(backup, { allowRegistration: false });
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, srv) =>
        app.fetch(req, srv.requestIP(req)?.address ?? 'test'),
    });
    expect(
      (
        await (
          await call(`/v1/notes/${note.id}`, 'GET', undefined, token)
        ).json()
      ).title
    ).toBe('survives restart');
  } finally {
    await server.stop(true);
    app.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('databases created before revisions gain rev=1 rows and a cursor', async () => {
  const directory = mkdtempSync(join(tmpdir(), '2du-server-'));
  const path = join(directory, 'old.sqlite');
  const bearer = 'a'.repeat(64);
  const old = new Database(path, { create: true, strict: true });
  old.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE tokens(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('session','read','write')), expires INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE records(user_id TEXT NOT NULL REFERENCES users(id), entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,entity,id));
    CREATE TABLE history(user_id TEXT NOT NULL REFERENCES users(id), entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at TEXT NOT NULL, archived_at TEXT NOT NULL);
    PRAGMA user_version=1;
  `);
  const when = new Date().toISOString();
  old.query('INSERT INTO users VALUES(?,?,?)').run('u1', 'owner', 'x');
  old
    .query('INSERT INTO tokens VALUES(?,?,?,?,?,?)')
    .run(
      createHash('sha256').update(bearer).digest('hex'),
      'u1',
      'Device session',
      'session',
      Date.now() + 86400000,
      when
    );
  old
    .query('INSERT INTO records VALUES(?,?,?,?,?)')
    .run('u1', 'notes', 'n1', JSON.stringify({ id: 'n1', title: 'one' }), when);
  old
    .query('INSERT INTO records VALUES(?,?,?,?,?)')
    .run('u1', 'notes', 'n2', null, when);
  old.close();
  try {
    const app = createApp(path, { allowRegistration: false });
    try {
      expect(app.db.query('PRAGMA user_version').get()).toEqual({
        user_version: 2,
      });
      expect(
        app.db.query('SELECT rev FROM records ORDER BY id').all()
      ).toEqual([{ rev: 1 }, { rev: 1 }]);
      const response = await app.fetch(
        new Request('http://localhost/v1/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({ changes: [], since: 0 }),
        })
      );
      const body = await response.json();
      expect(body.cursor).toBe(1);
      expect(body.records.map((r: any) => r.id)).toEqual(['n1', 'n2']);
    } finally {
      app.db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
