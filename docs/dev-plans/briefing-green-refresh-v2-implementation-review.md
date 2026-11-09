# Briefing green refresh v2 implementation review

Date: 2026-08-30

## Objective

Repair the regression where an explicit future-date refresh of AI/tech, US, and world news made every unrelated briefing card red, then simplify the news path so a full fresh refresh reaches a published green result quickly. The clean-room replay must exclude every URL used by the immediately preceding refresh.

## Implemented invariants

1. A full overnight bootstrap remains honestly all-red until each card earns same-date proof.
2. An explicit off-cycle scoped bootstrap carries every unrelated accepted card forward with its prior visible body, verdict, and generated timestamp. Only the requested cards enter a pending state.
3. A repair command may reverse existing bootstrap collateral only when every unrelated non-clean row carries the exact `BOOTSTRAP-STALE` evidence. It refuses other defects.
4. The producer and renderer use one canonical news article package verdict containing source identity, legitimate article body, exactly three renderable summary paragraphs, and a distinct grounded display title.
5. A valid three-paragraph summary with a bad generated title gets one deterministic source-grounded title repair instead of losing the body or spending another model loop.
6. Self-heal summarizes the currently required display candidates through the existing bounded worker pool instead of serially invoking a one-item pool.
7. Each batch persists a product-progress receipt. A batch either reduces the render shortfall or records the automatic strategy transition to an expanded distinct-candidate frontier.
8. The exact delivery-critical AI/tech, US, and world source refresh uses the reserved delivery admission priority, while mixed or lower-priority content refreshes remain on controller priority.

## Specific incident coverage

The prior controller wrote a 39-card stale-red bootstrap shell for 2026-08-31 even though the explicit requested scope contained only three news cards. Promotion then repaired those three rows and preserved the 36 bootstrap defects. The new scoped-bootstrap regression creates a verified prior board, opens the next day for the same three targets, proves that only those targets are red, simulates the old collateral shape, and proves the repair restores every unrelated row without replacing target output.

The change also removes a duplicate `previousIsoDate` declaration in `briefing-source-contracts.js`. That duplicate made the controller dependency graph fail to parse and therefore could prevent source work from starting at all.

## Verification completed before review

- `briefing-card-controller.test.js`: 150/150 passing under the repository's Vitest runner.
- Focused news and admission suites: 106/106 passing.
- Canonical package, deterministic title repair, bounded concurrent self-heal, and zero final stub count: 3/3 passing.
- JavaScript syntax checks and `git diff --check` pass.

## Review focus

Look for any path that can still publish unrelated red collateral, any mismatch between canonical package completion and render readiness, any concurrency race in cache persistence, any way deterministic title repair can accept unsupported claims, and any capacity-priority widening beyond the exact three delivery-critical news targets.
