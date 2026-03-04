#!/bin/bash
# Process TESTIMAGES dataset with pseudo-archetypes, one file at a time
# Usage: ./run-testimages-pseudo.sh <archetype>
# Example: ./run-testimages-pseudo.sh salamander

ARCHETYPE=${1:?Usage: $0 <archetype>}
BATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
TI_DIR="$BATCH_DIR/data/TESTIMAGES"
INPUT_DIR="$TI_DIR/input/psd/16bit"
OUTPUT_DIR="$TI_DIR/output/psd/$ARCHETYPE"

mkdir -p "$OUTPUT_DIR"

TOTAL=0
DONE=0
SKIPPED=0
FAILED=0

for PSD in "$INPUT_DIR"/*.psd; do
    [ -f "$PSD" ] || continue
    TOTAL=$((TOTAL + 1))
    BASENAME=$(basename "$PSD" .psd)

    # Skip if already done
    if [ -f "$OUTPUT_DIR/$BASENAME.json" ]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    echo "[$((DONE + SKIPPED + FAILED + 1))/$TOTAL] $BASENAME ($ARCHETYPE)"
    NODE_OPTIONS="--max-old-space-size=4096" node "$BATCH_DIR/src/posterize-psd.js" 16 "$PSD" "$OUTPUT_DIR" --archetype "$ARCHETYPE" 2>&1

    if [ $? -eq 0 ]; then
        DONE=$((DONE + 1))
    else
        FAILED=$((FAILED + 1))
        echo "FAILED: $BASENAME"
    fi
done

echo ""
echo "=== $ARCHETYPE COMPLETE ==="
echo "Total: $TOTAL, New: $DONE, Skipped: $SKIPPED, Failed: $FAILED"
