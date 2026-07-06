# Execution prompts for the active arcs

Prepared 2026-07-03 (repo tip `abfe5c9`) — architectural decisions, pitfalls and scope fences
pre-baked so an implementation agent can execute without re-deriving the design.

## How to use

- One prompt = one agent session. Give the agent the prompt file's content (or tell it to read
  the file); it will read `ENVIRONMENT.md` + `CLAUDE.md` + the named plan/ticket sections
  itself.
- Every prompt is drift-aware: it instructs the agent to re-verify all anchors against HEAD
  and TICKETS.md before editing, since earlier prompts change the codebase for later ones.
- Remaining prompts:

| # | Prompt | Scope | Notes |
|---|--------|-------|-------|
| 1 | `T-282-renderer-breakup-closeout.md` | audit/cleanup | anytime; audit-then-close |
| 2 | `T-186-body-recipes-layer2.md` | content/client | Step 0 reconciles vs T-301/T-302 |

Done and their prompt files deleted with the closing commit (CLAUDE.md refactor doctrine):
T-317 (mouse-facing camera), T-212/T-213b (POI runtime v2), T-311 P5a/P5b/P5c (atmosphere/water/
dissolves), T-311 P6 (terraced cliffs).

- Delete each prompt file in the commit that closes its ticket. Delete this directory when the
  table is empty.
