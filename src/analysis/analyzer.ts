import type { GeminiWriter } from '../commentary/gemini.js';
import { GAME_IN_PROGRESS, type GsiPayload } from '../gsi/schema.js';
import type { Logger } from '../logger.js';
import { computeBlame, findOurTeam, type BlameReport } from './blame.js';
import { computeMvp, type MvpReport } from './mvp.js';
import { MatchNotFoundError, steamIdToAccountId, type OpenDotaClient } from './opendota.js';
import {
  VERDICT_MAX_LENGTH,
  fallbackMvpVerdict,
  fallbackVerdict,
  formatChatReport,
  formatMvpChat,
  mvpSystemPrompt,
  mvpUserPrompt,
  verdictSystemPrompt,
  verdictUserPrompt,
  type AnalysisTone,
} from './report.js';

export interface MatchHint {
  matchId: string;
  /** OpenDota account id of the user (from GSI steamid). */
  accountId: number | null;
  heroId: number | null;
  /** Explicit team override, e.g. when the profile is private. */
  team?: 'radiant' | 'dire' | null;
}

export type AnalysisResult =
  | { kind: 'not-found' }
  | { kind: 'unknown-team' }
  | { kind: 'ok'; outcome: 'loss'; report: BlameReport; chatText: string; verdictText: string }
  | { kind: 'ok'; outcome: 'win'; report: MvpReport; chatText: string; verdictText: string };

export interface MatchAnalyzerOptions {
  openDota: OpenDotaClient;
  /** null → the built-in verdict text is used. */
  writer: GeminiWriter | null;
  logger: Logger;
}

const WRITER_TIMEOUT_MS = 40_000;

export class MatchAnalyzer {
  private readonly log: Logger;

  constructor(private readonly options: MatchAnalyzerOptions) {
    this.log = options.logger.child({ module: 'analysis' });
  }

  /**
   * Analyses a match for the chat: on a loss who is to blame, on a win who is the MVP.
   * Either way a points table plus a short verdict (Gemini or built-in).
   */
  async analyze(hint: MatchHint, tone: AnalysisTone, wait: { timeoutMs: number; pollMs: number }): Promise<AnalysisResult> {
    const { openDota } = this.options;
    let match;
    try {
      match = await openDota.getParsedMatch(hint.matchId, wait);
    } catch (err) {
      if (err instanceof MatchNotFoundError) return { kind: 'not-found' };
      throw err;
    }

    const ourRadiant =
      hint.team != null ? hint.team === 'radiant' : findOurTeam(match, { accountId: hint.accountId, heroId: hint.heroId });
    if (ourRadiant === null) return { kind: 'unknown-team' };
    if (match.radiant_win === null) return { kind: 'not-found' };
    const heroes = await openDota.getHeroes();
    const scores = (players: Array<{ hero: string; score: number }>) => players.map((p) => `${p.hero}:${p.score}`);

    if (match.radiant_win === ourRadiant) {
      const report = computeMvp(match, heroes, ourRadiant);
      this.log.info({ matchId: report.matchId, mvp: report.mvpSlots, scores: scores(report.players) }, 'win analysed');
      const verdictText = await this.writeVerdict(
        { system: mvpSystemPrompt(tone), user: mvpUserPrompt(report) },
        () => fallbackMvpVerdict(report, tone),
      );
      return { kind: 'ok', outcome: 'win', report, chatText: formatMvpChat(report, verdictText), verdictText };
    }

    const report = computeBlame(match, heroes, ourRadiant);
    this.log.info({ matchId: report.matchId, verdict: report.verdict, scores: scores(report.players) }, 'loss analysed');
    const verdictText = await this.writeVerdict(
      { system: verdictSystemPrompt(tone), user: verdictUserPrompt(report) },
      () => fallbackVerdict(report, tone),
    );
    return { kind: 'ok', outcome: 'loss', report, chatText: formatChatReport(report, verdictText), verdictText };
  }

  private async writeVerdict(prompt: { system: string; user: string }, fallback: () => string): Promise<string> {
    const { writer } = this.options;
    if (writer) {
      try {
        const text = await writer.complete({ ...prompt, maxLength: VERDICT_MAX_LENGTH, retries: 3 }, AbortSignal.timeout(WRITER_TIMEOUT_MS));
        this.log.info({ model: writer.lastModel }, 'verdict written by Gemini');
        return text;
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'Gemini verdict failed, using built-in text');
      }
    }
    return fallback();
  }
}

/**
 * Builds the hint for /analyze: the given match id (digits only) or the last match seen via GSI.
 * The account comes from GSI when available, else from PLAYER_STEAM_ID, so it also works after a restart.
 */
export function resolveMatchHint(
  args: { matchId: string | null; team: 'radiant' | 'dire' | null },
  last: MatchHint | null,
  defaultAccountId: number | null,
): MatchHint | null {
  const id = args.matchId ?? last?.matchId ?? null;
  if (!id || !/^\d+$/.test(id)) return null;
  const sameMatch = id === last?.matchId;
  return {
    matchId: id,
    accountId: last?.accountId ?? defaultAccountId,
    heroId: sameMatch ? last.heroId : null,
    team: args.team ?? (sameMatch ? (last.team ?? null) : null),
  };
}

const POST_GAME = 'DOTA_GAMERULES_STATE_POST_GAME';

/**
 * Watches GSI for the end of a match. Remembers the last match for /analyze and reports a loss
 * exactly once per match id.
 */
export class MatchEndWatcher {
  private last: MatchHint | null = null;
  private reported = new Set<string>();

  /** Returns a hint when this payload is the first one showing the match result (win or loss). */
  observe(payload: GsiPayload): MatchHint | null {
    const matchId = payload.map?.matchid;
    if (!matchId || matchId === '0') return null;

    const raw = payload as { player?: { team_name?: unknown }; map?: { win_team?: unknown } };
    const playing = payload.player?.activity === 'playing';
    if (playing) {
      this.last = {
        matchId,
        accountId: payload.player?.steamid ? steamIdToAccountId(payload.player.steamid) : (this.last?.accountId ?? null),
        heroId: typeof payload.hero?.id === 'number' && payload.hero.id > 0 ? payload.hero.id : (this.last?.heroId ?? null),
        team: teamName(raw.player?.team_name),
      };
    }

    if (payload.map?.game_state === GAME_IN_PROGRESS) return null;
    if (payload.map?.game_state !== POST_GAME || this.reported.has(matchId)) return null;
    const winner = teamName(raw.map?.win_team);
    const ours = this.last?.matchId === matchId ? this.last.team : null;
    if (!winner || !ours) return null;

    this.reported.add(matchId);
    return this.last;
  }

  lastMatch(): MatchHint | null {
    return this.last;
  }
}

function teamName(value: unknown): 'radiant' | 'dire' | null {
  return value === 'radiant' || value === 'dire' ? value : null;
}
