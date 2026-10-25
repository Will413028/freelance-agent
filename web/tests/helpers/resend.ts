import type { Request } from "@/modules/collection/mail/receiving";
import { PyError } from "@/platform/py/value";

/** The Resend transport over {url: [status, latin-1 body]}, recording each URL; an unknown URL fails like a network error. */
export function transport(pages: Record<string, [number, string]>, calls: string[] = []): Request {
  return async (url) => {
    calls.push(url);
    const page = pages[url];
    if (!page) throw new PyError("OSError", "unknown url");
    return { status: page[0], body: new Uint8Array(page[0] >= 200 && page[0] < 300 ? Buffer.from(page[1], "latin1") : []) };
  };
}
