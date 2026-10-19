import type { GameEvent } from '../game/events.js';
import type { GsiPayload } from '../gsi/schema.js';
import { heroDisplayName } from './hero-names.js';

export interface VictimInfo {
  /** GSI player id of the victim ("victimid_7" → "7"). The hero is not known to a player. */
  slot: string;
  /** How many times you have killed this player in the match, including this kill. */
  timesKilled: number;
}

/** Everything the commentator knows about a kill (or death). */
export interface KillContext {
  event: GameEvent;
  hero: string | null;
  heroLevel: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  killStreak: number | null;
  gameTimeSec: number | null;
  alive: boolean | null;
  healthPercent: number | null;
  /** Internal names of abilities/items that went on cooldown right before the event. */
  recentCasts: string[];
  victims: VictimInfo[];
}

/** How far back (game seconds) a cast or a kill_list change still counts for this event. */
const RECENT_WINDOW_SEC = 3;

interface Stamped<T> {
  value: T;
  at: number;
}

/**
 * Watches every payload to remember what was cast and whom you killed, then builds a
 * KillContext when the KillTracker emits an event. Reads the `abilities`, `items` and
 * `player.kill_list` sections defensively: their exact shape is not validated, so an
 * unexpected format only means less context, never a broken announcer.
 */
export class KillContextTracker {
  private matchId: string | null = null;
  private cooldowns = new Map<string, number>();
  private casts: Array<Stamped<string>> = [];
  private killList: Record<string, number> | null = null;
  private victimChanges: Array<Stamped<VictimInfo>> = [];

  observe(payload: GsiPayload, nowMs: number): void {
    const matchId = payload.map?.matchid ?? null;
    if (matchId !== this.matchId) {
      this.matchId = matchId;
      this.cooldowns.clear();
      this.casts = [];
      this.killList = null;
      this.victimChanges = [];
    }
    const at = timeSec(payload, nowMs);
    this.observeCooldowns(payload, at);
    this.observeKillList(payload, at);
    this.casts = this.casts.filter((c) => at - c.at <= RECENT_WINDOW_SEC);
    this.victimChanges = this.victimChanges.filter((v) => at - v.at <= RECENT_WINDOW_SEC);
  }

  build(event: GameEvent, payload: GsiPayload, nowMs: number): KillContext {
    const at = timeSec(payload, nowMs);
    const recent = <T>(items: Array<Stamped<T>>) => items.filter((i) => at - i.at <= RECENT_WINDOW_SEC).map((i) => i.value);
    const hero = asRecord(payload.hero);
    return {
      event,
      hero: heroDisplayName(payload.hero?.name),
      heroLevel: asNumber(hero?.level),
      kills: payload.player?.kills ?? null,
      deaths: payload.player?.deaths ?? null,
      assists: payload.player?.assists ?? null,
      killStreak: payload.player?.kill_streak ?? null,
      gameTimeSec: payload.map?.game_time ?? null,
      alive: payload.hero?.alive ?? null,
      healthPercent: asNumber(hero?.health_percent),
      recentCasts: [...new Set(recent(this.casts))],
      victims: recent(this.victimChanges),
    };
  }

  /** A cooldown that jumped up since the previous payload means the ability/item was just used. */
  private observeCooldowns(payload: GsiPayload, at: number): void {
    const raw = payload as Record<string, unknown>;
    for (const section of [raw.abilities, raw.items]) {
      for (const entry of Object.values(asRecord(section) ?? {})) {
        const item = asRecord(entry);
        const name = typeof item?.name === 'string' ? item.name : null;
        const cooldown = asNumber(item?.cooldown);
        if (!name || name === 'empty' || cooldown === null) continue;
        const previous = this.cooldowns.get(name);
        if (previous !== undefined && cooldown > previous + 0.5) this.casts.push({ value: name, at });
        this.cooldowns.set(name, cooldown);
      }
    }
  }

  private observeKillList(payload: GsiPayload, at: number): void {
    const list = asRecord(asRecord(payload.player)?.kill_list);
    if (!list) return;
    const current: Record<string, number> = {};
    for (const [key, value] of Object.entries(list)) {
      const count = asNumber(value);
      if (count !== null) current[key.replace(/^victimid_/, '')] = count;
    }
    if (this.killList) {
      for (const [slot, count] of Object.entries(current)) {
        if (count > (this.killList[slot] ?? 0)) this.victimChanges.push({ value: { slot, timesKilled: count }, at });
      }
    }
    this.killList = current;
  }
}

function timeSec(payload: GsiPayload, nowMs: number): number {
  return payload.map?.game_time ?? nowMs / 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
