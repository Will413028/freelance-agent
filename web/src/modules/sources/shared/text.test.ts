import { describe, expect, it } from "vitest";
import { codePoints, truthy } from "./json";
import { pyStrip, visibleLines } from "./text";

describe("shared text and JSON helpers", () => {
  it("strips Python's whitespace set: U+001C and U+0085 yes, the BOM no", () => {
    expect(pyStrip("\x1c\x85 a b　")).toBe("a b");
    expect(pyStrip("\ufeffa")).toBe("\ufeffa");
  });

  it("keeps lines at block tags and br, drops script, style and blank lines, collapses spaces", () => {
    expect(visibleLines("<h2>Role</h2><p>Build  APIs</p><script>x()</script><ul><li>One</li><li>Two<br>Three</li></ul>")).toBe("Role\nBuild APIs\nOne\nTwo\nThree");
    expect(visibleLines("a</p>b")).toBe("a\nb");
    expect(visibleLines("<style>p{}</style> ")).toBe("");
  });

  it("counts code points and reads JSON truthiness as Python did", () => {
    expect(codePoints("a😀")).toBe(2);
    expect([0, "", [], {}, null, false, undefined].map(truthy)).toEqual(Array(7).fill(false));
    expect([1, "x", [0], { a: 0 }, true].map(truthy)).toEqual(Array(5).fill(true));
  });
});
