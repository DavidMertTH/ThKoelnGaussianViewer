#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

command -v npm >/dev/null || { echo 'Node.js was not found. Install Node.js 22 or newer and run this again.' >&2; exit 1; }
npm ci
npm run build

if [[ "$(uname)" == Linux ]]; then
  launcher="${XDG_DATA_HOME:-$HOME/.local/share}/applications/gaussian-viewer.desktop"
  mkdir -p "$(dirname "$launcher")"
  cat > "$launcher" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Gaussian Viewer
Exec="$PWD/start.sh"
Path=$PWD
Icon=applications-graphics
Terminal=true
DESKTOP
  echo "Added Gaussian Viewer to the application menu."
fi
