// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlantSplitTrainer } from "./PlantSplitTrainer";
import { GROW_CYCLE_MS, GROW_DURATION_MS, REWIND_DURATION_MS, UNDO_CYCLE_MS, UNDO_DURATION_MS } from "./usePlantGrowth";
import { FALL_DURATION_MS } from "./plantCuts";

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

const svg = () => document.querySelector("svg.plant-canvas")!;
/** Leaders that grew straight out of the crown (not later child shoots). */
const leaderCount = () =>
  [...document.querySelectorAll('[data-kind="leader"]')].filter((el) => /^leader-\d+$/.test(el.getAttribute("data-part")!)).length;
const shootCount = () => document.querySelectorAll('[data-kind="leader"]').length;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const button = (name: string) => screen.getByRole("button", { name });
const hits = (stemId: string) => [...document.querySelectorAll<SVGPathElement>(`[data-testid="plant-stem-hit"][data-stem="${stemId}"]`)];
const pieces = () => document.querySelectorAll("[data-piece]");
const leafIds = () => [...document.querySelectorAll('[data-kind="leaf"]')].map((el) => el.getAttribute("data-part")!);

function growTo(mode: "2 split" | "3 split") {
  fireEvent.click(button(mode));
  advance(GROW_DURATION_MS + 100);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance", "Date"] });
  setReducedMotion(false);
  consoleError = vi.spyOn(console, "error");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // No React warnings (act, unmounted setState, keys…) during any test.
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

describe("PlantSplitTrainer", () => {
  it("starts with both split choices and no Undo", () => {
    render(<PlantSplitTrainer />);
    expect(button("2 split")).toBeEnabled();
    expect(button("3 split")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(svg()).toHaveAttribute("data-growth", "0.000");
    expect(screen.getByTestId("plant-ruler")).toBeInTheDocument();
  });

  it("disables both buttons while growing, then shows Undo", () => {
    render(<PlantSplitTrainer />);
    fireEvent.click(button("2 split"));
    expect(button("2 split")).toBeDisabled();
    expect(button("3 split")).toBeDisabled();

    advance(GROW_DURATION_MS / 2);
    const mid = Number(svg().getAttribute("data-growth"));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    advance(GROW_DURATION_MS);
    expect(svg()).toHaveAttribute("data-growth", "1.000");
    expect(screen.queryByRole("button", { name: "2 split" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "3 split" })).not.toBeInTheDocument();
    expect(button("Undo")).toBeEnabled();
    expect(leaderCount()).toBe(2);
  });

  it("ignores rapid repeated clicks instead of starting overlapping animations", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<PlantSplitTrainer />);
    const two = button("2 split");
    const three = button("3 split");
    act(() => {
      // Same tick, before React re-renders the disabled state.
      two.click();
      three.click();
      two.click();
    });
    expect(raf).toHaveBeenCalledTimes(1);
    advance(GROW_DURATION_MS + 100);
    expect(leaderCount()).toBe(2);

    const undo = button("Undo");
    act(() => {
      undo.click();
      undo.click();
    });
    advance(UNDO_DURATION_MS + 100);
    expect(svg()).toHaveAttribute("data-growth", "0.000");
    raf.mockRestore();
  });

  it("grows three leaders for a 3 split", () => {
    render(<PlantSplitTrainer />);
    fireEvent.click(button("3 split"));
    advance(GROW_DURATION_MS + 100);
    expect(leaderCount()).toBe(3);
  });

  it("Undo animates back to the exact starting plant, then offers both splits again", () => {
    render(<PlantSplitTrainer />);
    const startMarkup = svg().innerHTML;

    for (const mode of ["2 split", "3 split", "2 split"]) {
      fireEvent.click(button(mode));
      advance(GROW_DURATION_MS + 100);
      fireEvent.click(button("Undo"));
      expect(button("Undo")).toBeDisabled();
      advance(UNDO_DURATION_MS / 2);
      const mid = Number(svg().getAttribute("data-growth"));
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      advance(UNDO_DURATION_MS);
      expect(svg().innerHTML).toBe(startMarkup);
      expect(button("2 split")).toBeEnabled();
      expect(button("3 split")).toBeEnabled();
    }
  });

  it("renders the same plant every time the same split is repeated", () => {
    render(<PlantSplitTrainer />);
    fireEvent.click(button("3 split"));
    advance(GROW_DURATION_MS + 100);
    const first = svg().innerHTML;
    fireEvent.click(button("Undo"));
    advance(UNDO_DURATION_MS + 100);
    fireEvent.click(button("3 split"));
    advance(GROW_DURATION_MS + 100);
    expect(svg().innerHTML).toBe(first);
  });

  it("shows the finished state immediately with prefers-reduced-motion", () => {
    setReducedMotion(true);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<PlantSplitTrainer />);
    const startMarkup = svg().innerHTML;

    fireEvent.click(button("2 split"));
    expect(svg()).toHaveAttribute("data-growth", "1.000");
    expect(leaderCount()).toBe(2);
    expect(button("Undo")).toBeEnabled();

    fireEvent.click(button("Undo"));
    expect(svg().innerHTML).toBe(startMarkup);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it("cancels its animation frame when unmounted mid-growth", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { unmount } = render(<PlantSplitTrainer />);
    fireEvent.click(button("2 split"));
    advance(500);
    unmount();
    expect(cancel).toHaveBeenCalled();
    const callsAtUnmount = raf.mock.calls.length;
    advance(GROW_DURATION_MS);
    expect(raf.mock.calls.length).toBe(callsAtUnmount);
    expect(vi.getTimerCount()).toBe(0);
    cancel.mockRestore();
    raf.mockRestore();
  });

  describe("cutting", () => {
    it("offers no cutting until the plant has grown", () => {
      render(<PlantSplitTrainer />);
      expect(document.querySelectorAll('[data-testid="plant-stem-hit"]')).toHaveLength(0);
      fireEvent.click(button("2 split"));
      advance(GROW_DURATION_MS / 2);
      expect(document.querySelectorAll('[data-testid="plant-stem-hit"]')).toHaveLength(0);
      advance(GROW_DURATION_MS);
      expect(hits("main-stem").length).toBeGreaterThanOrEqual(3);
      // Every stem in the branching tree is cuttable.
      for (const id of ["leader-1", "leader-2", "leader-1.1", "leader-1.2", "leader-2.1", "leader-2.2"]) {
        expect(hits(id).length, id).toBeGreaterThanOrEqual(2);
      }
    });

    for (const [mode, count] of [["2 split", 2], ["3 split", 3]] as const) {
      for (let li = 1; li <= count; li++) {
        it(`double-clicking leader ${li} (${mode}) drops only that leader's top, which then leaves`, () => {
          render(<PlantSplitTrainer />);
          growTo(mode);
          const before = leafIds();
          const segs = hits(`leader-${li}`);
          fireEvent.doubleClick(segs[Math.floor(segs.length / 2)]);

          // The piece holds its shape first, then falls; no cutting meanwhile.
          expect(pieces()).toHaveLength(1);
          expect(document.querySelectorAll('[data-testid="plant-stem-hit"]')).toHaveLength(0);
          expect(button("Undo")).toBeDisabled();
          advance(FALL_DURATION_MS / 2);
          expect(pieces()[0].getAttribute("transform")).toMatch(/translate\([-\d.]+ [1-9]/);

          advance(FALL_DURATION_MS);
          expect(pieces()).toHaveLength(0); // gone once out of frame
          const after = leafIds();
          expect(after.length).toBeLessThan(before.length);
          expect(after.some((id) => id.includes(`leader-${li}-tip`))).toBe(false);
          for (let other = 1; other <= count; other++) {
            if (other !== li) expect(after.some((id) => id.includes(`leader-${other}-tip`))).toBe(true);
          }
          expect(document.querySelector(`[data-part="leader-${li}"]`)).toBeInTheDocument(); // the stub stays
          expect(screen.getAllByTestId("plant-cut-face")).toHaveLength(1);
          expect(button("Undo")).toBeEnabled();
        });
      }
    }

    it("a main-stem cut below the crown drops the crown and every leader together", () => {
      render(<PlantSplitTrainer />);
      growTo("3 split");
      const segs = hits("main-stem");
      fireEvent.doubleClick(segs[segs.length - 1]);
      const piece = pieces()[0];
      for (const id of ["leader-1", "leader-2", "leader-3", "leader-1.1", "leader-2.2", "leader-3.1", "bud-crown", "bud-leader-2"]) {
        expect(piece.querySelector(`[data-part="${id}"]`), id).toBeInTheDocument();
      }
      advance(FALL_DURATION_MS + 50);
      expect(pieces()).toHaveLength(0);
      expect(document.querySelectorAll('[data-kind="leader"]')).toHaveLength(0);
      expect(document.querySelector('[data-part="bud-crown"]')).not.toBeInTheDocument();
      expect(document.querySelector('[data-part="main-stem"]')).toBeInTheDocument();
      expect(leafIds().every((id) => id.startsWith("leaf-main-") || id.startsWith("leaf-crown-"))).toBe(true);
    });

    it("double-clicking a secondary child shoot drops only that child", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      const segs = hits("leader-2.2");
      fireEvent.doubleClick(segs[segs.length - 1]);
      const piece = pieces()[0];
      expect(piece.querySelector('[data-part="leader-2.2~upper"]')).toBeInTheDocument();
      expect(piece.querySelector('[data-part="leader-2.1"]')).not.toBeInTheDocument();
      advance(FALL_DURATION_MS + 50);
      expect(document.querySelector('[data-part="leader-2.1"]')).toBeInTheDocument();
      expect(document.querySelector('[data-part="bud-leader-2"]')).toBeInTheDocument();
      expect(leafIds().some((id) => id.startsWith("leaf-leader-2.2-tip"))).toBe(false);
      expect(leafIds().some((id) => id.startsWith("leaf-leader-2-tip"))).toBe(true); // sibling's head
    });

    it("double-clicking just below a later fork drops the fork and all its shoots together", () => {
      render(<PlantSplitTrainer />);
      growTo("3 split");
      const segs = hits("leader-3");
      fireEvent.doubleClick(segs[segs.length - 1]);
      const piece = pieces()[0];
      for (const id of ["leader-3.1", "leader-3.2", "bud-leader-3"]) {
        expect(piece.querySelector(`[data-part="${id}"]`), id).toBeInTheDocument();
      }
      advance(FALL_DURATION_MS + 50);
      expect(pieces()).toHaveLength(0);
      expect(document.querySelector('[data-part="leader-3.1"]')).not.toBeInTheDocument();
      expect(document.querySelector('[data-part="leader-3"]')).toBeInTheDocument();
      expect(shootCount()).toBe(7);
    });

    it("ignores extra cuts while a piece is falling, including rapid double-clicks", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      const a = hits("leader-1")[1];
      const b = hits("leader-2")[1];
      const c = hits("main-stem")[2];
      act(() => {
        // All in one tick, before React removes the targets.
        fireEvent.doubleClick(a);
        fireEvent.doubleClick(a);
        fireEvent.doubleClick(b);
        fireEvent.doubleClick(c);
      });
      expect(pieces()).toHaveLength(1);
      advance(FALL_DURATION_MS / 3);
      fireEvent.doubleClick(b); // stale element mid-fall
      advance(FALL_DURATION_MS);
      expect(pieces()).toHaveLength(0);
      expect(leafIds().some((id) => id.includes("leader-2-tip"))).toBe(true);
      // leader-1 stub + leader-2 and its two children; leader-1's children fell.
      expect(shootCount()).toBe(4);
      expect(screen.getAllByTestId("plant-cut-face")).toHaveLength(1);
    });

    it("allows another cut once the previous piece has gone", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      fireEvent.doubleClick(hits("leader-1")[2]);
      advance(FALL_DURATION_MS + 50);
      fireEvent.doubleClick(hits("leader-2")[2]);
      expect(pieces()).toHaveLength(1);
      advance(FALL_DURATION_MS + 50);
      expect(screen.getAllByTestId("plant-cut-face")).toHaveLength(2);
    });

    it("Undo clears every cut and returns the identical uncut starting plant", () => {
      render(<PlantSplitTrainer />);
      const startMarkup = svg().innerHTML;
      growTo("3 split");
      const grownMarkup = svg().innerHTML;
      fireEvent.doubleClick(hits("leader-3")[2]);
      advance(FALL_DURATION_MS + 50);
      const segs = hits("main-stem");
      fireEvent.doubleClick(segs[segs.length - 1]);
      advance(FALL_DURATION_MS + 50);

      fireEvent.click(button("Undo"));
      expect(button("Undo")).toBeDisabled();
      advance(REWIND_DURATION_MS / 2);
      expect(pieces().length).toBe(2); // pieces rewinding back into place
      advance(REWIND_DURATION_MS / 2 + 20);
      advance(UNDO_DURATION_MS + 100);
      expect(svg().innerHTML).toBe(startMarkup);
      expect(button("2 split")).toBeEnabled();
      expect(button("3 split")).toBeEnabled();

      // Same split again: identical uncut plant, and the same cut repeats exactly.
      growTo("3 split");
      expect(svg().innerHTML).toBe(grownMarkup);
    });

    it("repeats the same cut with identical geometry", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      fireEvent.doubleClick(hits("leader-1")[2]);
      advance(FALL_DURATION_MS + 50);
      const first = svg().innerHTML;
      fireEvent.click(button("Undo"));
      advance(REWIND_DURATION_MS + UNDO_DURATION_MS + 200);
      growTo("2 split");
      fireEvent.doubleClick(hits("leader-1")[2]);
      advance(FALL_DURATION_MS + 50);
      expect(svg().innerHTML).toBe(first);
    });

    it("cuts instantly with prefers-reduced-motion", () => {
      setReducedMotion(true);
      render(<PlantSplitTrainer />);
      fireEvent.click(button("2 split"));
      const before = leafIds().length;
      fireEvent.doubleClick(hits("leader-1")[1]);
      expect(pieces()).toHaveLength(0);
      expect(leafIds().length).toBeLessThan(before);
      expect(button("Undo")).toBeEnabled();
    });
  });

  describe("Grow 30 cm", () => {
    const growOnce = () => {
      fireEvent.click(button("Grow 30 cm"));
      advance(GROW_CYCLE_MS + 50);
    };
    const growth = () => Number(svg().getAttribute("data-growth"));
    const stagesOf = () =>
      Object.fromEntries([...document.querySelectorAll('[data-kind="bud"]')].map((el) => [el.getAttribute("data-part"), el.getAttribute("data-stage")]));
    /** Trainee pruning between presses: double-click every second (".2")
     *  shoot that is still growing, so only the selected leaders continue. */
    const pruneLaterals = () => {
      for (let guard = 0; guard < 60; guard++) {
        const target = [...document.querySelectorAll('[data-kind="leader"]')]
          .map((el) => el.getAttribute("data-part")!)
          .find((id) => /\.2$/.test(id) && !document.querySelector(`[data-part="${id}"] [data-testid="plant-cut-face"]`) && hits(id).length > 0);
        if (!target) return;
        fireEvent.doubleClick(hits(target)[0]);
        advance(FALL_DURATION_MS + 50);
      }
    };
    const tipCount = () => new Set(leafIds().filter((id) => id.includes("-tip-")).map((id) => id.replace(/-tip-\d+$/, ""))).size;

    it("appears with Undo once the first split has grown", () => {
      render(<PlantSplitTrainer />);
      expect(screen.queryByRole("button", { name: "Grow 30 cm" })).not.toBeInTheDocument();
      fireEvent.click(button("2 split"));
      advance(GROW_DURATION_MS / 2);
      expect(screen.queryByRole("button", { name: "Grow 30 cm" })).not.toBeInTheDocument();
      advance(GROW_DURATION_MS);
      expect(button("Grow 30 cm")).toBeEnabled();
      expect(button("Undo")).toBeEnabled();
      expect(screen.queryByRole("button", { name: "2 split" })).not.toBeInTheDocument();
    });

    it("animates one cycle per press, disabling the controls meanwhile, five times over", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      for (let k = 1; k <= 5; k++) {
        pruneLaterals();
        fireEvent.click(button("Grow 30 cm"));
        expect(button("Grow 30 cm")).toBeDisabled();
        expect(button("Undo")).toBeDisabled();
        expect(document.querySelectorAll('[data-testid="plant-stem-hit"]')).toHaveLength(0);
        advance(GROW_CYCLE_MS / 2);
        expect(growth()).toBeGreaterThan(k);
        expect(growth()).toBeLessThan(k + 1);
        advance(GROW_CYCLE_MS / 2 + 50);
        expect(growth()).toBe(k + 1);
        expect(screen.getByRole("status")).toHaveTextContent(`Growth cycle ${k} · +${30 * k} cm`);
        expect(button("Grow 30 cm")).toBeEnabled();
      }
      // Both selected leaders kept their heads all the way up.
      expect(leafIds().some((id) => id.startsWith("leaf-leader-1-tip"))).toBe(true);
      expect(leafIds().some((id) => id.startsWith("leaf-leader-2-tip"))).toBe(true);
    });

    it("gives both children of a new fork their own growing head, and grows both", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      const tips0 = tipCount();
      expect(tips0).toBe(4);
      growOnce();
      const tips1 = tipCount();
      expect(tips1).toBeGreaterThan(tips0 * 2); // unpruned branching multiplies tips
      expect(leafIds()).toContain("leaf-leader-1.1.2-tip-1"); // the lateral child's own head
      // Height of the lateral's own head: the start of its first tip leaf.
      const headY = () => {
        const d = document.querySelector('[data-part="leaf-leader-1.1.2-tip-1"] path')!.getAttribute("d")!;
        return Number(/^M[-\d.]+ ([-\d.]+)/.exec(d)![1]);
      };
      const before = headY();
      growOnce();
      expect(before - headY()).toBeGreaterThan(150); // it kept growing upward
      expect(document.querySelector('[data-part="leader-1.1.2.1"]')).toBeInTheDocument(); // and forked
    });

    it("ignores rapid repeated Grow presses", () => {
      const raf = vi.spyOn(window, "requestAnimationFrame");
      render(<PlantSplitTrainer />);
      growTo("2 split");
      raf.mockClear();
      const grow = button("Grow 30 cm");
      act(() => {
        grow.click();
        grow.click();
        grow.click();
      });
      expect(raf).toHaveBeenCalledTimes(1);
      advance(GROW_CYCLE_MS + 50);
      expect(growth()).toBe(2);
      raf.mockRestore();
    });

    it("advances reproductive stages one step per press; new buds stay buds", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      expect(stagesOf()["bud-leader-1"]).toBe("bud");
      pruneLaterals();
      growOnce();
      const one = stagesOf();
      expect(one["bud-crown"]).toBe("flower");
      expect(one["bud-leader-1"]).toBe("flower");
      expect(one["bud-leader-1.1"]).toBe("bud"); // formed during this press
      pruneLaterals();
      growOnce();
      pruneLaterals();
      growOnce();
      const three = stagesOf();
      expect(three["bud-leader-1"]).toBe("large-fruit");
      expect(three["bud-leader-1.1"]).toBe("small-fruit");
      expect(new Set(Object.values(three))).toEqual(new Set(["bud", "flower", "small-fruit", "large-fruit"]));
      pruneLaterals();
      growOnce();
      expect(stagesOf()["bud-leader-1"]).toBe("large-fruit");
    });

    it("keeps cut branches gone and cut ends unchanged through later cycles", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      fireEvent.doubleClick(hits("leader-1.2")[1]);
      advance(FALL_DURATION_MS + 50);
      const stub = document.querySelector('[data-part="leader-1.2"]')!.innerHTML;
      for (let k = 0; k < 3; k++) {
        pruneLaterals();
        growOnce();
      }
      expect(document.querySelector('[data-part="leader-1.2"]')!.innerHTML).toBe(stub);
      expect(document.querySelector('[data-part^="leader-1.2."]')).not.toBeInTheDocument();
      expect(leafIds().some((id) => id.startsWith("leaf-leader-1.2-tip"))).toBe(false);
      expect(leafIds().some((id) => id.startsWith("leaf-leader-1-tip"))).toBe(true); // neighbour grew on
    });

    it("drops a fruit-bearing branch whole, fruit included", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      for (let k = 0; k < 3; k++) {
        pruneLaterals();
        growOnce();
      }
      const segs = hits("leader-1");
      fireEvent.doubleClick(segs[segs.length - 1]);
      const piece = pieces()[0];
      expect(piece.querySelector('[data-part="bud-leader-1"]')).toHaveAttribute("data-stage", "large-fruit");
      advance(FALL_DURATION_MS + 50);
      expect(document.querySelector('[data-part="bud-leader-1"]')).not.toBeInTheDocument();
      expect(document.querySelector('[data-part="bud-crown"]')).toHaveAttribute("data-stage", "large-fruit");
    });

    it("disables Grow with a short status once every growing tip is cut", () => {
      render(<PlantSplitTrainer />);
      growTo("3 split");
      growOnce();
      const segs = hits("main-stem");
      fireEvent.doubleClick(segs[segs.length - 1]);
      advance(FALL_DURATION_MS + 50);
      expect(button("Grow 30 cm")).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("No active growing tips.");
      fireEvent.click(button("Grow 30 cm"));
      expect(growth()).toBe(2);
      expect(button("Undo")).toBeEnabled();
    });

    it("keeps Grow available while at least one head survives", () => {
      render(<PlantSplitTrainer />);
      growTo("2 split");
      fireEvent.doubleClick(hits("leader-1")[1]);
      advance(FALL_DURATION_MS + 50);
      expect(button("Grow 30 cm")).toBeEnabled();
      growOnce();
      expect(growth()).toBe(2);
    });

    it("Undo plays back cycles and cuts to the identical starting plant", () => {
      render(<PlantSplitTrainer />);
      const startMarkup = svg().innerHTML;
      growTo("3 split");
      pruneLaterals();
      growOnce();
      pruneLaterals();
      growOnce();
      const segs = hits("leader-1");
      fireEvent.doubleClick(segs[segs.length - 1]);
      advance(FALL_DURATION_MS + 50);
      growOnce();

      fireEvent.click(button("Undo"));
      expect(button("Undo")).toBeDisabled();
      expect(button("Grow 30 cm")).toBeDisabled();
      advance(UNDO_CYCLE_MS + 20); // the last cycle shrinks away
      expect(growth()).toBe(3);
      advance(REWIND_DURATION_MS / 2); // the pieces cut at this stage fly back
      expect(pieces().length).toBeGreaterThan(0);
      advance(20 * (REWIND_DURATION_MS + UNDO_CYCLE_MS) + UNDO_DURATION_MS);
      expect(svg().innerHTML).toBe(startMarkup);
      expect(button("2 split")).toBeEnabled();
      expect(button("3 split")).toBeEnabled();
    });

    it("replays the same split, grows and cuts identically", () => {
      const play = () => {
        const { unmount } = render(<PlantSplitTrainer />);
        growTo("2 split");
        pruneLaterals();
        growOnce();
        pruneLaterals();
        growOnce();
        fireEvent.doubleClick(hits("leader-1.1")[1]);
        advance(FALL_DURATION_MS + 50);
        growOnce();
        const markup = svg().outerHTML.replace(/plant-frame-[^"#)\s]+/g, "ID");
        unmount();
        return markup;
      };
      expect(play()).toBe(play());
    });

    it("stops its animation loop and timers when unmounted mid-cycle", () => {
      const cancel = vi.spyOn(window, "cancelAnimationFrame");
      const raf = vi.spyOn(window, "requestAnimationFrame");
      const { unmount } = render(<PlantSplitTrainer />);
      growTo("2 split");
      fireEvent.click(button("Grow 30 cm"));
      advance(500);
      unmount();
      expect(cancel).toHaveBeenCalled();
      const calls = raf.mock.calls.length;
      advance(GROW_CYCLE_MS);
      expect(raf.mock.calls.length).toBe(calls);
      expect(vi.getTimerCount()).toBe(0);
      cancel.mockRestore();
      raf.mockRestore();
    });

    it("grows a whole cycle instantly with prefers-reduced-motion", () => {
      setReducedMotion(true);
      const raf = vi.spyOn(window, "requestAnimationFrame");
      render(<PlantSplitTrainer />);
      fireEvent.click(button("2 split"));
      fireEvent.click(button("Grow 30 cm"));
      expect(growth()).toBe(2);
      expect(raf).not.toHaveBeenCalled();
      raf.mockRestore();
    });
  });
});
