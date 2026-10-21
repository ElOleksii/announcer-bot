/**
 * Collects real OpenDota matches for calibration and tests (ranked All Pick only).
 *
 *   npm run collect -- --count 40                        → parsed ranked matches into data/matches/
 *   npm run collect -- --account 123456789 --count 40    → that player's ranked matches instead
 *   npm run collect -- --match 9055254826 --fixture name → one match as it is now, into test/fixtures/name.json
 *
 * Recently parsed public matches are almost all Turbo, so candidates come from /publicMatches (or the
 * player's history) and get a parse request; the script waits until OpenDota has parsed them.
 * Everything saved is stripped of names and real account ids. Free tier: ~60 requests/min and
 * 3000/day, a parse request counts as 10; the script paces itself by the rate-limit headers.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const API = 'https://api.opendota.com/api';
const RANKED_LOBBY = 7;
const ALL_PICK = 22;
/** Shorter games are mostly early abandons: not useful for calibration. */
const MIN_DURATION_SEC = 15 * 60;
const REQUEST_GAP_MS = 1100;
const RECHECK_MS = 3 * 60_000;
const GIVE_UP_MS = 25 * 60_000;

type Json = Record<string, unknown>;

/** Never used by the analysis: cosmetics, chat, heatmaps, per-player copies of match info. */
const DROP_MATCH = ['cosmetics', 'chat', 'all_word_counts', 'my_word_counts', 'replay_url', 'replay_salt', 'metadata'];
const DROP_PLAYER = [
  'cosmetics',
  'lane_pos',
  'obs',
  'sen',
  'actions',
  'pings',
  'radiant_win',
  'start_time',
  'duration',
  'cluster',
  'lobby_type',
  'game_mode',
  'patch',
  'region',
  'is_subscriber',
  'is_contributor',
  'last_login',
];
/** Identifies real people. */
const PERSONAL = ['personaname', 'name', 'party_id', 'computed_mmr'];

/** A parse request costs 10 of the per-minute and daily allowance; keep room for one. */
const PARSE_REQUEST_COST = 10;
/** Stop before using up the day's allowance: the bot needs some too. */
const DAILY_RESERVE = 300;

let lastRequestAt = 0;
let remainingThisMinute = Number.POSITIVE_INFINITY;

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (remainingThisMinute <= PARSE_REQUEST_COST) {
      await sleep(60_000);
      remainingThisMinute = Number.POSITIVE_INFINITY;
    }
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const response = await fetch(`${API}${path}`, init);
    const minute = Number(response.headers.get('x-rate-limit-remaining-minute'));
    const day = Number(response.headers.get('x-rate-limit-remaining-day'));
    if (response.headers.has('x-rate-limit-remaining-minute') && Number.isFinite(minute)) remainingThisMinute = minute;
    if (response.headers.has('x-rate-limit-remaining-day') && day < DAILY_RESERVE) {
      throw new Error(`Only ${day} OpenDota requests left today; stopping to leave them for the bot.`);
    }
    if (response.status === 404) return null;
    if (response.status === 429 && attempt < 3) {
      console.warn('Rate limited, waiting a minute…');
      await sleep(60_000);
      continue;
    }
    if (!response.ok) throw new Error(`OpenDota ${response.status} for ${path}`);
    return response.json();
  }
}

/** Drops unused fields, names and real account ids (replaced by 1001…1010). */
function prune(match: Json): Json {
  const out: Json = { ...match };
  for (const key of DROP_MATCH) delete out[key];
  out.players = (match.players as Json[]).map((player, i) => {
    const p: Json = { ...player };
    for (const key of [...DROP_PLAYER, ...PERSONAL]) delete p[key];
    if (p.account_id != null) p.account_id = 1001 + i;
    return p;
  });
  return out;
}

const isRankedAllPick = (m: Json) => m.lobby_type === RANKED_LOBBY && m.game_mode === ALL_PICK;

/** Candidate match ids, newest first, until the source runs out. */
async function* candidates(account: string | undefined): AsyncGenerator<number> {
  if (account) {
    const list = (await api(`/players/${account}/matches?lobby_type=${RANKED_LOBBY}&game_mode=${ALL_PICK}&limit=500`)) as Json[] | null;
    for (const m of list ?? []) if (Number(m.duration) >= MIN_DURATION_SEC) yield Number(m.match_id);
    return;
  }
  let before: number | null = null;
  for (;;) {
    const page = (await api(`/publicMatches${before ? `?less_than_match_id=${before}` : ''}`)) as Json[] | null;
    if (!page?.length) return;
    for (const m of page) if (isRankedAllPick(m) && Number(m.duration) >= MIN_DURATION_SEC) yield Number(m.match_id);
    before = Math.min(...page.map((m) => Number(m.match_id)));
  }
}

async function collect(dir: string, count: number, account: string | undefined, timeoutMs: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const saved = new Set(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5))));
  const startSize = saved.size;
  /** Waiting for a parse: id → when the parse was requested and when we last looked. */
  const pending = new Map<number, { requestedAt: number; checkedAt: number }>();
  const source = candidates(account);
  let sourceDone = false;
  const deadline = Date.now() + timeoutMs;

  /** Fetches a match: saves it if parsed, requests a parse otherwise. */
  const check = async (id: number) => {
    const match = (await api(`/matches/${id}`)) as Json | null;
    const state = pending.get(id);
    if (!match || !isRankedAllPick(match) || Number(match.duration) < MIN_DURATION_SEC) {
      pending.delete(id);
      return;
    }
    if (match.version != null) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(prune(match)));
      saved.add(id);
      pending.delete(id);
      console.log(`saved ${id} (${saved.size - startSize}/${count})`);
      return;
    }
    if (!state) {
      await api(`/request/${id}`, { method: 'POST' });
      pending.set(id, { requestedAt: Date.now(), checkedAt: Date.now() });
    } else if (Date.now() - state.requestedAt > GIVE_UP_MS) {
      pending.delete(id);
    } else {
      state.checkedAt = Date.now();
    }
  };

  while (saved.size - startSize < count && Date.now() < deadline) {
    // Keep some spare candidates in flight: not every parse succeeds.
    while (!sourceDone && saved.size - startSize + pending.size < Math.ceil(count * 1.3)) {
      const next = await source.next();
      if (next.done) sourceDone = true;
      else if (!saved.has(next.value) && !pending.has(next.value)) await check(next.value);
    }
    if (pending.size === 0 && sourceDone) break;
    for (const [id, state] of [...pending]) {
      if (saved.size - startSize >= count) break;
      if (Date.now() - state.checkedAt >= RECHECK_MS) await check(id);
    }
    if (saved.size - startSize < count) {
      console.log(`${pending.size} matches waiting for a parse…`);
      await sleep(30_000);
    }
  }
  console.log(`Done: ${saved.size - startSize} new matches in ${dir} (${saved.size} in total).`);
}

async function saveFixture(matchId: string, name: string): Promise<void> {
  const match = (await api(`/matches/${encodeURIComponent(matchId)}`)) as Json | null;
  if (!match) throw new Error(`OpenDota has no match ${matchId}`);
  const target = resolve('test/fixtures', `${name}.json`);
  writeFileSync(target, `${JSON.stringify(prune(match), null, 1)}\n`);
  console.log(`Wrote ${target} (${match.version != null ? 'parsed' : 'not parsed'}, lobby ${match.lobby_type}, mode ${match.game_mode})`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '30' },
      account: { type: 'string' },
      out: { type: 'string', default: 'data/matches' },
      'timeout-min': { type: 'string', default: '40' },
      match: { type: 'string' },
      fixture: { type: 'string' },
    },
  });
  if (values.fixture || values.match) {
    if (!values.fixture || !values.match || !/^\d+$/.test(values.match)) throw new Error('Use --match <id> together with --fixture <name>');
    if (existsSync(resolve('test/fixtures', `${values.fixture}.json`))) console.warn(`Overwriting test/fixtures/${values.fixture}.json`);
    await saveFixture(values.match, values.fixture);
    return;
  }
  await collect(resolve(values.out), Number(values.count), values.account, Number(values['timeout-min']) * 60_000);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
