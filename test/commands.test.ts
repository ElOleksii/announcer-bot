import { describe, expect, it } from 'vitest';
import { buildCommands, formatStatus } from '../src/discord/commands.js';
import { AppStatus } from '../src/status.js';
import { parseGsiPayload } from '../src/gsi/schema.js';
import { playing } from './helpers.js';

describe('buildCommands', () => {
  it('defines join, leave, test (with event choices) and status', () => {
    const commands = buildCommands(['kill', 'double_kill']);
    expect(commands.map((c) => c.name)).toEqual(['join', 'leave', 'test', 'status', 'mode', 'say', 'analyze', 'autoanalyze']);
    const test = commands.find((c) => c.name === 'test');
    const option = test?.options?.[0] as { name: string; choices?: Array<{ value: string }> } | undefined;
    expect(option?.name).toBe('event');
    expect(option?.choices?.map((c) => c.value)).toEqual(['kill', 'double_kill']);
  });

  it('caps choices at 25', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const option = buildCommands(keys)[2]?.options?.[0] as { choices: unknown[] };
    expect(option.choices).toHaveLength(25);
  });
});

describe('formatStatus', () => {
  it('explains when no GSI data has arrived', () => {
    const text = formatStatus(new AppStatus().get(), null, 0);
    expect(text).toContain('no data received');
    expect(text).toContain('not connected');
  });

  it('shows match, hero, K/D and voice channel', () => {
    const status = new AppStatus();
    const parsed = parseGsiPayload(playing({ kills: 4, deaths: 2, kill_streak: 3 }));
    if (!parsed.ok) throw new Error(parsed.error);
    status.recordPayload(parsed.payload, 10_000);
    status.recordEvent({ kind: 'streak', streak: 3, sound: 'killing_spree' }, 10_000);

    const text = formatStatus(status.get(), '123', 15_000);
    expect(text).toContain('🟢 last update 5s ago');
    expect(text).toContain('`8123456789` · game in progress');
    expect(text).toContain('antimage · K/D 4 / 2 · streak 3');
    expect(text).toContain('killing_spree (streak 3), 5s ago');
    expect(text).toContain('<#123>');
  });

  it('flags stale GSI data', () => {
    const status = new AppStatus();
    status.recordPayload({}, 0);
    expect(formatStatus(status.get(), null, 120_000)).toContain('🟠');
  });
});
