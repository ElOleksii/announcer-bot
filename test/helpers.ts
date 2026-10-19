import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadFixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

export interface PlayingOverrides {
  matchid?: string;
  game_time?: number;
  game_state?: string;
  kills?: number;
  deaths?: number;
  kill_streak?: number;
}

/** The `playing` fixture with selected fields replaced. Returns raw JSON, like the HTTP body. */
export function playing(overrides: PlayingOverrides = {}): Record<string, unknown> {
  const fixture = loadFixture('playing');
  const map = fixture.map as Record<string, unknown>;
  const player = fixture.player as Record<string, unknown>;
  for (const key of ['matchid', 'game_time', 'game_state'] as const) {
    if (overrides[key] !== undefined) map[key] = overrides[key];
  }
  for (const key of ['kills', 'deaths', 'kill_streak'] as const) {
    if (overrides[key] !== undefined) player[key] = overrides[key];
  }
  return fixture;
}
