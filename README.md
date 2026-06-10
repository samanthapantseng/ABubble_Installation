# A Bubble — Project Overview

This repository contains tools for visualizing Gaussian Splats (.splat, .ksplat) / using Three.js, while retrieving live data from buoys and sending it through PureData for sound art and pulley motion.

Folders

- `Buoy_Data/`: Node script that fetches buoy readings and sends them as OSC UDP messages.
- `osc-bridge/`: Node WebSocket/UDP bridge that relays OSC between Pure Data (or other UDP senders) and browser clients.
- `sender/`: Pure Data patch that can emit OSC messages.
- `ThreeJS_Visualizer/`: Vite + Three.js viewer using the `@mkkellogg/gaussian-splats-3d` package.

Prerequisites

- Node.js 18+ and `npm` (for all Node subprojects)
- A modern browser (Chrome/Firefox/Edge) for the visualizer
- (Optional) Pure Data (Pd) if you want to use the `.pd` patches in `sender/`

Quick Install

1. Install Node.js (https://nodejs.org/) — use v18 or newer.
2. From the repo root, install dependencies in each Node subproject:

```bash
cd Buoy_Data && npm install
cd ../osc-bridge && npm install
cd ../ThreeJS_Visualizer && npm install
```

Configuration

- `Buoy_Data` expects an environment variable `KEY` for the buoy API. Create a `.env` file in `Buoy_Data/` with:

```
KEY=your_api_key_here
```

Run / Usage

- Start Pure Data patch

- Start the OSC bridge (relays UDP -> WebSocket for browser):

```bash
cd osc-bridge
node bridge.js
```

- Start the Three.js visualizer (dev server with Vite):

```bash
cd ThreeJS_Visualizer
npm run dev
# then open the shown local URL in your browser (usually http://localhost:5173)
```

- Run the Buoy data fetcher and sender (sends OSC UDP messages):

```bash
cd Buoy_Data
node main.js
```

Notes on ports & addresses

- `osc-bridge` opens a UDP listener (default `localPort: 7000`) to receive OSC from local PD/UDP senders and a WebSocket server on `ws://localhost:3000` for browser clients.
- The browser client in `ThreeJS_Visualizer/index.html` connects to `ws://localhost:3000` and listens for `/pulley` messages to drive camera movement.
- `Buoy_Data/main.js` sends UDP OSC messages by default to `127.0.0.1:8000` with address `/buoy`. You may need to adjust this or run another UDP listener (e.g., Pure Data) to forward to the bridge if desired.

Using Pure Data

- Open the Pure Data patches in `sender/` (for example `sender/sender.pd` or `sender/buoyData.pd`) to send OSC messages via UDP to the bridge. Configure the patch to target `localhost` and port `7000` if you want the bridge to receive them.

Troubleshooting

- If the browser shows no OSC updates, ensure `osc-bridge` is running and the WebSocket at `ws://localhost:3000` is reachable.
- If `Buoy_Data` fails fetching, verify your `KEY` in `Buoy_Data/.env` and that network requests are allowed from Node.
- If you see port mismatches, update `localPort`/`remotePort` values in the Node scripts or Pure Data patches to align the sender/receiver ports.

---
