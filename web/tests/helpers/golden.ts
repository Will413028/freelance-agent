import { readFileSync } from "node:fs";
import path from "node:path";
import { PyDict, type PyValue } from "@/platform/py/value";

// Tagged transport written by the Python generators: ['i', '7'] is int 7, ['f', '7.0'] float 7.0.
export type Tagged = ["n"] | ["b", boolean] | ["i", string] | ["f", string] | ["s", string] | ["l", Tagged[]] | ["o", [string, Tagged][]];

export function untag(t: Tagged): PyValue {
  switch (t[0]) {
    case "n": return null;
    case "b": return t[1];
    case "i": return BigInt(t[1]);
    case "f": return t[1] === "nan" ? NaN : t[1] === "inf" ? Infinity : t[1] === "-inf" ? -Infinity : Number(t[1]);
    case "s": return t[1];
    case "l": return t[1].map(untag);
    case "o": return new PyDict(t[1].map(([k, v]) => [k, untag(v)]));
  }
}

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures", name), "utf8"));
}

/** Spike 1c ground truth, read in place so its gitleaks allowlist entry stays the only one. */
export const hashPoints = (): { points: { name: string; cases: any[] }[] } =>
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../docs/plans/2026-10-23-nextjs-vercel-migration/spike-1c/expected.json"), "utf8"));

export type Expect<T = unknown> = { ok: T } | { error: string };

/** Runs fn the way the Python generator's attempt() did: a result, or the Python exception type. */
export function attempt<T>(fn: () => T): Expect<T> {
  try {
    return { ok: fn() };
  } catch (e) {
    const pyType = (e as { pyType?: string }).pyType;
    return { error: pyType ?? `JS:${(e as Error).message}` };
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Expect<T>> {
  try {
    return { ok: await fn() };
  } catch (e) {
    const pyType = (e as { pyType?: string }).pyType;
    return { error: pyType ?? `JS:${(e as Error).message}` };
  }
}
