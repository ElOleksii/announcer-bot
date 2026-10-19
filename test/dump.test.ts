import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { PayloadDump } from '../src/gsi/dump.js';
import { parseGsiPayload, type GsiPayload } from '../src/gsi/schema.js';
import { playing, type PlayingOverrides } from './helpers.js';

const payload = (overrides: PlayingOverrides = {}): GsiPayload => {
  const result = parseGsiPayload(playing(overrides));
  if (!result.ok) throw new Error(result.error);
  return result.payload;
};

const setup = (options: { maxBytes?: number } = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), 'gsi-dump-')), 'dump.ndjson');
  const dump = new PayloadDump({ file, logger: pino({ level: 'silent' }), ...options });
  const lines = () =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { reason: string; payload: Record<string, unknown> });
  return { dump, lines };
};

describe('PayloadDump', () => {
  it('writes when kills or deaths change, plus periodic snapshots', async () => {
    const { dump, lines } = setup();
    dump.record(payload({ kills: 3 }), 0); // first: change
    dump.record(payload({ kills: 3 }), 100); // same, too soon: skipped
    dump.record(payload({ kills: 4 }), 200); // change
    dump.record(payload({ kills: 4 }), 30_300); // snapshot
    await dump.close();
    expect(lines().map((l) => l.reason)).toEqual(['change', 'change', 'snapshot']);
  });

  it('never writes the auth token but keeps unknown sections', async () => {
    const { dump, lines } = setup();
    const raw = { ...playing(), events: [{ event_type: 'test' }] };
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    dump.record(parsed.payload, 0);
    await dump.close();
    const [line] = lines();
    expect(line?.payload).not.toHaveProperty('auth');
    expect(line?.payload).toHaveProperty('events');
    expect(JSON.stringify(line)).not.toContain('test-token');
  });

  it('stops at the size limit', async () => {
    const { dump, lines } = setup({ maxBytes: 3000 });
    for (let kills = 0; kills < 20; kills++) dump.record(payload({ kills }), kills);
    await dump.close();
    const count = lines().length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(20);
  });
});
