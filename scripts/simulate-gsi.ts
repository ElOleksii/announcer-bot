/**
 * Sends fake Dota 2 GSI requests to the running app, so you can test without the game.
 *
 *   npm run simulate                       → list scenarios
 *   npm run simulate -- double             → run one scenario
 *   npm run simulate -- all --delay 2500   → run every scenario, 2.5s between requests
 *
 * Every scenario starts a fresh match (random matchid), so its first request only
 * initialises the tracker and is expected to be silent.
 */
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ConfigError, loadDotEnv, loadGsiConfig } from '../src/config/env.js';

interface Step {
  kills?: number;
  deaths?: number;
  streak?: number;
  /** Game time in seconds; drives the multikill window. */
  t: number;
  state?: string;
  spectating?: boolean;
  token?: string;
  raw?: unknown;
  note: string;
}

interface Scenario {
  description: string;
  steps: Step[];
}

const POST_GAME = 'DOTA_GAMERULES_STATE_POST_GAME';

const init = (kills = 0, deaths = 0, streak = 0, t = 600): Step => ({ kills, deaths, streak, t, note: `init: ${kills} kills (silent)` });

const scenarios: Record<string, Scenario> = {
  kill: {
    description: 'one kill',
    steps: [init(), { kills: 1, streak: 1, t: 620, note: 'kill' }],
  },
  double: {
    description: 'two kills 6s apart',
    steps: [init(), { kills: 1, streak: 1, t: 620, note: 'kill' }, { kills: 2, streak: 2, t: 626, note: 'double_kill' }],
  },
  rampage: {
    description: 'five kills chained within the window',
    steps: [
      init(),
      { kills: 1, streak: 1, t: 620, note: 'kill' },
      { kills: 2, streak: 2, t: 625, note: 'double_kill' },
      { kills: 3, streak: 3, t: 630, note: 'triple_kill' },
      { kills: 4, streak: 4, t: 640, note: 'ultra_kill' },
      { kills: 5, streak: 5, t: 650, note: 'rampage' },
    ],
  },
  jump2: {
    description: 'kills grow by 2 in a single payload',
    steps: [init(3), { kills: 5, streak: 2, t: 620, note: 'double_kill (one sound)' }],
  },
  jump3: {
    description: 'kills grow by 3 in a single payload',
    steps: [init(3), { kills: 6, streak: 3, t: 620, note: 'triple_kill (one sound)' }],
  },
  streak: {
    description: 'kill streak reaches 3, then 4, kills far apart',
    steps: [
      init(2, 0, 2),
      { kills: 3, streak: 3, t: 700, note: 'killing_spree' },
      { kills: 4, streak: 4, t: 800, note: 'dominating' },
    ],
  },
  death: {
    description: 'you die (audible only with ANNOUNCE_DEATHS=true)',
    steps: [init(2, 1, 2), { kills: 2, deaths: 2, streak: 0, t: 700, note: 'death' }],
  },
  'new-match': {
    description: 'a kill, then a new matchid with kills already on the board',
    steps: [
      init(),
      { kills: 1, streak: 1, t: 620, note: 'kill' },
      { kills: 4, streak: 4, t: 900, note: 'NEW MATCH with 4 kills (silent)', raw: 'new-match' },
    ],
  },
  reconnect: {
    description: 'app sees the match for the first time with 7 kills, then you get one more',
    steps: [init(7, 2, 3, 1500), { kills: 7, streak: 3, deaths: 2, t: 1501, note: 'nothing new (silent)' }, { kills: 8, deaths: 2, streak: 4, t: 1530, note: 'dominating' }],
  },
  postgame: {
    description: 'kill counter changes after the game ended',
    steps: [init(), { kills: 1, streak: 1, t: 620, state: POST_GAME, note: 'post-game (silent)' }],
  },
  spectate: {
    description: 'spectator payloads are ignored',
    steps: [
      { t: 600, spectating: true, note: 'spectating (silent)' },
      { t: 610, spectating: true, note: 'spectating (silent)' },
    ],
  },
  'bad-token': {
    description: 'wrong auth token → 401',
    steps: [{ kills: 0, t: 600, token: 'definitely-wrong-token', note: 'expect 401' }],
  },
  invalid: {
    description: 'authenticated but malformed payload → 200, warning in app log',
    steps: [{ t: 600, raw: 'invalid', note: 'expect 200 + "ignoring invalid GSI payload"' }],
  },
};

function buildPayload(step: Step, matchId: string, token: string): unknown {
  if (step.raw === 'invalid') {
    return {
      provider: { name: 'Dota 2', appid: 570 },
      map: { matchid: matchId, game_time: 'ten minutes', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
      player: { activity: 'playing', kills: -1, deaths: 0 },
      auth: { token },
    };
  }

  const map = {
    name: 'start',
    matchid: matchId,
    game_time: step.t,
    clock_time: step.t - 90,
    game_state: step.state ?? 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    paused: false,
  };
  const player = step.spectating
    ? {
        team2: { player0: { name: 'radiant', activity: 'playing', kills: 4, deaths: 1, kill_streak: 3 } },
        team3: { player5: { name: 'dire', activity: 'playing', kills: 1, deaths: 4, kill_streak: 0 } },
      }
    : {
        steamid: '76561198000000000',
        name: 'simulator',
        activity: 'playing',
        kills: step.kills ?? 0,
        deaths: step.deaths ?? 0,
        assists: 0,
        kill_streak: step.streak ?? 0,
      };

  return {
    provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: Math.floor(Date.now() / 1000) },
    map,
    player,
    hero: { id: 1, name: 'npc_dota_hero_antimage', alive: true },
    auth: { token: step.token ?? token },
  };
}

async function run(name: string, scenario: Scenario, url: string, token: string, delayMs: number): Promise<void> {
  console.log(`\n▶ ${name}: ${scenario.description}`);
  let matchId = String(randomInt(1e9, 9e9));
  for (const [i, step] of scenario.steps.entries()) {
    if (step.raw === 'new-match') matchId = String(randomInt(1e9, 9e9));
    if (i > 0) await sleep(delayMs);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload(step, matchId, token)),
    });
    console.log(`  [${res.status}] t=${step.t}s  ${step.note}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      delay: { type: 'string', default: '1500' },
      url: { type: 'string' },
    },
  });

  const name = positionals[0];
  if (!name || (name !== 'all' && !(name in scenarios))) {
    if (name) console.error(`Unknown scenario "${name}".\n`);
    console.log('Usage: npm run simulate -- <scenario|all> [--delay ms] [--url http://127.0.0.1:3000/]\n');
    for (const [key, s] of Object.entries(scenarios)) console.log(`  ${key.padEnd(10)} ${s.description}`);
    process.exitCode = name ? 1 : 0;
    return;
  }

  loadDotEnv();
  const gsi = loadGsiConfig();
  const url = values.url ?? `http://127.0.0.1:${gsi.port}/`;
  const delayMs = Number(values.delay);

  const selected = name === 'all' ? Object.entries(scenarios) : [[name, scenarios[name]!] as const];
  for (const [key, scenario] of selected) {
    await run(key, scenario, url, gsi.token, delayMs);
    if (name === 'all') await sleep(Math.max(delayMs, 3000));
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else if (err instanceof TypeError && String(err.cause).includes('ECONNREFUSED')) {
    console.error('Cannot reach the GSI server. Is the app running (npm run dev)?');
  } else console.error(err);
  process.exitCode = 1;
});
