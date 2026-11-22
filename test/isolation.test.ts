import { test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";

let app: ReturnType<typeof createApp>;
const request = async (
  path: string,
  method = "GET",
  body?: unknown,
  auth = "",
) => {
  const response = await app.fetch(
    new Request(`http://localhost/v1/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const register = async (username: string) =>
  (
    await request("auth/register", "POST", {
      username,
      password: "long-test-password",
    })
  ).body.token as string;
const login = async (username: string) =>
  (
    await request("auth/login", "POST", {
      username,
      password: "long-test-password",
    })
  ).body.token as string;

const scopes = ["read", "write", "book", "add", "feed"] as const;
type Scope = "session" | (typeof scopes)[number];

const link = {
  slug: "bob-link",
  title: "Coffee chat",
  duration_min: 30,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: "09:00",
  end: "12:00",
  tz: "UTC",
  buffer_min: 0,
  notice_min: 0,
  horizon_days: 30,
  calendar_id: "daily",
  enabled: true,
};

let alice: Record<Scope, string>;
let bob: string;
let bobKey: { key: string; id: string };
let bobIds: Record<"todos" | "notes" | "calendars" | "goals", string>;

beforeEach(async () => {
  app = createApp(":memory:", { allowRegistration: true });
  const aliceSession = await register("alice");
  bob = await register("bob");

  const now = new Date().toISOString();
  const calendar = await request(
    "sync",
    "POST",
    {
      changes: [
        {
          entity: "calendars",
          id: "bobcal",
          updated_at: now,
          data: {
            id: "bobcal",
            name: "bobsecret cal",
            color: "#123456",
            created_at: now,
            updated_at: now,
          },
        },
      ],
    },
    bob,
  );
  expect(calendar.status).toBe(200);
  const todo = await request(
    "todos",
    "POST",
    {
      name: "bobsecret task",
      calendar_id: "bobcal",
      datetime: new Date(Date.now() + 86_400_000).toISOString(),
    },
    bob,
  );
  const note = await request(
    "notes",
    "POST",
    { title: "bobsecret note", content: "private" },
    bob,
  );
  const goal = await request("goals", "POST", { name: "bobsecret goal" }, bob);
  expect([todo.status, note.status, goal.status]).toEqual([201, 201, 201]);
  bobIds = {
    todos: todo.body.id,
    notes: note.body.id,
    calendars: "bobcal",
    goals: goal.body.id,
  };
  // An overwrite gives Bob a history row.
  expect(
    (
      await request(
        `todos/${bobIds.todos}`,
        "PATCH",
        { description: "edited" },
        bob,
      )
    ).status,
  ).toBe(200);
  expect((await request("booking", "POST", link, bob)).status).toBe(201);
  const made = await request(
    "keys",
    "POST",
    { name: "bob agent", scope: "write" },
    bob,
  );
  const listed = await request("keys", "GET", undefined, bob);
  bobKey = { key: made.body.key, id: listed.body[0].id };
  expect(bobKey.id).toBe(made.body.id);

  alice = { session: aliceSession } as Record<Scope, string>;
  for (const scope of scopes) {
    const r = await request(
      "keys",
      "POST",
      { name: `alice ${scope}`, scope },
      aliceSession,
    );
    expect(r.status).toBe(201);
    alice[scope] = r.body.key;
  }
});
afterEach(() => app.db.close());

const all = (): [Scope, string][] =>
  (["session", ...scopes] as Scope[]).map((s) => [s, alice[s]]);
const noBob = (body: unknown) => {
  const text = JSON.stringify(body);
  for (const id of Object.values(bobIds)) expect(text).not.toContain(id);
  expect(text).not.toContain("bobsecret");
};

test("no session or key of Alice reaches Bob records", async () => {
  const before = Object.fromEntries(
    await Promise.all(
      Object.entries(bobIds).map(async ([entity, id]) => [
        entity,
        (await request(`${entity}/${id}`, "GET", undefined, bob)).body,
      ]),
    ),
  );
  const patch: Record<string, object> = {
    todos: { name: "hacked" },
    notes: { title: "hacked" },
    calendars: { name: "hacked" },
    goals: { name: "hacked" },
  };
  for (const [scope, auth] of all()) {
    for (const [entity, id] of Object.entries(bobIds)) {
      for (const [method, body] of [
        ["GET", undefined],
        ["PATCH", patch[entity]],
        ["DELETE", undefined],
      ] as const) {
        const r = await request(`${entity}/${id}`, method, body, auth);
        expect([scope, entity, method, [403, 404].includes(r.status)]).toEqual([
          scope,
          entity,
          method,
          true,
        ]);
      }
      for (const q of ["", "?q=bobsecret", `?q=${id}`]) {
        const r = await request(`${entity}${q}`, "GET", undefined, auth);
        noBob(r.body);
      }
    }
    noBob(
      (await request("todos?calendar_id=bobcal", "GET", undefined, auth)).body,
    );
    noBob((await request("history", "GET", undefined, auth)).body);
    noBob((await request("pick", "GET", undefined, auth)).body);
  }
  for (const [entity, id] of Object.entries(bobIds))
    expect(
      (await request(`${entity}/${id}`, "GET", undefined, bob)).body,
    ).toEqual(before[entity]);
});

test("Alice cannot see, book or change Bob booking links", async () => {
  const before = (await request("booking", "GET", undefined, bob)).body;
  const slots = (await request("agent/booking/bob-link", "GET", undefined, bob))
    .body.slots as string[];
  expect(slots.length).toBeGreaterThan(0);
  for (const [scope, auth] of all()) {
    const checks = [
      await request("agent/booking/bob-link", "GET", undefined, auth),
      await request(
        "agent/booking/bob-link",
        "POST",
        { start: slots[0], name: "Mallory", contact: "m@example.com" },
        auth,
      ),
      await request("booking/bob-link", "PATCH", { title: "hacked" }, auth),
      await request("booking/bob-link", "DELETE", undefined, auth),
    ];
    for (const r of checks)
      expect([scope, [403, 404].includes(r.status)]).toEqual([scope, true]);
    noBob((await request("agent/booking", "GET", undefined, auth)).body);
    const list = await request("booking", "GET", undefined, auth);
    expect(JSON.stringify(list.body)).not.toContain("bob-link");
  }
  expect((await request("booking", "GET", undefined, bob)).body).toEqual(
    before,
  );
  // No booking task landed in Bob's account.
  const todos = (await request("todos", "GET", undefined, bob)).body;
  expect(todos).toHaveLength(1);
});

test("Alice cannot revoke Bob keys or overwrite Bob records through sync", async () => {
  for (const [, auth] of all())
    await request(`keys/${bobKey.id}`, "DELETE", undefined, auth);
  expect((await request("todos", "GET", undefined, bobKey.key)).status).toBe(
    200,
  );
  expect(
    (await request("keys", "GET", undefined, bob)).body.map((k: any) => k.id),
  ).toContain(bobKey.id);

  const before = (await request(`todos/${bobIds.todos}`, "GET", undefined, bob))
    .body;
  const now = new Date(Date.now() + 1000).toISOString();
  const synced = await request(
    "sync",
    "POST",
    {
      changes: [
        {
          entity: "todos",
          id: bobIds.todos,
          updated_at: now,
          data: {
            ...before,
            name: "hacked",
            updated_at: now,
          },
        },
        {
          entity: "calendars",
          id: "bobcal",
          updated_at: now,
          data: null,
        },
      ],
    },
    alice.session,
  );
  expect(synced.status).toBe(200);
  expect(
    (await request(`todos/${bobIds.todos}`, "GET", undefined, bob)).body,
  ).toEqual(before);
  expect(
    (await request("calendars/bobcal", "GET", undefined, bob)).body.name,
  ).toBe("bobsecret cal");
  const bobSync = await request("sync", "POST", { changes: [] }, bob);
  expect(JSON.stringify(bobSync.body)).not.toContain("hacked");
});

// Expected access per route, following the key scope table in docs/API.md.
type Cell = [method: string, path: string, body: unknown, allowed: Scope[]];
const R: Scope[] = ["session", "read", "write"];
const W: Scope[] = ["session", "write"];
const S: Scope[] = ["session"];
const crud = (entity: string, create: object): Cell[] => [
  ["GET", entity, undefined, entity === "goals" ? [...R, "add"] : R],
  ["POST", entity, create, entity === "goals" ? W : [...W, "add"]],
  ["PATCH", `${entity}/unknown-id`, create, W],
  ["DELETE", `${entity}/unknown-id`, undefined, W],
];
const matrix: Cell[] = [
  ...crud("todos", { name: "matrix task" }),
  ...crud("notes", { title: "matrix note" }),
  ...crud("goals", { name: "matrix goal" }),
  ["GET", "calendars", undefined, [...R, "add"]],
  ["POST", "sync", { changes: [] }, S],
  ["GET", "history", undefined, S],
  // NOTE: docs/API.md's pick section says "any scope", but the key scope table
  // (and the server) give it to read and write keys only, not add keys.
  ["GET", "pick", undefined, R],
  ["GET", "prefs", undefined, S],
  ["PATCH", "prefs", { brief_lang: "en" }, S],
  ["GET", "keys", undefined, S],
  ["POST", "keys", { name: "matrix", scope: "read" }, S],
  ["GET", "booking", undefined, S],
  ["GET", "agent/booking", undefined, ["session", "book"]],
  ["POST", "brief", {}, W],
  ["DELETE", "session", undefined, S],
];

test("scope matrix: every scope gets exactly its routes", async () => {
  // DELETE /v1/session runs last; the session column uses a throwaway session
  // for it so the other cells keep a working sign-in.
  const throwaway = await login("alice");
  const tried = new Set<Scope>();
  for (const [method, path, body, allowed] of matrix)
    for (const [scope, key] of all()) {
      const auth = scope === "session" && path === "session" ? throwaway : key;
      const r = await request(path, method, body, auth);
      const ok = allowed.includes(scope)
        ? (r.status >= 200 && r.status < 300) || r.status === 404
        : r.status === 403;
      expect([method, path, scope, r.status, ok]).toEqual([
        method,
        path,
        scope,
        r.status,
        true,
      ]);
      tried.add(scope);
    }
  expect(tried.size).toBe(6);
  // The throwaway session is gone; the main one still works.
  expect((await request("todos", "GET", undefined, throwaway)).status).toBe(
    401,
  );
  expect((await request("todos", "GET", undefined, alice.session)).status).toBe(
    200,
  );
});
