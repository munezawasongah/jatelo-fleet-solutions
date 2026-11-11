import type { Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { registerDoc, type HttpMethod, type ResponseDoc } from '../openapi.js';

type Schema = z.ZodType;
type Out<T> = T extends Schema ? z.output<T> : undefined;

export interface RouteContext<P, Q, B> {
  req: Request;
  res: Response;
  params: Out<P>;
  query: Out<Q>;
  body: Out<B>;
}

export interface RouteDef<
  P extends Schema | undefined,
  Q extends Schema | undefined,
  B extends Schema | undefined,
> {
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  auth?: boolean;
  params?: P;
  query?: Q;
  body?: B;
  /** Success status when the handler returns a value (default 200; 204 when it returns undefined). */
  status?: number;
  responses: Record<number, ResponseDoc>;
  middleware?: RequestHandler[];
  handler: (ctx: RouteContext<P, Q, B>) => unknown;
}

/** Defines an endpoint once: validates input with zod, runs the handler, and documents it in OpenAPI. */
export function route<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
>(router: Router, basePath: string, def: RouteDef<P, Q, B>): void {
  registerDoc({
    method: def.method,
    path: `${basePath}${def.path}`,
    tags: def.tags,
    summary: def.summary,
    description: def.description,
    auth: def.auth ?? false,
    params: def.params,
    query: def.query,
    body: def.body,
    responses: def.responses,
  });

  const handler: RequestHandler = async (req, res) => {
    const ctx = {
      req,
      res,
      params: def.params ? def.params.parse(req.params) : undefined,
      query: def.query ? def.query.parse(req.query) : undefined,
      body: def.body ? def.body.parse(req.body ?? {}) : undefined,
    } as RouteContext<P, Q, B>;
    const result = await def.handler(ctx);
    if (res.headersSent) return;
    if (result === undefined) {
      res.status(def.status ?? 204).end();
      return;
    }
    res.status(def.status ?? 200).json(result);
  };

  const register = router[def.method] as (path: string, ...handlers: RequestHandler[]) => unknown;
  register.call(router, def.path, ...(def.middleware ?? []), handler);
}
