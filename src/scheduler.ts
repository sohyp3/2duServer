import type { Database } from 'bun:sqlite';
import { buildBrief, saveBrief } from './brief';
import { readPrefs } from './prefs';
import type { createStore } from './store';
import { localDate, localTime } from './tz';

interface SchedulerApp {
  db: Database;
  store: ReturnType<typeof createStore>;
}

/** Writes today's brief for every enabled user who is due. Returns briefs written. */
export function tick(app: SchedulerApp, now: Date): number {
  const users = app.db
    .query("SELECT user_id FROM prefs WHERE key='brief_enabled' AND value='true'")
    .all() as { user_id: string }[];
  let written = 0;
  let handled = 0;
  for (const { user_id: uid } of users) {
    if (handled >= 20) break;
    try {
      const prefs = readPrefs(app.db, uid);
      const date = localDate(now, prefs.tz);
      if (
        localTime(now, prefs.tz) < prefs.brief_time ||
        app.store.get(uid, 'briefs', date)
      )
        continue;
      handled++;
      const brief = buildBrief({
        store: app.store,
        uid,
        tz: prefs.tz,
        lang: prefs.brief_lang,
        now,
      });
      saveBrief(app.store, uid, brief, now);
      written++;
    } catch {
      console.error('Brief generation failed');
    }
  }
  return written;
}

export function startScheduler(app: SchedulerApp): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      tick(app, new Date());
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
