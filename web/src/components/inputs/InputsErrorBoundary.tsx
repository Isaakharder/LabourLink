// Real incident this exists for: a server-computed field (endedAtCorrectedFrom)
// carried the literal string "null" instead of JSON null for a midnight-
// rollover-closed entry; the client formatted it as a date, which threw
// RangeError: Invalid time value during render — with nothing catching it,
// React unmounted the entire Inputs page, leaving it blank. That specific
// bug is fixed at its source (inputs.ts no longer emits that string), but
// this boundary is the general defense-in-depth requirement: no single
// malformed record should ever be able to take down more than the smallest
// section that actually depends on it, and every failure should carry a
// reference a person can act on instead of a silent blank screen.
import { Component, ErrorInfo, ReactNode } from "react";

interface InputsErrorBoundaryProps {
  children: ReactNode;
  // Clears a caught error the instant this changes — keyed by whatever
  // identifies "the data this boundary is showing" (e.g. `${employeeId}:${date}`
  // for the section-level boundary, `${date}:${runId}` for a per-row one).
  // Without this, one bad render would wedge this section/row in its
  // "Needs review" state even after navigating to a date/employee/entry
  // that renders fine — a full app reload should never be required to
  // recover, only a navigation away and back (or the underlying data
  // itself changing).
  resetKey: string;
  // Logged alongside the diagnostic id — e.g. "Inputs daily detail" or
  // "activity log row 5edc8b63-...".
  label: string;
  // Table rows need a <tr>/<td>-shaped fallback to stay valid HTML;
  // defaults to a generic block for section-level use.
  renderFallback?: (diagnosticId: string) => ReactNode;
}

interface InputsErrorBoundaryState {
  error: Error | null;
  diagnosticId: string;
}

// Short, human-relayable (readable over a phone call, fits in a bug
// report) — not a security token, just a way to correlate what a user
// saw with the exact console.error this boundary logged.
function newDiagnosticId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export class InputsErrorBoundary extends Component<InputsErrorBoundaryProps, InputsErrorBoundaryState> {
  state: InputsErrorBoundaryState = { error: null, diagnosticId: "" };

  static getDerivedStateFromError(error: Error): Partial<InputsErrorBoundaryState> {
    return { error, diagnosticId: newDiagnosticId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[InputsErrorBoundary] ${this.props.label} — ref ${this.state.diagnosticId}:`,
      error,
      "\nComponent stack:",
      info.componentStack
    );
  }

  componentDidUpdate(prevProps: InputsErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, diagnosticId: "" });
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.renderFallback) return this.props.renderFallback(this.state.diagnosticId);
      return (
        <div className="inputs-needs-review" role="alert">
          <p className="inputs-needs-review-title">Needs review</p>
          <p className="inputs-needs-review-detail">This couldn't be displayed due to an unexpected data issue.</p>
          <p className="inputs-needs-review-ref">Reference: {this.state.diagnosticId}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
