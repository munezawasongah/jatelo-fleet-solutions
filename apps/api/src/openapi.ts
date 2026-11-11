import { z } from 'zod';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export interface ResponseDoc {
  description: string;
  schema?: z.ZodType;
}
export interface RouteDoc {
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  auth: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  responses: Record<number, ResponseDoc>;
}

type Json = Record<string, unknown>;
const routes: RouteDoc[] = [];

export function registerDoc(doc: RouteDoc): void {
  routes.push(doc);
}

function jsonSchema(s: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

function parametersFor(where: 'path' | 'query', s?: z.ZodType): Json[] {
  if (!s || !(s instanceof z.ZodObject)) return [];
  return Object.entries(s.shape as Record<string, z.ZodType>).map(([name, field]) => ({
    name,
    in: where,
    required: where === 'path' || !field.safeParse(undefined).success,
    schema: jsonSchema(field, 'input'),
    ...(field.description ? { description: field.description } : {}),
  }));
}

function operationId(method: string, path: string): string {
  return (
    method +
    path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
  );
}

export function buildOpenApi(serverUrl: string, version: string): Json {
  const paths: Record<string, Json> = {};
  const tags = new Set<string>();
  for (const r of routes) {
    const p = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    r.tags.forEach((t) => tags.add(t));
    const responses: Json = {};
    for (const [code, resp] of Object.entries(r.responses)) {
      responses[code] = {
        description: resp.description,
        ...(resp.schema
          ? { content: { 'application/json': { schema: jsonSchema(resp.schema, 'output') } } }
          : {}),
      };
    }
    responses.default = {
      description: 'Error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
    const op: Json = {
      tags: r.tags,
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      operationId: operationId(r.method, p),
      parameters: [...parametersFor('path', r.params), ...parametersFor('query', r.query)],
      responses,
      security: r.auth ? [{ bearerAuth: [] }] : [],
    };
    if (r.body)
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(r.body, 'input') } },
      };
    paths[p] = { ...(paths[p] ?? {}), [r.method]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Jatelo Fleet Solutions API',
      version,
      description:
        'Multi-tenant fleet management API for Kenya, Tanzania, Uganda and Rwanda. All errors use the Error schema; ' +
        'every response carries an X-Request-Id header to quote when contacting support.',
      contact: { name: 'Jatelo Technologies', email: 'evans.onyango@jatelo-techs.com' },
    },
    servers: [{ url: serverUrl }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { Error: jsonSchema(ErrorBody, 'output') },
    },
  };
}
