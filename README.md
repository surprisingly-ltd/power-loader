# Power Loader

[![CI](https://github.com/surprisingly-ltd/power-loader/actions/workflows/ci.yml/badge.svg)](https://github.com/surprisingly-ltd/power-loader/actions/workflows/ci.yml)
[![Security](https://github.com/surprisingly-ltd/power-loader/actions/workflows/security.yml/badge.svg)](https://github.com/surprisingly-ltd/power-loader/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/surprisingly-ltd/power-loader/badge)](https://securityscorecards.dev/viewer/?uri=github.com/surprisingly-ltd/power-loader)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

A Firefox extension for caseworkers. Every case is a run of a flow: the steps of one process, done for one piece of work. Power Loader clips values from the approved casework systems, shows where sources agree and conflict, and fills the target forms with checked values. Flows, forms, fields and page profiles come from the team's library. All application logic runs in the extension.

The organisation controls what is sent where. Power Loader works with no AI at all: remote AI is off until it is set up, flows can be built entirely by hand, and site rules can be very strict allow and deny lists. AI is optional, through the organisation's own OpenAI-compatible endpoint, such as an internal LiteLLM gateway. If AI is used, every ✦ request is redacted on this computer, by default with the on-device privacy model, and shown in a preview before anything is sent. An organisation can lock it down or make it smart and easy, and lock each choice: policy decides first, then the forms library, then the caseworker in Settings. [How it works](https://powerloader.surprisingly.ltd/how-it-works#choices) sets out the choices.

**Website, demo and install instructions:** <https://powerloader.surprisingly.ltd>. Privacy policy: <https://powerloader.surprisingly.ltd/privacy>. Notes for add-on reviewers: [REVIEWERS.md](REVIEWERS.md). Published as open source (Apache-2.0) by Surprisingly Limited.

The design and its decisions are in [the first release plan](docs/plans/release-plan.md), which links the feature plans. How a version is signed and published: [docs/releasing.md](docs/releasing.md). `prototype/case-journeys.html` is the clickable prototype; `pnpm test:prototype` checks it.

```text
extension/
  background.js            storage writer, interrupted-teardown recovery, activity logging, page routes
  lib/case.js              the one active case: field state from clips, conflicts, identity check, removal
  lib/fields.js            field types, validators and library rules
  lib/library.js           indexing and validating one library commit (profiles are untrusted)
  lib/library-sync.js      manifest, hashes, last known good, policy pin
  lib/drafts.js            local profile drafts: picking, test-before-use, diff, export checks
  lib/flows.js             flows: forms to fill, pages to clip and the field contract; checks, compile, export
  lib/fill.js              the dry-run fill plan (values only)
  lib/teardown.js          Finish and Discard
  lib/activity.js          the activity log schema; lib/visits.js decides what is logged
  lib/pii.js               placeholders, union cover, strict restore (from an earlier PII prototype)
  lib/privacy-detect.js    case values, library patterns, the DOB rule, model spans
  lib/ai/boundary.js       previewBeforeSend(): the only way to the gateway; lib/ai/client.js enforces it
  lib/ai/tasks.js          the ✦ actions, one approved request each
  lib/calc.js, timeline.js the Standard tools; lib/reader/ reads PDFs and pictures on this computer
  lib/journey.js           a flow's steps (templated links) and timelines in a case: steps.json, timelines.json
  lib/extract.js           the extraction DSL engine (frozen conformance fixtures)
  lib/json-dom.js          JSON responses as a synthetic document extract.js reads (strict parser, limits, quotes)
  lib/fetch-steps.js       running a fetch step: plan, request from the trigger tab, read (HTML or JSON), clip
  lib/agent.js             the in-page agent: extract, probe, pick, drag, override, fill (values only), highlight
  lib/assist.js            making a profile: page values → target fields (rules), the model's prompt and merge
  assist/worker.js         the on-device profile assistant (Gemma 3 1B, Transformers.js, WebGPU)
  sidebar/                 the sidebar: start, case, tools, privacy, flows, settings, draft editor
  case/ library/ log/ ready/  full pages that replace the sidebar while open
  privacy/worker.js        the on-device privacy model (Transformers.js, WebGPU)
  ui/                      DOM helpers, dialogs, tabs, shared styles
  vendor/                  written by tools/vendor.mjs at build time (not in git)
demo/                      fictional pages and a demo forms library (demo/library/)
fixtures/                  DSL specification, frozen reference outputs, document OCR samples
tests/js/                  offline tests; tests/tools/ manual and opt-in tools
```

## Install and try it

```sh
pnpm install
pnpm vendor          # builds Transformers.js with released ONNX Runtime; copies PDF/OCR libraries
pnpm demo            # generates the demo casework systems, then serves demo/ at http://localhost:8787/demo/
```

To install a signed release, follow [Setup](https://powerloader.surprisingly.ltd/setup) (enterprise policy or one computer). To run it from source, in Firefox 140 or newer, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and select `extension/manifest.json`. Open the sidebar with the toolbar button.

The first time the sidebar opens it starts on **Settings**, with what to set up: download the on-device privacy model there (**Download and test the model**), connect a library if you have one, and turn on the ✦ Remote AI if you use it. The Privacy tab has the model's server and the redaction settings; it works with or without a library.

In the sidebar's **Settings**, enter the library address `http://localhost:8787/demo/library/` and press **Connect**. On the **Case** tab, star the flows you work and start one (*Discretionary housing payment*, say), then visit the demo pages from <http://localhost:8787/demo/> and clip them. `client-2077.html` is a different person, so clipping it shows the identity warning. `dhp.html` is a target form with a fill profile and a side effect; submitting it opens a confirmation page that Power Loader recognises.

**The demo casework systems** are four fictional systems and a staff intranet with 100 cases, generated from a fixed seed by `tools/build-demo-systems.mjs` into `demo/cm/`, `demo/biv/`, `demo/harbour/`, `demo/messages/` and `demo/intranet/` (about 1,290 static files, not committed: `pnpm demo`, `pnpm test` and the site build write them; `pnpm check:demo` checks they're deterministic, fictional and current). Each system has a homepage, and its header links only to pages that exist: Case Manager's *My work* (<http://localhost:8787/demo/cm/index.html>) and work queue, every income record, every tenancy, and the Housing Support Team's inbox. Pick up a case from the work queue, and each case page links to the client's case notes, their employment and income record (Benefits and Income Verification), their Harbour Homes rent account and their Customer Messages. A client's messages page lists six messages; only *Tell us about a change* online forms carry an effective date, a new weekly income or a tenancy end date, so a caseworker would open each in turn. The same messages are served as JSON (`demo/messages/api/NC-xxxx.json`). The team inbox also has **referrals** from partner organisations, urgent or routine, open or already picked up, and emails asking about them, all with the subject *Referral received*: page 1 has exactly 4 urgent open referrals, two of them for cases 1012 and 1020. A few cases disagree across systems on purpose: an old address at Harbour Homes (case 1003), a surname spelt differently (1007) and a different person under a reused reference (1005). The intranet's *Rent support review* procedure (`demo/intranet/rent-support-review.html`) is the council's own, for working a case by hand and timing it before trying the flow. **Mark as done** on a case page is kept in the browser's localStorage only, the queue then offers the next case, and *Reset the demo* clears it. The library's *Rent support review* form fills `demo/rent-review.html`. The demo library carries its flows (listed on the Case tab to start, and in Build on the Flows tab under *From your library*), and the site's *Try a flow* page offers them as downloads too: two rent support reviews, which start with *Choose a case* (open a case in the work queue and Power Loader takes its number from the address), email the client for a missing tenancy reference, and fetch the client's six message pages 4 at a time or read the JSON instead; and the *Inbox triage*, which fills no form, fetches the 25 messages on the inbox page and lists and marks the open urgent referrals. The demo library's `access.json` locks one site rule: fetch steps may read only the messages service, so a fetch step pointed at another demo system is refused.

**Making a flow** needs no library. A flow is the forms a case fills, the pages it clips from and the fields between them: what a library is made of. The sidebar has two modes, switched in its header: **Casework**, for working a case along its flow's steps, and **Build**, for making and mending flows. Build is for everyone; the site rules bind a flow whoever made it. In Build's **Flows** tab (or *Build a flow* on the Case tab before a library is connected), choose **New flow**, name it and optionally paste guidance; `demo/index.html` has guidance for the demo pages. Start with the form to fill: open it in the tab, choose *Use this form*, then *✦ Make the template with AI* (the form's boxes and the guidance go through the redaction preview; the AI says which fields the form collects and where) or *Make it by hand* (type a field's name, then click its box). Do the same on each page to clip: the AI gets a reduced copy of the page's HTML (no scripts or styles, no values of hidden or password inputs, links cut to their path shape; `cleanHtml()` in `lib/ai/snapshot.js`), with every value Power Loader outlines on the page (three characters or more), anything the library's patterns match and anything the privacy model finds replaced by a placeholder, and returns selectors for the flow's fields. Other text on the page, such as headings and labels, is sent as it is, so read the preview. Test each page there. The flow is checked as you go, and each problem offers its fixes, including *✦ Fix with AI*. **Export** downloads one `powerloader-flow/1` file with the flow and the library files it becomes (`fields.json` entries, a form and fill profile per form, a page profile per page); **Import a flow** opens one again, and *Make a flow from a library form* copies a library form with its profiles. A case can start from any flow (**Try it** in Build, or **Start** on the Case tab), with or without a library: the flow is compiled and pinned by the case like a library commit. A flow can also guide the caseworker, so they don't need the guidance page again: add **Pages to visit** (a work queue such as `demo/cases.html`, a search page), write what to do on each page, and add links to the next step whose addresses carry values from the case (`client-{ref}.html`, `search?q={lastName}`), or let *✦ Write the steps from the guidance* draft them. A case from the flow lists every step on the Case tab, numbered, with a tick when done; the open step (the one for the page in view) has one green button, always the next thing to do: go to its page, clip it, fill the form, then *Next*. Its links are filled in from the case. After a clip the step says what it is to the case now (*5 matched · 2 new · ⚠ 1 conflict: Postcode*, then *1 used* or *1 overridden* once decided). A value in conflict is orange with ⚠ and the word *Conflict* in the step and on the page; its name goes to its card, and each source on the card goes back to its page, where the value is scrolled into view and held in orange. A value in a closed part of a page (an accordion, a tab) is opened by the template's **reveal rule**, which only adds or removes class names (or opens a `<details>`, or removes `hidden`) and is put back afterwards; in Build, open the part by hand and Power Loader offers the class names that changed as the rule. Two more kinds of step need no web page: a **Screenshot to read**, for a system Power Loader can't clip (snip a desktop app with Win+Shift+S and paste it into the step; OCR on this computer finds the values it names, such as the case reference by its shape `CM-\d{6}`, and the caseworker checks them before they're added), and an **Email to send**, whose To, Subject and text are templates filled from the case and opened in the caseworker's own email app with a `mailto:` link. **Pages to fetch** is a step that saves opening pages: on its page (say *Start case*), the caseworker presses *Fetch 3 pages* and Power Loader fetches each page it names from the same system (GET only, no redirects, every address checked by the site rules), reads it with its page's profile and adds the values as clips. Each page is made like a page to clip, then checked with *Test as fetched*, and the step's editor previews every request as it will be sent ([the plan](docs/plans/fetch-steps.md)). While it runs, each page it reads has a box on the step's page showing what came back, as text, with the values it reads outlined and travelling to the sidebar; then the box shrinks to a line in a strip along the bottom. Afterwards *View what was read* opens the **fetched view** on the case page: the text around each value read (kept with the clip, at most 500 characters a value, deleted with the case), what happened to each value, *Open the page* and *Fetch again* ([the plan](docs/plans/conflicts-and-fetch-views.md)). A page to fetch can also be **data (JSON)**, for systems that build their pages in the browser from their own API: paste the address the page loads its data from (the browser's network panel shows it), *Fetch a sample* from the trigger page, and pick values in the sample's tree view; the test on the sample is the test as fetched. Power Loader parses the response with its own strict parser into a document the same profile engine reads, refuses a response that isn't JSON or is too large rather than reading part of it, and keeps each value's path and raw text as its quote (`.person.dateOfBirth: "1986-07-14"`), shown with the value in the case. A JSON clip is otherwise an ordinary clip: the identity check, conflicts and the fill plan don't know the difference ([the plan](docs/plans/json-clips.md)). Any page of a flow can also carry **notes on the page**: at a selector (picked on the page, or typed as in a profile), expanded or compact (a marker that opens it), with a style override (colours, fonts, borders) and content in a small subset of HTML with case values in it, such as *Check the arrears: the referral says £{arrears}*. They're drawn while a case from the flow is open, in a closed shadow root, built from a parsed tree rather than HTML, and each says it's from Power Loader. **Timelines** choose which dates the case's timeline draws: series of bars (employments, tenancies) and pointers, each with its colour or shape, from table rows on a page (pick a cell) or from date fields. See [the plan](docs/plans/flow-authoring.md).

**Making a profile** starts from the target. On a form's page, *Make a profile for this page* → "This page is a form to fill" matches the form's boxes to its fields. On a page you gather from, choose the target forms (only forms with a fill profile can be chosen). Their fields become drop zones in the sidebar, and every value on the page is outlined. Power Loader's rules (labels, names, types, the privacy categories and the library's validators) fill in what they can straight away. Drag a value from the page onto a field, or click it and choose its field; *Pick something that isn't outlined* reaches any other element. When the ✦ Remote AI isn't turned on, the optional on-device model (Gemma 3 1B, about 785 MB, downloaded from Hugging Face the first time, pinned and hash-checked like the privacy model) then suggests fields the rules missed, each marked *Check this*. Policy `assistModel.enabled: false` or the editor's checkbox switches it off. It has no *Remove* button: its files stay in the browser's cache until the extension is removed. `node tests/tools/assist-eval.mjs` scores the rules on the demo pages; `node tests/tools/assist-model-eval.mjs` (slow, downloads the model) scores the model. See [the plan](docs/plans/local-profile-assist.md).

The on-device privacy model downloads from Hugging Face by default (`openai/privacy-filter` at a pinned commit, about 920 MB, every file checked against its SHA-256; see `DEFAULT_MODEL` in `extension/lib/model-fetch.js`). A caseworker can point it at a folder holding the same files on any web server, or at a Hugging Face mirror, on the **Privacy** tab under **Where the model comes from**, where **Test connection** reports which files were found. Policy locks the address (`privacyModel.filesUrl` for a folder, `privacyModel.baseUrl` for a mirror), and policy or the library's `privacy.json` can set another revision and hashes.

The privacy model is on by default and can be switched off (`modelUse()` in `extension/lib/model-fetch.js`). Policy `privacyModel.use` (`true` or `false`) sets it and locks it, and a policy that sets `privacyModel.required: true` keeps it on. Otherwise the library's `privacy.json` can set `"use": { "on": false, "lock": true }`, as a default or locked, and failing that the caseworker decides in **Settings → On-device privacy model**. Off, nothing is downloaded or scanned and the model isn't required before sending; case values and the library's patterns are still redacted, and the preview says the model is off and who turned it off.

## Policy

Enterprise settings come from managed storage (Firefox `policies.json`, `3rdparty` → `Extensions` → `powerloader@surprisingly.ltd`). The keys are listed with their defaults in `extension/lib/policy.js`: `library.*`, `gateway.*`, `privacyModel.*`, `assistModel.*`, `redaction.*`, `activityLog.*`, `workstation.idleConfirmMinutes` and `siteAccess.*`. Settings set by policy show as locked. Among them: `gateway.enabled: false` turns the remote AI off and locks it off, `library.syncMinutes` sets how often the library syncs by itself (default 60, also at start), `workstation.clearCaseOnClose` (on by default) deletes the open case when Firefox closes, `workstation.clearCaseAfterHours` (default 24, in half hours, or a maximum with `workstation.clearCaseMaxHours`) deletes it after a time without use, `tools.capture`, `tools.reader`, `tools.calculator`, `tools.timeline` and `tools.notes` switch each tool (set, locked; unset, the caseworker's), `privacyModel.use` sets and locks whether the on-device privacy model is used (unset, it's on unless the library or the caseworker turns it off), `privacyModel.required` (on by default) holds every AI request until the model is ready while it's used, and `assistModel.enabled: false` turns the profile assistant off. Firefox reads managed storage at startup, so a policy change needs a browser restart.

**Organisation builds.** An organisation can build its own version with its rules in a **policy file** built into the signed package (`extension/policy.json`; the repo's own file sets nothing). It has the same keys, plus `allowed` patterns that constrain a setting instead of fixing it, and `build.hosts`, the sites Firefox grants at install and the only ones the build can connect to. With `build.hosts`, capture uses `activeTab`, started from the page's right-click menu or Alt+Shift+R. An organisation build ignores managed storage. Check a file with `node tools/policy.mjs check|explain|try`, build with `pnpm build:ext --policy <file>`. Six samples are in `policies/samples/`. See [docs/organisation-builds.md](docs/organisation-builds.md).

For security, compliance and data protection teams, [How it works](https://powerloader.surprisingly.ltd/how-it-works) explains the parts, the controls and what leaves the browser, with every policy key.

**Site rules** (`siteAccess.*`, see [the plan](docs/plans/site-access-lists.md)) say where Power Loader may read, fill, write notes, capture and open pages. They limit Power Loader, never the caseworker's browsing: a blocked page still opens and works, Power Loader just doesn't work on it. They guard against a mistaken or poisoned flow or profile, not against the caseworker.

```json
"siteAccess": {
  "allow": ["https://*.example.gov.uk*"],
  "deny": ["https://finance.example.gov.uk*"],
  "rules": [{ "id": "pay", "effect": "deny", "pattern": "https://cm.example.gov.uk/payments/*", "actions": ["fill"] }],
  "lockLibraryRules": false,
  "backgroundReading": false
}
```

- `allow` and `deny` are lists of addresses; `rules` are full rules `{ id, effect: "allow" | "deny", pattern, actions?, note? }`, where `actions` are any of `navigate`, `read`, `fill`, `annotate`, `capture`, `fetch-get` and `fetch-post` (left out: all of them). `fetch-post` is closed: only an allow rule that names it opens it. Nothing in this version makes a POST request: a fetch step must use GET, and a flow or library that asks for another method is refused when it is checked.
- Addresses are written like profile match patterns but read as URLs, in their parts: `https://`, `http://` or `*://`; a host, or `*.` and a domain for the domain and all its subdomains; an optional `:port`; then `*` for every page, or a path (`*` is any run of characters, and the query is part of the path). A deny written with `https://` covers `http://` too.
- Policy rules are a layer above the library's `access.json` and the caseworker's own rules in **Settings → Sites Power Loader works on**. Deny wins in any layer; allow lists in different layers intersect, so adding rules only ever takes pages away. `lockLibraryRules: true` makes every rule in the library's `access.json` locked, whatever the file says.
- A policy allow address Power Loader can't read is dropped, which narrows. A deny address it can't read would widen if dropped, so Power Loader fails closed: it works on no page until IT corrects it, and Settings says which address.
- **Read pages in the background (pages you're not on).** A flow's *fetch step* fetches pages from the system the caseworker is on, when they press its button, reads them with their page profiles and adds the values to the case (see [the plan](docs/plans/fetch-steps.md)). One switch covers it, on by default (`BACKGROUND_READING_DEFAULT` in `extension/lib/access.js`). `siteAccess.backgroundReading: false` turns it off and locks it (`true` turns it on and locks it); the library's `access.json` can set it with `"backgroundReading": { "on": false, "lock": true }`, locked or left to the caseworker, who otherwise sets it in **Settings → Sites Power Loader works on**. Off is a deny of `fetch-get` and `fetch-post` through the same rules, so fetch steps don't run and say who turned it off; the caseworker opens each page and clips it themselves.
- Power Loader never asks Firefox for a site the rules block entirely, and removes host permissions it already holds for one (at startup, when the rules change, and when one is granted in about:addons). With any rule set it doesn't ask for `<all_urls>` for *Select a region*. IT can also use Firefox's own `ExtensionSettings` → `restricted_domains`; that is separate from these rules.

## AI gateway

All AI goes through the organisation's LiteLLM gateway (OpenAI-compatible). Enter its `/v1` address, model and this extension's own virtual key under **Settings → ✦ Remote AI**, or set the address by policy, and tick the acknowledgement: the anonymised page is sent, the anonymisation might not be perfect, and the caseworker must check that this complies with the law and their organisation's policies. A change to that wording asks again. Never use a provider key. Every ✦ action builds its payload, redacts personal data on this computer, and shows the preview; nothing is sent until the caseworker presses Send. Redaction uses the case's values, the library's patterns and, unless it's switched off, the on-device privacy model; while the model is used and `privacyModel.required` is on (the default), nothing is sent until it's ready. With the model off, the preview says so. See [How it works](https://powerloader.surprisingly.ltd/how-it-works#leaves) for every destination.

## Checks and builds

```sh
pnpm test              # offline unit and jsdom tests
pnpm test:firefox      # real Firefox workflow, network, documents and restart suites; set POWERLOADER_FIREFOX
pnpm test:firefox:org  # the locked-down sample as an organisation build, installed in Firefox ESR
pnpm test:prototype    # the prototype's journeys
pnpm lint:ext          # or pnpm check:lint, which fails on any finding not in tools/lint-baseline.json
pnpm check:vendor      # every vendored file matches SOURCES.tsv and its npm release
pnpm build:ext         # vendors, then builds dist/power-loader-<version>.zip (--policy <file>: an organisation build)
pnpm build:site        # the website into dist/site/
pnpm site              # the website and its demo, built for this computer into dist/site-local/ and served at
                       # http://localhost:8080/ (library address http://localhost:8080/demo/library/). The same build as
                       # the live site with one setting changed, so its library and flows point back at this computer
pnpm check:site        # every link, anchor and powerloader.surprisingly.ltd address resolves
```

The [Firefox stability suites](tests/firefox/README.md) cover complete sidebar/agent journeys, real request inspection, document processing and two browser restarts. `POWERLOADER_TEST_MODEL=1` adds the full WebGPU model check on target hardware; the default suite uses only synthetic data and local servers.

`pnpm bundle:source` snapshots the current build inputs into `dist/power-loader-<version>-src.zip`, with per-file hashes in `SOURCE.json`. Upload this alongside the extension ZIP. It excludes credentials, dependencies and generated files.

`web-ext lint` reports warnings only from the vendored libraries (`Function` constructor in pdf.js, tesseract.js, Transformers.js and ONNX Runtime). The CSP blocks string evaluation at runtime; the release review must still accept them.

The reference outputs in `fixtures/expected/` came from the retired Python engine and are frozen, with hashes in `fixtures/reference-hashes.json`. Never regenerate them to make a test pass. JSON has its own conformance cases, `fixtures/json-cases.json` (`tests/js/json-conformance.test.js`, which also checks `dsl-cases.json` is unchanged); its hash joins `reference-hashes.json` once the cases are reviewed, and then the same rule applies. `node tools/build-demo-library.mjs` rewrites the demo library's manifest after its files change; a test fails if it is stale. `node tests/tools/fill-check.mjs` fills a saved form page and reports side effects for the library's `sideEffects` entries.

The live smoke test is opt-in and billable: set `POWERLOADER_RUN_LIVE=1`, `POWERLOADER_LIVE_BASE_URL` (the gateway's `/v1` address) and `POWERLOADER_LIVE_API_KEY` (a dedicated virtual key), then run `pnpm test:live`. It sends one ✦ Suggest a profile request through the same boundary, with model `deepseek/deepseek-v4-flash` unless `POWERLOADER_LIVE_MODEL` says otherwise.

What still has to be checked in real Firefox, on the target laptops, is listed in section 5 of the release plan and on the **Check Power Loader is ready** page (Settings → Support).

## CI, the website and releases

GitHub Actions (`.github/workflows/`) runs on every pull request and every push to `main`:

- **CI** (`ci.yml`): the tests, the prototype journeys, `web-ext lint` against its baseline, the vendor check, the extension build, a rebuild from the source archive compared file by file with the CI build (what AMO's reviewers do), the site build with its link check, and the real Firefox suites on the latest ESR and the latest release.
- **Security** (`security.yml`, also weekly): CodeQL (`security-extended`), dependency review on pull requests, OSV-Scanner on the lockfile, gitleaks over the whole history, and zizmor on the workflows. OpenSSF Scorecard runs in `scorecard.yml`. Dependabot keeps npm packages and actions up to date; every action is pinned to a full commit SHA.
- **Pages** (`pages.yml`): builds the site from `main` and deploys it to <https://powerloader.surprisingly.ltd> on GitHub Pages, then checks the live pages. Signed releases are served from the site itself at `/download/`, and `/updates.json` lists them for the `update_url` in the manifest. A weekly job (`links.yml`) checks every outside link.
- **Release** (`release.yml`): pushing a tag `v<manifest version>` on `main` tests and builds the extension, rebuilds it from source, signs it through AMO as an unlisted add-on once a maintainer approves the `release` environment (secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`), and drafts a GitHub Release with the signed XPI, the unsigned and source zips, a CycloneDX SBOM, `SHA256SUMS` and build provenance. Publishing the draft redeploys the site, and installed copies update from it.

```sh
# bump "version" in extension/manifest.json in a pull request, merge it, then:
git tag v1.0.1 && git push origin v1.0.1
# approve the `release` environment in the Actions run, then publish the draft release
```

The full procedure, including a version signed by hand on AMO, is in [docs/releasing.md](docs/releasing.md).

Security reports: see [SECURITY.md](SECURITY.md). Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).
