import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { JsonCache } from './cache.js';

const API_BASE = 'https://api.opendota.com/api';

/** Lenient: every field beyond the basics is optional, because unparsed matches lack them. */
const deathSchema = z.looseObject({
  time: z.number(),
  key: z.string().optional(),
  gold_fed: z.number().optional(),
  /** Unreliable gold lost on this death (unspent gold). */
  gold_lost: z.number().optional(),
  time_dead: z.number().optional(),
});

/**
 * For the detailed (parsed replay) fields: an unexpected shape becomes null instead of failing the
 * whole match, so a format change on OpenDota's side costs one category, not the analysis.
 */
const detail = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(null);

const countsSchema = z.record(z.string(), z.number());

const wardSchema = z.looseObject({
  time: z.number(),
  /** Pairs a placement in obs_log/sen_log with its removal in obs_left_log/sen_left_log. */
  ehandle: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const teamfightPlayerSchema = z.looseObject({
  deaths: z.number().optional(),
  buybacks: z.number().optional(),
  damage: z.number().optional(),
  healing: z.number().optional(),
  gold_delta: z.number().optional(),
  xp_delta: z.number().optional(),
  ability_uses: countsSchema.optional(),
  item_uses: countsSchema.optional(),
  /** Units killed in the fight, by unit key. */
  killed: countsSchema.optional(),
});

const teamfightSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  last_death: z.number().optional(),
  deaths: z.number().optional(),
  /** Same order as match.players. */
  players: z.array(teamfightPlayerSchema),
});

const objectiveSchema = z.looseObject({
  time: z.number(),
  type: z.string(),
  key: z.union([z.string(), z.number()]).optional(),
  player_slot: z.number().optional(),
});

const pickBanSchema = z.looseObject({
  is_pick: z.boolean(),
  hero_id: z.number(),
  /** 0 Radiant, 1 Dire. */
  team: z.number(),
  order: z.number(),
});

const playerSchema = z.looseObject({
  player_slot: z.number(),
  account_id: z.number().nullable().optional(),
  isRadiant: z.boolean(),
  hero_id: z.number(),
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  last_hits: z.number().optional(),
  gold_per_min: z.number(),
  xp_per_min: z.number(),
  hero_damage: z.number().nullable().optional(),
  tower_damage: z.number().nullable().optional(),
  hero_healing: z.number().nullable().optional(),
  net_worth: z.number().nullable().optional(),
  lane: z.number().nullable().optional(),
  lane_role: z.number().nullable().optional(),
  is_roaming: z.boolean().nullable().optional(),
  position_est: z.number().nullable().optional(),
  lane_efficiency: z.number().nullable().optional(),
  teamfight_participation: z.number().nullable().optional(),
  obs_placed: z.number().nullable().optional(),
  sen_placed: z.number().nullable().optional(),
  stuns: z.number().nullable().optional(),
  observer_kills: z.number().nullable().optional(),
  sentry_kills: z.number().nullable().optional(),
  camps_stacked: z.number().nullable().optional(),
  /** Percentiles against recent public games on the same hero, e.g. benchmarks.hero_damage_per_min.pct. */
  benchmarks: z.record(z.string(), z.looseObject({ pct: z.number().nullable().optional() })).nullable().optional(),
  life_state_dead: z.number().nullable().optional(),
  leaver_status: z.number().nullable().optional(),
  abandons: z.number().nullable().optional(),
  gold_t: z.array(z.number()).nullable().optional(),
  lh_t: z.array(z.number()).nullable().optional(),
  xp_t: z.array(z.number()).nullable().optional(),
  deaths_log: z.array(deathSchema).nullable().optional(),
  kills_log: z.array(z.looseObject({ time: z.number(), key: z.string().optional() })).nullable().optional(),
  buyback_log: z.array(z.looseObject({ time: z.number() })).nullable().optional(),
  /** Rank medal ×10 + stars, e.g. 54 = Legend 4; null when the player hides it. */
  rank_tier: detail(z.number()),
  party_size: detail(z.number()),
  networth_t: detail(z.array(z.number())),
  /** Unspent gold at the end of the game. */
  gold: detail(z.number()),
  gold_spent: detail(z.number()),
  /** Gold by source (OpenDota gold reason ids: creeps, neutrals, kills, buildings…). */
  gold_reasons: detail(countsSchema),
  item_0: detail(z.number()),
  item_1: detail(z.number()),
  item_2: detail(z.number()),
  item_3: detail(z.number()),
  item_4: detail(z.number()),
  item_5: detail(z.number()),
  backpack_0: detail(z.number()),
  backpack_1: detail(z.number()),
  backpack_2: detail(z.number()),
  item_neutral: detail(z.number()),
  purchase_log: detail(z.array(z.looseObject({ time: z.number(), key: z.string() }))),
  item_uses: detail(countsSchema),
  obs_log: detail(z.array(wardSchema)),
  sen_log: detail(z.array(wardSchema)),
  obs_left_log: detail(z.array(wardSchema)),
  sen_left_log: detail(z.array(wardSchema)),
  connection_log: detail(z.array(z.looseObject({ time: z.number(), event: z.string().optional() }))),
});

export const matchSchema = z.looseObject({
  match_id: z.number(),
  /** Non-null once OpenDota has parsed the replay (detailed data available). */
  version: z.number().nullable().optional(),
  duration: z.number(),
  radiant_win: z.boolean().nullable(),
  game_mode: z.number().optional(),
  lobby_type: z.number().optional(),
  start_time: z.number().optional(),
  radiant_gold_adv: z.array(z.number()).nullable().optional(),
  radiant_xp_adv: detail(z.array(z.number())),
  patch: detail(z.number()),
  teamfights: detail(z.array(teamfightSchema)),
  /** First blood, buildings, Roshan, aegis, couriers… */
  objectives: detail(z.array(objectiveSchema)),
  /** Draft order; real bans only in ranked All Pick and Captains Mode. */
  picks_bans: detail(z.array(pickBanSchema)),
  players: z.array(playerSchema).length(10),
});

export type OdMatch = z.infer<typeof matchSchema>;
export type OdPlayer = z.infer<typeof playerSchema>;

export interface HeroInfo {
  id: number;
  name: string;
  localized_name: string;
}

export class MatchNotFoundError extends Error {
  override name = 'MatchNotFoundError';
}

const heroStatSchema = z.looseObject({
  id: z.number(),
  localized_name: z.string(),
  roles: z.array(z.string()).optional(),
  turbo_picks: z.number().nullable().optional(),
  turbo_wins: z.number().nullable().optional(),
  pro_pick: z.number().nullable().optional(),
  pro_win: z.number().nullable().optional(),
  pro_ban: z.number().nullable().optional(),
  // Plus "1_pick", "1_win" … "8_pick", "8_win": games and wins per rank bracket, see bracketStats().
});
export type HeroStat = z.infer<typeof heroStatSchema>;

const matchupSchema = z.looseObject({ hero_id: z.number(), games_played: z.number(), wins: z.number() });
export type HeroMatchup = z.infer<typeof matchupSchema>;

const playerHeroSchema = z.looseObject({
  hero_id: z.coerce.number(),
  games: z.number(),
  win: z.number(),
  last_played: z.number().optional(),
});
export type PlayerHero = z.infer<typeof playerHeroSchema>;

const itemConstantSchema = z.looseObject({
  id: z.number(),
  dname: z.string().optional(),
  cost: z.number().nullable().optional(),
});

export interface ItemInfo {
  id: number;
  /** As in purchase_log, e.g. "black_king_bar". */
  key: string;
  name: string;
  cost: number;
}

export interface ItemCatalog {
  byKey: Map<string, ItemInfo>;
  /** For the item_0…item_5 slots, which hold ids. */
  byId: Map<number, ItemInfo>;
}

/** Games and win rate of a hero in a rank bracket (1 Herald … 8 Immortal); null without games. */
export function bracketStats(stat: HeroStat, bracket: number): { games: number; winRate: number } | null {
  const games = Number((stat as Record<string, unknown>)[`${bracket}_pick`]);
  const wins = Number((stat as Record<string, unknown>)[`${bracket}_win`]);
  return Number.isFinite(games) && games > 0 && Number.isFinite(wins) ? { games, winRate: wins / games } : null;
}

export interface OpenDotaOptions {
  fetch?: typeof fetch;
  /** Injected for tests; real code waits for real. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Paid-tier key; without it the free tier applies (~60 requests/min, 3000/day). */
  apiKey?: string | null;
  /** Directory for cached reference data (hero stats, items…); null keeps it in memory only. */
  cacheDir?: string | null;
  now?: () => number;
}

/** Hero stats, matchups, items and a player's hero history change slowly. */
const REFERENCE_MAX_AGE_MS = 24 * 60 * 60_000;
/** A parse request counts as this many requests against the rate limit. */
const PARSE_REQUEST_COST = 10;
const RATE_LIMIT_WAIT_MS = 60_000;

/** Public OpenDota API (no key needed; free tier allows ~60 requests/min). */
export class OpenDotaClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly apiKey: string | null;
  private readonly cache: JsonCache;
  /** From the last response's rate-limit header; unknown until the first request. */
  private remainingThisMinute = Number.POSITIVE_INFINITY;

  constructor(options: OpenDotaOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => sleep(ms));
    this.apiKey = options.apiKey ?? null;
    this.cache = new JsonCache(options.cacheDir ?? null, options.now);
  }

  /**
   * Every OpenDota call goes through here: waits out the minute when the allowance left (from the
   * response headers) is below the call's cost, and retries once after a 429.
   */
  private async request(path: string, init: RequestInit = {}, cost = 1): Promise<Response> {
    const url = new URL(`${API_BASE}${path}`);
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    for (let attempt = 0; ; attempt++) {
      if (this.remainingThisMinute < cost) {
        await this.sleep(RATE_LIMIT_WAIT_MS);
        this.remainingThisMinute = Number.POSITIVE_INFINITY;
      }
      const response = await this.fetch(url.toString(), init);
      const remaining = response.headers.get('x-rate-limit-remaining-minute');
      if (remaining !== null && Number.isFinite(Number(remaining))) this.remainingThisMinute = Number(remaining);
      if (response.status !== 429 || attempt > 0) return response;
      this.remainingThisMinute = 0;
    }
  }

  private async getJson<T>(path: string, schema: z.ZodType<T>, what: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, signal ? { signal } : {});
    if (!response.ok) throw new Error(`OpenDota ${response.status} for ${what}`);
    const result = schema.safeParse(await response.json());
    if (!result.success) throw new Error(`Unexpected OpenDota ${what} format: ${z.prettifyError(result.error).slice(0, 300)}`);
    return result.data;
  }

  async getMatch(matchId: string, signal?: AbortSignal): Promise<OdMatch> {
    const response = await this.request(`/matches/${encodeURIComponent(matchId)}`, signal ? { signal } : {});
    if (response.status === 404) throw new MatchNotFoundError(`OpenDota has no match ${matchId} (yet)`);
    if (!response.ok) throw new Error(`OpenDota ${response.status} for match ${matchId}`);
    const result = matchSchema.safeParse(await response.json());
    if (!result.success) throw new Error(`Unexpected OpenDota match format: ${z.prettifyError(result.error).slice(0, 300)}`);
    return result.data;
  }

  /** Asks OpenDota to download and parse the replay. Safe to call repeatedly. */
  async requestParse(matchId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      `/request/${encodeURIComponent(matchId)}`,
      { method: 'POST', ...(signal ? { signal } : {}) },
      PARSE_REQUEST_COST,
    );
    if (!response.ok) throw new Error(`OpenDota parse request ${response.status} for match ${matchId}`);
  }

  /**
   * Returns the match once it is parsed, requesting a parse if needed. If parsing does not finish
   * within `timeoutMs`, returns whatever OpenDota has (basic stats), or throws if it has nothing.
   */
  async getParsedMatch(
    matchId: string,
    { timeoutMs = 15 * 60_000, pollMs = 60_000, signal }: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<OdMatch> {
    const deadline = Date.now() + timeoutMs;
    let requested = false;
    let latest: OdMatch | null = null;

    for (;;) {
      try {
        latest = await this.getMatch(matchId, signal);
        if (latest.version != null) return latest;
      } catch (err) {
        if (!(err instanceof MatchNotFoundError)) throw err;
      }
      if (!requested) {
        await this.requestParse(matchId, signal).catch(() => {});
        requested = true;
      }
      if (Date.now() + pollMs > deadline) break;
      await this.sleep(pollMs);
      signal?.throwIfAborted();
    }
    if (latest) return latest;
    throw new MatchNotFoundError(`OpenDota still has no data for match ${matchId}`);
  }

  async getHeroes(signal?: AbortSignal): Promise<Map<number, HeroInfo>> {
    const list = await this.cache.get('heroes', REFERENCE_MAX_AGE_MS, async () => {
      const response = await this.request('/heroes', signal ? { signal } : {});
      if (!response.ok) throw new Error(`OpenDota ${response.status} for heroes`);
      return (await response.json()) as HeroInfo[];
    });
    return new Map(list.map((h) => [h.id, h]));
  }

  /** Every hero's picks and wins per rank bracket, in Turbo and in pro games (the current meta). */
  async getHeroStats(signal?: AbortSignal): Promise<Map<number, HeroStat>> {
    const list = await this.cache.get('hero-stats', REFERENCE_MAX_AGE_MS, () =>
      this.getJson('/heroStats', z.array(heroStatSchema), 'hero stats', signal),
    );
    return new Map(list.map((h) => [h.id, h]));
  }

  /** How the hero fares against each other hero. A small sample of mostly high-level games: treat as weak evidence. */
  async getHeroMatchups(heroId: number, signal?: AbortSignal): Promise<HeroMatchup[]> {
    return this.cache.get(`matchups-${heroId}`, REFERENCE_MAX_AGE_MS, () =>
      this.getJson(`/heroes/${heroId}/matchups`, z.array(matchupSchema), `matchups of hero ${heroId}`, signal),
    );
  }

  /** Item names and costs, by purchase_log key and by inventory slot id. */
  async getItems(signal?: AbortSignal): Promise<ItemCatalog> {
    const raw = await this.cache.get('items', REFERENCE_MAX_AGE_MS, () =>
      this.getJson('/constants/items', z.record(z.string(), itemConstantSchema), 'items', signal),
    );
    const items = Object.entries(raw).map(([key, item]): ItemInfo => ({ id: item.id, key, name: item.dname ?? key, cost: item.cost ?? 0 }));
    return { byKey: new Map(items.map((i) => [i.key, i])), byId: new Map(items.map((i) => [i.id, i])) };
  }

  /** The player's games and wins on each hero; empty for a private profile. */
  async getPlayerHeroes(accountId: number, signal?: AbortSignal): Promise<PlayerHero[]> {
    return this.cache.get(`player-heroes-${accountId}`, REFERENCE_MAX_AGE_MS, () =>
      this.getJson(`/players/${accountId}/heroes`, z.array(playerHeroSchema), `heroes of player ${accountId}`, signal),
    );
  }
}

/** 64-bit Steam ID (from GSI) → 32-bit account id (used by OpenDota). */
export function steamIdToAccountId(steamId: string): number | null {
  try {
    const id = BigInt(steamId) - 76561197960265728n;
    return id > 0n && id < 2n ** 32n ? Number(id) : null;
  } catch {
    return null;
  }
}
