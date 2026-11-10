import type { Provider } from './config';
import { chat, type ChatMessage, type ToolSpec } from './llm';
import type { createStore } from './store';
import { HttpError } from './security';

type Store = ReturnType<typeof createStore>;
interface Ctx {
  store: Store;
  uid: string;
  now: Date;
}
export interface AgentTool {
  spec: ToolSpec;
  run(ctx: Ctx, args: any): unknown;
  writes: boolean;
}

const MAX_MODEL_CALLS = 8;
const MAX_RESULT_CHARS = 20_000;
const MAX_LIST_RECORDS = 100;
const FALLBACK = 'I could not finish that. Try a smaller request.';

const priority = { type: 'string', enum: ['urgent', 'moderate', 'low'] };
const todoStatus = {
  type: 'string',
  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
};
const todoFields = {
  name: { type: 'string' },
  datetime: {
    type: 'string',
    description: 'UTC ISO 8601 with milliseconds, e.g. 2026-11-10T09:00:00.000Z',
  },
  description: { type: 'string' },
  priority,
  time_needed: { type: 'integer', minimum: 0 },
  calendar_id: { type: 'string' },
  remind_me: { type: 'boolean' },
  status: todoStatus,
};
const noteFields = {
  title: { type: 'string' },
  content: { type: 'string' },
  pinned: { type: 'boolean' },
};
const idProp = { id: { type: 'string' } };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  writes: boolean,
  run: AgentTool['run']
): AgentTool {
  return {
    spec: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        },
      },
    },
    run,
    writes,
  };
}

const id = (args: any): string => {
  if (typeof args?.id !== 'string') throw new HttpError(400, 'Invalid id');
  return args.id;
};
const without = (args: any, key: string) => {
  const { [key]: _, ...rest } = args;
  return rest;
};

// Tools map one-to-one onto the store. Later plans can append to this table.
export const agentTools: AgentTool[] = [
  tool(
    'list_todos',
    'List tasks, optionally filtered by UTC datetime range, status, calendar or text.',
    {
      from: { type: 'string', description: 'UTC ISO, inclusive' },
      to: { type: 'string', description: 'UTC ISO, inclusive' },
      status: todoStatus,
      calendar_id: { type: 'string' },
      q: { type: 'string' },
    },
    [],
    false,
    ({ store, uid }, args) => store.list(uid, 'todos', args)
  ),
  tool(
    'create_todo',
    'Create a task.',
    todoFields,
    ['name'],
    true,
    ({ store, uid }, args) => store.save(uid, 'todos', null, args).data
  ),
  tool(
    'update_todo',
    'Change fields of an existing task. Look it up first to get its id.',
    { ...idProp, ...todoFields },
    ['id'],
    true,
    ({ store, uid }, args) =>
      store.save(uid, 'todos', id(args), without(args, 'id')).data
  ),
  tool(
    'delete_todo',
    'Delete a task.',
    idProp,
    ['id'],
    true,
    ({ store, uid }, args) => {
      store.remove(uid, 'todos', id(args));
      return { ok: true };
    }
  ),
  tool(
    'list_notes',
    'List notes, optionally filtered by text.',
    { q: { type: 'string' } },
    [],
    false,
    ({ store, uid }, args) => store.list(uid, 'notes', args)
  ),
  tool(
    'create_note',
    'Create a note.',
    noteFields,
    ['title'],
    true,
    ({ store, uid }, args) => store.save(uid, 'notes', null, args).data
  ),
  tool(
    'update_note',
    'Change fields of an existing note. Look it up first to get its id.',
    { ...idProp, ...noteFields },
    ['id'],
    true,
    ({ store, uid }, args) =>
      store.save(uid, 'notes', id(args), without(args, 'id')).data
  ),
  tool(
    'delete_note',
    'Delete a note.',
    idProp,
    ['id'],
    true,
    ({ store, uid }, args) => {
      store.remove(uid, 'notes', id(args));
      return { ok: true };
    }
  ),
  tool(
    'list_calendars',
    'List calendars.',
    {},
    [],
    false,
    ({ store, uid }) => store.list(uid, 'calendars')
  ),
  tool(
    'create_calendar',
    'Create a calendar.',
    {
      name: { type: 'string' },
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    },
    ['name'],
    true,
    ({ store, uid }, args) => store.save(uid, 'calendars', null, args).data
  ),
];

function systemPrompt(tz: string, now: Date): string {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(now);
  return [
    "You manage the user's tasks, notes and calendars in 2du, using the tools provided.",
    `Current time: ${now.toISOString()} (UTC). In the user's time zone (${tz}) it is ${local}.`,
    'All stored datetimes are UTC ISO strings with milliseconds, such as 2026-11-10T09:00:00.000Z. The user speaks in local time, so convert every time you read or write.',
    'Look records up before changing them. Never invent ids.',
    'Do what was asked without asking for confirmation, unless the request is ambiguous or would delete more than five records.',
    'Reply briefly, in the language the user wrote in (Arabic or English), and say what you changed.',
  ].join('\n');
}

export async function runAgent(input: {
  store: Store;
  provider: Provider;
  fetchImpl: typeof fetch;
  uid: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tz: string;
  now?: Date;
}): Promise<{ reply: string; changed: boolean }> {
  const now = input.now ?? new Date();
  const ctx: Ctx = { store: input.store, uid: input.uid, now };
  const specs = agentTools.map((t) => t.spec);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input.tz, now) },
    ...input.messages,
  ];
  let changed = false;

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const answer = await chat(
      input.provider,
      messages,
      specs,
      input.fetchImpl
    );
    const calls = answer.tool_calls ?? [];
    if (calls.length === 0)
      return { reply: answer.content ?? '', changed };
    messages.push({
      role: 'assistant',
      content: answer.content,
      tool_calls: calls,
    });
    for (const toolCall of calls) {
      const found = agentTools.find(
        (t) => t.spec.function.name === toolCall.function?.name
      );
      let result: unknown;
      try {
        if (!found) throw new HttpError(400, 'Unknown tool');
        let args: unknown;
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          throw new HttpError(400, 'Tool arguments must be JSON');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new HttpError(400, 'Tool arguments must be a JSON object');
        result = found.run(ctx, args);
        if (found.writes) changed = true;
        if (found.spec.function.name.startsWith('list_') && Array.isArray(result))
          result = {
            records: result.slice(0, MAX_LIST_RECORDS),
            truncated: result.length > MAX_LIST_RECORDS,
          };
      } catch (error) {
        result = {
          error:
            error instanceof HttpError ? error.message : 'The tool failed',
        };
      }
      let content = JSON.stringify(result) ?? 'null';
      if (content.length > MAX_RESULT_CHARS)
        content = `${content.slice(0, MAX_RESULT_CHARS)}… [result cut to ${MAX_RESULT_CHARS} characters]`;
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content,
      });
    }
  }
  return { reply: FALLBACK, changed };
}
