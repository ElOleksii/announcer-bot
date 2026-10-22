import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { MatchAnalyzer } from '../src/analysis/analyzer.js';
import { computeBlame } from '../src/analysis/blame.js';
import { draftOutlook } from '../src/analysis/draft.js';
import { computeMvp } from '../src/analysis/mvp.js';
import { OpenDotaClient, matchSchema, type HeroInfo, type HeroStat, type OdMatch } from '../src/analysis/opendota.js';
import { rateTeam } from '../src/analysis/rating.js';
import { NO_REFERENCE, heroWinRate, loadReference, shrunkMatchup, type ReferenceData } from '../src/analysis/reference.js';
import { formatChatReport } from '../src/analysis/report.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const load = (): OdMatch => matchSchema.parse(fixture('opendota-ranked-parsed'));
const heroes = new Map((fixture('opendota-heroes') as HeroInfo[]).map((h) => [h.id, h]));
const slot = (m: OdMatch, s: number) => m.players.find((p) => p.player_slot === s)!;

/** Hero stats where every hero wins `rate` in every bracket, with the given roles. */
function stats(entries: Array<[heroId: number, rate: number, roles?: string[]]>): Map<number, HeroStat> {
  return new Map(
    entries.map(([id, rate, roles = ['Carry', 'Support', 'Disabler']]) => {
      const stat: Record<string, unknown> = { id, localized_name: `hero ${id}`, roles, turbo_picks: 1000, turbo_wins: 1000 * rate };
      for (let b = 1; b <= 8; b++) Object.assign(stat, { [`${b}_pick`]: 1000, [`${b}_win`]: 1000 * rate });
      return [id, stat as HeroStat];
    }),
  );
}
const allHeroes = (m: OdMatch, rate = 0.5) => m.players.map((p) => [p.hero_id, rate] as [number, number]);
const facts = (m: OdMatch, radiant: boolean, s: number, ref: ReferenceData = NO_REFERENCE) => {
  const r = rateTeam(m, heroes, radiant, ref).players.find((p) => p.slot === s)!;
  return { good: r.good, bad: r.bad, area: (key: string) => r.areas.find((a) => a.key === key)! };
};

describe('reference helpers', () => {
  it('hero win rate: the match bracket, Turbo for Turbo, all brackets when the rank is unknown', () => {
    const [stat] = stats([[1, 0.5]]).values();
    Object.assign(stat!, { '5_pick': 200, '5_win': 110, turbo_picks: 100, turbo_wins: 40 });
    expect(heroWinRate(stat, 'ranked-all-pick', 5)).toBeCloseTo(0.55);
    expect(heroWinRate(stat, 'turbo', 5)).toBeCloseTo(0.4);
    // 7 brackets × 1000 games at 50% + 200 games at 55%.
    expect(heroWinRate(stat, 'ranked-all-pick', null)).toBeCloseTo((3500 + 110) / 7200);
    expect(heroWinRate(undefined, 'ranked-all-pick', 5)).toBeNull();
  });

  it('matchups are pulled towards 50% so a few games do not decide', () => {
    expect(shrunkMatchup({ hero_id: 1, games_played: 10, wins: 8 })).toBeCloseTo(58 / 110);
    expect(shrunkMatchup(undefined)).toBeNull();
  });

  it('loads what it can; a failed request drops out and is reported', async () => {
    const match = load();
    const client = new OpenDotaClient({
      fetch: async (url) => {
        const href = String(url);
        if (href.endsWith('/heroStats')) return new Response(JSON.stringify([{ id: 8, localized_name: 'Juggernaut' }]));
        if (href.endsWith('/heroes/155/matchups')) return new Response('oops', { status: 500 });
        if (href.includes('/matchups')) return new Response('[]');
        return new Response(JSON.stringify([{ hero_id: 8, games: 12, win: 7 }]));
      },
    });
    const { data, failures } = await loadReference(client, match, true);
    expect(data.heroStats?.get(8)?.localized_name).toBe('Juggernaut');
    expect(data.matchups.has(155)).toBe(false);
    expect(data.matchups.size).toBe(4);
    // Only our (Radiant) players' histories.
    expect([...data.playerHeroes.keys()].sort()).toEqual([1001, 1002, 1003, 1004, 1005]);
    expect(failures).toEqual([expect.stringContaining('matchups of hero 155')]);
  });
});

describe('pick area', () => {
  it('needs hero stats: without them it drops out of the rating', () => {
    expect(facts(load(), true, 4).area('pick').weight).toBe(0);
  });

  it('credits a hero that is strong in this bracket and names a weak one', () => {
    const m = load();
    const ref = { ...NO_REFERENCE, heroStats: stats([...allHeroes(m), [8, 0.535], [36, 0.47]]) };
    expect(facts(m, true, 4, ref).good).toContain('hero 8 зараз сильний у цьому ранзі: 53.5% перемог');
    expect(facts(m, true, 1, ref).bad).toContain('hero 36 зараз слабкий у цьому ранзі: 47.0% перемог');
  });

  it('flags only clear role mismatches: a non-carry at pos1, a hero with no support or control at pos4–5', () => {
    const m = load();
    // Slot 4 is pos1 (hero 8), slot 2 is pos5 (hero 100).
    const ref = { ...NO_REFERENCE, heroStats: stats([...allHeroes(m), [8, 0.5, ['Nuker']], [100, 0.5, ['Carry', 'Escape']]]) };
    expect(facts(m, true, 4, ref).bad).toContain('hero 8 не керрі, а грав на позиції 1');
    expect(facts(m, true, 2, ref).bad).toContain('hero 100 не саппорт і без контролю, а грав на позиції 5');
  });

  it('counts a near-first try on the hero against the player, and nothing else about experience', () => {
    const m = load();
    const ref: ReferenceData = {
      ...NO_REFERENCE,
      playerHeroes: new Map([
        [1005, [{ hero_id: 8, games: 1, win: 0 }]],
        [1002, [{ hero_id: 36, games: 250, win: 140 }]],
      ]),
    };
    expect(facts(m, true, 4, ref).bad).toContain('лише 1 гра на цьому героєві за всю історію');
    const veteran = facts(m, true, 1, ref);
    expect(veteran.area('pick').value).toBe(0);
    expect(veteran.good.join(' ')).not.toContain('героєві за всю історію');
  });
});

describe('items area', () => {
  it('a BKB owner who died in a fight without turning it on', () => {
    const m = load();
    // Slot 4 died first in fight 3 and used no BKB there.
    slot(m, 4).purchase_log = [...(slot(m, 4).purchase_log ?? []), { time: 0, key: 'black_king_bar' }];
    expect(facts(m, true, 4).bad.join(' ')).toMatch(/помер у \d+ файт\S* з BKB, не увімкнувши його/);
  });

  it('credits a BKB that was turned on in fights', () => {
    const m = load();
    const i = m.players.indexOf(slot(m, 4));
    slot(m, 4).purchase_log = [...(slot(m, 4).purchase_log ?? []), { time: 0, key: 'black_king_bar' }];
    for (const f of m.teamfights!) f.players[i]!.item_uses = { ...f.players[i]!.item_uses, black_king_bar: 1 };
    expect(facts(m, true, 4).good).toContain('увімкнув BKB у 5 файтах');
  });

  it('unspent gold lost on deaths, against what the position usually loses', () => {
    const m = load();
    slot(m, 4).deaths_log = slot(m, 4).deaths_log!.map((d) => ({ ...d, gold_lost: 600 }));
    expect(facts(m, true, 4).bad).toContain('у середньому втрачав 600 незбереженого золота за смерть (зазвичай ~100 на позиції 1)');
  });

  it('support detection only matters when the enemy goes invisible', () => {
    const m = load();
    // In the real match a Dire player bought an invisibility item: take it away first.
    for (const p of m.players.filter((x) => !x.isRadiant)) {
      p.purchase_log = (p.purchase_log ?? []).filter((x) => !['invis_sword', 'silver_edge', 'glimmer_cape'].includes(x.key));
    }
    expect(facts(m, true, 2).area('items').bad.map((f) => f.text).join(' ')).not.toContain('детект');
    slot(m, 128).hero_id = 32; // Riki on Dire
    slot(m, 2).purchase_log = (slot(m, 2).purchase_log ?? []).filter((x) => !['ward_sentry', 'dust', 'gem'].includes(x.key));
    expect(facts(m, true, 2).bad.join(' ')).toContain('детект проти невидимих ворогів: 0 сентрі, 0 порошку');
  });

  it('dying at the end of a loss with buyback gold but no buyback', () => {
    const m = load();
    const p = slot(m, 129);
    p.gold = 5000;
    p.deaths_log = [...p.deaths_log!.slice(0, -1), { ...p.deaths_log!.at(-1)!, time_dead: 60 }];
    expect(facts(m, false, 129).bad).toContain('помер наприкінці, маючи 5000 золота, і не викупився');
  });
});

describe('draft outlook', () => {
  it('adds up hero strength on both sides, plus our matchup edge, as context', () => {
    const m = load();
    const ours = m.players.filter((p) => p.isRadiant).map((p) => [p.hero_id, 0.52] as [number, number]);
    const theirs = m.players.filter((p) => !p.isRadiant).map((p) => [p.hero_id, 0.49] as [number, number]);
    const ctx = rateTeam(m, heroes, true).context;
    const outlook = draftOutlook(ctx, { ...NO_REFERENCE, heroStats: stats([...ours, ...theirs]) })!;
    expect(outlook.ourMeta).toBeCloseTo(0.1);
    expect(outlook.theirMeta).toBeCloseTo(-0.05);
    expect(outlook.matchupEdge).toBeNull();
    expect(outlook.expected).toBeCloseTo(0.65);
    expect(draftOutlook(ctx, NO_REFERENCE)).toBeNull();
  });

  it('is shown in the chat as context, and never changes a score', () => {
    const m = load();
    const ref = { ...NO_REFERENCE, heroStats: stats(allHeroes(m, 0.5)) };
    const withDraft = computeBlame(m, heroes, false, ref);
    expect(formatChatReport(withDraft)).toContain('🧩 Драфт: орієнтовно 50% на перемогу (сила героїв у цьому ранзі)');
    expect(formatChatReport(computeBlame(m, heroes, false))).not.toContain('Драфт');
    const strongerDraft = computeMvp(m, heroes, true, { ...NO_REFERENCE, heroStats: stats(allHeroes(m, 0.5)) });
    expect(strongerDraft.draft!.expected).toBeCloseTo(0.5);
  });
});

describe('the bot loads reference data before rating', () => {
  it('a full analysis carries the draft line when hero stats are available', async () => {
    const match = fixture('opendota-ranked-parsed') as { players: Array<{ hero_id: number }> };
    const heroStats = [...stats(match.players.map((p) => [p.hero_id, 0.5] as [number, number])).values()];
    const client = new OpenDotaClient({
      fetch: async (url) => {
        const href = String(url);
        if (href.endsWith('/heroes')) return new Response(JSON.stringify(fixture('opendota-heroes')));
        if (href.endsWith('/heroStats')) return new Response(JSON.stringify(heroStats));
        if (href.includes('/matches/')) return new Response(JSON.stringify(match));
        return new Response('[]');
      },
      sleep: async () => {},
    });
    const analyzer = new MatchAnalyzer({ openDota: client, writer: null, logger: pino({ level: 'silent' }) });
    const result = await analyzer.analyze({ matchId: '1', accountId: null, heroId: null, team: 'dire' }, 'harsh', { timeoutMs: 0, pollMs: 1 });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.report.draft?.expected).toBeCloseTo(0.5);
      expect(result.chatText).toContain('🧩 Драфт');
    }
  });
});
