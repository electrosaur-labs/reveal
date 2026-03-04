#!/bin/bash
# Process SP100 dataset with pseudo-archetypes, one file at a time
# Usage: ./run-sp100-pseudo.sh <archetype>
# Example: ./run-sp100-pseudo.sh chameleon

ARCHETYPE=${1:?Usage: $0 <archetype>}
BATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
SP100_DIR="$BATCH_DIR/data/SP100"
OUTPUT_DIR="$SP100_DIR/output/psd/$ARCHETYPE"

mkdir -p "$OUTPUT_DIR"

TOTAL=0
DONE=0
SKIPPED=0
FAILED=0

# Collect all 16-bit input PSDs
for SOURCE_DIR in "$SP100_DIR"/input/*/psd/16bit; do
    [ -d "$SOURCE_DIR" ] || continue
    for PSD in "$SOURCE_DIR"/*.psd; do
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
done

echo ""
echo "=== $ARCHETYPE COMPLETE ==="
echo "Total: $TOTAL, New: $DONE, Skipped: $SKIPPED, Failed: $FAILED"
