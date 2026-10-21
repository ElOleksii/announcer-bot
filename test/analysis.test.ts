import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { MatchAnalyzer, MatchEndWatcher, resolveMatchHint } from '../src/analysis/analyzer.js';
import { computeMvp, MVP_SHARE_GAP } from '../src/analysis/mvp.js';
import { assignPositions, computeBlame, findOurTeam, plural, ramp, CULPRIT_MIN_SCORE } from '../src/analysis/blame.js';
import { OpenDotaClient, matchSchema, steamIdToAccountId, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { fallbackMvpVerdict, fallbackVerdict, formatChatReport, formatMvpChat, mvpUserPrompt, verdictUserPrompt } from '../src/analysis/report.js';
import { clampMessage } from '../src/discord/commands.js';
import { parseGsiPayload, type GsiPayload } from '../src/gsi/schema.js';
import { playing } from './helpers.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const loadMatch = (): OdMatch => matchSchema.parse(fixture('opendota-match'));
const heroes = new Map((fixture('opendota-heroes') as HeroInfo[]).map((h) => [h.id, h]));
const silent = pino({ level: 'silent' });

/** In the fixture Radiant won; Dire lost. */
const DIRE = false;

describe('helpers', () => {
  it('ramp is linear and clamped', () => {
    expect([ramp(-1, 0, 4), ramp(2, 0, 4), ramp(9, 0, 4), ramp(Number.NaN, 0, 1)]).toEqual([0, 0.5, 1, 0]);
  });

  it.each([
    [1, '1 смерть'],
    [3, '3 смерті'],
    [5, '5 смертей'],
    [11, '11 смертей'],
    [22, '22 смерті'],
  ])('plural(%i)', (n, expected) => {
    expect(plural(n, ['смерть', 'смерті', 'смертей'])).toBe(expected);
  });

  it('converts a 64-bit steam id to an account id', () => {
    expect(steamIdToAccountId('76561198000000000')).toBe(39734272);
    expect(steamIdToAccountId('nope')).toBeNull();
  });
});

describe('computeBlame on a real parsed match', () => {
  const report = computeBlame(loadMatch(), heroes, DIRE);

  it('analyses our five players, sorted by score', () => {
    expect(report.lost).toBe(true);
    expect(report.parsed).toBe(true);
    expect(report.ourTeam).toBe('dire');
    expect(report.players).toHaveLength(5);
    const scores = report.players.map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('uses OpenDota position estimates (one player per position)', () => {
    expect(new Set(report.players.map((p) => p.position))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('never exceeds category maxima and backs points with numbers', () => {
    for (const p of report.players) {
      for (const c of p.categories) expect(c.points).toBeLessThanOrEqual(c.max);
      expect(p.score).toBeLessThanOrEqual(100);
      for (const fact of p.evidence) expect(fact).toMatch(/\d/);
    }
  });

  it('judges supports on support work instead of farm', () => {
    for (const p of report.players) {
      const keys = p.categories.map((c) => c.key);
      expect(keys).toContain(p.position >= 4 ? 'support' : 'farm');
      expect(keys).not.toContain(p.position >= 4 ? 'farm' : 'support');
    }
  });

  it('mitigates the top damage dealer', () => {
    const topDamage = report.players.find((p) => p.mitigations.includes('найбільший урон у команді'));
    expect(topDamage).toBeDefined();
    expect(topDamage!.score).toBeLessThan(topDamage!.raw);
  });

  it('reports the winning side as not lost', () => {
    expect(computeBlame(loadMatch(), heroes, !DIRE).lost).toBe(false);
  });
});

describe('computeBlame rules', () => {
  /** A copy of the fixture with our (Dire) players tweaked. */
  function tweak(edit: (ours: OdMatch['players'], theirs: OdMatch['players'], match: OdMatch) => void): OdMatch {
    const match = loadMatch();
    edit(
      match.players.filter((p) => !p.isRadiant),
      match.players.filter((p) => p.isRadiant),
      match,
    );
    return match;
  }

  it('a leaver gets 100 and is the culprit; everyone else is halved', () => {
    const base = computeBlame(loadMatch(), heroes, DIRE);
    const match = tweak((ours) => {
      ours[4]!.abandons = 1;
    });
    const report = computeBlame(match, heroes, DIRE);
    const leaver = report.players.find((p) => p.leaver)!;
    expect(leaver.score).toBe(100);
    expect(report.verdict).toEqual({ kind: 'culprit', slot: leaver.slot });
    const other = report.players.find((p) => !p.leaver)!;
    const before = base.players.find((p) => p.slot === other.slot)!;
    expect(other.score).toBeLessThanOrEqual(Math.ceil(before.score / 2));
  });

  it('names a culprit only with ≥ 45 points and a 10-point lead', () => {
    const match = tweak((ours) => {
      const feeder = ours.find((p) => p.position_est === 2)!;
      feeder.deaths = 18;
      feeder.deaths_log = Array.from({ length: 18 }, (_, i) => ({ time: 120 + i * 150, gold_fed: 300, time_dead: 40 }));
      feeder.life_state_dead = 900;
      feeder.gold_per_min = 250;
      feeder.xp_per_min = 300;
      feeder.teamfight_participation = 0.2;
      feeder.hero_damage = 2000;
    });
    const report = computeBlame(match, heroes, DIRE);
    const [first, second] = report.players;
    expect(first!.score).toBeGreaterThanOrEqual(CULPRIT_MIN_SCORE);
    expect(first!.score - second!.score).toBeGreaterThanOrEqual(10);
    expect(report.verdict).toEqual({ kind: 'culprit', slot: first!.slot });
    expect(first!.evidence.join(' ')).toContain('18 смертей');
  });

  it('blames the whole team when every core is far behind at 15 minutes', () => {
    const match = tweak((ours) => {
      for (const p of ours.filter((x) => (x.position_est ?? 5) <= 3)) p.gold_t = p.gold_t!.map((g) => Math.round(g * 0.5));
    });
    expect(computeBlame(match, heroes, DIRE).verdict).toEqual({ kind: 'team', reason: 'behind-everywhere' });
  });

  it('drops lane points for a player alone against two', () => {
    const match = tweak((ours, theirs) => {
      const offlaner = ours.find((p) => p.position_est === 3)!;
      offlaner.gold_t = offlaner.gold_t!.map((g) => Math.round(g * 0.3));
      for (const p of ours) if (p !== offlaner && p.lane === offlaner.lane) p.lane = 2;
      for (const p of theirs.slice(0, 2)) {
        p.lane = offlaner.lane;
        p.is_roaming = false;
      }
    });
    const offlaner = computeBlame(match, heroes, DIRE).players.find((p) => p.position === 3)!;
    expect(offlaner.categories.find((c) => c.key === 'lane')?.points).toBe(0);
    expect(offlaner.mitigations).toContain('стояв сам проти двох на лайні');
  });

  it('works on an unparsed match with basic stats only', () => {
    const match = tweak((_ours, _theirs, m) => {
      m.version = null;
      m.radiant_gold_adv = null;
      for (const p of m.players) {
        for (const key of ['gold_t', 'lh_t', 'deaths_log', 'buyback_log', 'teamfight_participation', 'life_state_dead', 'obs_placed', 'sen_placed', 'stuns', 'position_est'] as const) {
          delete p[key];
        }
      }
    });
    const report = computeBlame(match, heroes, DIRE);
    expect(report.parsed).toBe(false);
    const unavailable = report.players[0]!.categories.filter((c) => !c.available).map((c) => c.key);
    expect(unavailable).toEqual(expect.arrayContaining(['lane', 'endgame', 'throw']));
    expect(new Set(report.players.map((p) => p.position)).size).toBe(5);
  });
});

describe('positions and team detection', () => {
  it('falls back to net worth order when estimates are duplicated', () => {
    const team = loadMatch().players.filter((p) => p.isRadiant);
    for (const p of team) p.position_est = 1;
    const positions = assignPositions(team);
    const richest = [...team].sort((a, b) => (b.net_worth ?? 0) - (a.net_worth ?? 0))[0]!;
    expect(positions.get(richest.player_slot)).toBe(1);
  });

  it('finds our team by account id, then by hero', () => {
    const match = loadMatch();
    const direPlayer = match.players.find((p) => !p.isRadiant)!;
    expect(findOurTeam(match, { accountId: direPlayer.account_id ?? null })).toBe(false);
    expect(findOurTeam(match, { heroId: direPlayer.hero_id })).toBe(false);
    expect(findOurTeam(match, { accountId: 1, heroId: 99999 })).toBeNull();
  });
});

describe('report text', () => {
  const report = computeBlame(loadMatch(), heroes, DIRE);

  it('chat report lists every player with points', () => {
    const text = formatChatReport(report);
    expect(text).toContain('Розбір поразки');
    for (const p of report.players) expect(text).toContain(p.hero);
    expect(text.split('```')).toHaveLength(3);
  });

  it('prompt carries the verdict and facts, never Steam names', () => {
    const prompt = verdictUserPrompt(report);
    expect(prompt).toContain('Вердикт');
    expect(prompt).toContain(report.players[0]!.hero);
  });

  it.each(['harsh', 'light'] as const)('built-in %s verdict is speakable', (tone) => {
    const text = fallbackVerdict(report, tone);
    expect(text.length).toBeGreaterThan(30);
    expect(text).not.toMatch(/[*`_#]/);
  });

  it('clampMessage keeps Discord limits and closes code blocks', () => {
    const long = `head\n\`\`\`\n${'рядок з фактами\n'.repeat(200)}\`\`\``;
    const clamped = clampMessage(long);
    expect(clamped.length).toBeLessThanOrEqual(2000);
    expect(clamped.split('```').length % 2).toBe(1);
  });
});

describe('OpenDotaClient', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('requests a parse and polls until the match is parsed', async () => {
    const unparsed = { ...(fixture('opendota-match') as object), version: null };
    const responses = [json({}, 404), json(unparsed), json(fixture('opendota-match'))];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return json({ job: { jobId: 1 } });
      return responses.shift()!;
    });
    const client = new OpenDotaClient({ fetch: fetchMock, sleep: async () => {} });
    const match = await client.getParsedMatch('9047376255', { timeoutMs: 60_000, pollMs: 1 });
    expect(match.version).not.toBeNull();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe('https://api.opendota.com/api/request/9047376255');
  });

  it('returns basic data when parsing does not finish in time', async () => {
    const unparsed = { ...(fixture('opendota-match') as object), version: null };
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => (init?.method === 'POST' ? json({}) : json(unparsed)));
    const client = new OpenDotaClient({ fetch: fetchMock, sleep: async () => {} });
    const match = await client.getParsedMatch('1', { timeoutMs: 0, pollMs: 1 });
    expect(match.version).toBeNull();
  });

  it('throws MatchNotFound when OpenDota never has the match', async () => {
    const client = new OpenDotaClient({ fetch: async (_url, init) => (init?.method === 'POST' ? json({}) : json({}, 404)), sleep: async () => {} });
    await expect(client.getParsedMatch('1', { timeoutMs: 0, pollMs: 1 })).rejects.toThrow(/no data/);
  });
});

describe('MatchAnalyzer', () => {
  const stubClient = (match: unknown) =>
    new OpenDotaClient({
      fetch: async (url) => new Response(JSON.stringify(String(url).endsWith('/heroes') ? fixture('opendota-heroes') : match)),
      sleep: async () => {},
    });
  const direHero = loadMatch().players.find((p) => !p.isRadiant)!.hero_id;
  const radiantHero = loadMatch().players.find((p) => p.isRadiant)!.hero_id;
  const wait = { timeoutMs: 0, pollMs: 1 };

  it('analyses a loss with the built-in verdict when Gemini is not configured', async () => {
    const analyzer = new MatchAnalyzer({ openDota: stubClient(fixture('opendota-match')), writer: null, logger: silent });
    const result = await analyzer.analyze({ matchId: '9047376255', accountId: null, heroId: direHero }, 'harsh', wait);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.verdictText).toContain('Розбір поразки');
      expect(result.chatText).toContain('9047376255');
      // The verdict is part of the chat message, quoted above the table.
      expect(result.chatText).toContain(`> ${result.verdictText}`);
    }
  });

  it('analyses a win with the MVP report', async () => {
    const analyzer = new MatchAnalyzer({ openDota: stubClient(fixture('opendota-match')), writer: null, logger: silent });
    const result = await analyzer.analyze({ matchId: '1', accountId: null, heroId: radiantHero }, 'harsh', wait);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.outcome).toBe('win');
      expect(result.chatText).toContain('Розбір перемоги');
      expect(result.chatText).toContain('MVP');
      expect(result.verdictText).toContain('Розбір перемоги');
    }
  });

  it('asks for the team when it cannot tell', async () => {
    const analyzer = new MatchAnalyzer({ openDota: stubClient(fixture('opendota-match')), writer: null, logger: silent });
    expect((await analyzer.analyze({ matchId: '1', accountId: null, heroId: null }, 'harsh', wait)).kind).toBe('unknown-team');
    expect((await analyzer.analyze({ matchId: '1', accountId: null, heroId: null, team: 'dire' }, 'harsh', wait)).kind).toBe('ok');
  });
});

describe('MatchEndWatcher', () => {
  const gsi = (gameState: string, winTeam = 'none', matchid = '777'): GsiPayload => {
    const raw = playing({ game_state: gameState, matchid });
    (raw.map as Record<string, unknown>).win_team = winTeam;
    const result = parseGsiPayload(raw);
    if (!result.ok) throw new Error(result.error);
    return result.payload;
  };

  it('reports a loss once, with account, hero and team from GSI', () => {
    const watcher = new MatchEndWatcher();
    expect(watcher.observe(gsi('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'))).toBeNull();
    const hint = watcher.observe(gsi('DOTA_GAMERULES_STATE_POST_GAME', 'dire'));
    expect(hint).toEqual({ matchId: '777', accountId: 39734272, heroId: 1, team: 'radiant' });
    expect(watcher.observe(gsi('DOTA_GAMERULES_STATE_POST_GAME', 'dire'))).toBeNull();
  });

  it('reports wins too (for the MVP analysis) and remembers the match for /analyze', () => {
    const watcher = new MatchEndWatcher();
    expect(watcher.observe(gsi('DOTA_GAMERULES_STATE_POST_GAME', 'radiant'))?.matchId).toBe('777');
    expect(watcher.lastMatch()?.matchId).toBe('777');
  });

  it('waits until the winner is known', () => {
    const watcher = new MatchEndWatcher();
    expect(watcher.observe(gsi('DOTA_GAMERULES_STATE_POST_GAME', 'none'))).toBeNull();
    expect(watcher.observe(gsi('DOTA_GAMERULES_STATE_POST_GAME', 'dire'))).not.toBeNull();
  });
});

describe('resolveMatchHint', () => {
  const last = { matchId: '777', accountId: 42, heroId: 1, team: 'radiant' as const };

  it('accepts an explicit numeric match id (regression: digits were rejected)', () => {
    expect(resolveMatchHint({ matchId: '9046484852', team: null }, null, null)).toEqual({
      matchId: '9046484852',
      accountId: null,
      heroId: null,
      team: null,
    });
  });

  it('rejects non-numeric ids and a missing match', () => {
    expect(resolveMatchHint({ matchId: 'abc', team: null }, last, null)).toBeNull();
    expect(resolveMatchHint({ matchId: 'ddd', team: null }, last, null)).toBeNull();
    expect(resolveMatchHint({ matchId: null, team: null }, null, null)).toBeNull();
  });

  it('defaults to the last GSI match with its hero and team', () => {
    expect(resolveMatchHint({ matchId: null, team: null }, last, null)).toEqual(last);
  });

  it('uses PLAYER_STEAM_ID when GSI has not seen a game since startup', () => {
    expect(resolveMatchHint({ matchId: '123', team: null }, null, 39734272)?.accountId).toBe(39734272);
  });

  it('an explicit team wins; hero/team from GSI only apply to the same match', () => {
    expect(resolveMatchHint({ matchId: '123', team: 'dire' }, last, null)).toEqual({ matchId: '123', accountId: 42, heroId: null, team: 'dire' });
  });
});

describe('computeMvp on a real parsed match (Radiant won)', () => {
  const RADIANT = true;
  const report = computeMvp(loadMatch(), heroes, RADIANT);

  it('scores our five players and names the top one MVP', () => {
    expect(report.ourTeam).toBe('radiant');
    expect(report.parsed).toBe(true);
    expect(report.players).toHaveLength(5);
    const scores = report.players.map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(report.mvpSlots[0]).toBe(report.players[0]!.slot);
    expect(report.players[0]!.hero).toBe('Kez');
  });

  it('never exceeds category maxima and backs points with numbers', () => {
    for (const p of report.players) {
      for (const c of p.categories) expect(c.points).toBeLessThanOrEqual(c.max);
      expect(p.score).toBeLessThanOrEqual(100);
      for (const fact of p.evidence) expect(fact).toMatch(/\d/);
    }
  });

  it('rewards supports for support work instead of farm', () => {
    for (const p of report.players) {
      const keys = p.categories.map((c) => c.key);
      expect(keys).toContain(p.position >= 4 ? 'support' : 'farm');
      expect(keys).not.toContain(p.position >= 4 ? 'farm' : 'support');
    }
  });

  it('a leaver gets 0 and cannot be MVP', () => {
    const match = loadMatch();
    const kez = match.players.find((p) => p.isRadiant && heroes.get(p.hero_id)?.localized_name === 'Kez')!;
    kez.abandons = 1;
    const r = computeMvp(match, heroes, RADIANT);
    expect(r.players.find((p) => p.hero === 'Kez')?.score).toBe(0);
    expect(r.mvpSlots).not.toContain(kez.player_slot);
  });

  it('shares MVP when the top two are within the gap', () => {
    const match = loadMatch();
    const ember = match.players.find((p) => p.isRadiant && heroes.get(p.hero_id)?.localized_name === 'Ember Spirit')!;
    const kez = match.players.find((p) => p.isRadiant && heroes.get(p.hero_id)?.localized_name === 'Kez')!;
    for (const key of ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'hero_damage', 'tower_damage', 'teamfight_participation', 'kills_log', 'deaths_log', 'gold_t', 'lh_t'] as const) {
      (ember as Record<string, unknown>)[key] = structuredClone((kez as Record<string, unknown>)[key]);
    }
    const r = computeMvp(match, heroes, RADIANT);
    expect(Math.abs(r.players[0]!.score - r.players[1]!.score)).toBeLessThan(MVP_SHARE_GAP);
    expect(r.mvpSlots).toHaveLength(2);
    expect(formatMvpChat(r)).toMatch(/MVP: .+ і .+/);
  });

  it('penalises many deaths', () => {
    const match = loadMatch();
    const willow = match.players.find((p) => p.isRadiant && heroes.get(p.hero_id)?.localized_name === 'Dark Willow')!;
    willow.deaths = 14;
    const p = computeMvp(match, heroes, RADIANT).players.find((x) => x.hero === 'Dark Willow')!;
    expect(p.modifiers.join(' ')).toContain('багато смертей');
    expect(p.score).toBeLessThan(p.raw);
  });

  it('works on an unparsed match with basic stats only', () => {
    const match = loadMatch();
    match.version = null;
    match.radiant_gold_adv = null;
    for (const p of match.players) {
      for (const key of ['gold_t', 'lh_t', 'deaths_log', 'kills_log', 'teamfight_participation', 'obs_placed', 'sen_placed', 'stuns', 'position_est'] as const) delete p[key];
    }
    const r = computeMvp(match, heroes, RADIANT);
    expect(r.parsed).toBe(false);
    const unavailable = r.players[0]!.categories.filter((c) => !c.available).map((c) => c.key);
    expect(unavailable).toEqual(expect.arrayContaining(['lane', 'closing', 'surge']));
    expect(r.mvpSlots.length).toBeGreaterThan(0);
  });

  it('chat, prompt and built-in verdict name the MVP', () => {
    const text = formatMvpChat(report, 'вердикт');
    expect(text).toContain('Розбір перемоги');
    expect(text).toContain('🏆 **MVP: Kez**');
    expect(text).toContain('> вердикт');
    expect(text.split('```')).toHaveLength(3);
    expect(mvpUserPrompt(report)).toContain('MVP — Kez');
    for (const tone of ['harsh', 'light'] as const) {
      const verdict = fallbackMvpVerdict(report, tone);
      expect(verdict).toContain('Kez');
      expect(verdict).not.toMatch(/[*`_#]/);
    }
  });
});
