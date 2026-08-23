#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_PORT=3000
VIEWER_PORT=4173
CHROME_PROFILE_DIR="/tmp/exhibition-chrome-profile"

echo "=== A Bubble — Exhibition Launcher ==="

free_port() {
    local port="$1"
    local pids
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "Freeing port $port (killing: $pids)"
        kill -9 $pids 2>/dev/null || true
    fi
}

wait_for_tcp_port() {
    local port="$1"
    local label="$2"
    local tries=30
    while [ $tries -gt 0 ]; do
        if nc -z localhost "$port" 2>/dev/null; then
            return 0
        fi
        sleep 0.5
        tries=$((tries - 1))
    done
    echo "Warning: $label on port $port did not come up in time; continuing anyway."
    return 1
}

cleanup() {
    echo ""
    echo "Shutting down osc-bridge and the visualizer server..."
    [ -n "${BRIDGE_PID:-}" ] && kill "$BRIDGE_PID" 2>/dev/null
    [ -n "${PREVIEW_PID:-}" ] && kill "$PREVIEW_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

free_port "$BRIDGE_PORT"
free_port "$VIEWER_PORT"

echo "Opening Pure Data patches..."
open "$SCRIPT_DIR/sender/buoyData.pd"
open "$SCRIPT_DIR/soundscapd/bubble.pd"

echo "Starting osc-bridge..."
(cd "$SCRIPT_DIR/osc-bridge" && node bridge.js) &
BRIDGE_PID=$!
wait_for_tcp_port "$BRIDGE_PORT" "osc-bridge"

echo "Building the visualizer (production build)..."
if ! (cd "$SCRIPT_DIR/ThreeJS_Visualizer" && npm run build); then
    echo ""
    echo "Build failed — see the error above."
    read -p "Press Enter to close this window..." _
    exit 1
fi

echo "Starting the visualizer server..."
(cd "$SCRIPT_DIR/ThreeJS_Visualizer" && npm run preview -- --port "$VIEWER_PORT" --strictPort) &
PREVIEW_PID=$!

if ! wait_for_tcp_port "$VIEWER_PORT" "visualizer server"; then
    echo "The visualizer server may not be ready; opening the browser anyway."
fi

echo "Opening the viewer in Chrome (kiosk mode)..."
mkdir -p "$CHROME_PROFILE_DIR"
open -na "Google Chrome" --args \
    --kiosk \
    --no-first-run \
    --noerrdialogs \
    --disable-session-crashed-bubble \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    "http://localhost:$VIEWER_PORT"

echo ""
echo "Exhibition is running."
echo "  - osc-bridge:  http://localhost:$BRIDGE_PORT (WebSocket)"
echo "  - visualizer:  http://localhost:$VIEWER_PORT"
echo ""
echo "To stop osc-bridge and the visualizer server, close this window or press Ctrl+C."
echo "Chrome and Pure Data will stay open — quit those separately (Cmd+Q) if needed."
echo ""

wait
