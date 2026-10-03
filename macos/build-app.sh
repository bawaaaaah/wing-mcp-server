#!/usr/bin/env bash
# Builds WingMCP.app (the menu bar controller for this checkout's server) and installs it in
# ~/Applications. The checkout's path and the current `node` are baked into Info.plist as defaults;
# see macos/README.md to override them.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
package="$here/WingMenuBar"
app="$here/build/WingMCP.app"
dest="$HOME/Applications/WingMCP.app"
bundle_id="com.bawaaaaah.wing-mcp-menubar"

node_path="$(command -v node || true)"
if [[ -z "$node_path" ]]; then
  echo "node is not on PATH; install it or set nodePath afterwards (see macos/README.md)" >&2
  exit 1
fi
version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"

swift build -c release --package-path "$package"
binary="$(swift build -c release --package-path "$package" --show-bin-path)/WingMenuBar"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/WingMenuBar"

plist="$app/Contents/Info.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>WingMCP</string>
  <key>CFBundleDisplayName</key><string>WING MCP</string>
  <key>CFBundleExecutable</key><string>WingMenuBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>The WING MCP server reaches the WING console on your local network.</string>
</dict>
</plist>
PLIST
plutil -insert WingRepoPath -string "$repo" "$plist"
plutil -insert WingNodePath -string "$node_path" "$plist"

codesign --force --sign - "$app"

# SIGTERM rather than a clean quit: the app does not stop the server that way, and the new copy
# takes the running server back over through data/menubar.pid, so reinstalling does not bounce it.
was_running=false
if pkill -x WingMenuBar; then
  was_running=true
  sleep 1
fi

mkdir -p "$HOME/Applications"
rm -rf "$dest"
cp -R "$app" "$dest"
echo "Installed $dest"

if $was_running; then
  open "$dest"
else
  echo "Start it with: open \"$dest\""
fi
