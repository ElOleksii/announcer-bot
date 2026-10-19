import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../logger.js';
import type { AnalysisResult, MatchAnalyzer, MatchHint } from './analyzer.js';
import { MatchNotFoundError, type OdMatch, type OpenDotaClient } from './opendota.js';
import type { AnalysisTone } from './report.js';

/** Where a job shows its progress: the first update creates the message, later ones edit it. */
export interface AnalysisSink {
  update(text: string): Promise<void>;
  /** Link to the message, once it exists (for "already analysing" replies). */
  readonly url?: string | null;
}

export type JobState = 'waiting' | 'preliminary' | 'done' | 'not-found' | 'failed';

export interface JobTiming {
  /** How often to ask OpenDota for the match. */
  pollMs: number;
  /** How often to re-request a replay parse while the match is not parsed yet. */
  reparseMs: number;
  /** Give up when OpenDota still has no match at all after this long. */
  notFoundMs: number;
  /** Stop waiting for the parse; finish with basic stats if there are any. */
  deadlineMs: number;
}

export const DEFAULT_JOB_TIMING: JobTiming = {
  pollMs: 60_000,
  reparseMs: 3 * 60_000,
  notFoundMs: 10 * 60_000,
  deadlineMs: 20 * 60_000,
};

export interface AnalysisJobOptions {
  hint: MatchHint;
  tone: AnalysisTone;
  openDota: OpenDotaClient;
  analyzer: MatchAnalyzer;
  sink: AnalysisSink;
  logger: Logger;
  timing?: Partial<JobTiming>;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

export const jobTexts = {
  waiting: (matchId: string) =>
    `⏳ Матч \`${matchId}\` завершено. Чекаю на дані OpenDota — зазвичай 5–15 хв. Розбір з'явиться в цьому повідомленні.`,
  preliminary: (chatText: string) =>
    `⏳ _Попередній розбір за базовою статистикою. Оновлю, коли OpenDota розбере запис гри._\n${chatText}`,
  notFound: (matchId: string, afterMs: number) =>
    `❔ OpenDota так і не отримав матч \`${matchId}\` за ${minutes(afterMs)} хв. Ігри з ботами й приватні лобі туди не потрапляють.`,
  unknownTeam: (matchId: string) =>
    `❔ Не можу визначити, за яку команду ти грав у матчі \`${matchId}\` (приватний профіль?). Спробуй \`/analyze match_id:${matchId} team:…\`.`,
  failed: (matchId: string, message: string) => `⚠️ Не вийшло розібрати матч \`${matchId}\`: ${message}`,
};

/**
 * Follows one match from "game over" to a finished analysis:
 * - shows a "waiting" message right away (unless the full data is already there);
 * - replaces it with a preliminary analysis as soon as basic stats appear;
 * - re-requests the replay parse every few minutes and swaps in the full analysis when ready;
 * - gives up honestly when OpenDota never gets the match (bot games, lobbies).
 */
export class AnalysisJob {
  readonly matchId: string;
  readonly startedAt: number;
  private currentState: JobState = 'waiting';
  private readonly timing: JobTiming;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly log: Logger;

  constructor(private readonly options: AnalysisJobOptions) {
    this.matchId = options.hint.matchId;
    this.timing = { ...DEFAULT_JOB_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => sleep(ms));
    this.startedAt = this.now();
    this.log = options.logger.child({ module: 'analysis-job', matchId: this.matchId });
  }

  get state(): JobState {
    return this.currentState;
  }

  get url(): string | null {
    return this.options.sink.url ?? null;
  }

  async run(): Promise<JobState> {
    try {
      return await this.loop();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'analysis job failed');
      await this.show(jobTexts.failed(this.matchId, (err as Error).message)).catch(() => {});
      return (this.currentState = 'failed');
    }
  }

  private async loop(): Promise<JobState> {
    const { openDota } = this.options;
    let lastParseRequest = -Infinity;
    let posted = false;
    let lastBasic: OdMatch | null = null;
    let lastError: string | null = null;

    for (;;) {
      const elapsed = this.now() - this.startedAt;
      let match: OdMatch | null = null;
      try {
        match = await openDota.getMatch(this.matchId);
        lastError = null;
      } catch (err) {
        if (!(err instanceof MatchNotFoundError)) {
          lastError = (err as Error).message;
          this.log.warn({ err: lastError }, 'OpenDota request failed, will retry');
        }
      }

      if (match && match.version != null) {
        // Full data: final analysis with the Gemini verdict.
        return this.finish(await this.options.analyzer.analyzeMatch(match, this.options.hint, this.options.tone));
      }

      if (match) {
        lastBasic = match;
        if (this.currentState === 'waiting') {
          const preliminary = await this.options.analyzer.analyzeMatch(match, this.options.hint, this.options.tone, { useWriter: false });
          if (preliminary.kind === 'unknown-team') return this.end('failed', jobTexts.unknownTeam(this.matchId));
          if (preliminary.kind === 'ok') {
            await this.show(jobTexts.preliminary(preliminary.chatText));
            posted = true;
            this.currentState = 'preliminary';
            this.log.info('preliminary analysis posted, waiting for the replay parse');
          }
        }
      } else if (elapsed >= this.timing.notFoundMs && lastError === null) {
        return this.end('not-found', jobTexts.notFound(this.matchId, elapsed));
      }

      if (elapsed >= this.timing.deadlineMs) {
        if (lastBasic) {
          this.log.info('replay was not parsed in time, finishing with basic stats');
          return this.finish(await this.options.analyzer.analyzeMatch(lastBasic, this.options.hint, this.options.tone));
        }
        return this.end('failed', jobTexts.failed(this.matchId, lastError ?? 'OpenDota не відповідає'));
      }

      // Valve may not have published the replay yet when the game ends, so ask again periodically.
      if (this.now() - lastParseRequest >= this.timing.reparseMs) {
        lastParseRequest = this.now();
        await openDota.requestParse(this.matchId).catch((err: unknown) => this.log.debug({ err: (err as Error).message }, 'parse request failed'));
      }

      if (!posted) {
        await this.show(jobTexts.waiting(this.matchId));
        posted = true;
      }
      await this.sleep(this.timing.pollMs);
    }
  }

  private async finish(result: AnalysisResult): Promise<JobState> {
    if (result.kind === 'ok') {
      await this.show(result.chatText);
      this.log.info({ outcome: result.outcome, parsed: result.report.parsed }, 'analysis posted');
      return (this.currentState = 'done');
    }
    if (result.kind === 'unknown-team') return this.end('failed', jobTexts.unknownTeam(this.matchId));
    return this.end('not-found', jobTexts.notFound(this.matchId, this.now() - this.startedAt));
  }

  private async end(state: JobState, text: string): Promise<JobState> {
    await this.show(text);
    this.log.info({ state }, 'analysis job ended');
    return (this.currentState = state);
  }

  private show(text: string): Promise<void> {
    return this.options.sink.update(text);
  }
}

export const JOB_STATE_LABELS: Record<JobState, string> = {
  waiting: 'чекаю на дані OpenDota',
  preliminary: 'попередній розбір готовий, чекаю повних даних',
  done: 'готово',
  'not-found': 'OpenDota не має матчу',
  failed: 'помилка',
};
