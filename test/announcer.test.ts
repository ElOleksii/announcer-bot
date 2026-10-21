import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { Announcer, type AnnouncerMode } from '../src/announcer.js';
import type { PlaybackQueue, QueueItem } from '../src/audio/playback-queue.js';
import { SoundPicker } from '../src/audio/sound-picker.js';
import type { Commentator, SpokenLine } from '../src/commentary/commentator.js';
import type { KillContext } from '../src/commentary/context.js';
import type { SoundFile } from '../src/config/sounds.js';
import type { GameEvent } from '../src/game/events.js';

const silent = pino({ level: 'silent' });
const KILL: GameEvent = { kind: 'kill', sound: 'kill' };
const ctx = { event: KILL } as KillContext;

function setup(mode: AnnouncerMode, line: SpokenLine | null | 'none' = { text: 'жарт', file: 'line.mp3' }) {
  const played: QueueItem[] = [];
  const queue = { enqueue: (item: QueueItem) => played.push(item) } as unknown as PlaybackQueue;
  const picker = new SoundPicker<SoundFile>({ kill: [{ path: 'kill.mp3', volume: 0.8 }] });
  const commentator =
    line === 'none' ? null : ({ comment: async () => line, say: async () => line, description: 'fake' } as unknown as Commentator);
  const announcer = new Announcer({ picker, queue, commentator, mode, logger: silent });
  return { announcer, files: () => played.map((p) => p.file) };
}

describe('Announcer', () => {
  it('sounds mode plays the sound only', async () => {
    const { announcer, files } = setup('sounds');
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['kill.mp3']);
  });

  it('commentator mode plays the spoken line only', async () => {
    const { announcer, files } = setup('commentator');
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['line.mp3']);
  });

  it('commentator mode falls back to the sound when no line was produced', async () => {
    const { announcer, files } = setup('commentator', null);
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['kill.mp3']);
  });

  it('both mode plays the sound first, then the line', async () => {
    const { announcer, files } = setup('both');
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['kill.mp3', 'line.mp3']);
  });

  it('without a commentator only sounds mode is available', async () => {
    const { announcer, files } = setup('commentator', 'none');
    expect(announcer.mode).toBe('sounds');
    expect(announcer.setMode('both')).toBe(false);
    expect(announcer.setMode('sounds')).toBe(true);
    expect(await announcer.say('привіт')).toBe('unavailable');
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['kill.mp3']);
  });

  it('say() queues the spoken text', async () => {
    const { announcer, files } = setup('sounds');
    expect(await announcer.say('привіт')).toBe('queued');
    expect(files()).toEqual(['line.mp3']);
  });

  it('switches mode at runtime', async () => {
    const { announcer, files } = setup('sounds');
    expect(announcer.setMode('commentator')).toBe(true);
    await announcer.onEvent(KILL, ctx);
    expect(files()).toEqual(['line.mp3']);
  });
});

describe('Announcer.playMatchResult', () => {
  const withSounds = (events: Record<string, SoundFile[]>, mode: AnnouncerMode = 'sounds') => {
    const played: QueueItem[] = [];
    const queue = { enqueue: (item: QueueItem) => played.push(item) } as unknown as PlaybackQueue;
    const commentator = { comment: async () => null, say: async () => null, description: 'fake' } as unknown as Commentator;
    const announcer = new Announcer({ picker: new SoundPicker<SoundFile>(events), queue, commentator, mode, logger: silent });
    return { announcer, played };
  };

  it('plays "victory" on a win and "defeat" on a loss', () => {
    const { announcer, played } = withSounds({
      victory: [{ path: 'win.mp3', volume: 1 }],
      defeat: [{ path: 'lose.mp3', volume: 0.5 }],
    });
    expect(announcer.playMatchResult('win')).toBe(true);
    expect(announcer.playMatchResult('loss')).toBe(true);
    expect(played).toEqual([
      { file: 'win.mp3', volume: 1, label: 'victory' },
      { file: 'lose.mp3', volume: 0.5, label: 'defeat' },
    ]);
  });

  it('is silent without a configured file and never falls back to the kill sound', () => {
    const { announcer, played } = withSounds({ kill: [{ path: 'kill.mp3', volume: 1 }] });
    expect(announcer.playMatchResult('win')).toBe(false);
    expect(announcer.playMatchResult('loss')).toBe(false);
    expect(played).toEqual([]);
  });

  it.each(['commentator', 'both'] as const)('plays the sound file in %s mode too', (mode) => {
    const { announcer, played } = withSounds({ victory: [{ path: 'win.mp3', volume: 1 }] }, mode);
    expect(announcer.playMatchResult('win')).toBe(true);
    expect(played.map((p) => p.file)).toEqual(['win.mp3']);
  });
});
