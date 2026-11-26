# Site rules: an allow list and a deny list for every flow

Created: 2026-11-25. Status: built, except where noted below (2026-11-25). Builds on `flow-authoring.md` and `library-and-profiles.md`. `fetch-steps.md` uses the same rules for steps that fetch pages.

**What's built.** `lib/access.js` (patterns, rules, layers, `allowed(layers | rules, url, action)`, `originVerdict()`, `access.json` validation, the caseworker's overrides), with `accessLayers()` building policy, library-locked (pinned and current commit), yours and approved-hosts layers. `lib/core.js` `currentAccess()` reads them live for every check. Choke points 1 to 15 as below, the Settings card *Sites Power Loader works on* (locked rules shown apart from yours; change, turn off, *Use the library's*, *Keep mine*, *Try an address*), the Case tab's card, ⛔ steps and disabled links, `access.json` in `indexLibrary()` and `flowSet()`, policy `siteAccess.*` failing closed, permission housekeeping in `background.js`, `blocked_action` in the activity log, and rule counts in diagnostics. The two gaps are closed: a tested draft in use is used to clip or fill only on approved hosts (`pageProfiles()`, `fillProfileForCase()`), and a `{name}` in a link's scheme or host is refused (`templateErrors()`, `fillTemplate()`, and note links in `parseMarkup()`/`fillNote()`; the email step is a `mailto:` of single addresses, out of scope as below).

**Decided while building.** The approved-hosts layer is checked where a case's library applies (clipping, filling, drafts in use), not in `ask()` itself, so the flow editor still works on a flow's own hosts outside the library; it keeps `hostApproved()`'s reading (`*.example` is subdomains only), so it never widens today's rule. A policy layer that fails closed blocks every action, `navigate` included. Open questions, with the defaults taken: values clipped from a page that is now blocked may still be filled (the clip is marked, and the form's own page is checked); a delegated allow list is the caseworker's to widen, with `lockLibraryRules` as the organisation's switch; `read` isn't split for ✦ requests; failing closed on a policy deny that doesn't read is kept; the approved-hosts layer isn't shown in the Settings card.

**Deferred.** *More rules* for action-specific rules in Settings (they work from policy and `access.json` now; the editor adds allow and deny for every action) waits for `fetch-steps.md`, as planned. There is still no *Disconnect the library* control. The Firefox suite (`tests/firefox`) for this plan isn't written: it needs a real Firefox, as does checking `restricted_domains` against `scripting.executeScript`. In the flow editor, only *Use the current form/page* is disabled on a blocked site; *Test*, series tests and the draft editor are refused at `ask()` with the reason, rather than disabled beforehand.

## Why

Today the pages Power Loader may read and fill are whatever the case's library approves. A library approves hosts in `library.json` (`approvedHosts`, checked by `hostApproved()` in `lib/library.js`). A flow without a library approves the hosts of its own pages (`flowHosts()` in `lib/flows.js`), and with a library it adds them to the library's list (`flowLib()` and `flowSet()` both take the union). So a flow imported from a file approves whatever hosts it names, and nothing outside the flow can say "never on these pages".

**Site rules** are a list of allowed and blocked addresses that applies to every flow and every library. The team's library sets them. Enterprise policy can set them above the library. The caseworker can add their own in Settings. For example, the library allows `https://*.surprisingly.ltd*` and blocks `https://finance.surprisingly.ltd*`: Power Loader then reads, fills and fetches only on `surprisingly.ltd` sites, and never on the finance one.

## What the rules guard against

The caseworker controls their own browser: unless policy locks the library address they can connect another library (there is no *Disconnect* control; *Delete all Power Loader data* removes the library copy and settings), and they can remove the extension or read any page themselves. In the user's words, "they can do pretty much anything in their browser anyway so this is just a guard against accidental/poisoned flows rather than actually stopping anyone from doing anything malicious."

So site rules are **not a security boundary against the caseworker**. They guard against:

- a mistaken flow or profile whose match pattern is too wide, so it clips or fills the wrong system;
- a poisoned flow file, imported from someone else, that names pages it shouldn't touch;
- a library change that adds a page on a system the organisation has ruled out;
- in `fetch-steps.md`, a step that would fetch, or post to, a page it shouldn't.

They restrict what Power Loader does. They never restrict the caseworker's browsing: a blocked page still opens and works as normal; Power Loader just doesn't read it, fill it, capture it or fetch it. Wording in the interface follows this. It says "Power Loader doesn't work on this page", never "this page is blocked".

## The rules

### Shape

One shape for every source, general enough for `fetch-steps.md`:

```text
Rule   { id, effect: 'allow' | 'deny', pattern, actions?: [Action], lock?: boolean, note? }
Action  'navigate'   Power Loader opens the page (Go to, step links, Open the form) or logs a visit to it
        'read'       clip, auto-clip, test or pick a profile, describe a form, page text, the privacy check,
                     confirmation pages, and any ✦ request that sends the page's HTML or text
        'fill'       fill a form
        'annotate'   write a flow's notes into the page's DOM at a selector (flow annotations, being built now)
        'capture'    select a region of the tab (captureVisibleTab)
        'fetch-get'  a fetch step's GET request (fetch-steps.md)
        'fetch-post' a fetch step's POST request (fetch-steps.md)
```

- `actions` left out means every action.
- `lock` only means something in the library's file (below).
- `fetch-post` is a **closed** action: nothing is allowed until an allow rule names it. Every other action is **open**: allowed unless a rule says otherwise. An allow rule without `actions` never opens `fetch-post`.

The simple Settings form is the same shape: each address in *Allowed* is `{ effect: 'allow', pattern }` and each in *Blocked* is `{ effect: 'deny', pattern }`, with no actions, so they cover everything. Rules for particular actions ("block posting to `https://cm.surprisingly.ltd/decide/*`") are added under *More rules* once fetch steps exist (`fetch-steps.md`, phase 2).

### How a decision is made

The rules come in **layers**. For a URL and an action:

1. In each layer, a **deny** rule that matches the URL and covers the action blocks it.
2. In each layer that has **allow** rules covering the action, the URL must match one of them.
3. A layer with no allow rules for the action has no opinion on it. For a closed action (`fetch-post`), though, the URL must match an allow rule naming it in at least one layer.
4. The action is allowed only if every layer allows it.

So **deny always wins**, in any layer. **An empty allow list allows everything** except what is denied. Allow lists in different layers **intersect**: adding a layer can only take pages away, never add them.

### The layers, top to bottom

| Layer | Where it comes from | Who can change it |
|---|---|---|
| Policy | managed storage, `siteAccess.*` (`lib/policy.js`) | IT only; needs a Firefox restart |
| Library, locked | the library's `access.json`, rules with `lock: true` | the library team, by publishing |
| Yours | Settings: your own rules, plus the library's delegated rules as you've left them | you |
| Approved hosts | the case's library `approvedHosts`, or a flow's own hosts | the library team, or the flow's author |

The approved-hosts layer is today's rule, written as allow rules (`*.example.gov.uk` becomes `*://*.example.gov.uk*`, `localhost:8787` becomes `*://localhost:8787*`). It covers `read`, `fill`, `fetch-get` and `fetch-post`, as now. It doesn't cover `navigate` or `capture`, because today neither is limited to approved hosts: step links can open any web address, and region capture works on any tab. Keeping that means no current flow breaks; the other layers can still block them.

The effective set is the intersection of all four, never a widening. A host the library approves but the site rules don't allow can't be used. A host the site rules allow but the library doesn't approve can't be read or filled.

**Gap this closes.** As far as I can see, `pageProfiles()` uses a tested draft in use without checking its hosts. `draftHostsApproved()` in `lib/drafts.js` is exported but nothing calls it, so a caseworker's draft could clip an unapproved host. Checking the approved-hosts layer at every choke point (below) closes this. Confirm it while building.

### The library declares the rules: `access.json`

A library file like `privacy.json`, listed in `library.json` with its SHA-256. `fetchLibrary()` in `lib/library-sync.js` fetches and hashes every listed file, so it needs no change for that. It also refuses the whole commit when `indexLibrary()` reports any problem, so a bad `access.json` keeps the last known good library.

```json
{
  "schema": "powerloader-access/1",
  "allow": { "lock": true,  "rules": [{ "id": "org", "pattern": "https://*.surprisingly.ltd*" }] },
  "deny":  { "lock": false, "rules": [{ "id": "fin", "pattern": "https://finance.surprisingly.ltd*" },
                                      { "id": "pay", "pattern": "https://cm.surprisingly.ltd/payments/*", "actions": ["fill"], "lock": true }] },
  "rules": [{ "id": "dec", "effect": "deny", "pattern": "https://cm.surprisingly.ltd/decide/*", "actions": ["fetch-post"], "lock": true }]
}
```

- `allow` and `deny` are the two simple lists, each with a `lock` for the whole list. `rules` holds rules with their own `effect`. A rule's own `lock` overrides its list's. `lock` defaults to `false`.
- **Locked** rules are in the *Library, locked* layer. The caseworker sees them in Settings but can't change, turn off or override them.
- **Delegated** rules (`lock: false`) start in the caseworker's layer. They can edit one, turn it off, or add their own allow and deny rules beside it. A delegated allow list is the starting point: the caseworker can add to it and widen it, because it's theirs to manage.
- The caseworker's changes to delegated rules are kept by rule `id`, so a library update still reaches the rules they haven't touched. A rule the library removes disappears, even if it was edited. A rule the library changes after the caseworker edited it shows *The library changed this rule* with *Use the library's* and *Keep mine*.
- `indexLibrary()` gets a kind `access` (in `kindOfPath()`) and calls `validateAccess()` from a new `lib/access.js`. Errors: unknown schema, a pattern that doesn't parse (see *Patterns*), an unknown action, a duplicate or missing `id`, more than 500 rules. The indexed library gets `lib.access = { locked: [Rule], delegated: [Rule] }`.
- **Narrowing a locked list.** Yes, always. A caseworker's deny rules sit in their own layer, and deny wins in any layer, so they can block anything. Their allow rules can narrow a locked allow list but never widen it: the layers intersect.
- Policy key `siteAccess.lockLibraryRules` (default `false`) makes every library rule count as locked, for an organisation that wants the library's lists fixed whatever the file says.
- `"backgroundReading": { "on": false, "lock": true }` (both optional in the file; `on` is required when it's there) sets *Read pages in the background* for fetch steps, locked or left to the caseworker. Off is a deny of `fetch-get` and `fetch-post` in the rule engine. Policy `siteAccess.backgroundReading` sets and locks it above the library. See `fetch-steps.md`.

### Enterprise policy

New keys in `POLICY_DEFAULTS`, read by `getPolicy()` and listed in the README's Policy section:

```text
siteAccess: { allow: null, deny: null, rules: null, lockLibraryRules: false }
```

`allow` and `deny` are lists of patterns. `rules` is a list of full rules. As with every policy key, a value that is set is locked (`merge()` in `lib/policy.js` adds it to `locked`), and the policy card in Settings lists it. Policy rules are a layer of their own above everything else, so the library can't widen what policy allows. Policy patterns are checked when policy loads. An allow pattern that doesn't parse is dropped, which narrows. A **deny** pattern that doesn't parse would widen if dropped, so Power Loader **fails closed**: it reads, fills, captures and fetches nothing, and Settings says *Your organisation's site rules have an address Power Loader can't read: … Ask IT to correct it.*

### When there's no library

- **No library connected:** the policy layer and the caseworker's own rules apply. The caseworker's layer then holds only their own rules.
- **A flow started without a library** gets the same: policy, the caseworker's rules, and its own hosts as the approved-hosts layer.
- **A flow started with a library connected** gets the library's rules too. `flowSet()` already copies the connected library's `privacy.json` into the flow's set. It copies `access.json` the same way, so the case pins it.
- **Turning the library off.** I couldn't find a control that disconnects a library today; the address can only be changed. Whatever form *Disconnect* takes, it drops the library layers for new cases. A case already open keeps its pinned library, and with it the library's rules.
- **A flow file can never widen the rules.** A `powerloader-flow/1` file carries no rules. `importFlow()` keeps only the known page fields (`pageExtras()`), so a planted `access` key is dropped. Its hosts only reach the approved-hosts layer, which intersects with the others.

### Which library rules apply to an open case

A case pins its library commit. A deny published mid-case should still reach it, so an open case uses the library rules of **both** its pinned commit and the current synced commit, as separate layers. That can only narrow. The caseworker's and policy's rules are always read live: a change in Settings applies at the next action, in the open case too.

## Patterns

### One syntax, read strictly

There are three URL syntaxes in Power Loader now:

1. **Profile match patterns** (`matchUrl()` in `lib/extract.js`). The whole URL without its fragment, query included, compared with `^…$`, where `*` is any run of characters. Case-sensitive. The host isn't treated specially.
2. **Approved hosts** (`hostApproved()`). A `host[:port]`, compared case-insensitively. `*.example` matches subdomains, not `example` itself.
3. **Firefox match patterns**, used for permissions (`originPattern()` in `lib/core.js`, `libraryOrigin()`): `scheme://host/*`. `*.example` matches `example` and its subdomains. No port: `originPattern()` drops it because Firefox ignores it.

Site rules are **written like profile match patterns** (the user's examples are in that form, and authors already write them), but are **read as URLs**, in their parts. `matchUrl()` is too loose for a list that decides where Power Loader may work. With it, `https://*.surprisingly.ltd*` also matches `https://cm.surprisingly.ltd.evil.example/` and `https://evil.example/?x=.surprisingly.ltd`. The host is read with Firefox match-pattern rules, so permissions and rules agree.

```text
pattern = scheme "://" host [":" port] [rest]
scheme  = "https" | "http" | "*"           "*" is http and https
host    = "*" | ["*."] name                 name: a host name, an IPv4 address or [an IPv6 address]; no other "*"
port    = digits | "*"
rest    = "*"                               straight after the host: any port and any page on it
        | "/" path                          path and query; "*" is any run of characters, including / ? = &
```

`parsePattern()` in `lib/access.js` turns a pattern into `{ schemes, host, subdomains, port, path }`. `matchRule()` compares a URL parsed with `new URL()`. Both are pure and offline-tested.

### Edge cases

| Case | Rule |
|---|---|
| Scheme | `https://` matches https only, `http://` http only, `*://` both. A **deny** written with `https://` also covers `http://`, so a downgrade never gets round a block. Other schemes (`file:`, `about:`, `moz-extension:`, `data:`, `blob:`, `mailto:`) are never matched; Power Loader only works on http and https pages anyway (`isWebPage()` in `sidebar/sidebar.js`). |
| `*.` | `*.surprisingly.ltd` is `surprisingly.ltd` and every subdomain, as in Firefox match patterns. That differs from `hostApproved()`, and the editor says so. A label boundary is kept: `notsurprisingly.ltd` doesn't match. |
| A bare host | `finance.surprisingly.ltd` is that host only, not `a.finance.surprisingly.ltd`. To block its subdomains too, write `*.finance.surprisingly.ltd`. The editor points this out for deny rules. |
| `*` elsewhere in the host | Refused (`cm.*.gov.uk`, `*cm.gov.uk`): it can't be read one way only. |
| Ports | No port means any port. `:8443` means only that port. Default ports (443, 80) are dropped from both sides, as `new URL()` does. |
| Paths | No path, or a `*` straight after the host, means every page. A path without a trailing `*` is that exact path and query only; the editor warns *Only this exact address: add * for the pages under it.* Paths are case-sensitive, as URLs are. Both sides are normalised by `new URL()` (`/a/../b` is `/b`, spaces are `%20`). |
| Query strings | Part of the path, as in `matchUrl()`: `https://cm.x/case?id=*`. |
| Fragments | Always dropped, from the pattern and the URL. |
| Case | Scheme and host are lowercased. |
| IDN | Hosts are compared in punycode, as `new URL()` gives them (`bücher.example` is `xn--bcher-kva.example`). The editor shows the Unicode form beside it. |
| Trailing dot | `finance.surprisingly.ltd.` is `finance.surprisingly.ltd`. |
| User info | `https://cm.surprisingly.ltd@evil.example/` has host `evil.example`; it is the parsed host that's matched. |
| IP addresses | Matched as `new URL()` writes them (`http://0x7f.1/` is `127.0.0.1`). `*.` before an IP address is refused. |

### Worked example

Allow `https://*.surprisingly.ltd*`, deny `https://finance.surprisingly.ltd*`. The last column is what `matchUrl()` would say for the allow pattern, to show why it isn't used.

| Address | Allow | Deny | Power Loader | `matchUrl` allow |
|---|---|---|---|---|
| `https://cm.surprisingly.ltd/cases/1042` | yes | no | works | yes |
| `https://surprisingly.ltd/` | yes, `*.` includes the domain | no | works | no |
| `https://finance.surprisingly.ltd/ledger` | yes | yes | doesn't work | yes |
| `https://FINANCE.Surprisingly.LTD/ledger` | yes | yes, host lowercased | doesn't work | yes, as Firefox lowercases it |
| `https://finance.surprisingly.ltd./ledger` | yes | yes, trailing dot dropped | doesn't work | yes |
| `https://finance.surprisingly.ltd:8443/x` | yes | yes, any port | doesn't work | yes |
| `https://a.finance.surprisingly.ltd/` | yes | **no**, a bare host | works; write `*.finance…` to block it | yes |
| `http://cm.surprisingly.ltd/` | no, https only | no | doesn't work | no |
| `http://finance.surprisingly.ltd/` | no | yes, a deny covers http | doesn't work | no |
| `https://cm.surprisingly.ltd.evil.example/` | no | no | doesn't work | **yes** |
| `https://evil.example/?next=.surprisingly.ltd` | no | no | doesn't work | **yes** |
| `https://cm.surprisingly.ltd@evil.example/` | no, host is evil.example | no | doesn't work | **yes** |
| `https://notsurprisingly.ltd/` | no | no | doesn't work | no |
| `https://bücher.surprisingly.ltd/` | yes, as `xn--bcher-kva…` | no | works | yes |
| `https://cm.surprisingly.ltd/cases/1042#finance` | yes, fragment dropped | no | works | yes |

## Where it's enforced

Every check calls one function: `allowed(url, action)`, from `lib/access.js` with the layers built by `accessLayers({ policy, settings, caseLib, currentLib })`. It returns `{ ok, rule: { layer, id } | null }`. Checks happen **when Power Loader acts**, not only when a page loads, because redirects and single-page apps change the address after the first check.

### Choke points

| # | Where | Action | What changes |
|---|---|---|---|
| 1 | `lib/core.js` `ask()` and `ensureAgent()` | from the message type | Every message to the in-page agent goes through `ask()`, from the sidebar and from the background (`registerPageRoutes()`). Before injecting or sending, get the tab's address with `tabs.get(tabId)` and check it. Message types map to actions: `extract`, `applies`, `probe`, `capture`, `describeForm`, `values`, `labels`, `pageText`, `pick*`, `override*`, `highlightPII` → `read`; `fill` → `fill`; the annotation messages → `annotate`; `selectRegion` → `capture`; `ping`, `scroll`, `scrollTo`, `clearPII`, `pickStop`, `cancelRegion` need no check. No agent is injected into a page where `read`, `fill`, `annotate` and `capture` are all blocked. |
| 2 | `lib/agent.js` message handler | the same | The moment of reading. `powerloader:fill` already refuses when `msg.url !== location.href`. Every reading message gets the same check: `ask()` sends the address it checked, and the agent refuses if the page is now somewhere else (fragment ignored for reading). A `pushState` or a redirect between the check and the read then fails safely: *The page changed: try again.* The agent needs no copy of the rules. |
| 3 | `sidebar/sidebar.js` `refreshPage()` | `read`, `fill` | Work out `info.blocked` (the actions blocked here, and the rule) before `profilesForTab()`. With `read` blocked, no profile, form or confirmation page is matched (`info.kind = 'blocked'`), so auto-clip never starts. |
| 4 | `lib/core.js` `clipTab()` | `read` | Checks before `extractFromTab()`, and checks `res.url` again (the address the agent read) before `addClip()`. Auto-clip goes through `act.clip()` and `clipTab()`, so it's covered. |
| 5 | `sidebar/fill-ui.js` `openFillPlan()`, `applyPlan()` | `fill` | Check before `describeForm()`, and check `described.url` again before sending the plan. The agent's own address check (row 2) covers a change after that. |
| 6 | `sidebar/tools/reader-ui.js` `selectRegion()` | `capture` | Check before asking for `<all_urls>`. Just before `captureVisibleTab()`, check the window's active tab again, because capture takes whatever is showing. See *Permissions* for `<all_urls>`. |
| 7 | `sidebar/privacy.js` `extractWithAI()`, `mapFormWithAI()`, *Check this page*; `sidebar/flows.js` and `sidebar/draft-editor.js` ✦ requests (`captureTab()`) | `read` | All read through `ask()` (row 1), so no ✦ request can carry a blocked page's HTML or text. The AI payload's `url` is checked as well, so a changed page fails before the preview. |
| 8 | `sidebar/flows.js` `whereCard()` (*Use the current form/page*), `guideEditor()`, `runTest()`, `testSeries()`; `sidebar/draft-editor.js` | `read` (pages to clip), `fill` (forms), `navigate` (pages to visit) | A blocked page can't be bound to a flow page or tested. The button is disabled with the reason. |
| 9 | `sidebar/sidebar.js` `act.openUrl()` | `navigate` | The one place Power Loader opens addresses: *Go to* a step, step links, *Open* a form, *Go to it* in the flow editor. A blocked address isn't opened. `stepsCard()` in `sidebar/caseview.js` shows the link disabled with *Power Loader doesn't open this address: the site rules block it*, and the caseworker can still copy it. It refuses rather than warns: a flow that sends caseworkers to a blocked page is a flow problem, and validation reports it (row 12). |
| 10 | `background.js` `logVisit()`, `lib/visits.js` `pageInfo()` | `navigate` | A blocked page is never logged as a visit, even on an approved host. |
| 11 | `sidebar/sidebar.js` `act.requestAccess()` | see *Permissions* | Never asks Firefox for an origin the rules block entirely. |
| 12 | `lib/flows.js` `validateFlow(flow, { access })` | all | New issue `blocked`: *Power Loader can't work on {page}: the site rules block {address}* (error), for a page's address, a profile's `match`, a link or a guide page. `startable()` refuses a flow whose forms are all blocked. |
| 13 | Library page, Case tab start list | all | `accessIssues(lib, layers)` lists profiles and forms the rules block. These issues aren't added to `indexLibrary()`'s problems, because indexing is cached per commit (`libraryAt()`) and the caseworker's rules change without the commit changing. They're shown beside the library's own problems instead. |
| 14 | Annotation rendering (flow steps that add notes to a page at a selector, with case values templated in; in progress, so names to be confirmed against that code) | `annotate` | No annotation is drawn on a blocked page. The message that draws them goes through `ask()` (row 1), and the agent checks its address at the moment of drawing (row 2). On every navigation (`tabs.onUpdated` with a new `url`, which `refreshPage()` already handles) the check runs again. Annotations already drawn are removed when the new address is blocked for `annotate`. A single-page app that changes its address with `pushState` doesn't reload the content script, so the agent also removes its annotations when `location.href` stops matching the address they were drawn for. |
| 15 | `lib/journey.js` `templateErrors()` | `navigate` | A link template can put a case value in the host today: `templateErrors()` replaces each `{name}` with `x` before checking, so `https://{x}.example/` passes. It should require the host to be literal, as `fetch-steps.md` requires for fetches, and `act.openUrl()` checks the filled address anyway. |

Matching a profile's `match` against the rules can't be exact, because a glob can cover more addresses than any example shows. `accessIssues()` checks the profile's `urlPattern` (with `{ref}` filled with a sample) and the fixed start of each `match` (scheme, host and the path up to the first `*`). If the host is blocked for the action, that's an **error**. If only some paths under it might be blocked, that's a **warning**: *Some pages this profile matches are blocked.* Either way, the choke points above decide on the real address at the moment of acting.

### Importing

- **A flow file** (`importFlow()`): `validateFlow()` reports `blocked` issues as soon as it opens. The flow is kept, so the author can see what's wrong.
- **A library** (`syncLibrary()`): it syncs as now. Blocked profiles and forms are listed on the Library page and refused when used. A library can't widen the rules by syncing: its `access.json` is one layer, and the approved-hosts layer intersects with the rest.

### A case already open

- Rules are read live, so the next clip, fill, capture or *Go to* uses the new rules.
- Clips already taken from a page that is now blocked stay in the case, marked *From a page the site rules now block*. They're never removed silently: removing evidence is the caseworker's choice, with the existing removal dialog. Whether their values may still be filled is an open question.
- A fill plan or a pending AI request made before the change is checked again when it is applied (rows 2, 5 and 7).

### Permissions

Power Loader asks for host access one origin at a time (`optional_host_permissions: ["<all_urls>"]`, requested with `permissions.request` in `act.requestAccess()`, the library and AI settings, and the reader). Firefox host permissions are origins with no path and, in Firefox, no port. So:

- **A deny that covers a whole origin** (the finance example: every page of `https://finance.surprisingly.ltd`) is expressed as an origin. `originVerdict(layers, origin)` returns `blocked`, and Power Loader never calls `permissions.request` for it. The *Allow on this site* button isn't shown; the card says Power Loader doesn't work on this site.
- **A deny narrower than an origin** (block `https://cm.surprisingly.ltd/payments/*` while the rest of `cm` is allowed) can't be expressed as a permission. Power Loader asks for `cm` as now, and the choke points refuse the payments pages.
- **Permissions already granted.** On startup (`background.js`) and when the rules change (`storage.onChanged` for `settings`, and after a library sync), `permissions.getAll()` lists the granted origins, and those the rules block entirely are removed with `permissions.remove()`. Removing them means Firefox's own *Permissions* panel matches the rules. It also stops `scripting.executeScript` from injecting into them, and needs no user action. `permissions.onAdded` (already used in `sidebar/sidebar.js`) does the same for an origin granted later from about:addons. Removal is housekeeping, not the guard; the choke points are.
- **`<all_urls>`.** Region capture asks for it (`selectRegion()`), and the managed install may grant it (`magic-reader.md`). It can't be granted "all but these": Firefox has no partial grant. When any rule restricts (a non-empty allow list, or any deny), Power Loader stops asking for `<all_urls>` itself. *Select a region* then says to paste a screenshot instead (Win+Shift+S), unless `<all_urls>` is already held. Where it is held, the choke points still decide.

### What Firefox does and doesn't let an extension enforce

| Can | Can't |
|---|---|
| Not ask for an origin, and remove optional origins it holds | Grant `<all_urls>` minus some sites, or a permission for part of an origin |
| Check the tab's address before every action, and again in the page when acting | Stop the caseworker opening, reading or copying any page (and it shouldn't) |
| Refuse to open an address from a step link | Stop page scripts changing the address after a check; it can only check again at the moment of acting |
| Remove a permission granted later from about:addons | Stop IT's policy granting permissions (that's IT's call, and the rules still apply) |

Firefox's enterprise policy has an `ExtensionSettings` option, `restricted_domains`, that stops every extension's content scripts on listed domains. I haven't checked how it works with `scripting.executeScript` in Firefox 140 ESR. It is IT's tool, outside Power Loader, and doesn't replace these rules. Power Loader doesn't use `webRequest` to block requests and shouldn't: that would control the caseworker's browsing, not Power Loader.

### Out of scope

- **The email step's `mailto:` link** isn't a page, a fetch or a fill. The email app opens it. Site rules don't apply. Addresses are already limited to single email addresses (`emailFor()`).
- **Power Loader's own infrastructure:** the library address, the AI gateway and the model server have their own settings and policy keys (`library.*`, `gateway.*`, `privacyModel.*`). Site rules apply to casework pages, not to them. An allow list that doesn't include the library host doesn't stop the library syncing.
- **Frames.** The agent runs in the top frame only (`frameId: 0`), and the rules check that frame's address. A cross-origin frame's content isn't readable from the top frame anyway.

## Settings, the Case tab and the flow editor

### Settings: *Sites Power Loader works on*

A card after *Forms library*.

- **Allowed.** Empty: *Every site, except those blocked below.* Otherwise the list, and above it: *Power Loader only reads, fills and fetches on these sites.*
- **Blocked.** *Power Loader never reads, fills, captures or fetches on these, even if they're allowed above. You can still open them yourself.*
- Each row: the pattern; how it reads (*surprisingly.ltd and its subdomains, any page*); where it comes from:
  - **🔒 Set by your organisation**: policy. No controls.
  - **🔒 Set by your library**: a locked library rule. No controls. *Your library team manages this.*
  - **From your library**: a delegated rule. *Change* and *Turn off*. When changed: *Changed by you · Use the library's*. When the library has changed it since: *The library changed this rule*, with *Use the library's* and *Keep mine*.
  - **Yours**: *Change* and *Remove*.
  - A turned-off rule stays in the list, struck through, with *Turn back on*.
- **Add an address**, for Allowed or Blocked: a box that shows how the address reads as it's typed, and refuses one that doesn't parse, with the reason (*`*` can only start a host, as in `*.example.gov.uk`*). For a deny on a bare host: *This doesn't block its subdomains. Block `*.finance.surprisingly.ltd` instead?*
- **Try an address**: paste one and see *Power Loader works here* or *Power Loader doesn't work here: blocked by {source} rule {pattern}*. No address is saved.
- Saved in `settings.siteAccess = { rules: [Rule], library: { [ruleId]: { off?: true, rule?: Rule, base?: hash } } }` through `saveSettings()`. `migrateSettings()` keeps unknown keys, so nothing else changes. The backup in *Support* already includes `settings`.

### The Case tab

On a blocked page, `contextCard()` in `sidebar/caseview.js` shows one card in place of the clip or fill card:

> **Power Loader doesn't work on this page.** The site rules {from your organisation | from your library | in your Settings} block reading and filling here. You can still use the page yourself.

When only some actions are blocked, it names them: *Power Loader can read this page but not fill it here.* A step whose page is blocked shows ⛔ in *All steps*, and its *Go to* is disabled (choke point 9).

### The flow editor

A blocked page shows the `blocked` issue on the flow's overview and on the page, with *Open Settings* and the rule. *Use the current form/page* is disabled with *Power Loader doesn't work on this site: the site rules block it.* Export is allowed, as with other problems. The file lists the issue, so a maintainer sees it.

### The activity log

A new activity in `lib/activity.js`: `blocked_action: 'Blocked by site rules'`. It is logged once per attempt that a caseworker started (a clip, a fill, a capture, a link, auto-clip) while a case is open, with:

- `page_type: 'blocked'` and `url_pattern` as `(link not kept)`. The page's address is never passed as `page.url`, so not even the open case holds it;
- `detail`: the action and the layer, for example `fill · library rule`. Never the pattern (a caseworker could type a client's address as a pattern), never a value.

Repeated attempts on the same page are logged once each time the page changes, not on every render. Without a case, `recordFailure('blocked-<action>')` counts them for *Copy diagnostics*. Diagnostics say how many rules are set in each layer, never the patterns.

## Tests

Offline (jsdom, `tests/js`):

- `access.test.js`: `parsePattern()` for every row of the edge-case table; the worked example table, row by row; decisions across layers (deny in any layer wins; allow lists intersect; an empty allow list allows; `fetch-post` closed until named; an allow without actions doesn't open `fetch-post`); policy deny that doesn't parse fails closed; `originVerdict()` for whole-origin and partial denies.
- `library.test.js`: `validateAccess()` errors, and `indexLibrary()` refusing a bad `access.json`; locked and delegated rules from list and rule `lock`; `lockLibraryRules`.
- Settings overrides: a delegated rule turned off, changed, removed by the library, changed by the library after the caseworker edited it.
- `flows.test.js`: `validateFlow()` `blocked` issues for addresses, matches, links and guide pages; an imported flow with a planted `access` key gains no rules; `flowSet()` copies `access.json` from the connected library.
- `sidebar.test.js`: a blocked page shows the card, offers no *Allow on this site* and doesn't auto-clip; `act.openUrl()` refuses a blocked link; `blocked_action` is logged without an address or pattern.
- `agent.test.js`: every reading message refuses when the address changed between the check and the read; annotations are not drawn on a blocked page, and are removed after a `pushState` to one.
- `journey.test.js`: `templateErrors()` refuses a `{name}` in the host.

Firefox (`tests/firefox`, against the demo):

- With a deny for a demo origin, the sidebar never shows a Firefox permission prompt for it, and a granted permission for it is removed at startup.
- A path deny on an allowed origin: clipping and filling are refused there, and work on the rest of the origin.
- A page that calls `history.pushState()` to a blocked path between the check and the clip: the clip is refused.
- A step link to a blocked address isn't opened.
- Policy `siteAccess.deny` from a test `policies.json`: shown locked in Settings, and enforced.

## Order of work

1. `lib/access.js`: patterns, rules, layers, `allowed()`, `originVerdict()`, with its tests.
2. Choke points 1 to 5, annotations (row 14) and the agent's address check: reading, filling and writing into pages.
3. Settings card, saved rules, and the Case tab's blocked card.
4. `access.json`: `validateAccess()` in `indexLibrary()`, locked and delegated rules, the copy in `flowSet()`, and the pinned-plus-current layers for an open case.
5. Policy keys, the fail-closed check and the README.
6. Permissions: not requesting, removing, `onAdded`, and `<all_urls>` for capture.
7. Navigation, visit logging, `templateErrors()`, validation, the Library page and import.
8. Activity logging and diagnostics.
9. The Firefox suite.
10. Action-specific rules under *More rules* wait for `fetch-steps.md`.

## What's decided

- One rule shape, `{ id, effect, pattern, actions?, lock?, note? }`, for policy, the library, Settings and fetch steps.
- Deny wins in any layer; allow lists intersect; an empty allow list allows everything not denied; `fetch-post` is closed.
- The library declares rules in `access.json`, locked or delegated per list or per rule. Policy sits above it. The caseworker can always add denies and can narrow a locked allow list. They can widen only a delegated one.
- Flow files carry no rules and can't widen anything.
- Patterns are written like profile patterns, but read as URLs in their parts, with Firefox match-pattern host rules.
- Checks happen at the moment of acting, in the sidebar, the background and the page. The rules guard against mistaken and poisoned flows, not against the caseworker.

## What's open

- Whether values clipped from a page that is now blocked may still be filled into a form.
- Whether a delegated allow list should be widenable by the caseworker, or only narrowable, by default. As planned it's theirs to change; `lockLibraryRules` is the organisation's switch.
- What *Disconnect the library* looks like. There's no such control now.
- Whether `read` should be split, so that sending a page to the ✦ AI can be blocked while clipping it is allowed (a `send-to-ai` action).
- Whether failing closed on a policy deny pattern that doesn't parse is too strong, against ignoring just that pattern and warning.
- How `restricted_domains` in Firefox's `ExtensionSettings` policy interacts with `scripting.executeScript`. If it blocks injection, IT can use it as a second guard.
- Whether to show the approved-hosts layer in the Settings card (read-only, *From your library's approved systems*) so the caseworker sees why an allowed site still doesn't work.
