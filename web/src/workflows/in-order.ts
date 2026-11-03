// Pure orchestration helper for the daily workflow; it may import nothing that needs Node.js modules.

/**
 * Runs each source after the previous one finished, as collection/service.py does. Sources write
 * under one writer lease (D20-B), so running them side by side would only make them wait for each
 * other; running them in parallel again is the trigger for revisiting D20 (optimistic per-record
 * versions). A source step that throws counts as failed and the next one still runs.
 */
export async function syncInOrder<T>(sources: string[], sync: (source: string) => Promise<T>, failed: T): Promise<Record<string, T>> {
  const results: Record<string, T> = {};
  for (const source of sources) {
    try {
      results[source] = await sync(source);
    } catch {
      results[source] = failed;
    }
  }
  return results;
}
