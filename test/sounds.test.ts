import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SoundPicker } from '../src/audio/sound-picker.js';
import { ConfigError } from '../src/config/env.js';
import { knownSoundKeys, loadSoundsConfig } from '../src/config/sounds.js';
import { soundChain } from '../src/game/events.js';

describe('SoundPicker', () => {
  it('returns null for unknown or empty events', () => {
    const picker = new SoundPicker({ kill: [], death: ['d.wav'] });
    expect(picker.pick('kill')).toBeNull();
    expect(picker.pick('rampage')).toBeNull();
    expect(picker.keys()).toEqual(['death']);
  });

  it('picks using the injected random source', () => {
    const picker = new SoundPicker({ kill: ['a', 'b', 'c'] }, () => 0.99);
    expect(picker.pick('kill')).toBe('c');
  });

  it('does not repeat the same file twice in a row when there is a choice', () => {
    const picker = new SoundPicker({ kill: ['a', 'b'] }, () => 0);
    const picks = Array.from({ length: 6 }, () => picker.pick('kill'));
    expect(picks).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('repeats when there is only one file', () => {
    const picker = new SoundPicker({ kill: ['a'] });
    expect([picker.pick('kill'), picker.pick('kill')]).toEqual(['a', 'a']);
  });

  it('pickFirst uses the first key that has files', () => {
    const picker = new SoundPicker({ kill: ['kill.mp3'], rampage: ['rampage.mp3'], double_kill: [] });
    expect(picker.pickFirst(['rampage', 'kill'])).toBe('rampage.mp3');
    expect(picker.pickFirst(['double_kill', 'kill'])).toBe('kill.mp3');
    expect(picker.pickFirst(['death'])).toBeNull();
  });
});

describe('soundChain', () => {
  it('falls back to "kill" for multikills and streaks only', () => {
    expect(soundChain({ kind: 'multikill', count: 2, sound: 'double_kill' })).toEqual(['double_kill', 'kill']);
    expect(soundChain({ kind: 'streak', streak: 3, sound: 'killing_spree' })).toEqual(['killing_spree', 'kill']);
    expect(soundChain({ kind: 'kill', sound: 'kill' })).toEqual(['kill']);
    expect(soundChain({ kind: 'death', sound: 'death' })).toEqual(['death']);
  });
});

describe('loadSoundsConfig', () => {
  const setup = (config: unknown, files: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'sounds-test-'));
    mkdirSync(join(dir, 'sounds'));
    for (const f of files) writeFileSync(join(dir, 'sounds', f), '');
    const path = join(dir, 'sounds.config.json');
    writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
    return { dir, path };
  };

  it('resolves files relative to soundsDir and drops missing ones with a warning', () => {
    const { dir, path } = setup(
      { volume: 0.5, streaks: { '3': 'killing_spree' }, events: { kill: ['k1.wav', 'missing.wav'], killing_spree: ['ks.mp3'] } },
      ['k1.wav', 'ks.mp3'],
    );
    const config = loadSoundsConfig(path);
    expect(config.streakThresholds).toEqual({ 3: 'killing_spree' });
    expect(config.events.kill).toEqual([{ path: join(dir, 'sounds', 'k1.wav'), volume: 0.5 }]);
    expect(config.warnings.some((w) => w.includes('missing.wav'))).toBe(true);
    // Events the tracker can emit but with no files are listed (they fall back), not warned about.
    expect(config.withoutSound).toContain('double_kill');
    expect(config.withoutSound).not.toContain('kill');
    expect(config.warnings.some((w) => w.includes('double_kill'))).toBe(false);
  });

  it('defaults master and per-file volume to 1', () => {
    const { path } = setup({ events: { kill: ['a.wav', { file: 'b.wav' }] } }, ['a.wav', 'b.wav']);
    expect(loadSoundsConfig(path).events.kill?.map((s) => s.volume)).toEqual([1, 1]);
  });

  it('multiplies the per-file volume by the master volume', () => {
    const { path } = setup(
      { volume: 0.8, events: { kill: [{ file: 'loud.mp3', volume: 0.5 }, { file: 'quiet.mp3', volume: 1.5 }, 'plain.mp3'] } },
      ['loud.mp3', 'quiet.mp3', 'plain.mp3'],
    );
    expect(loadSoundsConfig(path).events.kill?.map((s) => s.volume)).toEqual([0.4, 1.2, 0.8]);
  });

  it('warns about a missing file given in object form', () => {
    const { path } = setup({ events: { kill: [{ file: 'gone.mp3', volume: 1.2 }] } });
    const config = loadSoundsConfig(path);
    expect(config.events.kill).toEqual([]);
    expect(config.warnings.some((w) => w.includes('gone.mp3'))).toBe(true);
  });

  it.each([
    ['volume out of range', { volume: 5, events: {} }],
    ['per-file volume out of range', { events: { kill: [{ file: 'a.mp3', volume: 3 }] } }],
    ['negative per-file volume', { events: { kill: [{ file: 'a.mp3', volume: -1 }] } }],
    ['object entry without file', { events: { kill: [{ volume: 1 }] } }],
    ['non-numeric streak key', { streaks: { three: 'x' }, events: {} }],
    ['events not arrays', { events: { kill: 'kill.wav' } }],
    ['broken JSON', '{ nope'],
  ])('rejects %s', (_name, config) => {
    const { path } = setup(config);
    expect(() => loadSoundsConfig(path)).toThrow(ConfigError);
  });

  it('the project sounds.config.json is valid', () => {
    // User-edited file: only validity is checked, missing sounds are just warnings.
    const config = loadSoundsConfig('sounds.config.json');
    expect(knownSoundKeys(config.streakThresholds).length).toBeLessThanOrEqual(25); // Discord choice limit
  });
});

describe('match result events', () => {
  it('victory and defeat are known events (they show up in /test once configured)', () => {
    const keys = knownSoundKeys({});
    expect(keys).toContain('victory');
    expect(keys).toContain('defeat');
  });
});
