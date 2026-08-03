// True when the currently focused element is a genuine text-entry control
// (a text/number/etc. input, a textarea, or a select) — as opposed to a
// checkbox, radio, or button. Those don't consume typed characters, so
// merely holding focus on one (e.g. right after clicking a toggle like
// "Snap to grid") shouldn't block keyboard shortcuts the way it should for
// an actual text field.
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

export function isTypingIntoFormField(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (active as HTMLInputElement).type?.toLowerCase() || "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}
