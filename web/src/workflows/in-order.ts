// Pure orchestration helper for the daily workflow; it may import nothing that needs Node.js modules.

/**
 * Runs each source after the previous one finished, as collection/service.py does: a source batch
 * holds the single writer lock for its whole transaction, so a source running beside it would fail
 * on lock_timeout. A source step that throws counts as failed and the next one still runs.
 */
export async function syncInOrder(sources: string[], sync: (source: string) => Promise<string>): Promise<Record<string, string>> {
  const statuses: Record<string, string> = {};
  for (const source of sources) {
    try {
      statuses[source] = await sync(source);
    } catch {
      statuses[source] = "failed";
    }
  }
  return statuses;
}
