import { describe, expect, it } from "vitest";
import { parseListingInput } from "@/modules/listings/public";
import { SourceError } from "../types";
import { setAside } from "./set-aside";

describe("setAside", () => {
  it("keeps the good items, counts the refused ones and every item examined", () => {
    const r = setAside([1, 2, 3], (n) => { if (n === 2) throw new SourceError("bad"); return n * 10; });
    expect(r).toEqual({ listings: [10, 30], rejected: 1, examined: 3 });
  });
  it("counts an item the normalizer skipped (returned null) as examined, not rejected", () => {
    expect(setAside([1, 2], (n) => (n === 1 ? null : n))).toEqual({ listings: [null, 2], rejected: 0, examined: 2 });
  });
  it("sets aside a listing the listing contract refuses (ZodError)", () => {
    const r = setAside([{ external_id: "" }, 7], (v) => (typeof v === "number" ? v : parseListingInput(v)));
    expect(r).toEqual({ listings: [7], rejected: 1, examined: 2 });
  });
  it("lets any other error through", () => {
    expect(() => setAside([1], () => { throw new TypeError("bug"); })).toThrow(TypeError);
  });
});
