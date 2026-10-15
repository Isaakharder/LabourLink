#!/usr/bin/env bash
# TEST ONLY. Tiny UI driver for the emulator suite (via cdp.mjs).
#   ui.sh text            -> visible page text
#   ui.sh click "<label>" -> clicks the innermost element whose text is exactly <label>
#   ui.sh eval "<expr>"
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SERIAL="${SERIAL:-emulator-5554}"
case "$1" in
  text) node "$DIR/cdp.mjs" "$SERIAL" eval 'document.body.innerText' ;;
  click) node "$DIR/cdp.mjs" "$SERIAL" eval "(() => { const t = $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2"); const el = [...document.querySelectorAll('button,a,[role=button],li,label,div,span,p,h1')].reverse().find(e => e.innerText && e.innerText.trim() === t); if (!el) throw new Error('no element: ' + t); el.click(); return 'clicked ' + t; })()" ;;
  eval) node "$DIR/cdp.mjs" "$SERIAL" eval "$2" ;;
  *) echo "usage: ui.sh text|click|eval" >&2; exit 2 ;;
esac
