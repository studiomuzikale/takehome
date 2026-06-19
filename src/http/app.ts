import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { verifyAuthorizationHeader } from '../auth/hmac.js';
import { DomainError } from '../domain.js';
import { processAggregatorRequest } from '../processor.js';
import { getCasinoRtpReport, getUserRtpReport } from '../reports/rtp.js';
import { processRequestSchema, reportQuerySchema } from '../validation.js';

export type AppOptions = {
  logLevel?: string;
};

export function buildApp(pool: Pool, secret: string, options: AppOptions | string = {}): FastifyInstance {
  const normalizedOptions: AppOptions = typeof options === 'string' ? { logLevel: options } : options;
  const logLevel = normalizedOptions.logLevel ?? 'info';
  const app = Fastify({ logger: { level: logLevel } });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as unknown as { rawBody: Buffer }).rawBody = rawBody;
    try {
      const parsed = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
      done(null, parsed);
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (request.url === '/healthz') return;

    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifyAuthorizationHeader(request.headers.authorization, rawBody, secret)) {
      await reply.code(403).send({ error: 'Forbidden' });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.code(error.statusCode).send(error.payload);
      return;
    }

    if (error instanceof ZodError) {
      void reply.code(400).send({ error: 'Bad Request' });
      return;
    }

    request.log.error(error);
    void reply.code(500).send({ error: 'Internal Server Error' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/aggregator/takehome/process', async (request) => {
    const body = processRequestSchema.parse(request.body);
    return processAggregatorRequest(pool, body);
  });

  app.get('/reports/rtp/users', async (request) => {
    const query = reportQuerySchema.parse(request.query);
    return getUserRtpReport(pool, query);
  });

  app.get('/reports/rtp/casino', async (request) => {
    const query = reportQuerySchema.parse(request.query);
    return getCasinoRtpReport(pool, query);
  });

  return app;
}
