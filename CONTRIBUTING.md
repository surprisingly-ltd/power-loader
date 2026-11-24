# Contributing to Power Loader

Thanks for helping. Power Loader runs in caseworkers' browsers next to personal data, so changes are
reviewed for safety first and features second.

## Set up

Use **Node.js 24.19.0** and **pnpm 11.3.0** (the versions CI and the AMO rebuild use):

```sh
pnpm install --frozen-lockfile
pnpm vendor            # third-party runtime files into extension/vendor/ (not in git)
pnpm demo              # demo pages and library at http://localhost:8787/demo/
```

Load `extension/manifest.json` from `about:debugging#/runtime/this-firefox` (Firefox 140 or newer).

## Before you open a pull request

```sh
pnpm test              # offline unit and jsdom tests
pnpm test:prototype    # the clickable prototype's journeys
pnpm lint:ext          # web-ext lint; new warnings in our own code fail CI
pnpm build:ext         # dist/power-loader-<version>.zip
pnpm build:site && node tools/check-site.mjs   # the site, with every link checked
POWERLOADER_FIREFOX=/path/to/firefox pnpm test:firefox   # real Firefox suites (CI runs ESR and release)
```

CI runs all of these on every pull request, plus CodeQL, dependency, secret and workflow scanning.

## Rules that keep it safe

- **No remote code.** Everything the extension runs ships in the package. Third-party code goes through
  `tools/vendor.mjs`, unmodified, with its licence and a line in `vendor/SOURCES.tsv`.
- **Data stays local unless the caseworker approves.** Every AI request goes through
  `previewBeforeSend()` in `extension/lib/ai/boundary.js`; nothing reaches the gateway without the
  redaction preview and an explicit Send. AI features use the organisation's own gateway and key, never a
  provider key.
- **Library content is untrusted.** Profiles are data, validated on load; they never run code.
- **The DSL fixtures are the specification.** `fixtures/dsl-cases.json` and the frozen outputs in
  `fixtures/expected/` (with `fixtures/reference-hashes.json`) are not regenerated to make a failing
  change pass. A deliberate change to them goes in its own commit with a reviewed diff and an explanation.
- **No real people or organisations in demo content.** Demo pages and libraries are fictional and say so.

## Pull requests

Keep each pull request to one change, with a description of what changed and why, and how you checked it.
Changes to `main` go through pull requests, and the required checks must pass. By contributing you agree
that your contribution is licensed under the Apache License 2.0 (see `LICENSE`).

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening an issue.
