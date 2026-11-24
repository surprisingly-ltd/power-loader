---
name: release
description: Release a new version of the Power Loader Firefox extension (bump, PR, tag, approve AMO signing, publish the GitHub Release so the site serves it and installed copies update), publish a version that was signed by hand on AMO, or check that a release is live on powerloader.surprisingly.ltd. Use when asked to release, ship, deploy, sign or publish a version, or when a signed XPI arrives from Mozilla.
---

# Releasing Power Loader

The reference is `docs/releasing.md`; read it first. Fixed for good in every signed XPI: ID
`powerloader@surprisingly.ltd` and `update_url` `https://powerloader.surprisingly.ltd/updates.json`.
Never change either. The repo is `surprisingly-ltd/power-loader`; `main` takes changes only by pull request.

Steps that publish or sign are the user's call: say what you are about to do and get a yes before
pushing a tag, approving the `release` environment, or publishing a release. **A pushed `v*` tag can
never be moved or deleted** (tag ruleset), and AMO signs each version number only once.

## 1. Before anything

```sh
git fetch origin && git status          # clean, on an up-to-date branch
gh run list -R surprisingly-ltd/power-loader --branch main --limit 6   # main is green
node -p "require('./extension/manifest.json').version"
gh release list -R surprisingly-ltd/power-loader --limit 5
```

Pick the next version: dot-separated numbers only (`1.0.1`, `1.1.0`), higher than every version
already on AMO, including ones uploaded by hand.

## 2. New version through the pipeline

1. On a branch, set `"version"` in `extension/manifest.json`. Run `pnpm test`, `pnpm check:lint`,
   `pnpm build:ext` and `pnpm build:site && pnpm check:site`. Open a PR; wait for every required check;
   squash-merge.
2. With the user's go-ahead, tag the merged commit:
   ```sh
   git checkout main && git pull --ff-only
   git tag v<version> && git push origin v<version>
   ```
3. Watch the **Release** run (`gh run watch`). After the `build` job passes, the `sign` job waits for
   the `release` environment. The **user** approves it in the Actions page (Review deployments). It
   needs the environment secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`; if they're missing, say so and
   stop.
4. Signing can take minutes to hours (Mozilla may review). When the run finishes, a **draft** release
   holds `power-loader-<v>.xpi`, both zips, the SBOM and `SHA256SUMS`. Check it, then with the user's
   go-ahead: `gh release edit v<version> --draft=false -R surprisingly-ltd/power-loader`.
5. Publishing triggers **Pages**. Go to step 4 below to verify.

If the build fails before signing: the user rejects the approval, the fix goes in a PR, and the release
uses the **next** version number (the tag can't be reused).

## 3. A version signed by hand on AMO

For a version uploaded through the Developer Hub (1.0.0 was, from commit `8caf0f5`), the workflow can't
sign it again. When Mozilla's "signed" email arrives, the user downloads the XPI from the Developer Hub.

1. Rebuild that version's package from the commit it came from, and check the signed file is that build
   (Mozilla adds only `META-INF/`):
   ```sh
   V=1.0.0; SHA=8caf0f5     # the commit the uploaded zip was built from
   git worktree add /tmp/pl-$V $SHA && cd /tmp/pl-$V
   pnpm install --frozen-lockfile && pnpm build:ext && pnpm bundle:source
   mkdir -p /tmp/pl-check/{signed,built}
   unzip -q <path to signed .xpi> -d /tmp/pl-check/signed
   unzip -q dist/power-loader-$V.zip -d /tmp/pl-check/built
   diff -r -x META-INF /tmp/pl-check/signed /tmp/pl-check/built && echo SAME
   unzip -p <path to signed .xpi> manifest.json | node -e 'const m=JSON.parse(require("fs").readFileSync(0));console.log(m.version, m.browser_specific_settings.gecko.id)'
   ```
   Stop if anything differs, or if the version or ID is wrong.
2. Name and checksum the files:
   ```sh
   cp <path to signed .xpi> power-loader-$V.xpi
   cp dist/power-loader-$V.zip dist/power-loader-$V-src.zip .
   sha256sum power-loader-$V.xpi power-loader-$V.zip power-loader-$V-src.zip > SHA256SUMS
   ```
3. With the user's go-ahead, create and publish the release on that commit:
   ```sh
   gh release create v$V --target $(git rev-parse $SHA) -R surprisingly-ltd/power-loader \
     --title "Power Loader $V" --notes "Signed by Mozilla (unlisted). Uploaded by hand through the AMO Developer Hub." \
     power-loader-$V.xpi power-loader-$V.zip power-loader-$V-src.zip SHA256SUMS
   ```
   The new tag starts a **Release** run as well: its `sign` job would fail (AMO already has this
   version), so the user **rejects** that approval.
4. Clean up: `git worktree remove /tmp/pl-$V`.

## 4. Check it's live

Publishing a release runs **Pages** (`gh run watch` on it); its `smoke` job checks the live pages and that
the latest XPI's hash matches `updates.json`. Then confirm yourself:

```sh
S=https://powerloader.surprisingly.ltd
curl -s $S/updates.json                       # lists the new version, update_link and sha256
curl -sL $S/download/power-loader-latest.xpi -o /tmp/latest.xpi && sha256sum /tmp/latest.xpi
unzip -p /tmp/latest.xpi manifest.json | grep '"version"'
```

If the site seems unreachable from this machine, check through a public resolver before concluding it is
down (`dig @1.1.1.1 powerloader.surprisingly.ltd`, or `curl --resolve powerloader.surprisingly.ltd:443:185.199.108.153 ...`):
a local filtering resolver can hide or hijack the subdomain.

Installed copies update on Firefox's next update check (about once a day); `about:addons` → gear →
**Check for Updates** forces it on a test machine.
