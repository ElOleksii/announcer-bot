import { GAME_IN_PROGRESS, type GsiPayload } from '../gsi/schema.js';
import { MULTIKILL_SOUNDS, type GameEvent, type MultikillCount, type SoundKey } from './events.js';

export interface KillTrackerOptions {
  /** Max gap between consecutive kills that still counts as one multikill chain. */
  multikillWindowMs: number;
  /** kill_streak value → sound key, e.g. { 3: 'killing_spree', 10: 'beyond_godlike' }. */
  streakThresholds: Readonly<Record<number, SoundKey>>;
  announceDeaths: boolean;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  killStreak: number;
}

export interface TrackerState {
  matchId: string | null;
  /** null until the first playable payload of the match has been seen. */
  stats: PlayerStats | null;
  /** Length of the current multikill chain. */
  chain: number;
  /** Time of the last kill in ms (game time when available, wall clock otherwise). */
  lastKillAt: number | null;
}

const MAX_MULTIKILL = 5;

/**
 * Pure state machine turning a stream of GSI payloads into announcer events.
 * No I/O: the caller supplies the wall-clock fallback via `nowMs`.
 */
export class KillTracker {
  private state: TrackerState = { matchId: null, stats: null, chain: 0, lastKillAt: null };
  private readonly thresholds: ReadonlyArray<readonly [number, SoundKey]>;

  constructor(private readonly options: KillTrackerOptions) {
    this.thresholds = Object.entries(options.streakThresholds)
      .map(([streak, sound]) => [Number(streak), sound] as const)
      .filter(([streak]) => Number.isInteger(streak) && streak > 0)
      .sort((a, b) => a[0] - b[0]);
  }

  getState(): Readonly<TrackerState> {
    return this.state;
  }

  process(payload: GsiPayload, nowMs: number): GameEvent | null {
    const matchId = payload.map?.matchid;
    if (matchId === undefined) return null;

    // New match (or first payload since startup): reset, never announce.
    if (matchId !== this.state.matchId) {
      this.state = { matchId, stats: readStats(payload), chain: 0, lastKillAt: null };
      return null;
    }

    const current = readStats(payload);
    if (!current) return null; // spectating, or player section missing

    const previous = this.state.stats;
    this.state.stats = current;

    // First playable payload of this match: we may have reconnected mid-game.
    if (!previous) return null;

    // Outside the live game (pre-game, post-game) we only follow the numbers silently.
    if (payload.map?.game_state !== GAME_IN_PROGRESS) return null;

    const newKills = current.kills - previous.kills;
    const newDeaths = current.deaths - previous.deaths;

    // Counters went backwards: should not happen within a match, just resync.
    if (newKills < 0 || newDeaths < 0) {
      this.state.chain = 0;
      this.state.lastKillAt = null;
      return null;
    }

    if (newKills > 0) {
      const at = eventTimeMs(payload, nowMs);
      return this.onKills(newKills, at, previous.killStreak, current.killStreak);
    }

    if (newDeaths > 0 && this.options.announceDeaths) {
      return { kind: 'death', sound: 'death' };
    }

    return null;
  }

  private onKills(count: number, at: number, prevStreak: number, streak: number): GameEvent {
    const { lastKillAt } = this.state;
    const chained = lastKillAt !== null && at >= lastKillAt && at - lastKillAt <= this.options.multikillWindowMs;
    this.state.chain = (chained ? this.state.chain : 0) + count;
    this.state.lastKillAt = at;

    // Priority: multikill > streak > kill. Several kills in one payload yield one event.
    if (this.state.chain >= 2) {
      const level = Math.min(this.state.chain, MAX_MULTIKILL) as MultikillCount;
      return { kind: 'multikill', count: level, sound: MULTIKILL_SOUNDS[level] };
    }

    const crossed = this.thresholds.filter(([threshold]) => prevStreak < threshold && threshold <= streak).at(-1);
    if (crossed) {
      return { kind: 'streak', streak: crossed[0], sound: crossed[1] };
    }

    return { kind: 'kill', sound: 'kill' };
  }
}

function readStats(payload: GsiPayload): PlayerStats | null {
  const player = payload.player;
  if (!player || player.activity !== 'playing') return null;
  if (player.kills === undefined || player.deaths === undefined) return null;
  return { kills: player.kills, deaths: player.deaths, killStreak: player.kill_streak ?? 0 };
}

/** Game time stops during pauses, so prefer it over the wall clock. */
function eventTimeMs(payload: GsiPayload, nowMs: number): number {
  const gameTime = payload.map?.game_time;
  return gameTime === undefined ? nowMs : gameTime * 1000;
}
