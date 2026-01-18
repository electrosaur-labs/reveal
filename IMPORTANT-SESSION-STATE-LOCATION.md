# CRITICAL: Session State and Temporary Files Location

## ⚠️ NEVER use ~/ (home directory) for session state

**ALWAYS use `/workspaces/electrosaur/` or project-relative paths for:**
- Session state files
- Temporary files
- Checkpoint files
- Cache files
- Any working files

## Why?

The home directory (~/) may not persist across sessions or may not be accessible in the same way. The workspace directory is the correct location for all working files in this project.

## Correct Patterns

✅ **CORRECT:**
- `/workspaces/electrosaur/tmp/checkpoint.json`
- `/workspaces/electrosaur/reveal-project/.session-state/`
- `/tmp/working-files/`
- Project-relative paths

❌ **WRONG:**
- `~/checkpoint.json`
- `~/.session-state/`
- `~/cache/`

## Date Created
2026-01-18

## Context
User directive during reveal-project 16-bit Lab support implementation session.
