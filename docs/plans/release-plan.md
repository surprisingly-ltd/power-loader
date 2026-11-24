# First release plan and design-review response

Created: 2026-10-19. Status: proposal. This is the entry point for building the case-journeys design into the extension. It records:

- what the first release includes;
- how each finding from the design review was handled;
- the cross-cutting rules not covered by a feature plan;
- the acceptance criteria that can only be met in the real extension on real laptops.

Feature plans:

| Plan | Covers |
|---|---|
| `redact-before-ai.md` | The single AI boundary, placeholders and restoring, detection, images, model source |
| `library-and-profiles.md` | Library sync, the Library page, drafts, export contract, publishing, profile safety |
| `case-activity-log.md` | Data classification, collection scope, event schema, notes, retention |
| `magic-reader.md` | Document sources, Firefox capabilities, reader states |

The clickable prototype is `prototype/case-journeys.html`. Its scenario steps 1 to 9 show the journeys. Its jsdom checks are in `prototype/tests/` (`pnpm test:prototype`); `review-test.mjs` covers the review fixes. The extension's own tests are listed under each plan.

## 1. Scope of the first release

**In:**

- **Cases:** one active case started from target forms; explicit clipping with an identity check; conflicts; Finish and Discard with full teardown.
- **Full case page:** Fields and Sources views.
- **Undo a clip,** including wrong-person cleanup and purging it from the log.
- **Filling:** values only, through a fill plan the caseworker sees before anything is filled. No clicking (see section 4).
- **Calculator and timeline:** Standard (local) only.
- **Reader:** paste, drop and file; pdf.js text; local OCR.
- **Privacy:** the Privacy tab and the redaction preview. Every Enhanced action goes through it. The model loads from Hugging Face at a pinned revision by default; the caseworker can choose another server, and policy can lock one.
- **Library:** read-only sync, the Library page, local drafts with test-before-use, and checked export. Publishing is manual.
- **Activity log:** collected for approved systems only; notes kept local; no central upload.

**Deferred:**

- **Automation:** repeating-row authoring; automatic row creation when filling.
- **Reader:** frame discovery and download; Enhanced reading of images (Enhanced reading sends the text found on this computer, never the image).
- **Activity log:** central upload; the all-cases log editor beyond view, remove and download.

**Added after the first build, to match the prototype (2026-10-20):** the prototype's look throughout; auto-clip as an opt-in setting (off by default; the identity check warns first); region capture in the reader; the Matrix view and full-size calculator and timeline on the case page; ✦ calculator questions, finding periods in case notes (each added only when the caseworker accepts it) and explaining the timeline, all through the redaction preview; "Update this profile" in the sidebar, so any caseworker can propose a fix to a page profile and export it for the library team. All need the real-Firefox checks in section 5, region capture at 125/150/200% scaling especially.

## 2. Review findings and where each is handled

"Prototype" means the clickable prototype now behaves this way. A named plan means the build must follow that plan. "Release criterion" means section 5.

### Top ten

| # | Finding | Handling |
|---|---|---|
| 1 | Wrong-person removal left dependent data | **Prototype.** Choosing "Wrong person" lists and clears the values you typed for its fields, choices that used its value, saved workings that used it, and AI periods found in it. Forms already filled are flagged "check again". Spec in section 3, Case lifecycle. |
| 2 | Not every AI action used the preview; overlaps kept only the stronger finding; the payload had more in it than the preview showed | **Prototype:** the calculator, timeline, region, paste and file all go through the preview, and overlaps cover the union. **`redact-before-ai.md`:** the frozen payload accepted by `client.js`, snapshot attribute scanning, metadata, blocking when the model is required. |
| 3 | Restoring placeholders was too permissive | **Prototype:** a random namespace per request, exact matching, category checks, neutralising planted tokens, and unresolved values left empty. **`redact-before-ai.md`:** the per-field allow-list and the full restore rules. |
| 4 | The fill engine can click arbitrary elements | Section 4, Filling. Remove `lists[].add` clicks, add a dry-run fill plan, and test page side effects. |
| 5 | Exports didn't match the DSL | **Prototype:** `regex:` instead of `part`, rows as DSL lists, `CaseData.` fill paths, checks before export. **`library-and-profiles.md`:** the validator and CI. |
| 6 | Finish and Discard didn't erase everything | **Prototype:** one teardown, and a receipt that names no one. Section 3 lists what teardown must also cover in the extension. |
| 7 | Logs are potentially identifiable | **`case-activity-log.md`:** the classification, approved systems only, failing closed (prototype), notes kept local and left out of downloads unless chosen (prototype), the DPIA as a release dependency. |
| 8 | Drafts could vanish when a version was published | **Prototype:** a draft is retired only when the published hash equals its exported hash. **`library-and-profiles.md`:** the keep, compare and use-published choices, and version pinning per case. |
| 9 | Wrong Firefox assumptions; no readiness journey | **`magic-reader.md`:** `content.fetch` withdrawn and MV3 paths listed; capture needs `<all_urls>` or `activeTab`. Readiness check in section 5. |
| 10 | Tool arithmetic | **Prototype:** "Excluding gaps" is exact, with short gaps reported separately, and calculator results are marked stale when inputs change. Section 3, Tools, covers signed amounts, limits and approximate dates. |

### Decided differently from the review

- **Log notes are kept** (you asked for them), but they stay on the computer, are left out of downloads unless chosen, and are never uploaded without DPIA approval.
- **Format hints are kept** (you asked for them), but they come from the library's definition of the identifier type, never from the value. The default is Shape, and policy can turn them off.
- **Ignoring short gaps in the timeline is kept** as a display choice. Weekends between jobs shouldn't count as gaps. The totals are now exact, and the ignored days are stated.
- **Negative amounts in the calculator** are rejected, with a message, until a real case needs refunds (section 3, Tools).

### Further findings

| Area | Finding | Handling |
|---|---|---|
| Lifecycle | A manual value counts as settled without validation | Section 3: validate types, options and cross-field rules before "ready". |
| Lifecycle | Submission is only known in the simulation | Section 3: reported vs observed submission. |
| Lifecycle | `quickStart` ignores other ticked forms | Section 3. |
| Lifecycle | A target form can't be removed | Section 3. |
| Lifecycle | `ensureActiveCase()` creates freehand cases | Section 4. |
| Clipping | Re-clipping restored excluded values | **Prototype:** exclusions are kept unless the value changed. |
| Clipping | Old decisions survived new evidence | **Prototype:** a decision is tied to the candidates it chose between, and reopens when they change. |
| Clipping | Auto-clip runs before the identity check | Deferred (section 1). |
| Full page | Returning should restore the source tab, scroll and focus | Section 3, Full page. |
| Tools | Mixed frequencies; same-day ranges; approximate dates | Section 3, Tools. |
| Reader | Missing states; invalid values could be added; quotes lost | **Prototype:** re-validation on add, and quotes stored with the clip. **`magic-reader.md`:** the states. |
| Privacy | "Minimum threshold" was the wrong way round | **`redact-before-ai.md`:** policy sets a maximum. |
| Privacy | DOB only caught from the case | **Prototype:** a context rule ("born", "birth", "DOB"). |
| Privacy | Hints leaked structure; a regex could contain `\|` | **Prototype:** hints come from library definitions. |
| Privacy | OCR misses things; masks too small | **`redact-before-ai.md`:** the flattened preview, manual masks, enlarged masks, markers with a legend. |
| Privacy | "Ready" meant only that a URL was set | **Prototype:** a real load and a test scan, with failure reasons. |
| Privacy | Dates and amounts per task | **`redact-before-ai.md`:** arithmetic is local; other dates are off by default. |
| Library | Generic selectors; clipping didn't use them | **`library-and-profiles.md`:** the real engine test, a test on a second record, no literals. The prototype only simulates it. |
| Library | Unsupported structures | **`library-and-profiles.md`:** stated in the editor. |
| Library | The diff ignored metadata | **`library-and-profiles.md`:** the diff includes the link pattern, `when` and rows. |
| Library | Drafts were in use by default | **Prototype:** "Not tested" until "Test and use". |
| Library | Git URL isn't a protocol | **`library-and-profiles.md`:** manifest, hashes, auth, last-known-good, rollback. |
| Log | Logs unrelated browsing | **Prototype:** approved systems only. |
| Log | Real URL fallback | **Prototype:** `(link not kept)`. |
| Log | Elapsed time shown as time on page | **Prototype:** relabelled "Until next". |
| Log | No schema version or stable IDs | **Prototype:** `schema` and `seq` in downloads. **`case-activity-log.md`:** stable IDs. |
| Log | `background.js` logs `tab.url` | Section 4. |
| Rollout | Recovery, WebGPU, mirror, XPI, diagnostics, policy restart | Section 5. |
| Accessibility | Clickable divs, dialogs, tabs, labels, colour-only signals | Section 5. |
| Security | Prompt injection, untrusted profiles, snapshot attributes | Section 3, Security; `library-and-profiles.md`; `redact-before-ai.md`. |

## 3. Cross-cutting rules

### Case lifecycle

- **Starting:**
  - Every case starts from one or more target forms. There are no freehand cases (section 4).
  - When several forms are ticked, the single-form Start buttons are disabled, and the multi-form Start names the forms.
- **Removing a target form:** it can be removed while no other form needs the fields. Evidence only that form needed stays in the case, marked "not needed by these forms", until the clip is removed or the case ends.
- **Ready to fill** means valid, not just present:
  - typed values pass the field's type validator and allowed options;
  - library cross-field rules hold (for example, the tenancy start is before today);
  - invalid values show as "needs fixing" and are left out of filling.
- **Submission:**
  - Power Loader can't see whether a form was submitted unless the library has a confirmation profile for the confirmation page, which matches the reference number pattern.
  - Without one, the caseworker ticks "I submitted this", which is recorded as *reported*.
  - The Finish dialog shows observed and reported submissions differently.
- **Identity check:** a clip whose name, date of birth, NINO or client ID disagrees with the case shows "This may be a different person" with Undo, before anything else (prototype step 6).
- **Wrong person.** The removal dialog lists everything that depends on the clip and, for "Wrong person", clears it all together:
  - values typed for its fields;
  - choices that picked its value;
  - saved workings that used it (workings record the clip ids they used);
  - AI periods found in it;
  - filled forms, which are flagged "check again", because values may already be in the target page. Power Loader can't unfill a page it doesn't control.
  - The log can be purged too.
- **Decisions** store the set of candidates they chose between. A change to that set reopens the conflict and says why.
- **Teardown** (Finish and Discard), one routine that:
  1. cancels pending AI requests, OCR jobs and model scans;
  2. makes late results check the case id and drop themselves;
  3. clears the case, every case-bearing view (reader result, preview, calculator and timeline state and results, highlights, pasted privacy text, full-page state, selections), object URLs (`URL.revokeObjectURL`) and any per-case worker state;
  4. writes the archived log (no values, notes local);
  5. shows a receipt with counts only and no names, saying that clipboard contents, downloads and target-page fields are outside Power Loader's control.

  If the browser closes mid-teardown, the next start finishes it (section 5).

### Filling

- **No clicking.** Remove `lists[].add` clicks from `extension/lib/agent.js` `fill()` for the first release. If they come back, allow only elements the library marks as row-add controls, and check at runtime that the element is not a submit, reset, link or navigation control, and not inside a different form.
- **Fill plan first.** "Fill this form" shows the plan: each box, the value, and the source, plus skipped (conflict, missing, invalid) and unmatched boxes. Nothing touches the page until the caseworker confirms.
- **Side effects.** Dispatched `input` and `change` events can trigger autosave, lookups or validation on the target page. Test each target form for side effects, and list any in the form's library entry.
- **Text report.** After filling, the sidebar keeps a list of filled, skipped, unmatched and failed boxes. Green outlines are not the only signal.
- **Stale fills.** Removing or changing evidence after a fill flags the form "check again" (prototype).

### Tools

- **Calculator:**
  - Results carry the inputs they were computed from, and are marked "Inputs changed" with Save and Copy disabled when the inputs change (prototype). Saved workings name their inputs and clip ids.
  - Default to transactions (payments). Weekly or monthly case values are opt-in and labelled with their frequency.
  - Negative amounts are rejected for now with "Adjustments aren't supported yet". If they are added later, the pruning must handle signed values.
  - Show the search limits (up to N amounts, the tolerance) and say when results were truncated. Run large searches in a cancellable worker.
- **Timeline:**
  - "Excluding gaps" is exact. Short gaps hidden from the list are counted and stated (prototype).
  - Exact days are the primary figure; months and years are approximate and labelled so.
  - Single-day periods and same-day ranges are allowed.
  - Approximate dates from AI ("mid-January") keep their precision as a range. They are excluded from exact totals until the caseworker confirms a date.

### Full page

- **Returning:** the full case page remembers the tab, window and scroll position the caseworker came from. "Back to the sidebar" restores them, and focuses the field they opened, if the tab still exists. Otherwise it says the tab was closed.
- **Unsaved input:** unsaved typing (manual values, notes) survives re-rendering. Re-render only the region that changed, or keep drafts in state.

### Security

- **Untrusted content.** Page text, OCR output, documents and model responses are evidence, never instructions. Nothing they contain can change the destination, policy, profile activation, permissions or what gets sent. The model's output is parsed against a fixed schema, and everything else is ignored.
- **Planted placeholders** are neutralised, and refs are namespaced per request (`redact-before-ai.md`).
- **Profiles** are untrusted input, validated on load, limited to approved hosts, and can't click (`library-and-profiles.md`).
- **Payloads.** HTML snapshots are scanned and reduced as a whole, including attributes and JSON-LD, not just their text (`redact-before-ai.md`).

## 4. Changes to existing extension code

| File | Change |
|---|---|
| `lib/core.js` `ensureActiveCase()` | Stop creating freehand cases, including from auto-clip. With no active case, the clip is refused and the sidebar offers to start a case. |
| `lib/agent.js` `fill()` | Remove the `add.click()` loop for list rows (around line 233). Apply only an approved fill plan. Return the full report. |
| `lib/ai/snapshot.js` `cleanHtml()` | Scan and reduce `href`, `src`, `data-*`, `title`, `alt`, `value` and JSON-LD before preview. The preview shows the HTML that will be sent. |
| `lib/ai/client.js` | Accept only payloads approved by `previewBeforeSend()`. |
| `lib/ai/generate.js` | Budget by text parts, plus a fixed cost per image (it currently uses `m.content.length`). |
| `background.js` | Don't log `tab.url` on auto-clip failure (line 32). Log the page-type ID. |
| `lib/extract.js` | Add `urlPattern` to the profile schema. Export validation reuses `validateProfile` and `validateFillProfile`. |
| The earlier PII prototype's `lib/pii.js` | Union-cover merging in place of `normalize()`, the token format, `restore()`, the DOB context rule. |
| The earlier PII prototype's `privacy/worker.js` | Pass `remoteHost`, `remotePathTemplate` and `revision`, check hashes, run a test scan, report states. |

## 5. Release criteria (verified in the real extension)

These can't be shown in the prototype. Each is a pass or fail check before rollout.

### Accessibility (WCAG 2.2 AA)

- Every action works by keyboard:
  - field rows, progress cards, calculator combinations and source rows are native buttons or links;
  - profile picking has the keyboard path in `library-and-profiles.md`;
  - region selection has a keyboard alternative (arrow keys to move and resize, Enter to capture), or "Capture the visible tab" with a crop dialog.
- **Dialogs:**
  - focus moves to the dialog on open and is trapped inside;
  - the background is `inert`;
  - Esc closes the dialog;
  - focus returns to the control that opened it.
- **Tabs:** `role="tab"` with `aria-controls` linked to its panel, arrow-key movement, and `aria-selected`.
- **Labels and errors:** every input has a visible label, not just a placeholder, and errors are announced (`aria-live`) and linked to the field.
- **Not colour alone:** status is never colour-only. Conflicts, fills and redactions have text or icons as well.
- **Screen readers:** run the full journey, at the narrow sidebar width, with NVDA and Firefox.
- **Rendering:** re-rendering keeps focus and unsaved input.

### Robustness and recovery

- **Restart and update:** after a crash, a browser restart or an extension update, the active case and its log are intact. Pending AI and OCR jobs are reported as cancelled, not lost silently.
- **Interrupted deletion:** a Finish or Discard interrupted part-way completes at the next start.
- **Locked or shared workstations:**
  - a case left open beyond a policy-set idle time asks for confirmation on return;
  - policy can require Discard when the Windows session ends (decide with IT);
  - shared profiles are not supported, and the guidance says so.
- **Storage limits:** low storage and quota errors are reported, with the case kept read-only rather than half-written.
- **Library failure:** a failed library sync falls back to the last known good set (`library-and-profiles.md`).

### Platform and deployment

- **WebGPU:** each laptop model in the estate exposes a usable WebGPU adapter in the deployed Firefox or ESR version. Record cold and warm model load times and memory use. If an adapter is missing, the readiness check says so, and policy decides whether Enhanced is blocked.
- **Model source:**
  - by default every model file loads from huggingface.co (and its download CDN) at the pinned revision; where policy sets a mirror, every file loads from it through enterprise authentication, and no request goes to huggingface.co (check with a proxy log);
  - hashes are verified;
  - interrupted downloads recover;
  - the cache is primed in the deployed profile, if pre-seeding is used.
- **Model worker lifetime:** decide between keeping it alive when the sidebar closes (for example when the full page opens) and accepting a measured reload.
- **Package:** the signed XPI with vendored pdf.js, tesseract.js and Transformers.js, about 12 MB plus WASM, installs through the managed channel. The CSP (`'wasm-unsafe-eval'`, `blob:` images) passes review. Model weights are not in the XPI.
- **Permissions:**
  - The library host, gateway host, model host and document-store hosts are separate permissions, each explained.
  - Capture uses `<all_urls>` from the managed install or a command-started `activeTab` (`magic-reader.md`).
- **Policy:**
  - Managed storage settings apply as documented. The guidance says that a policy change needs a Firefox restart.
  - Settings set by policy show as locked in the interface.
- **Region capture:** crops are correct at 125%, 150% and 200% Windows scaling, with browser zoom and scrolled pages.

### Readiness check

A "Check Power Loader is ready" page, run by IT at deployment and by caseworkers from Settings. It tests and reports:

- managed configuration loaded;
- library reachable and valid at the expected commit;
- gateway reachable with the key (one synthetic request);
- model downloaded, started and test-scanned;
- WebGPU adapter;
- free storage;
- capture permission.

Each failure gives a specific fix. Standard features stay available whatever fails.

### Diagnostics

"Copy diagnostics" gives a redacted report:

- extension and Firefox versions;
- which policy keys are set (not their secret values);
- library commit and validation results;
- model revision and state;
- gateway status code from the last test;
- WebGPU adapter info;
- recent capability failures, by type.

It never includes page URLs, payloads, case values, notes or keys. Test this.

### What a person must verify (from the build, 2026-10-19)

The extension builds and its offline tests pass, but these can only be checked on the real laptops, network and accounts. The readiness page (Settings → Support → Check Power Loader is ready) runs the automatic parts and lists the rest.

- [ ] **WebGPU:** each laptop model exposes a usable adapter in the deployed Firefox or ESR; record cold and warm model load times and memory use. The model worker belongs to the sidebar, so opening a full page (which closes the sidebar) ends it and the next ✦ action reloads it from the cache: measure that warm reload and decide whether to move the worker to a longer-lived page.
- [ ] **Model source:** every file of `openai/privacy-filter` at the pinned revision loads from huggingface.co and passes its hash check in real Firefox (the default), and from a caseworker-set server. Where policy sets a mirror: every file loads through enterprise authentication and a proxy log shows no request to huggingface.co. An interrupted download recovers. Incremental hashing runs at about 65 MB/s, so a first download spends about 15 seconds hashing.
- [ ] **Library read path:** the enterprise git host serves `library.json` and the files at `{ref}` (branch or commit); decide between a read token in policy (`library.auth: "token"`) and SSO cookies (`"cookies"`), and test it.
- [ ] **Gateway:** this extension's own virtual key, with a budget and expiry, works from the laptops; the alias in use accepts the requests.
- [ ] **Reader:** pdf.js and tesseract.js load from the extension (`wasm-unsafe-eval`, no blob workers); OCR speed and accuracy on real scanned agreements and phone photos; paste from Snipping Tool and Firefox screenshots.
- [ ] **Document store:** authenticated PDFs and `blob:` documents in frames (the MV3 fetch paths in `magic-reader.md`) under Total Cookie Protection and containers. Not built in this release.
- [ ] **Region capture** at 125%, 150% and 200% scaling, with zoom and scroll. Not built in this release.
- [ ] **Package and signing:** the signed XPI installs through the managed channel. It is about 16 MB (26 MB of that, uncompressed, is ONNX Runtime's WASM); the plan estimated about 12 MB. `web-ext lint` warns about `Function` and dynamic `import` in the vendored pdf.js, tesseract.js, Transformers.js and ONNX Runtime; confirm review accepts them. Transformers.js 4.3.1 depends on a development build of onnxruntime-web.
- [ ] **Policy:** managed storage applies after a restart; locked settings show as locked; `privacyModel.required` blocks ✦ actions until the model is ready.
- [ ] **Accessibility:** a keyboard-only run and an NVDA run of the full journey at sidebar width (start, clip, identity warning, conflicts, removal, fill plan, reader, finish).
- [ ] **Recovery:** close Firefox during Finish and check the next start completes it; fill the disk and check the case is reported read-only, unchanged.
- [ ] **DPIA:** agreed before the activity log is used, with the retention period (`activityLog.retentionDays`, default 90 as a placeholder), access, and the staff notice.

Placeholders the product owner needs to set: the library address and read authentication; the gateway address and model alias; whether to lock the model to an organisation mirror (Hugging Face at a pinned revision is the default); the redaction maximum threshold and locked groups; the log retention period; the idle time before a case asks for confirmation (default 120 minutes).

## 6. Questions to answer with real users and Firefox

- Can caseworkers tell "gathered", "valid", "filled" and "submitted" apart, especially across two target forms?
- After a wrong-person clip, can they recover without any dependent value remaining in the review, workings or target forms?
- After Finish or Discard, can any tab, worker, storage area or late response bring case data back?
- On the deployed Firefox, does every laptop model have a usable WebGPU adapter, and what are the load times and memory use?
- Is downloading the model from Hugging Face acceptable on the estate's network, or must policy lock it to a mirror?
- Can authenticated PDFs and `blob:` documents be read under cookie partitioning, containers, frames and the real viewers?
- Does region capture crop correctly at 125%, 150% and 200% scaling, with browser zoom and scroll?
- Can keyboard-only and screen-reader users complete clipping, conflicts, reading and finishing at sidebar width?
- Do generated profiles work across several records, with empty fields, repeated sections and changed layouts?
- What happens to an active case when the library publishes new form or profile versions, or becomes unreachable?
- Do redaction samples cover multilingual names, household members, new clients' dates of birth, handwriting and overlapping findings?
- Are invented, altered and page-planted placeholders rejected without restoring a value into the wrong field?
