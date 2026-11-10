export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// Fixed windows, bounded memory, no client-controlled forwarded headers.
export class RateLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(private capacity = 10_000) {}
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (entry && entry.until <= now) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        for (const [k, v] of this.entries)
          if (v.until <= now) this.entries.delete(k);
        if (this.entries.size >= this.capacity) return false;
      }
      entry = { count: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    return ++entry.count <= limit;
  }
}

export const MAX_BODY = 5_000_000;
export async function readObject(
  req: Request,
  limit = MAX_BODY
): Promise<Record<string, unknown>> {
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    throw new HttpError(415, 'Content-Type must be application/json');
  if (
    req.headers.has('content-encoding') &&
    req.headers.get('content-encoding') !== 'identity'
  )
    throw new HttpError(415, 'Compressed request bodies are not supported');
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new HttpError(413, 'Request too large');
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'Expected a JSON object');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'Request too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

export function exactFields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new HttpError(400, 'Unknown field');
}
