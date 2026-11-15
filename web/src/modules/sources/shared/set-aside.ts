import { ZodError } from "zod";
import { SourceError } from "../types";

/**
 * Normalize each listing on its own: a `SourceError` raised for ONE listing, or the listing contract
 * refusing it (`parseListingInput`'s `ZodError`), sets it aside and counts it (Will 2026-11-15, step 5a
 * VM run); any other error still propagates. `examined` is every item the normalizer ran on, kept or
 * not. The caller adds `rejected` and `examined` to its `Collected` (summed over every call, so both are
 * counted at the same level), and services/collect fails the run when more than half were rejected.
 */
export function setAside<T, L>(items: readonly T[], normalize: (item: T, index: number) => L): { listings: L[]; rejected: number; examined: number } {
  const listings: L[] = [];
  let rejected = 0;
  items.forEach((item, i) => {
    try {
      listings.push(normalize(item, i));
    } catch (e) {
      if (!(e instanceof SourceError) && !(e instanceof ZodError)) throw e;
      rejected++;
    }
  });
  return { listings, rejected, examined: items.length };
}
