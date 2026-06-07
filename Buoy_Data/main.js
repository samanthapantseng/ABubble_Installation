require("dotenv").config();
const osc = require("osc");

const options = {
    method: "GET",
    headers: {
        Authorization: `Bearer ${process.env.KEY}`,
    },
};

async function getBuoyData(id, startDate, endDate) {
    try {
        const response = await fetch(
            `https://api.thebuoy.app/v2/buoys/${id}/readings?order=desc&page=1&per_page=48&start_date=${startDate}&end_date=${endDate}`,
            options,
        );

        const json = await response.json();
        const readings = json.data.readings;

        return readings.map((reading) => reading.maximum_height);
    } catch (err) {
        console.error(err);
        return [];
    }
}

function scaleValues(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);

    return values.map((value) => {
        const normalized = (value - min) / (max - min);
        return -14 + normalized * 20;
    });
}

function sendOscUdp(
    values,
    { host = "127.0.0.1", port = 8000, address = "/buoy" } = {},
) {
    return new Promise((resolve, reject) => {
        const udpPort = new osc.UDPPort({
            localAddress: "0.0.0.0",
            localPort: 0,
            remoteAddress: host,
            remotePort: port,
            metadata: true,
        });

        udpPort.once("error", reject);
        udpPort.once("ready", () => {
            values.forEach((value, index) => {
                udpPort.send({
                    address,
                    args: [
                        {
                            type: "i",
                            value: index,
                        },
                        {
                            type: "f",
                            value,
                        },
                    ],
                });
            });

            setImmediate(() => {
                udpPort.close();
                resolve();
            });
        });

        udpPort.open();
    });
}

async function fetchAndSendData() {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - 2);
    console.log(startDate);
    console.log(endDate);

    const result = await getBuoyData(
        "330",
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10),
    );
    result.reverse();
    const scaledResult = scaleValues(result);

    await sendOscUdp(scaledResult, {
        host: "127.0.0.1",
        port: 8000,
        address: "/buoy",
    });

    console.log(
        `Sent ${scaledResult.length} indexed OSC messages to 127.0.0.1:8000`,
    );

    for (let i = 0; i < scaledResult.length; i++) {
        console.log(`${result[i]} -> ${scaledResult[i]}`);
    }
}

async function loop() {
    try {
        await fetchAndSendData();
    } finally {
        setTimeout(loop, 30 * 60 * 1000);
    }
}

loop();
