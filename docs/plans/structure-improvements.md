# Structure improvements

Created: 2026-10-19

The app's browser/server split, JSON profiles, extraction engines and shared conformance fixtures are sound. Improve persistence and case integrity before changing navigation or presentation.

## 1. Prevent lost writes — high priority

Status: complete (2026-10-19); automated verification passed.

Route storage mutations through one background writer. Case creation, updates, deletion and active-case selection must participate in the same concurrency mechanism. Keep asynchronous AI requests outside storage transactions. Cover overlapping writes, failures, and multiple extension contexts with regression tests.

Acceptance: simultaneous edits and auto-clips preserve all successful changes; a failed write does not stop later writes; deleting a case cannot be undone by a stale update.

## 2. Keep mapped answers consistent with source clips — high priority

Status: complete (2026-10-19); automated verification passed.

Add a domain operation for removing clips and their answer contributions. Update replacement/remapping to retire earlier contributions from that clip. Retain contributions from other clips and deliberate user decisions. Define behaviour for scalar answers, conflicts, unsure values and list rows. Prevent an AI mapping started before a removal or edit from restoring stale values.

Acceptance: removed or superseded evidence is unavailable for filling unless explicitly retained by a user decision; remaining sources and decisions survive; existing cases work without destructive migration.

## 3. Preserve corrections made in the preview

Status: pending; outside the initial high-priority implementation.

Track preview edits and persist the manual-edit flag when adding the clip. Test that auto-clip cannot overwrite corrections.

## 4. Scope asynchronous state to its page and case

Status: pending; outside the initial high-priority implementation.

Bind inspection and generation operations to explicit page/case identities. Clear case-dependent generation state on case changes and discard stale responses after navigation. Add regression coverage for case/page switching during requests.

## 5. Separate UI and service responsibilities

Status: pending; outside the initial high-priority implementation.

Split the sidebar into page, case, profiles and settings features. Extract browser access and a shared API client. Keep case operations independent of rendering and retain the existing engines/templates. Introduce explicit storage versions and migrations when the stored schema changes.

## Validation and progress

- Review baseline: both JavaScript test files passed; extension lint had no errors or warnings; 70 Python tests passed with API tests excluded. The full Python run stalled in an API test.
- Added `extension/lib/storage.js`: one serialized background commit queue with a persisted revision. Mutations from sidebars retry against fresh storage after a competing commit; failures leave the queue usable. All settings, profile and case writes participate. The revision defaults to zero for existing installations.
- Added domain operations `removeClip` and `editClip`. Removal, replacement, raw edits and remapping retire the old clip's answer contributions. Other sources and explicit decisions survive; obsolete conflict candidates and empty list rows are removed. Surviving uncertain candidates remain subject to review, including legacy conflicts without candidate metadata.
- Raw clip revisions and snapshot checks reject mapping responses after the clip is edited, replaced or removed. Network requests run outside storage transactions.
- Edited raw clips remain unmapped until **Map again** is used; the clip is marked as needing mapping. Old answers are retired immediately so they cannot be filled while outdated. Replacements map automatically as before. Explicit rejections stay blank on remapping; uncertain evidence is tracked with its source so removal of a confident source cannot silently approve the remaining uncertain evidence.
- Final validation: **71 JavaScript tests passed** (15 case-domain, 13 storage/integration, 43 extraction/fill conformance). This includes 20 new regressions. Tests execute the production writer and independent client module instances with mocked browser storage/messaging, covering real concurrent `addClip` calls and delayed AI responses after removal, editing and replacement.
- Extension lint reported **zero errors, warnings and notices**. Changed JavaScript entry points passed syntax checks. The lint tool's optional update check could not write its user configuration in this environment; lint itself completed successfully.
- No Python source changed, so the review's Python baseline was not rerun. No interactive Firefox smoke test was performed. Suggested manual check: reload the extension, collect into a typed case, remove/edit/replace clips, and confirm the template, decisions and filled form match the retained evidence.
- Items 3–5 remain pending. No UI redesign was included in this implementation.
- Use installed Node and Python tools directly if pnpm/uv cannot write their caches in this environment.


## Backend-removal follow-up (2026-10-19)

The approved [backend-removal plan](remove-python-backend.md) is implemented: generation now runs in sidebar-owned JS operations through a generic endpoint, with local validation, cancellation, document/case identity checks and versioned settings. The old custom Python API is removed. Its final progress section records automated verification and the Firefox/live checks that could not run here. Item 4's generation/inspection protections were included in that migration; preview-edit protection (item 3) and the broader UI/module refactor (item 5) remain separate work.
