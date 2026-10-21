import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

const API_BASE = 'https://api.opendota.com/api';

/** Lenient: every field beyond the basics is optional, because unparsed matches lack them. */
const deathSchema = z.looseObject({
  time: z.number(),
  key: z.string().optional(),
  gold_fed: z.number().optional(),
  time_dead: z.number().optional(),
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
  life_state_dead: z.number().nullable().optional(),
  leaver_status: z.number().nullable().optional(),
  abandons: z.number().nullable().optional(),
  gold_t: z.array(z.number()).nullable().optional(),
  lh_t: z.array(z.number()).nullable().optional(),
  xp_t: z.array(z.number()).nullable().optional(),
  deaths_log: z.array(deathSchema).nullable().optional(),
  kills_log: z.array(z.looseObject({ time: z.number(), key: z.string().optional() })).nullable().optional(),
  buyback_log: z.array(z.looseObject({ time: z.number() })).nullable().optional(),
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

export interface OpenDotaOptions {
  fetch?: typeof fetch;
  /** Injected for tests; real code waits for real. */
  sleep?: (ms: number) => Promise<unknown>;
}

/** Public OpenDota API (no key needed; free tier allows ~60 requests/min). */
export class OpenDotaClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private heroes: Map<number, HeroInfo> | null = null;

  constructor(options: OpenDotaOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => sleep(ms));
  }

  async getMatch(matchId: string, signal?: AbortSignal): Promise<OdMatch> {
    const response = await this.fetch(`${API_BASE}/matches/${encodeURIComponent(matchId)}`, signal ? { signal } : {});
    if (response.status === 404) throw new MatchNotFoundError(`OpenDota has no match ${matchId} (yet)`);
    if (!response.ok) throw new Error(`OpenDota ${response.status} for match ${matchId}`);
    const result = matchSchema.safeParse(await response.json());
    if (!result.success) throw new Error(`Unexpected OpenDota match format: ${z.prettifyError(result.error).slice(0, 300)}`);
    return result.data;
  }

  /** Asks OpenDota to download and parse the replay. Safe to call repeatedly. */
  async requestParse(matchId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetch(`${API_BASE}/request/${encodeURIComponent(matchId)}`, {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
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
    if (this.heroes) return this.heroes;
    const response = await this.fetch(`${API_BASE}/heroes`, signal ? { signal } : {});
    if (!response.ok) throw new Error(`OpenDota ${response.status} for heroes`);
    const list = (await response.json()) as HeroInfo[];
    this.heroes = new Map(list.map((h) => [h.id, h]));
    return this.heroes;
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
