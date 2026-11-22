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
| `/v1/goal_categories` | GET, POST | List/create named, coloured goal categories |
| `/v1/goal_categories/{id}` | GET, PATCH, DELETE | Rename, recolour, or delete a category. Deleting a category leaves its goals alone |
| `/v1/pick` | GET | Weighted random answer to "what should I do now?" |
| `/v1/briefs` | GET | Daily briefs, one per local date (`id` = `date`; fields `date`, `content` up to 20,000 chars). Written by the server; clients normally only read them |
| `/v1/history` | GET | Latest 200 overwritten versions for recovery |

Lists return arrays; single resources return objects; errors return `{ "error": "message" }` with an appropriate HTTP status. IDs and UTC ISO timestamps are server-generated on create and cannot be patched. Unknown fields are rejected. PATCH only sends changed fields. DELETE creates a sync tombstone. Calendar deletion returns 409 while tasks reference it.

All lists support `?q=text` and `?random=1`. Task lists additionally support `calendar_id`, `goal_id`, `status`, `from`, `to`. Date bounds are inclusive UTC ISO timestamps; encode query parameters. Omit bounds to inspect all tasks. Use calendar IDs from the calendar list. Local defaults use IDs `daily` and `work`, which appear after the first device sync.

Task fields: `name` (required), `description` (nullable), `datetime` (canonical UTC ISO), `time_needed` (nonnegative integer minutes or null), `priority` (`urgent`, `moderate`, `low`), `status` (`pending`, `in_progress`, `completed`, `cancelled`), `calendar_id` (default `daily`), `goal_id` (nullable goal ID; a goal ID matching no goal is treated as no goal), `parent_id` (nullable task ID), `remind_me` (boolean; device-local scheduling limitation in ../README.md).

Goal fields: `name` (required, up to 200), `description` (nullable), `importance` (integer 1-10, default 5), `weekly_target` (null or integer 1-100 completed tasks per week), `status` (`active`, `paused`, `done`), `category_id` (nullable goal category ID; a category ID matching no category is treated as uncategorised; optional, so older goal records without it still sync).

Goal category fields: `name` (required, up to 60), `color` (`#rrggbb`, default `#6c4dff`). Sync entity name: `goal_categories`.

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

`POST /v1/auth/register` (only when registration enabled) and `/v1/auth/login` accept `{username,password}` and return `{token,username}`. Session tokens can manage `/v1/keys` (see [Key scopes](#key-scopes)). `DELETE /v1/session` revokes the current session. Device sessions last 90 days from last use; an authenticated request extends them, at most once a day. `POST /v1/sync` takes `{changes:[{entity,id,data,updated_at}]}` and returns `{records:[...],cursor}` including tombstones (`data:null`). `cursor` is the account's latest revision number. Send `since` (a non-negative integer, the last `cursor` you received) to get only what changed: `records` then holds the records revised after `since`, plus the server copy of every record you submitted in `changes`, so a stale edit still gets its queued change cleared. Without `since` the whole account is returned. Invalid `since` values get 400 `Invalid sync cursor`. Revision numbers are not part of record responses. Agents use CRUD endpoints rather than device sync.

## Account (device sessions only)

Both routes accept only a device session token; any API key gets 403. Both are throttled like sign-in (10 attempts per username per 15 minutes, 429) and share the server's limit on concurrent password checks.

- `POST /v1/account/password` takes exactly `{current, next}`. `next` must be 10-1024 characters (400 otherwise). A wrong `current` gets 401 `Current password is wrong`. On success it stores the new password, signs out every other device session of the account (the current one stays signed in), keeps all API keys, and returns `{ok: true}`.
- `DELETE /v1/account` takes exactly `{password}`. A wrong password gets 401 `Password is wrong`. On success it permanently deletes the account and all its data (records, history, preferences, booking links, sessions and keys) in one transaction and returns `{ok: true}`. Later requests with any of its tokens get 401.

Sign-up (`POST /v1/auth/register`) is limited to 5 per client IP per hour (429 `Too many sign-ups from this network. Try again later.`). When the server sets `MAX_USERS` and that many accounts exist, sign-up gets 403 `This server is full`. Behind a reverse proxy on the same host, set `TRUST_PROXY=true` so rate limits use the proxy's `X-Real-IP` header; it is only read from loopback connections.

## Key scopes

| Scope | Can do |
|---|---|
| `session` | A device sign-in. Everything, including sync, keys, history, prefs, booking links and brief records. Expires 90 days after last use. |
| `read` | GET on records and `/v1/pick`. No history. |
| `write` | Record CRUD and `POST /v1/brief`. Not `/v1/history` and not POST/PATCH/DELETE on `/v1/briefs`. |
| `book` | Only `/v1/agent/*` (see Agent booking). |
| `add` | Only `POST /v1/todos`, `POST /v1/notes`, `GET /v1/calendars` and `GET /v1/goals` (lists, no ids). 403 `This key can only add tasks and notes` otherwise. |
| `feed` | A calendar feed link. Every `/v1` route returns 403 `This key only works as a calendar feed link`. |

Keys are managed with a session token:

- `POST /v1/keys` takes `{name, scope, expires_days?, calendar_ids?}`. `scope` is `read`, `write`, `book`, `add` or `feed`. `expires_days` is `30`, `90`, `365` or `null`/absent (never expires). `calendar_ids` (array of 1-50 ids, each `[A-Za-z0-9_-]{1,128}`) is allowed only with `feed`. Returns 201 `{key, id, name, scope, expires, meta}`; `key` is shown once, `expires` is epoch milliseconds or null, `meta` is `{calendar_ids}` or null. An expired key gets 401.
- `GET /v1/keys` lists non-session keys: `[{id, name, scope, created_at, expires, last_used, meta}]`. `last_used` is a UTC ISO time updated at most once an hour, or null if never used.
- `DELETE /v1/keys/{id}` revokes a key.

## Calendar feed (`feed` keys)

`GET /feed/{key}.ics` (no `Authorization` header; the key is in the URL) returns the account's tasks as an iCalendar (RFC 5545) feed that Google, Apple and Outlook Calendar can subscribe to. Create the key with `POST /v1/keys` `{"name":"Calendar","scope":"feed"}`, then subscribe to `https://<host>/feed/<key>.ics`. Apple and Outlook also accept it as `webcal://<host>/feed/<key>.ics` (replace `https://` with `webcal://`); in Google Calendar use "From URL" with the `https://` link.

- Includes tasks dated from 60 days ago to 365 days ahead, excluding cancelled tasks and subtasks. Each task is a UTC event from `datetime` lasting `time_needed` minutes (30 when unset); completed tasks are prefixed with `✓ `. No time zones or recurrence.
- Filter: create the key with `calendar_ids` to include only those calendars. The feed is then named `2du (<calendar names>)`, otherwise `2du`.
- Response: `text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`. Limited to 60 requests per key per hour (429).
- A key that does not exist, is not a `feed` key, or has expired gets 404 `Not found`. Revoke the key with `DELETE /v1/keys/{id}` to stop the feed.

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

## Agent booking (`book` keys)

A `book` key is for a reservation agent (n8n, a chatbot). It can see free times on its owner's enabled booking links and book them, and gets 403 on every other route: it cannot read or change tasks, notes, calendars, titles of existing events, or link settings. Create one with a session token: `POST /v1/keys {"name":"n8n","scope":"book"}`.

- `GET /v1/agent/booking` lists enabled links: `[{slug, title, duration_min, tz, url}]`. `url` is the public page to send a customer.
- `GET /v1/agent/booking/{slug}?from=YYYY-MM-DD&days=1-14` returns `{title, duration_min, tz, url, from, days, slots: [ISO...]}`. Defaults: today in the link's zone, 7 days.
- `POST /v1/agent/booking/{slug}` takes `{start, name, contact, note?}` (`start` exactly as listed in `slots`) and returns 201 `{ok, start, end, duration_min, title}`. The task is created like a public booking and its description says which key booked it. 409 when the time is not free, 400 for bad input, 404 for links of other accounts. Limits: 30 bookings an hour and 100 a day per key.
