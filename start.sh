#!/usr/bin/env bash
cd "$(dirname "$0")"

if [[ ! -f dist/index.html ]]; then
  ./install.sh || { read -rp 'Installation failed. Press Enter to close.'; exit 1; }
fi
node server.js --open "$@" || read -rp 'The viewer stopped with an error. Press Enter to close.'
