# Publishing Power Loader for Firefox

Reviewed 22 October 2026. The intended channel is **unlisted**, distributed through enterprise policy.
Both listed and unlisted submissions must follow Mozilla’s [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).

## Corrections made for submission

- Minimum Firefox version is 140.0, which supports built-in data consent. Earlier versions are no longer supported.
- Data declarations include website content, personally identifying information, financial/payment information and health information. These can all occur in approved case text. AI still needs Settings consent and approval of each case-data preview.
- Removed permanent access to Wikipedia, Companies House and localhost. Individual library, gateway and casework origins are requested at runtime through optional host permissions.
- Transformers.js 4.3.1’s all-in-one bundle contains a prerelease ONNX Runtime. The build instead bundles its unmodified web entry with released ONNX Runtime 1.30.0, using pinned esbuild 0.27.2. Both ONNX imports resolve to that release. BUNDLE.json records the inputs; the loader and WASM match the released runtime. No upstream library source is patched.
- Build dependencies and pnpm are pinned; the lockfile is included for reviewers.
- Vendoring clears stale files before writing the package, preserves available license notices, and records hashes and provenance.
- Stability-suite fixes: full-page extension tabs can use the storage writer while website content scripts remain blocked; explicit PDF ranges cannot bypass the page budget; privacy-worker cancellation rejects immediately and releases listeners; transient deletion failures keep a recoverable checkpoint; stopping OCR during startup cancels the old job; sidebar startup tolerates tab events before its first storage snapshot.
- Fixed OCR startup: tesseract.js 5.1.1’s ESM build exports its API as default; the previous named import made createWorker undefined in Firefox.
- Remote forms libraries require HTTPS. Embedded credentials, query parameters and fragments are rejected. Redirects are refused before credentials or requests can follow them elsewhere. Local HTTP demos remain supported.
- Source packaging snapshots current build inputs, including uncommitted fixes, with hashes in SOURCE.json. It excludes credentials, caches, dependencies and generated output; extraction and rebuilding need no git checkout.
- Reviewer and privacy documents describe the custom bundle, data categories, fixed gateway test, text-only AI requests, and retained sanitised activity log.

## Build and submit

Use Node.js 24.19.0 and pnpm 11.3.0:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:prototype
pnpm build:ext
pnpm lint:ext
pnpm build:site
pnpm bundle:source
```

Upload `dist/power-loader-1.0.0.zip` as the extension and `dist/power-loader-1.0.0-src.zip` as its sources.
Use REVIEWERS.md and amo-metadata.json for reviewer notes. The generated bundle must be reproduced with
`pnpm vendor`; it cannot be checked by hashing a CDN copy. Other runtime files remain unmodified npm files.

The validator still flags evaluation/dynamic-import patterns in third-party code. Power Loader does not enable
string evaluation; its CSP allows packaged WebAssembly. These warnings require reviewer assessment and
are not evidence that all runtime paths work. pdf.js is explicitly configured with isEvalSupported: false.

For API signing, use organisation-owned AMO credentials from a password manager or CI secrets:

```sh
pnpm exec web-ext sign --channel=unlisted --source-dir extension \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" \
  --upload-source-code dist/power-loader-1.0.0-src.zip --amo-metadata amo-metadata.json
```

## Validation completed

- All 20 offline test files passed, including transport, storage-sender, transient-deletion, PDF-budget and worker-cancellation regression checks.
- All 11 prototype checks passed; their jsdom windows now close after each journey to release timers.
- Firefox 151 passed 30 integration checks: real sidebar/agent workflows, fill preview and approval,
  network privacy and exact-payload retries, actual PDF/OCR and encrypted documents, and two restart
  recovery checkpoints. See tests/firefox/README.md and run `pnpm test:firefox`. The full pinned-model
  WebGPU scan remains an opt-in target-hardware check (`POWERLOADER_TEST_MODEL=1`).
- The validator reported 0 errors, 0 notices and 15 warnings, all in third-party runtime code.
- A fresh extraction of the source archive installed with the frozen lockfile and rebuilt successfully.
  Every packaged entry matched the submission extension ZIP byte for byte.
- Existing hosted privacy, reviewer and demo-library URLs returned successfully.

## Release decisions and checks still needed

- Keep the current valid ID `powerloader@surprisingly.ltd` if it has already been signed or deployed. Firefox does not require a domain-owned ID; changing it creates a different add-on. Decide any ID change before the first signing.
- Version 1.0.0 is the current release. Confirm it has not already been uploaded to AMO; if it has, increment it before rebuilding both archives.
- No update_url is invented. Manage signed XPI updates through enterprise policy, or configure an organisation-owned HTTPS update manifest before signing if self-hosted automatic updates are required.
- Rebuild the public site and publish its updated privacy policy and reviewer notes. The hosted demo and existing URLs are reachable, but the local wording fixes must be published before submission.
- Test Firefox 140/ESR and the deployed release on target hardware: WebGPU privacy-model loading and a successful scan, OCR, PDFs, paste/drop, pick/fill, region capture at display scaling, teardown/restart/update recovery, managed policy, and NVDA. The automated Firefox suite covers synthetic workflows, documents, keyboard focus and restart recovery; target GPUs, NVDA, production policy, capture scaling and real casework sites still need rollout checks.
- Verify the organisation’s library URL/authentication, gateway URL/model, model mirror policy, redaction settings, retention, deployment/update hosting and privacy owner.
- Reviewers can use the fictional hosted demo without credentials. Optional AI needs an organisation gateway; never send real case data during review.

For a public listing, also prepare listing text, screenshots, support details and the privacy URL. Signing,
submission and deployment are separate release actions; this readiness review does not perform them.
