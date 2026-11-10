import { afterEach, expect, test } from 'bun:test';
import { createApp } from '../src/app';

const stt = { baseUrl: 'http://stt.test/v1', apiKey: 'k', model: 'whisper-x' };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

async function setup(options: Record<string, unknown> = { stt, ai: null }) {
  const seen: { url: string; form?: FormData; init: RequestInit }[] = [];
  let reply: Response | null = null;
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, form: init.body as FormData, init });
    return reply ?? Response.json({ text: '  مرحبا  ' });
  }) as unknown as typeof globalThis.fetch;
  const app = createApp(
    ':memory:',
    { allowRegistration: true, ...options },
    { fetch }
  );
  apps.push(app);
  const token = (
    (await (
      await app.fetch(
        new Request('http://localhost/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'voice_user',
            password: 'long-test-password',
          }),
        })
      )
    ).json()) as { token: string }
  ).token;
  return {
    app,
    token,
    seen,
    setReply: (r: Response | null) => (reply = r),
  };
}

const upload = (
  app: ReturnType<typeof createApp>,
  token: string | null,
  body: BodyInit | null,
  type = 'audio/webm'
) =>
  app.fetch(
    new Request('http://localhost/v1/transcribe', {
      method: 'POST',
      headers: {
        ...(type ? { 'Content-Type': type } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    })
  );

test('a valid upload returns the trimmed transcript from a multipart request', async () => {
  const { app, token, seen } = await setup();
  const response = await upload(app, token, new Uint8Array([1, 2, 3]));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: 'مرحبا' });
  const [request] = seen;
  expect(request!.url).toBe('http://stt.test/v1/audio/transcriptions');
  expect(request!.init.headers).toEqual({ Authorization: 'Bearer k' });
  const form = request!.form!;
  expect(form.get('model')).toBe('whisper-x');
  expect(form.get('response_format')).toBe('json');
  expect(form.has('language')).toBe(false);
  const file = form.get('file') as File;
  expect(file.name).toBe('audio.webm');
  expect(file.type).toBe('audio/webm');
  expect(file.size).toBe(3);
});

test('file extensions follow the audio type', async () => {
  const { app, token, seen } = await setup();
  for (const type of ['audio/mp4', 'audio/mpeg', 'audio/wav'])
    await upload(app, token, new Uint8Array([1]), type);
  expect(
    seen.map((s) => (s.form!.get('file') as File).name)
  ).toEqual(['audio.m4a', 'audio.mp3', 'audio.wav']);
});

test('without speech settings the route answers 503', async () => {
  const { app, token } = await setup({ stt: null, ai: null });
  const response = await upload(app, token, new Uint8Array([1]));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Transcription is not configured on this server',
  });
});

test('an unsupported content type gets 415', async () => {
  const { app, token, seen } = await setup();
  const response = await upload(app, token, new Uint8Array([1]), 'video/mp4');
  expect(response.status).toBe(415);
  expect(seen).toHaveLength(0);
});

test('a body over the limit gets 413', async () => {
  const { app, token, seen } = await setup();
  const response = await upload(
    app,
    token,
    new Uint8Array(4_500_001),
    'audio/webm'
  );
  expect(response.status).toBe(413);
  expect(seen).toHaveLength(0);
});

test('an empty body gets 400', async () => {
  const { app, token } = await setup();
  const response = await upload(app, token, null);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'No audio received' });
});

test('a provider failure gets 502', async () => {
  const { app, token, setReply } = await setup();
  setReply(new Response('boom', { status: 500 }));
  const response = await upload(app, token, new Uint8Array([1]));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: 'Transcription is unavailable',
  });
});

test('a read-only key gets 403', async () => {
  const { app, token } = await setup();
  const key = (await (
    await app.fetch(
      new Request('http://localhost/v1/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'reader', scope: 'read' }),
      })
    )
  ).json()) as { key: string };
  const response = await upload(app, key.key, new Uint8Array([1]));
  expect(response.status).toBe(403);
});
