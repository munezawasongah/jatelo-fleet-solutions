import { useQuery } from '@tanstack/react-query';
import { API_BASE } from './api';

/** Minimal JSON-schema view of the API's OpenAPI document, used to render forms that always match the API. */
export interface JsonSchema {
  type?: string | string[];
  enum?: (string | number)[];
  const?: unknown;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  default?: unknown;
}
interface OpenApi {
  paths: Record<string, Record<string, { requestBody?: { content: { 'application/json'?: { schema: JsonSchema } } } }>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export function useOpenApi(): OpenApi | undefined {
  return useQuery({
    queryKey: ['openapi'],
    queryFn: async () => (await fetch(`${API_BASE}/api/openapi.json`)).json() as Promise<OpenApi>,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
}

function resolve(doc: OpenApi, s: JsonSchema | undefined): JsonSchema | undefined {
  if (!s) return s;
  if (s.$ref) return resolve(doc, doc.components?.schemas?.[s.$ref.split('/').pop()!]);
  return s;
}

/** Collapses nullable unions (anyOf [X, null]) into X with a nullable flag. */
export function unwrap(doc: OpenApi, s: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const r = resolve(doc, s)!;
  const alts = r.anyOf ?? r.oneOf;
  if (alts) {
    const nonNull = alts.map((a) => resolve(doc, a)!).filter((a) => a.type !== 'null');
    return { schema: nonNull[0] ?? {}, nullable: nonNull.length < alts.length };
  }
  if (Array.isArray(r.type)) return { schema: { ...r, type: r.type.find((t) => t !== 'null') }, nullable: r.type.includes('null') };
  return { schema: r, nullable: false };
}

/** Request body schema for e.g. ('post', '/vehicles') or ('patch', '/vehicles/{id}'). */
export function bodySchema(doc: OpenApi | undefined, method: string, path: string): JsonSchema | undefined {
  if (!doc) return undefined;
  const op = doc.paths[`/api/v1${path}`]?.[method];
  const s = resolve(doc, op?.requestBody?.content['application/json']?.schema);
  if (!s?.properties) return s;
  const properties: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(s.properties)) properties[k] = resolve(doc, v)!;
  return { ...s, properties };
}

export type OpenApiDoc = OpenApi;
