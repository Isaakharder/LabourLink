// Inputs: Up/Down arrows move through the employees listed in the sidebar
// (see InputsPage). Kept separate from isTypingTarget.ts on purpose: that
// helper lets keys through on checkboxes and other non-text controls, but
// here an arrow key must be left alone on anything that already uses it —
// a checkbox, radio, select, slider, any input, the date calendar, a menu —
// and while any dialog is open.

const ARROW_ROLES = new Set([
  "combobox",
  "dialog",
  "grid",
  "listbox",
  "menu",
  "menubar",
  "radiogroup",
  "slider",
  "spinbutton",
  "tablist",
  "textbox",
  "tree",
  "treegrid",
]);

function ownsArrowKeys(el: Element | null): boolean {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if ((node as HTMLElement).isContentEditable) return true;
    const role = node.getAttribute("role");
    if (role && ARROW_ROLES.has(role)) return true;
  }
  return false;
}

// "Up"/"Down" when this key press should move the employee selection,
// otherwise null (the browser or the focused control keeps the key).
export function employeeArrowDirection(e: KeyboardEvent): "up" | "down" | null {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return null;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (ownsArrowKeys(e.target instanceof Element ? e.target : null)) return null;
  if (ownsArrowKeys(document.activeElement)) return null;
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return null;
  return e.key === "ArrowUp" ? "up" : "down";
}

// The id to select next among `orderedIds` (top-to-bottom, as listed), or
// null to stay put: no wrap-around at either end. With nothing visible
// selected yet, Down starts at the top and Up at the bottom.
export function nextEmployeeId(orderedIds: string[], currentId: string | null, direction: "up" | "down"): string | null {
  if (orderedIds.length === 0) return null;
  const index = currentId ? orderedIds.indexOf(currentId) : -1;
  if (index === -1) return direction === "down" ? orderedIds[0] : orderedIds[orderedIds.length - 1];
  const next = direction === "down" ? index + 1 : index - 1;
  return next >= 0 && next < orderedIds.length ? orderedIds[next] : null;
}
