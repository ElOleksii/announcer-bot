import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { MatchAnalyzer, type MatchHint } from '../src/analysis/analyzer.js';
import { AnalysisJob, jobTexts, type AnalysisSink } from '../src/analysis/job.js';
import { OpenDotaClient } from '../src/analysis/opendota.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const parsed = fixture('opendota-match');
const unparsed = { ...parsed, version: null };
const silent = pino({ level: 'silent' });
const MIN = 60_000;

type Reply = 'missing' | 'basic' | 'parsed' | 'error';

/**
 * Runs a job against a scripted OpenDota: `replies[i]` answers the i-th match request
 * (the last one repeats). Time only moves when the job sleeps.
 */
async function runJob(replies: Reply[], hint: Partial<MatchHint> = {}) {
  let t = 0;
  let matchCalls = 0;
  const parseRequests: number[] = [];
  const updates: string[] = [];

  const fetchMock: typeof fetch = async (url, init) => {
    const href = String(url);
    if (init?.method === 'POST') {
      parseRequests.push(t);
      return new Response('{}');
    }
    if (href.endsWith('/heroes')) return new Response(JSON.stringify(fixture('opendota-heroes')));
    const reply = replies[Math.min(matchCalls++, replies.length - 1)];
    if (reply === 'missing') return new Response('{}', { status: 404 });
    if (reply === 'error') return new Response('oops', { status: 500 });
    return new Response(JSON.stringify(reply === 'parsed' ? parsed : unparsed));
  };

  const openDota = new OpenDotaClient({ fetch: fetchMock, sleep: async () => {} });
  const sink: AnalysisSink = {
    url: null,
    async update(text) {
      updates.push(text);
    },
  };
  const job = new AnalysisJob({
    hint: { matchId: '9047376255', accountId: null, heroId: null, team: 'dire', ...hint },
    tone: 'harsh',
    openDota,
    analyzer: new MatchAnalyzer({ openDota, writer: null, logger: silent }),
    sink,
    logger: silent,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  const state = await job.run();
  return { state, updates, parseRequests, elapsed: t };
}

describe('AnalysisJob', () => {
  it('posts the full analysis straight away when the match is already parsed', async () => {
    const { state, updates, parseRequests } = await runJob(['parsed']);
    expect(state).toBe('done');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('Розбір поразки');
    expect(parseRequests).toHaveLength(0);
  });

  it('waiting → preliminary → full, editing the same message', async () => {
    const { state, updates } = await runJob(['missing', 'missing', 'basic', 'basic', 'parsed']);
    expect(state).toBe('done');
    expect(updates[0]).toBe(jobTexts.waiting('9047376255'));
    expect(updates[1]).toContain('Попередній розбір');
    expect(updates[1]).toContain('Розбір поразки');
    expect(updates.at(-1)).toContain('Розбір поразки');
    expect(updates.at(-1)).not.toContain('Попередній розбір');
    expect(updates).toHaveLength(3);
  });

  it('re-requests the replay parse every few minutes', async () => {
    const { parseRequests } = await runJob(['basic', 'basic', 'basic', 'basic', 'basic', 'basic', 'basic', 'parsed']);
    // Polls every minute; asks at 0, 3 and 6 minutes.
    expect(parseRequests).toEqual([0, 3 * MIN, 6 * MIN]);
  });

  it('gives up with a clear message when OpenDota never gets the match', async () => {
    const { state, updates, elapsed, parseRequests } = await runJob(['missing']);
    expect(state).toBe('not-found');
    expect(updates.at(-1)).toContain('так і не отримав');
    expect(elapsed).toBe(10 * MIN);
    expect(parseRequests.length).toBeGreaterThan(1);
  });

  it('finishes with basic stats when the parse does not arrive by the deadline', async () => {
    const { state, updates, elapsed } = await runJob(['basic']);
    expect(state).toBe('done');
    expect(elapsed).toBe(20 * MIN);
    expect(updates[0]).toContain('Попередній розбір');
    expect(updates.at(-1)).not.toContain('Попередній розбір');
    expect(updates.at(-1)).toContain('OpenDota ще не розібрав запис');
  });

  it('reports when it cannot tell our team', async () => {
    const { state, updates } = await runJob(['basic'], { team: null, accountId: null, heroId: null });
    expect(state).toBe('failed');
    expect(updates.at(-1)).toContain('Не можу визначити');
  });

  it('rides out temporary OpenDota errors', async () => {
    const { state, updates } = await runJob(['error', 'error', 'parsed']);
    expect(state).toBe('done');
    expect(updates.at(-1)).toContain('Розбір поразки');
  });

  it('does not mistake persistent OpenDota errors for a missing match', async () => {
    const { state, updates, elapsed } = await runJob(['error']);
    expect(state).toBe('failed');
    expect(elapsed).toBe(20 * MIN);
    expect(updates.at(-1)).toContain('Не вийшло розібрати');
  });

  it('a failing sink ends the job as failed instead of hanging', async () => {
    let t = 0;
    const openDota = new OpenDotaClient({ fetch: async () => new Response(JSON.stringify(parsed)), sleep: async () => {} });
    const job = new AnalysisJob({
      hint: { matchId: '1', accountId: null, heroId: null, team: 'dire' },
      tone: 'harsh',
      openDota,
      analyzer: new MatchAnalyzer({ openDota, writer: null, logger: silent }),
      sink: {
        async update() {
          throw new Error('Missing Permissions');
        },
      },
      logger: silent,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(await job.run()).toBe('failed');
  });
});
