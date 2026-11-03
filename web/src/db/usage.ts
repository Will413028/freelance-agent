// Pure on purpose: the daily workflow function adds these up, and workflow code may import nothing
// that needs Node.js modules (src/workflows/in-order.ts).

/**
 * What a step spent on D1 and how its storage failed, as daily_runs.result records it at the top
 * level (plan step 4e). The D20 and D21 revocation triggers read it on every run
 * (src/ops/storage-triggers.ts): lease_wait_ms (over 2 s), lease_timeouts and lease_lost (any),
 * d1_errors.rate_limited (any 429), d1_requests (over 600).
 * lost_steps counts steps that died before returning theirs: the run's totals are then a lower bound.
 * read_retries counts page reads of the discovery projection run again (plan step 10e2; any is flagged).
 */
export type Usage = {
  d1_requests: number; d1_rows_written: number; lease_wait_ms: number; lease_timeouts: number; lease_lost: number;
  d1_errors: Record<string, number>; lost_steps: number; read_retries: number;
};

export const NO_USAGE: Usage = { d1_requests: 0, d1_rows_written: 0, lease_wait_ms: 0, lease_timeouts: 0, lease_lost: 0, d1_errors: {}, lost_steps: 0, read_retries: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  const d1_errors = { ...a.d1_errors };
  for (const [kind, n] of Object.entries(b.d1_errors)) d1_errors[kind] = (d1_errors[kind] ?? 0) + n;
  return {
    d1_requests: a.d1_requests + b.d1_requests, d1_rows_written: a.d1_rows_written + b.d1_rows_written, lease_wait_ms: a.lease_wait_ms + b.lease_wait_ms,
    lease_timeouts: a.lease_timeouts + b.lease_timeouts, lease_lost: a.lease_lost + b.lease_lost, d1_errors, lost_steps: a.lost_steps + b.lost_steps,
    read_retries: a.read_retries + b.read_retries,
  };
}
