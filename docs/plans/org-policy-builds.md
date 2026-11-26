# Organisation builds: a policy file built into the extension

Created: 2026-11-26. Status: built (2026-11-26): steps 1 to 11 and the follow-ups 13 to 15; step 12 (the case in `storage.session`) dropped for good (decision 9). Decisions settled 2026-11-26 (see *Decisions*).

**What's built.** `extension/policy.json` (the default, which sets nothing) read by `lib/policy.js` (`resolvePolicy()`, `useBuiltInPolicy()`, `allowed` checks), managed storage read only for the default file; `gateway.enabled`, `library.syncMinutes`, `workstation.clearCaseOnClose` and `allowed`. `allowed` is checked in `connectionConfig()`, every library file fetch and `verifyingFetch()` (and where a redirect lands). The background syncs the library at start, on install and on an alarm; a timed sync (these, and the sidebar opening) fetches only `library.json` when the commit is held and only changed files otherwise, while *Sync now* still fetches and checks every file (the Firefox suite's corrupt-update and restart checks rely on it). Clear on close at the next start (`clearCaseAtStart()`, outcome `closed`), the standing line, `beforeunload` in the last window, the receipt and the Settings switch (`sidebar/close-warning.js`). `tools/policy.mjs` (`check`, `explain`, `try`, `--expect`), six samples in `policies/samples/` with expectations run by `pnpm test`, `tools/build-ext.mjs --policy` and `bundle:source --policy`, a `policy` job in `tools/ci-local.sh`. Settings names whose rules are built in (`sidebar/org-policy.js`), shows `allowed` beside each box and refuses values outside it, says when the remote AI is off; "doesn't work on this site" (`lib/build-hosts.js`); readiness and diagnostics name the built-in policy. `pnpm test:firefox:org` runs the locked-down sample installed in Firefox ESR. `docs/organisation-builds.md` and the `policy-file` skill.

**What's built in the follow-ups.** Clearing a case left without use (`workstation.clearCaseAfterHours`, half hours, default 24, 0 for never; `workstation.clearCaseMaxHours`, a maximum the caseworker may choose at or below), on its own alarm set for when the case is due, with the outcome `expired`, wording that follows the value, a warning an hour before or a sixth of a short time before, and a receipt that says why (`lib/teardown.js`, `sidebar/close-warning.js`). A switch for each tool (`tools.capture`, `.reader`, `.calculator`, `.timeline`, `.notes`; `lib/tools.js`), refused where each is carried out and not offered when off, in one Settings card with the switches that already existed. Capture on a build with fixed hosts through `activeTab`, started from the page's right-click menu or Alt+Shift+R (`tools/build-ext.mjs`, `background.js`, `startPendingRegion()`), left out of the build when `tools.capture` is false. The org-build Firefox check covers all three.

**Found while building.** Checked in Firefox 140.17 and 153.8 ESR (`tests/tools/firefox-org-build.mjs`): MV3 `host_permissions` are granted at install with no prompt for an add-on installed from the profile (the closest local stand-in for a policy install); `connect-src` applies to the background's `fetch`, extension pages and workers; Transformers.js, tesseract.js and pdf.js need no `blob:` or `data:` in it. A CSP source without a port allows only the default port, so the build writes `:*`. Firefox offers `tabs.captureVisibleTab` only with `<all_urls>` or `activeTab`; the page's own host permission isn't enough, so a build with `build.hosts` first lost region capture, and now captures through `activeTab` (decision 12). Capture also fetched its `data:` picture, which `connect-src` refuses; it is decoded in place now. `storage.session` holds just under 10 MiB in total, shared with the reader's results and the views' state, which is one reason step 12 was dropped (decision 9).

## Why

An organisation can already lock Power Loader down, but only through managed storage (Firefox `policies.json`), and only by fixing a setting to one value. Two things are missing:

1. **A locked-down build.** Some organisations want to publish their own version of the extension with their rules inside the signed package, so the rules hold on any machine it is installed on, whether or not IT's browser policy reached that machine.
2. **Patterns as well as fixed values.** "The AI endpoint must be on `*.example.gov.uk`" can't be said today. Only "the AI endpoint is exactly this address" can.

This plan adds a policy file that is built into the extension, lets a policy constrain an address by pattern, ships sample files, and adds a skill for writing and checking them. It also adds two behaviours an organisation build needs: the library keeps itself up to date, and case data is cleared when the browser closes.

It is a plan only. Where it says what the code does today, the file was read for it. Claims about Firefox behaviour that need testing are marked *to check*.

## What exists today

- `extension/lib/policy.js` reads `browser.storage.managed`, merges it over `POLICY_DEFAULTS`, and records every key the policy set as locked. Keys: `library.*`, `gateway.*`, `privacyModel.*`, `assistModel.*`, `redaction.*`, `activityLog.*`, `workstation.*`, `siteAccess.*`. A key the reader doesn't know is ignored without any warning, so a typing mistake in `policies.json` silently locks nothing.
- Locked values are applied where they are used, on every request, by `withPolicy()` in `lib/ai/settings.js` and `libraryConfig()` in `lib/library-sync.js`.
- Site rules (`lib/access.js`) already take patterns and per-action rules from policy (`siteAccess.allow`, `.deny`, `.rules`), as one layer among several. Deny wins in any layer, allow lists in different layers intersect, and `fetch-post` is closed unless an allow rule names it.
- The manifest asks for `optional_host_permissions: ["<all_urls>"]`, and the extension pages' CSP has no `connect-src`, so nothing the browser enforces limits where the extension can connect.
- The library syncs when the sidebar opens (`sidebar.js`) and when the caseworker presses the button in Settings. Nothing syncs it on a timer or at startup, and the manifest has no `alarms` permission.
- The open case is kept in `storage.local`, so it survives a browser restart. `lib/teardown.js` deletes it on Finish or Discard, and finishes an interrupted deletion at the next start.
- Each site is granted with a Firefox permission prompt the first time Power Loader works on it (`permissions.request` in `sidebar.js`, `settings.js`, `ai-settings.js`).
- `pnpm build:ext` runs `tools/vendor.mjs` then `web-ext build` straight from `extension/`.

## The design in one paragraph

A policy file is built into the package as `extension/policy.json`. The repo's own file sets nothing, so the public build behaves exactly as it does today, managed storage included. An organisation writes its own file, checks it with `tools/policy.mjs`, and builds with `--policy <file>`; the build swaps the file in, and rewrites the manifest's identity and host permissions from it. The file has the same keys managed storage has, plus an `allowed` section that constrains an address by pattern instead of fixing it. An organisation build ignores managed storage: to change a guardrail, the organisation ships a new version.

## Naming

These are called **policy files**, never "profiles": "profile" already means the thing that matches a page and maps its fields, and it is on the Settings and library screens.

## The policy file

```json
{
  "schema": "powerloader-policy/1",
  "name": "Example Council",
  "build": {
    "id": "powerloader@example.gov.uk",
    "updateUrl": "https://addons.example.gov.uk/powerloader/updates.json",
    "hosts": ["*://*.example.gov.uk/*"]
  },
  "policy": {
    "gateway": { "baseUrl": "https://ai.example.gov.uk/v1", "model": "fast" },
    "library": { "auth": "cookies", "syncMinutes": 60 },
    "siteAccess": { "rules": [{ "id": "no-post", "effect": "deny", "pattern": "*://*", "actions": ["fetch-post"] }] },
    "allowed": {
      "library.baseUrl": ["https://gitlab.example.gov.uk/casework/*"],
      "privacyModel.filesUrl": ["https://models.example.gov.uk/*"]
    }
  }
}
```

- **`policy`** has exactly the keys managed storage has today, so what an organisation already has in `policies.json` can be pasted in. A key set here is locked, as it is from managed storage.
- **`policy.allowed`** is new, and is only read from the built-in file. It maps a setting to a list of patterns. The caseworker may choose any value that matches one. This is how one GitLab instance serves several teams: `library.baseUrl` is allowed by pattern, and each team enters its own repo's address. Patterns use the site-rule grammar in `lib/access.js` (`parsePattern()`), so there is one pattern language in the product.
  - Settings that take patterns: `gateway.baseUrl`, `library.baseUrl`, `privacyModel.filesUrl`, `privacyModel.baseUrl`, `assistModel.filesUrl`, `assistModel.baseUrl`.
  - `gateway.model` takes a list of model names, with `*` as a wildcard.
- **`gateway.enabled`** is a new key. `false` turns remote AI off and locks it off. Today there is no way to say this in policy; an organisation that wants no remote AI can only leave the endpoint unset and hope nobody fills it in.
- **`build`** is only read by the build step, never by the running extension:
  - `id` and `updateUrl`: the add-on's own identity. An organisation can't sign a build under `powerloader@surprisingly.ltd`, so these are required for any file other than the default. Managed storage is keyed by this id.
  - `hosts`: the sites the build may ever touch, as match patterns. See *build.hosts* below. It is optional. Leave it out and the build keeps `<all_urls>` as an optional permission and no `connect-src`, as today: any site is possible, and each domain is granted only when the caseworker asks for it.
- **`name`** is shown in Settings and in diagnostics ("Rules built in by Example Council").

### What a pattern is checked against

The address each request is actually sent to, at the time it is sent: the chat completions address, every library file address (after `{ref}` is filled in), every model file address. This is where locked values are applied today, so a value saved before the rule existed is never used. A value outside the pattern is refused with a message that says the organisation doesn't allow it, and Settings shows the constraint beside the box and refuses to save a value outside it.

The library and the AI client already refuse redirects (`redirect: 'error'`). The model download is *to check*: Hugging Face redirects to a CDN, so a pattern for the model source must either cover the CDN or the organisation must use a mirror (`filesUrl`). The checker warns about this.

### Managed storage

Managed storage is read only when the built-in file is the repo's default. An organisation build ignores it, and diagnostics say so if any is set. So there is one place to look for an organisation's rules, and nothing to combine.

Two consequences:

- A guardrail changes by shipping a new version. Day-to-day changes (flows, forms, the library's own site rules) still arrive through the library, without a new build.
- A library read token can't be supplied, because the file must hold no secrets. A private GitLab library is read with the caseworker's own sign-in (`library.auth: "cookies"`). *To check:* that GitLab serves raw files to a signed-in browser session when the request comes from the extension, in Firefox 140 ESR.

Letting managed storage narrow an organisation build can be added later without changing the file format.

### build.hosts: no permission prompts for official systems

`build.hosts` may be as wide as `*://*.gov.uk/*`, and may list several patterns (`*.nhs.uk`, a supplier's domain). The build writes it in three places:

- **`host_permissions`**, so Firefox grants the hosts when the extension is installed and never asks the caseworker site by site. Installed by browser policy, there is no prompt at all; installed by hand, Firefox lists the sites once, at install. *To check in Firefox 140 ESR:* that Manifest V3 `host_permissions` are granted at install without a per-site prompt, including when force-installed.
- **`optional_host_permissions`** is emptied, so nothing outside the list can ever be granted.
- **`connect-src`** in the extension pages' CSP, so extension pages can't connect outside the list.

Holding the permission is not the same as reading. What Power Loader reads is still decided by the site rules and by the flow: it reads a page only when the page is in the active flow, or when Build is on. The permission just removes the prompt, which on an official system would worry a caseworker for no reason once security has approved the list.

The code changes this needs:

- Every place that asks for a host (`sidebar.js`, `settings.js`, `ai-settings.js`) already checks `permissions.contains` first, so on an organisation build the prompt never appears. Where a site is outside `build.hosts`, the request would fail, so the interface says "Your organisation's version of Power Loader doesn't work on this site" in place of the *Allow* button.
- The two checks for `<all_urls>` (`sidebar.js`, `ready.js`, for capture) become "is this page covered by what's granted".
- A caseworker can still switch a site off in Firefox's add-on manager. The readiness page already reports missing permissions; it names the missing host and says how to turn it back on.

The checker warns when `build.hosts` is wider than everything the site rules allow, and says in `explain` which is which: "may connect to" (hosts) and "works on" (site rules).

### What the build can and can't promise

To be said plainly in the docs and by the skill:

- The site rules are checked by the extension's own code. They guard against mistaken and poisoned flows, as today.
- `build.hosts` is enforced by Firefox: the extension can't be granted a host outside the list, and extension pages can't connect outside it.
- Fetch steps run in the page's own tab and only ever fetch from that page's site (`fetch-steps.md`), so `connect-src` doesn't cover them; the site rules and the host permission do.
- A signed package can't be edited without breaking its signature. A caseworker with rights to install other add-ons could still install the public build, and stopping that is browser policy's job, not this file's.
- **No secrets in a built-in file.** Anyone with the package can read it. The checker refuses `library.token` in a file meant for a build.

## The library keeps itself up to date

Today the library only syncs when the sidebar opens or the caseworker asks. It should sync by itself:

- at browser start (`runtime.onStartup`) and on install or update (`runtime.onInstalled`);
- every hour after that, from an alarm (the `alarms` permission, which shows no prompt). `library.syncMinutes` is a new policy key, default 60, lowest 15, `0` for off.

`syncLibrary()` is unchanged: all files from one commit, checked against the manifest, last known good kept. An open case stays on the commit it started with, as now. A failed sync is recorded and tried again at the next interval, with no message to the caseworker unless the library has been out of date for a day. The sidebar-open sync stays, skipped when the last sync was under five minutes ago.

`fetchLibrary()` fetches every file on every sync today. Hourly across an estate that is wasteful, so the timed sync fetches `library.json` first, stops if the commit is the one already held, and otherwise fetches only the files whose hash differs from the copy it has.

## Case data is cleared when the browser closes

A case holds personal data, and today it stays in `storage.local` across a restart. On an organisation build it shouldn't.

- `workstation.clearCaseOnClose` is a new policy key, default `true` in every build (a default in `POLICY_DEFAULTS`, never a value in the default policy file, which would lock it). The caseworker can turn it off in Settings. When the organisation sets it, either way, it is locked and Settings shows it as theirs.
- **What is cleared:** the open case, everything in `CASE_SESSION_KEYS`, unsaved typing and reader results. It goes through the existing teardown with a new outcome, `closed`, so the activity log gets its entry (no values, as for Discard) and a receipt with counts is left.
- **The warning.** Firefox gives an extension no way to stop the browser closing or to ask a question as it does. So the warning is given before and after:
  - While a case is open, the case header carries a standing line: "This case is deleted when you close Firefox."
  - When the caseworker closes the last Power Loader window or the sidebar with unsubmitted values in the case, that page asks before closing where Firefox allows it (`beforeunload`). *To check:* which of the sidebar, the case page and the full-page views honour it.
  - At the next start the sidebar shows the receipt: "Firefox was closed with a case open. It was deleted: 14 values, 2 pages. Nothing was sent anywhere."
- **When it is cleared.** Two steps, in this order of building:
  1. At the next start (`runtime.onStartup`, before anything else reads the case). Simple and reliable, but the data sits on disk while Firefox is closed.
  2. Move the open case from `storage.local` to `storage.session`, which Firefox keeps in memory and drops itself when it closes, so nothing is on disk at all. This touches every reader of the case (`mutateStorage` and its callers), and *to check* is whether a large case with captured images fits in the session quota. Do it after step 1 is in use.
- A crash followed by session restore counts as a close: the case is cleared.

## The default file

`extension/policy.json`, committed, is the default:

```json
{ "schema": "powerloader-policy/1", "name": null, "policy": {} }
```

Running from source (`web-ext run`, the tests, the Firefox suite) reads the same file the public build ships. `POLICY_DEFAULTS` stays in `lib/policy.js` as the list of keys and their defaults; the default file is a policy that sets none of them.

## Sample files

In `policies/samples/`, each with a comment-free JSON file and a short `.md` beside it saying what it does and what it leaves open. All use `example.gov.uk`.

| File | What it does |
|---|---|
| `no-post.json` | Denies `fetch-post` everywhere. Fetch steps can read pages but never send a POST. Everything else is as the default. |
| `fetch-one-domain.json` | An allow rule for `fetch-get` on `https://*.example.gov.uk/*`, and `fetch-post` denied. Background requests only go to that domain; reading and filling the page the caseworker is on is unchanged. |
| `fixed-endpoints.json` | AI endpoint and model fixed, library address fixed, model files from a fixed mirror, `build.hosts` set to match. The address boxes in Settings are locked. |
| `endpoints-by-pattern.json` | The same three constrained by `allowed` patterns instead of fixed. |
| `no-remote-ai.json` | `gateway.enabled: false`. |
| `locked-down.json` | All of the above together with a site allow list for every action, to show a fully closed build. |

`fetch-one-domain.json` depends on how the rule engine reads an allow rule that names actions: a layer with allow rules for an action must have one that matches, and a layer with none for that action has no opinion. That is what the comment at the top of `lib/access.js` says; the sample's test confirms it.

Each sample has an expectations file (`policies/samples/<name>.expect.json`): a list of `{ url, action, allowed }` and `{ setting, value, allowed }` cases. The test suite runs every sample through the checker and its expectations, so a sample can't go stale when the rule engine changes.

## The checker and the build

**`tools/policy.mjs`**, importing the real `lib/policy.js` and `lib/access.js` so it can't drift from the extension:

- `check <file>`: schema, unknown keys (with the nearest known key suggested), every pattern and rule parsed with the extension's own parser, fixed values tested against the file's own `allowed`, secrets refused, `build.id` and `updateUrl` present and not Surprisingly's, and every fixed address and pattern covered by `build.hosts` when it is set. It warns when `build.hosts` would cut off something the policy leaves open (the default Hugging Face model source, for example).
- `explain <file>`: a plain-English summary of what the build will and won't do, for the organisation's security team to read.
- `try <file> <url> [action]`: what the rules decide for one address, and which rule decided it. Also takes `--setting gateway.baseUrl`.

**`tools/build-ext.mjs`** replaces the `build:ext` script: `pnpm build:ext` builds the default as today; `pnpm build:ext --policy path/to/file.json` runs the checker, copies `extension/` to a staging folder, writes the file as `policy.json`, rewrites the manifest (`gecko.id`, `update_url`, `optional_host_permissions`, `connect-src`), and builds from the staging folder to `dist/power-loader-<version>-<slug>.zip`. It never edits `extension/` in place. `tools/source-bundle.mjs` takes the same flag so the organisation's source archive rebuilds to the same package.

An organisation keeps its file in its own repo or fork. Nothing in this repo needs changing to make a build.

## The skill

`.claude/skills/policy-file/SKILL.md`, in this repo, so anyone who clones it and opens Claude Code can use it. It:

1. Asks what the organisation wants to fix, constrain or turn off, starting from the nearest sample.
2. Writes the file, using only keys in `POLICY_DEFAULTS` and the `build` keys.
3. Runs `check`, then `explain`, and shows the explanation to the person in place of the JSON.
4. Asks for a handful of addresses that must work and a handful that must not, writes them as an expectations file, and runs them with `try`.
5. Builds the package and runs the Firefox smoke test against it.
6. States what the build doesn't promise (the list above), and refuses to put a token in the file.

## Build order

1. **Reader.** `lib/policy.js` loads `policy.json`; when it is the default, managed storage is read as today, otherwise it is ignored. `getPolicy()` also returns the file's name. `allowed`, `gateway.enabled`, `library.syncMinutes` and `workstation.clearCaseOnClose` join `POLICY_DEFAULTS`. Unit tests.
2. **Enforcement.** `allowed` checked in `connectionConfig()`, `libraryUrl()` callers and the model fetch in `lib/model-fetch.js`; `gateway.enabled`. Tests at each choke point, including a value saved before the rule.
3. **Library sync** at start and on the alarm.
4. **Clear on close**, step 1 (at next start), with the standing line and the receipt.
5. **Checker.** `tools/policy.mjs` with `check`, `explain`, `try`, and its tests.
6. **Samples** and their expectations, run by `pnpm test`.
7. **Build.** `tools/build-ext.mjs` (identity, `host_permissions`, `connect-src`), the source bundle flag, a `policy` job in `tools/ci-local.sh` that builds every sample and lints the result.
8. **Interface.** Settings shows which values the organisation set and any pattern beside its box; the "doesn't work on this site" message; the readiness page and diagnostics name the built-in policy and list its keys (never values, as today).
9. **Real Firefox.** A Firefox suite run on the `locked-down` sample build: no permission prompt on a host in `build.hosts`; the model loads, OCR and PDFs work under `connect-src`; a request outside `build.hosts` fails; managed storage is ignored; a case open at close is gone at the next start.
10. **Docs.** README *Policy* section, the how-it-works page's policy table (its test requires a row for every key), REVIEWERS.md, and a short `docs/organisation-builds.md` for the organisation doing it.
11. **Skill.**
12. ~~**Clear on close, step 2** (the case in `storage.session`).~~ Dropped: see decision 9.
13. **Clear after a time without use.** `workstation.clearCaseAfterHours` and `workstation.clearCaseMaxHours`, checked on their own alarm and at start, the same teardown with the outcome `expired`, the standing line, the last-hour warning and the receipt. Decisions 10 and 11.
14. **Capture on fixed-host builds.** `activeTab`, `menus` and a command for capture only; checked in Firefox 140 ESR. Decision 12.
15. **A switch for each tool.** `tools.*`, Settings, enforcement where each tool acts, the checker, samples and docs. Decision 13.

## To check before building

- `connect-src` on extension pages in Firefox 140 ESR: that it applies to the background script's `fetch`, and that Transformers.js, tesseract.js and pdf.js work under it (they may need `blob:` or `data:`).
- Whether Mozilla will sign an organisation's build of the same code under another id as an unlisted add-on without further review, and what they ask for.
- Whether the name and icon should change on an organisation build. The licence allows keeping them; I've assumed the name stays "Power Loader" and Settings says whose rules are built in.

## Decisions

Settled 2026-11-26:

1. They are called policy files.
2. An organisation build ignores managed storage. Guardrails change by shipping a new version.
3. The library address is constrained by pattern, so several team repos on one GitLab instance work with one build.
4. `build.hosts` can be a wide pattern such as `*.gov.uk` and is granted at install, so Firefox doesn't prompt site by site.
5. The library syncs at start and every hour.
6. Case data is cleared when the browser closes, with a warning.

7. `workstation.clearCaseOnClose` is an organisation setting, on by default in every build. The caseworker can turn it off in Settings, unless the organisation sets it (in a policy file, or in managed storage on the public build), which locks it.
8. `build.hosts` is optional. Without it a build works as the public one does today: any site is possible, but each domain is only granted when the caseworker asks for it, through Firefox's own prompt.

Settled 2026-11-26, after building steps 1 to 11, from the owner's answers:

9. **The case stays in `storage.local`; step 12 is dropped for good.** The owner: "don't worry about this, just clear the data after 24 hours or on browser close if possible". (`storage.session` holds just under 10 MiB in Firefox 140 and 153 ESR, which a large case could exceed.)
10. **A case left without use is cleared after a time, as well as at close.** The owner, then: "make the 24 hours for reset configurable by the org/user. most orgs probably want no more than e.g. 9 hours and many will want less". So `workstation.clearCaseAfterHours` takes half hours (lowest 0.5, 0 for never, default 24 in the public build), fixed by the organisation (locked) or capped by `workstation.clearCaseMaxHours`, under which the caseworker chooses (never and longer are refused); a fixed value wins, and the checker warns when it is above the maximum, or above 9 hours.
11. *Chosen while building, for the owner to overturn:* the time runs from the last time the case was used (`touchedAt`, set by every change to it, each logged activity among them, the same time the idle check reads), not from when it started, so a case being worked isn't deleted under the caseworker. It is checked on its own alarm, set for when the case would be due and moved on with each use, so a half-hour limit is kept, and at start.
12. **`build.hosts` is about the clipper, not capture.** The owner: "region capture is basically part of screenshot as people can use the clipper or screenshots anyway. have a separate setting for turning each tool on and off, including visual capture. the hosts thing is just about which pages the standard clipper can run on". Firefox offers capture only with `<all_urls>` or `activeTab`, and a click in the sidebar doesn't grant `activeTab` (checked in Firefox 140.17 ESR: refused after a sidebar click, allowed after the page's right-click menu item or a keyboard command). So a build with fixed hosts gets `activeTab` (with `menus` and an Alt+Shift+R command) for capture only, rather than an optional `<all_urls>`, which would widen what Firefox lets the clipper do.
13. **A switch for each tool** (`tools.<name>`, unset means on): set, locked; unset, the caseworker's. The tools: region capture, the reader, the calculator, the timeline and notes on pages. Those with a switch already (`gateway.enabled`, `siteAccess.backgroundReading`, `assistModel.enabled`, `privacyModel.use`) aren't switched twice, but are listed with them. No switch gates Build.
