---
title: Goals entity and goal_id on tasks
model: claude-sonnet-5-5
depends: []
---

## Goal
Goals sync like tasks and notes, have REST routes, and tasks accept a `goal_id`.

## Files
- `src/records.ts`: entity, fields, validation
- `src/store.ts`: defaults for goals, `goal_id` filter
- `src/app.ts`: route pattern, `goal_id` query parameter
- `test/api.test.ts`: new tests
- `docs/API.md`: document goals

## Do
1. `src/records.ts`:
   - `entities = ['todos', 'notes', 'calendars', 'goals']`.
   - Add `'goal_id'` to `fields.todos`, after `'calendar_id'`.
   - `fields.goals = ['id', 'name', 'description', 'importance', 'weekly_target', 'status', 'created_at', 'updated_at']`.
   - In `validateChange`: for todos, `goal_id` is optional text up to 128 characters. For goals:
     `name` required text up to 200; `description` optional text up to 10,000; `importance` an
     integer from 1 to 10; `weekly_target` null or an integer from 1 to 100; `status` one of
     `active`, `paused`, `done`. The final `else` branch currently means "calendars"; make it an
     explicit `else if (c.entity === 'calendars')` and add the goals branch. Errors are
     `HttpError(400, ...)` like the others in this file (`Invalid goal`).
2. `src/store.ts`:
   - `save` defaults: todos gain `goal_id: null`; goals default to
     `{ description: null, importance: 5, weekly_target: null, status: 'active' }`.
   - `list` filters: add `goal_id` for todos, matched like `calendar_id`.
3. `src/app.ts`: add `goals` to the entity alternatives in the `validRoute` regular expression
   (`(?:todos|notes|calendars|goals)`), and pass the `goal_id` query parameter through to
   `store.list` for todos. Everything else about the generic record routes already works off
   `entities`.
4. Existing records have no `goal_id` key. Check that reading, patching and syncing such a todo
   still works: `save` spreads defaults before the old record, so a patched old todo gains
   `goal_id: null`; a synced old todo without the key must still validate.
5. Tests: create, read, patch and delete a goal with a write key; invalid importance (0, 11, 2.5),
   invalid weekly_target (0) and invalid status are rejected with 400; a todo can be created with
   a `goal_id` and found with `GET /v1/todos?goal_id=...`; a sync batch containing a goal and a
   todo with `goal_id` is accepted and returned; a todo record without `goal_id` still syncs.
6. `docs/API.md`: add `/v1/goals` and `/v1/goals/{id}` to the resources table, the goal fields,
   the `goal_id` task field and filter, and the note that deleting a goal leaves its tasks alone.

## Done when
- `bun run verify` passes, with every existing test unchanged.

## Don't
- Don't cascade goal deletion to tasks.
- Don't add the pick endpoint here.
