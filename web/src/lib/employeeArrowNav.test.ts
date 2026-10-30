// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { employeeArrowDirection, nextEmployeeId } from "./employeeArrowNav";

afterEach(() => {
  document.body.innerHTML = "";
});

function keyOn(target: Element, key = "ArrowDown", init: KeyboardEventInit = {}) {
  let direction: ReturnType<typeof employeeArrowDirection> = null;
  const listener = (e: Event) => (direction = employeeArrowDirection(e as KeyboardEvent));
  window.addEventListener("keydown", listener);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  window.removeEventListener("keydown", listener);
  return direction;
}

describe("employeeArrowDirection", () => {
  it("handles plain Up/Down on the page or on a button", () => {
    expect(keyOn(document.body, "ArrowDown")).toBe("down");
    expect(keyOn(document.body, "ArrowUp")).toBe("up");
    const button = document.body.appendChild(document.createElement("button"));
    button.focus();
    expect(keyOn(button)).toBe("down");
    expect(keyOn(document.body, "ArrowLeft")).toBeNull();
  });

  it("leaves the keys to every control that uses them", () => {
    const html = [
      '<input type="checkbox">',
      '<input type="radio">',
      '<input type="time">',
      "<select></select>",
      "<textarea></textarea>",
      '<div contenteditable="true" tabindex="0"></div>',
      '<div role="listbox" tabindex="0"></div>',
      '<div role="radiogroup"><button>a</button></div>',
      '<div role="grid"><button>a</button></div>',
      '<div role="slider" tabindex="0"></div>',
    ];
    for (const markup of html) {
      document.body.innerHTML = markup;
      const el = (document.body.querySelector("button") ?? document.body.firstElementChild) as HTMLElement;
      // jsdom has no layout, so contenteditable must be faked.
      if (markup.includes("contenteditable")) Object.defineProperty(el, "isContentEditable", { value: true });
      el.focus();
      expect(keyOn(el), markup).toBeNull();
    }
  });

  it("does nothing while a dialog is open", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(keyOn(document.body)).toBeNull();
  });
});

describe("nextEmployeeId", () => {
  const ids = ["a", "b", "c"];
  it("steps and stops at either end without wrapping", () => {
    expect(nextEmployeeId(ids, "a", "down")).toBe("b");
    expect(nextEmployeeId(ids, "b", "up")).toBe("a");
    expect(nextEmployeeId(ids, "a", "up")).toBeNull();
    expect(nextEmployeeId(ids, "c", "down")).toBeNull();
  });
  it("starts from the top (Down) or bottom (Up) when the selection isn't listed", () => {
    expect(nextEmployeeId(ids, "zz", "down")).toBe("a");
    expect(nextEmployeeId(ids, null, "up")).toBe("c");
    expect(nextEmployeeId([], "a", "down")).toBeNull();
  });
});
