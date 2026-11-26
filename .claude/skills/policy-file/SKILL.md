---
name: policy-file
description: Write, check and build a Power Loader policy file for an organisation build (the organisation's own version of Power Loader with its rules built into the signed package). Use when someone wants to lock Power Loader down for their organisation, fix or constrain the AI endpoint, model, library or model files, turn the remote AI off, limit the sites it may touch (build.hosts), stop fetch steps posting, explain a policy file to a security team, test addresses against one, or build the package. Not for managed storage (policies.json) on the public build, and these are policy files, never "profiles".
---

# Policy files for organisation builds

A policy file is built into an organisation's own version of Power Loader. Read `docs/organisation-builds.md`
first: it says what each part of the file does and what the build can and can't promise. The reader is
`extension/lib/policy.js`; the checker is `tools/policy.mjs`; the build is `tools/build-ext.mjs`.

## 1. Find out what they want

Ask, in plain words, what the organisation wants to **fix**, **constrain** or **turn off**:

- the remote AI: its address and model fixed, allowed by pattern, or off;
- the forms library: one address, or any repo under one GitLab group (allowed by pattern); read with the
  caseworker's own sign-in;
- where the on-device models come from (their own mirror, if huggingface.co is blocked or `build.hosts` is set);
- which sites Power Loader may touch at all (`build.hosts`, granted at install, enforced by Firefox), and which it
  works on (site rules, checked by Power Loader);
- background requests (fetch steps): no POSTs, or only to their own domain;
- whether caseworkers may keep a case when Firefox closes, and after how long without use an open case is
  deleted (`workstation.clearCaseAfterHours`, fixed, or a maximum with `workstation.clearCaseMaxHours`). Say, as
  guidance, not a rule: most organisations will want no more than 9 hours, and many will want less;
- which tools are on (`tools.capture`, `tools.reader`, `tools.calculator`, `tools.timeline`, `tools.notes`; set, a
  switch is locked). The remote AI, background reading, the assistant and the privacy model have their own keys
  already: don't add another. No switch turns off Build.

Start from the nearest sample in `policies/samples/` (each has a `.md` saying what it does and leaves open) and
change it. Also ask for the organisation's name, its add-on id (such as `powerloader@example.gov.uk`, on a domain
it controls) and the https address of its `updates.json`.

## 2. Write the file

Use only keys in `POLICY_DEFAULTS` (`extension/lib/policy.js`), `policy.allowed`, and `build.id`, `build.updateUrl`,
`build.hosts`. Patterns use the site-rule grammar (`parsePattern()` in `extension/lib/access.js`):
`https://*.example.gov.uk/*`, `https://gitlab.example.gov.uk/casework/*`. `build.hosts` takes Firefox match patterns.

**Never put a secret in the file**: no `library.token`, no API key, no password in an address. Anyone with the
package can read it. Refuse if asked, and say why: a private GitLab library uses `library.auth: "cookies"`, and
each caseworker enters the gateway key in Settings. In examples, use `example.gov.uk`.

## 3. Check and explain

```sh
node tools/policy.mjs check <file>
node tools/policy.mjs explain <file>
```

Fix every problem `check` reports and talk through each warning. Then show the person the output of `explain`,
not the JSON: it is what their security team reads.

## 4. Test it with their addresses

Ask for a handful of addresses and settings that must work and a handful that must not. Write them beside the
policy file as `<name>.expect.json`:

```json
[
  { "url": "https://records.example.gov.uk/clients/1", "action": "read", "allowed": true },
  { "url": "https://records.example.gov.uk/clients/1", "action": "fetch-post", "allowed": false },
  { "setting": "library.baseUrl", "value": "https://gitlab.example.gov.uk/casework/team-a/-/raw/{ref}/", "allowed": true }
]
```

Actions: `navigate`, `read`, `fill`, `annotate`, `capture`, `fetch-get`, `fetch-post`. Run them:

```sh
node tools/policy.mjs try <file> --expect <name>.expect.json
node tools/policy.mjs try <file> <url> [action]        # one address, and which rule decided
```

If one doesn't hold, ask which is right, the expectation or the file, and change that one.

## 5. Build and smoke-test

```sh
pnpm install --frozen-lockfile
pnpm build:ext --policy <file>          # dist/power-loader-<version>-<slug>.zip
pnpm bundle:source --policy <file>      # its source archive, for Mozilla's review
pnpm check:lint                         # the public build lints clean; tools/ci-local.sh --only policy lints the samples' builds
POWERLOADER_FIREFOX=/path/to/firefox-esr pnpm test:firefox:org   # the locked-down sample, installed in Firefox ESR
```

The Firefox check runs the `locked-down` sample, pointed at a local server, not the person's own file: their
addresses aren't reachable here. Say so. They sign the package with Mozilla as an unlisted add-on under their id.

## 6. Say what the build doesn't promise

Always tell them, in these words or close to them:

- The site rules are checked by Power Loader's own code. They guard against mistaken and poisoned flows.
- `build.hosts` is enforced by Firefox: nothing outside it can be granted, and the extension's pages can't connect
  outside it.
- Fetch steps run in the page's own tab and only fetch from that page's site, so `connect-src` doesn't cover them;
  the site rules and the host permission do.
- A signed package can't be edited, but someone allowed to install other add-ons could install the public build.
  Stopping that is browser policy's job.
- The file holds no secrets: anyone with the package can read it.
- With `build.hosts` set, selecting a region starts from the page (its right-click menu, or Alt+Shift+R), because
  Firefox allows capture only with permission for every site or `activeTab`, and a click in the sidebar doesn't
  grant `activeTab`. `tools.capture: false` leaves the permission out.
- An organisation build ignores managed storage (`policies.json`). To change a rule, ship a new version.
