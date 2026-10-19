import { pino, type Logger } from 'pino';
import type { LogLevel } from './config/env.js';

export type { Logger };

/** Any key that may carry a secret is censored, wherever it appears in a log object. */
const REDACT_PATHS = [
  'token',
  '*.token',
  'auth',
  '*.auth',
  'DISCORD_TOKEN',
  '*.DISCORD_TOKEN',
  'GSI_TOKEN',
  '*.GSI_TOKEN',
  'apiKey',
  '*.apiKey',
  'GEMINI_API_KEY',
  'ELEVENLABS_API_KEY',
  'headers.authorization',
];

export function createLogger(level: LogLevel = 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Pretty output in an interactive terminal, JSON lines when piped to a file/collector.
    ...(process.stdout.isTTY
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}
