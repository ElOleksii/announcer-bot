import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonCache } from '../src/analysis/cache.js';
import { OpenDotaClient, bracketStats, matchSchema, type HeroStat } from '../src/analysis/opendota.js';

const json = (body: unknown, { status = 200, remaining }: { status?: number; remaining?: number } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: remaining === undefined ? {} : { 'x-rate-limit-remaining-minute': String(remaining) },
  });

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-cache-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JsonCache', () => {
  it('serves a value until it is older than the limit, then loads a fresh one', async () => {
    let now = 0;
    const cache = new JsonCache(null, () => now);
    const load = vi.fn(async () => now);
    expect(await cache.get('k', 1000, load)).toBe(0);
    now = 999;
    expect(await cache.get('k', 1000, load)).toBe(0);
    now = 1000;
    expect(await cache.get('k', 1000, load)).toBe(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('survives a restart through the directory', async () => {
    const dir = tempDir();
    await new JsonCache(dir).get('hero-stats', 60_000, async () => [{ id: 1 }]);
    const load = vi.fn(async () => [{ id: 2 }]);
    expect(await new JsonCache(dir).get('hero-stats', 60_000, load)).toEqual([{ id: 1 }]);
    expect(load).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, 'hero-stats.json'), 'utf8')).value).toEqual([{ id: 1 }]);
  });

  it('falls back to an expired copy when loading fails, and throws without one', async () => {
    let now = 0;
    const cache = new JsonCache(null, () => now);
    await cache.get('k', 10, async () => 'old');
    now = 100;
    expect(await cache.get('k', 10, async () => Promise.reject(new Error('down')))).toBe('old');
    await expect(cache.get('other', 10, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });
});

describe('OpenDotaClient rate limit and key', () => {
  it('waits out the minute before a parse request (cost 10) when fewer requests are left', async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => {
      calls.push('sleep');
    });
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return init?.method === 'POST' ? json({}) : json({}, { status: 404, remaining: 5 });
    });
    const client = new OpenDotaClient({ fetch: fetchMock, sleep });
    await expect(client.getMatch('1')).rejects.toThrow(/no match/);
    await client.requestParse('1');
    expect(calls).toEqual(['GET', 'sleep', 'POST']);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('does not wait while the allowance is enough', async () => {
    const sleep = vi.fn(async () => {});
    const client = new OpenDotaClient({ fetch: async () => json([], { remaining: 40 }), sleep });
    await client.getHeroMatchups(1);
    await client.requestParse('1');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries once after a 429', async () => {
    const responses = [json({}, { status: 429 }), json([{ hero_id: 2, games_played: 10, wins: 6 }])];
    const sleep = vi.fn(async () => {});
    const client = new OpenDotaClient({ fetch: async () => responses.shift()!, sleep });
    expect(await client.getHeroMatchups(1)).toEqual([{ hero_id: 2, games_played: 10, wins: 6 }]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('sends the API key as a query parameter when configured', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json([]));
    await new OpenDotaClient({ fetch: fetchMock, apiKey: 'secret' }).getHeroMatchups(14);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.opendota.com/api/heroes/14/matchups?api_key=secret');
  });
});

describe('OpenDotaClient reference data', () => {
  it('hero stats: picks and win rate per rank bracket', async () => {
    const pudge = { id: 14, localized_name: 'Pudge', roles: ['Disabler'], '5_pick': 200, '5_win': 104, '8_pick': 0, '8_win': 0 };
    const client = new OpenDotaClient({ fetch: async () => json([pudge]) });
    const stats = await client.getHeroStats();
    const stat = stats.get(14) as HeroStat;
    expect(stat.roles).toEqual(['Disabler']);
    expect(bracketStats(stat, 5)).toEqual({ games: 200, winRate: 0.52 });
    expect(bracketStats(stat, 8)).toBeNull();
    expect(bracketStats(stat, 3)).toBeNull();
  });

  it('items: by purchase_log key and by inventory slot id', async () => {
    const client = new OpenDotaClient({
      fetch: async () => json({ black_king_bar: { id: 116, dname: 'Black King Bar', cost: 4050, qual: 'epic' }, tango: { id: 44, cost: 90 } }),
    });
    const items = await client.getItems();
    expect(items.byKey.get('black_king_bar')).toEqual({ id: 116, key: 'black_king_bar', name: 'Black King Bar', cost: 4050 });
    expect(items.byId.get(44)).toEqual({ id: 44, key: 'tango', name: 'tango', cost: 90 });
  });

  it("a player's heroes are fetched once and then served from the cache", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json([{ hero_id: '14', games: 120, win: 64, last_played: 1 }]));
    const client = new OpenDotaClient({ fetch: fetchMock, cacheDir: tempDir() });
    expect(await client.getPlayerHeroes(1001)).toEqual([{ hero_id: 14, games: 120, win: 64, last_played: 1 }]);
    await client.getPlayerHeroes(1001);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.opendota.com/api/players/1001/heroes');
  });

  it('a bad response is an error, not a silently empty result', async () => {
    const client = new OpenDotaClient({ fetch: async () => json({ error: 'nope' }) });
    await expect(client.getHeroStats()).rejects.toThrow(/Unexpected OpenDota hero stats format/);
  });
});

describe('match schema: detailed fields', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/opendota-ranked-parsed.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('reads teamfights, objectives, the draft and per-player logs from a real ranked match', () => {
    const match = matchSchema.parse(fixture);
    expect(match.teamfights!.length).toBeGreaterThan(0);
    for (const fight of match.teamfights!) expect(fight.players).toHaveLength(10);
    expect(match.objectives!.some((o) => o.type === 'building_kill')).toBe(true);
    // The draft can hold a hero nobody played (a repick: Dire picked hero 11 here), so the heroes
    // actually played come from players[], and picks_bans only gives the order.
    const picked = match.picks_bans!.filter((p) => p.is_pick).map((p) => p.hero_id);
    expect(picked).toHaveLength(11);
    expect(picked).toEqual(expect.arrayContaining(match.players.map((p) => p.hero_id)));
    expect(match.players.map((p) => p.hero_id)).not.toContain(11);
    const player = match.players[0]!;
    expect(player.purchase_log!.length).toBeGreaterThan(0);
    expect(player.networth_t!.length).toBeGreaterThan(10);
    expect(typeof player.gold_spent).toBe('number');
  });

  it('an unexpected shape in a detailed field costs that field, not the whole match', () => {
    const players = (fixture.players as Array<Record<string, unknown>>).map((p, i) => (i === 0 ? { ...p, purchase_log: 'oops' } : p));
    const match = matchSchema.parse({ ...fixture, teamfights: { broken: true }, players });
    expect(match.teamfights).toBeNull();
    expect(match.players[0]!.purchase_log).toBeNull();
    expect(match.players[1]!.purchase_log).not.toBeNull();
  });
});
