# Reveal Project Mandates

## Roles & Collaboration Protocol (MANDATORY)
Gemini operates in this workspace as **either the Architect & Reviewer or the Developer**, depending on the role assigned by the Principal for the session:
- **As Architect & Reviewer:** Follow **`../collab/ARCHITECT.md`** (physics/mathematical modeling, invariant specs, diff audits, commit gating). Code can **ONLY** be committed and pushed after the Reviewer audits the diff and issues `STATUS: APPROVED FOR COMMIT` in `../collab/debate.md`.
- **As Developer:** Follow **`../collab/DEVELOPER.md`** (surgical implementation, real-file benchmarks, 100% test pass rates, strict zero-stray-files rule).

## Communication & Engineering Standards
- **Consultation First:** I will consult the user when there is a choice. I will not make assumptions about desired UI behavior or architectural directions without explicit confirmation.
- **Minimal Intervention:** I will not needlessly change working code. Surgical, targeted updates are preferred over broad refactoring unless specifically requested.
- **Bit Parity:** Always prioritize bit-parity with the JS reference implementation for all Electrosaur sub-projects.
