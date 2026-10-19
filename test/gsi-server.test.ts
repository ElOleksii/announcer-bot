import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { renderGsiCfg } from '../src/gsi/cfg.js';
import type { GsiPayload } from '../src/gsi/schema.js';
import { createGsiServer } from '../src/gsi/server.js';
import { loadFixture, playing } from './helpers.js';

const TOKEN = 'test-token';

describe('GSI server', () => {
  let app: FastifyInstance;
  let onPayload: ReturnType<typeof vi.fn<(payload: GsiPayload) => void>>;

  beforeEach(async () => {
    onPayload = vi.fn<(payload: GsiPayload) => void>();
    app = createGsiServer({ token: TOKEN, logger: pino({ level: 'silent' }), onPayload });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: unknown, contentType = 'application/json') =>
    app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': contentType },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('accepts a valid payload with 200 and handles it asynchronously', async () => {
    const res = await post(playing({ kills: 5 }));
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    expect(onPayload.mock.calls[0]?.[0].player?.kills).toBe(5);
  });

  it('responds before the handler runs', async () => {
    let handled = false;
    onPayload.mockImplementation(() => {
      handled = true;
    });
    const res = await post(playing());
    expect(res.statusCode).toBe(200);
    expect(handled).toBe(false);
    await vi.waitFor(() => expect(handled).toBe(true));
  });

  it('accepts bodies sent without a JSON content type', async () => {
    const res = await post(JSON.stringify(playing()), 'text/plain');
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['wrong token', { ...playing(), auth: { token: 'nope' } }],
    ['token with different length', { ...playing(), auth: { token: `${TOKEN}x` } }],
    ['missing auth', (({ auth: _auth, ...rest }) => rest)(playing())],
    ['non-string token', { ...playing(), auth: { token: 123 } }],
  ])('rejects %s with 401', async (_name, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(401);
    await new Promise((r) => setImmediate(r));
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await post('{not json');
    expect(res.statusCode).toBe(400);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('acknowledges an authenticated but invalid payload and drops it', async () => {
    const res = await post(loadFixture('invalid'));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('survives a handler that throws', async () => {
    onPayload.mockImplementation(() => {
      throw new Error('boom');
    });
    expect((await post(playing())).statusCode).toBe(200);
    expect((await post(playing())).statusCode).toBe(200);
    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(2));
  });

  it('only exposes POST /', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});

describe('renderGsiCfg', () => {
  it('renders uri, timings, data sections and token', () => {
    const cfg = renderGsiCfg({ port: 3123, token: 'abc_DEF-123' });
    expect(cfg).toContain('"uri"           "http://127.0.0.1:3123/"');
    for (const key of ['timeout', 'buffer', 'throttle', 'heartbeat']) expect(cfg).toMatch(new RegExp(`"${key}"\\s+"[\\d.]+"`));
    for (const key of ['provider', 'map', 'player', 'hero']) expect(cfg).toMatch(new RegExp(`"${key}"\\s+"1"`));
    expect(cfg).toContain('"token"     "abc_DEF-123"');
  });
});
