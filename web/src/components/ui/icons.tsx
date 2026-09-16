// Tiny shared inline icons — plain currentColor strokes so they inherit
// whatever text color the button/control around them already uses (active
// vs. inactive, hover, disabled), rather than each caller hardcoding a fill.
// Used by EmploymentTimelineTab's export/print buttons and
// MultiSelectFilterDropdown's chevron; add to this file instead of inlining
// another one-off SVG elsewhere.

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5v8.5m0 0L4.5 6.5M8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PrintIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 5.5v-3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="2" y="5.5" width="12" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 9.5h7v4a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" className={className}>
      <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
