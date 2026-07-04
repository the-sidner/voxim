# Execution prompts for the active arcs

Prepared 2026-07-03 (repo tip `abfe5c9`) — architectural decisions, pitfalls and scope fences
pre-baked so an implementation agent (Sonnet) can execute without re-deriving the design.

## How to use

- One prompt = one agent session. Give the agent the prompt file's content (or tell it to read
  the file); it will read `ENVIRONMENT.md` + `CLAUDE.md` + the named plan/ticket sections
  itself.
- Every prompt is drift-aware: it instructs the agent to re-verify all anchors against HEAD
  and TICKETS.md before editing, since earlier prompts change the codebase for later ones.
- Recommended order (dependencies noted in each file):

| # | Prompt | Scope | Notes |
|---|--------|-------|-------|
| 1 | `T-317-mouse-facing-camera.md` | client/feel | **DOCTRINE, pulled forward — run with OPUS**; fixed camera dies |
| 2 | `T-212-T-213b-poi-runtime-v2.md` | gameplay | independent of the render arc |
| 5 | ~~`T-311-P5c-dissolves.md`~~ | render/wire/content | **DONE on `lane/creatures`** modulo I3b harness measurement (deferred to post-merge, no live stack in that lane) — file deleted in the closing commit |
| 6 | `T-311-P6-terraced-cliffs.md` | atlas/wire/client ✶ | re-bake; heaviest |
| 7 | `T-282-renderer-breakup-closeout.md` | audit/cleanup | anytime |
| 8 | `T-186-body-recipes-layer2.md` | content/client | Step 0 reconciles vs T-301/T-302 |

(P5a/P5b done — their prompt files deleted per the rule below, lane/atmosphere.)

- Delete each prompt file in the commit that closes its ticket (scaffolding dies with the work
  — CLAUDE.md refactor doctrine). Delete this directory when the table is empty.
