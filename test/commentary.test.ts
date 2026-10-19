import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { Commentator } from '../src/commentary/commentator.js';
import { KillContextTracker, type KillContext } from '../src/commentary/context.js';
import { ElevenLabsSynthesizer } from '../src/commentary/elevenlabs.js';
import { GeminiWriter } from '../src/commentary/gemini.js';
import { heroDisplayName } from '../src/commentary/hero-names.js';
import { cleanLine, describeForPrompt } from '../src/commentary/prompt.js';
import { TemplateWriter } from '../src/commentary/templates.js';
import type { CommentaryWriter, SpeechSynthesizer } from '../src/commentary/writer.js';
import { parseGsiPayload, type GsiPayload } from '../src/gsi/schema.js';
import { playing, type PlayingOverrides } from './helpers.js';

const silent = pino({ level: 'silent' });
const KILL = { kind: 'kill', sound: 'kill' } as const;

function payload(overrides: PlayingOverrides = {}, extra: Record<string, unknown> = {}): GsiPayload {
  const raw = playing(overrides);
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'player' || key === 'hero') Object.assign(raw[key] as object, value);
    else raw[key] = value;
  }
  const result = parseGsiPayload(raw);
  if (!result.ok) throw new Error(result.error);
  return result.payload;
}

const ability = (name: string, cooldown: number) => ({ name, level: 1, can_cast: cooldown === 0, cooldown });

function ctx(overrides: Partial<KillContext> = {}): KillContext {
  return {
    event: KILL,
    hero: 'Lina',
    heroLevel: 12,
    kills: 5,
    deaths: 2,
    assists: 7,
    killStreak: 3,
    gameTimeSec: 872,
    alive: true,
    healthPercent: 80,
    recentCasts: [],
    victims: [],
    ...overrides,
  };
}

describe('heroDisplayName', () => {
  it.each([
    ['npc_dota_hero_shadow_shaman', 'Shadow Shaman'],
    ['npc_dota_hero_techies', 'Techies'],
    ['npc_dota_hero_nevermore', 'Shadow Fiend'],
    ['npc_dota_hero_zuus', 'Zeus'],
    [undefined, null],
    ['', null],
  ])('%s → %s', (internal, expected) => {
    expect(heroDisplayName(internal)).toBe(expected);
  });
});

describe('KillContextTracker', () => {
  it('detects an ability that went on cooldown right before the kill', () => {
    const tracker = new KillContextTracker();
    tracker.observe(payload({ game_time: 600 }, { abilities: { ability3: ability('lina_laguna_blade', 0) } }), 0);
    const kill = payload({ kills: 4, game_time: 601 }, { abilities: { ability3: ability('lina_laguna_blade', 70) } });
    tracker.observe(kill, 0);
    expect(tracker.build(KILL, kill, 0).recentCasts).toEqual(['lina_laguna_blade']);
  });

  it('detects items too, and forgets casts older than 3 game seconds', () => {
    const tracker = new KillContextTracker();
    const items = (cd: number) => ({ items: { slot0: { name: 'item_dagon', cooldown: cd }, slot1: { name: 'empty' } } });
    tracker.observe(payload({ game_time: 600 }, items(0)), 0);
    tracker.observe(payload({ game_time: 601 }, items(30)), 0);
    const late = payload({ kills: 4, game_time: 605 }, items(26));
    tracker.observe(late, 0);
    expect(tracker.build(KILL, late, 0).recentCasts).toEqual([]);
  });

  it('a cooldown ticking down is not a cast', () => {
    const tracker = new KillContextTracker();
    tracker.observe(payload({ game_time: 600 }, { abilities: { a: ability('lina_dragon_slave', 8) } }), 0);
    const kill = payload({ kills: 4, game_time: 601 }, { abilities: { a: ability('lina_dragon_slave', 7) } });
    tracker.observe(kill, 0);
    expect(tracker.build(KILL, kill, 0).recentCasts).toEqual([]);
  });

  it('reports which victim slot was killed and how many times', () => {
    const tracker = new KillContextTracker();
    tracker.observe(payload({ game_time: 600 }, { player: { kill_list: { victimid_7: 2 } } }), 0);
    const kill = payload({ kills: 4, game_time: 601 }, { player: { kill_list: { victimid_7: 3, victimid_5: 1 } } });
    tracker.observe(kill, 0);
    const victims = tracker.build(KILL, kill, 0).victims;
    expect(victims).toHaveLength(2);
    expect(victims).toEqual(expect.arrayContaining([{ slot: '7', timesKilled: 3 }, { slot: '5', timesKilled: 1 }]));
  });

  it('fills hero, level, HP and alive from the payload', () => {
    const tracker = new KillContextTracker();
    const p = payload({ kills: 4 }, { hero: { alive: false, health_percent: 0, level: 9 } });
    tracker.observe(p, 0);
    expect(tracker.build(KILL, p, 0)).toMatchObject({ hero: 'Anti-Mage', heroLevel: 9, alive: false, healthPercent: 0, kills: 4 });
  });

  it('survives sections in an unexpected shape', () => {
    const tracker = new KillContextTracker();
    const weird = payload({ kills: 4 }, { abilities: 'nope', items: [1, 2], player: { kill_list: 'x' } });
    expect(() => tracker.observe(weird, 0)).not.toThrow();
    expect(tracker.build(KILL, weird, 0)).toMatchObject({ recentCasts: [], victims: [] });
  });

  it('resets on a new match', () => {
    const tracker = new KillContextTracker();
    tracker.observe(payload({ game_time: 600 }, { abilities: { a: ability('lina_laguna_blade', 0) } }), 0);
    // Same cooldown values in a new match must not look like a cast relative to the old match.
    const next = payload({ matchid: '42', game_time: 601 }, { abilities: { a: ability('lina_laguna_blade', 70) } });
    tracker.observe(next, 0);
    expect(tracker.build(KILL, next, 0).recentCasts).toEqual([]);
  });
});

describe('describeForPrompt', () => {
  it('includes the facts a joke can use', () => {
    const text = describeForPrompt(
      ctx({ event: { kind: 'multikill', count: 2, sound: 'double_kill' }, recentCasts: ['lina_laguna_blade'], victims: [{ slot: '7', timesKilled: 3 }] }),
    );
    expect(text).toContain('double kill');
    expect(text).toContain('Lina, рівень 12');
    expect(text).toContain('5/2/7');
    expect(text).toContain('14:32');
    expect(text).toContain('lina_laguna_blade');
    expect(text).toContain('вже 3-й раз');
  });

  it('flags posthumous kills, low HP and no recent cast', () => {
    expect(describeForPrompt(ctx({ alive: false }))).toContain('МЕРТВИЙ');
    expect(describeForPrompt(ctx({ healthPercent: 7 }))).toContain('7% HP');
    expect(describeForPrompt(ctx())).toContain('нічого не кастував');
  });

  it('does not talk about casts on death', () => {
    expect(describeForPrompt(ctx({ event: { kind: 'death', sound: 'death' } }))).not.toContain('кастував');
  });
});

describe('cleanLine', () => {
  it('strips quotes and newlines', () => {
    expect(cleanLine('«Бум!\nХтось не подивився під ноги.»')).toBe('Бум! Хтось не подивився під ноги.');
  });

  it('cuts long text at a sentence end', () => {
    const long = `${'Дуже довге речення про техіса. '.repeat(10)}`;
    const line = cleanLine(long, 100);
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.endsWith('.')).toBe(true);
  });
});

describe('TemplateWriter', () => {
  const writer = new TemplateWriter(() => 0);

  it('fills in the hero name', async () => {
    expect(await writer.write(ctx())).toContain('Lina');
  });

  it('has special lines for Techies kills without a cast', async () => {
    const line = await new TemplateWriter(() => 0.99).write(ctx({ hero: 'Techies', recentCasts: [] }));
    expect(line.toLowerCase()).toContain('мін');
  });

  it.each([
    ['death', ctx({ event: { kind: 'death', sound: 'death' } })],
    ['posthumous', ctx({ alive: false })],
    ['streak', ctx({ event: { kind: 'streak', streak: 5, sound: 'mega_kill' } })],
  ])('produces a line for %s', async (_name, c) => {
    expect((await writer.write(c)).length).toBeGreaterThan(5);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GeminiWriter', () => {
  it('sends a generateContent request and returns the cleaned text', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '"Лагуна і нема питань."' }] } }] }),
    );
    const writer = new GeminiWriter({ apiKey: 'g-key', model: 'gemini-test', fetch: fetchMock });
    expect(await writer.write(ctx({ recentCasts: ['lina_laguna_blade'] }))).toBe('Лагуна і нема питань.');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(String(url)).not.toContain('g-key');
    const body = JSON.parse(String(init?.body)) as { systemInstruction: unknown; contents: Array<{ parts: Array<{ text: string }> }> };
    expect(body.systemInstruction).toBeDefined();
    expect(body.contents[0]?.parts[0]?.text).toContain('lina_laguna_blade');
  });

  it('throws on HTTP errors without leaking the key', async () => {
    const writer = new GeminiWriter({ apiKey: 'secret-key', fetch: async () => jsonResponse({ error: 'quota' }, 429) });
    await expect(writer.write(ctx())).rejects.toThrow(/429/);
    await expect(writer.write(ctx())).rejects.not.toThrow(/secret-key/);
  });

  it('retries on 503 when asked to, and gives up on other errors', async () => {
    const statuses = [503, 429, 200];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const status = statuses.shift()!;
      return status === 200 ? jsonResponse({ candidates: [{ content: { parts: [{ text: 'ок' }] } }] }) : jsonResponse({}, status);
    });
    const writer = new GeminiWriter({ apiKey: 'k', fetch: fetchMock, sleep: async () => {} });
    expect(await writer.complete({ system: 's', user: 'u', retries: 3 })).toBe('ок');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const badRequest = vi.fn<typeof fetch>(async () => jsonResponse({}, 400));
    await expect(new GeminiWriter({ apiKey: 'k', fetch: badRequest }).complete({ system: 's', user: 'u', retries: 3 })).rejects.toThrow(/400/);
    expect(badRequest).toHaveBeenCalledTimes(1);
  });

  it('moves to the fallback model on 503 without waiting, and remembers which one answered', async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/primary:')
        ? jsonResponse({ error: 'high demand' }, 503)
        : jsonResponse({ candidates: [{ content: { parts: [{ text: 'запасна' }] } }] }),
    );
    const writer = new GeminiWriter({ apiKey: 'k', model: 'primary', fallbackModels: ['backup'], fetch: fetchMock, sleep });
    expect(await writer.complete({ system: 's', user: 'u' })).toBe('запасна');
    expect(writer.lastModel).toBe('backup');
    expect(fetchMock.mock.calls.map(([url]) => String(url).match(/models\/([^:]+):/)?.[1])).toEqual(['primary', 'backup']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('skips a model that no longer exists (404)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/gone:') ? jsonResponse({}, 404) : jsonResponse({ candidates: [{ content: { parts: [{ text: 'ок' }] } }] }),
    );
    const writer = new GeminiWriter({ apiKey: 'k', model: 'gone', fallbackModels: ['alive'], fetch: fetchMock });
    expect(await writer.complete({ system: 's', user: 'u' })).toBe('ок');
  });

  it('when every model is overloaded, waits and tries the whole list again', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      ++calls <= 2 ? jsonResponse({}, 503) : jsonResponse({ candidates: [{ content: { parts: [{ text: 'нарешті' }] } }] }),
    );
    const writer = new GeminiWriter({ apiKey: 'k', model: 'a', fallbackModels: ['b'], fetch: fetchMock, sleep });
    expect(await writer.complete({ system: 's', user: 'u', retries: 1 })).toBe('нарешті');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(writer.lastModel).toBe('a');
  });

  it('throws on an empty answer', async () => {
    const writer = new GeminiWriter({ apiKey: 'k', fetch: async () => jsonResponse({ candidates: [] }) });
    await expect(writer.write(ctx())).rejects.toThrow(/empty/);
  });
});

describe('ElevenLabsSynthesizer', () => {
  const setup = () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tts-test-'));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const tts = new ElevenLabsSynthesizer({ apiKey: 'xi-key', voiceId: 'voice1', model: 'eleven_flash_v2_5', cacheDir, fetch: fetchMock });
    return { tts, fetchMock };
  };

  it('requests mp3 audio and writes it to the cache dir', async () => {
    const { tts, fetchMock } = setup();
    const file = await tts.synthesize('Привіт');
    expect(existsSync(file)).toBe(true);
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice1?output_format=mp3_44100_128');
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Привіт', model_id: 'eleven_flash_v2_5', language_code: 'uk' });
  });

  it('reuses cached audio for the same text', async () => {
    const { tts, fetchMock } = setup();
    const a = await tts.synthesize('Те саме');
    const b = await tts.synthesize('Те саме');
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on HTTP errors', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tts-test-'));
    const tts = new ElevenLabsSynthesizer({ apiKey: 'k', cacheDir, fetch: async () => new Response('quota_exceeded', { status: 401 }) });
    await expect(tts.synthesize('x')).rejects.toThrow(/401/);
  });
});

describe('Commentator', () => {
  const synth = (impl?: SpeechSynthesizer['synthesize']): SpeechSynthesizer => ({
    name: 'fake-tts',
    synthesize: impl ?? (async (text) => `/tmp/${text.length}.mp3`),
  });
  const writer = (impl: CommentaryWriter['write']): CommentaryWriter => ({ name: 'fake', write: impl });
  const fallback = writer(async () => 'запасна фраза');

  it('writes and speaks a line', async () => {
    const c = new Commentator({ writer: writer(async () => 'жарт'), fallbackWriter: fallback, synthesizer: synth(), timeoutMs: 1000, logger: silent });
    expect(await c.comment(ctx())).toEqual({ text: 'жарт', file: '/tmp/4.mp3' });
  });

  it('uses the fallback writer when the main one fails', async () => {
    const c = new Commentator({
      writer: writer(async () => {
        throw new Error('quota');
      }),
      fallbackWriter: fallback,
      synthesizer: synth(),
      timeoutMs: 1000,
      logger: silent,
    });
    expect((await c.comment(ctx()))?.text).toBe('запасна фраза');
  });

  it('gives up after the timeout', async () => {
    const slow = writer(
      (_c, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const c = new Commentator({ writer: slow, fallbackWriter: fallback, synthesizer: synth(), timeoutMs: 1000, logger: silent });
    vi.useFakeTimers();
    try {
      const result = c.comment(ctx());
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when speech fails', async () => {
    const c = new Commentator({
      writer: writer(async () => 'жарт'),
      fallbackWriter: fallback,
      synthesizer: synth(async () => {
        throw new Error('tts down');
      }),
      timeoutMs: 1000,
      logger: silent,
    });
    expect(await c.comment(ctx())).toBeNull();
  });
});
