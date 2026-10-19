import type { GameEvent } from './game/events.js';
import type { GsiPayload } from './gsi/schema.js';

export interface StatusSnapshot {
  lastGsiAt: number | null;
  payloadCount: number;
  matchId: string | null;
  gameState: string | null;
  activity: string | null;
  hero: string | null;
  kills: number | null;
  deaths: number | null;
  killStreak: number | null;
  lastEvent: { event: GameEvent; at: number } | null;
}

/** Shared, read-mostly runtime status for /status and logs. */
export class AppStatus {
  private snapshot: StatusSnapshot = {
    lastGsiAt: null,
    payloadCount: 0,
    matchId: null,
    gameState: null,
    activity: null,
    hero: null,
    kills: null,
    deaths: null,
    killStreak: null,
    lastEvent: null,
  };

  recordPayload(payload: GsiPayload, at: number): void {
    const s = this.snapshot;
    s.lastGsiAt = at;
    s.payloadCount += 1;
    s.matchId = payload.map?.matchid ?? null;
    s.gameState = payload.map?.game_state ?? null;
    s.activity = payload.player?.activity ?? null;
    s.hero = payload.hero?.name ?? null;
    s.kills = payload.player?.kills ?? null;
    s.deaths = payload.player?.deaths ?? null;
    s.killStreak = payload.player?.kill_streak ?? null;
  }

  recordEvent(event: GameEvent, at: number): void {
    this.snapshot.lastEvent = { event, at };
  }

  get(): Readonly<StatusSnapshot> {
    return this.snapshot;
  }
}
