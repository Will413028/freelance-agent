import { describe, expect, it } from "vitest";
import { fromisoformat } from "@/platform/py/datetime";
import { formatG, formatThousands0f, roundFloat, roundToInt } from "@/platform/py/format";
import { asciiHash, dumps, encode, identityHash, loads, sha256Hex, submissionDigest } from "@/platform/py/json";
import { casefold, pyStr, pyStrip } from "@/platform/py/unicode";
import { asDict, isDict, PyDict, PyError, type PyValue } from "@/platform/py/value";
import { attempt, fixture, hashPoints as loadHashPoints, untag, type Tagged } from "./helpers/golden";

const hashPoints = loadHashPoints();
const golden = fixture("golden.json");

const EXCLUDED = ["received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"];
const without = (v: PyValue, keys: string[]) => new PyDict([...asDict(v)].filter(([k]) => !keys.includes(k)));
const sortedText = (v: PyValue) => dumps(v, { sortKeys: true, ensureAscii: false });

// HP5–HP7 live in discovery rules and are checked in discovery.test.ts.
const IMPL: Record<string, (c: any) => unknown> = {
  "HP1.identity_hash": (c) => { const v = untag(c.input); return { sha256: identityHash(v), text: sortedText(v) }; },
  "HP1b.rules._hash": (c) => ({ sha256: identityHash(untag(c.input)) }),
  "HP1c.legacy_postgres._hash": (c) => ({ sha256: identityHash(untag(c.input)) }),
  "HP1d.opportunity_id_and_fingerprint": (c) => {
    const job = asDict(untag(c.input));
    return { id: identityHash([job.req("source"), job.req("external_id")]), fingerprint: identityHash(without(job, EXCLUDED)) };
  },
  "HP1e.identity_hash_from_stored_text": (c) => ({ sha256: identityHash(loads(c.stored)) }),
  "HP2.receipt_ensure_ascii_false": (c) => {
    const j = untag(c.input);
    if (!isDict(j)) throw new PyError("AttributeError");
    const h = identityHash(j), content = identityHash(without(j, EXCLUDED));
    return { plain: "guru:" + h, getonboard: "getonboard:" + pyStr(j.req("external_id")) + ":" + h,
      public_feeds_int_identity: "remotive:" + pyStr(12345n) + ":" + h, taiwanjobs: "taiwanjobs:" + identityHash(without(j, ["received_at"])),
      ptt_codejob: "ptt_codejob:" + content, ptt_soho: "ptt_soho:" + content };
  },
  "HP3.receipt_ensure_ascii_true": (c) => {
    const v = untag(c.input), s = dumps(v, { sortKeys: true }), h = asciiHash(v);
    return { text: s, himalayas: "himalayas:" + h, linkedin: "linkedin:" + h, free_jobs_float_id: "weworkremotely:" + pyStr(7.0) + ":" + h, community: "hn:" + h };
  },
  "HP4.submission_digest": (c) => {
    const v = untag(c.input);
    return { sha256: submissionDigest(v), text: dumps(v, { sortKeys: true, ensureAscii: false, compact: true, allowNan: false }) };
  },
  "HP4b.submission_digest_from_stored_text": (c) => ({ sha256: submissionDigest(loads(c.stored)) }),
  "HP8.legacy_review_key": (c) => { const j = asDict(untag(c.input)); return { key: sha256Hex(dumps([j.req("source"), j.req("external_id")])).slice(0, 24) }; },
  "HP9.plain_str_sha256": (c) => {
    const s = untag(c.input);
    if (typeof s !== "string") throw new PyError("TypeError");
    return { sha256: sha256Hex(s), intent_key: sha256Hex(s), suffix: sha256Hex(casefold(pyStrip(s))).slice(0, 12) };
  },
  "HP10.sqlite_encode": (c) => ({ text: encode(untag(c.input)) }),
};

describe("spike 1c hash points", () => {
  for (const point of hashPoints.points.filter((p) => IMPL[p.name])) {
    it(`${point.name} matches Python byte for byte`, () => {
      const mismatches = point.cases.flatMap((c, n) => {
        const got = attempt(() => IMPL[point.name](c));
        const ok = "error" in c.expect ? "error" in got : JSON.stringify(got) === JSON.stringify(c.expect);
        return ok ? [] : [{ n, want: c.expect, got }];
      });
      expect(mismatches).toEqual([]);
    });
  }
});

describe("datetime.fromisoformat (C implementation semantics)", () => {
  it("parses or rejects exactly like CPython 3.13", () => {
    const got = golden.fromisoformat.map((c: { input: string }) => ({
      input: c.input,
      expect: attempt(() => {
        const d = fromisoformat(c.input);
        return [d.year, d.month, d.day, d.hour, d.minute, d.second, d.microsecond, d.offset === null ? null : Number(d.offset)];
      }),
    }));
    expect(got).toEqual(golden.fromisoformat);
  });
});

describe("number formatting and rounding", () => {
  const n = (t: Tagged) => { const v = untag(t); return typeof v === "bigint" ? Number(v) : (v as number); };
  it("format(x, 'g')", () => {
    expect(golden.format_g.map((c: any) => formatG(n(c.input)))).toEqual(golden.format_g.map((c: any) => c.expect));
  });
  it("format(x, ',.0f')", () => {
    expect(golden.format_thousands.map((c: any) => formatThousands0f(n(c.input)))).toEqual(golden.format_thousands.map((c: any) => c.expect));
  });
  it("round(x, 1) keeps ints and rounds floats half-even on the binary value", () => {
    const got = golden.round1.map((c: any) => { const v = untag(c.input); return encode(typeof v === "bigint" ? v : roundFloat(v as number, 1)); });
    expect(got).toEqual(golden.round1.map((c: any) => encode(untag(c.expect))));
  });
  it("round(x) returns an int", () => {
    const got = golden.round0.map((c: any) => encode(roundToInt(untag(c.input) as number)));
    expect(got).toEqual(golden.round0.map((c: any) => encode(untag(c.expect))));
  });
});
