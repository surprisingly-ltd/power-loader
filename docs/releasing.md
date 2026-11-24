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
   `amo-metadata.json` to AMO (unlisted) with `web-ext sign` and waits for the signed XPI. If AMO already
   has the version (a re-run after a timeout), it downloads that instead. Either way,
   `tools/amo-signed.mjs` checks the signed XPI is this build plus Mozilla's `META-INF/` signature.
5. **Draft release:** the workflow drafts a GitHub Release with the signed XPI, both zips, a CycloneDX
   SBOM, `SHA256SUMS` and build provenance attestations.
6. **Publish the draft.** That starts `pages.yml`, which redeploys the site from `main` (GitHub Pages only
   serves deployments from the default branch, not from a release's tag): `tools/fetch-releases.mjs`
   downloads every published release's XPI and `SHA256SUMS`, `tools/build-site.mjs` checks each XPI's hash
   and manifest and writes `/download/` and `/updates.json`, and the smoke check waits (Pages' CDN caches
   for up to 10 minutes) until the live site serves the new version and an XPI with the hash it lists.
   Installed copies pick it up on Firefox's next update check (about daily).

Firefox versions are dot-separated numbers only (no `-rc.1`), so there are no pre-release tags, and a pushed
`v*` tag can't be deleted: tag only a version you mean to release. If something fails before step 4,
reject the approval (nothing reaches AMO), fix it in a pull request, and release the next version number.

## A version signed outside the workflow

AMO signs each version once. 1.0.0 was uploaded through the Developer Hub on 24 November 2026 and signed
that day. A tag runs the workflow as it was at the tagged commit, and 1.0.0's commit predates
`tools/amo-signed.mjs`, so 1.0.0 is published by hand: rebuild it, download and check the signed file
with `tools/amo-signed.mjs`, and create the release with it (reject that tag's approval request).
`.claude/skills/release/SKILL.md` has the exact steps.

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
