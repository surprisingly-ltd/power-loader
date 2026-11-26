# JSON clips: reading JSON responses as clips

Created: 2026-11-25. Status: phase 1 built (2026-11-25); phases 2 and 3 not started. Builds on `fetch-steps.md` (JSON mostly arrives as a fetch step's response) and `site-access-lists.md` (every request and every read goes through `allowed()`). Uses the profile and draft model of `library-and-profiles.md` and `flow-authoring.md`.

**What's built (phase 1).** `lib/json-dom.js` (the strict iterative parser, the synthetic document, the limits, prefixes and encodings, `jsonContentType()`, `jsonKeySelector()`, `selectorFor()`, `pathOf()`, `selectorToPath()`, `jsonQuote()`, `probeJson()`, `dataLikeKey()`, `jsonValues()` and the tree picker's `pickFor()`). `format` in `validateProfile()` (the one change to `lib/extract.js`), `exportBody()`, `diffDraft()` and the library; `pageProfiles()` never offers a JSON profile for a tab. `FORMATS.json` in `lib/fetch-steps.js` with the `Accept` header, the Content-Type rows, refusals in words and the log codes; `judgeDocument()`, `responseValues()` and `keyIsPersonal()` for the test and the leak check. JSON clips carry quotes and `format: 'json'` (display only), shown in the sidebar's clip view and the full case page. Authoring: `bindJsonPage()` in `lib/flows.js`, rows picks (`addRowField()`, `removeRowField()`, `rowPicksOf()` in `lib/drafts.js`), the tree view `sidebar/json-tree.js` and the data editor in `sidebar/flows.js` (*Fetch a sample*, *Test on the sample*, *Try another record*), and *Reads data (JSON)* in the request preview. Tests: `tests/js/json-dom.test.js`, `json-conformance.test.js` with `fixtures/json-cases.json`, `fetch-json.test.js`, `json-authoring.test.js` and `json-sidebar.test.js`.

**Settled in building phase 1**, taking the recommended defaults of the open questions below:

- No path sugar, no value tests in `when` (existence only), no new filters, no embedded JSON: phase 3, as planned.
- `text/plain` JSON is refused: profiles have no `contentTypes`. Bearer-token APIs stay out of scope.
- The data-like key rule is built in, with no library setting: three or more digits, `detect()` with the library's privacy patterns, or three or more siblings whose values have the same shape (objects with the same keys, arrays, or scalars of the same type and character shape, so an ordinary record of names isn't a map).
- Records keep no row path, and fetched JSON values are added as fetched pages' are, with the identity check and no review first.
- A repeated key is read (the first, as `querySelector` finds it) and flagged: *This response has a repeated key: check the profile* on the step card, and `duplicate key` in the log.
- A number whose plain form would be over 100 characters (`1e400`) is refused under the number limit. `true`, `false` and `null` aren't leak-check values: they're words of the format.
- An HTML profile given JSON keeps the existing *This isn't a page Power Loader can read*.
- The sample is dropped when its page's editor closes; it isn't tied to a case.
- `fixtures/json-cases.json` isn't in `fixtures/reference-hashes.json` yet: its hash goes in once the cases are reviewed.

**Deferred:** JSON tabs (phase 2, once the Firefox suite picks a route); ✦ suggestions from `jsonSkeleton()` through `previewBeforeSend()`, *Suggest from keys* and `pathToSelector()` (phase 2, so the AI gets nothing from a JSON page yet); path display on the library's review screen (phase 2); demo JSON endpoints for the Firefox suite.

## Why

In the user's words: "Typically a user wouldn't ever view JSON, but if we want to be able to fetch other URLs and extract stuff from them we should make that possible, and we want to treat it as a clip as close as possible to an HTML clip."

Many casework systems build their pages in the browser from their own API. The HTML a fetch step gets back is then an empty shell (`fetch-steps.md`, *Test as fetched*: "This page is built after it loads, so it can't be fetched"). The data is in the API's JSON response, at an address the author can find in the browser's network panel. A fetch step that requests that address and reads the JSON gets the same evidence, faster, without a background tab. `fetch-steps.md` lists it as open: "Whether pages that load their data as JSON should be readable, with a JSON form of the profile DSL." This plan answers it.

The aim is that **a JSON clip is an HTML clip**: a page profile reads it, it passes the same tests and leak check, and `addClip()` sees a clip of the same shape. Nothing downstream of `addClip()` knows the evidence was JSON.

## How JSON reaches extraction

### The approaches

| | (a) Synthetic DOM | (b) A JSON path locator in the DSL | (b′) Reuse the fill side's paths |
|---|---|---|---|
| What it is | Turn the JSON into a detached document (objects and arrays as elements, keys as attributes) and run the existing engine on it | A new locator kind, such as `$.client.dateOfBirth`, evaluated on parsed objects | Use `resolvePath()` from `lib/extract.js`, which already reads dotted paths (`Person.address.postalCode`, `[0]`, `[propertyID=NI number]`) over records for fill profiles |
| `extract()`, filters, lists, `$scope`, `@attr` | Unchanged | Every evaluation path gains a second branch: `evalExpr`, `evalList`, `evalObject`, `$scope` and `@attr` each need a JSON meaning | Lists and `$scope` aren't path-aware; would need the same branches as (b) |
| `probe()`, `profileApplies()` (`when`), `locate()` | Unchanged | New versions for paths | New versions |
| `judgeTest()`, `literalLeaks()`, `recordTest()` (second record) | Unchanged | Unchanged | Unchanged |
| `fixtures/dsl-cases.json` | Stays frozen, byte for byte | Stays frozen, but `extract.js` changes in its core, so every HTML case is at risk | As (b) |
| Conformance | A new `fixtures/json-cases.json`: JSON in, the same `extract()` out | A new suite for the new locator, plus every interaction with filters and lists | As (b) |
| Profile readability | CSS: `:root > [key='client'] > [key='dob']`. Wordy, but the author never types it (*Authoring*) | `$.client.dob`. Short and familiar | `client.dob`. Short |
| Big integers, exact number text | Kept: the builder writes the number's source text | Lost if parsed with `JSON.parse` (`12345678901234567890` becomes `12345678901234567000`) unless a custom parser keeps it | As (b) |
| `__proto__`, `constructor` keys | Only ever attribute strings; no object is built from the response | Path lookups on parsed objects need `Object.hasOwn` everywhere. `getKey()` today reads `v[key]`, so `.constructor` returns `Object` | As (b), and `getKey()` must change |
| Duplicate keys | Visible: both members are elements, so a test that matches 2 fails | Hidden: `JSON.parse` keeps the last silently | As (b) |
| Risk to HTML extraction | None: `extract.js` isn't changed in phase 1 | Real: shared code changes | Real |

### Decided: (a), a synthetic DOM

The engine already reads any DOM, and I checked that it reads a synthetic one unchanged. With jsdom, an XML document built from the mapping below gave the expected values for `:root > [key='client'] > [key='name']`, `| lines` on a multi-line string, a list spec over an array with `:scope > [key='amount'] | number` and `@index`, a `$scope` object, a `null` (read as `null` with the usual *Matched an element but it has no value* warning), `probe()` (count 1) and `profileApplies()` with a `when`. A `__proto__` key read as plain text and `Object.prototype` was untouched.

So (a) reuses everything the user asked to keep: the DSL, `probe`, profiles, tests, the leak check and clips. It costs wordy selectors, which the tree view writes and the review screen shows back as paths (*Authoring*). A short path syntax can be added later as **sugar that compiles to the same CSS before evaluation** (open question), so the engine and its conformance stay CSS-only.

### The mapping

`lib/json-dom.js` (new, a classic script like `extract.js`, setting `globalThis.PowerLoaderJson`, so it runs in the sidebar, the agent and Node tests) exports `jsonToDocument(text, { documentSource, limits })`. It returns `{ doc, stats }` or throws a `JsonRefused` with a plain reason.

- The document is `documentSource.implementation.createDocument(null, null, null)`: an XML document with no browsing context. Nothing in it is rendered, runs or loads. Elements are made with `createElementNS(null, tag)` and text with `createTextNode()`. The response is **never** turned into markup and parsed, so a string like `<img onerror=…>` is only ever text.
- **The root element is the JSON's root value**, so `:root` is the top of the JSON.
- **Every JSON value is one element. Its tag is its type**, from a fixed set: `j-object`, `j-array`, `j-string`, `j-number`, `j-boolean`, `j-null`. A JSON key never becomes a tag name, so a key such as `input`, `script`, `br` or `select` can't trigger the engine's form-control, skip or line-break handling.
- **An object member** is its value's element with `key="<the key, exactly>"`. **An array item** has `index="<n>"`, counted from 0.
- **Scalars are text.** A string is its text, with each `\n` written as an empty `<br>` element, so `| lines` and `| oneline` work as they do for HTML block text. A number is its source text (`1234.50` stays `1234.50`, `12345678901234567890` stays exact). One in exponent form (`1.5e3`) is written out in plain decimal by string arithmetic (`1500`), because `| number` reads only the digits before the `e`. `true` and `false` are the words. `null` is an empty `j-null`.

```json
{ "client": { "name": "Jane Doe", "dob": "1986-07-14", "address": "Flat 3\n12 Mill Lane" },
  "payments": [{ "date": "2026-10-01", "amount": 412.5 }], "active": true, "notes": null }
```

becomes

```text
<j-object>                                          :root
  <j-object key="client">                           :root > [key='client']
    <j-string key="name">Jane Doe</j-string>
    <j-string key="dob">1986-07-14</j-string>
    <j-string key="address">Flat 3<br/>12 Mill Lane</j-string>
  <j-array key="payments">
    <j-object index="0">                            :root > [key='payments'] > [index='0']
      <j-string key="date">2026-10-01</j-string>
      <j-number key="amount">412.5</j-number>
  <j-boolean key="active">true</j-boolean>
  <j-null key="notes"/>
```

### Selectors on JSON

The tree view (*Authoring*) writes them. The form is fixed so they're exact and stable:

- **Anchored child paths.** Top-level fields start at `:root` and use only `>`: `:root > [key='client'] > [key='dob']`. A descendant selector (`[key='dob']`) would pick up a `dob` nested anywhere, in document order, so the picker never writes one. In a row or a `$scope`, item fields start with `:scope >`: `:scope > [key='amount']`.
- **Keys are quoted CSS strings**, escaped by `jsonKeySelector(key)` (`'` and `\` escaped, newlines as `\a `). Attribute values are case-sensitive in an XML document, so `Name` and `name` are different keys, as in JSON.
- **Indexes are quoted**: `[index='0']`, because an unquoted `0` isn't a CSS identifier.
- **`@key` and `@index`** read the key or position itself, through the existing `@attr`.
- **`label()` works on values, not keys**, exactly as on HTML. For key/value-pair data (`[{ "name": "Status", "value": "Open" }]`), `label(Status)` finds the string `Status` and reads the next value. The tree view offers it only for that shape.
- `when` is a selector, as now: `:root > [key='clientId']` says "this response has a client ID". It checks that a key exists, never a value (*Open questions*).

### Edge cases

| Case | Rule |
|---|---|
| Root is an array | `:root > *` is each item. A list spec `[":root > *", { … }]` reads rows. |
| Root is a scalar | `:root` reads it. |
| Arrays of scalars | `[":root > [key='tags'] > *"]` reads a list of strings. As for HTML, `clipFromExtract()` keeps only object rows as records, so a top-level list of strings goes to `extra`. |
| Nested arrays | `[[1, 2], [3, 4]]`: rows `:root > *`, items `:scope > [index='0']`. A list inside a row is a nested list spec, as in HTML. |
| Objects keyed by data (`{ "P-1042": {…}, "P-1043": {…} }`) | Read as rows: `[":root > [key='payments'] > *", { "id": "@key", … }]`. The picker never writes such a key into a selector, and the leak check treats data-like keys as values (*The leak check*). |
| A key that isn't a valid name (`first name`, `a.b`, `é`, `""`, `0`) | Fine: keys are attribute values. `[key='first name']`, `[key='']`. |
| A key with control characters or NUL | CSS can't express NUL (`\0` becomes U+FFFD). The tree view shows the key and says *Power Loader can't read this key*. |
| Duplicate keys in one object | Both kept, in order. A selector then matches 2 and the test fails (*Matches 2 elements, not one*). At extraction `querySelector` takes the first, while `JSON.parse` would take the last, so the builder adds a diagnostic `Duplicate key "x"` (the key's position, never a value) and the step card shows *This response has a repeated key: check the profile*. |
| Keys that look alike (`Name` and `name`; `café` in NFC and NFD; `name` and `name `) | Different keys, kept exactly. The tree view marks a sibling that differs only by case, Unicode form or spaces: *Two keys look the same here*. |
| `null` | An empty `j-null`: reads `null` with a warning, like an empty element. A required field that's `null` fails its test with *Reads nothing*. |
| `true` / `false` | Text `true` / `false`. `| bool` gives a boolean. Without `| bool`, a yes/no field's validator decides. |
| Numbers versus strings | Both are text, so `| number`, `| int` and the field validators work as for HTML. The tag says which it was, and the quote shows it (`412.5` versus `"412.50"`). An ID sent as a number by one system and padded text by another (`71042` versus `0071042`) differs as text: the identity check treats it as a mismatch, as it would for two HTML pages. |
| Dates | ISO strings work with `| date`, which takes the written date (`1986-07-14T00:00:00Z` is `1986-07-14`). A system that writes local midnight in UTC (`1986-07-13T23:00:00Z` for 14 July in summer time) is a day out, and epoch milliseconds don't parse. Both need new filters (*Open questions*). |
| Very large documents | Refused, never truncated, because a cut-off response would silently miss evidence (*Limits*). |
| Empty strings, whitespace | `""` reads `null`. Spaces are collapsed and trimmed, as for HTML text. The quote keeps the raw value. |
| Lone surrogates (`"\ud800"`) | Replaced with U+FFFD, as `TextDecoder` does for bytes. |

### Lists, records and timeline groups

They map one to one, because `clipFromExtract()` only sees the extracted data:

- A list spec over an array, `["…> [key='payments'] > *", { "@type": "Payment", "date": ":scope > [key='date'] | date", "amount": ":scope > [key='amount'] | number" }]`, makes rows. Top-level rows become records with `group` set to the field key and ids `payments-1`, `payments-2`, as now. Empty rows are dropped as now.
- **Timeline series** read records by `{ profile, group: 'tl_…' }` (`lib/journey.js`). A JSON profile with a `tl_employment` list of `{ "@type": "period", "start": …, "end": …, "cat": "=Employment", "label": … }` rows feeds the timeline exactly as an HTML one does.
- `$scope` narrows to an object: `{ "$scope": ":root > [key='tenancy']", "start": ":scope > [key='start'] | date" }`.

### Does `fixtures/dsl-cases.json` stay frozen?

**Yes, byte for byte**, with its hash in `fixtures/reference-hashes.json` unchanged. Phase 1 changes nothing in `extract()`, `probe()` or the filters. JSON gets its own conformance file, `fixtures/json-cases.json`: `{ name, json, url, fields, expected }`, where `json` is the raw response text as a string, so prefixes, duplicate keys, big numbers and bad encodings can be written. `tests/js/conformance.test.js` gains a loop that runs `jsonToDocument()` then the same `extract()`. Once reviewed, its hash goes in `reference-hashes.json` and it's frozen by the same rule (`CONTRIBUTING.md`). Any new filter (*Open questions*) gets cases in a new file, never in `dsl-cases.json`.

The one change to `lib/extract.js` is in `validateProfile()`: it accepts `format` (*The profile*). That's validation, not evaluation, and `dsl-cases.json` doesn't cover it.

## Where JSON comes from

| Source | In scope | How |
|---|---|---|
| A fetch step's response | **Yes, phase 1.** The main case. | The runner in `fetch-steps.md`, with a profile of `format: 'json'` |
| A JSON address the caseworker opens in a tab | Phase 2 | The agent reads the raw text (below) |
| The API responses a page makes for itself | **No** | See below |
| JSON embedded in an HTML page (`<script type="application/json">`, `__NEXT_DATA__`) | Later, open | Today `script#data | json` parses it into one object, which `clipFromExtract()` keeps as `extra`. A `$json` scope could build a synthetic DOM from it. |

### A fetch step's response

The runner is `fetch-steps.md`'s (*What a run does*), with these changes when the request's page profile has `format: 'json'`:

1. The address check is unchanged: `allowed(url, 'fetch-get')` across every layer of `site-access-lists.md`, the host fixed in the template, the filled address matching the profile's `match`. A JSON request is a `fetch-get` like any other. There's no separate JSON action.
2. The request sends one fixed header, `Accept: application/json`. It isn't templated and nothing else is added. Many APIs answer `406` or send HTML without it.
3. Redirects fail, 401 and 403 are *sign in again*, and a 20-second timeout applies, as for HTML. A response with `application/problem+json`, or a non-2xx status, is an error: *The system returned an error (404)*. Its body is never read for values.
4. The Content-Type must be JSON (*Content types*). A JSON profile given HTML, or an HTML profile given JSON, is refused: *Client details sent a page, not data: check the address*.
5. The body is read as bytes with a cap (*Limits*), decoded (*Encodings*), stripped of a known prefix (*Prefixes*), then parsed by `jsonToDocument()`.
6. **Parsing happens in the extension, never in the page.** With way C (`executeScript({ world: 'MAIN' })`), the page-world function returns only the status, the Content-Type and the body text. The text is parsed in the sidebar's or the agent's own context, where page scripts can't reach the document.
7. Then `profileApplies(profile, url, doc)`, `extract(doc, profile, { baseUrl: url })`, quotes (*Clip parity*), `clipFromExtract()` and `addClip()` inside `updateCase()`, exactly as for HTML.

**Same origin, phase 1.** `fetch-steps.md` phase 1 fetches only from the trigger page's origin. Many systems call their API on the same origin (`/api/clients/1042`), so phase 1 is useful. An API on another host (`api.cm.example.gov.uk`) waits for `fetch-steps.md` phase 2 (way A), if the Firefox suite shows it gets the session.

**Sessions, not tokens.** Requests carry the page's cookies and nothing else. An API that needs a bearer token the page keeps in `localStorage` can't be read: Power Loader doesn't read or send a page's credentials. The editor says so when *Test as fetched* gets a 401 that the HTML page didn't (*This system's data needs a sign-in token Power Loader doesn't use*).

### A JSON address opened in a tab

Rare, as the user says, but it's how an author first looks at an API, and a caseworker may follow a link to one. Firefox shows JSON with its built-in viewer (`devtools.jsonview.enabled`, on by default; a managed install may turn it off). The agent needs the raw text, and I haven't checked what an extension's content script sees there in Firefox 140 ESR. The candidates, for the Firefox suite to decide:

| Route | What it relies on | Concern |
|---|---|---|
| 1. `document.contentType` is a JSON type, and with the viewer off, the raw text is the page's only `<pre>` | Firefox's plain-text rendering | Only works with the viewer off |
| 2. The viewer's *Raw Data* panel, or its data object through `wrappedJSObject` | The viewer's internals | Undocumented; can change in any release; reaches into a page object |
| 3. The agent re-requests `location.href` from the tab, as fetch way B, with `cache: 'force-cache'` | The browser cache, the tab's session | A second request to the system. Checked as `read` for the open page and `fetch-get` for the request. |

Route 3 is the likely choice: it doesn't depend on the viewer, and it reuses phase 1's code. Whatever the route, the agent tells the sidebar the tab is JSON (`info.kind = 'json'` in `refreshPage()`), only profiles with `format: 'json'` are tried, and clipping goes through `clipTab()` and choke point 4 of `site-access-lists.md`. Auto-clip works on a JSON tab as on any page, with `autoClipDelay` ignored (the response is complete when it loads).

### The page's own API responses

**Out of scope.** Reading them means `webRequest.filterResponseData()` with the `webRequest` and `webRequestBlocking` permissions and host access. That is:

- a new, heavy permission for AMO review, and one that reads every response a page gets, not just the ones a profile names;
- against `site-access-lists.md`, which says Power Loader doesn't use `webRequest` and shouldn't;
- timing-dependent, which is the problem the auto-clip delay (`autoClipDelay`, `flow-authoring.md`) already works around for pages that render their API data into HTML.

Patching the page's `fetch` or `XMLHttpRequest` from the page world is ruled out for the same reasons, and because page scripts could see and change it. Where the data matters, the author makes a fetch step that requests the same API address directly. That's explicit, listed in the request preview, checked by the site rules and logged.

### Content types

| Content-Type (parameters ignored except `charset`) | Verdict |
|---|---|
| `application/json` | Accepted |
| `application/*+json` (`hal+json`, `vnd.api+json`, `ld+json`) | Accepted |
| `application/problem+json` | An error response: *The system returned an error*. The body isn't read. |
| `text/json` | Accepted (legacy) |
| `text/javascript`, `application/javascript` | Refused: JSONP is code, and Power Loader never runs it. *This is a script, not data.* |
| `text/plain`, `text/html`, `application/octet-stream`, none | Refused for a JSON profile, with no sniffing. Some old systems send JSON as `text/plain`; whether a profile may say so is open. |

Content-Type decides; the body is never sniffed to pick HTML or JSON. That keeps a response from being read by a profile its author didn't mean.

### Prefixes

Some systems put an XSSI guard before the JSON so a `<script>` tag can't run it. After an optional BOM and whitespace, exactly one of these is removed if the body starts with it, and nothing else is:

| Prefix | Used by |
|---|---|
| `)]}'` then a newline, or `)]}',` then a newline | Angular, Google APIs |
| `while(1);` | Some older frameworks |
| `for(;;);` | Some older frameworks |
| `{}&&` | Some older frameworks |

A body that starts with anything else that isn't JSON is refused: *This isn't data Power Loader can read*. `callback({…})` JSONP is never unwrapped. There's no eval, no `Function` and no `JSON.parse` reviver anywhere.

### Encodings

- The body is read with `response.arrayBuffer()` (counting bytes as they arrive, *Limits*) and decoded with `TextDecoder(label, { fatal: true })`.
- The label is UTF-8 (RFC 8259), unless the response names a `charset` that `TextDecoder` knows. A BOM overrides both, as in the Encoding standard. UTF-16 and UTF-32 without a BOM aren't guessed.
- Bytes that don't decode are refused: *The data isn't in a text encoding Power Loader can read*. Nothing is replaced silently, because a mis-decoded name would go into the case.

### Limits

Enforced while parsing, so a hostile or mistaken response fails fast. The parser is iterative, so depth can't overflow the stack.

| Limit | Value | Over it |
|---|---|---|
| Body | 2 MB, as for HTML (`fetch-steps.md`) | Refused before parsing; reading stops at the cap |
| Depth | 64 levels | Refused |
| Elements | 50 000 values | Refused |
| One string | 100 000 characters | Refused |
| One key | 1 000 characters | Refused |
| One number | 100 characters | Refused |
| Members of one object | 10 000 | Refused |

The message names the limit and suggests a narrower address: *Payment history is too large to read (over 50 000 values). Ask for less, for example a date range in the address.* A partial read is never kept.

## The profile

### Saying that it reads JSON

```json
{ "schema": "powerloader-profile/1", "id": "cm/client-api", "kind": "extract", "format": "json",
  "name": "Client details (data)", "version": "v1",
  "match": ["https://cm.example.gov.uk/api/clients/*"],
  "urlPattern": "https://cm.example.gov.uk/api/clients/{clientId}",
  "when": ":root > [key='clientId']",
  "fields": {
    "clientId": ":root > [key='clientId']",
    "dob": ":root > [key='person'] > [key='dateOfBirth'] | date",
    "payments": [":root > [key='payments'] > *", { "date": ":scope > [key='paidOn'] | date", "amount": ":scope > [key='amount'] | number" }]
  } }
```

- **`format: 'html' | 'json'`**, default `html`. Not a new `kind`: `kind` says what a profile is for (`extract`, `fill`, `map`, `casetype`), and a JSON profile is still for extracting. `validateProfile()` checks `format` is one of the two. `validateLibraryProfile()` in `lib/library.js` and the export body (`exportBody()`) carry it. `diffDraft()` reports a change of format as a metadata change.
- **Not a content type in `match`.** `match` stays URL patterns, so the site rules' reading of patterns, `accessIssues()` and `fetchTemplateErrors()` all apply unchanged. Content type is checked by the runner against `format`.
- **`autoClip`** works as for HTML on a JSON tab. In a fetch step it's irrelevant: the step decides when to fetch.
- `kind: 'fill'` profiles are unaffected. Nothing fills JSON.

### Matching a profile to a JSON response

- **In a fetch step**, by construction, as for HTML: the request names its page, the page's profile has `format: 'json'`, and the filled address must match its `match`. Then `when` is checked on the synthetic document.
- **On a JSON tab**, `profilesForTab()` offers only `format: 'json'` profiles, by `match` and `when`, as for HTML pages. An HTML page never matches a JSON profile and a JSON tab never matches an HTML one.
- **`when`** is an existence check on the synthetic document, so it tells two responses from the same address apart by their keys (`:root > [key='tenancy']`). It can't test a value in phase 1 (*Open questions*).

## Clip parity with HTML

### The clip

`clipFromExtract(lib, profile, { data, url, title }, { kind, quotes })` is used as it is. The clip is:

```text
{ source: `${profile.id}|${url}`, kind: 'fetch' (from a fetch step) | 'page' (a JSON tab), profile, name, url,
  title, capturedAt, values, records, extra, quotes, via?: { stepId, requestId }, format: 'json' }
```

- `source` is the same rule as HTML, so fetching again, or clipping the same address in a tab, replaces the clip.
- `title` is the profile's name: JSON has no `<title>`. The clip list shows *Client details (data) · fetched by Start case*.
- `format: 'json'` is for display only (*Data from {host}* rather than *Page*). `addClip()`, `fieldState()`, `removeClip()` and the fill plan never read it.

### Quotes: a path and the value as sent

Page clips carry no per-value quotes today; the reader's and the ✦ AI's do (`clip.quotes`, shown by `extension/case/case.js`). JSON clips carry them from the first version, because a caseworker never sees the response and the quote is the only way to check a value against it.

- **A quote is the value's path and its raw JSON text:** `.person.dateOfBirth: "1986-07-14"`, `.payments[2].amount: 412.50`, `.["first name"]: "Jane"`. The path is jq-style: `.key` for name-like keys, `.["key"]` (JSON-escaped) otherwise, `[n]` for indexes. The value is the JSON text as received (strings in quotes, numbers as their source text, `true`, `false`), cut at 200 characters with `…`.
- **How it's found.** For each top-level field, `jsonQuote(doc, spec)` in `lib/json-dom.js` takes the locator before the pipes (`splitPipes()`), finds the element with the exported `locate()` and builds the path from the `key` and `index` attributes up to `:root`. No engine change.
- **Shown** as the reader's quotes are: under the value in the full case page's Sources view and matrix (`extension/case/case.js`, which already renders `cl.quotes[k]`), and in the value's detail in the sidebar. The quote shows the value before normalisation, so `412.50` against a displayed `£412.50` is visible, and so is `"1986-07-13T23:00:00Z"` against `13 Jul 1986`.
- **Rows.** Records get no per-field quotes in phase 1, as HTML rows get none. Each record could keep its row's path (`.payments[2]`) later.
- Quotes hold page values, so they live only in the case, like `values`, and go when the case ends.

Adding quotes to HTML page clips the same way (the matched element's text) is the separate change `fetch-steps.md` mentions. JSON doesn't depend on it.

### Downstream of `addClip()`: no special cases

| Behaviour | For a JSON clip |
|---|---|
| Identity check | Unchanged: `addClip()` compares `values` after `validateValue()` and `norm()`. Values are text read through the same filters, so the comparison is the same. |
| Conflicts and choices | Unchanged: `fieldState()` sees candidates by normalised value |
| Re-clipping | Same `source`, so it replaces and keeps exclusions unless the value changed, as now |
| Removal, *Wrong person* | `removeClip()` and `clipDependents()` unchanged |
| Teardown | `CASE_ENDED` aborts a run and `updateCase()` drops a late result (`fetch-steps.md`). The synthetic document and raw text are never stored: they're dropped when the read finishes. |
| Fill plan, timeline, calculator, export | Read `values` and `records` only |
| *Open the page* | Opens the address in a tab after a `navigate` check. Firefox shows its JSON viewer. |

## Authoring

The author can't click on JSON in a page, so the sidebar gives them a **tree view** of a sample response. It's the picker for JSON, and it writes picks into the same draft (`lib/drafts.js`), so tests, the second record, the leak check and export are shared.

### Getting a sample

- **In a fetch step**, from *Add a request* (`fetch-steps.md`, *Authoring*), the author chooses **The response is data (JSON)** and pastes the API address (from the browser's network panel), or **Use the current tab** on a JSON tab (phase 2). Power Loader suggests `match` and `urlPattern` with `suggestPatterns()` and sets `format: 'json'`.
- **Fetch a sample** asks for a value for each `{name}` in the address, kept in memory only (`flowUi`), never saved or exported, as *Test as fetched* does. It fetches exactly as a case would, through every check, and builds the synthetic document. A failure shows the same reasons as a run (*sign in again*, *not data*, *too large*).
- The sample lives in memory for the editor session. It's dropped when the editor closes, the tab's case ends or another sample is fetched.

### The tree view

`sidebar/json-tree.js` (new) renders the synthetic document with `h()` and `textContent` only, never markup:

- Objects and arrays fold. Each row shows the key (quoted if it isn't name-like), the type and, for scalars, the value cut at 120 characters. Arrays show their length and the first 20 items, with *Show more*.
- **Clicking a scalar** picks it: `togglePick(d, selector, guessKey(lib, humanise(key)))`, where the selector is the anchored path and `humanise()` turns `dateOfBirth` and `date_of_birth` into *date of birth*. The pick shows in the draft's list with its path (`.person.dateOfBirth`), not the CSS.
- **Clicking a value inside an array of objects** asks *Every payment, or just this one?*. *Every* makes a rows pick: a list spec over the array with the clicked key as an item field, and further clicks inside the same array add item fields. *Just this one* writes `[index='n']` and warns *Picks item 3 by position: check it's the right one on another record.* Picks today only cover string specs (`picksOf()`), so rows picks are new in `drafts.js`, and HTML can use them later.
- An object or array can't be picked as a value: *Pick a value inside it*. `probeJson()` adds that error for any field whose matched element is `j-object` or `j-array`, before `judgeTest()`, which is unchanged.
- Data-like keys (*The leak check*) and look-alike keys are marked. A key Power Loader can't select is shown greyed with the reason.

### Testing

- **Test on the sample.** `probe()` on the synthetic document for each field, then `judgeTest()` with `pageValues` from `jsonValues(doc)`: every scalar's text up to 200 characters, plus data-like keys. Each field must match exactly one element and pass its validator, as on HTML.
- **Test as fetched** is the same test here, because the sample is already fetched as a case would fetch it. `recordTest()` keeps `tested.fetched` as `fetch-steps.md` says.
- **A second record.** *Try another record* fetches with new sample values. `recordTest()` already keeps it as `d.second` when the address differs and the profile hasn't changed. A field that's `null` on one record and set on another shows *Empty on this record*. That's a warning on the second record, not a failure, if it passed on the first.

### The leak check

`literalLeaks()` is unchanged. What changes is what it's given:

- **Values**: every scalar in the sample, not just the values the profile read, as `pageValues()` gives every candidate's text on an HTML page.
- **Data-like keys**: a key is treated as a value if `detect()` in `lib/privacy-detect.js` finds personal data in it (a NINO, an email, a date, a known case value), or it has an identifier's shape (three or more digits; stricter than `idLike()` in `drafts.js`, which any digit satisfies, so `address2` stays structure), or it's one of three or more sibling keys whose values all have the same shape (an object used as a map). The picker never writes such a key, and the check catches it if a hand-edited profile does.
- Ordinary keys (`dateOfBirth`, `address2`) are structure, like HTML labels and class names, and are allowed in selectors.

The export checks (`exportChecks()`) are unchanged: *No page or case values anywhere in the file*.

### ✦ AI profile suggestions

The AI gets the response's **structure, never its values**.

- `jsonSkeleton(doc, { maxItems: 3 })` writes the structure as indented text: every key, and for each scalar a placeholder of its type and shape. Strings become `‹text, 9 chars›`, `‹date YYYY-MM-DD›`, `‹datetime›`, `‹email›`, `‹postcode›`, `‹digits, 8›` or `‹url /clients/{id}›` (with `pathShape()` from `lib/ai/snapshot.js`). Numbers become `‹number›` or `‹integer›`, booleans `‹boolean›` (a flag such as `hasConviction: true` can be personal), and `null` stays `null`. Arrays show their first 3 items and `(+47 more)`.
- Data-like keys become placeholders too (`‹key: identifier›`). The skeleton then goes through `previewBeforeSend()` as a `kind: 'text'` part, *Response structure*. `detect()` scans it like any part, so a personal key that slipped through is redacted and shown, and nothing is sent without the preview and **Send**.
- The prompt (`extension/prompts/profile.md`, a JSON section) asks for **paths**, in the quote's jq-style form, per case field, and for rows as an array path plus item paths. `pathToSelector()` turns them into anchored selectors on this computer. The AI never writes CSS for JSON, and a path the sample doesn't have is refused locally.
- The suggestion is then tested on the real sample locally, as every ✦ profile is (`lib/ai/checks.js` `review()`). Whatever the AI says, a field must pass the same test.
- Without AI, **Suggest from keys** matches keys to case fields by `guessKey()` on humanised keys and the library's synonyms, on this computer (`local-profile-assist.md`).

### Review and export

The export file is an ordinary profile with `format: 'json'`. The library's review screen shows each JSON selector as its path (`selectorToPath()`, for selectors in the anchored form), with the CSS beside it, so a maintainer reads `.person.dateOfBirth`. The request preview in `fetch-steps.md` says *Reads data (JSON)*.

## Security and privacy

| Risk | Mitigation |
|---|---|
| JSON from a system that isn't approved | Every request is `allowed(url, 'fetch-get')` across every layer of `site-access-lists.md`, with approved hosts, the fixed host and the profile's `match`. Reading a JSON tab is `read`. There's no JSON-specific way round any of them. |
| Code in the response | No eval, no `Function`, no `JSON.parse` reviver, no JSONP unwrapping. Text is only ever text nodes and attribute values in a document with no browsing context. |
| Prototype pollution (`__proto__`, `constructor`, `prototype` keys) | No JavaScript object is built from the response. Keys are attribute strings. `jsonSkeleton()` and the tree view walk the DOM. Anything that must hold keys uses a `Map`. Tests assert `Object.prototype` is untouched after parsing a hostile sample. |
| Depth or size bombs | The limits table, enforced while parsing, with an iterative parser |
| Lax parsing reading the wrong thing | Strict RFC 8259: no comments, trailing commas, single quotes, `NaN` or `Infinity`. Malformed input is refused, not guessed. |
| Page scripts changing the response (way C) | Parsing happens in the extension's context. The page-world function returns only text and two headers. The response is evidence, checked like any clip, with the identity check. |
| A response about someone else | Addresses filled only from the case's settled values (`fetch-steps.md`), and the identity check on every clip |
| Personal data to the AI | Only the skeleton, through `previewBeforeSend()` |
| Values in a profile | The leak check with every scalar and data-like key |
| Credentials | Cookies only, as the page would send them. Power Loader never reads or sends a page's tokens. |

### Activity logging, without values

- `fetch_page` as in `fetch-steps.md`, with `detail` gaining `json`: the step's and request's names, the item count, or the failure: *not data*, *script*, *bad prefix*, *encoding*, *too large*, *too deep*, *duplicate key*, *error 404*. Never a key, a path, a value or the filled address.
- `clip_page` for a JSON tab, as for any page, with `page_type` `${profile.id}@${version}`.
- `recordFailure('json-<reason>')` counts refusals for *Copy diagnostics*. Diagnostics give counts and limits hit, never content.

### AMO review

No new permissions: no `webRequest`. The reviewer paragraph in `fetch-steps.md` gains: *Some requests return data (JSON) instead of a page. Power Loader reads it as text with its own parser, never runs it, and reads it with the library's profiles like a page.*

## Phasing

1. **JSON in fetch steps**, with `fetch-steps.md` phase 1 (GET, same origin, button only). `lib/json-dom.js` (parser, mapping, limits, prefixes, encodings, `jsonQuote()`, `jsonValues()`), `format` in `validateProfile()` and the library, the runner's JSON branch and `Accept` header, quotes on JSON clips, the tree view with *Fetch a sample*, single-value and rows picks, the second record, the data-like key leak rule, `json-cases.json`, logging. Without this, `fetch-steps.md` can't read systems that build pages from an API.
2. **Comfort.** JSON tabs, once the Firefox suite picks a route. ✦ suggestions from the skeleton, and *Suggest from keys*. Path display on the library's review screen. Other origins with `fetch-steps.md` way A.
3. **Later, if needed.** Path sugar in profiles. Value tests in `when`. New filters for epoch dates, UTC-to-local dates and pence. Embedded JSON in HTML pages. `text/plain` JSON for systems that need it.

## Tests

Offline (`tests/js`, jsdom), with fictional samples under `fixtures/json/`:

- `json-dom.test.js`: the mapping for every edge-case row above. The parser is strict (trailing commas, comments, `NaN` and single quotes are refused). Big integers and decimals keep their text. Exponents are written out. Duplicate and look-alike keys. `__proto__`, `constructor` and `prototype` keys are readable and `Object.prototype` is unchanged. Every limit, just under and just over. Each prefix is stripped, and `callback(…)` is refused. Encodings: UTF-8, a BOM, a named Latin-1 charset, and bad bytes refused. Keys with spaces, quotes, backslashes, newlines and NUL go through `jsonKeySelector()`. `jsonQuote()` paths.
- `fixtures/json-cases.json` in `conformance.test.js`: scalars, nested objects, root arrays, rows, nested lists, `$scope`, `@key`, `@index`, `label()` on key/value pairs, `when`, filters on numbers and booleans, and multi-line strings with `| lines`. `dsl-cases.json` and its hash are checked unchanged.
- `drafts.test.js`: `judgeTest()` with `jsonValues()`. A data-like key in a selector is a leak; `address2` isn't. Rows picks build list specs. An object picked as a value fails.
- `case.test.js`: a JSON clip through `addClip()` gives the same summary, conflicts and identity warnings as the same values from an HTML clip, and re-fetching replaces it.
- The runner, with a fake page `fetch`: each Content-Type row, `problem+json`, the `Accept` header, the byte cap stopping the read, a refusal never making a clip, and logging with no keys, paths or values.
- `ai.test.js`: `jsonSkeleton()` of a sample contains none of its scalar values or data-like keys, and goes through `previewBeforeSend()`. `pathToSelector()` refuses a path the sample doesn't have.

Firefox (`tests/firefox`), against new demo endpoints that need the demo session cookie:

- A fetch step that reads a JSON endpoint from the trigger tab gets the session. Without it, *sign in again*.
- An endpoint that answers `text/html` to a JSON profile is refused, and one behind a `)]}'` prefix is read.
- A JSON address opened in a tab, with the viewer on and off: which route reads the raw text (phase 2).

## What's decided

- JSON is read through a **synthetic DOM** (approach a): an XML document with no browsing context, values as typed elements, keys and indexes as attributes. `extract()`, `probe()`, `profileApplies()`, the filters and the tests are unchanged.
- `fixtures/dsl-cases.json` stays frozen. JSON gets its own conformance file, frozen once reviewed.
- Selectors are anchored child paths that the tree view writes and the review screen shows as paths.
- A profile says `format: 'json'`. Content type is checked against it, never sniffed and never put in `match`.
- JSON arrives through fetch steps first, through every site-rule check, as `fetch-get`. The page's own API traffic and `webRequest` are out of scope.
- JSON clips are page clips with quotes (path and raw value). Nothing downstream of `addClip()` changes.
- The AI sees the structure with placeholders, through `previewBeforeSend()`, and answers in paths.
- A strict parser of our own: no eval, no objects from the response, limits while parsing, refusal rather than truncation.

## Open questions

- Whether to add path sugar (`json(.person.dateOfBirth)`, compiled to the anchored CSS before evaluation) so hand-written profiles are readable. It would need its own conformance cases.
- Whether `when` should test a value for discriminators (`"type": "client"`), and how the leak check would allow enum values such as `client` while still catching personal values.
- New filters: epoch milliseconds (`date:epoch`), UTC to UK local date (`date:local`), pence to pounds. Each changes the DSL and needs new fixture cases, not edits to `dsl-cases.json`.
- Which route reads a JSON tab's raw text in Firefox 140 ESR (*A JSON address opened in a tab*). The Firefox suite answers this.
- Whether a profile may accept JSON served as `text/plain`, and how it would say so (`contentTypes`).
- Whether APIs that need a bearer token should ever be readable, or always stay out of scope.
- Whether the data-like key heuristic needs a library setting, for systems whose ordinary keys contain digits.
- Whether the record for each row should keep its path (`.payments[2]`) as provenance in the Sources view.
- Whether fetched JSON values should be reviewed before they're added, as `fetch-steps.md` asks for fetched pages generally. The caseworker sees JSON even less than a fetched page.
- Whether embedded JSON in HTML pages (`$json` scope) is worth doing, or `| json` into `extra` is enough.
