// Startup guard — a plain classic script (no module, no imports, no
// dependency on the app bundle) that runs before the React bundle even
// starts loading. index.html already shows a static loading screen inside
// #root; this guard's only job is to make sure that screen can never turn
// into a permanent blank/white page.
//
// Context (Khen Lagto / Jhang Jhang Ulefone phones, 2026-10-01): opening the
// app in the morning could leave a white screen that only closing and
// reopening (sometimes repeatedly) cleared. The native ColdStartWatchdog
// (MainActivity.java) only covers the WebView renderer failing to START —
// it counts onPageStarted as success, so anything that stalls or throws
// AFTER the page starts (bundle load failure, an exception before React's
// first render, a hung startup step) previously had no recovery at all.
//
// If React hasn't signalled a successful mount (window.__llBootGuard
// .markBooted(), called from main.tsx) within BOOT_TIMEOUT_MS, or a script/
// resource error fires before then, this replaces the loading screen with
// a "couldn't start" screen and a Retry button. Retry is a plain page
// reload — it never clears localStorage, IndexedDB, or the local SQLite
// database, so the paired-device identity and any pending offline events
// are untouched. React's own first render replaces this screen if the app
// finishes booting late anyway.
//
// The shown code is a fixed category only (TIMEOUT / SCRIPT / JS-<name>),
// never the raw error message.
(function () {
  "use strict";
  var BOOT_TIMEOUT_MS = 15000;
  if (window.__llBootGuard) return;

  var timer = null;
  var guard = {
    booted: false,
    failed: false,
    code: null,
    timeoutMs: BOOT_TIMEOUT_MS,
    markBooted: function () {
      guard.booted = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    fail: fail,
  };
  window.__llBootGuard = guard;

  function fail(code) {
    if (guard.booted || guard.failed) return;
    guard.failed = true;
    guard.code = code;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      console.error("[boot-guard] startup did not complete: " + code);
    } catch (e) {
      // console unavailable — nothing else to do
    }
    var root = document.getElementById("root") || document.body;
    if (!root) return;
    root.innerHTML =
      '<div class="boot-screen" role="alert">' +
      '<p class="boot-title">LabourLink couldn’t start</p>' +
      '<p class="boot-text">Your saved work is safe on this phone. Tap Retry to try again.</p>' +
      '<button type="button" class="boot-retry" id="boot-retry">Retry</button>' +
      '<p class="boot-code">Code: ' + code + "</p>" +
      "</div>";
    var button = document.getElementById("boot-retry");
    if (button) {
      button.addEventListener("click", function () {
        window.location.reload();
      });
    }
  }

  function codeForError(event) {
    // A failed <script>/<link> load fires a non-bubbling error on the
    // element itself — only visible here via the capture-phase listener.
    // Any other element (an <img> that 404s, say) is not a startup failure.
    var target = event && event.target;
    if (target && target !== window && target.tagName) {
      return target.tagName === "SCRIPT" || target.tagName === "LINK" ? "SCRIPT" : null;
    }
    var err = event && event.error;
    var name = err && typeof err.name === "string" ? err.name : "Error";
    return "JS-" + name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  }

  window.addEventListener(
    "error",
    function (event) {
      if (guard.booted) return;
      var code = codeForError(event);
      if (code) fail(code);
    },
    true
  );

  timer = setTimeout(function () {
    fail("TIMEOUT");
  }, BOOT_TIMEOUT_MS);
})();
