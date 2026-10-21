import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry {
  savedAt: number;
  value: unknown;
}

/**
 * JSON values with an age limit, kept in memory and (when `dir` is set) on disk, so reference data
 * such as hero stats survives a restart instead of costing OpenDota requests again.
 */
export class JsonCache {
  private readonly memory = new Map<string, Entry>();

  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The cached value if younger than `maxAgeMs`, else a fresh one from `load`. When `load` fails,
   * an expired copy is better than nothing and is returned instead; with no copy the error is thrown.
   */
  async get<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.memory.get(key) ?? (await this.readDisk(key));
    if (cached && this.now() - cached.savedAt < maxAgeMs) {
      this.memory.set(key, cached);
      return cached.value as T;
    }
    let value: T;
    try {
      value = await load();
    } catch (err) {
      if (cached) return cached.value as T;
      throw err;
    }
    const entry = { savedAt: this.now(), value };
    this.memory.set(key, entry);
    await this.writeDisk(key, entry);
    return value;
  }

  private file(key: string): string {
    return join(this.dir!, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  private async readDisk(key: string): Promise<Entry | null> {
    if (!this.dir) return null;
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as Entry;
      return typeof entry.savedAt === 'number' ? entry : null;
    } catch {
      return null;
    }
  }

  /** A failed write only costs a request next time; it must not fail the analysis. */
  private async writeDisk(key: string, entry: Entry): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(key), JSON.stringify(entry));
    } catch {
      // ignore
    }
  }
}
