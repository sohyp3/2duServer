---
title: Pick endpoint
model: claude-opus-5-5
depends: ["01"]
---

## Goal
`GET /v1/pick` answers "what should I do now?" from the server's copy of the data, for any client
with a read key or a device session, including external agents.

## Files
- `src/pick.ts`: new, pure scoring
- `src/app.ts`: route
- `test/pick.test.ts`: new
- `docs/API.md`: document the route

## Do
1. Implement `src/pick.ts` exactly to the rules below. It is a pure module with no imports from
   the rest of the server. The app has the same file as `shared/pick.ts`; both must behave
   identically.

### The scoring rules (identical in the app and on the server)

Types:
```ts
export interface PickTodo {
  id: string; name: string; datetime: string; status: string; priority: string;
  time_needed: number | null; goal_id: string | null; updated_at: string;
}
export interface PickGoal {
  id: string; name: string; importance: number; weekly_target: number | null; status: string;
}
export interface Candidate {
  kind: 'todo' | 'goal'; id: string; name: string; goal_id: string | null;
  weight: number; reasons: string[];
}
export function scoreCandidates(input: {
  todos: PickTodo[]; goals: PickGoal[]; now: Date; weekStart: Date; minutes?: number | null;
}): Candidate[]
export function pick(
  candidates: Candidate[], rng: () => number = Math.random
): { choice: Candidate | null; alternatives: Candidate[] }
```

Definitions, with `DAY = 86_400_000` ms:
- An **active todo** has status `pending` or `in_progress`. An **active goal** has status `active`.
- A todo is **linked** when its `goal_id` matches an active goal. A todo whose `goal_id` matches a
  goal that is `paused` or `done` is skipped entirely. A todo whose `goal_id` matches no goal at
  all is treated as unlinked.
- For each active goal:
  - `done` = number of todos with that `goal_id`, status `completed`, and `updated_at >= weekStart`.
  - `idleDays` = days between `now` and the newest `updated_at` among that goal's todos with
    status `completed` or `in_progress`; 14 when there are none; capped to the range 0 to 14.
  - `neglect = 1 + idleDays / 14` (between 1 and 2).
  - `quota`: 1 when `weekly_target` is null. Otherwise `remaining = weekly_target - done`; when
    `remaining <= 0` the quota is 0.25; else `1 + (remaining / weekly_target) * elapsed * 2`,
    where `elapsed = clamp((now - weekStart) / (7 * DAY), 0, 1)`.

Todo candidates, one per active todo, except:
- skip when `minutes` is a number and `time_needed` is a number greater than `minutes` (a todo
  without `time_needed` always fits);
- skip when `datetime` is more than 7 days after `now`.

Weight of a todo candidate = `base * urgency * progress * goalFactor`:
- `base`: the goal's `importance` (1 to 10) when linked; otherwise by priority: `urgent` or `high`
  8, `moderate` or `medium` 5, `low` 2, anything else 5.
- `urgency` from `d = (datetime - now) / DAY`: `d <= 0` gives 3, `d <= 1` gives 2.5, `d <= 3` gives
  1.8, otherwise 1.3.
- `progress`: 1.2 when status is `in_progress`, else 1.
- `goalFactor`: `quota * neglect` of its goal when linked, else 1.

Goal candidates: every active goal that has no active todo becomes a candidate of kind `goal`
(`id` and `goal_id` are the goal's id, `name` is the goal's name) with weight
`importance * quota * neglect`. It always fits any `minutes`.

`reasons` are short English strings, in this order, only those that apply:
`importance 8` (linked todos and goal candidates), `overdue` (`d <= 0`), `due within a day`
(`0 < d <= 1`), `in progress`, `weekly target 1 of 3 done` (goal has a target),
`untouched for 6 days` (`idleDays >= 3`, rounded down), `fits 45 min` (when `minutes` was given and
the todo has `time_needed`).

`scoreCandidates` returns candidates sorted by weight descending, ties broken by `id` ascending.

`pick`: with no candidates returns `{ choice: null, alternatives: [] }`. Otherwise it draws
`r = rng() * totalWeight` and walks the sorted list subtracting weights until `r` is below zero or
equal; that candidate is `choice` (the last candidate if rounding runs off the end).
`alternatives` are the three heaviest candidates other than `choice`. The draw is random on
purpose: a low-importance goal must still get an occasional turn.

2. Route `GET /v1/pick` (add `pick` to the `validRoute` regular expression). Any authenticated
   scope may call it. Query parameters, both optional:
   - `minutes`: integer from 1 to 1440, else 400 `Invalid minutes`;
   - `week_start`: a canonical UTC ISO timestamp for the start of the user's week, else 400
     `Invalid week_start`. Default: the most recent Monday 00:00 UTC.
   Load the user's todos and goals with `store.list`, run `scoreCandidates` and `pick`, and answer
   `{ "choice": Candidate | null, "alternatives": Candidate[] }`.
3. Tests:
   - `test/pick.test.ts`: the unit cases for `scoreCandidates` and `pick` (overdue beats later;
     linked uses importance; `minutes` filter; 7-day horizon; paused goal skipped; weekly target
     early versus late in the week and the 0.25 floor; neglect; goal candidate only without active
     todos; `rng` 0 picks the heaviest; empty list gives `choice: null`), plus route tests: the
     route returns a choice for an account with one todo, `null` for an empty account, and 400 for
     `minutes=0` and a malformed `week_start`.
4. `docs/API.md`: document `GET /v1/pick`, its parameters, and the response shape.

## Done when
- `bun run verify` passes.

## Don't
- Don't store picks or add any table.
- Don't change the scoring rules; they must match the app.
