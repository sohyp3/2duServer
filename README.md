# 2duServer

Standalone TypeScript/Bun backend for the sibling **2du** Expo app. Account-scoped sync, tasks, notes, calendars, conflict recovery, and revocable agent API keys. No runtime npm dependencies. Requires Bun **1.3.14+** and persistent local disk.

```sh
cd ../2duServer
bun install --frozen-lockfile
cp .env.example .env
bun start
```

Health: `http://127.0.0.1:3000/health`. Registration is disabled initially. For initial account creation:

```sh
ALLOW_REGISTRATION=true bun start
```

In **2du → Settings → Sync**, use `http://localhost:3000` on the same computer, enter a username and password of at least 10 characters, and choose **Create an account**. Stop the server afterward and restart with `ALLOW_REGISTRATION=false`. Other devices sign in to that account. No frontend code changes are needed. A phone's localhost refers to the phone; use your HTTPS domain for devices.

The folder is an independent Git repository. It does not import files or dependencies from the app. The original app repository is untouched.

## Run and verify

```sh
bun start                 # persistent server, loopback by default
bun run dev               # restart on source changes
bun run verify            # TypeScript + API/security/persistence tests
bun run backup            # consistent SQLite backup in backups/
```

Configuration is loaded from `.env` by Bun; real environment variables take precedence. See [.env.example](.env.example). `HOST` defaults to `127.0.0.1`, `PORT` to `3000`, and `DATABASE_PATH` to `data/2du.sqlite`. `ALLOWED_ORIGINS` contains exact comma-separated browser origins, with no paths or wildcard. Set an empty value to permit only clients without an Origin header. Native requests omit Origin. CORS is a browser restriction; bearer authentication is required independently.

## Deployment

Production runs at **https://2du.hyp3.cafe/api** (health: `https://2du.hyp3.cafe/api/health`; API: `https://2du.hyp3.cafe/api/v1/...`). Use that URL in the app's Sync settings. Docker Compose runs the API on `127.0.0.1:3000`, and the host's Nginx proxies `/api/` to it with the prefix stripped. [deploy/nginx.conf](deploy/nginx.conf) adds request size limits and per-client request/connection limits. Keep port 3000 private.

The config is HTTP only on purpose; `certbot --nginx` adds the HTTPS block, certificate and redirect, then renews them in place. On the VPS (code checked out at `/root/apps/2duServer`):

```sh
cp deploy/nginx.conf /etc/nginx/sites-available/2du.hyp3.cafe
ln -s /etc/nginx/sites-available/2du.hyp3.cafe /etc/nginx/sites-enabled/2du.hyp3.cafe
nginx -t && systemctl reload nginx
# After the domain's DNS points at the VPS:
certbot --nginx -d 2du.hyp3.cafe
```

To update: `git pull && docker compose up -d --build`. Do not re-copy the Nginx file after certbot has edited it; that would remove the HTTPS block.

Application throttles use the actual socket IP and deliberately ignore forwarded headers. Behind Nginx, clients still share the application's proxy-IP limits; the Nginx limits add per-client protection. These assume clients connect directly to Nginx. Set up trusted real-IP handling separately if a CDN or another proxy sits in front.

Run with Docker:

```sh
cp .env.example .env
# Edit ALLOWED_ORIGINS to your actual web app origins.
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

The image runs as an unprivileged user; Compose uses a read-only filesystem, persistent volumes, dropped capabilities, resource limits, and a loopback-only published port. To register the first account, temporarily set `ALLOW_REGISTRATION=true` in `.env`, run `docker compose up -d --force-recreate`, create the account, then set false and recreate again. `docker compose down` preserves volumes; `down -v` deletes them.

For a Linux service, [deploy/2du-server.service](deploy/2du-server.service) is a hardened systemd template. Install the code at `/opt/2duServer`, install Bun at `/usr/local/bin/bun`, create the `twodu` service user, and create `/etc/2du-server.env` from `.env.example` with mode `0600`. In that file use `DATABASE_PATH=/var/lib/2du-server/2du.sqlite`. The service creates its private state directory. Use either systemd or Docker for the API, with your existing Nginx on the host.

After preparing those paths and the service user:

```sh
sudo cp deploy/2du-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 2du-server
curl http://127.0.0.1:3000/health
```

Temporarily set `ALLOW_REGISTRATION=true` in `/etc/2du-server.env` and restart the service to create your account through the app using `https://YOUR_DOMAIN`. Then set it back to `false` and restart again. For Docker, use the `.env` registration steps above. Check the public endpoint with `curl https://YOUR_DOMAIN/health`, then use that HTTPS address in the app's Sync settings.

## Data and API

[API reference](docs/API.md) describes the app-compatible `/v1` endpoints. Sessions expire after 30 days. Agents use read-only or read/write keys created in the app; only sessions can sync or manage keys. Logout revokes that session. Agent keys last until revoked.

Sync merges complete records by UTC `updated_at`. Equal-time conflicts use sorted field serialization; deletion wins an equal-time tie. Newer writes can restore deleted records. CRUD timestamps advance past the previous stored version. Tombstones remain indefinitely. Repeated losing versions are deduplicated; the newest 2,000 conflict versions per account are retained and the history endpoint returns the newest 200. Restore a version through a normal PATCH with its editable fields. This is record-level merging, so concurrent edits can replace each other's fields. Keep device clocks correct.

Sync accepts at most 10,000 changes and 5,000,000 request bytes. Each round returns a full snapshot, suitable for a personal workspace. Per-account limits: 20,000 record IDs including tombstones, 25 MB of current serialized record data, 50 agent keys, 100 active device sessions. History is separately bounded. Larger archives need pagination and incremental sync. Authentication accepts 8 KB; CRUD accepts 500 KB. Non-JSON/compressed bodies, unknown fields, invalid dates, malformed IDs and writes over five minutes in the future are rejected.

## Backups and restore

`bun run backup [new-backup-path]` uses SQLite `VACUUM INTO` for a consistent snapshot while the server runs, including committed WAL data. The destination must not already exist. Backups have mode `0600`.

```sh
docker compose exec server bun run scripts/backup.ts /app/backups/manual.sqlite
# Copy off the host as part of your regular encrypted backup plan:
docker compose cp server:/app/backups/manual.sqlite ./manual.sqlite
```

To restore: stop the API; retain the existing database and WAL/SHM files as a rollback copy; replace the database with the backup; remove the old `-wal` and `-shm` files from the active database directory; set owner to the service user and mode `0600`; restart. Restore the whole DB, which includes accounts, hashed credentials, records, history, and token hashes. For Docker, perform replacement through a temporary container with the data volume mounted while the API is stopped. Test restoration before relying on backups.

## Security scope

Passwords use Argon2id (64 MiB, three passes); random 256-bit bearer tokens are stored only as SHA-256 hashes. SQL uses bound parameters. Requests enforce account ownership and key permissions. Authentication has per-user/per-socket throttles and at most four concurrent password operations. General request throttles, bounded limiter maps, streaming byte limits, storage quotas, generic internal errors, restrictive database permissions and response headers reduce common abuse paths.

This service is for self-hosted personal use. Data is readable by the server; use encrypted disks/backups for protection at rest. TLS is provided by your proxy. Rate limits are per process and reset on restart. The service does not include account recovery, email verification, password changes, or a distributed abuse-control service. Keep registration closed, dependencies/runtime patched, and the database private.

Implementation references: [Bun password hashing](https://bun.sh/guides/util/hash-a-password) and [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
