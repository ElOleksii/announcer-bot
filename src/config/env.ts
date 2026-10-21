import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ANNOUNCER_MODES, type AnnouncerMode } from '../announcer.js';
import { DEFAULT_ELEVENLABS_MODEL, DEFAULT_ELEVENLABS_VOICE } from '../commentary/elevenlabs.js';
import { steamIdToAccountId } from '../analysis/opendota.js';
import { ANALYSIS_TONES, type AnalysisTone } from '../analysis/report.js';
import { DEFAULT_GEMINI_FALLBACK_MODELS, DEFAULT_GEMINI_MODEL } from '../commentary/gemini.js';

const port = z.coerce.number().int().min(1).max(65_535);

const gsiEnvSchema = z.object({
  GSI_PORT: port.default(3000),
  // Restricted charset: the token is written verbatim into a quoted KeyValues .cfg file.
  GSI_TOKEN: z
    .string({ error: 'GSI_TOKEN is required' })
    .min(16, 'GSI_TOKEN must be at least 16 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'GSI_TOKEN may only contain letters, digits, "_" and "-"'),
});

const envSchema = gsiEnvSchema
  .extend({
    PLAYBACK_MODE: z.enum(['discord', 'local']).default('discord'),
    DISCORD_TOKEN: z.string().min(1).optional(),
    DISCORD_CLIENT_ID: z.string().regex(/^\d+$/, 'must be a numeric snowflake').optional(),
    GUILD_ID: z.string().regex(/^\d+$/, 'must be a numeric snowflake').optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    MULTIKILL_WINDOW_MS: z.coerce.number().int().positive().default(18_000),
    ANNOUNCE_DEATHS: z.stringbool().default(false),
    SOUNDS_CONFIG: z.string().min(1).default('sounds.config.json'),
    GSI_DUMP_FILE: z.string().min(1).optional(),
    ANNOUNCER_MODE: z.enum(ANNOUNCER_MODES).default('sounds'),
    COMMENTARY_TEXT: z.enum(['templates', 'gemini']).default('templates'),
    COMMENTARY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(6000),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default(DEFAULT_GEMINI_MODEL),
    // Comma-separated; "none" disables fallbacks.
    GEMINI_FALLBACK_MODELS: z
      .string()
      .default(DEFAULT_GEMINI_FALLBACK_MODELS.join(','))
      .transform((list) => (list.trim() === 'none' ? [] : list.split(',').map((m) => m.trim()).filter(Boolean))),
    ELEVENLABS_API_KEY: z.string().min(1).optional(),
    ELEVENLABS_VOICE_ID: z.string().min(1).default(DEFAULT_ELEVENLABS_VOICE),
    ELEVENLABS_MODEL: z.string().min(1).default(DEFAULT_ELEVENLABS_MODEL),
    ELEVENLABS_LANGUAGE: z.string().regex(/^[a-z]{2}$/, 'must be a 2-letter ISO 639-1 code, e.g. uk').default('uk'),
    AUTO_ANALYZE: z.stringbool().default(true),
    ANALYSIS_TONE: z.enum(ANALYSIS_TONES).default('harsh'),
    ANALYSIS_CHANNEL_ID: z.string().regex(/^\d+$/, 'must be a numeric channel id').optional(),
    PLAYER_STEAM_ID: z.string().regex(/^7656\d{13}$/, 'must be a 17-digit SteamID64, e.g. 76561198000000000').optional(),
    OPENDOTA_API_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.PLAYBACK_MODE === 'discord') {
      for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'GUILD_ID'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when PLAYBACK_MODE=discord` });
      }
    }
    if (env.COMMENTARY_TEXT === 'gemini' && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_API_KEY is required when COMMENTARY_TEXT=gemini' });
    }
    if (env.ANNOUNCER_MODE !== 'sounds' && !env.ELEVENLABS_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ELEVENLABS_API_KEY'], message: 'ELEVENLABS_API_KEY is required when ANNOUNCER_MODE is not sounds' });
    }
  });

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildId: string;
}

export interface GsiConfig {
  port: number;
  token: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Tried in order when the primary model is overloaded or unavailable. */
  fallbackModels: string[];
}

export interface CommentaryConfig {
  mode: AnnouncerMode;
  timeoutMs: number;
  text: { provider: 'templates' } | ({ provider: 'gemini' } & GeminiConfig);
  /** null when ELEVENLABS_API_KEY is not set: only the sounds mode is available. */
  tts: { apiKey: string; voiceId: string; model: string; language: string } | null;
}

export interface AnalysisConfig {
  /** Analyse automatically after every lost match (toggle at runtime with /autoanalyze). */
  auto: boolean;
  tone: AnalysisTone;
  /** Text channel for automatic analyses; null → the bot's voice channel chat, else the server's system channel. */
  channelId: string | null;
  /** Used for the spoken verdict whenever GEMINI_API_KEY is set; otherwise built-in text. */
  gemini: GeminiConfig | null;
  /** OpenDota account id from PLAYER_STEAM_ID; GSI provides it too, but only while a game runs. */
  playerAccountId: number | null;
  /** Paid OpenDota key; null → the free tier (~60 requests/min, 3000/day). */
  openDotaApiKey: string | null;
}

export interface AppConfig {
  mode: 'discord' | 'local';
  logLevel: LogLevel;
  gsi: GsiConfig;
  /** null in local mode: the Discord module is not initialised at all. */
  discord: DiscordConfig | null;
  multikillWindowMs: number;
  announceDeaths: boolean;
  soundsConfigPath: string;
  /** NDJSON file for recording raw GSI payloads, or null when disabled. */
  gsiDumpFile: string | null;
  commentary: CommentaryConfig;
  analysis: AnalysisConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Loads `.env` from the working directory into process.env (existing variables win). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  // Treat empty strings as unset so `KEY=` in .env falls back to defaults / "missing".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadGsiConfig(source: NodeJS.ProcessEnv = process.env): GsiConfig {
  const env = parse(gsiEnvSchema, source);
  return { port: env.GSI_PORT, token: env.GSI_TOKEN };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = parse(envSchema, source);
  const discord =
    env.PLAYBACK_MODE === 'discord' && env.DISCORD_TOKEN && env.DISCORD_CLIENT_ID && env.GUILD_ID
      ? { token: env.DISCORD_TOKEN, clientId: env.DISCORD_CLIENT_ID, guildId: env.GUILD_ID }
      : null;
  return {
    mode: env.PLAYBACK_MODE,
    logLevel: env.LOG_LEVEL,
    gsi: { port: env.GSI_PORT, token: env.GSI_TOKEN },
    discord,
    multikillWindowMs: env.MULTIKILL_WINDOW_MS,
    announceDeaths: env.ANNOUNCE_DEATHS,
    soundsConfigPath: env.SOUNDS_CONFIG,
    gsiDumpFile: env.GSI_DUMP_FILE ?? null,
    commentary: {
      mode: env.ANNOUNCER_MODE,
      timeoutMs: env.COMMENTARY_TIMEOUT_MS,
      text:
        env.COMMENTARY_TEXT === 'gemini' && env.GEMINI_API_KEY
          ? { provider: 'gemini', apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fallbackModels: env.GEMINI_FALLBACK_MODELS }
          : { provider: 'templates' },
      tts: env.ELEVENLABS_API_KEY
        ? {
            apiKey: env.ELEVENLABS_API_KEY,
            voiceId: env.ELEVENLABS_VOICE_ID,
            model: env.ELEVENLABS_MODEL,
            language: env.ELEVENLABS_LANGUAGE,
          }
        : null,
    },
    analysis: {
      auto: env.AUTO_ANALYZE,
      tone: env.ANALYSIS_TONE,
      channelId: env.ANALYSIS_CHANNEL_ID ?? null,
      gemini: env.GEMINI_API_KEY
        ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fallbackModels: env.GEMINI_FALLBACK_MODELS }
        : null,
      playerAccountId: env.PLAYER_STEAM_ID ? steamIdToAccountId(env.PLAYER_STEAM_ID) : null,
      openDotaApiKey: env.OPENDOTA_API_KEY ?? null,
    },
  };
}
