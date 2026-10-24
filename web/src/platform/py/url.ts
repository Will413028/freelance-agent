import { isIPv6 } from "node:net";
import { nfkc } from "./unicode";
import { isDict, isList, PyError, truthy, type PyValue } from "./value";

// urllib.parse.urlsplit / SplitResult.geturl semantics of CPython 3.13 (spike 1c rule 8). WHATWG URL
// would lowercase the host, add "/" and percent-encode, which changes stored identity keys.

export type SplitResult = { scheme: string; netloc: string; path: string; query: string; fragment: string };

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]$/;
const USES_NETLOC = new Set(["", "ftp", "http", "gopher", "nntp", "telnet", "imap", "wais", "file", "mms", "https", "shttp",
  "snews", "prospero", "rtsp", "rtsps", "rtspu", "rsync", "svn", "svn+ssh", "sftp", "nfs", "git", "git+ssh", "ws", "wss", "itms-services"]);

const rpartitionAt = (s: string) => {
  const j = s.lastIndexOf("@");
  return j >= 0 ? ([s.slice(0, j), true, s.slice(j + 1)] as const) : (["", false, s] as const);
};

function checkBracketedNetloc(netloc: string) {
  const hp = rpartitionAt(netloc)[2];
  const b = hp.indexOf("[");
  let host: string;
  if (b >= 0) {
    if (b > 0) throw new PyError("ValueError", "Invalid IPv6 URL");
    const rest = hp.slice(b + 1), e = rest.indexOf("]");
    host = e >= 0 ? rest.slice(0, e) : rest;
    const port = e >= 0 ? rest.slice(e + 1) : "";
    if (port && !port.startsWith(":")) throw new PyError("ValueError", "Invalid IPv6 URL");
  } else host = hp.split(":")[0];
  // 3.13.15 (the production image) also accepts an uppercase V; 3.13.13 did not.
  if (host.startsWith("v") || host.startsWith("V")) {
    if (!/^[vV][a-fA-F0-9]+\..+$/s.test(host)) throw new PyError("ValueError", "IPvFuture address is invalid");
  } else if (!isIPv6(host)) throw new PyError("ValueError", "Invalid IPv6 URL");
}

function checkNetloc(netloc: string) {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const n2 = nfkc(n);
  if (n === n2) return;
  for (const c of "/?#@:") if (n2.includes(c)) throw new PyError("ValueError", "netloc contains invalid characters under NFKC normalization");
}

export function urlsplit(input: string): SplitResult {
  let k = 0;
  while (k < input.length && input.charCodeAt(k) <= 0x20) k++;
  let url = input.slice(k).replace(/[\t\r\n]/g, "");
  let scheme = "", netloc = "", query = "", fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]$/.test(url[0]) && [...url.slice(0, i)].every((c) => SCHEME_CHARS.test(c))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith("//")) {
    let delim = url.length;
    for (const c of "/?#") {
      const w = url.indexOf(c, 2);
      if (w >= 0) delim = Math.min(delim, w);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const open = netloc.includes("["), close = netloc.includes("]");
    if (open !== close) throw new PyError("ValueError", "Invalid IPv6 URL");
    if (open && close) checkBracketedNetloc(netloc);
  }
  const h = url.indexOf("#");
  if (h >= 0) { fragment = url.slice(h + 1); url = url.slice(0, h); }
  const q = url.indexOf("?");
  if (q >= 0) { query = url.slice(q + 1); url = url.slice(0, q); }
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

/**
 * urlsplit(value) for a value read from untrusted JSON: a falsy non-str splits to empty bytes, whose
 * parts never equal a str; a list or dict is unhashable (lru_cache); other truthy values lack decode().
 */
export function urlsplitValue(value: PyValue | undefined): SplitResult {
  if (typeof value === "string") return urlsplit(value);
  if (isList(value) || isDict(value)) throw new PyError("TypeError", "unhashable type");
  if (truthy(value)) throw new PyError("AttributeError", "object has no attribute 'decode'");
  return urlsplit("");
}

/** SplitResult.hostname, used only for truthiness by the ported code. */
export function hostname(netloc: string): string | null {
  const hostinfo = rpartitionAt(netloc)[2];
  const b = hostinfo.indexOf("[");
  const host = b >= 0 ? hostinfo.slice(b + 1).split("]")[0] : hostinfo.split(":")[0];
  return host ? host : null;
}

export function userinfo(netloc: string): { username: string | null; password: string | null } {
  const [info, has] = rpartitionAt(netloc);
  if (!has) return { username: null, password: null };
  const c = info.indexOf(":");
  return c >= 0 ? { username: info.slice(0, c), password: info.slice(c + 1) } : { username: info, password: null };
}

export function urlunsplit(p: SplitResult): string {
  let url = p.path;
  if (p.netloc) {
    if (url && url[0] !== "/") url = "/" + url;
    url = "//" + p.netloc + url;
  } else if (url.startsWith("//")) url = "//" + url;
  else if (p.scheme && USES_NETLOC.has(p.scheme) && (!url || url[0] === "/")) url = "//" + url;
  if (p.scheme) url = p.scheme + ":" + url;
  if (p.query) url += "?" + p.query;
  if (p.fragment) url += "#" + p.fragment;
  return url;
}
