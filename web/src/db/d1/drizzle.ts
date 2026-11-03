// drizzle's sqlite-proxy driver over a D1Client: each query is one request, `db.batch([...])` is one
// atomic request. drizzle's `transaction()` would send BEGIN, which D1 refuses (spike 1f (c)).
import type { DrizzleConfig } from "drizzle-orm";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { D1Client, D1Param, D1Result } from "./client";

type Method = "run" | "all" | "values" | "get";

/** sqlite-proxy wants rows as arrays for all/values, a single row (or undefined) for get. */
function shape(result: D1Result, method: Method): { rows: any[] } {
  if (method === "get") return { rows: result.rows[0] as any[] };
  if (method === "run") return { rows: [] };
  return { rows: result.rows };
}

export type D1Db<TSchema extends Record<string, unknown>> = SqliteRemoteDatabase<TSchema>;

export function d1Drizzle<TSchema extends Record<string, unknown>>(client: D1Client, schema: TSchema, config: Omit<DrizzleConfig<TSchema>, "schema"> = {}): D1Db<TSchema> {
  return drizzle(
    async (sql, params, method) => shape((await client.batch([{ sql, params: params as D1Param[] }]))[0], method),
    async (queries) => {
      const results = await client.batch(queries.map((q) => ({ sql: q.sql, params: q.params as D1Param[] })));
      return results.map((r, i) => shape(r, queries[i].method));
    },
    { ...config, schema },
  );
}
