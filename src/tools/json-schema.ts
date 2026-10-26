/**
 * Minimal JSON-Schema subset used by the tool registry. The same schema
 * object is (a) sent to models for tool calling and (b) used to validate
 * model-produced arguments — a single source of truth, no converter.
 */

export type JSONSchema =
  | { type: 'object'; properties: Record<string, JSONSchema>; required?: string[]; additionalProperties?: false; description?: string }
  | { type: 'string'; description?: string; enum?: string[]; pattern?: string; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: JSONSchema; description?: string; minItems?: number; maxItems?: number };

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Structural validator for the subset above (depth/size bounded). */
export function validateAgainstSchema(value: unknown, schema: JSONSchema, path = '$', depth = 0): ValidationResult {
  const errors: string[] = [];
  if (depth > 12) {
    return { ok: false, errors: [`${path}: exceeds maximum nesting depth`] };
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        break;
      }
      const obj = value as Record<string, unknown>;
      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: missing required property`);
      }
      for (const [key, val] of Object.entries(obj)) {
        const propSchema = schema.properties[key];
        if (!propSchema) {
          if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
          continue;
        }
        if (val === undefined) continue;
        errors.push(...validateAgainstSchema(val, propSchema, `${path}.${key}`, depth + 1).errors);
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string`);
        break;
      }
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
        } catch {
          /* invalid pattern in a schema is a developer error, ignore */
        }
      }
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${path}: expected number`);
        break;
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateAgainstSchema(value[i], schema.items, `${path}[${i}]`, depth + 1).errors);
      }
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Parse model-provided argument JSON safely + validate. */
export function parseToolArguments(raw: string, schema: JSONSchema): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.length > 1_000_000) return { ok: false, error: 'Tool arguments exceed 1 MB.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return { ok: false, error: `Tool arguments are not valid JSON: ${raw.slice(0, 200)}` };
  }
  const result = validateAgainstSchema(parsed, schema);
  if (!result.ok) return { ok: false, error: result.errors.slice(0, 6).join('; ') };
  return { ok: true, value: parsed as Record<string, unknown> };
}
