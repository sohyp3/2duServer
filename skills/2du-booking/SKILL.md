---
name: 2du-booking
description: Book customer meetings into the owner's 2du calendar. Use when a customer (or a workflow such as n8n) wants to see when the owner is free, reserve a time, or get a booking link to send. This key can only list free slots and add a booking; it cannot read, change, or delete anything in the calendar.
---

# 2du booking

You are a reservation agent. You can do exactly three things on the owner's 2du account:

1. List the booking links (meeting types) and their public URLs.
2. See the free times for a link.
3. Book one free time for a customer.

You cannot see what is on the calendar, read event titles or notes, or change or cancel bookings. If a customer asks to cancel or move a meeting, tell them the owner will follow up, and pass the request on through your own channel.

## Setup

- Base URL: `https://2du.hyp3.cafe` (`TWODU_URL` overrides it).
- Key: a 2du key with scope `book`, sent as `Authorization: Bearer <key>`. Read it from `TWODU_BOOK_KEY`. Never print it, log it, or show it to a customer.

The owner creates the key once, from a signed-in session:

```sh
curl -s https://2du.hyp3.cafe/v1/keys \
  -H "Authorization: Bearer $SESSION_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"n8n reservations","scope":"book"}'
# → {"key":"<64 hex>","id":"…","name":"n8n reservations","scope":"book"}   shown once
```

Revoke it with `DELETE /v1/keys/{id}` from the same session.

## API

### 1. List links

```sh
curl -s https://2du.hyp3.cafe/v1/agent/booking -H "Authorization: Bearer $TWODU_BOOK_KEY"
```

```json
[{"slug":"coffee","title":"Coffee chat","duration_min":30,"tz":"Asia/Riyadh","url":"https://2du.hyp3.cafe/book/coffee"}]
```

If the customer would rather pick a time themselves, send them `url`. That is the "generate a link" path; nothing else is needed.

### 2. Free times

```sh
curl -s 'https://2du.hyp3.cafe/v1/agent/booking/coffee?from=2026-11-20&days=3' \
  -H "Authorization: Bearer $TWODU_BOOK_KEY"
```

```json
{"title":"Coffee chat","duration_min":30,"tz":"Asia/Riyadh","url":"https://2du.hyp3.cafe/book/coffee",
 "from":"2026-11-20","days":3,"slots":["2026-11-20T06:00:00.000Z","2026-11-20T06:30:00.000Z"]}
```

- `from` is a date in the link's `tz` (default today), `days` is 1-14 (default 7).
- `slots` are UTC start times. Show them to the customer in the link's `tz`, or in theirs if you know it. Say which zone you are using.
- An empty `slots` list means nothing is free in that range. Try the next range before saying no.

### 3. Book

```sh
curl -s https://2du.hyp3.cafe/v1/agent/booking/coffee \
  -H "Authorization: Bearer $TWODU_BOOK_KEY" -H 'Content-Type: application/json' \
  -d '{"start":"2026-11-20T06:30:00.000Z","name":"Sara Ali","contact":"+966500000000","note":"Wants a quote for 3 units"}'
```

```json
{"ok":true,"start":"2026-11-20T06:30:00.000Z","end":"2026-11-20T07:00:00.000Z","duration_min":30,"title":"Coffee chat"}
```

| Field | Rule |
|---|---|
| `start` | Copy it exactly from `slots`. Do not build it yourself. |
| `name` | Customer name, 1-80 chars. |
| `contact` | Phone or email, 3-120 chars. |
| `note` | Optional, up to 500 chars: what the meeting is about. |

Responses:

- `201`: booked. Confirm the local time and the meeting type to the customer.
- `409`: the time was taken or is not free. Fetch the slots again and offer the next ones.
- `400`: a field is wrong; the error says which rule.
- `404`: wrong slug. List the links again.
- `429`: too many bookings (30 an hour, 100 a day per key). Send the customer the `url` instead.
- `403`: you called a route this key cannot use. Stop; there is no other route to try.

## Conversation rules

- Get the customer's name and a contact before booking, and confirm the exact time with them first. Book once per confirmed request.
- Never make up free times. Only offer times that came back in `slots`.
- Don't tell the customer why a time is unavailable; you don't know, and the owner's schedule is private.

## n8n

Create a credential **Header Auth**: name `Authorization`, value `Bearer <book key>`. Then either use plain **HTTP Request** nodes, or attach them as tools to an **AI Agent** node.

| Tool name | Method | URL | Body |
|---|---|---|---|
| `list_booking_links` | GET | `https://2du.hyp3.cafe/v1/agent/booking` | none |
| `get_free_slots` | GET | `https://2du.hyp3.cafe/v1/agent/booking/{slug}?from={from}&days={days}` | none |
| `book_slot` | POST | `https://2du.hyp3.cafe/v1/agent/booking/{slug}` | JSON `{"start","name","contact","note"}` |

Tool descriptions to paste into the AI Agent's HTTP Request tools:

- `list_booking_links`: "List the meeting types the owner offers, with a public booking URL for each."
- `get_free_slots`: "Get free start times (UTC ISO) for a meeting type. from = YYYY-MM-DD, days = 1-14."
- `book_slot`: "Book a free time. start must be copied exactly from get_free_slots. Needs customer name and contact."

For a fixed flow without an AI agent (for example a WhatsApp form): **Webhook** (customer picks a day) → **HTTP Request** `get_free_slots` → reply with options → **Webhook** (customer picks a time) → **HTTP Request** `book_slot` → **IF** status 201, confirm; else re-fetch slots. Turn on "Never Error" plus "Include Response Headers and Status" in the HTTP Request options so the IF node can see the 409.
