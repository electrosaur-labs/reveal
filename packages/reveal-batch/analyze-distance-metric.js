const fs = require("fs");
const path = require("path");

function analyzeDataset(name, dirPath) {
    const allFiles = fs.readdirSync(dirPath);
    const files = allFiles.filter(f => {
        return f.endsWith(".json") &&
               f.indexOf("meta") === -1 &&
               f.indexOf("batch") === -1;
    });

    let cie76 = 0, cie94 = 0;
    const details = [];

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf8"));
            const dna = data.dna || {};
            const archetype = (data.configuration && data.configuration.meta)
                ? data.configuration.meta.archetype
                : "Unknown";
            const peakChroma = dna.maxC || 0;
            const isPhotographic = archetype === "Photographic";
            const metric = (peakChroma > 80 || isPhotographic) ? "cie94" : "cie76";

            if (metric === "cie94") {
                cie94++;
            } else {
                cie76++;
            }

            details.push({
                file: file.replace(".json",""),
                archetype,
                peakChroma: peakChroma.toFixed(1),
                metric
            });
        } catch (e) {
            // Skip files that can't be parsed
        }
    }

    const total = cie76 + cie94;
    if (total === 0) {
        console.log("\n=== " + name + " === (no data)");
        return;
    }

    console.log("\n=== " + name + " ===");
    console.log("Total images:", total);
    console.log("CIE76 (Poster/Graphic):", cie76, "(" + (100*cie76/total).toFixed(1) + "%)");
    console.log("CIE94 (Photo/Tonal):", cie94, "(" + (100*cie94/total).toFixed(1) + "%)");

    // Group by archetype
    const byArch = {};
    details.forEach(d => {
        if (byArch[d.archetype] === undefined) {
            byArch[d.archetype] = {cie76: 0, cie94: 0};
        }
        byArch[d.archetype][d.metric]++;
    });

    console.log("\nBy Archetype:");
    Object.keys(byArch).sort().forEach(a => {
        console.log("  " + a + ": CIE76=" + byArch[a].cie76 + " CIE94=" + byArch[a].cie94);
    });
}

// Analyze CQ100
if (fs.existsSync("data/CQ100_v4/output/8bit")) {
    analyzeDataset("CQ100 (Natural Photos)", "data/CQ100_v4/output/8bit");
}

// Analyze SP100 - check different locations
const sp100Paths = [
    "data/SP100/output/8bit",
    "data/SP100/output/met",
    "data/SP100/output/rijks"
];

for (const sp of sp100Paths) {
    if (fs.existsSync(sp)) {
        analyzeDataset("SP100: " + path.basename(sp), sp);
    }
}
