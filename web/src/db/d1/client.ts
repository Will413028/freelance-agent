// D1 over its REST API (plan D19, D21): Vercel is outside Workers, so every query is an HTTP request
// to the account API. Facts this relies on are in spikes.md §1f and "1f 補充": a `batch` is atomic
// when a constraint, guard or trigger fails; BEGIN/COMMIT/SAVEPOINT are refused; `/raw` returns rows
// as arrays; numbers travel as JSON, so integers above 2^53 only survive as text.

export type D1Param = string | number | bigint | boolean | null;
export type D1Statement = { sql: string; params: D1Param[] };
export type D1Result = { columns: string[]; rows: unknown[][]; changes: number; rowsWritten: number; rowsRead: number };

/** One request; every statement in it commits together or not at all. */
export interface D1Transport {
  batch(statements: { sql: string; params: (string | number | null)[] }[]): Promise<D1Result[]>;
}

/**
 * `committed` is what the caller may assume about the batch: false means it certainly did not
 * commit; "unknown" means it may have (response lost, timeout, server error) and the caller must
 * check before sending it again (plan step 4e, write_attempts).
 */
export type D1ErrorKind = "rate_limited" | "daily_limit" | "overloaded" | "constraint" | "rejected" | "unsafe_integer" | "outcome_unknown";

export class D1Error extends Error {
  constructor(readonly kind: D1ErrorKind, readonly committed: false | "unknown", message: string) {
    super(`D1 ${kind}: ${message}`);
    this.name = "D1Error";
  }
}

export type D1Counters = { requests: number; rowsWritten: number; rowsRead: number };

function encodeParam(value: unknown): string | number | null {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`unsupported parameter: ${value}`);
    return value;
  }
  // Exact above 2^53 only as text (1f (e)); SQLite's INTEGER affinity stores it as an integer.
  if (typeof value === "bigint") return value.toString();
  // D1 would store a JSON boolean as the text 'true' (1f (e)).
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError(`unsupported parameter: ${typeof value}`);
}

/** Wraps a transport with parameter encoding, the unsafe-integer check and request/row counters. */
export class D1Client {
  readonly counters: D1Counters = { requests: 0, rowsWritten: 0, rowsRead: 0 };

  constructor(private readonly transport: D1Transport) {}

  async batch(statements: D1Statement[]): Promise<D1Result[]> {
    if (statements.length === 0) return [];
    const encoded = statements.map((s) => ({ sql: s.sql, params: s.params.map(encodeParam) }));
    this.counters.requests++;
    const results = await this.transport.batch(encoded);
    if (results.length !== statements.length) throw new D1Error("outcome_unknown", "unknown", `expected ${statements.length} results, got ${results.length}`);
    for (const r of results) {
      this.counters.rowsWritten += r.rowsWritten;
      this.counters.rowsRead += r.rowsRead;
      for (const row of r.rows) {
        for (const v of row) {
          // JSON.parse already rounded it; refuse instead of handing back a silently different value.
          if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) {
            throw new D1Error("unsafe_integer", false, "an integer outside ±(2^53-1) came back as a number; read it with cast(… as text)");
          }
        }
      }
    }
    return results;
  }
}

export type HttpConfig = { accountId: string; databaseId: string; token: string; fetch?: typeof fetch; timeoutMs?: number };

type ApiError = { code?: number; message?: string };
type RawResult = { success?: boolean; results?: { columns?: string[]; rows?: unknown[][] }; meta?: { changes?: number; rows_written?: number; rows_read?: number } };

/** Classifies a failed response; anything not known to be refused before execution counts as possibly committed. */
function classify(status: number, errors: ApiError[]): D1Error {
  const message = errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") || `HTTP ${status}`;
  if (status === 429) return new D1Error("rate_limited", false, message);
  if (/SQLITE_CONSTRAINT/.test(message)) return new D1Error("constraint", false, message);
  // The exact text of the daily-limit error is not documented; matched loosely, and any other 4xx is
  // still a refusal, so a miss here only changes the label, never the committed answer.
  if (/daily (row )?(read |write )?limit|limit exceeded|exceeded (its|the)? ?.*limit/i.test(message)) return new D1Error("daily_limit", false, message);
  if (/overloaded/i.test(message)) return new D1Error("overloaded", false, message);
  if (status >= 400 && status < 500) return new D1Error("rejected", false, message);
  return new D1Error("outcome_unknown", "unknown", message);
}

export function httpTransport(config: HttpConfig): D1Transport {
  const doFetch = config.fetch ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/raw`;
  return {
    async batch(statements) {
      let response: Response;
      let body: { success?: boolean; errors?: ApiError[]; result?: RawResult[] };
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ batch: statements }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
        });
        body = await response.json();
      } catch (e) {
        throw new D1Error("outcome_unknown", "unknown", e instanceof Error ? e.message : String(e));
      }
      if (!response.ok || body.success !== true) throw classify(response.status, body.errors ?? []);
      return (body.result ?? []).map((r) => ({
        columns: r.results?.columns ?? [],
        rows: r.results?.rows ?? [],
        changes: r.meta?.changes ?? 0,
        rowsWritten: r.meta?.rows_written ?? 0,
        rowsRead: r.meta?.rows_read ?? 0,
      }));
    },
  };
}
