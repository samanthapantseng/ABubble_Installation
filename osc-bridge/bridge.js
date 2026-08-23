const osc = require("osc");
const WebSocket = require("ws");

// Create a UDP port to receive OSC from Pure Data
const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 7000,
    metadata: true,
});

udpPort.open();

// Second UDP port for trigger.pd's /trigger 1|0 (V-key activation) messages
const triggerUdpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 7021,
    metadata: true,
});

triggerUdpPort.open();

// Create a WebSocket server for browser clients
const wss = new WebSocket.Server({ port: 3000 });

// Store all connected browser OSC ports
const browserPorts = new Set();

wss.on("connection", function (socket) {
    console.log("Browser connected via WebSocket");

    const wsPort = new osc.WebSocketPort({
        socket: socket,
        metadata: true,
    });

    browserPorts.add(wsPort);

    // Relay messages from browser to Pure Data (optional)
    wsPort.on("message", function (oscMsg) {
        udpPort.send(oscMsg);
    });

    // Clean up on disconnect
    socket.on("close", () => {
        browserPorts.delete(wsPort);
    });

    socket.on("error", () => {
        browserPorts.delete(wsPort);
    });
});

// Relay OSC messages from Pure Data to all connected browsers
function relayToBrowsers(oscMsg) {
    browserPorts.forEach((port) => {
        try {
            if (port.socket.readyState === WebSocket.OPEN) {
                port.send(oscMsg);
            } else {
                browserPorts.delete(port);
            }
        } catch (err) {
            console.warn("Failed to send OSC to browser:", err.message);
            browserPorts.delete(port);
        }
    });
}

udpPort.on("message", function (oscMsg) {
    /* console.log("From PD:", oscMsg); */
    relayToBrowsers(oscMsg);
});

triggerUdpPort.on("message", function (oscMsg) {
    /* console.log("From PD (trigger):", oscMsg); */
    relayToBrowsers(oscMsg);
});
