import { getDb, readTransaction } from "@/db/client";
import { sourceChecksIn } from "@/modules/collection/public";
import { asDict } from "@/platform/py/value";

export const dynamic = "force-dynamic";

// Shadow-period status page; the real UI arrives in plan step 11.
export default async function Page() {
  const checks = await readTransaction(getDb(), (tx) => sourceChecksIn(tx));
  return (
    <main>
      <h1>來源狀態</h1>
      <table>
        <thead>
          <tr><th>來源</th><th>狀態</th><th>檢查時間（UTC）</th></tr>
        </thead>
        <tbody>
          {[...checks].map(([source, v]) => (
            <tr key={source}><td>{source}</td><td>{String(asDict(v).at("status"))}</td><td>{String(asDict(v).at("checked_at") ?? "")}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
