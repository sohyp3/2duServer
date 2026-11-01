import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config';

process.umask(0o077);
const source = resolve(loadConfig().databasePath);
const target = resolve(
  process.argv[2] ??
    `backups/2du-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`
);
if (target === source || existsSync(target))
  throw new Error('Backup destination must be a new file');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true });
try {
  // SQLite VACUUM INTO produces a consistent snapshot, including committed WAL data.
  db.query('VACUUM INTO ?').run(target);
  chmodSync(target, 0o600);
  console.log(`Backup created: ${target}`);
} finally {
  db.close();
}
