const options = {
    method: "GET",
    headers: {
        Authorization: "Bearer ",
    },
};

async function getBuoyData(id, date) {
    try {
        const response = await fetch(
            `https://api.thebuoy.app/v2/buoys/${id}/readings?order=asc&page=1&per_page=48&date=${date}`,
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

(async () => {
    const result = await getBuoyData("343", "2026-06-05");
    const scaledResult = scaleValues(result);
    for (const value of scaledResult) {
        console.log(value);
    }
})();
