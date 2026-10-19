import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from '../logger.js';
import type { GsiPayload } from './schema.js';

export interface PayloadDumpOptions {
  file: string;
  logger: Logger;
  /** Stop writing once the file reaches this size. */
  maxBytes?: number;
  /** Also write a snapshot at least this often, even when nothing interesting changed. */
  snapshotEveryMs?: number;
}

/**
 * Appends interesting GSI payloads to an NDJSON file, for discovering which fields Dota sends.
 * Dota posts ~10 times per second, so only payloads where kills/deaths changed (plus a periodic
 * snapshot) are written. The auth token is never written.
 */
export class PayloadDump {
  private readonly stream: WriteStream;
  private readonly maxBytes: number;
  private readonly snapshotEveryMs: number;
  private readonly log: Logger;
  private bytes: number;
  private lastKey: string | null = null;
  private lastWriteAt = 0;
  private full = false;

  constructor({ file, logger, maxBytes = 20 * 1024 * 1024, snapshotEveryMs = 30_000 }: PayloadDumpOptions) {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    this.bytes = existingSize(path);
    this.stream = createWriteStream(path, { flags: 'a' });
    this.maxBytes = maxBytes;
    this.snapshotEveryMs = snapshotEveryMs;
    this.log = logger.child({ module: 'gsi-dump' });
    this.log.info({ file: path }, 'recording GSI payloads');
  }

  record(payload: GsiPayload, at: number): void {
    if (this.full) return;

    const key = `${payload.map?.matchid}|${payload.player?.kills}|${payload.player?.deaths}`;
    const changed = key !== this.lastKey;
    if (!changed && at - this.lastWriteAt < this.snapshotEveryMs) return;
    this.lastKey = key;
    this.lastWriteAt = at;

    const { auth: _auth, ...rest } = payload;
    const line = `${JSON.stringify({ receivedAt: new Date(at).toISOString(), reason: changed ? 'change' : 'snapshot', payload: rest })}\n`;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.maxBytes) {
      this.full = true;
      this.log.warn({ maxBytes: this.maxBytes }, 'payload dump reached its size limit; recording stopped');
      return;
    }
    this.stream.write(line);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function existingSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
