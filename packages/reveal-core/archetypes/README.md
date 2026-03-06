# Archetype Definitions

Each JSON file in this directory defines a separation strategy. Archetypes are auto-discovered at runtime — add or remove files to change the available strategies.

## How It Works

1. **Analyze** — Image DNA is extracted: lightness, chroma, blackness, contrast, entropy, temperature, hue distribution
2. **Match** — DNA is scored against all archetypes using weighted 40/45/15 scoring (structural / sector / pattern)
3. **Apply** — The winning archetype's parameters drive the separation engine

## Adding an Archetype

Create a new JSON file in this directory. See `schema.json` for the full structure. Key fields:

- `id` — Unique identifier (snake_case, must match filename in kebab-case)
- `name` — Display name shown in the UI
- `group` — Category for carousel filter chips: `natural`, `soft`, `graphic`, `dramatic`, `vibrant`, `specialist`
- `centroid` — 7D target DNA: `l`, `c`, `k`, `l_std_dev`, `hue_entropy`, `temperature_bias`, `primary_sector_weight`
- `weights` — How much each DNA dimension matters for matching this archetype
- `parameters` — Full separation config: color count, distance metric, vibrancy, dithering, etc.

No code changes needed — the new archetype participates in matching immediately.

## Current Archetypes

See [docs/ARCHETYPES.md](../../../docs/ARCHETYPES.md) for the full reference table.
