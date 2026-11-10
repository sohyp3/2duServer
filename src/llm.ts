import type { Provider } from './config';
import { HttpError } from './security';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// One OpenAI-compatible chat completion. Provider error text is never returned.
export async function chat(
  provider: Provider,
  messages: ChatMessage[],
  tools: ToolSpec[],
  fetchImpl: typeof fetch
): Promise<ChatMessage> {
  const unavailable = () =>
    new HttpError(502, 'The AI provider is unavailable');
  let response: Response;
  try {
    response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        tools,
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw unavailable();
  }
  if (!response.ok) throw unavailable();
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw unavailable();
  }
  const message = body?.choices?.[0]?.message;
  if (
    !message ||
    typeof message !== 'object' ||
    (message.content !== null && typeof message.content !== 'string') ||
    (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
  )
    throw unavailable();
  return message as ChatMessage;
}
