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
| `/v1/goals` | GET, POST | List/create goals |
| `/v1/goals/{id}` | GET, PATCH, DELETE | Read, edit, or delete a goal. Deleting a goal leaves its tasks alone |
| `/v1/pick` | GET | Weighted random answer to "what should I do now?" |
| `/v1/briefs` | GET | Daily briefs, one per local date (`id` = `date`; fields `date`, `content` up to 20,000 chars). Written by the server; clients normally only read them |
| `/v1/history` | GET | Latest 200 overwritten versions for recovery |

Lists return arrays; single resources return objects; errors return `{ "error": "message" }` with an appropriate HTTP status. IDs and UTC ISO timestamps are server-generated on create and cannot be patched. Unknown fields are rejected. PATCH only sends changed fields. DELETE creates a sync tombstone. Calendar deletion returns 409 while tasks reference it.

All lists support `?q=text` and `?random=1`. Task lists additionally support `calendar_id`, `goal_id`, `status`, `from`, `to`. Date bounds are inclusive UTC ISO timestamps; encode query parameters. Omit bounds to inspect all tasks. Use calendar IDs from the calendar list. Local defaults use IDs `daily` and `work`, which appear after the first device sync.

Task fields: `name` (required), `description` (nullable), `datetime` (canonical UTC ISO), `time_needed` (nonnegative integer minutes or null), `priority` (`urgent`, `moderate`, `low`), `status` (`pending`, `in_progress`, `completed`, `cancelled`), `calendar_id` (default `daily`), `goal_id` (nullable goal ID; a goal ID matching no goal is treated as no goal), `parent_id` (nullable task ID), `remind_me` (boolean; device-local scheduling limitation in ../README.md).

Goal fields: `name` (required, up to 200), `description` (nullable), `importance` (integer 1-10, default 5), `weekly_target` (null or integer 1-100 completed tasks per week), `status` (`active`, `paused`, `done`).

`GET /v1/pick` (any scope) returns `{ "choice": Candidate | null, "alternatives": Candidate[] }`. Optional query parameters: `minutes` (integer 1-1440; skips tasks needing longer) and `week_start` (canonical UTC ISO start of the user's week; default the most recent Monday 00:00 UTC). A candidate is `{ kind: "todo" | "goal", id, name, goal_id, weight, reasons[] }`. The choice is a weighted random draw, so low-importance goals still surface occasionally; `alternatives` are the three heaviest other candidates.

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

`POST /v1/auth/register` (only when registration enabled) and `/v1/auth/login` accept `{username,password}` and return `{token,username}`. Session tokens can manage `/v1/keys` (GET list, POST `{name,scope}` where scope is `read`/`write`, DELETE `/v1/keys/{id}`). `DELETE /v1/session` revokes the current session. Device sessions last 90 days from last use; an authenticated request extends them, at most once a day. `POST /v1/sync` takes `{changes:[{entity,id,data,updated_at}]}` and returns `{records:[...],cursor}` including tombstones (`data:null`). `cursor` is the account's latest revision number. Send `since` (a non-negative integer, the last `cursor` you received) to get only what changed: `records` then holds the records revised after `since`, plus the server copy of every record you submitted in `changes`, so a stale edit still gets its queued change cleared. Without `since` the whole account is returned. Invalid `since` values get 400 `Invalid sync cursor`. Revision numbers are not part of record responses. Agents use CRUD endpoints rather than device sync.

## Standalone server limits

See [server operations](../README.md) for request sizes, registration configuration, throttles, account quotas, history retention, backup, and HTTPS deployment. Requests with JSON bodies must use `Content-Type: application/json`. Unsupported routes return 404. Throttled requests return 429 and `Retry-After`; size violations return 413, unsupported content types return 415, and account quota conflicts return 409. Sync payloads allow only `changes`; change objects allow only `entity`, `id`, `data`, and `updated_at`.

## Preferences and daily brief

Device sessions only (API keys get 403): `GET /v1/prefs` returns `{brief_enabled, brief_time ("HH:MM"), brief_lang ("en"|"ar"), tz (IANA zone)}`; `PATCH /v1/prefs` takes any subset and returns the updated object. Invalid values get 400 `Invalid preferences`.

`POST /v1/brief` (device session or write key, empty object body) builds today's brief in the user's `tz` and `brief_lang`, stores it as the `briefs` record for the local date (replacing an earlier one) and returns it. Limited to 6 per hour (429, `Retry-After: 600`). When `brief_enabled` is true the server also generates it automatically once `brief_time` has passed each local day.

## Booking links (device sessions only)

`GET /v1/booking` lists the account's links; `POST /v1/booking` creates one (201); `PATCH /v1/booking/{slug}` changes any field except `slug`; `DELETE /v1/booking/{slug}` removes it. An account may have 10 links; slugs are global (409 when taken). API keys get 403.

Link fields: `slug` (3-40 chars of `a-z0-9-`, not `app`, `api`, `v1`, `assets`, `static`), `title` (1-100), `duration_min` (15, 20, 30, 45, 60, 90, 120), `days` (weekdays 0=Sunday..6, unique, at least one), `start` / `end` (`HH:MM` in `tz`, end after start), `tz` (IANA zone), `buffer_min` (0-120), `notice_min` (0-10080), `horizon_days` (1-60), `calendar_id` (where bookings go; falls back to `daily` if missing), `enabled`.

A slot is free when it lies in the weekly window and does not overlap (with the buffer) an active task that has `time_needed`. Tasks without a duration do not block time.

## Public booking (no authentication)

`GET /v1/public/booking/{slug}?from=YYYY-MM-DD` returns `{title, duration_min, tz, from, days: 7, slots: [ISO...]}`; 404 for unknown or disabled links. `POST /v1/public/booking/{slug}` takes exactly `{start, name, contact, note, website}` (`website` is a honeypot and must be empty) and creates a task `Meeting: <name>` with a reminder; 409 when the slot was just taken, 429 when rate limited (5 per hour per IP, 30 per day per link). Visitors see a page at `/book/{slug}`.
