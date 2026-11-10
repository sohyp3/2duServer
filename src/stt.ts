import type { Provider } from './config';
import { HttpError } from './security';

const extensions: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};

// Sends audio to an OpenAI-compatible transcription API. No language is sent,
// so the provider detects Arabic or English itself.
export async function transcribe(
  provider: Provider,
  audio: Uint8Array,
  mime: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const unavailable = () =>
    new HttpError(502, 'Transcription is unavailable');
  try {
    const form = new FormData();
    form.append('model', provider.model);
    form.append('response_format', 'json');
    form.append(
      'file',
      new Blob([audio as BlobPart], { type: mime }),
      `audio.${extensions[mime] ?? 'bin'}`
    );
    const response = await fetchImpl(
      `${provider.baseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      }
    );
    if (!response.ok) throw unavailable();
    const body = (await response.json()) as { text?: unknown };
    if (typeof body?.text !== 'string') throw unavailable();
    return body.text.trim();
  } catch {
    throw unavailable();
  }
}
