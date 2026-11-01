# Connect an AI agent

No model provider is built into 2du. Bring your agent and give it an account-scoped REST key from **Settings → A key for your agent**. The key is displayed once. Choose read-only for browsing or read & write to create/edit/delete. Revoke a key in Settings at any time. Agent keys cannot create keys, authenticate devices, or access other accounts. A read & write key can delete data; give it only to agents you trust.

The API is the supported integration; it is not an MCP transport. An agent with HTTP tools can call it directly, or an MCP gateway can wrap these routes. The agent interacts with server data; offline device edits arrive at the next successful sync.

Every request except health/login/register needs:

```http
Authorization: Bearer YOUR_KEY
Content-Type: application/json
```

## Resources

| Route | Methods | Meaning |
|---|---|---|
| `/v1/todos` | GET, POST | List or create scheduled tasks |
| `/v1/todos/{id}` | GET, PATCH, DELETE | Read, edit, complete, reschedule, or delete a task |
| `/v1/notes` | GET, POST | Notes, random thoughts, Markdown content |
| `/v1/notes/{id}` | GET, PATCH, DELETE | Read, edit, pin, or delete a note |
| `/v1/calendars` | GET, POST | List/create named, colored calendars |
| `/v1/calendars/{id}` | GET, PATCH, DELETE | Rename, recolor, delete an empty calendar |
| `/v1/history` | GET | Latest 200 overwritten versions for recovery |

Lists return arrays; single resources return objects; errors return `{ "error": "message" }` with an appropriate HTTP status. IDs and UTC ISO timestamps are server-generated on create and cannot be patched. Unknown fields are rejected. PATCH only sends changed fields. DELETE creates a sync tombstone. Calendar deletion returns 409 while tasks reference it.

All lists support `?q=text` and `?random=1`. Task lists additionally support `calendar_id`, `status`, `from`, `to`. Date bounds are inclusive UTC ISO timestamps; encode query parameters. Omit bounds to inspect all tasks. Use calendar IDs from the calendar list. Local defaults use IDs `daily` and `work`, which appear after the first device sync.

Task fields: `name` (required), `description` (nullable), `datetime` (canonical UTC ISO), `time_needed` (nonnegative integer minutes or null), `priority` (`urgent`, `moderate`, `low`), `status` (`pending`, `in_progress`, `completed`, `cancelled`), `calendar_id` (default `daily`), `parent_id` (nullable task ID), `remind_me` (boolean; device-local scheduling limitation in ../README.md).

Note fields: `title` (required), `content` (Markdown string, default empty), `pinned` (boolean).

Calendar fields: `name` (required, max 100 characters), `color` (six-digit hex, default `#a7c968`). Task/note titles max 500 characters; content/description max 100,000. Numeric SQLite booleans 0/1 are also accepted and can appear in synced records.

## Examples

```sh
export TWODU_URL=https://sync.example.com
export TWODU_KEY=your-key

curl "$TWODU_URL/v1/notes?random=1" -H "Authorization: Bearer $TWODU_KEY"

curl "$TWODU_URL/v1/notes" -H "Authorization: Bearer $TWODU_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"A thought from my agent","content":"Try a smaller first step."}'

curl "$TWODU_URL/v1/todos" -H "Authorization: Bearer $TWODU_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Review the draft","datetime":"2026-11-02T09:00:00.000Z","calendar_id":"work","priority":"moderate"}'

curl -X PATCH "$TWODU_URL/v1/todos/TASK_ID" \
  -H "Authorization: Bearer $TWODU_KEY" -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

Suggested agent instruction: “Use my 2du API to manage my tasks, calendars, and notes. Read relevant existing records before editing, use the user's timezone when translating dates, preserve unrelated fields, and report what changed. Never expose the API key.”

## Device-only endpoints

`POST /v1/auth/register` (only when registration enabled) and `/v1/auth/login` accept `{username,password}` and return `{token,username}`. Session tokens can manage `/v1/keys` (GET list, POST `{name,scope}` where scope is `read`/`write`, DELETE `/v1/keys/{id}`). `DELETE /v1/session` revokes the current session. `POST /v1/sync` takes `{changes:[{entity,id,data,updated_at}]}` and returns `{records:[...]}` including tombstones (`data:null`). Agents use CRUD endpoints rather than device sync.

## Standalone server limits

See [server operations](../README.md) for request sizes, registration configuration, throttles, account quotas, history retention, backup, and HTTPS deployment. Requests with JSON bodies must use `Content-Type: application/json`. Unsupported routes return 404. Throttled requests return 429 and `Retry-After`; size violations return 413, unsupported content types return 415, and account quota conflicts return 409. Sync payloads allow only `changes`; change objects allow only `entity`, `id`, `data`, and `updated_at`.
