import { describe, expect, it } from "vitest";
import { PyDateTime } from "@/platform/py/datetime";
import { parsedateToDatetime } from "@/platform/py/email";
import { encode } from "@/platform/py/json";
import { pyInt } from "@/platform/py/unicode";
import { PyDict } from "@/platform/py/value";
import { attempt, fixture, untag, type Expect, type Tagged } from "../../../../tests/helpers/golden";
import { parse } from "./cryptojobslist";
import { published, text } from "./public-feeds";

// Plan step 7: collection/cryptojobslist.py and the public_feeds helpers it imports, against the
// ground truth gen_golden.py wrote with the production image's Python (3.13.15).

type Case<I, O> = { input: I; expect: Expect<O>; latin1?: boolean };
const golden = fixture<{
  public_text: Case<Tagged, string>[];
  parsedate: Case<string, string>[];
  published: Case<string, string>[];
  py_int: Case<string, string>[];
  cryptojobslist_parse: Case<string, { result: string; jobs: string[] }>[];
}>("golden.json");

const NOW = new PyDateTime(2026, 9, 28, 1, 0, 0, 0, 0n);
const mismatches = <I, O>(cases: Case<I, O>[], run: (c: Case<I, O>) => O) =>
  cases.filter((c) => JSON.stringify(attempt(() => run(c))) !== JSON.stringify(c.expect)).map((c) => ({ input: c.input, expect: c.expect, got: attempt(() => run(c)) }));

describe("public_feeds helpers match CPython 3.13.15", () => {
  it(`text: ${golden.public_text.length} fragments (html.parser feed + close)`, () => {
    expect(mismatches(golden.public_text, (c) => text(untag(c.input)))).toEqual([]);
  });
  it(`email.utils.parsedate_to_datetime: ${golden.parsedate.length} dates`, () => {
    expect(mismatches(golden.parsedate, (c) => parsedateToDatetime(c.input).isoformat())).toEqual([]);
  });
  it(`published: ${golden.published.length} dates`, () => {
    expect(mismatches(golden.published, (c) => published(c.input).isoformat())).toEqual([]);
  });
  it(`int(str): ${golden.py_int.length} strings`, () => {
    expect(mismatches(golden.py_int, (c) => pyInt(c.input).toString())).toEqual([]);
  });
});

describe("cryptojobslist.parse matches Python", () => {
  it(`${golden.cryptojobslist_parse.length} feeds`, () => {
    expect(mismatches(golden.cryptojobslist_parse, (c) => {
      const r = parse(Buffer.from(c.input, c.latin1 ? "latin1" : "utf8"), NOW);
      return { result: encode(new PyDict([...r].filter(([k]) => k !== "jobs"))), jobs: (r.req("jobs") as PyDict[]).map((j) => encode(j)) };
    })).toEqual([]);
  });
});
