// Regression guard at the CSS source level for the Safari/WebKit End Time
// editor sizing investigation — jsdom doesn't lay out native form controls
// (input[type="time"]'s actual rendered width, and Safari's specific
// collapse-inside-flex behavior, can't be reproduced there), so
// ActivityLogsCard/WorkdayDetailsCard's own tests can only prove the
// className contract holds. This file proves the *rule behind that class*
// still carries the actual fix — an explicit, non-trivial width/min-width
// and flex-shrink: 0 — and that the columns those inputs live in are still
// wide enough to hold them without re-introducing the overlap failure mode
// (the End Time editor visually painting over Duration/Start Time) that
// showed up once the input itself could no longer collapse. Real rendering
// was confirmed separately against real macOS Safari at desktop,
// ~1040px-narrow, and iPad-portrait widths — see index.css's own comments
// on .inputs-time-input and .inputs-logs-table for the investigation notes.
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const rawCss = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
// Several of this file's own rules (e.g. .inputs-logs-table below) quote
// OTHER selector/declaration snippets — including literal "{"/"}" — inside
// their explanatory comments. A naive "stop at the first }" match breaks on
// those, so comments are stripped before any rule is located/parsed.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openBrace = css.search(new RegExp(escaped + "\\s*\\{"));
  expect(openBrace, `expected a CSS rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", openBrace) + 1;
  const bodyEnd = css.indexOf("}", bodyStart);
  return css.slice(bodyStart, bodyEnd);
}

function pxValue(declarationBody: string, property: string): number {
  const match = declarationBody.match(new RegExp(`${property}\\s*:\\s*(\\d+)px`));
  expect(match, `expected ${property} to be an explicit px value`).not.toBeNull();
  return Number(match![1]);
}

describe(".inputs-time-input — non-collapsing sizing", () => {
  const body = ruleBody(".inputs-time-input");

  it("sets an explicit width, not a percentage or auto", () => {
    expect(pxValue(body, "width")).toBeGreaterThanOrEqual(100);
  });

  it("sets min-width to the same floor as width, so it can never shrink below it", () => {
    const width = pxValue(body, "width");
    const minWidth = pxValue(body, "min-width");
    expect(minWidth).toBe(width);
  });

  it("sets flex-shrink: 0 — the actual mechanism that stops it from absorbing 100% of a flex row's space deficit", () => {
    expect(body).toMatch(/flex-shrink\s*:\s*0\b/);
  });
});

describe("Start Time / End Time columns — room for the non-collapsing input", () => {
  it("gives .inputs-col-starttime enough width for .inputs-time-input plus the cell's own padding", () => {
    const inputWidth = pxValue(ruleBody(".inputs-time-input"), "width");
    const colWidth = pxValue(ruleBody(".inputs-col-starttime"), "width");
    expect(colWidth).toBeGreaterThanOrEqual(inputWidth);
  });

  it("gives .inputs-col-endtime enough width for the input, with Save/Cancel wrapping under it instead of beside it", () => {
    const inputWidth = pxValue(ruleBody(".inputs-time-input"), "width");
    const colWidth = pxValue(ruleBody(".inputs-col-endtime"), "width");
    expect(colWidth).toBeGreaterThanOrEqual(inputWidth);
    // The End Time cell holds the input AND two buttons. Rather than a
    // ~305px column, the editor wraps the buttons onto their own line, so
    // it never overflows left and covers Duration/Start Time.
    const editorBody = ruleBody(".inputs-endtime-editor,\n.inputs-time-editor");
    expect(editorBody).toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it("has no Actions column any more — deleting moved to the section headers", () => {
    expect(css).not.toMatch(/\.inputs-col-actions\b/);
    expect(css).not.toMatch(/\.inputs-th-actions\b/);
  });
});

describe(".inputs-logs-table — floor wide enough to avoid crushing, scrolls instead below it", () => {
  it("sets min-width to at least the sum of every column's own width", () => {
    const columns = [
      ".inputs-col-select",
      ".inputs-col-activity",
      ".inputs-col-row",
      ".inputs-col-carrier",
      ".inputs-col-speed",
      ".inputs-col-starttime",
      ".inputs-col-duration",
      ".inputs-col-endtime",
    ];
    const sum = columns.reduce((total, selector) => total + pxValue(ruleBody(selector), "width"), 0);
    const tableMinWidth = pxValue(ruleBody(".inputs-logs-table"), "min-width");
    expect(tableMinWidth).toBeGreaterThanOrEqual(sum);
  });

  it("keeps the horizontal-scroll container that reveals overflow instead of the table shrinking below its columns' widths", () => {
    const scrollBody = ruleBody(".inputs-logs-table-scroll");
    expect(scrollBody).toMatch(/overflow-x\s*:\s*auto/);
  });
});

describe(".inputs-workday-table — every column sized, so spare width is spread across all of them", () => {
  it("gives the name column an explicit width (a width-less one absorbed all the spare room and bunched the times on the right)", () => {
    expect(pxValue(ruleBody(".inputs-workday-col-name"), "width")).toBeGreaterThan(0);
  });

  it("sets min-width to at least the sum of every column's own width", () => {
    const sum =
      pxValue(ruleBody(".inputs-col-select"), "width") +
      pxValue(ruleBody(".inputs-workday-col-name"), "width") +
      2 * pxValue(ruleBody(".inputs-workday-col-time"), "width") +
      2 * pxValue(ruleBody(".inputs-workday-col-duration"), "width");
    expect(pxValue(ruleBody(".inputs-workday-table"), "min-width")).toBeGreaterThanOrEqual(sum);
  });
});
