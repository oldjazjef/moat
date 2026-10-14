import { z } from 'zod';
import { canonicalJson } from '../canonical/jcs';
import { MoatRejection, reject } from '../errors';
import {
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';

/**
 * Request validation (FR-13, SEC-20): a route's `body` lists the fields of the JSON object the
 * website sends — a closed list of types, no expression, no pattern from config. The gate keeps
 * only these fields (unknown ones are removed, at every level), refuses the request with 400
 * `body_invalid` when one does not fit, and forwards the canonical JSON (RFC 8785) of what it
 * kept. Every gate decides alike (conformance/vectors/http/body.json).
 */

export const BODY_FIELD_TYPES = [
  'string',
  'integer',
  'boolean',
  'object',
  'array',
] as const;
export type BodyFieldType = (typeof BODY_FIELD_TYPES)[number];

/** Field names as JSON APIs write them (`email`, `firstName`, `first_name`); ASCII only. */
export const BODY_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** At most this many fields in one body schema, nested ones included. */
export const MAX_BODY_FIELDS = 256;
/** At most this many fields in one object. */
export const MAX_OBJECT_FIELDS = 64;
/** Objects and arrays nest at most this deep below the body. */
export const MAX_BODY_DEPTH = 4;
export const MAX_STRING_LENGTH = 1_000_000;
export const MAX_ENUM_VALUES = 64;
export const MAX_ENUM_LENGTH = 256;
export const MAX_ARRAY_ITEMS = 1_000;
export const MAX_BODY_INTEGER = Number.MAX_SAFE_INTEGER;
export const STRING_FORMATS = ['email'] as const;

/**
 * `format: email`: ASCII local part and a DNS name with a letter-only top-level label, at most
 * 254 characters. Deliberately plain: a gate checks the shape, the provider the address. Every
 * gate uses exactly this pattern (PHP with `\z` for `$`).
 */
export const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const MAX_EMAIL_LENGTH = 254;

export type BodyField =
  | {
      type: 'string';
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      enum?: string[];
      format?: (typeof STRING_FORMATS)[number];
    }
  | {
      type: 'integer';
      required?: boolean;
      minimum?: number;
      maximum?: number;
    }
  | { type: 'boolean'; required?: boolean }
  | { type: 'object'; required?: boolean; fields: BodyFields }
  | {
      type: 'array';
      required?: boolean;
      items: BodyField;
      minItems?: number;
      maxItems: number;
    };
export type BodyFields = { [name: string]: BodyField };

const fieldName = z
  .string()
  .regex(BODY_FIELD_NAME)
  .refine((name) => name !== '__proto__');
const length = z.int().min(0).max(MAX_STRING_LENGTH);
const integer = z.int().min(0).max(MAX_BODY_INTEGER);
const required = z.boolean().optional();

export const bodyFieldSchema: z.ZodType<BodyField> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('string'),
      required,
      minLength: length.optional(),
      maxLength: length.optional(),
      enum: z
        .array(
          // Code points, as every gate counts them.
          z.string().refine((value) => [...value].length <= MAX_ENUM_LENGTH),
        )
        .min(1)
        .max(MAX_ENUM_VALUES)
        .optional(),
      format: z.enum(STRING_FORMATS).optional(),
    }),
    z.strictObject({
      type: z.literal('integer'),
      required,
      minimum: integer.optional(),
      maximum: integer.optional(),
    }),
    z.strictObject({ type: z.literal('boolean'), required }),
    z.strictObject({
      type: z.literal('object'),
      required,
      fields: bodyFieldsSchema,
    }),
    z.strictObject({
      type: z.literal('array'),
      required,
      items: bodyFieldSchema,
      minItems: z.int().min(0).max(MAX_ARRAY_ITEMS).optional(),
      maxItems: z.int().min(1).max(MAX_ARRAY_ITEMS),
    }),
  ]),
);

/** The fields of an object: at least one, at most MAX_OBJECT_FIELDS. */
export const bodyFieldsSchema: z.ZodType<BodyFields> = z.lazy(() =>
  z.record(fieldName, bodyFieldSchema).refine((fields) => {
    const count = Object.keys(fields).length;
    return count >= 1 && count <= MAX_OBJECT_FIELDS;
  }, `1 to ${MAX_OBJECT_FIELDS} fields`),
);

/**
 * What the shape alone does not say: at most MAX_BODY_FIELDS fields and MAX_BODY_DEPTH levels,
 * minimum ≤ maximum for lengths, integers and items, and no `required` on array items (an item is
 * always there). Returns a message for the first problem, or null.
 */
export function bodySchemaProblem(fields: BodyFields): string | null {
  let count = 0;
  const walk = (
    field: BodyField,
    depth: number,
    item: boolean,
  ): string | null => {
    count += 1;
    if (item && field.required !== undefined)
      return 'array items cannot be `required`';
    if (field.type === 'string') {
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      )
        return '`minLength` above `maxLength`';
    } else if (field.type === 'integer') {
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      )
        return '`minimum` above `maximum`';
    } else if (field.type === 'object') {
      if (depth + 1 > MAX_BODY_DEPTH)
        return `nested deeper than ${MAX_BODY_DEPTH} levels`;
      return walkAll(field.fields, depth + 1);
    } else if (field.type === 'array') {
      if (depth + 1 > MAX_BODY_DEPTH)
        return `nested deeper than ${MAX_BODY_DEPTH} levels`;
      if (field.minItems !== undefined && field.minItems > field.maxItems)
        return '`minItems` above `maxItems`';
      return walk(field.items, depth + 1, true);
    }
    return null;
  };
  const walkAll = (all: BodyFields, depth: number): string | null => {
    for (const field of Object.values(all)) {
      const problem = walk(field, depth, false);
      if (problem !== null) return problem;
    }
    return null;
  };
  const problem = walkAll(fields, 0);
  if (problem !== null) return problem;
  return count > MAX_BODY_FIELDS ? `more than ${MAX_BODY_FIELDS} fields` : null;
}

/**
 * FR-13: the body the gate forwards — the canonical JSON of the fields `fields` lists, unknown
 * ones removed — or `body_invalid` when the bytes are not a strict JSON object (docs/CRYPTO.md
 * §2) or a field does not fit.
 */
export function validateBody(fields: BodyFields, bytes: Uint8Array): string {
  let value: JsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof MoatRejection) reject('body_invalid');
    throw error;
  }
  if (!isJsonObject(value)) reject('body_invalid');
  return canonicalJson(keep(fields, value));
}

function keep(
  fields: BodyFields,
  value: { [key: string]: JsonValue },
): { [key: string]: JsonValue } {
  const kept = Object.create(null) as { [key: string]: JsonValue };
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, name)) {
      if (field.required === true) reject('body_invalid');
      continue;
    }
    kept[name] = check(field, value[name] ?? null);
  }
  return kept;
}

function check(field: BodyField, value: JsonValue): JsonValue {
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') reject('body_invalid');
      // Code points, as every gate counts them (strict JSON has no lone surrogates).
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength)
        reject('body_invalid');
      if (field.maxLength !== undefined && length > field.maxLength)
        reject('body_invalid');
      if (field.enum !== undefined && !field.enum.includes(value))
        reject('body_invalid');
      if (
        field.format === 'email' &&
        (value.length > MAX_EMAIL_LENGTH || !EMAIL.test(value))
      )
        reject('body_invalid');
      return value;
    }
    case 'integer':
      if (typeof value !== 'number') reject('body_invalid');
      if (field.minimum !== undefined && value < field.minimum)
        reject('body_invalid');
      if (field.maximum !== undefined && value > field.maximum)
        reject('body_invalid');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') reject('body_invalid');
      return value;
    case 'object':
      if (!isJsonObject(value)) reject('body_invalid');
      return keep(field.fields, value);
    case 'array':
      if (!Array.isArray(value)) reject('body_invalid');
      if (field.minItems !== undefined && value.length < field.minItems)
        reject('body_invalid');
      if (value.length > field.maxItems) reject('body_invalid');
      return value.map((item) => check(field.items, item));
  }
}
