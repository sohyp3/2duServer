# Goals and "Pick for me" (server)

## Goal
The server stores and syncs goals, accepts a goal on tasks, and can answer "what should I do
now?" for API clients and external agents.

## Context
- This repo is the 2du sync API: Bun (>= 1.3.14), `bun:sqlite`, TypeScript, zero runtime
  dependencies.
- `src/records.ts` lists the synced entities and their fields and validates every record. A
  record with a field that is not listed is rejected, so the app cannot sync goals or `goal_id`
  until step 01 here is **deployed**. Deploy this plan's step 01 before releasing the app build
  from `../2du/plans/goals-picker`.
- `src/store.ts` (`createStore(db)`) holds `list`, `get`, `save`, `remove` and `merge` for
  records. `src/app.ts` dispatches routes by hand and has a `validRoute` regular expression that
  must list every path.
- A goal: `name`, optional `description`, `importance` (integer 1 to 10), `weekly_target` (null
  or an integer 1 to 100, counted in completed tasks per week), `status` (`active`, `paused`,
  `done`). A task gets an optional `goal_id`.
- Deleting a goal does not touch its tasks. A task whose `goal_id` matches no goal is treated as
  having no goal.
- The pick is a weighted random draw on purpose: a strict ranking would never surface
  low-importance goals.
- This plan assumes `plans/fixes-polish` is merged and `src/store.ts` exists (from `plans/agent` step 02).

## Conventions
- No new dependencies.
- Errors are JSON `{ "error": "message" }` via `HttpError(status, message)`.
- Tests use `bun:test`, `createApp(':memory:', { allowRegistration: true })` and the `request`
  helper pattern at the top of `test/api.test.ts`.
- Prettier style: 80 columns, single quotes, trailing commas `es5`.
- `src/records.ts` is mirrored by `../2du/shared/records.ts`; field lists must stay identical.
- Steps never deploy.

## Checks
`bun run verify`

## Steps
1. `01-goals-entity.md`: `goals` records, `goal_id` on tasks, REST routes.
2. `02-pick-endpoint.md`: scoring and `GET /v1/pick`.
