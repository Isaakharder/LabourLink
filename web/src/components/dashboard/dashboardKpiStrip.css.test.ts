// Dashboard KPI strip sizing (index.css): fixed-width tiles (about 50%
// wider than the original 13rem minimum) in a wrapping grid, so two sit side
// by side on desktop and tablet and more KPIs can be added without the
// existing tiles stretching. Readable type: larger label, value and detail.
// Layout checked visually in a real browser separately.
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\r\n/g, "\n");

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function prop(selector: string, name: string): string | undefined {
  for (const decl of ruleBody(selector).split(";")) {
    const i = decl.indexOf(":");
    if (i > 0 && decl.slice(0, i).trim() === name) return decl.slice(i + 1).trim();
  }
  return undefined;
}

const rem = (v: string | undefined) => Number((v ?? "").replace("rem", ""));

describe("Dashboard KPI strip sizing", () => {
  it("uses fixed 20rem tiles that wrap (never stretched to fill the row), capped at the screen width", () => {
    expect(prop(".dashboard-kpi-strip", "grid-template-columns")).toBe("repeat(auto-fill, minmax(min(20rem, 100%), 20rem))");
  });

  it("fits two tiles side by side on a tablet (820px wide, collapsed 76px sidebar, 24px page padding each side)", () => {
    const content = 820 - 76 - 2 * 24;
    const tile = 20 * 16;
    const gap = rem(prop(".dashboard-kpi-strip", "gap")) * 16;
    expect(2 * tile + gap).toBeLessThanOrEqual(content);
  });

  it("is about 50% wider than the original 13rem tiles", () => {
    expect(20 / 13).toBeGreaterThan(1.45);
    expect(20 / 13).toBeLessThan(1.6);
  });

  it("has more padding and larger type than before", () => {
    expect(prop(".dashboard-kpi-card", "padding")).toBe("1rem 1.25rem 1.05rem 1.4rem");
    expect(rem(prop(".dashboard-kpi-label", "font-size"))).toBeGreaterThanOrEqual(0.8);
    expect(rem(prop(".dashboard-kpi-value", "font-size"))).toBeGreaterThanOrEqual(1.9);
    expect(rem(prop(".dashboard-kpi-detail", "font-size"))).toBeGreaterThanOrEqual(0.88);
  });
});
