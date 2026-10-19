import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '../logger.js';
import { parseGsiPayload, type GsiPayload } from './schema.js';

export interface GsiServerOptions {
  token: string;
  logger: Logger;
  /** Called asynchronously after the HTTP response has been sent. */
  onPayload: (payload: GsiPayload) => void | Promise<void>;
}

export const GSI_HOST = '127.0.0.1';

export function createGsiServer({ token, logger, onPayload }: GsiServerOptions): FastifyInstance {
  const log = logger.child({ module: 'gsi' });
  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    // Dota posts several times per second; per-request logs would drown everything else.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
  });

  // Be lenient about Content-Type: parse any body as JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const error = new Error('Body is not valid JSON') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  const expected = Buffer.from(token);

  app.post('/', async (request, reply) => {
    const provided = extractToken(request.body);
    if (provided === null || !safeEqual(Buffer.from(provided), expected)) {
      log.warn({ ip: request.ip }, 'rejected GSI request with missing or wrong auth token');
      return reply.code(401).send();
    }

    const body: unknown = request.body;
    // Answer immediately; Dota waits for the response before sending the next update.
    setImmediate(() => {
      const result = parseGsiPayload(body);
      if (!result.ok) {
        log.warn({ error: result.error }, 'ignoring invalid GSI payload');
        return;
      }
      Promise.resolve()
        .then(() => onPayload(result.payload))
        .catch((err: unknown) => log.error({ err }, 'error while handling GSI payload'));
    });
    return reply.code(200).send();
  });

  return app;
}

export async function startGsiServer(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ host: GSI_HOST, port });
}

function extractToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const auth = (body as { auth?: unknown }).auth;
  if (typeof auth !== 'object' || auth === null) return null;
  const token = (auth as { token?: unknown }).token;
  return typeof token === 'string' ? token : null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
