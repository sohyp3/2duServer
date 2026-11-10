import { HttpError } from './security';

export const entities = ['todos', 'notes', 'calendars', 'goals', 'briefs'] as const;
export type Entity = (typeof entities)[number];
export interface Change {
  entity: Entity;
  id: string;
  data: Record<string, unknown> | null;
  updated_at: string;
}
export const fields = {
  todos: [
    'id',
    'name',
    'description',
    'time_needed',
    'priority',
    'datetime',
    'status',
    'parent_id',
    'remind_me',
    'calendar_id',
    'goal_id',
    'created_at',
    'updated_at',
  ],
  notes: ['id', 'title', 'content', 'pinned', 'created_at', 'updated_at'],
  calendars: ['id', 'name', 'color', 'created_at', 'updated_at'],
  briefs: ['id', 'date', 'content', 'created_at', 'updated_at'],
  goals: [
    'id',
    'name',
    'description',
    'importance',
    'weekly_target',
    'status',
    'created_at',
    'updated_at',
  ],
} satisfies Record<Entity, string[]>;

export function validateChange(value: unknown): Change {
  const c = value as Change;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).some(
      (k) => !['entity', 'id', 'data', 'updated_at'].includes(k)
    ) ||
    !entities.includes(c.entity) ||
    typeof c.id !== 'string' ||
    !/^[\w-]{1,128}$/.test(c.id) ||
    !validDate(c.updated_at)
  )
    throw new HttpError(400, 'Invalid change');
  if (c.data !== null) {
    const d = c.data;
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      d.id !== c.id ||
      d.updated_at !== c.updated_at ||
      !validDate(d.created_at)
    )
      throw new HttpError(400, 'Invalid record');
    if (Object.keys(d).some((k) => !fields[c.entity].includes(k)))
      throw new HttpError(400, 'Unknown record field');
    if (c.entity === 'todos') {
      text(d.name, 500);
      text(d.description, 100000, true);
      if (
        !validDate(d.datetime) ||
        typeof d.priority !== 'string' ||
        !['urgent', 'moderate', 'low', 'medium', 'high'].includes(d.priority) ||
        typeof d.status !== 'string' ||
        !['pending', 'in_progress', 'completed', 'cancelled'].includes(d.status)
      )
        throw new HttpError(400, 'Invalid task');
      if (
        d.time_needed != null &&
        (!Number.isSafeInteger(d.time_needed) || Number(d.time_needed) < 0)
      )
        throw new HttpError(400, 'Invalid duration');
      flag(d.remind_me);
      if (d.parent_id != null) identifier(d.parent_id);
      if (d.calendar_id != null) identifier(d.calendar_id);
      if (d.goal_id != null) {
        if (typeof d.goal_id !== 'string' || d.goal_id.length > 128)
          throw new HttpError(400, 'Invalid reference');
      }
    } else if (c.entity === 'notes') {
      text(d.title, 500);
      if (typeof d.content !== 'string')
        throw new HttpError(400, 'Invalid note content');
      text(d.content, 100000, true);
      flag(d.pinned);
    } else if (c.entity === 'calendars') {
      text(d.name, 100);
      if (typeof d.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(d.color))
        throw new HttpError(400, 'Invalid calendar color');
    } else if (c.entity === 'goals') {
      text(d.name, 200);
      text(d.description, 10000, true);
      if (
        !Number.isSafeInteger(d.importance) ||
        Number(d.importance) < 1 ||
        Number(d.importance) > 10 ||
        (d.weekly_target != null &&
          (!Number.isSafeInteger(d.weekly_target) ||
            Number(d.weekly_target) < 1 ||
            Number(d.weekly_target) > 100)) ||
        typeof d.status !== 'string' ||
        !['active', 'paused', 'done'].includes(d.status)
      )
        throw new HttpError(400, 'Invalid goal');
    } else if (c.entity === 'briefs') {
      if (
        typeof d.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
        d.date !== c.id ||
        typeof d.content !== 'string' ||
        d.content.length > 20000
      )
        throw new HttpError(400, 'Invalid brief');
    }
  }
  return c;
}
function validDate(v: unknown) {
  return (
    typeof v === 'string' &&
    /^\d{4}-/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
function text(v: unknown, max: number, optional = false) {
  if (optional && v == null) return;
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim()))
    throw new HttpError(400, 'Invalid text');
}
function flag(v: unknown) {
  if (![true, false, 0, 1].includes(v as boolean))
    throw new HttpError(400, 'Invalid boolean');
}

function identifier(v: unknown) {
  if (typeof v !== 'string' || !/^[\w-]{1,128}$/.test(v))
    throw new HttpError(400, 'Invalid reference');
}
