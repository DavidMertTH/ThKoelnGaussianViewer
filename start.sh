#!/usr/bin/env bash
cd "$(dirname "$0")"

command -v node >/dev/null || { read -rp 'Node.js was not found. Install Node.js 22 or newer, then press Enter to close.'; exit 1; }
# First start, or an update pulled new code: install and build again.
if ! node check-install.js; then
  ./install.sh || { read -rp 'Installation failed. Press Enter to close.'; exit 1; }
fi
node server.js --open "$@" || read -rp 'The viewer stopped with an error. Press Enter to close.'
