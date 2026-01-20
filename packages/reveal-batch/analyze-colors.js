const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data/CQ100_v4/output/psd');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && !f.includes('batch') && !f.includes('meta') && !f.includes('summary'));

const colorCounts = {};
const colorDistribution = {};

files.forEach(file => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dataDir, file)));
        const numColors = data.palette ? data.palette.length : 0;

        if (!colorCounts[numColors]) {
            colorCounts[numColors] = 0;
            colorDistribution[numColors] = [];
        }

        colorCounts[numColors]++;
        colorDistribution[numColors].push({
            file: file.replace('.json', ''),
            revScore: data.metrics?.feature_preservation?.revelationScore || 0,
            integrity: data.metrics?.physical_feasibility?.integrityScore || 0,
            deltaE: data.metrics?.global_fidelity?.avgDeltaE || 0
        });
    } catch (e) {
        console.error('Error processing ' + file + ':', e.message);
    }
});

console.log('\n🎨 COLOR DISTRIBUTION ACROSS CQ100 DATASET\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Sort by color count
const sortedCounts = Object.keys(colorCounts).map(Number).sort((a, b) => a - b);

sortedCounts.forEach(count => {
    const images = colorDistribution[count];
    const avgRev = (images.reduce((sum, img) => sum + img.revScore, 0) / images.length).toFixed(1);
    const avgInt = (images.reduce((sum, img) => sum + img.integrity, 0) / images.length).toFixed(1);
    const avgDeltaE = (images.reduce((sum, img) => sum + img.deltaE, 0) / images.length).toFixed(2);

    const numImages = colorCounts[count];
    const bar = '█'.repeat(Math.round(numImages / 2));
    const countStr = String(count);
    const numStr = String(numImages);
    console.log(countStr + ' colors:  ' + numStr.padStart(3) + ' images ' + bar);
    console.log('           Avg Revelation: ' + avgRev + ', Avg Integrity: ' + avgInt + ', Avg ΔE: ' + avgDeltaE);

    // Show example images
    if (images.length <= 5) {
        console.log('           Examples: ' + images.map(i => i.file).join(', '));
    } else {
        console.log('           Examples: ' + images.slice(0, 3).map(i => i.file).join(', ') + ', ...');
    }
    console.log('');
});

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Show which images got 12 colors (Saliency Rescue candidates)
console.log('🚑 IMAGES WITH 12 COLORS (Maximum Palette):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (colorDistribution[12]) {
    colorDistribution[12].forEach(img => {
        const revStr = String(img.revScore);
        const intStr = String(img.integrity);
        console.log('   ' + img.file.padEnd(30) + ' Rev: ' + revStr.padStart(4) + ', Int: ' + intStr.padStart(4) + ', ΔE: ' + img.deltaE.toFixed(2));
    });
} else {
    console.log('   No images with 12 colors found.');
}

console.log('\n');
