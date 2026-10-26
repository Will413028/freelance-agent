// Pure on purpose: the daily workflow function adds these up, and workflow code may import nothing
// that needs Node.js modules (src/workflows/in-order.ts).

/**
 * What a step spent on D1 and how its storage failed, as daily_runs.result records it at the top
 * level (plan step 4e). The D20 and D21 revocation triggers read it: lease_wait_ms (p95 over 7
 * days), lease_timeouts (any), d1_errors.rate_limited (any 429), d1_requests (over 600 in a run).
 * lost_steps counts steps that died before returning theirs: the run's totals are then a lower bound.
 */
export type Usage = {
  d1_requests: number; d1_rows_written: number; lease_wait_ms: number; lease_timeouts: number; lease_lost: number;
  d1_errors: Record<string, number>; lost_steps: number;
};

export const NO_USAGE: Usage = { d1_requests: 0, d1_rows_written: 0, lease_wait_ms: 0, lease_timeouts: 0, lease_lost: 0, d1_errors: {}, lost_steps: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  const d1_errors = { ...a.d1_errors };
  for (const [kind, n] of Object.entries(b.d1_errors)) d1_errors[kind] = (d1_errors[kind] ?? 0) + n;
  return {
    d1_requests: a.d1_requests + b.d1_requests, d1_rows_written: a.d1_rows_written + b.d1_rows_written, lease_wait_ms: a.lease_wait_ms + b.lease_wait_ms,
    lease_timeouts: a.lease_timeouts + b.lease_timeouts, lease_lost: a.lease_lost + b.lease_lost, d1_errors, lost_steps: a.lost_steps + b.lost_steps,
  };
}
