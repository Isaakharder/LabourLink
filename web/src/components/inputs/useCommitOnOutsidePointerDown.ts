import { useEffect, useRef } from "react";

// Inputs time editors save when the admin presses anywhere outside them —
// the "click elsewhere" half of Enter-or-click-away saving. The editor's own
// elements carry data-time-editor={editorKey} (an activity run's editor spans
// both its Start and End cells, so moving between those two inputs is not
// "elsewhere"); a press inside them, including on Save/Cancel, is left alone.
//
// pointerdown in the capture phase, so it fires before any row/cell click
// handler (and regardless of stopPropagation there): the edit is committed
// first, then the press goes on to do whatever it normally does.
export function useCommitOnOutsidePointerDown(active: boolean, editorKey: string, onCommit: () => void) {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!active) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Element && target.closest(`[data-time-editor="${editorKey}"]`)) return;
      onCommitRef.current();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [active, editorKey]);
}
