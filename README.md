# Power Loader

[![CI](https://github.com/surprisingly-ltd/power-loader/actions/workflows/ci.yml/badge.svg)](https://github.com/surprisingly-ltd/power-loader/actions/workflows/ci.yml)
[![Security](https://github.com/surprisingly-ltd/power-loader/actions/workflows/security.yml/badge.svg)](https://github.com/surprisingly-ltd/power-loader/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/surprisingly-ltd/power-loader/badge)](https://securityscorecards.dev/viewer/?uri=github.com/surprisingly-ltd/power-loader)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

A Firefox extension for caseworkers. A case starts from the forms it needs to fill. Power Loader clips values from the approved casework systems, shows where sources agree and conflict, and fills the target forms with checked values. Forms, fields and page profiles come from the team's forms library. All application logic runs in the extension; AI features use the organisation's AI gateway, and only after a redaction preview.

**Website, demo and install instructions:** <https://powerloader.surprisingly.ltd>. Privacy policy: <https://powerloader.surprisingly.ltd/privacy>. Notes for add-on reviewers: [REVIEWERS.md](REVIEWERS.md). Published as open source (Apache-2.0) by Surprisingly Limited.

The design and its decisions are in [the first release plan](docs/plans/release-plan.md), which links the feature plans. `prototype/case-journeys.html` is the clickable prototype; `pnpm test:prototype` checks it.

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
pnpm demo            # serves demo/ at http://localhost:8787/demo/
```

In Firefox 140 or newer, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and select `extension/manifest.json`. Open the sidebar with the toolbar button.

The first time the sidebar opens it starts on **Settings**, with what to set up: download the on-device privacy model there (**Download and test the model**), connect a library if you have one, and turn on the ✦ Remote AI if you use it. The Privacy tab has the model's server and the redaction settings; it works with or without a library.

In the sidebar's **Settings**, enter the library address `http://localhost:8787/demo/library/` and press **Connect**. Star a form or tick several, start a case, then visit the demo pages from <http://localhost:8787/demo/> and clip them. `client-2077.html` is a different person, so clipping it shows the identity warning. `dhp.html` is a target form with a fill profile and a side effect; submitting it opens a confirmation page that Power Loader recognises.

**Making a flow** needs no library. A flow is the forms a case fills, the pages it clips from and the fields between them: what a library is made of. In the sidebar's **Flows** tab (or *Or make a flow* on the Case tab before a library is connected), choose **New flow**, name it and optionally paste guidance; `demo/index.html` has guidance for the demo pages. Start with the form to fill: open it in the tab, choose *Use this form*, then *✦ Generate the extraction profile with AI* (the form's boxes and the guidance go through the redaction preview; the AI says which fields the form collects and where) or *Make it by hand* (type a field's name, then click its box). Do the same on each page to clip: the AI gets the page's HTML with every value on it replaced by a placeholder, and returns selectors for the flow's fields. Test each page there. The flow is checked as you go, and each problem offers its fixes, including *✦ Fix with AI*. **Export** downloads one `powerloader-flow/1` file with the flow and the library files it becomes (`fields.json` entries, a form and fill profile per form, a page profile per page); **Import a flow** opens one again, and *Make a flow from a library form* copies a library form with its profiles. A case can start from any flow (**Start case**), with or without a library: the flow is compiled and pinned by the case like a library commit. A flow can also guide the caseworker, so they don't need the guidance page again: add **Pages to visit** (a work queue such as `demo/cases.html`, a search page), write what to do on each page, and add links to the next step whose addresses carry values from the case (`client-{ref}.html`, `search?q={lastName}`), or let *✦ Write the steps from the guidance* draft them. A case from the flow shows each step on the Case tab with its links filled in. **Timelines** choose which dates the case's timeline draws: series of bars (employments, tenancies) and pointers, each with its colour or shape, from table rows on a page (pick a cell) or from date fields. See [the plan](docs/plans/flow-authoring.md).

**Making a profile** starts from the target. On a form's page, *Make a profile for this page* → "This page is a form to fill" matches the form's boxes to its fields. On a page you gather from, choose the target forms (only forms with a fill profile can be chosen). Their fields become drop zones in the sidebar, and every value on the page is outlined. Power Loader's rules (labels, names, types, the privacy categories and the library's validators) fill in what they can straight away. Drag a value from the page onto a field, or click it and choose its field; *Pick something that isn't outlined* reaches any other element. The optional on-device model (Gemma 3 1B, about 785 MB, downloaded from Hugging Face the first time, pinned and hash-checked like the privacy model) then suggests fields the rules missed, each marked *Check this*. Policy `assistModel.enabled: false` or the editor's checkbox switches it off. `node tests/tools/assist-eval.mjs` scores the rules on the demo pages; `node tests/tools/assist-model-eval.mjs` (slow, downloads the model) scores the model. See [the plan](docs/plans/local-profile-assist.md).

The on-device privacy model downloads from Hugging Face by default (`openai/privacy-filter` at a pinned commit, about 920 MB, every file checked against its SHA-256; see `DEFAULT_MODEL` in `extension/lib/model-fetch.js`). A caseworker can point it at another server with the same files under **Privacy → Use a different model server**; policy (`privacyModel.baseUrl`) locks the address, and policy or the library's `privacy.json` can set another revision and hashes.

## Policy

Enterprise settings come from managed storage (Firefox `policies.json`, `3rdparty` → `Extensions` → `powerloader@surprisingly.ltd`). The keys are listed with their defaults in `extension/lib/policy.js`: `library.*`, `gateway.*`, `privacyModel.*`, `assistModel.*`, `redaction.*`, `activityLog.*` and `workstation.idleConfirmMinutes`. Settings set by policy show as locked. Firefox reads managed storage at startup, so a policy change needs a browser restart.

## AI gateway

All AI goes through the organisation's LiteLLM gateway (OpenAI-compatible). Enter its `/v1` address, model and this extension's own virtual key under **Settings → ✦ Remote AI**, or set the address by policy, and tick the acknowledgement: the anonymised page is sent, the anonymisation might not be perfect, and the caseworker must check that this complies with the law and their organisation's policies. A change to that wording asks again. Never use a provider key. Every ✦ action builds its payload, redacts personal data on this computer, and shows the preview; nothing is sent until the caseworker presses Send.

## Checks and builds

```sh
pnpm test              # offline unit and jsdom tests
pnpm test:firefox      # real Firefox workflow, network, documents and restart suites; set POWERLOADER_FIREFOX
pnpm test:prototype    # the prototype's journeys
pnpm lint:ext          # or pnpm check:lint, which fails on any finding not in tools/lint-baseline.json
pnpm check:vendor      # every vendored file matches SOURCES.tsv and its npm release
pnpm build:ext         # vendors, then builds dist/power-loader-<version>.zip
pnpm build:site        # the website into dist/site/
pnpm check:site        # every link, anchor and powerloader.surprisingly.ltd address resolves
```

The [Firefox stability suites](tests/firefox/README.md) cover complete sidebar/agent journeys, real request inspection, document processing and two browser restarts. `POWERLOADER_TEST_MODEL=1` adds the full WebGPU model check on target hardware; the default suite uses only synthetic data and local servers.

`pnpm bundle:source` snapshots the current build inputs into `dist/power-loader-<version>-src.zip`, with per-file hashes in `SOURCE.json`. Upload this alongside the extension ZIP. It excludes credentials, dependencies and generated files.

`web-ext lint` reports warnings only from the vendored libraries (`Function` constructor in pdf.js, tesseract.js, Transformers.js and ONNX Runtime). The CSP blocks string evaluation at runtime; the release review must still accept them.

The reference outputs in `fixtures/expected/` came from the retired Python engine and are frozen, with hashes in `fixtures/reference-hashes.json`. Never regenerate them to make a test pass. `node tools/build-demo-library.mjs` rewrites the demo library's manifest after its files change; a test fails if it is stale. `node tests/tools/fill-check.mjs` fills a saved form page and reports side effects for the library's `sideEffects` entries.

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
git tag -s v1.0.1 && git push origin v1.0.1
```

Security reports: see [SECURITY.md](SECURITY.md). Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).
