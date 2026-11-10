export interface PickTodo {
  id: string;
  name: string;
  datetime: string;
  status: string;
  priority: string;
  time_needed: number | null;
  goal_id: string | null;
  updated_at: string;
}
export interface PickGoal {
  id: string;
  name: string;
  importance: number;
  weekly_target: number | null;
  status: string;
}
export interface Candidate {
  kind: 'todo' | 'goal';
  id: string;
  name: string;
  goal_id: string | null;
  weight: number;
  reasons: string[];
}

const DAY = 86_400_000;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
const isActive = (t: PickTodo) =>
  t.status === 'pending' || t.status === 'in_progress';

export function scoreCandidates(input: {
  todos: PickTodo[];
  goals: PickGoal[];
  now: Date;
  weekStart: Date;
  minutes?: number | null;
}): Candidate[] {
  const { todos, goals, now, weekStart } = input;
  const minutes = typeof input.minutes === 'number' ? input.minutes : null;
  const nowMs = now.getTime();
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const elapsed = clamp((nowMs - weekStart.getTime()) / (7 * DAY), 0, 1);

  interface Stats {
    goal: PickGoal;
    done: number;
    idleDays: number;
    neglect: number;
    quota: number;
  }
  const stats = new Map<string, Stats>();
  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    const mine = todos.filter((t) => t.goal_id === goal.id);
    const done = mine.filter(
      (t) =>
        t.status === 'completed' && Date.parse(t.updated_at) >= weekStart.getTime()
    ).length;
    const touched = mine
      .filter((t) => t.status === 'completed' || t.status === 'in_progress')
      .map((t) => Date.parse(t.updated_at));
    const idleDays = touched.length
      ? clamp((nowMs - Math.max(...touched)) / DAY, 0, 14)
      : 14;
    const neglect = 1 + idleDays / 14;
    let quota = 1;
    if (goal.weekly_target != null) {
      const remaining = goal.weekly_target - done;
      quota =
        remaining <= 0
          ? 0.25
          : 1 + (remaining / goal.weekly_target) * elapsed * 2;
    }
    stats.set(goal.id, { goal, done, idleDays, neglect, quota });
  }

  const goalReasons = (s: Stats): string[] => {
    const r = [`importance ${s.goal.importance}`];
    return r;
  };
  const tail = (s: Stats): string[] => {
    const r: string[] = [];
    if (s.goal.weekly_target != null)
      r.push(`weekly target ${s.done} of ${s.goal.weekly_target} done`);
    if (s.idleDays >= 3)
      r.push(`untouched for ${Math.floor(s.idleDays)} days`);
    return r;
  };

  const out: Candidate[] = [];
  const goalsWithActive = new Set<string>();
  for (const t of todos) {
    if (!isActive(t)) continue;
    const g = t.goal_id ? goalById.get(t.goal_id) : undefined;
    if (g && g.status !== 'active') continue;
    const s = g ? stats.get(g.id)! : undefined;
    if (s) goalsWithActive.add(g!.id);
    if (
      minutes !== null &&
      typeof t.time_needed === 'number' &&
      t.time_needed > minutes
    )
      continue;
    const d = (Date.parse(t.datetime) - nowMs) / DAY;
    if (d > 7) continue;
    const base = s
      ? s.goal.importance
      : t.priority === 'urgent' || t.priority === 'high'
        ? 8
        : t.priority === 'low'
          ? 2
          : 5;
    const urgency = d <= 0 ? 3 : d <= 1 ? 2.5 : d <= 3 ? 1.8 : 1.3;
    const progress = t.status === 'in_progress' ? 1.2 : 1;
    const goalFactor = s ? s.quota * s.neglect : 1;
    const reasons: string[] = [];
    if (s) reasons.push(...goalReasons(s));
    if (d <= 0) reasons.push('overdue');
    else if (d <= 1) reasons.push('due within a day');
    if (t.status === 'in_progress') reasons.push('in progress');
    if (s) reasons.push(...tail(s));
    if (minutes !== null && typeof t.time_needed === 'number')
      reasons.push(`fits ${t.time_needed} min`);
    out.push({
      kind: 'todo',
      id: t.id,
      name: t.name,
      goal_id: s ? s.goal.id : (t.goal_id ?? null),
      weight: base * urgency * progress * goalFactor,
      reasons,
    });
  }

  // A goal with any active todo is represented by those todos, even when
  // they were filtered out by minutes or the horizon.
  const hasActive = new Set(
    todos.filter((t) => isActive(t) && t.goal_id).map((t) => t.goal_id!)
  );
  for (const s of stats.values()) {
    if (hasActive.has(s.goal.id)) continue;
    out.push({
      kind: 'goal',
      id: s.goal.id,
      name: s.goal.name,
      goal_id: s.goal.id,
      weight: s.goal.importance * s.quota * s.neglect,
      reasons: [...goalReasons(s), ...tail(s)],
    });
  }

  return out.sort(
    (a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function pick(
  candidates: Candidate[],
  rng: () => number = Math.random
): { choice: Candidate | null; alternatives: Candidate[] } {
  if (!candidates.length) return { choice: null, alternatives: [] };
  const total = candidates.reduce((n, c) => n + c.weight, 0);
  let r = rng() * total;
  let choice = candidates[candidates.length - 1];
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) {
      choice = c;
      break;
    }
  }
  return {
    choice,
    alternatives: candidates.filter((c) => c !== choice).slice(0, 3),
  };
}
