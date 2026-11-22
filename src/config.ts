export interface Config {
  host: string;
  port: number;
  databasePath: string;
  allowRegistration: boolean;
  allowedOrigins: string[];
  trustProxy: boolean;
  maxUsers: number | null;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PORT');
  if (
    env.ALLOW_REGISTRATION &&
    !['true', 'false'].includes(env.ALLOW_REGISTRATION)
  )
    throw new Error('ALLOW_REGISTRATION must be true or false');
  if (env.TRUST_PROXY && !['true', 'false'].includes(env.TRUST_PROXY))
    throw new Error('TRUST_PROXY must be true or false');
  let maxUsers: number | null = null;
  if (env.MAX_USERS) {
    maxUsers = Number(env.MAX_USERS);
    if (
      !/^\d+$/.test(env.MAX_USERS) ||
      !Number.isSafeInteger(maxUsers) ||
      maxUsers < 1
    )
      throw new Error('MAX_USERS must be a positive integer');
  }
  const allowedOrigins = (
    env.ALLOWED_ORIGINS ??
    'http://localhost:8081,http://127.0.0.1:8081,http://localhost:8080,http://127.0.0.1:8080'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  }
  const host = env.HOST ?? '127.0.0.1';
  const databasePath = env.DATABASE_PATH ?? 'data/2du.sqlite';
  if (!host || !databasePath)
    throw new Error('HOST and DATABASE_PATH cannot be empty');
  return {
    host,
    port,
    databasePath,
    allowedOrigins,
    allowRegistration: env.ALLOW_REGISTRATION === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    maxUsers,
  };
}
