import type { SkeletonListing } from "@/db/pg/listings";

/** Walking-skeleton list (plan step 2; removed in step 3). */
export function SkeletonList({ listings }: { listings: SkeletonListing[] }) {
  return (
    <main>
      <h1>Skeleton</h1>
      <p>{listings.length} listings</p>
      <ul>{listings.map((l) => <li key={l.id}>{l.source}: <a href={l.url} rel="noreferrer">{l.title}</a></li>)}</ul>
    </main>
  );
}
