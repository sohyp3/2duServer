import { pick, scoreCandidates } from './pick';
import type { createStore } from './store';
import { localDate, localTime, localWeekday, zonedToUtc } from './tz';

type Store = ReturnType<typeof createStore>;
export interface BriefData {
  date: string;
  today: { name: string; time: string; priority: string; done: boolean }[];
  overdue: { name: string; date: string }[];
  overdueCount: number;
  goals: {
    name: string;
    importance: number;
    done: number;
    target: number | null;
  }[];
  suggestion: { name: string; reasons: string[] } | null;
  weekday: number;
}

const DAY = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY)
    .toISOString()
    .slice(0, 10);
const active = (s: unknown) => s === 'pending' || s === 'in_progress';

export function collectBrief(
  store: Store,
  uid: string,
  tz: string,
  now: Date,
  rng?: () => number
): BriefData {
  const date = localDate(now, tz);
  const start = zonedToUtc(date, '00:00', tz).getTime();
  const end = zonedToUtc(addDays(date, 1), '00:00', tz).getTime();
  const weekday = localWeekday(now, tz);
  const weekStart = zonedToUtc(
    addDays(date, -((weekday + 6) % 7)),
    '00:00',
    tz
  );
  const todos = store.list(uid, 'todos') as any[];
  const goals = store.list(uid, 'goals') as any[];
  const at = (t: any) => Date.parse(t.datetime);

  const today = todos
    .filter((t) => t.status !== 'cancelled' && at(t) >= start && at(t) < end)
    .sort((a, b) => at(a) - at(b))
    .map((t) => ({
      name: t.name,
      time: localTime(new Date(t.datetime), tz),
      priority: t.priority,
      done: t.status === 'completed',
    }));
  const late = todos
    .filter((t) => active(t.status) && at(t) < start)
    .sort((a, b) => at(a) - at(b));
  const overdue = late.slice(0, 10).map((t) => ({
    name: t.name,
    date: localDate(new Date(t.datetime), tz),
  }));
  const briefGoals = goals
    .filter((g) => g.status === 'active')
    .sort((a, b) => b.importance - a.importance)
    .map((g) => ({
      name: g.name,
      importance: g.importance,
      done: todos.filter(
        (t) =>
          t.goal_id === g.id &&
          t.status === 'completed' &&
          Date.parse(t.updated_at) >= weekStart.getTime()
      ).length,
      target: g.weekly_target ?? null,
    }));
  const choice = pick(
    scoreCandidates({ todos, goals, now, weekStart }),
    rng
  ).choice;
  return {
    date,
    weekday,
    today,
    overdue,
    overdueCount: late.length,
    goals: briefGoals,
    suggestion: choice ? { name: choice.name, reasons: choice.reasons } : null,
  };
}

const text = {
  en: {
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    greeting: 'Good morning',
    today: 'Today',
    nothing: 'Nothing scheduled.',
    overdue: 'Overdue',
    more: (n: number) => `+${n} more`,
    goals: 'Goals this week',
    start: 'Start with',
  },
  ar: {
    days: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
    greeting: 'صباح الخير',
    today: 'اليوم',
    nothing: 'لا يوجد شيء مجدول.',
    overdue: 'متأخرة',
    more: (n: number) => `+${n} أخرى`,
    goals: 'أهداف هذا الأسبوع',
    start: 'ابدأ بـ',
  },
};

export function renderBrief(data: BriefData, lang: 'en' | 'ar'): string {
  const t = text[lang];
  const out = [`${t.greeting}! ${t.days[data.weekday]}, ${data.date}`, ''];
  out.push(`## ${t.today}`);
  if (!data.today.length) out.push(t.nothing);
  for (const x of data.today)
    out.push(`- ${x.time} ${x.done ? `~~${x.name}~~` : x.name}`);
  if (data.overdue.length) {
    out.push('', `## ${t.overdue}`);
    for (const x of data.overdue) out.push(`- ${x.name} (${x.date})`);
    if (data.overdueCount > data.overdue.length)
      out.push(`- ${t.more(data.overdueCount - data.overdue.length)}`);
  }
  if (data.goals.length) {
    out.push('', `## ${t.goals}`);
    for (const g of data.goals)
      out.push(`- ${g.name}: ${g.done}${g.target != null ? `/${g.target}` : ''}`);
  }
  if (data.suggestion) {
    out.push('', `## ${t.start}`, `${data.suggestion.name}`);
    if (data.suggestion.reasons.length)
      out.push(`(${data.suggestion.reasons.join(', ')})`);
  }
  return out.join('\n');
}

export function buildBrief(input: {
  store: Store;
  uid: string;
  tz: string;
  lang: 'en' | 'ar';
  now: Date;
  rng?: () => number;
}): { date: string; content: string } {
  const data = collectBrief(
    input.store,
    input.uid,
    input.tz,
    input.now,
    input.rng
  );
  return { date: data.date, content: renderBrief(data, input.lang) };
}

export function saveBrief(
  store: Store,
  uid: string,
  brief: { date: string; content: string },
  now: Date
): void {
  const old = store.get(uid, 'briefs', brief.date) as any;
  const updated = new Date(
    Math.max(now.getTime(), old ? Date.parse(old.updated_at) + 1 : 0)
  ).toISOString();
  store.merge(uid, [
    {
      entity: 'briefs',
      id: brief.date,
      updated_at: updated,
      data: {
        id: brief.date,
        date: brief.date,
        content: brief.content,
        created_at: old?.created_at ?? updated,
        updated_at: updated,
      },
    },
  ]);
}
