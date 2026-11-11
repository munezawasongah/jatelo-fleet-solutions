import type { Request, RequestHandler, Response } from 'express';
import rlf from 'rate-limiter-flexible';
import type { RateLimiterRes } from 'rate-limiter-flexible';
import { redis } from '../infra/redis.js';
import { AppError } from './errors.js';

export interface RateLimitOptions {
  keyPrefix: string;
  points: number;
  durationSec: number;
  key?: (req: Request) => string;
}

function setHeaders(res: Response, limit: number, r: RateLimiterRes): void {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, r.remainingPoints)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(r.msBeforeNext / 1000)));
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const limiter = new rlf.RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:${opts.keyPrefix}`,
    points: opts.points,
    duration: opts.durationSec,
    insuranceLimiter: new rlf.RateLimiterMemory({
      points: opts.points,
      duration: opts.durationSec,
    }),
  });
  return async (req, res, next) => {
    const key = opts.key?.(req) ?? req.ip ?? 'unknown';
    try {
      setHeaders(res, opts.points, await limiter.consume(key));
      next();
    } catch (err) {
      if (err instanceof rlf.RateLimiterRes) {
        setHeaders(res, opts.points, err);
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.msBeforeNext / 1000))));
        next(new AppError(429, 'rate_limited', 'Too many requests, please slow down'));
        return;
      }
      next(err);
    }
  };
}
