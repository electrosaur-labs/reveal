/**
 * RevalidateQuality.js
 * Applies "Screen Count Penalty" to existing Revelation Scores.
 *
 * EFFICIENCY PENALTY:
 * - <= 8 Colors: No penalty (Efficiency Safe Zone)
 * - > 8 Colors: -1.5 points per extra screen
 *
 * This retroactively updates existing CQ100 sidecar JSONs to include
 * the efficiency penalty, favoring Smart Separation over Brute Force.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data/CQ100_v4/output/psd');

// --- EFFICIENCY CONSTANTS (must match MetricsCalculator.js) ---
const SCREEN_LIMIT = 8;
const PENALTY_PER_SCREEN = 1.5;

function run() {
    console.log(`📉 Applying Efficiency Penalties to ${DATA_DIR}...`);
    console.log(`   Screen Limit: ${SCREEN_LIMIT} colors`);
    console.log(`   Penalty: -${PENALTY_PER_SCREEN} pts per extra screen\n`);

    if (!fs.existsSync(DATA_DIR)) {
        console.error(`❌ Directory not found: ${DATA_DIR}`);
        return;
    }

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    let totalPenalty = 0;
    let penalizedCount = 0;
    let skippedCount = 0;

    files.forEach(file => {
        const filePath = path.join(DATA_DIR, file);

        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // 1. Get Color Count from configuration
            const colors = data.configuration?.targetColors ||
                           data.input_parameters?.targetColors ||
                           0;

            if (colors === 0) {
                console.warn(`   ⚠️ ${file}: No targetColors found, skipping`);
                skippedCount++;
                return;
            }

            // 2. Calculate Penalty
            let penalty = 0;
            if (colors > SCREEN_LIMIT) {
                penalty = (colors - SCREEN_LIMIT) * PENALTY_PER_SCREEN;
            }

            // 3. Get current score and check for existing penalty
            const currentScore = data.metrics.feature_preservation.revelationScore;
            const oldPenalty = data.metrics.feature_preservation.efficiencyPenalty || 0;

            // Reset to raw/base score first (undo any previous penalty)
            const baseScore = currentScore + oldPenalty;

            // Apply new penalty
            const newScore = Math.max(0, baseScore - penalty);

            // 4. Update metrics
            data.metrics.feature_preservation.revelationScore = parseFloat(newScore.toFixed(1));
            data.metrics.feature_preservation.baseScore = parseFloat(baseScore.toFixed(1));
            data.metrics.feature_preservation.efficiencyPenalty = parseFloat(penalty.toFixed(1));
            data.metrics.feature_preservation.screenCount = colors;

            // 5. Save
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

            if (penalty > 0) {
                totalPenalty += penalty;
                penalizedCount++;
                console.log(`   ${pad(file, 30)} ${colors}c → -${penalty.toFixed(1)} pts → Score: ${newScore.toFixed(1)}`);
            }
        } catch (err) {
            console.warn(`   ⚠️ ${file}: ${err.message}`);
            skippedCount++;
        }
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Revalidation Complete`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Files processed:   ${files.length}`);
    console.log(`   Files penalized:   ${penalizedCount}`);
    console.log(`   Files skipped:     ${skippedCount}`);
    console.log(`   Total penalty:     ${totalPenalty.toFixed(1)} pts`);
    console.log(`   Avg penalty:       ${(totalPenalty / files.length).toFixed(1)} pts`);
    console.log();
}

function pad(str, len) {
    return (str + ' '.repeat(len)).substring(0, len);
}

// Run if called directly
if (require.main === module) {
    run();
}

module.exports = { run };
