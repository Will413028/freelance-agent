import { PyDateTime } from "./datetime";
import { codePoints, pyInt, pyIsDigit, pyLower, pySplit, pyStrip, pyUpperAscii } from "./unicode";
import { PyError } from "./value";

// email.utils.parsedate_to_datetime of CPython 3.13.15 (email/_parseaddr.py _parsedate_tz).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700,
};

const last = (s: string) => { const c = codePoints(s); return c.length ? String.fromCodePoint(c[c.length - 1]) : ""; };
const dropLast = (s: string) => { const c = codePoints(s); return String.fromCodePoint(...c.slice(0, -1)); };
const tryInt = (s: string) => { try { return pyInt(s); } catch { return null; } };

type Parsed = [bigint, number, bigint, bigint, bigint, bigint, number | null];

function parsedateTz(input: string): Parsed | null {
  if (!input) return null;
  let data = pySplit(input);
  if (!data.length) return null;
  if (data[0].endsWith(",") || DAYS.includes(pyLower(data[0]))) data.shift();
  else {
    const i = data[0].lastIndexOf(",");
    if (i >= 0) data[0] = data[0].slice(i + 1);
  }
  if (data.length === 3) {
    const stuff = data[0].split("-");
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3];
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) data.splice(3, 1, s.slice(0, i), s.slice(i));
    else data.push("");
  }
  if (data.length < 5) return null;
  let [dd, mm, yy, tm, tz] = data.slice(0, 5);
  if (!(dd && mm && yy)) return null;
  mm = pyLower(mm);
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, pyLower(dd)];
    if (!MONTHS.includes(mm)) return null;
  }
  let month = MONTHS.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (last(dd) === ",") dd = dropLast(dd);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (last(yy) === ",") {
    yy = dropLast(yy);
    if (!yy) return null;
  }
  if (!pyIsDigit(codePoints(yy)[0])) [yy, tz] = [tz, yy];
  if (last(tm) === ",") tm = dropLast(tm);
  let parts = tm.split(":");
  let thh: string, tmm: string, tss: string;
  if (parts.length === 2) [thh, tmm, tss] = [parts[0], parts[1], "0"];
  else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
  else if (parts.length === 1 && parts[0].includes(".")) {
    parts = parts[0].split(".");
    if (parts.length === 2) [thh, tmm, tss] = [parts[0], parts[1], "0"];
    else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
    else return null;
  } else return null;
  const nums = [yy, dd, thh, tmm, tss].map(tryInt);
  if (nums.some((n) => n === null)) return null;
  let [year, day, hh, mi, ss] = nums as bigint[];
  if (year < 100n) year += year > 68n ? 1900n : 2000n;
  let offset: bigint | null = null;
  const zone = pyUpperAscii(tz);
  if (Object.hasOwn(ZONES, zone)) offset = BigInt(ZONES[zone]);
  else {
    offset = tryInt(zone);
    if (offset === 0n && zone.startsWith("-")) offset = null;
  }
  let seconds: number | null = offset === null ? null : 0;
  if (offset) {
    const sign = offset < 0n ? -1n : 1n, abs = offset < 0n ? -offset : offset;
    const value = sign * ((abs / 100n) * 3600n + (abs % 100n) * 60n);
    seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) seconds = Number.MAX_SAFE_INTEGER; // past timezone()'s range either way
  }
  return [year, month, day, hh, mi, ss, seconds];
}

/** email.utils.parsedate_to_datetime; every failure is a ValueError, as in Python. */
export function parsedateToDatetime(data: string): PyDateTime {
  const parsed = parsedateTz(data);
  const invalid = () => new PyError("ValueError", `Invalid date value or format "${data}"`);
  if (parsed === null) throw invalid();
  const [year, month, day, hh, mi, ss, tz] = parsed;
  const small = (n: bigint) => (n >= -(2n ** 31n) && n < 2n ** 31n ? Number(n) : null);
  const fields = [year, day, hh, mi, ss].map(small);
  // CPython raises OverflowError past a C int, which parsedate_to_datetime turns into ValueError.
  if (fields.some((n) => n === null)) throw invalid();
  const [y, d, h, m, s] = fields as number[];
  return new PyDateTime(y, month, d, h, m, s, 0, tz === null ? null : BigInt(tz) * 1_000_000n);
}

// email.utils.getaddresses(strict=True) of CPython 3.13.15 (email/utils.py and _parseaddr.AddrlistClass),
// line by line: the Resend sender allowlist depends on exactly which header values it accepts.

type Address = [string, string];
const SPECIALS = '()<>@,:;."[]';
const LWS = " \t";
const CR = "\r\n";
const FWS = LWS + CR;
const ATOMENDS = SPECIALS + LWS + CR;
const PHRASEENDS = ATOMENDS.replace(".", "");
const parseaddrQuote = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

class AddrlistClass {
  pos = 0;
  commentlist: string[] = [];
  constructor(readonly field: string) {}

  private at(): string {
    return this.field[this.pos];
  }

  gotonext(): string {
    const wslist: string[] = [];
    while (this.pos < this.field.length) {
      if ((LWS + "\n\r").includes(this.at())) {
        if (!"\n\r".includes(this.at())) wslist.push(this.at());
        this.pos++;
      } else if (this.at() === "(") this.commentlist.push(this.getcomment());
      else break;
    }
    return wslist.join("");
  }

  getaddrlist(): Address[] {
    const result: Address[] = [];
    while (this.pos < this.field.length) {
      const ad = this.getaddress();
      if (ad.length) result.push(...ad);
      else result.push(["", ""]);
    }
    return result;
  }

  getaddress(): Address[] {
    this.commentlist = [];
    this.gotonext();
    const oldpos = this.pos, oldcl = this.commentlist;
    const plist = this.getphraselist();
    this.gotonext();
    let returnlist: Address[] = [];
    if (this.pos >= this.field.length) {
      if (plist.length) returnlist = [[this.commentlist.join(" "), plist[0]]];
    } else if (".@".includes(this.at())) {
      this.pos = oldpos;
      this.commentlist = oldcl;
      const addrspec = this.getaddrspec();
      returnlist = [[this.commentlist.join(" "), addrspec]];
    } else if (this.at() === ":") {
      returnlist = [];
      const fieldlen = this.field.length;
      this.pos++;
      while (this.pos < this.field.length) {
        this.gotonext();
        if (this.pos < fieldlen && this.at() === ";") {
          this.pos++;
          break;
        }
        returnlist = returnlist.concat(this.getaddress());
      }
    } else if (this.at() === "<") {
      const routeaddr = this.getrouteaddr();
      returnlist = this.commentlist.length
        ? [[plist.join(" ") + " (" + this.commentlist.join(" ") + ")", routeaddr]]
        : [[plist.join(" "), routeaddr]];
    } else if (plist.length) returnlist = [[this.commentlist.join(" "), plist[0]]];
    else if (SPECIALS.includes(this.at())) this.pos++;
    this.gotonext();
    if (this.pos < this.field.length && this.at() === ",") this.pos++;
    return returnlist;
  }

  getrouteaddr(): string {
    let expectroute = false;
    this.pos++;
    this.gotonext();
    let adlist = "";
    while (this.pos < this.field.length) {
      if (expectroute) {
        this.getdomain();
        expectroute = false;
      } else if (this.at() === ">") {
        this.pos++;
        break;
      } else if (this.at() === "@") {
        this.pos++;
        expectroute = true;
      } else if (this.at() === ":") this.pos++;
      else {
        adlist = this.getaddrspec();
        this.pos++;
        break;
      }
      this.gotonext();
    }
    return adlist;
  }

  getaddrspec(): string {
    const aslist: string[] = [];
    this.gotonext();
    while (this.pos < this.field.length) {
      let preserveWs = true;
      if (this.at() === ".") {
        if (aslist.length && !pyStrip(aslist[aslist.length - 1])) aslist.pop();
        aslist.push(".");
        this.pos++;
        preserveWs = false;
      } else if (this.at() === '"') aslist.push(`"${parseaddrQuote(this.getquote())}"`);
      else if (ATOMENDS.includes(this.at())) {
        if (aslist.length && !pyStrip(aslist[aslist.length - 1])) aslist.pop();
        break;
      } else aslist.push(this.getatom());
      const ws = this.gotonext();
      if (preserveWs && ws) aslist.push(ws);
    }
    if (this.pos >= this.field.length || this.at() !== "@") return aslist.join("");
    aslist.push("@");
    this.pos++;
    this.gotonext();
    const domain = this.getdomain();
    if (!domain) return "";
    return aslist.join("") + domain;
  }

  getdomain(): string {
    const sdlist: string[] = [];
    while (this.pos < this.field.length) {
      if (LWS.includes(this.at())) this.pos++;
      else if (this.at() === "(") this.commentlist.push(this.getcomment());
      else if (this.at() === "[") sdlist.push(this.getdomainliteral());
      else if (this.at() === ".") {
        this.pos++;
        sdlist.push(".");
      } else if (this.at() === "@") return "";
      else if (ATOMENDS.includes(this.at())) break;
      else sdlist.push(this.getatom());
    }
    return sdlist.join("");
  }

  getdelimited(beginchar: string, endchars: string, allowcomments: boolean): string {
    if (this.at() !== beginchar) return "";
    const slist = [""];
    let quote = false;
    this.pos++;
    while (this.pos < this.field.length) {
      if (quote) {
        slist.push(this.at());
        quote = false;
      } else if (endchars.includes(this.at())) {
        this.pos++;
        break;
      } else if (allowcomments && this.at() === "(") {
        slist.push(this.getcomment());
        continue;
      } else if (this.at() === "\\") quote = true;
      else slist.push(this.at());
      this.pos++;
    }
    return slist.join("");
  }

  getquote = () => this.getdelimited('"', '"\r', false);
  getcomment = (): string => this.getdelimited("(", ")\r", true);
  getdomainliteral = () => `[${this.getdelimited("[", "]\r", false)}]`;

  getatom(atomends = ATOMENDS): string {
    const atomlist = [""];
    while (this.pos < this.field.length) {
      if (atomends.includes(this.at())) break;
      atomlist.push(this.at());
      this.pos++;
    }
    return atomlist.join("");
  }

  getphraselist(): string[] {
    const plist: string[] = [];
    while (this.pos < this.field.length) {
      if (FWS.includes(this.at())) this.pos++;
      else if (this.at() === '"') plist.push(this.getquote());
      else if (this.at() === "(") this.commentlist.push(this.getcomment());
      else if (PHRASEENDS.includes(this.at())) break;
      else plist.push(this.getatom(PHRASEENDS));
    }
    return plist;
  }
}

const addressList = (field: string): Address[] => (field ? new AddrlistClass(field).getaddrlist() : []);

function* iterEscapedChars(addr: string): Generator<[number, string]> {
  let pos = 0, escape = false;
  for (pos = 0; pos < addr.length; pos++) {
    const ch = addr[pos];
    if (escape) {
      yield [pos, "\\" + ch];
      escape = false;
    } else if (ch === "\\") escape = true;
    else yield [pos, ch];
  }
  // Python's loop variable keeps the last index (0 for an empty string).
  if (escape) yield [Math.max(addr.length - 1, 0), "\\"];
}

function stripQuotedRealnames(addr: string): string {
  if (!addr.includes('"')) return addr;
  let start = 0, openPos: number | null = null;
  const result: string[] = [];
  for (const [pos, ch] of iterEscapedChars(addr)) {
    if (ch !== '"') continue;
    if (openPos === null) openPos = pos;
    else {
      if (start !== openPos) result.push(addr.slice(start, openPos));
      start = pos + 1;
      openPos = null;
    }
  }
  if (start < addr.length) result.push(addr.slice(start));
  return result.join("");
}

function checkParenthesis(addr: string): boolean {
  addr = stripQuotedRealnames(addr);
  let opens = 0;
  for (const [, ch] of iterEscapedChars(addr)) {
    if (ch === "(") opens++;
    else if (ch === ")" && --opens < 0) return false;
  }
  return opens === 0;
}

export function getaddresses(fieldvalues: string[]): Address[] {
  const values = fieldvalues.map((v) => (checkParenthesis(v) ? v : "('', '')"));
  const result = addressList(values.join(", ")).map((v): Address => (v[1].includes("[") ? ["", ""] : v));
  let n = 0;
  for (const v of values) n += 1 + stripQuotedRealnames(v).split(",").length - 1;
  return result.length === n ? result : [["", ""]];
}
