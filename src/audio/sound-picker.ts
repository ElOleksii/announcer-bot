import type { SoundKey } from '../game/events.js';

export type Random = () => number;

/** Picks a random sound for a key, avoiding an immediate repeat when there is a choice. */
export class SoundPicker<T> {
  private readonly last = new Map<SoundKey, T>();

  constructor(
    private readonly events: Readonly<Record<SoundKey, readonly T[]>>,
    private readonly random: Random = Math.random,
  ) {}

  pick(key: SoundKey): T | null {
    const sounds = this.events[key] ?? [];
    if (sounds.length === 0) return null;

    const previous = this.last.get(key);
    const candidates = sounds.length > 1 ? sounds.filter((s) => s !== previous) : sounds;
    const sound = candidates[Math.floor(this.random() * candidates.length)] ?? candidates[0]!;
    this.last.set(key, sound);
    return sound;
  }

  /** Picks from the first key in `keys` that has sounds. */
  pickFirst(keys: readonly SoundKey[]): T | null {
    for (const key of keys) {
      const sound = this.pick(key);
      if (sound !== null) return sound;
    }
    return null;
  }

  keys(): SoundKey[] {
    return Object.keys(this.events).filter((key) => (this.events[key]?.length ?? 0) > 0);
  }
}
