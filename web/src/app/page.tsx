import { getDb } from "@/db/client";
import { listSourceHealth } from "@/modules/collection/source-health";

export const dynamic = "force-dynamic";

export default async function Page() {
  const rows = await listSourceHealth(getDb());
  return (
    <main>
      <h1>來源狀態</h1>
      <table>
        <thead>
          <tr><th>來源</th><th>狀態</th><th>檢查時間（UTC）</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source}><td>{r.source}</td><td>{r.status}</td><td>{r.checkedAt}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
