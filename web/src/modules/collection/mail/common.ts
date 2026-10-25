import { fromisoformat, type PyDateTime } from "@/platform/py/datetime";
import { pyRe } from "@/platform/py/re";
import { pySplit } from "@/platform/py/unicode";
import { PyError } from "@/platform/py/value";

// Pieces the mail parsers share: Python's error class, the received-timestamp check and the
// kind patterns, as the per-source Python modules each wrote them.

export const mailParseError = (message: string) => new PyError("MailParseError", message);

/** datetime.fromisoformat(received_at.replace('Z', '+00:00')), aware, or MailParseError. */
export function receivedAt(value: string, message: string): PyDateTime {
  try {
    const received = fromisoformat(value.replaceAll("Z", "+00:00"));
    if (received.offset === null) throw new PyError("ValueError", "");
    return received;
  } catch (e) {
    if (e instanceof PyError && e.pyType === "ValueError") throw mailParseError(message);
    throw e;
  }
}

/** ' '.join(''.join(parts).split()) */
export const squash = (parts: string[]) => pySplit(parts.join("")).join(" ");

export const FULL_TIME = pyRe("全職|\\bfull[ -]time\\b", true);

/** dict(attrs).get(name, fallback): the last occurrence of a repeated attribute wins. */
export function attr(attrs: [string, string | null][], name: string, fallback: string | null | undefined = undefined): string | null | undefined {
  let found: string | null | undefined = fallback;
  for (const [k, v] of attrs) if (k === name) found = v;
  return found;
}
