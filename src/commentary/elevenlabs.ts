import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechSynthesizer } from './writer.js';

/** "George", a premade voice from the ElevenLabs docs; premade voices work on every plan. */
export const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
/** Supports Ukrainian, lowest latency, half the credits of multilingual_v2. */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId?: string;
  model?: string;
  /** ISO 639-1, e.g. "uk". Ignored by models that do not support it. Empty = auto. */
  language?: string;
  cacheDir?: string;
  fetch?: typeof fetch;
}

/**
 * ElevenLabs text-to-speech. Results are cached on disk by voice/model/text, so repeated
 * lines (e.g. templates or /say) cost credits only once.
 */
export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly name: string;
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly language: string;
  private readonly cacheDir: string;
  private readonly fetch: typeof fetch;

  constructor(options: ElevenLabsOptions) {
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId ?? DEFAULT_ELEVENLABS_VOICE;
    this.model = options.model ?? DEFAULT_ELEVENLABS_MODEL;
    this.language = options.language ?? 'uk';
    this.cacheDir = options.cacheDir ?? join(tmpdir(), 'dota-kill-announcer', 'tts');
    this.fetch = options.fetch ?? fetch;
    this.name = `elevenlabs:${this.model}`;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<string> {
    const key = createHash('sha1').update(`${this.voiceId}|${this.model}|${this.language}|${text}`).digest('hex').slice(0, 20);
    const file = join(this.cacheDir, `${key}.mp3`);
    if (existsSync(file)) return file;

    const url = `${API_BASE}/${encodeURIComponent(this.voiceId)}?output_format=mp3_44100_128`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': this.apiKey, accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: this.model,
        ...(this.language ? { language_code: this.language } : {}),
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`ElevenLabs API ${response.status}: ${detail}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new Error('ElevenLabs returned empty audio');
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(file, audio);
    return file;
  }
}
