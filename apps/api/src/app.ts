import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { rateLimit } from './http/rate-limit.js';
import { logger } from './logger.js';
import { buildOpenApi } from './openapi.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerV1Routes } from './routes/v1.js';
import { version } from './version.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.CORS_ORIGINS.includes(origin)),
      credentials: true,
      exposedHeaders: [
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  const health = express.Router();
  registerHealthRoutes(health);
  app.use(health);

  const v1 = express.Router();
  v1.use(rateLimit({ keyPrefix: 'global', points: config.RATE_LIMIT_PER_MINUTE, durationSec: 60 }));
  registerV1Routes(v1);
  app.use('/api/v1', v1);

  const spec = buildOpenApi(config.PUBLIC_API_URL, version);
  app.get('/api/openapi.json', (_req, res) => {
    res.json(spec);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: 'Jatelo Fleet Solutions API',
      swaggerOptions: { url: '/api/openapi.json', persistAuthorization: true },
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
