// Small readers of decoded JSON values that several connectors share (merged in plan step 5b from
// per-connector copies).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A JSON object (not null, not an array). */
export const isObject = <V = unknown>(v: unknown): v is Record<string, V> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Python truthiness of a JSON value, as the old readers judged flags such as `deleted` or `alpha2 or name`. */
export const truthy = (v: unknown) =>
  v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);

/** Length in code points, as Python's len() counted (JavaScript's length counts UTF-16 units). */
export const codePoints = (s: string) => [...s].length;
