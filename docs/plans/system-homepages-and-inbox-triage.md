# Demo systems: a homepage for each, and triaging the team inbox

Created: 2026-11-26. Status: built 2026-11-26 (steps 1 to 7, with D1 to D10 as recommended), with the owner's
additions recorded where they belong: the staff intranet procedure (section 1), the email to the client, the
instructions for every step and the library's flows (section 5). Not yet published: that waits for a hand check
in Firefox. Checked against the code on 2026-11-26 (the generator, `lib/fetch-steps.js`, `lib/journey.js`,
`lib/flows.js`, `lib/case.js`).

**Where the build differs from the text below.** A choose step stores the next page's address template in
steps.json (`choose: { label, next, url }`), so `validateSteps()`, which has no profiles, can check it;
`refFromAddress(step, url)` takes it from there. "`{ref}` inside a segment" is read as `{ref}` run together with
letters or digits (`case{ref}`, `{ref}x`), since `case-{ref}.html` is allowed. A step's list request's row items
use `main` rather than `#message` (see *Found while building the profiles*). `fetchOnly` is a new profile key.
After *Change*, the same case page doesn't set the reference again until the tab moves on. Every client has
arrears and a tenancy reference, so those branches of the procedure have no training example.

Builds on the synthetic casework systems (`tools/build-demo-systems.mjs`, commit `4dd25ac`), the demo library's
casework profiles (`2c3796e`) and fetch steps phase 1 (`fetch-steps.md`).

## Why

The four synthetic systems work, but you can only reach them from the Case Manager work queue. In the messages
system, the *Inbox* link goes to `#`, and so do *Search*, *Recent*, *Tenancies* and *Help* in the others. A
visitor can't start at a system's front page as a caseworker would.

The demo also lacks the case that shows a fetch step at its best. A caseworker opens the team inbox and has to
open every message to find the **open urgent referrals**, because the list doesn't show which messages are
referrals, how urgent they are or whether anyone has picked them up. One press of **Fetch** opens every message
on the inbox page in parallel and reads each one. The caseworker then sees the urgent, open ones at once, in
the sidebar and marked on the page.

Starting a case is also awkward. Today the caseworker types a case reference before the case starts
(`sidebar/start.js`, *Case reference (optional)*), and nothing sets it after that. The rent support review
asks them to "type its case number, such as 1001", for a case they haven't chosen yet. A flow should start with
**go to the case list and choose a case**: the guide gives a link to the list, and Power Loader takes the case
reference from the case they open.

Four changes:

1. **A homepage for each system**, and no dead links in the headers. A flow doesn't have to visit every page:
   the homepages are there so the systems feel whole, and flows use only the pages they need.
2. **Urgent referrals and a team inbox** in Customer Messages.
3. **Taking the case reference from the case the caseworker opens**, an extension change.
4. **Fetching every link in a list**, the extension feature that makes the inbox demo possible. Today a fetch
   step can only fetch up to 6 addresses that are fixed when the flow is written.

The inbox triage also needs something the extension refuses today: a flow and a case with **no form to fill**
(D4, and *A case with no form* in section 4).

Then the library, the flows, the demo index, the site, the docs and the tests are updated to match.

Not in this change: attaching pictures and PDFs to messages and reading them with OCR. It's the next iteration,
and *Ready for attachments* says what this change does to prepare for it.

## Decisions for you before I start

These are my recommendations. Tell me where you'd rather go another way.

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | How many messages does the inbox fetch read? | **Every message on the current inbox page: 25.** | It's one page of a real inbox, and it's enough to make the point. Reading every page is a crawl, and a mistaken flow could hammer a real system that way. |
| D2 | The fixed caps (`FETCH_LIMITS`) | Keep **6 requests a step** for fixed requests. A list request gets its own cap of **25**. A step has **at most one list request**. Raise **at a time from 2 to 4** and **a case from 30 to 60 in 10 minutes**. Keep the other caps. | At 2 at a time, 25 pages take about 13 rounds and don't look parallel. 4 is still gentle on a casework system. 60 lets a caseworker run the inbox twice and still have a case's own fetches left; a third run inside 10 minutes is refused whole, as the cap works now (`planRun()`). One list a step keeps a step under the case cap, and `show` then has one set of rows to read. `how-it-works.html` and `REVIEWERS.md` state the caps, so they change too. |
| D3 | Where do triage results go? | **Rows (records) in the case, not case fields.** The step card then lists the matches, and each matching row in the inbox gets a marker. | Rows are never compared for identity or conflicts (`addClip()` checks only `clip.values`), so 25 messages from 25 different people don't set off 25 "different person" warnings. |
| D4 | What is the "case" for a triage? | An ordinary case with no reference. The sidebar labels it *Inbox triage, 26 Nov*. The **Inbox triage** flow has no form to fill. | Power Loader is built around cases: that's where the log, the teardown and the end-of-case purge live. A case-less mode would be a much bigger change. It isn't free, though: a flow and a case each need at least one form today, so this adds *A case with no form* (section 4). The cheaper alternative is to give the triage flow a small made-up form, a *triage record*, which needs no extension change but makes the demo fill a form nobody asked for. |
| D10 | When is the list of links read? | **When the step's card is shown on the inbox page**, so the button can say *Fetch 25 messages*. Nothing is fetched or kept until the button is pressed. | The count on the button is what tells the caseworker what a press will do. It does mean Power Loader reads the page's links on arrival, under the `read` check, as it already reads a page to recognise it. If you'd rather nothing is read before the press, the button says *Fetch the messages on this page* and the count comes after. |
| D8 | How the case reference is taken from the caseworker's choice | **From the address of the case page they open**, matched against the next step's address template (`cm/case-{ref}.html` gives `1042`). Power Loader doesn't listen for clicks in the page. | It works however the page was opened: a click, a middle-click to a new tab, the keyboard or a pasted address. It needs nothing new in the page and no click handler for AMO to review. The address is also what's logged and checked against the site rules anyway. |
| D9 | Once the reference is set, can a different case page change it? | **No.** On another case's page the sidebar says *This is case 1043, not this case (1042)*, offering *Finish this case first* and nothing else. *Change* is offered only until the first clip. | Switching the reference mid-case would leave earlier clips under the wrong case. |
| D5 | Markers on the inbox page | **Build them in this change.** If you'd rather keep it small, they can be a follow-up, and the step card alone shows the result. | The marked page is the demo's payoff, but it's the largest piece of new extension UI here (*In the page*). |
| D6 | The original hand-written demo pages (`client-1042.html`, `cases.html` and the rest, used by the DHP and referral flows) | **Leave them as they are**, listed on the demo index under "the first demo". | They have their own flows and tests. Folding them into the generated systems would change two flows for nothing the user sees. |
| D7 | The inbox as JSON (`messages/api/inbox-1.json`) | **Not now.** | One JSON response would answer the triage without opening any message, which defeats the point of the demo. The per-client JSON stays. |

## 1. A homepage for each system

Each system gets an `index.html` at its root, and each header's first nav item points to it. Every page is
static and generated from the same seed. The only script is still `assets/casework.js`, and the fictional-data
check (`fictionProblems()`) covers the new pages.

| System | Homepage | What it shows | Other new pages |
|---|---|---|---|
| Case Manager | `cm/index.html`, *Home* | My work: counts by status and by case type (worked out at build time), **Pick up the next case** (as on the queue, from `casework.js`), the 5 oldest cases not marked done, and links to the work queue and the team inbox | none |
| Benefits and Income Verification | `biv/index.html`, *Find a person* | Every income record, 25 a page, sorted by surname: council reference, name, date of birth, NI number, last updated, each linking to its record | `biv/index-2.html` to `-4.html` |
| Harbour Homes | `harbour/index.html`, *Tenancies* | Every tenancy, 25 a page: reference, tenant, property, monthly rent and arrears, plus a count of accounts in arrears | `harbour/index-2.html` to `-4.html` |
| Customer Messages | `messages/index.html`, *Team inbox* | See *2. The team inbox* | `messages/index-2.html` to about `-9.html`, `messages/clients.html` and `clients-2.html` to `-4.html` |

The work queue stays at `cm/queue.html`, so the address the flows and the site use doesn't change.

**Navigation.** Every `#` in a header nav is replaced by a real page or removed:

| System | Nav today | Nav after |
|---|---|---|
| `cm` | Work queue, Search `#`, Reports `#` | Home, Work queue |
| `biv` | Search `#`, Recent `#` | Find a person |
| `harbour` | Tenancies `#`, Help `#` | Tenancies |
| `messages` | Inbox `#`, Search `#` | Team inbox, Clients |

On the client messages page, the breadcrumb *Clients* `#` now points to `messages/clients.html`, a list of
every client with their message count, 25 a page.

The system name in each header becomes a link to its homepage too. A search page stays out, because doing a
search would need a script or a server, and the demo has neither on purpose.

### The team's procedure on the staff intranet (added at the owner's request)

A fifth generated area, `demo/intranet/`, is the council's staff intranet: *Procedures* (`index.html`) and
**Housing Support Team procedures: Rent support review** (`rent-support-review.html`). It's written in the
council's voice and never mentions Power Loader, so a visitor can first work a case by hand as a caseworker
would, timing it, and then do the same case with the *Rent support review* flow.

- Ten numbered steps, system by system (the inbox and the queue, the case, Harbour Homes, Benefits and Income
  Verification, stopping on a reused reference, every message in Customer Messages, the form, the email to the
  income team, marking the case done), with "If X, go to step N; otherwise continue" decisions as in-page links
  and a table of the decisions near the top.
- `<details>` parts for each branch, a worked example and *Why we do this*. No script: `<details>` and anchors
  need none, and the print style shows every part's text.
- *Training examples* named from the data by `trainingExamples()`: 1003 (Harbour Homes holds a previous
  address), 1007 (a different spelling), 1005 (a reused reference), an income change, a move, no change, the
  lowest arrears, and 1012's urgent referral. Every client in the data has arrears, so the no-arrears branch has
  an instruction but no example. Every case has a landlord reference, so step 3 (*Ask the client for their
  tenancy reference*, the same words as the flow's email step) has no example either: making one would change
  an existing case.
- Linked from Case Manager's home (*Procedures*) and from each case page beside *Start a rent support review*.
  It's in `SYSTEM_DIRS`, so `--check` and `fictionProblems()` cover it.
- Tested in `demo-systems.test.js`: generated, every link and anchor resolves, no script, no "Power Loader",
  a part for each quirk and branch, and each named case has what it's named for.

## 2. Urgent referrals and the team inbox

### Referrals

A **referral** is a message from a partner organisation asking the council's housing team to act for one of
its clients. Each has:

| Field | Values |
|---|---|
| Referred by | *Harbour Homes tenancy team*, *Northtown General Hospital discharge team*, *Northshire Probation Service*, *Southmere Children's Centre* or *Northshire Adult Social Care* (all fictional) |
| Reason | e.g. *Notice seeking possession served*, *Ready for discharge, no safe home to return to*, *Release date set, no address*, *Family at risk of eviction* |
| Urgency | **Urgent** or **Routine** |
| Referral status | **Open**, **Accepted** (a worker has picked it up) or **Closed** |
| Respond by | a date: 2 working days after it was received if urgent, 10 if routine |
| Referrer contact | a name, an `07700 900xxx` phone and an `@example.org` email |
| Client | the client's ID, name and date of birth, as on their other messages |

**Enquiries, the look-alikes.** The existing 600 messages can't change (see *The seed*), and none of them is
from a partner organisation. So the referral stream also makes about 20 **enquiries**: emails from the same
organisations asking about an earlier referral. An enquiry has the same subject, sender and type as a
referral, and no `#referral` section.

**What the list shows.** In the inbox, every referral and every enquiry has the subject *Referral received*,
*From* is the organisation, and *Type* is *Email*, a type the existing messages already use (they are *Online
form*, *Email*, *Phone call*, *Letter* and *Web chat*; there is no *Message* type). So the list shows neither
urgency, nor status, nor whether a message from an organisation is a referral at all. The only way to know is
to open each one, which is the point of the demo.

**On the message page.** A referral or an enquiry is a page at `messages/message/MSG-xxxxxx.html`, named by
its message ID. The address mustn't give a referral away either, so there is no `RF-` prefix: the inbox's
links are `NC-xxxx-n.html` for a client's own messages and `MSG-xxxxxx.html` for anything from an organisation.
The folder is the same as other messages, so the library's existing locked rule (`fetch-messages-pages`)
already allows fetching it. The page has the usual `#message` summary (Type: *Email*, as in the list), and a
referral also has a `#referral` section with the fields above as a `<dl>`. A message is a referral if it has
that section. The existing message pages don't change.

**How many, and where.** As with `QUIRKS`, the positions are planned, so the demo and the tests can point at
them:

- 40 referrals across 32 clients. 12 are urgent and open, 6 urgent and accepted or closed, 10 routine and
  open, and 12 routine and accepted or closed.
- **Inbox page 1 has exactly 4 urgent open referrals**, 2 urgent ones already accepted or closed (the decoys),
  2 routine open ones and 17 other messages, at least 3 of them enquiries. The tests check that, so a change
  to the seed can't quietly spoil the demo.
- The newest 25 existing messages were all received on 23 or 24 Nov, so the planned ones are received on 24
  or 25 Nov to be sure of a place on page 1. That also puts the urgent ones' *Respond by* at 26 or 27 Nov, a
  day or two after the demo's today, which is what a caseworker would act on.
- Two of the urgent open referrals belong to clients with a case in the work queue (planned case numbers,
  which the demo text names), so the triage can go on to a case.

**The seed.** Referrals and enquiries are drawn from their own seeded stream (`SEED + 1`). Their message IDs
are checked against the existing ones, so no two messages share one. The stream that makes the 100
cases doesn't change, so every existing case, income record, tenancy and message keeps its values. That
matters because the tests, the README and the site name specific cases (1003, 1005, 1007, 1042…). A test
checks that the values the existing profiles read are the same as before.

### On the client's page

`messages/client/NC-xxxx.html` keeps its *Messages* table of six, so the rent support review's fetch step
(which fetches `-1` to `-6`) and its text are unchanged. A client with referrals or enquiries gets a second
table, *From other organisations*, listing them with the same columns, which also don't give the urgency or
status away.

The per-client JSON (`messages/api/NC-xxxx.json`) gains a `referrals` array with the full fields. That's
harmless for the existing data profile, which reads only `messages`.

### The team inbox

`messages/index.html` is the Housing Support Team's shared inbox: every message, referral and enquiry received
in the last 28 days (to the demo's fixed today, 25 Nov 2026), newest first, 25 a page (`index-2.html` and
onwards). That's 183 of the existing messages plus most of the 60 new ones, so about 9 pages. The columns are
*Received*, *From* (the client, or the organisation), *Client* (the client ID), *Subject*, *Type* and *Read*. Each row links to
its message page. The table is `#inbox`, and each row carries `data-message="<id>"`, so the inbox profile and
the markers have something stable to find. The page says: *Open a message to see what it is and whether
anyone has picked it up.*

## 3. Extension: the case reference from the case the caseworker opens

### What the caseworker sees

1. On **Flows**, they press **Start case** on *Rent support review*. There's no reference box, because the
   flow's first step sets it. The case starts with no reference.
2. The Steps card shows the first step, **Choose a case**: *Go to the work queue and open the case you're
   picking up*, with **Go to the work queue** (a link, as guide steps have now).
3. They open case 1042 from the queue. As the tab arrives at `…/cm/case-1042.html`, the sidebar says *Case
   reference set to **1042**, from the case you opened. Change* and the step is done. The case's label, the
   log and every later `{ref}` link use it.

### How it works

A guide step (`role: 'guide'`) gains an optional `choose`:

```text
choose { label: 'Choose a case', next: <page id> }   the page whose address gives the reference
```

- The **next** page's address template must contain `{ref}` exactly once, as a whole path segment or a whole
  query value (`cm/case-{ref}.html` and `cases?id={ref}` are fine, `{ref}{x}` isn't). `validateSteps()`
  checks this.
- In the demo that template is the `cm/case` profile's link pattern, which is already
  `…/demo/cm/case-{ref}.html`, so the library's profile doesn't change.
- The template is turned into a pattern: the literal parts escaped, `{ref}` becoming
  `([A-Za-z0-9][A-Za-z0-9._-]{0,39})`, and the scheme, host and port literal, as for fetch templates
  (`fetchTemplateErrors()`). There's no `/` in the set, so the value can't run past its path segment. A
  reference with a `/` in it (the demo's own `HSG/2026/1042`) can't be taken from an address, and is typed.
  The pattern is for this check only, and it's never shown or stored.
- **When it's checked**: on the tab updates the sidebar already follows for the current step (`stepForPage()`),
  only on the case's own window (`c.windowId`), and only on an address allowed for `read`. While the case has
  no reference, a match sets it. Once it has one, a match with a different value only shows the D9 warning.
- **The value** is percent-decoded, trimmed, and refused if it's only dots or has a character outside the
  pattern. As a last check, filling the template with the value (`fillTemplate()`) must give the tab's address
  back, without its query and fragment, so the reference always opens the page it was taken from. It's set with a new `setCaseRef(c, ref, { from: 'address', stepId })` in `lib/case.js`, inside
  `updateCase()`, and logged as `set_reference` (with the step's name, never the address).
- A step with `choose` is `done` once the case has a reference (`stepStatus()`), so the Steps card moves on to
  the next page.
- **Typing still works.** If the flow has no `choose` step, the start card keeps its reference box. If it has
  one, the box is under *Or type a reference*, collapsed, and a typed reference counts as chosen.
- **Change**, until the first clip, clears the reference and goes back to the *Choose a case* step. After
  that, see D9.
- Library forms started without a flow are unchanged.

In the flow editor, a guide step has *This page is where the caseworker chooses the case*, which asks which
page's address holds the reference. The step overview shows *Sets the case reference from the address of
Case*.

### Where the code changes

| File | Change |
|---|---|
| `lib/journey.js` | `choose` in `validateSteps()`; `refPattern(template)`; `refFromAddress(step, next, url)`; `stepStatus()` for a `choose` step |
| `lib/case.js` | `setCaseRef()`, and `clearCaseRef()` only before the first clip |
| `lib/activity.js` | `set_reference: 'Set the case reference'` |
| `lib/flows.js` | `choose` in compile, export and import (remapping `next`); a `validateFlow()` row: *Choose a case: the next page's address has no {ref}* |
| `sidebar/sidebar.js`, `sidebar/caseview.js` | checking the address on tab updates; the *set from the case you opened* note with *Change*; the *This is case 1043* warning |
| `sidebar/start.js`, `sidebar/flows.js` | no reference box for a flow that chooses; the editor's checkbox |

## 4. Extension: fetching every link in a list

### The request

A fetch step's request gains a second kind. Today's kind has a template address. The new kind takes its
addresses from links on the trigger page:

```text
Request (fixed, today)  { id, name, url: template, method: 'GET', pageId, required }
Request (each, new)     { id, name, each: { profileId, list, max }, method: 'GET', pageId, required: false }
  each.profileId   the trigger page's own page profile, which has a list field of links
  each.list        that list field's key, e.g. "items"; each row's `href` is one address
  each.max         at most this many addresses, 1 to 25 (FETCH_LIMITS.perList)
```

That's the request as a flow holds it (`lib/flows.js`), where `pageId` is the flow's page that reads each
response. The list's profile is a page of the flow too, a child of the fetch step as request pages are, so
the flow's own form of it is `each.pageId`, and `compileFlow()` writes both as `profileId`s in `steps.json`.
A step has at most one list request (D2), and it can sit beside fixed requests.

The inbox profile (`messages/inbox`) has a list field
`"items": ["#inbox tbody tr", { "@type": "inboxItem", "href": "a @href | abs", "messageId": "@data-message" }]`.
The DSL already reads attributes (`a @href`, with a space, in `lib/extract.js`), and `| abs` resolves a
relative link against `baseUrl`. Step 6 checks that a bare `@data-message` reads the row's own attribute in a
list item; if it doesn't, the ID goes on the link (`a @data-message`).

### What a run does with it

The existing *What a run does* in `fetch-steps.md` applies, with these steps first:

1. **Read the list from the trigger tab** with the in-page agent's `extract`, as clipping does (the `read`
   action, checked as now). The tab's address must match the list profile's `match` and its `when`. It doesn't
   clip the inbox page, only reads the links, and it reads them again at the press, so the run fetches what
   the page shows then (D10). `planRun()` stays pure: `lib/core.js` reads the list and passes it in.
2. **Check each address before anything is fetched.** It must resolve with `new URL(href, pageUrl)`, have the
   trigger page's origin, match the child page profile's `match` (`matchUrl()`), and be allowed for
   `fetch-get` by every layer (`allowed()`). Fragments are removed and duplicates dropped, in order, and only
   the first `max` are kept. An address that fails a check is never fetched, and the card says why (*Not a
   message page*, *Blocked by the site rules*).
3. The step card and the preview show the count before the run: **Fetch 25 messages**.

Then each address goes through the same checked fetch as a fixed request (no redirects, 20 s, 2 MB, the
profile's `when`), up to `FETCH_LIMITS.parallel` at a time. The whole run still has `runMs` (60 seconds), so on
a slow system it can stop part way, and the card then says *Read 18 of 25 messages* with *Fetch the rest*.

A list request can't be `required`, so the step is done once a run has finished, whatever it found. Today
`stepStatus()` calls a fetch step done when each request's profile has a clip in the case, which an empty
inbox would never give. So the runner marks the step done itself (`markStep()`) when a run with a list request
finishes.

What's the same as fixed requests: GET only, same origin as the trigger tab, a button press each time, *Stop*,
teardown cancelling the run, a late result dropped by `CaseEnded`, and a `fetch_page` log entry for each page
with the profile's `urlPattern` (never the address or a value). The per-case cap counts each fetched page.

What a poisoned library or flow could do is no more than fixed requests allow. The addresses come from the page
the caseworker is on, not from the flow, but each one must still match the child profile the author tested,
pass the site rules and stay on the trigger page's origin. The demo library's locked rule allows fetching only
`messages/message/*`, so a list pointed anywhere else is refused.

### Results as rows

The child profile for a fetched inbox message (`messages/inbox-message`) reads one row and no case fields:

```json
"fields": {
  "item": ["#message", { "@type": "inboxItem", "messageId": "label(Message ID)", "type": "label(Type)",
                         "client": "label(Client ID)", "from": "label(From)", "received": "label(Received) | date",
                         "urgency": "#referral label(Urgency)", "status": "#referral label(Referral status)",
                         "reason": "#referral label(Reason)", "respondBy": "#referral label(Respond by) | date" }]
}
```

A message that isn't a referral has no `#referral` section, so its row has no urgency or status and `show`
passes over it.

Each fetched page is a clip with one record and no `values`. So nothing conflicts and nothing is compared for
identity, and fetching again replaces each clip by its source, as now. A run also removes the clips an earlier
run of the same request left (found by `via.stepId` and `via.requestId`) whose address is no longer in the
list. Otherwise a message that has dropped off the page would still be counted. The clip list shows *25
messages fetched by Team inbox* as one group, not 25 lines (a change to `caseview.js`).

### What the caseworker sees: the step's `show`

A fetch step gains an optional `show`, which picks the rows the step card lists after a run:

```text
show { type: 'inboxItem', where: { urgency: 'Urgent', status: 'Open' }, label: 'Open urgent referrals',
       columns: ['client', 'reason', 'respondBy'], mark?: Mark }
```

- `where` is exact matches only, value for value, with no expressions, so `validateSteps()` can check it and
  it can't do anything else.
- The card shows **Open urgent referrals: 4**. Each row has its columns and **Open the message**, which opens
  the fetched address in a tab after a `navigate` check. Under it: *Read 25 of 25 messages. 21 others weren't
  urgent open referrals.* The live region announces the same.
- Without `show`, the card shows the run's summary only, as today.

### In the page: markers (D5)

```text
Mark { row: '#inbox tbody tr', key: 'messageId', rowKey: '@data-message', text: 'Urgent, open', style? }
```

After a run, the step asks the in-page agent to mark each inbox row whose `rowKey` value matches a shown row's
`key`. The marker is a compact annotation with fixed text, so no case value is put into the page. It reuses
`lib/annotations.js` (the safe-HTML tree, the style allowlist, the `annotate` action check) with one new
placement: at a row found by its attribute value, instead of a fixed selector. Markers are drawn again when the
caseworker comes back to the page during the case, from the rows the case holds, and cleared when the case
ends, as annotations are. At most `LIMITS.perStep` (20) are drawn.

### In the flow editor

- In a fetch step, **Add a request** offers *One page* (today's) or *Every link in a list on this page*. The
  second asks for the trigger page's profile and its list field, from those that have an `href` column, and
  for the maximum.
- **Test as fetched** for a list request reads the list in the current tab and fetches the first three links,
  so the author sees whether the child profile reads them.
- The request preview says: *Up to 25 addresses taken from the links in "items" on this page, each one checked
  against Inbox message's pattern and the site rules.*
- `show` and `mark` have a small form: the row type, a list of *field equals value*, the columns, and the
  marker text.

### Where the code changes

| File | Change |
|---|---|
| `lib/journey.js` | the `each` request kind in `validateSteps()`, with `max` checked against `perList` and `required` false; `show` and `mark` validation; `stepStatus()` for a step with list requests |
| `lib/fetch-steps.js` | `FETCH_LIMITS` (D2); `planRun()` expands a list request into addresses read from the tab; the address checks; `runSummary()` counts list results |
| `lib/core.js` | reading the trigger page's list through the agent, before `fetchFromTab()` |
| `lib/flows.js` | `addRequest()` and `setRequest()` for `each`; `setShow()`; compile, export, import (remapping `profileId` and `pageId`); `validateFlow()` rows: *a list request whose profile has no `href` column*, *a list request with a max over 25* |
| `lib/library.js` | `fetchIndexErrors()` checks `each.profileId` |
| `lib/annotations.js`, the in-page agent | markers at a row found by its attribute |
| `sidebar/fetch-ui.js`, `sidebar/caseview.js` | the card's count and matches list; grouping the fetched clips |
| `sidebar/flows.js` | the editor parts above |

### A case with no form (D4)

The inbox triage fills nothing, and today both a flow and a case must have a form:

| Where | What refuses it today | Change |
|---|---|---|
| `lib/case.js` `newCase()` | *Choose at least one form to start a case* | A case may have no forms when it starts from a flow. Starting from the library's form list still needs one. |
| `lib/flows.js` `NEEDED`, `startable()` | A flow needs a form to fill and a page to clip; *Make a form to fill first* | A flow can start with no form if it has a fetch step with a list request. The page that reads each fetched message counts as its page. |
| `lib/core.js` `startFlowCase()` | passes the flow's forms to `newCase()` | passes none, and the `start_case` log entry says *flow · no form* |
| `sidebar/caseview.js`, `sidebar/fill-ui.js` | the case view expects a form's progress and a *Fill* card | with no forms: no progress bar and no fill card. *Finish case* is always offered, and the summary line is the step's own (*Open urgent referrals: 4*). |
| `tools/build-demo-flows.mjs` | `flowFromLibrary()` throws without a form | the triage flow is built from an empty flow (`newFlow()`), with its two profiles added as pages |

Removing a form from a case keeps its guard (`c.forms.length < 2`), so a case that started with a form can't
end up without one.

## 5. The demo library and the flows

**Profiles.** Every profile goes in `demo/library/profiles/pages/messages/`, and the manifest is rebuilt by
`tools/build-demo-library.mjs`:

- `inbox.json`: the team inbox (`messages/index*.html`), with the `items` list field.
- `inbox-message.json`: a fetched inbox message, reading the `inboxItem` row (above). It matches
  `messages/message/*`, as `message.json` does. A fetch step names its child profile, so the two don't clash
  in a fetch.
- `referral.json`: a referral page clipped by hand within a case, with case fields (client ID, name, date of
  birth, so the identity check works) and `referralReason`, `referralUrgency` and `referralRespondBy`. Its
  `when` is `#referral`, so it applies only to a referral.

That makes three profiles for `messages/message/*`. On a message page opened by hand, the sidebar must offer
*Customer message* or *Referral* and never *Inbox message*, which is for fetching only. Step 6 checks how the
sidebar chooses between profiles for one address (`profilesForTab()`) and, if it would offer *Inbox message*,
keeps it out of the choice.

**Fields** (`fields.json`): `referralReason`, `referralUrgency` (a choice: Urgent or Routine) and
`referralRespondBy` (a date), for the hand-clipped referral. The triage rows don't use fields.

**Site rules** (`access.json`): no new rule. Referrals are under `messages/message/`, which
`fetch-messages-pages` already allows. Its note gains *and every message on a page of the team inbox*.

**Homepage profiles**: none. Homepages are pages to visit, not to clip.

**Flows** (`tools/build-demo-flows.mjs`, exported to `dist/site/flows/`):

Flows use only the pages they need. No flow visits every homepage.

- **Rent support review** (both versions): the first step is **Choose a case** on the work queue
  (`choose`, next: the case page, `cm/case-{ref}.html`). It replaces *type its case number, such as 1001, as
  the case reference*, and the guidance text in `demo/index.html` loses that sentence too. The step's link
  *Open the case* goes, because its address needs a reference the case doesn't have yet; the caseworker opens
  the case from the queue itself. The queue's *Pick up the next case* button still offers the oldest case not
  marked done. The rest of the flow is unchanged,
  except that the fetch step's text says *fetches all six messages, 4 at a time* instead of *at once*.
- **Inbox triage** (new, no form, no reference, D4): it starts at the **Team inbox** fetch step, with one list
  request (`max` 25), `show` for open urgent referrals, and the markers. Then a step says what to do with each
  referral: *Open it, accept it in your own system, then finish this triage and start a case for the client*.
  Power Loader works on one case at a time, so the triage case is finished before the rent support review
  starts.
- The DHP and housing support referral flows don't change. Their pages have no case list to choose from.

**Emailing the client (added at the owner's request).** Both versions of the rent support review have an email
step after the case, **Ask the client for a missing reference**: to the client's own address from the case
(`{email}`, which the case page's profile reads, added to the flow for this email), with a subject and body
filled from the case (*Dear {firstName} {lastName}, … your Harbour Homes tenancy reference … quoting case
{ref}*). It's the same wording as the intranet procedure's step 3 (`ASK_FOR_REFERENCE` in the generator), and
it shows how much quicker a templated email opened with a mailto link is than one written by hand. The step
says to use it only when the case has no tenancy reference. An email step is done once opened in the email app
or marked with the step's button, now worded *Sent another way, or not needed*; finishing a case never waits for
steps, so a skipped email doesn't block it. *Tell the income team* stays. No generated case lacks a tenancy
reference (making one would change an existing case), so the step is there to show, not one the data forces.

**Instructions for every step (added at the owner's request).** The flow's own instructions (`flow.guidance`)
for both rent support reviews start with *1. Choose a case. Go to the work queue at …/cm/queue.html and open the
case you want to work on*, then give one numbered line per step in the order the caseworker takes them, both
emails included. Guidance is plain text (the editor shows it and the AI reads it; it isn't a link anywhere), so
the work queue's address is written out and the *Choose a case* step carries the real link. Every step has its
own short text, *Tell the income team* included. The Inbox triage flow's instructions are written the same way. A
test checks the first line and that every step in the journey has text and its own numbered line.

**Found while building the profiles.** A bare `@data-message` in a list item reads the row's own attribute, so
`inbox.json` reads it as written. The plan's `inbox-message` spec scoped each item to `#message`, but `#referral`
is beside `#message`, not in it: the row is `main`, with `#message label(…)` and `#referral label(…)` inside it.
The sidebar offers the first profile whose `when` applies, in library order (`pageProfiles()`, then
`profilesForTab()`), so *Inbox message* and *Team inbox* are marked `fetchOnly: true`, a new profile key that
`pageProfiles()` leaves out (fetch steps still read them), and *Customer message* (now v2) has
`"when": "#message:not(:has(~ #referral))"` so a referral page offers *Referral*.

**Flows from the library (added at the owner's request).** A library can carry flows under `flows/`, and the demo
library carries the five demo flows (both rent support reviews, the Inbox triage, the DHP and housing support
referral flows), written by `tools/build-demo-library.mjs` from the same definitions as the site's downloads
(`libraryFlowFiles()` in `tools/build-demo-flows.mjs`, with ids numbered so the files are the same at every build).
The Flows tab and the start screen list them under *From your library*, beside *On this computer*. They're
read-only (look, start, copy), opened as imports, so their pages are untested on this computer and listed when a
case starts. See *Where flows come from* in `flow-authoring.md`. `flow-authoring.md` had listed library flows
under *Not in this version*, as not built yet rather than ruled out, so this doesn't contradict a decision.

## 6. The demo index, the site and the docs

| File | Change |
|---|---|
| `demo/index.html` | A *Systems* section first, linking the four homepages, with a line on what each plays. The inbox and urgent referrals described as the messages were. *At once* corrected. The hand-written pages listed under *The first demo* (D6). |
| `site/try.html` | A new section after the rent support review, **Triage the team inbox**: import *Inbox triage.flow.json*, start a case, press **Fetch 25 messages**, see the 4 open urgent referrals in the sidebar and marked in the inbox, then open one, finish the triage and start the rent support review for its client. A download button for the new flow. *The demo pages* table gains the four homepages, and *Customer Messages* becomes the team inbox. *At once* corrected. Section 2, *Start a case*, and the rent support review: no case reference to type; open a case from the work queue and Power Loader takes its number. |
| `site/how-it-works.html` | The caps sentence (line 173) updated (D2), plus a short paragraph on list requests: where the addresses come from and the checks each one passes. Its fetch-step sequence diagram (`tools/how-it-works.mjs`) gains a *for each link* group. |
| `site/reviewers.html`, `REVIEWERS.md` | The caps (D2), and one sentence: *A fetch step can also take up to 25 addresses from links on the page the caseworker is on; each must be on the same site, match the library's page profile and pass the site rules.* |
| `site/create.html` | Checked for mentions of the demo systems, and updated if any. |
| `README.md` | The demo casework paragraph: homepages, the inbox, referrals, *at once* corrected. |
| `docs/plans/fetch-steps.md` | The status line: list requests built, with a link to this plan; the caps table. |
| `tools/build-site.mjs` | The new flow file in `dist/site/flows/`. |

## 7. Ready for attachments (next iteration, not built now)

So that adding pictures and PDFs later doesn't change the layout or the profiles:

- Every message in the generator gets `attachments: []`, and the page draws an *Attachments* section only when
  there are some. So nothing changes on any page now.
- The plan for next time: some messages (payslips, a letter, a tenancy agreement, a referral form as a PDF)
  get a generated PNG or PDF under `messages/files/`, linked from the message page. The library's existing
  document profiles (`profiles/documents/payslip.json`, `tenancy-agreement.json`) read them through the
  reader, and the privacy model and OCR run on this computer. A fetch step would need a third format,
  `binary`, to fetch an attachment. That's a separate plan, along with whether fetched files are read
  automatically.

## 8. Tests

`tests/js/demo-systems.test.js`:

- Each system has a homepage, every nav link and breadcrumb points to a generated page (no `#`), and every
  link on every generated page resolves to a generated file.
- The existing values are unchanged: the values each existing profile reads, for a sample of cases, are the
  same as before this change (a small fixture recorded from the current generator).
- Referrals: 40 of them, in the planned mix; inbox page 1 has exactly 4 urgent open referrals, 2 urgent
  decoys, 2 routine open ones and at least 3 enquiries; in the inbox, a referral's row and address differ from
  an enquiry's only in their IDs, and its type is one the existing messages use; no two messages share an ID;
  referrals are fictional (`fictionProblems()` covers the new pages).
- The intranet procedure: generated, links and anchors resolve, no script, no "Power Loader", a part for each
  quirk and branch, and every case it names has what it's named for.
- The inbox profile reads 25 `items` with resolvable `href`s from page 1; the inbox-message profile reads a
  referral row and an ordinary message row; the referral profile clips a referral with the identity fields.

New `tests/js/case-ref.test.js`:

- `refPattern()` and `refFromAddress()`: `cm/case-1042.html` gives `1042`; a query value gives its value; a
  percent-encoded value is decoded; another host, another path, a value that runs into the next path segment,
  dots only, a value over 40 characters or with a character outside the set gives nothing; a template with no `{ref}`, two, or `{ref}` inside a segment is
  refused by `validateSteps()`.
- Starting the rent support review with no reference, then arriving at a case page, sets the reference once,
  logs `set_reference` without the address, and marks the *Choose a case* step done; a second case's page
  warns and doesn't change it; *Change* works before the first clip and isn't offered after; a typed reference
  skips the step.
- An address blocked for `read`, or a tab in another window, sets nothing.
- `importFlow()` remaps `choose.next`; an export round-trips it.

New `tests/js/fetch-list.test.js` (the runner, with `fetch` stubbed against the generated files):

- A list request expands to the page's links, in order, deduplicated and capped at `max`; an address on
  another origin, one that doesn't match the child profile, and one blocked by the rules are each refused
  without being requested.
- At most `parallel` requests run at once (a stub that counts the ones in flight); two full runs fit under
  the per-case cap, and a third inside 10 minutes is refused before any request.
- The triage run on inbox page 1 gives 25 row clips, no case values, no identity warning, and `show` picks
  exactly the 4 planned referrals; running again replaces the clips rather than adding 25 more; a run on a
  list that has lost a message removes that message's clip; a run on an empty list marks the step done.
- A flow with a list request and no form starts a case with no forms; a flow with neither is still refused;
  the last form of a case that has one still can't be removed.
- *Stop*, `CASE_ENDED` and a late result behave as for fixed requests; each fetched page is logged with the
  pattern, never the address.
- `validateSteps()` refuses a list request with `max` over 25, `required: true`, a second list request in one
  step, or a `show` with something
  other than exact matches; `importFlow()` remaps `each.profileId`.
- Markers: placed only on rows whose attribute matches a shown row, with fixed text; none when `annotate` is
  blocked.

Updated: the flow tests (the inbox triage flow exports and imports; the rent support review starts with
*Choose a case* on the work queue), the tests that state the caps (`fetch-run.test.js`, `fetch-steps.test.js`),
the library tests that count its contents (`tools.test.js`, `assist.test.js`, as in `2c3796e`), and
`check:site` for the new flow download.

**Firefox suite**: not added here, as for fetch steps phase 1. It still needs a session-cookie demo server.

## 9. Order of work, and how it's published

Each step is a commit, pushed to `origin` as it lands:

1. Generator: homepages, nav, the client list. Tests.
2. Generator: referrals and the team inbox, from their own stream. Tests.
3. Extension: the case reference from the case opened (`choose`). Tests.
4. Extension: list requests, the caps, results as rows, `show`, and a case with no form. Tests.
5. Extension: markers (D5). Tests.
6. Library: profiles and fields, and the flows. Tests.
7. Demo index, site, README, `REVIEWERS.md`, the how-it-works diagram, the `fetch-steps.md` status.
8. `tools/ci-local.sh` in full, then **one** `tools/publish.sh`, because this touches the extension, tooling
   and the site: the long local CI, about 10+ minutes.

Before publishing, I'll run the demo in Firefox against `pnpm demo` and check by hand: the four homepages, the
inbox, a triage run with 4 matches and the markers, and the rent support review starting from the work queue. Firefox
can't be driven from here for fetch steps, so I'll tell you which of these I could check and which you'll need
to try.

**Size.** The generated files go from 1,204 to 1,289: 40 referral pages, 20 enquiry pages, 23 homepage and
list pages (1 for Case Manager, 4 each for income records and tenancies, 10 for the inbox and 4 for the client
list) and the intranet's 2 pages. They're still not committed.
