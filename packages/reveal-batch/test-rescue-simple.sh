#!/bin/bash
# Simple test: Force rescue parameters by temporarily modifying DynamicConfigurator

CONFIGURATOR_FILE="src/DynamicConfigurator.js"
BACKUP_FILE="src/DynamicConfigurator.js.backup"
RESCUE_PARAMS_FILE="../reveal-core/archetypes/structural-outlier-rescue.json"
OUTPUT_DIR="data/TESTIMAGES/output/psd/16bit/rescue_simple"

# Backup original
cp "$CONFIGURATOR_FILE" "$BACKUP_FILE"

# Create modified configurator that always returns rescue parameters
cat > "$CONFIGURATOR_FILE" << 'EOF'
const fs = require('fs');
const path = require('path');

// Force rescue archetype parameters
const rescueArchetype = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../reveal-core/archetypes/structural-outlier-rescue.json'),
    'utf8'
));

module.exports = {
    generate(dna) {
        console.log('⚠️  FORCING RESCUE ARCHETYPE PARAMETERS');
        return {
            ...rescueArchetype.parameters,
            meta: {
                archetype: rescueArchetype.name + ' (FORCED)',
                archetypeId: rescueArchetype.id,
                forced: true
            }
        };
    }
};
EOF

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Testing with FORCED rescue parameters..."
echo ""

# Test all 8 failing images
for file in cards_b.psd snails.psd screws.psd multimeter.psd pencils_b.psd ducks.psd baloons.psd sweets.psd; do
    echo "Processing: $file"
    node src/posterize-psd.js 16 "data/TESTIMAGES/input/psd/16bit/$file" "$OUTPUT_DIR" 2>&1 | grep -E "(DNA:|Archetype:|Revelation Score:|Processing:|Generated)"
    echo ""
done

# Restore original
mv "$BACKUP_FILE" "$CONFIGURATOR_FILE"

echo "Restored original DynamicConfigurator"
echo ""
echo "Results saved to: $OUTPUT_DIR"
