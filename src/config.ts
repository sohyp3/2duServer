export interface Provider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  allowRegistration: boolean;
  allowedOrigins: string[];
  ai: Provider | null;
  stt: Provider | null;
}

function baseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AI_BASE_URL must be an http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('AI_BASE_URL must be an http or https URL');
  return value.replace(/\/+$/, '');
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
  const aiParts = [env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL];
  const aiSet = aiParts.filter((v) => v !== undefined && v !== '').length;
  if (aiSet !== 0 && aiSet !== 3)
    throw new Error('Set AI_BASE_URL, AI_API_KEY and AI_MODEL together');
  const ai: Provider | null =
    aiSet === 3
      ? {
          baseUrl: baseUrl(env.AI_BASE_URL!),
          apiKey: env.AI_API_KEY!,
          model: env.AI_MODEL!,
        }
      : null;
  let stt: Provider | null = null;
  if (env.STT_MODEL) {
    const sttBase = env.STT_BASE_URL || env.AI_BASE_URL;
    const sttKey = env.STT_API_KEY || env.AI_API_KEY;
    if (!sttBase || !sttKey)
      throw new Error('STT needs a base URL and an API key');
    stt = {
      baseUrl: baseUrl(sttBase),
      apiKey: sttKey,
      model: env.STT_MODEL,
    };
  }
  return {
    host,
    port,
    databasePath,
    allowedOrigins,
    allowRegistration: env.ALLOW_REGISTRATION === 'true',
    ai,
    stt,
  };
}
