# Verification

Verified on 2026-11-01 with Bun 1.3.14:

- `bun run verify`: TypeScript passes; 22 tests pass, 451 assertions.
- `bun audit`: no reported dependency vulnerabilities.
- `docker compose config --quiet`: valid configuration.
- Docker image builds successfully and starts with a read-only root filesystem, nonroot UID 1000, all Linux capabilities dropped, and a 512 MiB memory limit.
- Container HTTP smoke: `/health` returns 200, security headers are set, registration defaults to 403.
- Integration test creates data through real HTTP, reopens the persistent database, makes an online backup while the server is running, checks backup integrity and permissions, and restores from it.

The security tests exercise account/key/history isolation, scope enforcement, token hashing/expiration/revocation, Argon2id storage, CORS, malformed JSON, streaming byte limits, schema validation, route suffix attacks, throttling and spoofed forwarding headers, registration races, transactional quota rollback, bounded conflict history, tombstones, and sync convergence.

HTTPS/domain issuance and systemd installation require your deployment host and domain; templates are provided. No external hosting or remote Git repository was created. The Docker smoke container and its temporary volumes were removed after verification.

An automated dependency audit and regression suite are useful checks, not a penetration-test certification. See the README for the supported personal-hosting scope and limits.
