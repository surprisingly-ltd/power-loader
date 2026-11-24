# Remove the Python backend

Date: 2026-10-19  
Status: implementation complete (2026-10-19). The Firefox suite now runs in CI on the latest ESR and release; the live-endpoint smoke test (`pnpm test:live`) stays opt-in.

## Decision and first-release scope

Move Power Loader's prompts, generation loops and validation into JavaScript in the extension. Call a configurable OpenAI-compatible Chat Completions endpoint directly. Keep declarative JSON profiles and the existing JS extraction/fill/map engine.

Run interactive AI generation in the sidebar page. Keep the background responsible for auto-clipping, cached local mapping and serialized storage writes. Store session-only keys in `browser.storage.session`, not an event-page global. Do not add Aquarium, SES, a background job service or a new build framework. The Aquarium assessment is in the appendix.

This complements [Structure improvements](structure-improvements.md): retain the completed storage/provenance fixes, include page/case stale-result guards here, and leave the visual redesign separate.

| Must ship with backend removal | Later, only if needed |
| --- | --- |
| Generic transport and all four local generation flows | General conversational agent or tool-calling harness |
| Session/local credential choices and a backup allowlist | Multiple saved provider credentials and model discovery |
| Existing validation behaviour and reviewed fixture parity | Provider-specific reasoning, JSON-schema and streaming options |
| Sidebar cancellation and stale-result guards | Generation continuing after sidebar closure |
| Decouple clip storage from mapping generation | Background jobs, subscriptions, durable job metadata and recovery |
| Versioned settings migration before switching callers | Broad `core.js` decomposition and UI reorganisation |

## Ownership and the auto-mapping behaviour change

The current mapping POST is in `core.js`, but its execution context depends on the caller:

- The sidebar calls `mapClipIntoCase()` from mapping retry and **Map again** actions (`sidebar.js`, currently lines 571 and 807).
- Manual **Add to case** also reaches it through `addClip()`.
- The background calls `addClip()` during auto-clip. That currently awaits `mapClipIntoCase()` inline, holding the tab/URL `inFlight` entry throughout generation.

Use the following ownership model instead:

| Operation | Owner and behaviour |
| --- | --- |
| Generate extraction, freehand fill or form-template profile | Sidebar; capture immutable input, call shared generation functions, show progress/result |
| Generate a clip-to-case-type mapping | Sidebar; same shared loop, triggered by manual collection or a mapping action |
| Save a clip | Domain/storage operation; commit raw data immediately, independently of AI |
| Apply an existing mapping | Short local operation usable by sidebar and background; preserve source retirement and final revision checks |
| Auto-clip with no saved mapping | Save the clip, mark it **Needs mapping**, and finish auto-clip; the sidebar generates the mapping (immediately if open, otherwise on a later action) |

**This intentionally changes automatic first-use mapping when the sidebar is closed:** loading a page will no longer start an AI mapping request without the sidebar. Existing mappings still apply automatically. All four generation capabilities remain available, but a new source kind in an automatically collected typed case needs a sidebar action before its answers populate. Surface this clearly in the clip and case views.

When the sidebar is open, keep the current first-use experience: its existing `auto-clipped` listener (`sidebar.js`, currently line 1056) starts mapping generation for that clip straight away, subject to the same identity guards and the per-pair deduplication below. Deferral applies only when no sidebar is open.

Represent **Needs mapping** with the existing record state rather than a parallel flag: records already carry `mappingError`, and the sidebar already shows “not mapped into the template yet” with a retry. Add a distinct reason (for example `mappingPending: true` alongside a cleared `mappingError`) so the views can say “needs mapping” instead of reporting a failure. Existing records with a `mappingError` from the old server keep it and remain retryable through the same action; no migration rewrites them.

One generated mapping serves every clip waiting on it. Key generation by source profile ID + case-type ID (and case-type revision): while one generation for a pair is running in a sidebar, further requests for that pair await the same promise rather than starting another. When a mapping is saved, apply it to every pending clip of that source kind in typed cases of that case type, each through the normal final-revision checks. Before generating, re-check for a saved mapping for the pair, since another window's sidebar may have produced one; `mapProfileFor()` otherwise returns whichever duplicate it finds first.

Separate finding a mapping, generating one, and applying one. `addClip()` must not hide network requests. Manual collection can orchestrate save → cached map or sidebar generation → validate/apply, while reporting that the raw clip was saved even if generation fails. Release the background `inFlight` entry after capture, storage and any cached local mapping, not after an LLM call.

Firefox MV3 background pages are non-persistent. Do not depend on a particular idle timeout or an unverified port keepalive: unload behaviour depends on views and messaging. Sidebar-owned generation removes this lifetime dependency. Closing/unloading the sidebar ends its work; explicit cancellation aborts requests, and no work resumes automatically after reload. No background AI requests are needed in the first release. [Firefox background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)

## Small module structure

Keep plain JS ES modules, `extract.js`, `casetype.js`, `core.js` and the existing storage writer. Add approximately these modules, splitting only when implementation warrants it:

```text
extension/lib/ai/
  client.js       endpoint transport and readable errors
  settings.js     versioned configuration and credential helpers
  generate.js     bounded runner plus four generation adapters
  checks.js       domain-specific validation/review/scoring
  snapshot.js     prompt HTML reduction and detached-document evaluation
extension/prompts/ packaged system prompts and DSL references
```

The sidebar owns an `AbortController` and a small operation context per active generation, with a progress callback. Business rules belong in the shared functions, not rendering handlers. Transport accepts explicit configuration and a signal; it does not import UI or case storage. Keep final application of a mapping in case-domain operations using the single background writer.

## Behaviour to port and reuse

| Current source | Required replacement |
| --- | --- |
| `generate.py` | Prompt, URL generalisation, tolerant JSON parsing, diagnostic review, feedback, score and best-attempt selection |
| `fillgen.py` | Fill path resolution; scalar selectors, row selectors/add buttons, row controls and unmapped-control checks |
| `mapgen.py` | Template/list key checks, path diagnostics, uncertainty flags and source-profile/type associations |
| `formgen.py` | Coverage/skip reasons, duplicate targets, radio groups, types/options/examples and row validation; reuse existing JS `formProfileParts()` |
| `htmlclean.py` | Local reduction of model-bound HTML with explicit truncation reporting |
| `extract.py` | Retire after fixture parity; `extension/lib/extract.js` becomes the sole engine |
| `dsl.md`, `fill-dsl.md`, generator system prompts | Move into packaged extension resources before deleting their Python sources |
| `config.py`, FastAPI schemas and LiteLLM wrapper | Versioned local settings, direct transport and JS function contracts |

Reuse `capture.js`: it already copies live input/textarea/select/checkbox/radio state into the cloned snapshot and removes ordinary scripts/styles. Add tests for reconstructed DOM property values rather than rebuilding capture. Keep a full local evaluation snapshot separate from the reduced model input. Parse a detached document in the sidebar, never attach captured HTML to the UI or execute its scripts, and verify parsing causes no resource requests while preserving selector-relevant attributes.

For form-template generation, construct an allowlisted field description that excludes `current` values **before sending**. The server currently strips those values when building its prompt, but the extension sends them to the server first. Fill generation may send intended case records; extraction requires page content. Remove passwords and irrelevant hidden credentials from outbound input without modifying the local evaluation copy.

Preserve result fields used by the UI: `profile`, `sample`, `plan`, `problems`, `notes`, `attempts`, `model` and `html_truncated`. Store notes/sample per attempt and return those belonging to the selected attempt.

## Bounded generation and prompt size

Use the existing propose → validate/evaluate → diagnose → retry pattern for each flow. Begin with three attempts. Stop on success, an unchanged normalized proposal, cancellation, deadline or attempt limit. Return the best valid attempt with unresolved issues visible; never treat a malformed proposal as a saved profile or fill a page during generation.

Build each request from a bounded window:

1. Packaged system prompt and DSL reference.
2. One immutable task input: reduced HTML, form description or source record/template.
3. Only the latest proposal and its compact feedback, if retrying.

Do not accumulate every previous reply/feedback as the Python loop does. Keep attempt summaries locally. A stateless completion request still sends the task input on every attempt: a 120,000-character HTML cap is a **per-request input component**, not a whole-operation token budget. Cap total request characters across all messages, proposal/feedback size, attempts and elapsed time; count transport retries against the request budget. Fail clearly if the task cannot fit rather than silently removing essential instructions. Provider prompt caching may reduce cost but is not a correctness or budgeting dependency.

Use text JSON responses as the baseline; optional structured-output support can follow. Validate types and allowed fields, retain DSL restrictions, reject dangerous object keys, and never use `eval`, `Function` or model-written modules to execute profiles. Retry transient network/throttling failures only within the total deadline and request budget; fail authentication and invalid-request errors directly.

## Settings, credentials and the local LiteLLM setup

Introduce a versioned non-secret `settings.ai` schema **before wiring production callers**:

| Setting | Initial value/meaning |
| --- | --- |
| `baseUrl` | Explicit provider prefix, e.g. `http://localhost:30200/v1`; initially unconfigured |
| `model` | Project default suggestion `fast`, confirmed by connection test |
| `maxIterations` | 3; replaces `POWERLOADER_MAX_ITERATIONS` |
| `maxHtmlChars` | 120000; replaces `POWERLOADER_MAX_HTML_CHARS` |
| `requestTimeoutMs` | Finite per-request timeout, e.g. 120000 |
| `operationDeadlineMs` | Overall deadline per generation, including retries and evaluation, e.g. 300000 |
| Authentication | Bearer key or no-key mode for an endpoint that supports it |

Request `POST <baseUrl>/chat/completions` with `model`, `messages` and `stream: false`. Preserve URL path prefixes and normalize trailing slashes/full pasted endpoint URLs explicitly. Distinguish missing content, refusals, length-truncated output, malformed JSON, authentication, unavailable model and rate limits. Do not require `/models`, tool calls or provider-specific options. [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/chat-completions/overview)

Project development setup, based on README and `server/.env.example`:

```sh
ssh -N -L 30200:127.0.0.1:30200 ms
```

Then configure `baseUrl: http://localhost:30200/v1`, model `fast`, and a **new extension-specific LiteLLM virtual key** with a small budget and expiry. The gateway is tailnet-only; the tunnel is the documented off-tailnet route. `localhost` must be reachable from the machine running Firefox. Existing `http://localhost/*` host permission covers this origin, including its port; test the connection in Firefox rather than assuming shell connectivity proves browser connectivity.

The SDK model prefix `litellm_proxy/` is not part of the direct gateway model name: use `fast`, and use `deepseek/deepseek-v4-flash` for this project's opt-in live smoke test. Do not copy `ENABLED_MODELS` verbatim: `.env.example` currently lists a prefixed Claude model first, while `config.py` defaults to `litellm_proxy/fast`. These are intended project aliases to verify against the gateway, not live model availability established by this review. LiteLLM documents direct OpenAI-compatible gateway requests at `/v1/chat/completions`. [LiteLLM client setup](https://docs.litellm.ai/docs/proxy/user_keys)

Never read or migrate `server/.env` credentials. Creating the separate virtual key is deployment setup, not part of a documentation edit or offline test run.

Credential choices:

- **This browser session:** use `browser.storage.session`. It survives an event-page unload and is cleared when the browser session ends; do not rely on a module global. Session storage is supported from Firefox 115, below this manifest's minimum 128. Use basic get/set/remove methods, without assuming newer helpers or `setAccessLevel()` support. [Session storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session), [Firefox compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/storage.json)
- **Remember in this browser:** store a separate local credential record, outside ordinary settings. Local extension storage is not encrypted. Trusted sidebar code can read credentials through the helper; content/page scripts must never receive them. This design does not promise OS-vault protection. [Extension storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage)
- **Forget key:** remove both session and saved credentials; switching to session-only must remove any previously saved copy.
- Replace the raw `storage.local.get(null)` backup with an allowlist before supporting persistent keys. Exclude credentials, authorization headers and request transcripts from exports/logs/errors.
- Write credentials directly from the sidebar with `storage.session.set/remove` and `storage.local.set/remove` under a dedicated key outside the writer's `KEYS`. Do **not** route them through the background storage writer: its commits travel by `runtime.sendMessage`, which reaches every listening extension page (the background and every window's sidebar), so that would broadcast the key. The writer exists to serialize revisioned writes to the shared snapshot; a single dedicated key needs no such coordination, since each `set`/`remove` is atomic. Handle partial failures across the two areas without claiming a key was forgotten or saved when it was not.
- Use one active endpoint/key pair. On endpoint change, clear credential association and require explicit re-entry/reuse; no multiple-provider vault is needed. Use HTTPS remotely and loopback HTTP locally; reject embedded URL credentials and authenticated redirects as small transport checks. Request endpoint host permission from a user action, separately from source-site access. [Host permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)

Version/migrate settings here: retain non-AI preferences and all cases/profiles/answers; remove obsolete `serverUrl` only through the migration. Do not reinterpret a custom Power Loader server URL as an inference endpoint. No AI request occurs until endpoint/auth/model setup is explicit and valid. A synthetic connection completion verifies the chosen model without page/case data; no automatic paid request runs just because Settings opens.

## Cancellation, identity and disclosures

Each sidebar operation captures its page/document identity, case ID, relevant record/type/profile revisions, endpoint/model settings and a local operation token. Before displaying or applying results, compare the captured identity with the intended target. Cancel/discard stale work after navigation (including same-URL reload), case switch, source edits/deletion or settings change. A tab switch must not silently reassign a result. Keep final storage revision checks and source retirement even when the UI already checked identity.

On explicit cancel, abort fetch/backoff and check the signal between evaluation steps. Sidebar closure/reload discards unfinished work; best-effort abort on unload does not guarantee the remote provider stops billing. Do not claim an AbortController can interrupt arbitrary synchronous DOM work; keep inputs bounded and test evaluation performance. No persisted job metadata, automatic replay, global subscriptions or runtime-port keepalive is required.

Reword the three disclosure blocks in `sidebar.js` (currently lines 331, 419 and 630): replace “your Power Loader server” with the selected endpoint and explain task-specific data transmission. Replace the Settings `/api/health`/`llm_configured` check (currently line 1019) with the synthetic completion. Preserve “never submits” for explicit form filling. Before publishing, reconcile `data_collection_permissions.required: ["none"]` and transmission consent with the actual behaviour and supported Firefox versions. [Mozilla transmission requirements](https://extensionworkshop.com/documentation/publish/add-on-policies/#6-data-collection-and-transmission-disclosure-and-control)

## Migration phases and gates

| Phase | Work | Completion gate |
| --- | --- | --- |
| 1. Freeze the reference | Preserve current expected fixtures; move prompts/DSL docs; port Python-only validator cases | Current 71 JS tests remain green; every Python-only check has a JS test target |
| 2. Local generation | Implement shared loop, checks and all four adapters against injected fake completions; reuse capture. Move the `storage.test.js` mapping tests (currently a `fetch` stub for `/api/` at line 161, used by the “delayed AI mapping” provenance tests) onto the injected fake completion | Offline tests cover JSON recovery, feedback, no-progress stopping, bounded histories and best-attempt selection; the delayed-mapping provenance tests pass without any `/api/` stub |
| 3. Transport and migrated settings | Add direct client, versioned schema/migration, session/local credentials, backup allowlist and connection test | Old data survives; no inference until configured; keys survive background unload but stay out of exports; tunnel smoke test is opt-in |
| 4. Decouple mapping and wire sidebar | Separate save/find/generate/apply; replace three sidebar POSTs and all mapping-generation paths; add cancellation/identity guards | All four flows work with Python stopped; auto-clip with missing mapping saves promptly, maps immediately when the sidebar is open and visibly defers otherwise; concurrent requests for one source/type pair produce one mapping applied to every pending clip |
| 5. Remove backend and tooling | Delete Python after parity gates; update docs/scripts/demo/fixtures tooling and unused routes | Install/build/test/lint and Firefox smoke checks require no Python, uv, FastAPI, LiteLLM SDK or Aquarium |

Inventory for phase 5:

- Delete `/api/profiles/test`, `/api/dsl` and `/api/fill-dsl`: they have no extension callers. Preserve any useful route-test assertions in local JS tests; replace `/api/health` through the Settings connection test.
- Port `server/tests/regen_expected.py` and `tests/tools/make-form-profile-fixture.py` to Node as **manual maintenance tools**, never a prerequisite for tests.
- Freeze existing `fixtures/expected/*`. Today the Python engine generates reference outputs checked independently by JS; after removal, a JS generator is no longer an independent oracle. Treat hand-written `dsl-cases.json` as the core behavioural specification, retain the historical snapshots, and require a reviewed diff plus semantic explanation for every regeneration. Never regenerate fixtures merely to make a failing implementation pass.
- Preserve fixture/template demo URLs. Add an optional Node static server for `demo/` on port 8787 and update `start:firefox`; this is developer tooling, not an installed-app dependency.
- Update README, engine comments, DSL links and remaining custom `/api/*` references (the fake mapping tests move in phase 2). Remove the root PyCharm `main.py` boilerplate with this cleanup.
- Retain `hello-world-extension/` unless separately retired: its README documents a corporate installation/signing diagnostic, so apparent age alone is not evidence that it is unused.
- Keep `scratch/aquarium` out of extension packaging and production test discovery.

## Verification and completion

Keep default tests offline. Cover all existing engine, storage and provenance cases plus:

- Every migrated validator; stable result shapes; uncertainty; notes/sample from the selected attempt; bounded total request characters and latest-only feedback.
- Capture/reconstruction parity and no snapshot script execution or resource requests.
- URL prefixes/auth modes, permission failure, refusal/length/invalid responses, request limits, timeouts and cancellation.
- Settings migration, session-key survival across background unload, saved-key removal, safe backups and no endpoint-change credential reuse.
- Stale results after navigation/reload, case/record/type changes and settings edits; raw clip saved despite mapping-generation failure; background auto-clip never waits for AI.
- Mapping deduplication: two concurrent requests for one source/type pair make one completion sequence and one saved map; a saved mapping is applied to every pending clip of that pair; credentials never appear in `runtime` messages.

In Firefox, exercise all four generation flows with Python stopped, test `fast` via the tunnel and explicitly opt in to the `deepseek/deepseek-v4-flash` smoke test. Record endpoint/model combinations actually tested. Close/reopen the sidebar and unload/restart the event page to verify session keys and mapping behaviour. Confirm cached profiles still work with inference unavailable.

Completion means all Power Loader business logic runs in the extension, no custom backend routes remain, existing case data survives, reference fixtures remain meaningful, and the mapping deferral behaviour is documented and visible. A generic gateway may still protect organizational provider secrets; it contains no Power Loader business rules.

## Appendix: Aquarium and SES assessment

Inspected `scratch/aquarium` at commit `3f8a7a001092168c40f51be55e0e0ab05df30311`: [`package.json`](../../scratch/aquarium/package.json), [`runtime.ts`](../../scratch/aquarium/src/runtime.ts), [`config.ts`](../../scratch/aquarium/src/config.ts), [`llm.ts`](../../scratch/aquarium/src/llm.ts), [`execute.ts`](../../scratch/aquarium/src/js/execute.ts) and [`runner.ts`](../../scratch/aquarium/src/js/runner.ts).

Aquarium uses pi-agent-core/pi-ai for general agent orchestration and `ses: ^2.0.0` for model-authored JS in a worker. SES supplies confinement, not the model loop. Its `lockdown()`/fresh `Compartment` and worker timeout/cancellation patterns are useful references, but current Power Loader features need only bounded JSON proposal/testing. [SES upstream documentation](https://github.com/endojs/endo/tree/master/packages/ses)

The inspected sandbox calls `Compartment.evaluate()` on source strings. Firefox MV3 restricts dynamic evaluation in extension pages/workers; worker placement alone does not prove compatibility. Mozilla also prohibits loading remote code for execution. These are further reasons to avoid adding model-authored JS execution here. No Aquarium-in-Firefox prototype was run. [Firefox CSP](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy), [Add-on development policies](https://extensionworkshop.com/documentation/publish/add-on-policies/#4-development-practices)

If a later interactive assistant needs tool selection, reconsider Aquarium with `js/files/todos/task` disabled and only bounded Power Loader tools exposed. Verify CSP, dependencies, request budgets and per-operation state before adoption. Do not import production code from `scratch/`.

## Review record

Revised from source inspection and primary Firefox/LiteLLM documentation after the external review: session storage replaces background globals; sidebar ownership replaces background jobs; mapping deferral is explicit; prompt histories and fixture regeneration are bounded/reviewed; settings migration precedes caller switching; deployment/caller/cleanup inventories are concrete. Exact idle timeout and current gateway model availability are not assumed. No keys were accessed, no gateway requests were made, and no application code changed during this revision. Document links were checked; implementation and Firefox smoke gates remain future work.

## Implementation progress

- Phase 1 in progress: copied packaged prompts/DSL references and froze historical expected fixtures with SHA-256 hashes.
- No live endpoint calls or backend keys will be used by default.

- Phases 1–2 implemented: all four generators and validators run in JS; delayed-mapping tests use injected completions. Historical references remain unchanged.
- Phase 3 implemented: versioned AI settings, direct transport, browser-session/local key choices and allowlisted backups. Keys never pass through the runtime writer.
- Phase 4 implemented: sidebar-owned operations, cancel/reload guards, immediate open-sidebar mapping, cached-only background mapping, per-pair sharing and application to pending clips. Integration verification is in progress.
- Phase 5 in progress: Node demo/maintenance tools replace Python tooling; backend removal follows offline validation. Firefox is not installed in this environment; live model smoke tests remain explicitly opt-in.

### Final implementation and verification

- Phases 1–5 are implemented. Removed the Python backend source, Python tests/build metadata, obsolete routes and the root starter. Existing ignored local `.env`/virtual-environment files were left untouched; no credential was read or migrated. The installation diagnostic extension and Aquarium reference checkout remain separate.
- Added six focused AI modules (the proposed five plus sidebar mapping orchestration), packaged prompt/DSL resources, direct endpoint Settings, session/local credential controls, transmission consent, operation cancellation and source-document identity checks. Extension version is 0.5.0.
- All **105 offline JavaScript tests passed**: 43 conformance, 15 case-domain, 17 storage/mapping, 14 generation/validation, 10 transport/credentials, 5 sidebar integration and 1 demo-handler test. This includes fake-model delayed-mapping tests without an old `/api/` stub, multi-clip mapping sharing, automatic open-sidebar mapping, same-URL reload and case-switch cancellation, and cached mapping without credentials.
- Extension lint: **0 errors, 0 warnings, 0 notices**. Additional unused-variable checks passed. Built `dist/power-loader-0.5.0.zip`; the archive contains extension resources only, including all prompts. The lint/build tool's optional user-config update check could not write outside the workspace; lint and packaging completed successfully.
- Both Node fixture-maintenance tools were exercised into `/tmp`. Every candidate matched its historical reference semantically. No reference fixture or reference hash was regenerated after the initial freeze.
- The Node demo request handler passed direct HTTP-handler tests, including access boundaries. A real listening-server smoke test could not run: binding a localhost port returns `EPERM`. After the user suggested running outside the sandbox, the execution tool rejected escalation because this session's approval policy disables it. This is an environment restriction, not a passed server smoke test.
- Firefox is not installed in this environment. Actual Firefox host-permission prompts, snapshot network behaviour under extension CSP, Web Locks across separate windows, event-page unloads and real form interaction remain to be smoke-tested in Firefox. No real gateway/model calls were made: live testing remains explicit opt-in with a dedicated key. The old backend key was never accessed.
- Remaining external checks: load the built extension in Firefox; save/reopen a session key; verify all four generation flows with Python stopped; verify auto-clip with the sidebar open/closed; run the explicit `fast` connection test and optional `deepseek/deepseek-v4-flash` smoke test against the configured gateway. These verification gates are recorded as outstanding rather than assumed complete.
