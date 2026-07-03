# T-282 — Renderer breakup: close it out (audit remaining polish, do or drop, mark done)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the FULL T-282 ticket body in
`TICKETS.md` (it lists what already landed — five extracted units, renderer 2120→1063 lines —
and a trailing remaining-items list).

**Depends / assumes landed:** nothing. But T-315 E2 (ClientWorld as single grid owner) and
E1 (ContentCache read-through) reshaped the renderer's surroundings AFTER the ticket text was
written — some "remaining" items may be moot. That's the point of this prompt.

## Goal

T-282 stops being an eternal in-progress ticket. Either the remaining polish items are worth
doing — then do them — or they are not — then they get dropped with a reason. The ticket ends
this session as `done` (or, if something genuinely big is discovered, as a NEW well-scoped
ticket + T-282 done).

## Method (this is an audit-then-execute prompt, not a feature prompt)

1. Read the ticket's remaining-items list. For EACH item, verify against HEAD: does the code
   it describes still exist in the described shape? (T-315 moved a lot: grids live on
   ClientWorld, the content wire protocol is gone, EdgePass/Grade wiring changed in D2/D3.)
2. Classify each item:
   - **moot** — the premise no longer exists → drop, one line in the ticket saying why;
   - **worth it** — genuinely improves the renderer's shape at S/M effort → do it now, one
     commit per item, respecting the extraction pattern the ticket documents (thin
     delegation, external callers unchanged, stale-guards move VERBATIM — the ticket body
     spells out the house style for these extractions);
   - **not worth it** — real but low-value → drop with a reason ("low-value polish" is the
     ticket's own phrasing; honor it).
3. While you're in there, do ONE opportunistic check the ticket predates: `renderer.ts` after
   T-315 — are there leftover fields/methods now dead because ClientWorld/ContentCache own the
   data (the E2 review already deleted three dead accessors; look for siblings in renderer.ts
   itself)? Dead surface → delete in a small commit.
4. Close: T-282 `Status: done` + commit hash + a 3-line summary of what was done vs dropped in
   the ticket body. If — and only if — you found something that is real, valuable, and >M
   effort, write it as a NEW ticket at the bottom of the ticket's domain section instead of
   doing it, and still close T-282.

## Do NOT

- Start a new extraction spree. The breakup is "substantively COMPLETE" per the ticket; the
  bar for "worth it" is high.
- Reshuffle public APIs game.ts depends on for aesthetics.
- Leave the ticket in-progress.

## Verification

Standard bar (type-check per commit, client tests, bundle + one testplay screenshot since
renderer internals moved). Grep for every symbol you delete.
