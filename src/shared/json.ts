// JSON domain types and runtime guards for narrowing unparsed values at their
// I/O boundary. Keep this file dependency-free: it is type-checked in both the
// worker and client TypeScript programs.
//
// The guards are generic (`<T>(value: T) => value is T & X`) rather than
// `unknown`-parametered so call sites keep whatever type evidence they already
// have; `typeof` is confined to these type guards per the anti-slop
// no-runtime-typeof contract.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

export function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

export function isBoolean<T>(value: T): value is T & boolean {
  return typeof value === 'boolean';
}

export function isFunction<T>(value: T): value is T & ((...args: never[]) => void) {
  return typeof value === 'function';
}

/** True for non-array, non-null objects. Intended for JSON-derived values. */
export function isJsonObject<T>(value: T): value is T & JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
  return Array.isArray(value);
}

/** Parse JSON text into the JSON domain instead of `any`. */
export function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse output is by construction a JSON value.
  return JSON.parse(text) as JsonValue;
}
