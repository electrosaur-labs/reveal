// Quick comparison of before/after Saliency Rescue results
const fs = require('fs');

// Read current CSV
const csv = fs.readFileSync('data/CQ100_v4/output/cq100_summary.csv', 'utf8');
const lines = csv.split('\n').filter(l => l.trim());

// Parse astronaut row
const astronautLine = lines.find(l => l.startsWith('astronaut.ppm'));
if (astronautLine) {
    const parts = astronautLine.split(',');
    console.log('\n🚑 ASTRONAUT RESCUE RESULTS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Avg ΔE:       15.7 → ${parts[2]} (${((parts[2] - 15.7) / 15.7 * 100).toFixed(1)}% change)`);
    console.log(`Revelation:   27.7 → ${parts[4]} (${((parts[4] - 27.7) / 27.7 * 100).toFixed(1)}% improvement)`);
    console.log(`Integrity:    96.9 → ${parts[5]} (${((parts[5] - 96.9) / 96.9 * 100).toFixed(1)}% change)`);
    console.log(`Breaches:     4,259 → ${parts[6]} (${((parts[6] - 4259) / 4259 * 100).toFixed(1)}% change)`);
}

// Calculate overall stats
let totalDeltaE = 0, totalRev = 0, totalInt = 0;
let count = 0;
for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 6) {
        totalDeltaE += parseFloat(parts[2]);
        totalRev += parseFloat(parts[4]);
        totalInt += parseFloat(parts[5]);
        count++;
    }
}

console.log('\n📊 OVERALL CQ100 RESULTS:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Images:         ${count}/100`);
console.log(`Avg ΔE:         16.85 → ${(totalDeltaE/count).toFixed(2)} (${(((totalDeltaE/count) - 16.85) / 16.85 * 100).toFixed(1)}% change)`);
console.log(`Avg Revelation: 30.3 → ${(totalRev/count).toFixed(1)} (${(((totalRev/count) - 30.3) / 30.3 * 100).toFixed(1)}% change)`);
console.log(`Avg Integrity:  93.7 → ${(totalInt/count).toFixed(1)} (${(((totalInt/count) - 93.7) / 93.7 * 100).toFixed(1)}% change)`);

console.log('\n✅ Saliency Rescue Implementation Complete!\n');
