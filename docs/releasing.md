# Releasing Power Loader

Power Loader is a **self-distributed (unlisted)** Firefox add-on. Mozilla signs each version; we host the
signed files and the update manifest ourselves, on GitHub Pages at <https://powerloader.surprisingly.ltd>.
Every submission must follow Mozilla's [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).

## What is fixed for good

These are written into every signed XPI and must never change:

| | |
|---|---|
| Add-on ID | `powerloader@surprisingly.ltd` |
| `update_url` | `https://powerloader.surprisingly.ltd/updates.json` |
| Install address (enterprise policy) | `https://powerloader.surprisingly.ltd/download/power-loader-latest.xpi` |

The site address is a custom domain (a `powerloader` CNAME to `surprisingly-ltd.github.io` in the
surprisingly.ltd zone, DNS only), so the repository can be renamed or moved without breaking updates.
AMO rejects `update_url` for listed add-ons: always submit as **unlisted** ("On your own").

## How a release flows

1. **Version bump, by pull request.** Change `"version"` in `extension/manifest.json`. CI must pass
   (tests, lint against `tools/lint-baseline.json`, vendor check, build, reproducible rebuild, site
   links, Firefox ESR and release). Merge.
2. **Tag on `main`:** `git tag v<version> && git push origin v<version>`. Tags `v*` can't be moved or
   deleted once pushed.
3. **`release.yml` runs:** it checks the tag matches the manifest and is on `main`, runs the tests, builds
   `power-loader-<v>.zip` and `power-loader-<v>-src.zip`, and rebuilds from the source zip to prove they
   match.
4. **Approve** the `release` environment (Actions → the run → Review deployments). Only then can the job
   read `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. It submits that exact package, the source zip and
   `amo-metadata.json` to AMO (unlisted) with `web-ext sign` and waits for the signed XPI.
5. **Draft release:** the workflow drafts a GitHub Release with the signed XPI, both zips, a CycloneDX
   SBOM, `SHA256SUMS` and build provenance attestations.
6. **Publish the draft.** That runs `pages.yml`: `tools/fetch-releases.mjs` downloads every published
   release's XPI and `SHA256SUMS`, `tools/build-site.mjs` checks each XPI's hash and manifest and writes
   `/download/` and `/updates.json`, and a smoke check confirms the live site serves the new XPI with the
   hash `updates.json` lists. Installed copies pick it up on Firefox's next update check (about daily).

Firefox versions are dot-separated numbers only (no `-rc.1`), so there are no pre-release tags, and a pushed
`v*` tag can't be deleted: tag only a version you mean to release. If something fails before step 4,
reject the approval (nothing reaches AMO), fix it in a pull request, and release the next version number.

## A version signed outside the workflow

AMO signs each version once. If a version was uploaded by hand (as 1.0.0 was, on 24 November 2026), the
workflow can't sign it again: reject its approval request, then publish the hand-signed file yourself.
`.claude/skills/release/SKILL.md` has the exact steps, including checking that the signed XPI is the
build you uploaded.

## Secrets and accounts

- AMO API keys belong to the Surprisingly Ltd developer account, created at
  <https://addons.mozilla.org/developers/addon/api/key/>, and live only as secrets of the `release`
  environment. Rotate them there if they leak.
- The `github-pages` environment needs no secrets.

## Validator warnings

AMO's validator (the same `addons-linter` that `pnpm check:lint` runs) reports 16 warnings and no errors:
15 in the vendored third-party libraries (`Function` constructor and dynamic `import` in pdf.js,
tesseract.js, ONNX Runtime and Transformers.js), and one that `data_collection_permissions` needs Firefox
for Android 142. The extension's CSP has no `'unsafe-eval'`, so string evaluation can't run; pdf.js is
configured with `isEvalSupported: false`. Power Loader is desktop-only (it needs `sidebar_action`), so
choose Firefox desktop only when submitting. A new warning fails CI; see `tools/lint-baseline.json`.

## Checks before a release reaches caseworkers

The automated Firefox suite covers synthetic workflows, documents, keyboard focus and restart recovery on
the latest ESR and release. On the organisation's own laptops, also check: WebGPU privacy-model loading
and a successful scan, OCR, PDFs, paste and drop, pick and fill, region capture at display scaling,
teardown, restart and update recovery, managed policy, and NVDA. Confirm the organisation's library
address and authentication, gateway address and model, model mirror, redaction settings, retention and
privacy owner. Reviewers use the fictional hosted demo; never send real case data during review.
