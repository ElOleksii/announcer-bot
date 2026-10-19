import { setTimeout as sleep } from 'node:timers/promises';
import type { KillContext } from './context.js';
import { SYSTEM_PROMPT, cleanLine, describeForPrompt } from './prompt.js';
import type { CommentaryWriter } from './writer.js';

/** Measured fastest on the free tier: ~1.3–2.4 s per line vs 4–10 s for gemini-3.5-flash-lite. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
/** Tried in order when the primary model is overloaded (503/429) or unavailable (404). */
export const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash-lite'];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** "High demand" / rate limit / model gone / server error: worth trying another model or later. */
const RETRYABLE = new Set([404, 429, 500, 503]);

export interface GeminiWriterOptions {
  apiKey: string;
  model?: string;
  fallbackModels?: readonly string[];
  fetch?: typeof fetch;
  /** Wait between retry rounds; injected in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
}

/** Writes commentary with the Gemini generateContent REST API. */
export class GeminiWriter implements CommentaryWriter {
  readonly name: string;
  /** Model that produced the last successful answer (for logs). */
  lastModel: string | null = null;
  private readonly apiKey: string;
  private readonly models: string[];
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;

  constructor({ apiKey, model = DEFAULT_GEMINI_MODEL, fallbackModels = [], fetch: fetchImpl = fetch, sleep: sleepImpl }: GeminiWriterOptions) {
    this.sleep = sleepImpl ?? ((ms, signal) => sleep(ms, undefined, signal ? { signal } : {}));
    this.apiKey = apiKey;
    this.models = [...new Set([model, ...fallbackModels])];
    this.fetch = fetchImpl;
    this.name = `gemini:${model}`;
  }

  async write(ctx: KillContext, signal?: AbortSignal): Promise<string> {
    return this.generate(describeForPrompt(ctx), signal);
  }

  async generate(userText: string, signal?: AbortSignal): Promise<string> {
    return this.complete({ system: SYSTEM_PROMPT, user: userText }, signal);
  }

  /**
   * One-shot completion with any system prompt; the answer is normalised to one line.
   * Each round tries the models in order, moving on when one is overloaded or unavailable;
   * `retries` adds rounds with a growing pause, since Gemini's 503s are usually short-lived.
   */
  async complete(
    { system, user, maxLength = 220, retries = 0 }: { system: string; user: string; maxLength?: number; retries?: number },
    signal?: AbortSignal,
  ): Promise<string> {
    let lastError: Error | null = null;
    for (let round = 0; round <= retries; round++) {
      if (round > 0) await this.sleep(2000 * round, signal);
      for (const model of this.models) {
        const response = await this.request(model, system, user, signal);
        if (response.ok) {
          const line = cleanLine(await extractText(response), maxLength);
          if (!line) throw new Error('Gemini returned an empty response');
          this.lastModel = model;
          return line;
        }
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        lastError = new Error(`Gemini API ${response.status} (${model}): ${detail}`);
        if (!RETRYABLE.has(response.status)) throw lastError;
      }
    }
    throw lastError ?? new Error('Gemini: no models configured');
  }

  private request(model: string, system: string, user: string, signal?: AbortSignal): Promise<Response> {
    return this.fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // Generous cap: thinking tokens may count towards it; the line itself is trimmed afterwards.
        generationConfig: { maxOutputTokens: 1024 },
      }),
      ...(signal ? { signal } : {}),
    });
  }
}

async function extractText(response: Response): Promise<string> {
  const data = (await response.json()) as GenerateContentResponse;
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text as string)
    .join('');
}
