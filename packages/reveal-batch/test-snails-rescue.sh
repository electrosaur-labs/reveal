#!/bin/bash
# Test snails.psd with structural-outlier-rescue parameters
# by temporarily swapping the subtle-naturalist archetype

ARCHETYPE_FILE="packages/reveal-core/archetypes/subtle-naturalist.json"
BACKUP_FILE="packages/reveal-core/archetypes/subtle-naturalist.json.backup"
RESCUE_FILE="packages/reveal-core/archetypes/structural-outlier-rescue.json"

# Backup original
cp "$ARCHETYPE_FILE" "$BACKUP_FILE"

# Copy rescue parameters but keep subtle-naturalist ID so it gets matched
cat "$RESCUE_FILE" | sed 's/"structural_outlier_rescue"/"subtle_naturalist"/' | sed 's/"Subtle Naturalist \/ Structural Rescue"/"Subtle Naturalist \/ Architectural (RESCUE TEST)"/' > "$ARCHETYPE_FILE"

echo "Testing snails.psd with structural-outlier-rescue parameters..."
node packages/reveal-batch/src/posterize-psd.js 16 packages/reveal-batch/data/TESTIMAGES/input/psd/16bit/snails.psd packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/test_rescue

# Restore original
mv "$BACKUP_FILE" "$ARCHETYPE_FILE"

echo ""
echo "Comparing results..."
if [ -f "packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/test_rescue/snails.json" ]; then
    node -e "
    const orig = require('./packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/snails.json');
    const test = require('./packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/test_rescue/snails.json');
    console.log('Original (blue-noise, standard params):');
    console.log('  Revelation: ' + orig.metrics.feature_preservation.revelationScore.toFixed(1));
    console.log('  Saliency Loss: ' + orig.metrics.feature_preservation.saliencyLoss.toFixed(1) + '%');
    console.log('  Avg ΔE: ' + orig.metrics.global_fidelity.avgDeltaE.toFixed(2));
    console.log('');
    console.log('Structural Rescue (atkinson, tighter params):');
    console.log('  Revelation: ' + test.metrics.feature_preservation.revelationScore.toFixed(1) + ' (' + (test.metrics.feature_preservation.revelationScore - orig.metrics.feature_preservation.revelationScore > 0 ? '+' : '') + (test.metrics.feature_preservation.revelationScore - orig.metrics.feature_preservation.revelationScore).toFixed(1) + ')');
    console.log('  Saliency Loss: ' + test.metrics.feature_preservation.saliencyLoss.toFixed(1) + '% (' + (test.metrics.feature_preservation.saliencyLoss - orig.metrics.feature_preservation.saliencyLoss > 0 ? '+' : '') + (test.metrics.feature_preservation.saliencyLoss - orig.metrics.feature_preservation.saliencyLoss).toFixed(1) + '%)');
    console.log('  Avg ΔE: ' + test.metrics.global_fidelity.avgDeltaE.toFixed(2) + ' (' + (test.metrics.global_fidelity.avgDeltaE - orig.metrics.global_fidelity.avgDeltaE > 0 ? '+' : '') + (test.metrics.global_fidelity.avgDeltaE - orig.metrics.global_fidelity.avgDeltaE).toFixed(2) + ')');
    console.log('');
    if (test.metrics.feature_preservation.revelationScore >= 20) {
        console.log('🎉 SUCCESS! Passed the 20 revelation threshold!');
    } else {
        console.log('⚠️  Still below 20 threshold (' + test.metrics.feature_preservation.revelationScore.toFixed(1) + ')');
    }
    "
fi
