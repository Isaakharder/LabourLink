import { Component, ErrorInfo, ReactNode } from "react";

// Top-level safety net. Without it, any exception thrown while rendering
// unmounts the entire React tree and leaves a blank white page with no way
// out except killing the app — one of the white-screen paths found while
// investigating the Ulefone morning-startup reports (2026-10-01).
//
// Retry is a plain page reload: it never touches localStorage, IndexedDB,
// or the local SQLite event store, so the paired-device identity and any
// pending offline events survive. Same markup/classes as boot-guard.js's
// pre-React error screen (styled inline in index.html), so the two look
// identical. The code shown is a fixed category plus a random reference
// that is also logged — never the raw error message.
interface Props {
  children: ReactNode;
}

interface State {
  code: string | null;
}

function errorCode(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const ref = Math.random().toString(36).slice(2, 8);
  return `RENDER-${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}-${ref}`;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { code: null };

  static getDerivedStateFromError(error: unknown): State {
    return { code: errorCode(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[app-error-boundary] ${this.state.code}:`, error, info.componentStack);
  }

  render() {
    if (this.state.code === null) return this.props.children;
    return (
      <div className="boot-screen" role="alert">
        <p className="boot-title">LabourLink couldn’t start</p>
        <p className="boot-text">Your saved work is safe on this phone. Tap Retry to try again.</p>
        <button type="button" className="boot-retry" onClick={() => window.location.reload()}>
          Retry
        </button>
        <p className="boot-code">Code: {this.state.code}</p>
      </div>
    );
  }
}
