import { createContext, ReactNode, useCallback, useContext, useRef } from "react";

interface UnsavedChangesContextValue {
  // Returns true if it's safe to proceed (nothing dirty, or the user
  // confirmed leaving anyway) — false means the caller should abort
  // whatever navigation it was about to perform.
  confirmNavigation: () => boolean;
  setUnsavedChanges: (dirty: boolean, message?: string) => void;
}

const DEFAULT_MESSAGE = "You have unsaved changes. Leave without saving?";

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

// Scoped, honest alternative to react-router's useBlocker/unstable_usePrompt
// (which require a data router — createBrowserRouter/RouterProvider — a
// separate, larger migration this repo doesn't use; see App.tsx's plain
// BrowserRouter). This only guards navigation that goes through
// confirmNavigation() — the sidebar's NavItem links and the Sign Out button
// — NOT browser back/forward or any other programmatic navigate() call.
// window.beforeunload (see individual pages) remains the only guard for a
// hard reload/tab-close/external navigation.
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirtyRef = useRef(false);
  const messageRef = useRef(DEFAULT_MESSAGE);

  const setUnsavedChanges = useCallback((dirty: boolean, message?: string) => {
    dirtyRef.current = dirty;
    messageRef.current = message ?? DEFAULT_MESSAGE;
  }, []);

  const confirmNavigation = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(messageRef.current);
  }, []);

  return (
    <UnsavedChangesContext.Provider value={{ confirmNavigation, setUnsavedChanges }}>
      {children}
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChangesGuard() {
  const ctx = useContext(UnsavedChangesContext);
  if (!ctx) throw new Error("useUnsavedChangesGuard must be used within UnsavedChangesProvider");
  return ctx;
}
