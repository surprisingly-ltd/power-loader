# Organisation builds

An organisation can publish its own version of Power Loader with its rules built into the signed package. The
rules then hold on any machine it is installed on, whether or not IT's browser policy reached that machine.
The rules are a **policy file**. This page is for the organisation doing it.

The design and its decisions are in [docs/plans/org-policy-builds.md](plans/org-policy-builds.md). Every policy
key is listed, with its default, on [How it works](https://powerloader.surprisingly.ltd/how-it-works#policy-keys).

## What a policy file is

```json
{
  "schema": "powerloader-policy/1",
  "name": "Example Council",
  "build": {
    "id": "powerloader@example.gov.uk",
    "updateUrl": "https://addons.example.gov.uk/powerloader/updates.json",
    "hosts": ["https://*.example.gov.uk/*"]
  },
  "policy": {
    "gateway": { "baseUrl": "https://ai.example.gov.uk/v1", "model": "fast" },
    "library": { "auth": "cookies" },
    "allowed": { "library.baseUrl": ["https://gitlab.example.gov.uk/casework/*"] }
  }
}
```

- **`name`** is shown in Settings ("Rules built in by Example Council") and in diagnostics.
- **`build.id`** and **`build.updateUrl`** are your add-on's own identity. You can't sign a build under
  Surprisingly's id. Both are required.
- **`build.hosts`** is optional: the sites the build may ever touch, as match patterns. Firefox grants them when
  the extension is installed, so it never asks site by site, and nothing outside them can be granted. The
  extension's own pages can't connect outside them either (`connect-src`). Leave it out and the build works as
  the public one does: any site, each granted only when the caseworker allows it.
- **`policy`** has the same keys as managed storage (Firefox `policies.json`), so what you already have there
  can be pasted in. A key set here is locked.
- **`policy.allowed`** constrains a setting by pattern instead of fixing it. The caseworker may choose any value
  that matches. It takes `gateway.baseUrl`, `gateway.model` (names, with `*` as a wildcard), `library.baseUrl`,
  and the `filesUrl` and `baseUrl` of `privacyModel` and `assistModel`. Patterns are the site-rule patterns.
  Each request is checked against them when it is sent, so a value saved before the build is never used.
- **`policy.gateway.enabled: false`** turns the remote AI off and locks it off.
- **No secrets.** Anyone with the package can read the file. The checker refuses a token. A private GitLab library
  is read with the caseworker's own sign-in: `library.auth: "cookies"`.

An organisation build **ignores managed storage**. To change a rule, ship a new version. Flows, forms and the
library's own site rules still arrive through the library, without a new build.

These behaviours are on in every build, the public one too:

- The library syncs at browser start and every hour (`library.syncMinutes`, lowest 15, `0` for off).
- The open case is deleted when Firefox closes (`workstation.clearCaseOnClose`). The caseworker can turn this off
  in Settings, unless your file sets it, either way.
- The open case is deleted after a time without use (`workstation.clearCaseAfterHours`, default 24, in half hours,
  lowest 0.5, `0` for never). The time runs from the last thing done in the case. Your file can fix it (locked), or
  set a maximum the caseworker may choose at or below (`workstation.clearCaseMaxHours`; never is then refused).
  Most organisations will want no more than 9 hours, and many will want less. The case says what applies while it's open, the sidebar warns shortly before (an hour, or a
  sixth of a short time), and the next start shows what was deleted and why.

### Tools

Each tool has its own switch. Set in your file (`true` or `false`) it is locked; left out, it is on and the
caseworker can turn it off in Settings. Off, the tool isn't offered anywhere and its action is refused where it is
carried out. No switch turns off Build: anyone can make and change flows.

| Key | Tool |
|---|---|
| `tools.capture` | ⬚ Select a region of the screen |
| `tools.reader` | The reader: PDFs, pictures and pasted screenshots, read on this computer |
| `tools.calculator` | The calculator |
| `tools.timeline` | The timeline |
| `tools.notes` | A flow's notes drawn onto its pages |

Tools that already have a switch, listed in the same place in Settings: the remote AI (`gateway.enabled`), reading
pages in the background (`siteAccess.backgroundReading`), the profile assistant (`assistModel.enabled`) and the
privacy model (`privacyModel.use`).

## Start from a sample

`policies/samples/` has six, each with a `.md` saying what it does and leaves open:

| File | What it does |
|---|---|
| `no-post.json` | Fetch steps never send a POST. |
| `fetch-one-domain.json` | Background requests only to `example.gov.uk`, never a POST. |
| `fixed-endpoints.json` | AI endpoint and model, library and model files fixed; `build.hosts` set. |
| `endpoints-by-pattern.json` | The same, allowed by pattern: one build for several teams. |
| `no-remote-ai.json` | No remote AI. |
| `locked-down.json` | All of these, with a site allow list for every action. |

Keep your file in your own repo or fork. Nothing in this repo needs changing to make a build. In Claude Code, the
`policy-file` skill (`.claude/skills/policy-file/SKILL.md`) walks you through it.

## Check it

```sh
node tools/policy.mjs check my-policy.json      # problems and warnings
node tools/policy.mjs explain my-policy.json    # what the build will and won't do, for your security team
node tools/policy.mjs try my-policy.json https://records.example.gov.uk/clients/1 [action]
node tools/policy.mjs try my-policy.json --setting library.baseUrl https://gitlab.example.gov.uk/casework/a/-/raw/{ref}/
node tools/policy.mjs try my-policy.json --expect my-policy.expect.json
```

An expectations file is a list of `{ "url", "action", "allowed" }` and `{ "setting", "value", "allowed" }`. Write a
handful of addresses that must work and a handful that must not, and keep it beside the policy file.

`try` shows your organisation's rules. The library's and the caseworker's rules can only narrow them.

## Build it

```sh
pnpm install --frozen-lockfile
pnpm build:ext --policy my-policy.json          # dist/power-loader-<version>-<slug>.zip
pnpm bundle:source --policy my-policy.json      # dist/power-loader-<version>-<slug>-src.zip
```

The build checks the file first, then builds from a copy of `extension/` with your file as `policy.json` and the
manifest rewritten: your id and update address, and, with `build.hosts`, `host_permissions`, no optional host
permissions and `connect-src`. `extension/` itself is never changed. The source archive holds your file as
`organisation-policy.json` and rebuilds to the same package with `pnpm build:ext --policy organisation-policy.json`.

Then sign the package with Mozilla as an unlisted add-on under your own id, and host it with your own
`updates.json`.

## What the build can and can't promise

- The site rules are checked by Power Loader's own code. They guard against mistaken and poisoned flows.
- `build.hosts` is enforced by Firefox: the extension can't be granted a host outside it, and its pages can't
  connect outside it.
- Fetch steps run in the page's own tab and only fetch from that page's site, so `connect-src` doesn't cover
  them. The site rules and the host permission do.
- A signed package can't be edited without breaking its signature. Someone allowed to install other add-ons
  could still install the public build: stopping that is browser policy's job, not this file's.
- `build.hosts` is about which pages the clipper runs on: reading, filling and fetching pages, and the host
  permissions granted at install. It doesn't take capture away. Firefox lets an extension capture the screen only
  with permission for every site or with `activeTab`, so a build with `build.hosts` gets `activeTab`, for capture
  only: the caseworker chooses **Select a region with Power Loader** on the page's right-click menu, or presses
  Alt+Shift+R, and Firefox lets Power Loader capture that tab until it moves to another page. The **⬚ Select a
  region** button in the sidebar says so, because a click in the sidebar doesn't count for Firefox. While the grant
  lasts Firefox would also let Power Loader run on that tab; it only draws the box and captures. The site rules'
  `capture` action still decides which pages. With `tools.capture: false`, the build has no permission to capture.
- The privacy model downloads from Hugging Face by default, which redirects to its CDN. With `build.hosts` set,
  give it your own mirror (`privacyModel.filesUrl`); the checker warns if you don't.

## Checked, and not yet checked

Checked in Firefox 140.17 ESR and 153.8 ESR, with the `locked-down` sample installed as a normal add-on
(`pnpm test:firefox:org`): hosts granted at install with no prompt, nothing else grantable, `connect-src` on the
background, pages and workers, Transformers.js, tesseract.js and pdf.js under it, managed storage ignored, the
library synced at install and at start and read with the browser's cookies, a case open at close gone at the next
start, a case left without use past its time deleted at once, capture absent and refused with `tools.capture: false`,
and, on a second build with capture on, the page's right-click menu clicked as a person would (through Marionette),
the region box drawn and the tab captured. Firefox refused capture before the menu was used ("Missing activeTab
permission") and allowed it after.

Not checked here: Mozilla signing an organisation's build under another id, a hand install (Firefox should list
the sites once, at install), a real GitLab instance serving raw files to the signed-in session, and the
privacy model's full download under `connect-src` (it needs WebGPU and the real files).
