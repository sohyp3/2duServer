import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  entities,
  validateChange,
  type Change,
  type Entity,
} from './records';

import { loadConfig, type Config } from './config';
import { createStore } from './store';
import {
  createLink,
  deleteLink,
  getLink,
  listLinks,
  updateLink,
  validateLink,
} from './booking';
import { bookingCss, bookingHtml, bookingJs } from './booking-page';
import { busyFromTodos, computeSlots, isSlotFree } from './slots';
import { localDate } from './tz';
import { buildBrief, saveBrief } from './brief';
import { readPrefs, writePrefs } from './prefs';
import { pick, scoreCandidates } from './pick';
import { HttpError, RateLimiter, readObject, exactFields } from './security';

const passwordOptions = {
  algorithm: 'argon2id',
  memoryCost: 65536,
  timeCost: 3,
} as const;
const dummyHash = Bun.password.hashSync(
  randomBytes(32).toString('hex'),
  passwordOptions
);
const SESSION_MS = 90 * 86400000;
const RENEW_AFTER_MS = 86400000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('hex');
export function createApp(
  path = loadConfig().databasePath,
  options: Partial<Config> = {}
) {
  const config = { ...loadConfig(), ...options };
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  if (path !== ':memory:') chmodSync(path, 0o600);
  // The container's root filesystem is read-only, so SQLite must not need temp files.
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA temp_store=MEMORY;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('session','read','write')), expires INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(user_id TEXT NOT NULL REFERENCES users(id), entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,entity,id));
    CREATE TABLE IF NOT EXISTS history(user_id TEXT NOT NULL REFERENCES users(id), entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at TEXT NOT NULL, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prefs(user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,key));
    CREATE TABLE IF NOT EXISTS booking_links(slug TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS booking_links_user ON booking_links(user_id);
    CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id,scope);
    CREATE INDEX IF NOT EXISTS history_user ON history(user_id,archived_at);
    CREATE INDEX IF NOT EXISTS history_record ON history(user_id,entity,id,updated_at);
  `);
  // Existing databases predate records.rev; CREATE TABLE IF NOT EXISTS skips them.
  db.transaction(() => {
    const columns = db.query('PRAGMA table_info(records)').all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === 'rev'))
      db.exec(`ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
        UPDATE records SET rev=1 WHERE rev=0;`);
    db.exec(`CREATE INDEX IF NOT EXISTS records_rev ON records(user_id,rev);
      PRAGMA user_version=2;`);
  })();
  const allowed = config.allowedOrigins;
  const attempts = new RateLimiter();
  const requests = new RateLimiter();
  let activeAuth = 0;
  const store = createStore(db);
  const { merge, record } = store;
  async function fetch(req: Request, clientIP = 'local'): Promise<Response> {
    const origin = req.headers.get('origin');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    };
    if (origin && allowed.includes(origin))
      headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] =
      'GET, POST, PATCH, DELETE, OPTIONS';
    const send = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (new URL(req.url).protocol === 'https:')
        headers['Strict-Transport-Security'] = 'max-age=31536000';
      if (!requests.allow(`ip:${clientIP}`, 600, 60000)) {
        headers['Retry-After'] = '60';
        return send({ error: 'Too many requests' }, 429);
      }
      if (origin && !allowed.includes(origin))
        return send({ error: 'Origin is not allowed' }, 403);
      if (req.method === 'OPTIONS') return send({ ok: true });
      const url = new URL(req.url),
        parts = url.pathname.split('/').filter(Boolean);
      if (url.pathname === '/health' && req.method === 'GET')
        return send({ ok: true });
      // Reject extra path segments and aliases before dispatching any mutation.
      if (
        url.pathname.includes('//') ||
        (url.pathname !== '/' && url.pathname.endsWith('/'))
      )
        return send({ error: 'Not found' }, 404);
      if (req.method === 'GET' && parts[0] === 'book' && parts.length === 2) {
        const asset =
          parts[1] === 'app.css'
            ? [bookingCss, 'text/css; charset=utf-8']
            : parts[1] === 'app.js'
              ? [bookingJs, 'text/javascript; charset=utf-8']
              : /^[a-z0-9-]{3,40}$/.test(parts[1])
                ? [bookingHtml, 'text/html; charset=utf-8']
                : null;
        if (asset)
          return new Response(asset[0], {
            headers: {
              ...headers,
              'Content-Type': asset[1],
              'Cache-Control': 'no-cache',
              'Content-Security-Policy':
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            },
          });
      }
      const validRoute =
        /^\/v1\/(?:auth\/(?:login|register)|session|sync|history|pick|prefs|brief|booking(?:\/[a-z0-9-]{3,40})?|public\/booking\/[a-z0-9-]{3,40}|keys(?:\/[a-f0-9]{64})?|(?:todos|notes|calendars|goals|briefs)(?:\/[\w-]{1,128})?)$/.test(
          url.pathname
        );
      if (!validRoute) return send({ error: 'Not found' }, 404);
      const body = () =>
        readObject(
          req,
          parts[1] === 'sync' ? 5_000_000 : parts[1] === 'auth' ? 8192 : 500_000
        );
      if (parts[1] === 'auth' && req.method === 'POST') {
        if (parts[2] === 'register' && !config.allowRegistration)
          return send(
            { error: 'Registration is disabled on this server' },
            403
          );
        if (!attempts.allow(`ip:${clientIP}`, 30, 60000)) {
          headers['Retry-After'] = '60';
          return send({ error: 'Too many authentication attempts' }, 429);
        }
        const input = await body();
        exactFields(input, ['username', 'password']);
        const { username, password } = input;
        if (
          typeof username !== 'string' ||
          !/^[a-zA-Z0-9_.-]{3,64}$/.test(username) ||
          typeof password !== 'string' ||
          password.length < 10 ||
          password.length > 1024
        )
          return send(
            {
              error:
                'Use a 3–64 character username and a password of at least 10 characters.',
            },
            400
          );
        const key = username.toLowerCase();
        if (!attempts.allow(`user:${key}`, 10, 900000)) {
          headers['Retry-After'] = '900';
          return send(
            { error: 'Too many attempts. Try again in 15 minutes.' },
            429
          );
        }
        if (activeAuth >= 4) {
          headers['Retry-After'] = '1';
          return send(
            { error: 'Authentication is busy. Try again shortly.' },
            429
          );
        }
        activeAuth++;
        try {
          let user = db
            .query('SELECT * FROM users WHERE username=?')
            .get(key) as {
            id: string;
            username: string;
            password: string;
          } | null;
          if (parts[2] === 'register') {
            // Hash even for existing usernames to avoid a timing shortcut.
            const passwordHash = await Bun.password.hash(
              password,
              passwordOptions
            );
            if (user) return send({ error: 'Username is unavailable' }, 409);
            const id = crypto.randomUUID();
            const inserted = db
              .query('INSERT OR IGNORE INTO users VALUES(?,?,?)')
              .run(id, key, passwordHash);
            if (!inserted.changes)
              return send({ error: 'Username is unavailable' }, 409);
            user = { id, username: key, password: passwordHash };
          } else {
            const valid = await Bun.password.verify(
              password,
              user?.password ?? dummyHash
            );
            if (!user || !valid)
              return send({ error: 'Invalid username or password' }, 401);
          }
          db.query(
            'DELETE FROM tokens WHERE expires IS NOT NULL AND expires<=?'
          ).run(Date.now());
          const count = db
            .query(
              "SELECT COUNT(*) AS n FROM tokens WHERE user_id=? AND scope='session'"
            )
            .get(user.id) as { n: number };
          if (count.n >= 100)
            return send({ error: 'Device session limit reached' }, 409);
          const token = secret();
          db.query('INSERT INTO tokens VALUES(?,?,?,?,?,?)').run(
            hash(token),
            user.id,
            'Device session',
            'session',
            Date.now() + SESSION_MS,
            new Date().toISOString()
          );
          return send({ token, username: key });
        } finally {
          activeAuth--;
        }
      }
      if (parts[1] === 'public' && parts[2] === 'booking') {
        const slug = parts[3];
        const now = new Date();
        const found = getLink(db, slug);
        if (req.method === 'GET') {
          if (!requests.allow(`book-read:${clientIP}`, 60, 60000)) {
            headers['Retry-After'] = '60';
            return send({ error: 'Too many requests' }, 429);
          }
          if (!found || !found.link.enabled)
            return send({ error: 'Not found' }, 404);
          const today = localDate(now, found.link.tz);
          let from = url.searchParams.get('from') ?? today;
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
            !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) ||
            new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from
          )
            return send({ error: 'Invalid date' }, 400);
          if (from < today) from = today;
          const busy = busyFromTodos(store.list(found.uid, 'todos'));
          return send({
            title: found.link.title,
            duration_min: found.link.duration_min,
            tz: found.link.tz,
            from,
            days: 7,
            slots: computeSlots(found.link, busy, now, from, 7),
          });
        }
        if (req.method === 'POST') {
          const tooMany = () => {
            headers['Retry-After'] = '3600';
            return send({ error: 'Too many bookings. Try again later.' }, 429);
          };
          if (
            !attempts.allow(`book:${clientIP}`, 5, 3_600_000) ||
            !attempts.allow(`book-link:${slug}`, 30, 86_400_000)
          )
            return tooMany();
          const b = await readObject(req, 4096);
          const invalid = () =>
            send({ error: 'Check the form and try again' }, 400);
          if (
            Object.keys(b).length !== 5 ||
            ['start', 'name', 'contact', 'note', 'website'].some(
              (k) => typeof b[k] !== 'string'
            )
          )
            return invalid();
          const name = (b.name as string).trim(),
            contact = (b.contact as string).trim(),
            note = (b.note as string).trim();
          if (
            name.length < 1 ||
            name.length > 80 ||
            contact.length < 3 ||
            contact.length > 120 ||
            note.length > 500 ||
            /[\u0000-\u001f\u007f]/.test(name + contact) ||
            /[\u0000-\u0009\u000b-\u001f\u007f]/.test(note) ||
            !/^\d{4}-/.test(b.start as string) ||
            !Number.isFinite(Date.parse(b.start as string)) ||
            new Date(b.start as string).toISOString() !== b.start
          )
            return invalid();
          if (!found || !found.link.enabled)
            return send({ error: 'Not found' }, 404);
          if (b.website !== '')
            return send(
              {
                ok: true,
                start: b.start,
                duration_min: found.link.duration_min,
              },
              201
            );
          const { link, uid: owner } = found;
          const booked = db.transaction(() => {
            const busy = busyFromTodos(store.list(owner, 'todos'));
            if (!isSlotFree(link, busy, now, b.start as string)) return false;
            const cal = store.get(owner, 'calendars', link.calendar_id)
              ? link.calendar_id
              : 'daily';
            store.save(owner, 'todos', null, {
              name: `Meeting: ${name}`,
              datetime: b.start,
              time_needed: link.duration_min,
              calendar_id: cal,
              priority: 'moderate',
              status: 'pending',
              remind_me: true,
              description: `Booked through "${link.title}"\nContact: ${contact}${note ? `\n\n${note}` : ''}`,
            });
            return true;
          })();
          if (!booked)
            return send(
              { error: 'That time was just taken. Pick another.' },
              409
            );
          return send(
            { ok: true, start: b.start, duration_min: link.duration_min },
            201
          );
        }
        return send({ error: 'Not found' }, 404);
      }
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(
        req.headers.get('authorization') ?? ''
      )?.[1];
      if (!bearer) return send({ error: 'Sign in again to sync' }, 401);
      const token = db
        .query('SELECT * FROM tokens WHERE hash=?')
        .get(hash(bearer)) as any;
      if (!token || (token.expires && token.expires <= Date.now()))
        return send({ error: 'Sign in again to sync' }, 401);
      // Sliding session: renew at most once a day while the device is in use.
      if (
        token.scope === 'session' &&
        token.expires - Date.now() < SESSION_MS - RENEW_AFTER_MS
      )
        db.query('UPDATE tokens SET expires=? WHERE hash=?').run(
          Date.now() + SESSION_MS,
          hash(bearer)
        );
      const uid = token.user_id;
      if (req.method !== 'GET' && token.scope === 'read')
        return send({ error: 'This key is read-only' }, 403);
      if (!requests.allow(`user:${uid}`, 300, 60000)) {
        headers['Retry-After'] = '60';
        return send({ error: 'Too many requests' }, 429);
      }
      if (parts[1] === 'session' && req.method === 'DELETE') {
        if (token.scope !== 'session')
          return send({ error: 'Sign in to manage sessions' }, 403);
        db.query('DELETE FROM tokens WHERE hash=?').run(hash(bearer));
        return send({ ok: true });
      }
      if (parts[1] === 'keys') {
        if (token.scope !== 'session')
          return send({ error: 'Sign in to manage keys' }, 403);
        if (req.method === 'GET' && !parts[2])
          return send(
            db
              .query(
                "SELECT hash as id,name,scope,created_at FROM tokens WHERE user_id=? AND scope!='session'"
              )
              .all(uid)
          );
        if (req.method === 'POST' && !parts[2]) {
          const b = await body();
          exactFields(b, ['name', 'scope']);
          if (
            typeof b.name !== 'string' ||
            !b.name.trim() ||
            b.name.length > 100 ||
            (b.scope !== 'read' && b.scope !== 'write')
          )
            return send(
              { error: 'Provide a key name and read/write scope' },
              400
            );
          const count = db
            .query(
              "SELECT COUNT(*) AS n FROM tokens WHERE user_id=? AND scope!='session'"
            )
            .get(uid) as { n: number };
          if (count.n >= 50)
            return send({ error: 'API key limit reached' }, 409);
          const key = secret();
          db.query('INSERT INTO tokens VALUES(?,?,?,?,?,?)').run(
            hash(key),
            uid,
            b.name,
            b.scope,
            null,
            new Date().toISOString()
          );
          return send(
            { key, id: hash(key), name: b.name, scope: b.scope },
            201
          );
        }
        if (req.method === 'DELETE' && parts[2]) {
          db.query(
            "DELETE FROM tokens WHERE hash=? AND user_id=? AND scope!='session'"
          ).run(parts[2], uid);
          return send({ ok: true });
        }
      }
      if (parts[1] === 'sync' && req.method === 'POST') {
        if (token.scope !== 'session')
          return send(
            {
              error:
                'Sync requires a device session; agents use record endpoints',
            },
            403
          );
        const b = await body();
        exactFields(b, ['changes', 'since']);
        if (!Array.isArray(b.changes) || b.changes.length > 10000)
          return send({ error: 'Invalid sync batch' }, 400);
        const since = b.since as number | undefined;
        if (
          since !== undefined &&
          !(Number.isSafeInteger(since) && since >= 0)
        )
          return send({ error: 'Invalid sync cursor' }, 400);
        const changes = b.changes.map(validateChange);
        if (
          changes.some(
            (c: Change) => Date.parse(c.updated_at) > Date.now() + 300000
          )
        )
          return send(
            { error: 'Device clock is ahead. Correct it before syncing.' },
            400
          );
        merge(uid, changes);
        const cursor = (
          db
            .query('SELECT COALESCE(MAX(rev),0) AS rev FROM records WHERE user_id=?')
            .get(uid) as { rev: number }
        ).rev;
        if (since === undefined)
          return send({
            records: db
              .query('SELECT * FROM records WHERE user_id=?')
              .all(uid)
              .map(record),
            cursor,
          });
        // Submitted changes are echoed back even when they lost, so the client can
        // clear its queued edit.
        const rows = new Map<string, any>();
        const key = (r: { entity: string; id: string }) =>
          `${r.entity}\u0000${r.id}`;
        for (const r of db
          .query('SELECT * FROM records WHERE user_id=? AND rev>?')
          .all(uid, since))
          rows.set(key(r as any), r);
        for (const c of changes) {
          const r = db
            .query('SELECT * FROM records WHERE user_id=? AND entity=? AND id=?')
            .get(uid, c.entity, c.id);
          if (r) rows.set(key(c), r);
        }
        return send({
          records: [...rows.values()].map(record),
          cursor,
        });
      }
      if (parts[1] === 'prefs') {
        if (token.scope !== 'session')
          return send({ error: 'Sign in to manage preferences' }, 403);
        if (req.method === 'GET') return send(readPrefs(db, uid));
        if (req.method === 'PATCH') return send(writePrefs(db, uid, await body()));
        return send({ error: 'Not found' }, 404);
      }
      if (parts[1] === 'booking') {
        if (token.scope !== 'session')
          return send({ error: 'Sign in to manage booking links' }, 403);
        const slug = parts[2];
        if (req.method === 'GET' && !slug) return send(listLinks(db, uid));
        if (req.method === 'POST' && !slug) {
          const link = validateLink(await body());
          createLink(db, uid, link);
          return send(link, 201);
        }
        if (req.method === 'PATCH' && slug)
          return send(updateLink(db, uid, slug, await body()));
        if (req.method === 'DELETE' && slug) {
          deleteLink(db, uid, slug);
          return send({ ok: true });
        }
        return send({ error: 'Not found' }, 404);
      }
      if (parts[1] === 'brief') {
        if (req.method !== 'POST') return send({ error: 'Not found' }, 404);
        exactFields(await body(), []);
        if (!requests.allow(`brief:${uid}`, 6, 3_600_000)) {
          headers['Retry-After'] = '600';
          return send({ error: 'Too many requests' }, 429);
        }
        const prefs = readPrefs(db, uid);
        const now = new Date();
        const brief = buildBrief({
          store,
          uid,
          tz: prefs.tz,
          lang: prefs.brief_lang,
          now,
        });
        saveBrief(store, uid, brief, now);
        return send(store.get(uid, 'briefs', brief.date));
      }
      if (parts[1] === 'pick') {
        if (req.method !== 'GET') return send({ error: 'Not found' }, 404);
        const m = url.searchParams.get('minutes');
        if (m !== null && !(/^\d{1,4}$/.test(m) && +m >= 1 && +m <= 1440))
          throw new HttpError(400, 'Invalid minutes');
        const ws = url.searchParams.get('week_start');
        if (
          ws !== null &&
          !(
            /^\d{4}-/.test(ws) &&
            Number.isFinite(Date.parse(ws)) &&
            new Date(ws).toISOString() === ws
          )
        )
          throw new HttpError(400, 'Invalid week_start');
        const now = new Date();
        let weekStart: Date;
        if (ws) weekStart = new Date(ws);
        else {
          weekStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
          );
          weekStart = new Date(
            weekStart.getTime() - ((now.getUTCDay() + 6) % 7) * 86_400_000
          );
        }
        return send(
          pick(
            scoreCandidates({
              todos: store.list(uid, 'todos') as any,
              goals: store.list(uid, 'goals') as any,
              now,
              weekStart,
              minutes: m === null ? null : +m,
            })
          )
        );
      }
      if (parts[1] === 'history' && req.method === 'GET')
        return send(
          db
            .query(
              'SELECT entity,id,data,updated_at,archived_at FROM history WHERE user_id=? ORDER BY archived_at DESC LIMIT 200'
            )
            .all(uid)
            .map((r: any) => ({ ...r, data: r.data && JSON.parse(r.data) }))
        );
      if (!entities.includes(parts[1] as Entity))
        return send({ error: 'Not found' }, 404);
      const entity = parts[1] as Entity,
        id = parts[2];
      if (req.method === 'GET') {
        if (id) {
          const old = store.get(uid, entity, id);
          return old ? send(old) : send({ error: 'Not found' }, 404);
        }
        let rows = store.list(uid, entity, {
          calendar_id: url.searchParams.get('calendar_id') ?? undefined,
          goal_id: url.searchParams.get('goal_id') ?? undefined,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
        });
        if (url.searchParams.get('random') === '1')
          rows = rows.length
            ? [rows[Math.floor(Math.random() * rows.length)]]
            : [];
        return send(rows);
      }
      if (req.method === 'DELETE' && id) {
        store.remove(uid, entity, id);
        return send({ ok: true });
      }
      if ((req.method === 'POST' && !id) || (req.method === 'PATCH' && id)) {
        if (id && !store.get(uid, entity, id))
          return send({ error: 'Not found' }, 404);
        const b = await body();
        const { data, created } = store.save(uid, entity, id || null, b);
        return send(data, created ? 201 : 200);
      }
      return send({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError)
        return send({ error: error.message }, error.status);
      // Do not log request bodies, passwords, tokens, or SQLite bound parameters.
      console.error('Unhandled request failure');
      return send({ error: 'Server error' }, 500);
    }
  }
  return { fetch, db, config, store };
}
