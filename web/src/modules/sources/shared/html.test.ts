import { describe, expect, it } from "vitest";
import { htmlText } from "./html";

// htmlText parses as the HTML standard does (cheerio, parse5 without scripting). Whitespace is JavaScript's
// \s, not Python's str.split() (NEL, U+001C–U+001F and BOM differ; accepted, step 4 review). Against the old
// html.parser port (golden.json html_text, 98 fragments) it differs in 15, all where the old one was
// wrong: it dropped unfinished text at the end ("tail &amp" gave ""), and it showed text a browser hides.
describe("htmlText", () => {
  it.each([
    ["<p>Build an API</p>", "Build an API"],
    ["<div>a</div><div>b</div>", "a b"],
    ["a<br>b<li>c</li>d", "a b c d"],
    ["<script>x</script><style>y</style>z", "z"],
    ["  \n\t ", ""],
    ["Fish &amp; chips &Aacute;", "Fish & chips Á"],
    ["tail &amp", "tail &"],
    ["x<", "x<"],
    ["<noscript><p>x</p></noscript>", "x"],
    ["Requirements:</p>Python", "Requirements: Python"],
    ["a</div>b</li>c</br>d", "a b c d"],
    ["<p>a</p>　<p>b</p>", "a b"],
  ])("%j → %j", (html, text) => expect(htmlText(html)).toBe(text));
});
