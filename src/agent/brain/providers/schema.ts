/**
 * Tool parameter schemas per provider. OpenAI, Anthropic and OpenAI-compatible servers take
 * JSON Schema as is; Gemini's function declarations accept an OpenAPI subset, so unsupported
 * keywords are dropped and non-string enums removed.
 */
import type { JsonSchema } from '../../tools/types';

/** Root object schema with `properties` always present (some servers require it). */
export function jsonSchemaFor(schema: JsonSchema): Record<string, unknown> {
  const root = (schema.type === 'object' || schema.type === undefined ? schema : { type: 'object', properties: {} }) as Record<string, unknown>;
  return { ...root, type: 'object', properties: (root.properties as Record<string, unknown> | undefined) ?? {} };
}

export function geminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = schema.type ?? (schema.properties ? 'object' : undefined);
  if (type && type !== 'null') out.type = type;
  if (schema.description) out.description = schema.description;
  if (schema.enum && schema.enum.length > 0 && (type === 'string' || type === undefined)) {
    out.enum = schema.enum.map(value => String(value));
    out.type = 'string';
  }
  if (typeof schema.minimum === 'number' && (type === 'number' || type === 'integer')) out.minimum = schema.minimum;
  if (typeof schema.maximum === 'number' && (type === 'number' || type === 'integer')) out.maximum = schema.maximum;
  if (schema.items) out.items = geminiSchema(schema.items);
  else if (type === 'array') out.items = { type: 'string' };
  if (type === 'object' || schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) properties[key] = geminiSchema(value);
    out.properties = properties;
    const required = (schema.required ?? []).filter(key => key in properties);
    if (required.length > 0) out.required = required;
  }
  return out;
}
