# Power Loader for Chrome and Edge

Created: 2026-11-25. Status: plan, not started. Builds on `docs/releasing.md` (how the Firefox build is signed and shipped), `site-access-lists.md` (the site rules), `fetch-steps.md` and `json-clips.md` (fetching from the trigger tab) and `how-it-works-page.md` (the page that describes all this to security and data protection teams).

## Why

Power Loader is a Firefox WebExtension. Many of the organisations it is meant for run Chrome or Edge as the managed browser, and won't add a second browser for one tool. This plan makes a Chrome build (which Edge also runs) from the same code, with the same site rules, redaction preview and AI boundary, distributed the way enterprise IT installs Chrome extensions.

It is a plan only. Nothing is built. Where it says what the code does, the file was read for it; where it says what Chrome does, the claim is from Chrome's extension reference (checked 2026-11-25) or is marked *to check*.

## What the code depends on today

A grep of `extension/` (outside `vendor/`) for `browser.*` gives 34 distinct calls. Most are the same in Chrome's promise-based `chrome.*`. The ones that aren't, and the Firefox assumptions around them:

| Where | What it relies on |
|---|---|
| `manifest.json` | `browser_specific_settings.gecko` (id `powerloader@surprisingly.ltd`, `strict_min_version` 140.0, `data_collection_permissions`, `update_url`); `sidebar_action`; `background.scripts` with `type: module` (an event page); SVG icons; `optional_host_permissions: ["<all_urls>"]`; a 135-character `description` |
| `background.js` | `browser.action.onClicked` → `sidebarAction.toggle()`; listeners registered at top level; `completeTeardown()`, `prune()` and `retain()` run once per background start |
| `lib/pages.js` | `sidebarAction.close()` when a full page opens and `sidebarAction.open()` (no arguments) on the way back, both first thing in a click; `tabs.getCurrent()` |
| `lib/storage.js` | the background is the only writer, serialised by an in-memory promise chain (`tail`), with `storageRevision` as the optimistic check; listeners return promises from `runtime.onMessage` |
| `lib/agent.js` | the in-page agent's `runtime.onMessage` listener returns promises, and rejects with an `Error` when the page moved on (`atUrl`) |
| `lib/core.js` | `ensureAgent()` injects `['/lib/extract.js', '/lib/capture.js', '/lib/agent.js']` with `scripting.executeScript({ files })`; `fetchFromTab()` runs `fetchInPage()` with `world: FETCH_WORLD` (`'ISOLATED'`) and `args`; `originPattern()` drops the port ("Firefox match patterns have no port"); `pruneBlockedOrigins()` uses `permissions.getAll`/`remove` |
| `lib/fetch-steps.js` | `fetchInPage()` returns `{ ...head, bytes }` with `bytes` a `Uint8Array`; `credentials: 'same-origin'`, `redirect: 'manual'` |
| `sidebar/tools/reader-ui.js` | `tabs.captureVisibleTab(windowId, { format, rect, scale })`, both Firefox-only options; asks for `<all_urls>` in the click and not at all while site rules are set |
| `lib/policy.js` | `storage.managed.get(null)`, cached per context; "Firefox reads managed storage at startup" |
| `lib/diagnostics.js` | `runtime.getBrowserInfo?.()` (Firefox-only, already optional); `navigator.gpu` |
| `ui/download.js` | `downloads.download` of a `blob:` URL from an extension page, revoked on `downloads.onChanged` |
| `storage.session` | `fullPage`, `returnFocus`, `editingDraft`, `editingFlow`, `gatewayStatus`, `modelStatus`, `capabilityFailures`, the gateway key (`lib/ai/settings.js`) and the test bootstrap key: all small |
| Workers | `privacy/worker.js` and `assist/worker.js` (Transformers.js, ONNX Runtime WebGPU, `wasmPaths` from the extension, `useWasmCache = false`, `caches`), `tools/calc-worker.js`, tesseract.js (`lib/reader/ocr.js`, `workerBlobURL: false`), pdf.js (`GlobalWorkerOptions.workerSrc`, `isEvalSupported: false`). None calls `browser.*` |
| Interface text | about a dozen user-facing strings name Firefox (`sidebar/settings.js`, `sidebar/flows.js`, `sidebar/privacy.js`, `ready/ready.js`, `reader-ui.js`) |

What isn't used: `cookieStoreId`, `contextualIdentities`, `identity`, `webRequest`, `alarms`, `offscreen`. Containers appear only in `fetch-steps.md`'s test list.

**Where the heavy work runs.** Every worker is started from an extension page: the privacy and assist models from `lib/privacy-client.js` and `lib/assist-client.js` (sidebar, readiness page), OCR and pdf.js from `reader-ui.js`, the calculator from `calc-ui.js`. Fetch step runs live in `sidebar/fetch-ui.js`, which also owns the `DOMParser`. The AI client and the redaction boundary (`lib/ai/client.js`, `lib/ai/boundary.js`) are imported only by pages. The background imports `core.js` and so `fetch-steps.js` and `json-dom.js`, but only calls functions that need no DOM. So a Chrome service worker needs **no offscreen document**.

## One codebase, not a fork

**Decision: one source tree, one Firefox manifest as today, a generated Chrome manifest, and a small compatibility layer of our own.**

- `extension/manifest.json` stays the Firefox manifest, so `web-ext run --source-dir extension`, `about:debugging` loading and `tests/firefox` keep working unchanged.
- `tools/build-chrome.mjs` copies `extension/` to `dist/chrome/` and writes its manifest by transforming the Firefox one (below). A test checks the transform, so a key added to one manifest can't be forgotten in the other.
- `lib/compat.js` (new, about 60 lines) and `lib/platform.js` (new) hold every difference. Nothing else in `extension/` may call `sidebarAction`, `sidePanel`, `captureVisibleTab` or `getBrowserInfo`; a test greps for it.

### `webextension-polyfill` or our own shim

| | `webextension-polyfill` | Own `lib/compat.js` |
|---|---|---|
| What it fixes | `browser` namespace, promise wrappers for every API, promise returns from `onMessage` | `browser` namespace, promise returns from `onMessage`, errors across messages |
| What Chrome MV3 already gives | promise-based `chrome.*` for the APIs we use | the same |
| Gaps | knows nothing of `sidePanel`; wraps APIs we don't need | we write and test it |
| Review cost | a new vendored file, a `SOURCES.tsv` row, AMO and Web Store review of it | our own unminified code |

**Decision: our own shim.** Chrome MV3 already returns promises, so the polyfill's main value is the `browser` name and `onMessage`, which are a few lines. `compat.js`:

1. `globalThis.browser ??= globalThis.chrome`, so every existing call and every jsdom test (21 files set `globalThis.browser`) are unchanged. In Firefox it does nothing.
2. Wraps `runtime.onMessage.addListener` so a listener that returns a promise answers through `sendResponse` and returns `true`, and one that returns `undefined` returns `false` (the background has two listeners, `storage.js` and `pages.js`, and must not hold the channel for the other's messages). Chrome's current reference lists a `Promise` return in the listener's type, but older versions in our range answered only through `sendResponse`; the wrapper makes the version irrelevant.
3. Sends a rejection as `{ __powerLoaderError: { name, message } }` and has `runtime.sendMessage` and `tabs.sendMessage` re-throw it, so `ask()` callers still see *The page changed: try again.*

It is loaded first everywhere: `import './lib/compat.js'` as the first import of `background.js`; a classic `<script src="../lib/compat.js">` before the module script in each page (`sidebar/sidebar.html`, `case/`, `library/`, `log/`, `ready/`); and first in `ensureAgent()`'s file list. Workers need nothing.

### `lib/platform.js`

Feature-detected at run time (`browser.sidebarAction` or `chrome.sidePanel`), never a build flag, so tests can stub either:

| Function | Firefox | Chrome |
|---|---|---|
| `togglePanel()` | `sidebarAction.toggle()` | not needed: `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at startup |
| `openPanel(windowId)` | `sidebarAction.open()` | `sidePanel.open({ windowId })` |
| `closePanel(windowId)` | `sidebarAction.close()` | `sidePanel.close({ windowId })` where it exists (Chrome 141+), else nothing (below) |
| `captureRegion(windowId, box)` | `captureVisibleTab` with `rect` and `scale` | capture the whole tab, crop here (below) |
| `browserName()` | `Firefox` | `Chrome` or `Edge` (from `navigator.userAgentData.brands`) |
| `browserVersion()` | `getBrowserInfo()` | `userAgentData` |

The dozen interface strings that name Firefox use `browserName()`. Strings about restarts (*takes effect after Firefox restarts*) are per browser, because Chrome's policy refreshes without a restart (*Managed policy*, below).

### The Chrome manifest

`build-chrome.mjs` derives it:

| Firefox key | Chrome |
|---|---|
| `browser_specific_settings` | removed; `minimum_chrome_version` added (*Open questions*) |
| `sidebar_action` | `side_panel: { default_path: 'sidebar/sidebar.html' }`, and `sidePanel` in `permissions` |
| `background.scripts` + `type: module` | `background: { service_worker: 'background.js', type: 'module' }` |
| `icons`, `action.default_icon` (SVG) | PNGs at 16, 32, 48 and 128. Chrome doesn't take SVG icons. The PNGs are committed (`extension/icons/`), not rasterised in the build, so builds stay reproducible |
| `description` (135 characters) | must be 132 or fewer for Chrome. Shorten it in both manifests rather than keep two |
| — | `storage.managed_schema: 'managed-schema.json'` |
| — | `key` for self-hosted builds only, if the release uses our own signing key (*Distribution*) |
| `permissions`, `optional_host_permissions`, `content_security_policy` | unchanged |

### Build and output

| Command | Output |
|---|---|
| `pnpm build:ext` | `dist/power-loader-{version}.zip`, byte for byte as today (the reproducible job keeps passing) |
| `pnpm build:chrome` | `dist/chrome/` (load unpacked) and `dist/power-loader-{version}-chrome.zip` |
| `pnpm build:all` | both |

`dist/firefox/` as a directory isn't needed: the Firefox build is `extension/` plus vendoring, as now. `tools/vendor.mjs` bundles Transformers.js with `target: 'firefox140'`; it becomes `['firefox140', 'chrome<min>']`, one bundle for both. That changes `transformers.min.js` once, recorded in `BUNDLE.json` as any bundle change is. `tools/source-bundle.mjs` gains `tools/build-chrome.mjs`, the PNGs and `managed-schema.json` in its list; the source archive stays one archive for both browsers.

## Every Firefox dependency, mapped

| API or feature | Firefox use, file | Chrome equivalent | Gap or risk | Decision |
|---|---|---|---|---|
| `sidebar_action` | the sidebar, `sidebar/sidebar.html`; toggled from `background.js` | `side_panel` + `sidePanel` API. A global panel (`default_path`) shows in every tab of a window, as Firefox's sidebar does; a tab-specific panel (`setOptions({ tabId })`) shows in one tab | the case is bound to a window (`c.windowId`, `ui.windowId`), which matches a global panel | **Global panel only.** `setPanelBehavior({ openPanelOnActionClick: true })` replaces `action.onClicked` |
| `sidebarAction.open()` from a full page | `returnToSidebar()` in `lib/pages.js`, called first in the click | `sidePanel.open({ windowId })` (Chrome 116+), in response to a user action on an extension page, and needs a `windowId` or `tabId` | the full page learns its tab with `tabs.getCurrent()`, which is async, so the window isn't known synchronously in the click | each full page reads its `windowId` at load and passes it to `openPanel()` synchronously |
| `sidebarAction.close()` when a full page opens | `openFullPage()` | `sidePanel.close({ windowId })`, Chrome 141+ | below 141 the panel stays open beside the full page | `closePanel()` uses it where it exists; otherwise the panel shows `fullPagePointer()` (*The case is open as a full page*), which already exists for a sidebar reopened over a full page |
| Background event page | `background.js`: storage writer, teardown recovery, page routes, visit logging, permission pruning, log retention | MV3 service worker: stopped after about 30 s idle, module state lost, no DOM | see *The service worker* | keep every listener top-level; add `runtime.onStartup` |
| `tabs.captureVisibleTab` with `rect`, `scale` | `selectRegion()` in `reader-ui.js` | `captureVisibleTab(windowId, { format: 'png' })` of the whole visible tab. Needs `<all_urls>`, `activeTab`, or host permission for the page (the reference lists it among host-permission methods). Limited to 2 calls a second | no cropping, and the image is at device pixels, which include page zoom | crop in `captureRegion()` with `createImageBitmap(blob, sx, sy, sw, sh)` and `OffscreenCanvas`, scaling by `image.width / box.vw` (the agent already returns `vw`, `vh` and `dpr`), not by `box.dpr` |
| `<all_urls>` for capture | `reader-ui.js` asks for it, and not while site rules are set, because "Firefox can't grant every site but these" | host permission for the tab's origin is enough | none: it removes a limit | **On Chrome, capture uses the origin's host permission**, which the page already has to be read. No `<all_urls>` request, so region capture works while site rules are set. *To check in the Chrome suite* |
| `optional_host_permissions`, `permissions.request` | `sidebar.js`, `settings.js`, `ai-settings.js`, `flows.js`, `reader-ui.js`, in the click | the same API and the same click rule. Chrome also lets the user grant or withhold sites from its puzzle-piece menu without being asked | a site granted from Chrome's menu arrives through `permissions.onAdded`, which `background.js` already prunes | none |
| Match patterns without a port | `originPattern()`, `endpointPattern()` | Chrome patterns may name a port; a pattern without one matches every port | the same pattern works in both | keep portless patterns; update the code comments to say both browsers |
| `permissions.remove` | `pruneBlockedOrigins()` | the same, for optional permissions | none | none |
| Managed storage | `lib/policy.js` | `storage.managed` needs `storage.managed_schema`; values that don't match are dropped and reported at `chrome://policy`. Policy refreshes while running, and `storage.onChanged` fires with area `managed` | no schema exists; the cache in `getPolicy()` never refreshes; schemas can't say `null` | generate `managed-schema.json` from `POLICY_DEFAULTS` plus a type table; listen for `managed` changes and drop the cache; per-browser restart wording |
| `executeScript({ files })` | `ensureAgent()` | the same; paths are relative to the extension root | the leading `/` in `'/lib/extract.js'` *to check* | add `/lib/compat.js` first |
| `executeScript({ func, args, world })` | `fetchFromTab()`, `abortInPage()` | the same. Args must be JSON-serialisable (documented); results aren't documented as structured clone | `fetchInPage()` returns a `Uint8Array` | **return `bytes` as base64 in both browsers**, decoded in `fetchFromTab()`. A 2 MB cap makes this about 2.7 MB of text |
| Content-script `fetch()` | `fetchInPage()` in `'ISOLATED'` (way B, `fetch-steps.md`) | since Chrome 85 a content-script fetch is made as the page: same origin, page cookies, subject to the page's CORS | same-origin requests are all phase 1 allows, so CORS doesn't bite; a cross-origin request (`fetch-steps.md` phase 2) would need the other site to allow it | **`FETCH_WORLD` stays `'ISOLATED'` in Chrome.** Way B should carry the session there without way C. Cross-origin fetching in Chrome would go through way A (an extension-page fetch with host permission), not the content script |
| Runtime messages | every `sendMessage`, the storage writer's patches | `sendMessage` takes "a JSON-ifiable object" | a `Date`, `Map`, `undefined` value or typed array is changed in transit | audit payloads; a jsdom test round-trips each message type and each storage patch through JSON |
| `storage.local` | everything durable | stored as JSON in Chrome | the same as messages | the test storage double gets a JSON mode |
| `storage.session` | small view state and the gateway key | 10 MB, in memory, not shown to content scripts by default | none at today's sizes | never call `setAccessLevel` |
| `downloads` | `ui/download.js` from the library, log, flows and settings pages | the same API; `blob:` URLs from extension pages work | none expected | none |
| `runtime.getBrowserInfo` | `diagnostics.js` | none | already optional | `platform.browserVersion()` |
| WebGPU | privacy and assist workers, `diagnostics.js`, `ready.js` | in extension pages and dedicated workers on Windows, macOS and ChromeOS; Linux support depends on version and GPU, *to check* | the model can't run where WebGPU is missing, as in Firefox | the readiness check already tests it; per-browser wording |
| Transformers.js, ONNX Runtime | `privacy/worker.js`, `assist/worker.js` | the same; CSP needs `'wasm-unsafe-eval'`, which the manifest already has | `useWasmCache` is already off ("outside Chrome … blob: URL"); threads need cross-origin isolation, absent in both browsers today | unchanged; isolation is an open question |
| tesseract.js | `lib/reader/ocr.js`, a classic worker from the extension, `workerBlobURL: false` | the same under `script-src 'self' 'wasm-unsafe-eval'` | none expected | the Chrome suite's OCR tests |
| pdf.js | `reader-ui.js`, `lib/reader/pdf.js`, module worker from `vendor/pdfjs/`, `isEvalSupported: false` | the same | none expected | the Chrome suite's PDF tests |
| CSP | `content_security_policy.extension_pages` | Chrome allows `'self'`, `'wasm-unsafe-eval'` and localhost sources in `script-src`, and nothing looser | ours is already stricter than Chrome's default | unchanged |
| JSON in a tab | `json-clips.md` phase 2, routes 1 to 3 | Chrome shows JSON as plain text in a `<pre>`, with a pretty-print option | route 1 works in Chrome with no setting; in Firefox only with the viewer off | **route 3 (re-request) in both**, as `json-clips.md` recommends, so there is one code path; the Chrome suite records whether route 1 would work |
| Containers | not used in code; `fetch-steps.md` tests a container tab | none; Chrome profiles are separate browsers | none | the container test stays Firefox-only |
| `data_collection_permissions` | manifest, Firefox's install consent | none in the manifest; the Web Store's privacy practices form | consent at install isn't shown by Chrome | the Web Store form, and the first-run Settings text, carry it (*Distribution*) |
| `update_url` + `updates.json` | self-hosted updates of AMO-signed XPIs | `update_url` to an update XML of CRXs we sign, or the Web Store's own | see *Distribution* | see *Distribution* |

## The service worker

The Firefox background is an event page, so it already survives being suspended. The service worker changes four things.

1. **No start at browser start.** A Chrome service worker runs only for an event. `completeTeardown()`, `prune()` and `retain()` run at the top of `background.js` "at the next start", which in Chrome is the next event, often a tab load (`tabs.onUpdated` is registered). **Decision:** also run them from `runtime.onStartup` and `runtime.onInstalled`, so an interrupted Finish completes when Chrome starts, not when a tab next loads. They are already safe to run twice; the Chrome suite checks they run exactly once in effect, as the Firefox suite's restart tests do.
2. **Module state is lost.** `writer`'s `tail` chain, `getPolicy()`'s cache and `core.js`'s `indexed` map go when the worker stops. Losing the chain loses nothing: the worker only stops when idle, so no commit is queued, and every commit is still checked against `storageRevision`. The caches only cost time. Re-indexing a library on each wake should be measured (*Open questions*).
3. **Wakes are frequent.** `tabs.onUpdated` wakes the worker on every page load in every window; `logVisit()` reads storage and returns when there's no case. That is cheap, but it evaluates the whole background module graph each time. Measure it in phase 2; Chrome's `tabs.onUpdated` has no URL filter to narrow it.
4. **No DOM.** Nothing the background calls needs one (*Where the heavy work runs*). A new test imports `background.js` in a bare Node context with no `document`, `window` or `DOMParser`, so a later change that adds one fails offline.

**Long jobs** don't run in the background, so the worker's 5-minute limit on an event doesn't touch them. They run in the side panel and its workers, and stop when the panel closes, as they stop when the Firefox sidebar closes. No keep-alive is needed or added.

**Page routes.** `registerPageRoutes()` stores the full page's origin in `storage.session` before opening the tab, so a worker stopped between opening and returning loses nothing.

## Managed policy on Chrome and Edge

`storage.managed` works only with a schema. `tools/build-chrome.mjs` writes `managed-schema.json` from `POLICY_DEFAULTS` in `lib/policy.js` and a type table beside it, since defaults of `null` don't say what a key is (`library.pinCommit` is a string, `privacyModel.hashes` an object, `siteAccess.rules` an array of rule objects, `redaction.maxThreshold` a number). A test fails when a key in `POLICY_DEFAULTS` has no type, and validates `site/how-it-works/policies.json` against the schema.

A policy value that doesn't match the schema is dropped by Chrome before Power Loader sees it. For `siteAccess.deny` that would widen access, the opposite of `site-access-lists.md`'s fail-closed rule for a deny pattern that doesn't parse. **Decision:** type `siteAccess.allow`, `deny` and `rules` loosely in the schema (arrays of strings and of objects, no patterns or enums), so any shape reaches `policyLayer()`, which keeps failing closed on its own.

How IT sets it, for the setup page and the how-it-works page:

| Platform | Chrome | Edge |
|---|---|---|
| Windows | registry under `Software\Policies\Google\Chrome\3rdparty\extensions\<id>\policy`, by Group Policy preferences or Intune | `Software\Policies\Microsoft\Edge\3rdparty\extensions\<id>\policy` |
| macOS | a configuration profile for the domain `com.google.Chrome.extensions.<id>` | `com.microsoft.Edge.extensions.<id>` |
| ChromeOS, or Chrome Browser Cloud Management | Google Admin console, the extension's *Policy for extensions* JSON | — |
| Linux | `/etc/opt/chrome/policies/managed/*.json` with `"3rdparty": { "extensions": { "<id>": { … } } }` | `/etc/opt/edge/policies/managed/` |

*To check in phase 4:* the exact registry layout of nested objects and lists, and the Admin console's value format, against a real `chrome://policy`. The setup page gives one tested example per platform rather than general rules.

Chrome reloads policy while running (and on *Reload policies* at `chrome://policy`), and fires `storage.onChanged` for `managed`. `getPolicy()` drops its cache on that event, and the Settings card says *A change to managed policy takes effect within a few hours, or when IT reloads policy* in Chrome, keeping the restart wording for Firefox.

The `<id>` differs by channel (*Distribution*), so the policy sample is per browser and per channel.

## Distribution

Today: AMO signs an unlisted XPI (`release.yml`, `web-ext sign --channel=unlisted`), GitHub Releases holds it, and `tools/build-site.mjs` writes `/updates.json` with `update_hash` for each published version, which `update_url` polls. Enterprise policy installs `/download/power-loader-latest.xpi`.

### The two Chrome channels

| | Self-hosted CRX | Chrome Web Store |
|---|---|---|
| Signing | our key (a `release` environment secret, as the AMO secrets are) | the store's |
| Extension ID | from our key: stable, the same in Chrome and Edge | assigned by the store |
| Install | `ExtensionInstallForcelist` (`<id>;https://powerloader.surprisingly.ltd/chrome/updates.xml`) or `ExtensionSettings` with `installation_mode: force_installed` and `update_url` | the store page, or the same policies with the store's update URL |
| Who can install | on Windows and macOS, Chrome and Edge honour off-store installs only from enterprise policy on managed machines (domain-joined, MDM, or cloud-managed). Unmanaged users can't | anyone, as Public or Unlisted; Private limits it to a Google Workspace domain |
| Updates | Chrome polls our update XML; we list each CRX with `hash_sha256` | the store |
| Review | none by Google | the store's review, on every update |
| Update check, for the privacy page | Chrome adds the extension ID, its version and browser details to the request it makes to our site | goes to Google, not to us |

**Decision: self-hosted CRX first, for managed estates, then a Web Store listing (Unlisted) for trials and unmanaged users.** The self-hosted ID is one ID for Chrome and Edge, so one policy sample serves both. The Web Store ID is different, and the setup page says which goes with which.

### Release changes

- `release.yml` `build` job: `pnpm build:chrome` as well, and the rebuild-and-compare step for the Chrome zip.
- A `sign-chrome` job in the `release` environment: packs `power-loader-{version}-chrome.zip` into `power-loader-{version}.crx` with the key, using a pinned CRX3 packer (a new devDependency, or a small writer of our own: *Open questions*). CRX3's RSA signature is deterministic, so the CRX is reproducible from the zip and the key.
- `publish`: the CRX goes into the draft release, `SHA256SUMS` and the build provenance.
- `tools/fetch-releases.mjs` downloads the `.crx` too; `tools/build-site.mjs` writes `/chrome/updates.xml` (`gupdate`, protocol 2.0, one `updatecheck` with `codebase`, `version` and `hash_sha256`) and `/download/power-loader-latest.crx`, and checks each CRX's manifest version, as it checks each XPI's version and gecko id today.
- Web Store: uploaded by a maintainer from the dashboard at first; the Web Store API can come later.

### Web Store review and listing

- **Single purpose:** "Collect information for a case from approved casework pages, check it, and fill the target forms" is one purpose. The reader, privacy model and AI help serve it; the listing says so.
- **Permission justifications** for `storage`, `scripting`, `tabs`, `clipboardWrite`, `downloads`, `unlimitedStorage`, `sidePanel` and the optional hosts. `REVIEWERS.md`'s *Permissions and data* already has each reason.
- **Privacy practices:** the data types (website content, personally identifiable, financial and health information) match `data_collection_permissions`; the Limited Use certification; the privacy policy URL (`/privacy`).
- **Remote code:** none. The privacy model's ONNX weights are data, checked by SHA-256 (`lib/model-fetch.js`); vendored runtimes are packaged. Say so, as `REVIEWERS.md` does for AMO.
- **Test instructions:** the dashboard has a field for them. It gets the `amo-metadata.json` approval notes, adapted (the demo library address, *press Connect*).
- **Listing assets:** a 128 px icon, screenshots and a short description (the 132-character manifest one).

**How `REVIEWERS.md` maps.** It stays the reviewer notes for both stores, with *Rebuild*, *Permissions and data* and *Try it* written for both and a short Chrome section: the service worker, `sidePanel`, the managed schema, the CRX and update XML. The Web Store doesn't take a source archive, so *Rebuild* is for anyone checking, not for its reviewers. A `store/chrome-listing.md` holds the listing text and the privacy practices answers, as `amo-metadata.json` holds AMO's notes.

### Edge

Edge runs the same Chrome build. Two ways in:

1. **The self-hosted CRX**, by Edge's `ExtensionInstallForcelist` and our update XML. Same ID, same package. This is the default.
2. **Edge Add-ons** (Partner Center), later, if an organisation wants a store listing. Its own review and its own ID.

Edge can also install from the Chrome Web Store when allowed. *To check in phase 2:* that Edge's `sidePanel` support matches Chrome's at our minimum version.

## Security and policy parity

The site rules (`lib/access.js`, `currentAccess()`, `checkAccess()`, every choke point in `site-access-lists.md`), the redaction preview and the AI boundary (`lib/ai/boundary.js`) are the same code in both builds. Nothing in them calls a browser API that differs. What Chrome enforces differently:

| Difference | Effect | What we do |
|---|---|---|
| Users can grant or withhold sites from Chrome's extension menu | a site can gain host permission without Power Loader asking | already handled: every action is checked by the rules, and `permissions.onAdded` prunes blocked origins |
| `ExtensionSettings` `runtime_blocked_hosts` and `runtime_allowed_hosts` | IT can keep the extension off hosts at the browser level, as `restricted_domains` does in Firefox | the how-it-works page names both, as separate from Power Loader's rules |
| Capture needs only the page's host permission | region capture works while site rules are set | the `capture` action is still checked by the rules before capture, as now |
| The service worker can stop | no background job is cut short today | test it: the Chrome suite stops the worker during a commit and during teardown |
| A content-script fetch is the page's fetch | way B carries the session; the page's CORS applies | same-origin only, as now; never `'MAIN'` |
| `world: 'MAIN'` | page scripts could replace `fetch`, `Response` or `URL` and forge results, and see the request | not used in Chrome. If ever needed, the response is still parsed and checked in the extension, and the switch is per browser |
| Messages and storage as JSON | values could change in transit | the JSON round-trip tests |
| Incognito | the extension can be allowed in incognito windows in both browsers | *Open questions* |
| Policy refresh while running | a site-rule change from IT applies without a restart | `getPolicy()` drops its cache on the `managed` change; `currentAccess()` already reads live |
| Off-store installs only by policy on managed machines | an unmanaged user can't install the CRX | the Web Store listing covers them |

## Website and docs

| Page | Change |
|---|---|
| `site/setup.html` | *You need* names Firefox 140+, Chrome or Edge at the minimum version. Install sections per browser: Firefox as now; Chrome and Edge by policy (`ExtensionInstallForcelist`, with the ID and update URL) or from the Web Store; *Load unpacked* from `dist/chrome` for developers. *Settings by policy* gives the four platform examples. The WebGPU paragraph names the browser |
| `site/try.html`, `site/create.html` | *sidebar* becomes *side panel* where Chrome says so; the shortest wording covering both, or a browser switch at the top |
| `site/privacy.html` | where data lives (*the browser profile*); the update check differs per channel (Chrome sends the ID and version to our update XML; the Web Store's checks go to Google) |
| `site/reviewers.html`, `REVIEWERS.md` | both stores, as *Distribution* says |
| `site/how-it-works.html` and `tools/how-it-works.mjs` | *one Firefox extension* becomes one extension for Firefox, Chrome and Edge; the policy section gives Chrome and Edge paths beside `policies.json`; *This website* in the destinations table gains the CRX update check; the background is *an event page in Firefox, a service worker in Chrome*. The generated policy table is unchanged (one `POLICY_DEFAULTS`) |
| `site/index.html` | install buttons per browser |
| `README.md` | build commands for both; the Chrome suite |
| `docs/releasing.md` | unchanged; a Chrome publishing checklist goes in this plan's phase 4, or its own file once it's real |

`tools/build-site.mjs` gains `CHROME_ID`, `CHROME_UPDATE_URL` and `CRX_LINK` placeholders, and `tools/check-site.mjs` checks them as it checks the others.

## Testing

### jsdom (`tests/js`), kept browser-neutral

- Code calls `browser.*`, so the 21 test files that set `globalThis.browser` keep working.
- New: `compat.test.js` with a fake `chrome` whose `onMessage` uses `sendResponse` semantics: a promise answer, an `undefined` passthrough with two listeners, a rejection's name and message round-tripped, and nothing done when `browser` already exists.
- New: `platform.test.js`: the crop maths (zoomed pages, `dpr` 1.25 and 2, a box at the viewport edge), and the panel calls for both stubs.
- New: a manifest transform test, and a schema test (every `POLICY_DEFAULTS` key typed; `policies.json` sample valid).
- New: background in a bare context (no `document`, `window`, `DOMParser`).
- New: JSON round-trip of every message type's reply in `agent.js` and every storage patch in the existing storage tests (a JSON mode for the double in `storage.test.js`).
- New: a grep test that only `platform.js` names `sidebarAction`, `sidePanel`, `captureVisibleTab` or `getBrowserInfo`.

### Chrome suite (`tests/chrome`)

`tests/tools/firefox-suite.mjs` already runs the real background, sidebar, agents, workers and CSP from a temporary copy, with a driver page that reports to a local server. That design is browser-neutral. `tests/tools/chrome-suite.mjs` does the same with Playwright (already a devDependency, `@playwright/test` 1.60): `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at a temporary `dist/chrome` copy. Branded Google Chrome no longer accepts `--load-extension` (from Chrome 137), so CI uses Playwright's Chromium or Chrome for Testing. The driver modules in `tests/firefox/` (`workflow.js`, `network.js`, `documents.js`, `profiles.js`, `recovery.js`, `model.js`) are shared; they move to `tests/browser/` once both suites use them.

As in Firefox, the sidebar runs in a tab (`sidebar.html?testRun=…`), since automation can't press the toolbar button. Chrome-only checks:

- The service worker stopped (through Playwright's service worker handle or CDP) between commits, during a commit, and during teardown; the next event recovers.
- `runtime.onStartup` completes an interrupted teardown on relaunch with the same profile.
- Region capture crops to the box at zoom 100% and 150%, with host permission only.
- A fetch step's session cookie is carried from the isolated world (way B); a redirect to `/login` fails.
- The policy schema: a managed policy file for Chromium on Linux, a deny that Chrome would drop if typed strictly.
- Route 1 for a JSON tab, recorded for `json-clips.md`.

Opening the real side panel (`sidePanel.open()` needs a user action) stays a manual check on the readiness page (`ready/ready.js` `CHECKS`), with the panel's close on full pages.

### CI matrix

`ci.yml` gains a `chrome` job: `[stable, beta]` of Chrome for Testing, as `firefox` runs `[latest-esr, latest]`. Edge on Linux runs weekly in `links.yml`'s style, not gating merges. `pnpm check:lint` stays `web-ext lint` for Firefox; the Chrome build gets the manifest transform test instead, since there's no equivalent linter.

## Phasing

1. **Compatibility layer and build** (about a week). `lib/compat.js`, `lib/platform.js` with Firefox paths only, compat loaded everywhere, base64 `bytes`, JSON-safe messages and storage, PNG icons, the shorter description, `tools/build-chrome.mjs`, `managed-schema.json`, the vendor target, the jsdom tests above. *Exit:* `pnpm test` and the Firefox suite pass unchanged; the Firefox zip differs only by the planned changes; `dist/chrome` loads in Chromium with no manifest errors, and the background starts.
2. **Side panel and service worker** (one to two weeks). The panel paths in `platform.js`, `openPanelOnActionClick`, the full-page round trip with `windowId`, `runtime.onStartup`, policy refresh, interface strings by browser, the Chrome suite's workflow, network and recovery modules, the CI job. *Exit:* the shared suite passes in Chromium; the worker-stop and restart checks pass; Edge loads the build and opens the panel.
3. **Reader and models** (about a week). Capture and crop, OCR, pdf.js, the privacy and assist models on WebGPU, the readiness page. *Exit:* the suite's documents and model modules pass in Chromium (model with `POWERLOADER_TEST_MODEL=1` on a GPU machine); manual capture checks on Windows at 125% and 150% scaling.
4. **Distribution** (one to two weeks of work, plus review time). The signing key, `sign-chrome`, the update XML, the site and docs, the policy examples checked on each platform, the Web Store listing, then Edge Add-ons if wanted. *Exit:* a tagged release yields a signed CRX that a policy-managed Chrome and Edge install and update from the site; the Web Store has accepted the Unlisted listing; the site checks pass.

## What's decided

- One source tree; `extension/manifest.json` stays Firefox's; the Chrome manifest is generated and tested.
- Our own `compat.js` and `platform.js`, not `webextension-polyfill`; `browser.*` everywhere else.
- A global side panel; full pages close it where Chrome can, otherwise point to themselves.
- A service worker with no offscreen document and no keep-alive; teardown recovery also on `runtime.onStartup`.
- Region capture crops in the extension, scaled from the image's own width, with host permission only on Chrome.
- `FETCH_WORLD` stays `'ISOLATED'`; fetched bytes travel as base64.
- JSON tabs use route 3 in both browsers.
- A loose managed schema for `siteAccess`, so the fail-closed rule still applies.
- Self-hosted CRX first (one ID for Chrome and Edge), then an Unlisted Web Store listing.

## Open questions

| Question | Recommended default |
|---|---|
| Minimum Chrome version | 116 at least, for `sidePanel.open()`. Take the oldest Chrome still on Extended Stable at release, and the matching Edge |
| Should the Chrome store listing be Public, Unlisted or Private? | Unlisted. Private only suits Workspace organisations |
| Keep the self-hosted and Web Store IDs the same? | No. Document both. Try the store's key option once, and don't depend on it |
| A CRX3 packer: a dependency or our own? | A pinned, small npm packer, listed in the lockfile and the reviewer notes. Write our own only if none is maintained |
| Pre-granting origins by policy | Chrome policy can't grant optional host permissions, so caseworkers press *Allow* once per origin. `ready.js`'s *Grant the library host permission in the managed install* gets Chrome wording |
| Allow incognito? | `"incognito": "not_allowed"` in both manifests: a case belongs to a normal window, and incognito would split storage expectations |
| Cross-origin isolation for threaded ONNX Runtime | Not now. Measure single-thread model load first; COEP would affect model downloads |
| Re-indexing a library on every worker wake | Measure in phase 2. If slow, keep the indexed set in `storage.session` |
| Should `activeTab` replace the host permission for capture? | No. Host permission is already needed to read the page, and the side panel's clicks may not grant `activeTab` |
| Edge Add-ons listing | Only when an organisation asks; the CRX covers managed Edge |
| A browser switch on the website, or side-by-side text? | Side-by-side for install and policy; one shared text everywhere else |
| When `fetch-steps.md` phase 2 fetches from other origins | Way A in Chrome (an extension-page fetch with host permission). Check that it carries the session cookies before deciding, as for Firefox |
