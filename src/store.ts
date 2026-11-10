import type { Database } from 'bun:sqlite';
import {
  fields,
  validateChange,
  type Change,
  type Entity,
} from './records';
import { HttpError } from './security';

export type Row = Record<string, unknown>;

export interface ListFilters {
  calendar_id?: string;
  from?: string;
  to?: string;
  status?: string;
  q?: string;
}

export function createStore(db: Database) {
  const merge = db.transaction((uid: string, changes: Change[]) => {
    let rev = (
      db
        .query('SELECT COALESCE(MAX(rev),0) AS rev FROM records WHERE user_id=?')
        .get(uid) as { rev: number }
    ).rev;
    const usage = db
      .query(
        'SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM records WHERE user_id=?'
      )
      .get(uid) as { n: number; bytes: number };
    for (const c of changes) {
      const old = db
        .query('SELECT * FROM records WHERE user_id=? AND entity=? AND id=?')
        .get(uid, c.entity, c.id) as any;
      const data =
        c.data === null
          ? null
          : JSON.stringify(c.data, [...fields[c.entity]].sort());
      if (old && old.data === data && old.updated_at === c.updated_at) continue;
      // Concurrent edits are deterministic; both versions remain recoverable in history.
      const wins =
        !old ||
        c.updated_at > old.updated_at ||
        (c.updated_at === old.updated_at &&
          (data === null || (old.data !== null && data > old.data)));
      if (!old && ++usage.n > 20_000)
        throw new HttpError(409, 'Account record limit reached');
      if (wins) {
        usage.bytes +=
          (data ? Buffer.byteLength(data) : 0) -
          (old?.data ? Buffer.byteLength(old.data) : 0);
        if (usage.bytes > 25_000_000)
          throw new HttpError(409, 'Account storage limit reached');
      }
      if (
        old &&
        !db
          .query(
            'SELECT 1 FROM history WHERE user_id=? AND entity=? AND id=? AND data IS ? AND updated_at=?'
          )
          .get(
            uid,
            c.entity,
            c.id,
            wins ? old.data : data,
            wins ? old.updated_at : c.updated_at
          )
      )
        db.query('INSERT INTO history VALUES(?,?,?,?,?,?)').run(
          uid,
          c.entity,
          c.id,
          wins ? old.data : data,
          wins ? old.updated_at : c.updated_at,
          new Date().toISOString()
        );
      if (wins)
        db.query(
          'INSERT OR REPLACE INTO records(user_id,entity,id,data,updated_at,rev) VALUES(?,?,?,?,?,?)'
        ).run(uid, c.entity, c.id, data, c.updated_at, ++rev);
    }
    db.query(
      'DELETE FROM history WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM history WHERE user_id=? ORDER BY archived_at DESC, rowid DESC LIMIT 2000)'
    ).run(uid, uid);
  });
  const record = (r: any): Change => ({
    entity: r.entity,
    id: r.id,
    data: r.data === null ? null : JSON.parse(r.data),
    updated_at: r.updated_at,
  });
  function liveRow(uid: string, entity: Entity, id: string): any {
    const row = db
      .query('SELECT * FROM records WHERE user_id=? AND entity=? AND id=?')
      .get(uid, entity, id) as any;
    return row?.data ? row : null;
  }

  function list(uid: string, entity: Entity, filters: ListFilters = {}): Row[] {
    let rows = (
      db
        .query(
          'SELECT * FROM records WHERE user_id=? AND entity=? AND data IS NOT NULL'
        )
        .all(uid, entity) as any[]
    ).map((r) => JSON.parse(r.data) as Row);
    if (entity === 'todos')
      rows = rows.filter(
        (r) =>
          (filters.calendar_id === undefined ||
            r.calendar_id === filters.calendar_id) &&
          (filters.from === undefined || (r.datetime as string) >= filters.from) &&
          (filters.to === undefined || (r.datetime as string) <= filters.to) &&
          (filters.status === undefined || r.status === filters.status)
      );
    const q = filters.q?.toLowerCase();
    if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    return rows;
  }

  function get(uid: string, entity: Entity, id: string): Row | null {
    const row = liveRow(uid, entity, id);
    return row ? (JSON.parse(row.data) as Row) : null;
  }

  function save(
    uid: string,
    entity: Entity,
    id: string | null,
    patch: Row
  ): { data: Row; created: boolean } {
    const oldRow = id
      ? (db
          .query('SELECT * FROM records WHERE user_id=? AND entity=? AND id=?')
          .get(uid, entity, id) as any)
      : null;
    const old = oldRow?.data ? (JSON.parse(oldRow.data) as Row) : null;
    if (id && !old) throw new HttpError(404, 'Not found');
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (k) =>
          !fields[entity].includes(k) ||
          ['id', 'created_at', 'updated_at'].includes(k)
      )
    )
      throw new HttpError(400, 'Invalid fields');
    const now = new Date(
        Math.max(Date.now(), oldRow ? Date.parse(oldRow.updated_at) + 1 : 0)
      ).toISOString(),
      rid = id || crypto.randomUUID();
    const defaults =
      entity === 'todos'
        ? {
            description: null,
            priority: 'moderate',
            status: 'pending',
            datetime: now,
            remind_me: false,
            parent_id: null,
            time_needed: null,
            calendar_id: 'daily',
          }
        : entity === 'notes'
          ? { content: '', pinned: false }
          : { color: '#a7c968' };
    const data = {
      ...defaults,
      ...old,
      ...patch,
      id: rid,
      created_at: old?.created_at || now,
      updated_at: now,
    };
    const change = validateChange({ entity, id: rid, data, updated_at: now });
    merge(uid, [change]);
    return { data, created: !id };
  }

  function remove(uid: string, entity: Entity, id: string): void {
    const oldRow = liveRow(uid, entity, id);
    if (!oldRow) throw new HttpError(404, 'Not found');
    if (
      entity === 'calendars' &&
      db
        .query(
          "SELECT id FROM records WHERE user_id=? AND entity='todos' AND json_extract(data,'$.calendar_id')=? LIMIT 1"
        )
        .get(uid, id)
    )
      throw new HttpError(
        409,
        'Move tasks out of this calendar before deleting it'
      );
    merge(uid, [
      {
        entity,
        id,
        data: null,
        updated_at: new Date(
          Math.max(Date.now(), Date.parse(oldRow.updated_at) + 1)
        ).toISOString(),
      },
    ]);
  }

  return { merge, record, list, get, save, remove };
}
