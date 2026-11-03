"use client";

// A page whose read failed (plan step 11): D1 over HTTP can be rate limited, out of its daily rows or
// time out, and listPage gives up after one retry when a write keeps landing between its two reads.
// A client component by Next's rule; it imports nothing of the server (tests/structure.test.ts).
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return <main>
    <p role="alert" className="error">暫時讀不到資料，請稍後重新載入。</p>
    <p><button className="outline-button" onClick={() => reset()}>重新載入</button> <a className="outline-button" href="/">回到清單</a></p>
  </main>;
}
