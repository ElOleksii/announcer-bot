import { beforeEach, describe, expect, it } from 'vitest';
import { KillTracker, type KillTrackerOptions } from '../src/game/kill-tracker.js';
import { parseGsiPayload, type GsiPayload } from '../src/gsi/schema.js';
import { loadFixture, playing, type PlayingOverrides } from './helpers.js';

const options: KillTrackerOptions = {
  multikillWindowMs: 18_000,
  streakThresholds: { 3: 'killing_spree', 4: 'dominating', 5: 'mega_kill', 10: 'beyond_godlike' },
  announceDeaths: true,
};

function parse(raw: unknown): GsiPayload {
  const result = parseGsiPayload(raw);
  if (!result.ok) throw new Error(result.error);
  return result.payload;
}

describe('KillTracker', () => {
  let tracker: KillTracker;
  const feed = (overrides: PlayingOverrides = {}, nowMs = 0) => tracker.process(parse(playing(overrides)), nowMs);

  beforeEach(() => {
    tracker = new KillTracker(options);
  });

  describe('initialisation', () => {
    it('stays silent on the first payload of a match even with kills already on the board', () => {
      expect(feed({ kills: 7, kill_streak: 7 })).toBeNull();
      expect(tracker.getState()).toMatchObject({ matchId: '8123456789', stats: { kills: 7, killStreak: 7 } });
    });

    it('does not announce kills made before a mid-game reconnect, but announces the next one', () => {
      // App started (or Dota reconnected) at 10 minutes with 3 kills on the board.
      expect(feed({ kills: 3, kill_streak: 0, game_time: 600 })).toBeNull();
      expect(feed({ kills: 3, kill_streak: 0, game_time: 601 })).toBeNull();
      expect(feed({ kills: 4, kill_streak: 1, game_time: 640 })).toEqual({ kind: 'kill', sound: 'kill' });
    });

    it('resets fully on a new matchid without playing a sound', () => {
      feed({ kills: 3, kill_streak: 0, game_time: 600 });
      feed({ kills: 4, kill_streak: 1, game_time: 610 });

      expect(feed({ matchid: '999', kills: 0, kill_streak: 0, game_time: 0 })).toBeNull();
      expect(tracker.getState()).toEqual({
        matchId: '999',
        stats: { kills: 0, deaths: 1, killStreak: 0 },
        chain: 0,
        lastKillAt: null,
      });
      // The chain from the old match must not leak: game_time 5 is within 18s of nothing.
      expect(feed({ matchid: '999', kills: 1, kill_streak: 1, game_time: 5 })).toEqual({ kind: 'kill', sound: 'kill' });
    });

    it('ignores payloads without a match (main menu)', () => {
      expect(tracker.process(parse(loadFixture('menu')), 0)).toBeNull();
      expect(tracker.getState().matchId).toBeNull();
    });
  });

  describe('kill', () => {
    it('announces a single kill', () => {
      feed({ kills: 3, kill_streak: 0, game_time: 600 });
      expect(feed({ kills: 4, kill_streak: 1, game_time: 630 })).toEqual({ kind: 'kill', sound: 'kill' });
    });

    it('announces nothing when kills do not change', () => {
      feed({ kills: 3, game_time: 600 });
      expect(feed({ kills: 3, game_time: 601 })).toBeNull();
    });

    it('does not chain kills that are further apart than the window', () => {
      feed({ kills: 3, kill_streak: 0, game_time: 600 });
      feed({ kills: 4, kill_streak: 1, game_time: 610 });
      expect(feed({ kills: 5, kill_streak: 2, game_time: 628.5 })).toEqual({ kind: 'kill', sound: 'kill' });
    });
  });

  describe('multikill', () => {
    beforeEach(() => {
      feed({ kills: 3, kill_streak: 0, game_time: 600 });
    });

    it('detects a double kill within the window', () => {
      expect(feed({ kills: 4, kill_streak: 1, game_time: 610 })?.kind).toBe('kill');
      expect(feed({ kills: 5, kill_streak: 2, game_time: 627 })).toEqual({ kind: 'multikill', count: 2, sound: 'double_kill' });
    });

    it('chains kills: each kill extends the window from the previous one', () => {
      const events = [610, 625, 640, 655].map((t, i) => feed({ kills: 4 + i, kill_streak: 1, game_time: t }));
      expect(events.map((e) => e?.sound)).toEqual(['kill', 'double_kill', 'triple_kill', 'ultra_kill']);
    });

    it('caps at rampage', () => {
      const events = [610, 611, 612, 613, 614, 615].map((t, i) => feed({ kills: 4 + i, kill_streak: 1, game_time: t }));
      expect(events.map((e) => e?.sound)).toEqual(['kill', 'double_kill', 'triple_kill', 'ultra_kill', 'rampage', 'rampage']);
    });

    it('uses game time, so a long pause between two kills still counts as a double kill', () => {
      feed({ kills: 4, kill_streak: 1, game_time: 610 }, 0);
      // Five real minutes later, but the game was paused: game_time moved 5s.
      expect(feed({ kills: 5, kill_streak: 2, game_time: 615 }, 300_000)?.sound).toBe('double_kill');
    });

    it('falls back to the wall clock when game_time is missing', () => {
      const withoutTime = (kills: number) => {
        const raw = playing({ kills, kill_streak: 0 });
        delete (raw.map as Record<string, unknown>).game_time;
        return parse(raw);
      };
      expect(tracker.process(withoutTime(4), 1_000)?.sound).toBe('kill');
      expect(tracker.process(withoutTime(5), 5_000)?.sound).toBe('double_kill');
      expect(tracker.process(withoutTime(6), 60_000)?.sound).toBe('kill');
    });
  });

  describe('several kills in one payload', () => {
    beforeEach(() => {
      feed({ kills: 3, kill_streak: 0, game_time: 600 });
    });

    it.each([
      [2, 'double_kill'],
      [3, 'triple_kill'],
      [4, 'ultra_kill'],
      [5, 'rampage'],
      [6, 'rampage'],
    ])('a jump of %i kills plays a single %s', (jump, sound) => {
      expect(feed({ kills: 3 + jump, kill_streak: jump, game_time: 700 })).toMatchObject({ kind: 'multikill', sound });
    });

    it('adds the jump to an existing chain', () => {
      feed({ kills: 4, kill_streak: 1, game_time: 700 });
      expect(feed({ kills: 6, kill_streak: 3, game_time: 705 })).toEqual({ kind: 'multikill', count: 3, sound: 'triple_kill' });
    });
  });

  describe('streak', () => {
    it('announces a streak when kill_streak reaches a threshold', () => {
      feed({ kills: 3, kill_streak: 2, game_time: 600 });
      expect(feed({ kills: 4, kill_streak: 3, game_time: 700 })).toEqual({ kind: 'streak', streak: 3, sound: 'killing_spree' });
      expect(feed({ kills: 5, kill_streak: 4, game_time: 800 })).toEqual({ kind: 'streak', streak: 4, sound: 'dominating' });
    });

    it('does not repeat or announce non-threshold streak values', () => {
      feed({ kills: 3, kill_streak: 5, game_time: 600 });
      expect(feed({ kills: 4, kill_streak: 6, game_time: 700 })?.kind).toBe('kill');
    });

    it('multikill wins over a streak reached by the same kill', () => {
      feed({ kills: 2, kill_streak: 1, game_time: 590 });
      expect(feed({ kills: 3, kill_streak: 2, game_time: 600 })?.kind).toBe('kill');
      expect(feed({ kills: 4, kill_streak: 3, game_time: 605 })).toMatchObject({ kind: 'multikill', sound: 'double_kill' });
    });

    it('picks the highest threshold crossed in a single jump when it is not a multikill', () => {
      // Defensive: kill_streak may move by more than the kill delta between two payloads.
      feed({ kills: 3, kill_streak: 3, game_time: 600 });
      expect(feed({ kills: 4, kill_streak: 5, game_time: 700 })).toEqual({ kind: 'streak', streak: 5, sound: 'mega_kill' });
    });

    it('announces the streak again after it was reset by a death', () => {
      feed({ kills: 3, deaths: 1, kill_streak: 2, game_time: 600 });
      expect(feed({ kills: 4, deaths: 1, kill_streak: 3, game_time: 700 })?.sound).toBe('killing_spree');
      feed({ kills: 4, deaths: 2, kill_streak: 0, game_time: 800 });
      feed({ kills: 5, deaths: 2, kill_streak: 1, game_time: 900 });
      feed({ kills: 6, deaths: 2, kill_streak: 2, game_time: 1000 });
      expect(feed({ kills: 7, deaths: 2, kill_streak: 3, game_time: 1100 })?.sound).toBe('killing_spree');
    });
  });

  describe('death', () => {
    it('announces a death when enabled', () => {
      feed({ deaths: 1, game_time: 600 });
      expect(feed({ deaths: 2, kill_streak: 0, game_time: 650 })).toEqual({ kind: 'death', sound: 'death' });
    });

    it('stays silent on death when disabled', () => {
      tracker = new KillTracker({ ...options, announceDeaths: false });
      feed({ deaths: 1, game_time: 600 });
      expect(feed({ deaths: 2, kill_streak: 0, game_time: 650 })).toBeNull();
    });

    it('a kill in the same payload as a death takes priority', () => {
      feed({ kills: 3, deaths: 1, kill_streak: 0, game_time: 600 });
      expect(feed({ kills: 4, deaths: 2, kill_streak: 0, game_time: 650 })?.kind).toBe('kill');
    });
  });

  describe('game state', () => {
    it('ignores kill changes outside GAME_IN_PROGRESS but keeps the baseline in sync', () => {
      feed({ kills: 3, game_time: 600 });
      expect(feed({ kills: 4, kill_streak: 1, game_state: 'DOTA_GAMERULES_STATE_POST_GAME', game_time: 610 })).toBeNull();
      // Back in progress: the kill above must not be announced late.
      expect(feed({ kills: 4, kill_streak: 1, game_time: 611 })).toBeNull();
    });

    it('ignores spectator payloads and does not touch the state', () => {
      feed({ kills: 3, game_time: 600 });
      const before = structuredClone(tracker.getState());
      expect(tracker.process(parse(loadFixture('spectating')), 0)).toBeNull();
      expect(tracker.getState()).toEqual(before);
    });

    it('does not announce when the first payload of a match comes from spectating', () => {
      const spectating = loadFixture('spectating');
      (spectating.map as Record<string, unknown>).matchid = '555';
      expect(tracker.process(parse(spectating), 0)).toBeNull();
      expect(feed({ matchid: '555', kills: 3, game_time: 600 })).toBeNull();
    });

    it('resyncs silently when counters go backwards', () => {
      feed({ kills: 5, deaths: 3, game_time: 600 });
      expect(feed({ kills: 2, deaths: 1, game_time: 601 })).toBeNull();
      expect(feed({ kills: 3, deaths: 1, kill_streak: 1, game_time: 700 })?.kind).toBe('kill');
    });
  });

  describe('invalid payload', () => {
    it('is rejected by the schema with a readable error', () => {
      const result = parseGsiPayload(loadFixture('invalid'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('game_time');
        expect(result.error).toContain('kills');
      }
    });

    it.each([null, 'text', 42, []])('rejects non-object body %j', (raw) => {
      expect(parseGsiPayload(raw).ok).toBe(false);
    });

    it('treats a payload with a partial player section as no-op', () => {
      feed({ kills: 3, game_time: 600 });
      const raw = playing({ kills: 4 });
      delete (raw.player as Record<string, unknown>).deaths;
      expect(tracker.process(parse(raw), 0)).toBeNull();
      expect(tracker.getState().stats?.kills).toBe(3);
    });
  });
});
