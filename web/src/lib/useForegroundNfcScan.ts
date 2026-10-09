import { useCallback, useEffect, useRef, useState } from "react";
import { isNfcSupported, ScannedTag, startScanSession } from "./nfc";
import { isIosNativePlatform } from "./platform";

interface UseForegroundNfcScanOptions {
  // Whether scanning should be possible right now at all (e.g. a picker
  // sheet is open, HomeScreen's existing homeNfcActive gate, the
  // diagnostic screen's availability === "ok"). Flipping this false tears
  // down any open session immediately, on every platform.
  active: boolean;
  onTag: (tag: ScannedTag) => void;
  onError?: (message: string) => void;
  label: string;
  // iOS-only — shown in Apple's system scan sheet; ignored on Android/web.
  iosAlertMessage?: string;
}

interface ForegroundNfcScanState {
  // True whenever a native session is actually open right now. On
  // Android/web this simply tracks `active` once isNfcSupported() resolves
  // — the existing ambient, auto-starting behavior, completely unchanged.
  // On iOS it's only true between an explicit startScan() tap and that
  // one scan's session ending (a tag read, a cancel, a timeout, or an
  // error) — iOS has no continuous/ambient reader mode to mirror.
  scanning: boolean;
  // iOS only: true once NFC is supported and `active` is true, but no
  // session is open because nothing has been tapped yet — the UI should
  // show a "Scan Tag" affordance. Always false on Android/web (auto-starts
  // instead of ever waiting on a tap) and false whenever `scanning` is
  // already true.
  awaitingTap: boolean;
  // Starts exactly one scan attempt. Safe to call unconditionally — a
  // no-op if a session is already open. This is what an iOS "Scan Tag"
  // button's onClick calls; harmless (and redundant with the automatic
  // behavior) if ever called on Android/web.
  startScan: () => void;
}

// Shared by every screen that listens for a foreground NFC scan (HomeScreen,
// RowPickerSheet, CarrierPickerSheet, NfcDiagnosticScreen) — the ONE place
// the platform split lives: Android/web keep the exact ambient,
// auto-starting, no-visible-UI behavior this app has always had; iOS never
// auto-starts a scan at all, satisfying "every scan begins only after an
// employee taps a Scan/Register/Write action" (Apple's own system sheet is
// intrusive enough — a native app that pops it up without a preceding tap
// reads as broken, and Apple's review guidelines are exactly this strict
// about unsolicited system UI).
export function useForegroundNfcScan({
  active,
  onTag,
  onError,
  label,
  iosAlertMessage,
}: UseForegroundNfcScanOptions): ForegroundNfcScanState {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    isNfcSupported().then((s) => {
      if (!cancelled) setSupported(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [scanning, setScanning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  // Kept current without re-subscribing the native session — same
  // ref-instead-of-closure convention already used throughout this app's
  // NFC call sites (HomeScreen's homeScanContextRef, RowPickerSheet's
  // onNfcScanRef) so a fresh onTag/onError identity every render never
  // means tearing down and restarting the actual scan.
  const onTagRef = useRef(onTag);
  useEffect(() => {
    onTagRef.current = onTag;
  }, [onTag]);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  }, []);

  const startScan = useCallback(() => {
    if (stopRef.current) return;
    setScanning(true);
    stopRef.current = startScanSession(
      (tag: ScannedTag) => {
        onTagRef.current(tag);
        // iOS's own native session already closed itself after this one
        // read (invalidateAfterFirstRead:true, set unconditionally by
        // lib/nfc.ts for iOS) — mirroring that here is what makes the next
        // startScan() tap actually start a fresh session instead of seeing
        // stopRef still set and silently no-op'ing. Android's session
        // stays open across many tags exactly as it always has; this
        // never runs there.
        if (isIosNativePlatform()) stop();
      },
      (message) => {
        onErrorRef.current?.(message);
        if (isIosNativePlatform()) stop();
      },
      label,
      iosAlertMessage
    );
  }, [label, iosAlertMessage, stop]);

  useEffect(() => {
    if (!supported || !active) {
      stop();
      return;
    }
    if (!isIosNativePlatform()) {
      startScan();
    }
    return stop;
    // startScan/stop are stable (useCallback with stable deps); only
    // supported/active should ever re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, active]);

  const iosManual = isIosNativePlatform();
  return {
    scanning,
    awaitingTap: supported && active && iosManual && !scanning,
    startScan,
  };
}
