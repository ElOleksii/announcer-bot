/** Sound keys are the keys of `events` in sounds.config.json. */
export type SoundKey = string;

export const MULTIKILL_SOUNDS = {
  2: 'double_kill',
  3: 'triple_kill',
  4: 'ultra_kill',
  5: 'rampage',
} as const satisfies Record<number, SoundKey>;

export type MultikillCount = keyof typeof MULTIKILL_SOUNDS;

/** Played once when the match ends; no fallback, silent when not configured. */
export const MATCH_RESULT_SOUNDS = {
  win: 'victory',
  loss: 'defeat',
} as const satisfies Record<'win' | 'loss', SoundKey>;

export type GameEvent =
  | { kind: 'kill'; sound: 'kill' }
  | { kind: 'multikill'; count: MultikillCount; sound: SoundKey }
  | { kind: 'streak'; streak: number; sound: SoundKey }
  | { kind: 'death'; sound: 'death' };

/** Sounds to try in order: a multikill or streak without its own sound falls back to the plain kill sound. */
export function soundChain(event: GameEvent): SoundKey[] {
  return event.kind === 'multikill' || event.kind === 'streak' ? [event.sound, 'kill'] : [event.sound];
}

export function describeEvent(event: GameEvent): string {
  switch (event.kind) {
    case 'kill':
      return 'kill';
    case 'multikill':
      return `${event.sound} (x${event.count})`;
    case 'streak':
      return `${event.sound} (streak ${event.streak})`;
    case 'death':
      return 'death';
  }
}
