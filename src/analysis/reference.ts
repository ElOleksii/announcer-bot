import type { GameMode } from './context.js';
import { bracketStats, type HeroMatchup, type HeroStat, type OdMatch, type OpenDotaClient, type PlayerHero } from './opendota.js';

/** The hero's current win rate where it matters: Turbo games for Turbo, else the match's rank bracket, else all public games. */
export function heroWinRate(stat: HeroStat | undefined, mode: GameMode, bracket: number | null): number | null {
  if (!stat) return null;
  if (mode === 'turbo') return stat.turbo_picks ? (stat.turbo_wins ?? 0) / stat.turbo_picks : null;
  if (bracket !== null) return bracketStats(stat, bracket)?.winRate ?? null;
  const all = [1, 2, 3, 4, 5, 6, 7, 8].map((b) => bracketStats(stat, b)).filter((s) => s !== null);
  const games = all.reduce((s, b) => s + b.games, 0);
  return games > 0 ? all.reduce((s, b) => s + b.winRate * b.games, 0) / games : null;
}

/** Matchup win rate pulled towards 50%: the sample is small, so a handful of games must not decide. */
export function shrunkMatchup(m: HeroMatchup | undefined, prior = 100): number | null {
  return m ? (m.wins + prior / 2) / (m.games_played + prior) : null;
}

/**
 * Data from outside the match that the pick area and the draft outlook need: the current meta,
 * matchups of our heroes, and our players' hero histories. Loaded before rating, so the rating
 * itself stays a pure calculation; whatever fails to load simply drops out.
 */
export interface ReferenceData {
  heroStats: Map<number, HeroStat> | null;
  /** By hero id, for our heroes. */
  matchups: Map<number, HeroMatchup[]>;
  /** By account id, for our players with a public profile. */
  playerHeroes: Map<number, PlayerHero[]>;
}

export const NO_REFERENCE: ReferenceData = { heroStats: null, matchups: new Map(), playerHeroes: new Map() };

export interface LoadedReference {
  data: ReferenceData;
  /** What could not be loaded, for the log. */
  failures: string[];
}

/** About 1 + 5 + 5 requests the first time, then mostly cache hits (see OpenDotaClient). */
export async function loadReference(client: OpenDotaClient, match: OdMatch, ourTeamIsRadiant: boolean, signal?: AbortSignal): Promise<LoadedReference> {
  const ours = match.players.filter((p) => p.isRadiant === ourTeamIsRadiant);
  const failures: string[] = [];
  const settle = async <T>(what: string, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load();
    } catch (err) {
      failures.push(`${what}: ${(err as Error).message}`);
      return null;
    }
  };
  const accounts = ours.map((p) => p.account_id).filter((id): id is number => typeof id === 'number' && id > 0);
  const [heroStats, matchups, playerHeroes] = await Promise.all([
    settle('hero stats', () => client.getHeroStats(signal)),
    Promise.all(ours.map(async (p) => [p.hero_id, await settle(`matchups of hero ${p.hero_id}`, () => client.getHeroMatchups(p.hero_id, signal))] as const)),
    Promise.all(accounts.map(async (id) => [id, await settle(`heroes of player ${id}`, () => client.getPlayerHeroes(id, signal))] as const)),
  ]);
  const present = <K, V>(entries: ReadonlyArray<readonly [K, V | null]>) => new Map(entries.filter((e): e is readonly [K, V] => e[1] !== null));
  return { data: { heroStats, matchups: present(matchups), playerHeroes: present(playerHeroes) }, failures };
}
