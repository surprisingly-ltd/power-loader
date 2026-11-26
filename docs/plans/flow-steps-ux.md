# Flows, steps, cases and templates: how the sidebar works a flow, and how a flow is built

Created: 2026-11-26. Status: **built** (steps 1 to 10, 2026-11-26), not yet published: `tools/publish.sh` and
the hand checks in step 10 are the owner's. Every decision below is the owner's, made on 2026-11-26.

## Where the build differs

- **A flow made from library forms keeps its pages' lists** (step 1): `flowFromLibrary()` used to keep only the
  fields the forms use, which dropped the rows the calculator and timeline read (payments, periods). With
  every case a case of a flow, the demo's Tools would have had nothing to work on.
- **Change of circumstances is an unfinished flow** (step 1, D9): the library has no fill template for its form
  and no demo page to fill, so its flow is listed with "Can't start yet: Make a form to fill first". It is
  mended in Build, as an incomplete flow should be.
- **A library flow keeps its file's page ids** (step 2): `importFlow(doc, { keepIds })` for `libraryFlow()` and
  `copyLibraryFlow()`, so a case's step ids and the copy's pages match for *Fix this in Build* and step 9.
- **Settings is the same in both modes** (step 2): there is no separate "library address for publishing"
  setting to show, and the remote AI serves Casework (*Read this page with AI*) as well as Build.
- **The on-device profile assistant** (`lib/assist.js`, `lib/assist-client.js`, `assist/worker.js`) was used only
  by the draft editor. It is left in place, unused by the sidebar: whether to wire it into the flow's page
  editor or delete it is the owner's call.
- **The Library page is read-only** (step 2): its drafts, Make a new version and Make a fill profile went with
  `profileDrafts`. Its tabs say *Page templates* and *Fill templates* (step 3's words).
- **Outlines are styled as properties and animated with the Web Animations API** from the start (step 6), so a
  page's CSP doesn't decide between that and a `<style>`; the Firefox suite serves a page with
  `default-src 'self'` (`?csp=strict`) and checks the outlines reach their done state there.
- **The step's Next is the open step's choice**: the variant's rule (the chosen step, else this page's, else the
  first not done) is kept, so any step can be opened to look at while on a step's page (D5).
- **The film and the lab walk were not re-recorded**: port 8787 was held by a lab server this build didn't
  start. `lab/film/script.mjs`'s line about step three and its check are rewritten; its voice isn't remade.


The part about working a flow's steps (steps 4 to 7) was tried out first in the UX lab, as the `flow-ux`
variant (`lab/variants/flow-ux/`), and filmed (`dist/lab/flow-ux.mp4`, made by `node lab/film/record.mjs`). The
owner's words on seeing it: "that is much easier to understand". The rest (steps 1 to 3, 8 and 9) came out of
talking it through and exists only here. Checked against the code on 2026-11-26 (`sidebar/caseview.js`,
`sidebar/sidebar.js`, `sidebar/start.js`, `sidebar/flows.js`, `lib/core.js`, `lib/flows.js`, `lib/journey.js`,
`lib/library.js`, `lib/agent.js`, `lib/access.js`).

Builds on the flow's steps (`flow-authoring.md`), fetch steps (`fetch-steps.md`), taking the case reference
from the case opened (`system-homepages-and-inbox-triage.md`) and the site rules (`site-access-lists.md`).

**If you are the one building this, read *For whoever builds this* at the end first.**

## Why

Working a flow today means reading two cards and working out which one to press.

- **The steps are hidden.** The Steps card shows one step. The others are behind *All steps*.
- **Choosing a step doesn't do it.** Clicking a step in the list opens its text. Its page is behind *Go to …*,
  and what you do on the page (*Clip this page*, *Fill this form*) is in a different card underneath, often
  below the fold.
- **The main button is often the wrong one.** On the case page, before it is clipped, the green button is
  *Open the rent account*, greyed out, above a note that "the links need Tenancy reference and Client ID".
  The thing to do is clip the page, and that button is in the other card.
- **After a clip there is no way on.** The Steps card says *Step 4 · done* and offers nothing. The next page is
  found by opening *All steps*.
- **Nothing shows what a clip took.** The card says "Reads 7 items" before and "+2 new, 5 matched" after. The
  caseworker can't see which values, or where on the page they came from, without opening the clip.

`dist/lab/base-walk.txt` (`node lab/baseline.mjs base`) has the sidebar's words at each of these points.

## The words

Four things, and no others (the owner, 2026-11-26):

- A **flow** is an end-to-end process made of steps.
- A **step** is one of: taking data from a page, putting data into a form, writing an email, or going to a
  search or index page to get to the next step. (In the code: `input`, `fetch` and `scan` take data; `output`
  puts it in; `email`; `guide`.)
- A **case** is one run of a flow: the steps of that flow done for one piece of work.
- A **template** is what Power Loader knows about one page or one form: where it is, and which values it
  reads from it or puts into it. Flows are made of them. (In the code and the library: a page profile, and a
  form with its fill profile.) The word "profile" goes from the sidebar; the files keep it.

So every case has a flow, and every case has steps. Today that isn't so: a case can also be started by ticking
forms under *Start a case*, and then it has no flow, and no steps unless the library has a `steps.json`. That
second way of working goes (step 1). The sidebar then has one thing to show for a case: its flow's steps.
Forms don't go: they are templates, listed with the pages on a new **Templates** tab (step 3), each linked to
the flows that use it.

**Two modes.** Power Loader is used for two different jobs, by people in two different frames of mind, and
the sidebar shows one at a time:

- **Casework**: following a flow to work a case. The tools for making flows aren't on screen, so the
  caseworker is looking at the job in hand and nothing else. The one exception is the moment a flow turns out
  to be incomplete: on a page the flow doesn't have, Casework asks whether it should.
- **Build**: making a flow. A page is something to add to the flow, and the Templates tab is here.

**Build is for everyone.** The point of Power Loader is that the people who do the work can change how it is
done. No one is kept out of Build, and no one is made to go there. An organisation restricts *what Power Loader
may do and where* (the site rules: which pages may be read, filled, fetched from), and those rules bind a flow
whoever made it. It doesn't restrict who may make one. Someone who copies a working flow and changes it so
that it reads the wrong thing has done that themselves. Far more often they were given a flow that was
broken or unfinished, and they are mending it.

**No cut-over.** There are no users yet (the owner, 2026-11-26). Nothing here keeps an old way working beside
the new one: no migration of stored cases, no reading of old keys, no release in between.

## What changes

Working a case (Casework):

1. **A case is always started from a flow.** The start screen lists flows, and nothing else. There are no
   forms to tick and no adding a form to a case part-way through.
2. **A flow can be starred**, and starred flows are at the top: a team may have twenty flows, and each
   caseworker works one or two.
3. **Every step is always listed**, numbered, with a tick when done and a bar of progress under the flow's
   name. One step is open, in place in the list: the step this page is, else the one they chose, else the first
   not done.
4. **The open step has one green button, and it is always the next thing to do**: go to the step's page; clip
   it; fill the form; then *Next: <the next step>*, which goes to that step's page. When every step is done it
   is *Finish case*.
5. **What a page is to the case is part of its step.** On a step's page, the clip or fill controls are in the
   step, not in a second card under it.
6. **A step done on the page says so.** On the work queue the step says *On the page: open the case you're
   picking up* and offers no green button. A filled form says *On the page: check every box, complete anything
   empty, then submit it yourself*.
7. **Any step can be opened to look at**, and a step whose page address is known has an arrow that goes
   straight there.
8. **The values a page gives are outlined on the page and listed in the step before the clip.** Pointing at a
   row marks its value on the page. A value the template reads but the page doesn't have says *not on this
   page*.
9. **Clipping shows the values travelling**: each lifts off the page and lands in its row in the sidebar. After
   the clip the outlines stay, in green with a tick.
10. **Auto-clip shows what it is about to read.** The values are outlined, then gathered: about half a second
    from the page being recognised to the clip. Auto-clip can be turned on from a tick box on the step, as well
    as in Settings.
11. **A step that doesn't apply to this case is passed over.** A flow can say a step is only needed when the
    case has, or lacks, a value. *Next* skips a step that isn't needed, and the list shows it as *Not needed*.
12. **Nothing offers to build**, with one exception. No *Not recognised · Make a profile for this page*, no
    Flows tab. But on a page that isn't part of the flow, while a case is open, the sidebar asks: *Is this flow
    incomplete?* If the page is needed to finish the case it belongs in the flow, perhaps as a step that is
    only sometimes needed. Adding it goes to Build, and the open case can then take the mended flow.

Building a flow (Build):

13. **A page in view is something to add to the flow**: *Add this page to <flow>*, as a page to take data
    from, a form to fill, or a page to go through. It uses the tools the Flows tab already has.
14. **Pages and forms have a tab of their own, *Templates***, after *Flows*: every page and form that a flow
    uses, what it reads or fills, and which flows use it, with links both ways.
15. **There is no template outside a flow.** *Make a profile for this page* and the separate draft editor go.

The film shows 3 to 10 on the rent support review, case 1001 (recorded before auto-clip was shortened to half
a second, and before conditions: it still skips step three by hand).

## What doesn't change

- The library's files, except one new optional key on a step (`when`, step 8) and that a library's own
  `steps.json` is no longer read (D11).
- What is clipped, what is stored about a clip, and the site rules that decide what Power Loader may do where.
  The activity log gains two events (`update_flow`, `reopen_step`) and loses none.
- The words of existing buttons that a flow's own instructions name. The demo's steps say "press *Fetch*" and
  name *Sent another way, or not needed*: those labels stay.
- The flow editor's own screens. Build is the Flows tab there is now, with a mode around it.

## Decisions

All made by the owner on 2026-11-26. Where he chose between options, what he said is given, because it is the
reason and the next question will be answered the same way.

| | Decision | Why, or the owner's words |
|---|---|---|
| D1 | Outlining what is clipped is part of reading the page: the site rules' `read` covers it, not `annotate`. | "annotate is where the flow can add some custom content to the page - this should be built in." It is drawn wherever the page may be read, and can't be turned off by blocking `annotate`. |
| D2 | There are no cases without a flow. | "we should get rid of cases without flows. there are too many things currently." |
| D3 | Auto-clip takes about 500 ms in all, from the page being recognised to the clip. | "make the whole thing fit in 500ms, or thereabouts." Not 500 ms on top of drawing the outlines. |
| D4 | Steps can have a condition, and *Next* passes over a step that isn't needed. | Asked for. *Next* follows the flow's order otherwise. |
| D5 | Clicking a step's name opens it in place. The arrow at the end of its row goes to its page. | Going to a page on a click on a name would take the caseworker off the page they are reading from. |
| D6 | The tick box for auto-clip is on every step that clips a page, as well as in Settings. | It is where the caseworker is when they want it. |
| D7 | With the computer set to show less animation (Windows: *Accessibility → Visual effects → Animation effects* off; macOS: *Reduce motion*), nothing travels. The outlines are drawn at once, and at the clip they turn green and the rows have their values straight away. | `prefers-reduced-motion`. For people whom movement on screen makes ill or distracts. |
| D8 | The clickable prototype (`prototype/case-journeys.html`) is left as it is. | It has no flow steps. |
| D9 | A library page or form that no flow uses is listed on the Templates tab under *Not in a flow*, with *Make a flow from it*. It can't be started on its own. The demo library gets a flow for *Change of circumstances*. | Forms stay: "let's not completely get rid of forms." No flow is made behind anyone's back. |
| D10 | A case that fills several forms is a flow with several forms to fill. | Flows already allow it. |
| D11 | A library's own `steps.json` is not read, and is reported as a file the library shouldn't have. | Steps belong to a flow. |
| D12 | The Templates tab is an index, read-only: it gathers the copies that are the same template, says which flows use each, and says so when two flows' copies differ. Changing one is done in a flow. | Each flow on this computer carries its own copy of each page and form (`page.draft`). Making a template one shared thing is its own piece of work (*Not in this plan*). |
| D13 | Two modes, Casework and Build. Making a template is offered only in Build, as *Add this page to the flow*. | "Make a template for this page only makes sense if you are building a flow." "In Casework mode that is hidden so the user is just clearly focussed on the task at hand." |
| D14 | No one is excluded from Build, and no one is made to use it. There is no policy switch for it. | "the whole point of this is I want to empower end users." Organisations restrict pages and actions, not who may build. "if someone is given a working flow and they decide to clone/edit it so that it does the data wrong that is on them - it's much more likely they were given a broken or incomplete flow and they are fixing it." |
| D15 | In Casework, with a case open, any page the site rules allow Power Loader to read that isn't in the flow shows *Is this flow incomplete?* Not a page the rules block. Not limited to the systems the flow already uses. | "generally people should not just be randomly browsing the internet while in the middle of the case. it should not show on pages which are not allowed via the allow/disallow lists but should not be restricted to the existing flow pages." |
| D16 | *Not needed for this flow* puts the box away for that page until the case ends. | The next case may need the page. |
| D17 | A case can take a flow that was changed after it started, when the caseworker asks. Never automatically. | "if you fix a flow you want to switch to the new fixed flow, or at least have the option to." |
| D18 | A flow from the library is never changed in place: changing it makes a copy on this computer first, and says so. | The library's flow is the team's. The copy can be exported for them. |
| D19 | Changing mode with a case open is allowed, and the case stays open. Build never clips into it. | Its reference stays in the header in both modes. |
| D20 | Flows can be starred, and starred flows are listed first. Stars on forms go. | "a team might work on 20 flow but each worker might focus on one or two." (The owner wrote "start a flow so that it is at the top of the list": taken as *star*. If he meant something else, this is the one decision to ask about.) |
| D21 | No cut-over. Nothing old is kept working beside the new: no migration of stored cases, no reading of old keys, no release in between. | "don't worry about cut over - there are no active users yet." |

## How it is built

Ten steps, in this order, each one a commit (or a few) that leaves `pnpm test` passing. Steps 1 to 3 change
what the sidebar is; 4 to 7 are the lab's variant going in; 8 and 9 are new behaviour on top; 10 tidies up.

| Step | What | Needs | In the lab? |
|---|---|---|---|
| 1 | Every case is a case of a flow | | No |
| 2 | Two modes, Casework and Build | 1 | No |
| 3 | The Templates tab | 2 | No |
| 4 | The steps list and the open step | 1 | Yes: `sidebar/caseview.js`, `sidebar/steps.css` |
| 5 | Tests and words for step 4 | 4 | The lab has no tests |
| 6 | The values a page gives, listed and outlined | 4 | Yes: `lib/gather.js`, `sidebar/gather-ui.js` |
| 7 | The values travel; auto-clip waits for the outlines | 6 | Yes, wrapped from outside |
| 8 | Steps with a condition | 4 | No |
| 9 | Mending a flow from a case | 2, 4, 8 | No |
| 10 | The lab, the film, publishing | all | |

### Step 1: every case is a case of a flow (`sidebar/start.js`, `lib/core.js`, `lib/flows.js`, `lib/library.js`)

First, because it removes a whole way of drawing the Case tab before the steps are redrawn.

- **Every flow has steps.** Today `compileSteps()` (`lib/flows.js`) writes steps only for a flow that "guides"
  (it has a page to visit, a fetch step, an email, or instructions or links on a page). A flow that is just
  pages to clip and a form compiles to a library with no steps, and its case looks like a form-started one.
  Drop the `guided` test: every flow compiles its journey (`journeyOf(flow)`) to steps, with empty text where
  the author wrote none. This alone makes the new steps list appear for every flow.
- **The start screen** (`sidebar/start.js`): one list of flows, the library's and this computer's together
  (`flowStartCard()`), each with *Start* and a star. Starred flows come first, under *★ Your flows*, then the
  rest by name; a search box appears when there are more than eight. Gone: *All forms* and its category
  filter, the tick boxes and the tray (*Start case: …*), stars on forms, and the one *Case reference* box at
  the top. A flow that doesn't take the reference from the case opened keeps its own *type a reference* under
  its card, which flows that do already have.
- **Starting** (`lib/core.js`, `sidebar/sidebar.js`): `startCase(formIds)` and `act.start()` go;
  `startFlowCase()` is the only way in. `act.star()`, `toggleStar()` and the `starred` storage key stay, and
  now hold flows: a library flow by its path, a flow on this computer by its id (`toggleStar(flowKey)`). A
  star whose flow has gone is dropped the next time the list is drawn.
- **Forms belong to the flow.** *Add it to this case* on a form's page (`contextCard()`) and removing a form
  from a case (`progressCard()`) go, with `addForm()` and `removeForm()` in `lib/case.js`. A library form that
  isn't in the flow says "This form isn't part of this flow."
- **A library's `steps.json`** (D11): not read into `lib.steps` for a library from a team's address;
  `indexLibrary()` reports it. The set a flow compiles to still has a `steps.json` inside it: that is how a
  case's steps are stored, and doesn't change. `validateSteps()` and the rest of `lib/journey.js` stay.
- **No case without a flow is drawn.** `renderCaseTab()` assumes steps. The branches for a case with none go,
  and so do `updateCaseLibrary()`, `libraryUpdates()` and the *Update this case to the latest library* notice
  (`updateNotice()`), which only ever applied to a case started from forms. Step 9 adds what replaces them.
- **The demo**: a flow for *Change of circumstances* in `tools/build-demo-flows.mjs` (`DEMO_FLOWS`), so every
  demo form has one. The two flows that are only pages and a form (*Discretionary housing payment*, *Housing
  support referral*) now have steps; give each step a line of instruction.
- **Words**: the header comment of `start.js` ("start one from the forms it needs to fill"), the onboarding
  card, `README.md`, `REVIEWERS.md`, `site/try.html`, `site/reviewers.html` and `demo/index.html` all walk
  through ticking a form. They become "start the flow". `site/how-it-works/diagrams.mjs` draws the same.

Tests: `tests/js/sidebar.test.js` and `storage.test.js` start cases with `startCase()` or the form list, as do
`tests/firefox/workflow.js`, `tests/firefox/recovery.js` and `tools/preview/shoot.mjs`: each starts from a
flow instead (a helper in `tests/js/helpers/library.js`, `startDemoFlow(name)`, keeps them short). New:
`flows.test.js`, a flow with no instructions compiles to steps; `library.test.js`, a library `steps.json` is
reported and not used; `sidebar.test.js`, the start screen has no form list, a starred
flow is listed first and stays starred after the sidebar is reopened.

### Step 2: two modes, Casework and Build (`sidebar/sidebar.js`, `sidebar/start.js`, `sidebar/flows.js`, `sidebar/draft-editor.js`)

- **The switch**: two buttons in the sidebar's header, *Casework* and *Build*, one pressed. The mode is
  `settings.mode` (`'casework'` by default), so it is the same the next time the sidebar opens. The header's
  bottom border is blue in Casework and purple (`--magic`, the colour building already has) in Build, so the
  mode is known at a glance from anywhere in the sidebar.
- **What each mode shows.**

  | | Casework | Build |
  |---|---|---|
  | Tabs | Case · Tools · Privacy · Settings | Flows · Templates · Privacy · Settings |
  | With no case | The list of flows, starred first, each with *Start* | The list of flows to open or copy, *New flow*, *Import a flow* |
  | On a page the flow knows | The step for it | That page of the flow, in its editor |
  | On a page the flow doesn't know | With a case open: *Is this flow incomplete?* (step 9). With none, nothing | *Add this page to <flow>* |
  | Settings | The caseworker's: auto-clip, site rules, the library | Also the library's address for publishing, and the AI used for building |

- **Casework loses**: the *Not recognised · Make a profile for this page* card (`unrecognisedCard()`), on the
  start screen and in a case; *Make a fill profile* and *Map this form with AI* on a form's page;
  *Something wrong or missing? Change the flow* becomes *Fix this in Build*, one line under *A value is wrong
  or missing* in the open step, which changes mode and opens the flow at that page (a library's flow is copied
  to this computer first, D18); `authorCard()` on the start
  screen; the Flows tab. `editorCard()` is never drawn in Casework.
- **Build: adding the page in view.** With a flow open, a page that isn't in it gets one card at the top of
  the Flows tab, *Add this page to <flow name>*, with three buttons: *A page to take data from*, *A form to
  fill*, *A page to go through* (a search or index page). Each is `addPage(flow, role)` with the page's
  address and title filled in, then the flow's own page editor (`pageEditor()`, `guideEditor()`): the
  typeahead, picking values on the page, the AI, *Test*. Nothing new is built for making the template: these
  are the tools the Flows tab has now. With no flow open the card says *Open a flow, or start a new one, to
  add this page*.
- **Build: a page already in the flow** opens its editor when the tab arrives on it, with *Step n of <flow>*
  at the top, the way Casework opens its step. (Today the Flows tab stays wherever it was left.)
- **The separate draft editor goes** (`sidebar/draft-editor.js`: *Make a profile for this page*, a new version
  of a library profile, a fill draft for a form). Each of its three jobs is a page in a flow: a new page, the
  flow's copy of a library page, a form's fill template. `profileDrafts` in storage goes with it, and
  `profilesForTab()` stops taking drafts. What is worth keeping from it (picking by dragging, `onDragPick`)
  moves into the flow's page editor if it isn't there already: compare the two editors before deleting.
- **Trying a flow out**: in Build a flow's overview has *Try it*, which changes to Casework and starts a case
  from it. That is the only way from Build to a case.
- **No policy for it.** There is no setting, managed or the caseworker's own, that hides Build. The site rules
  already stop a flow reading, filling or fetching where the organisation doesn't allow it, and they are
  checked when a flow runs, whoever made it (`startable()`, `checkAccess()`). Building on a page the rules
  block is refused as clipping it would be, with the same words.
- **First run**: the welcome on Settings stays. After it, with a library connected the sidebar opens in
  Casework; with none it says so and offers *Connect a library* or *Build a flow*.

Tests: `sidebar.test.js`: each mode's tabs; in Casework no control with a `data-key` beginning `make-`, `fl-`
or `ai-form` exists on any demo page, in a case or out of one; the mode survives reopening; no policy value
removes the switch. `flows-sidebar.test.js`: *Add this page* for each of the three kinds makes the page and
opens its editor; arriving on a page in the flow opens it. `tests/js/drafts.test.js` and the parts of
`sidebar.test.js` that drive the draft editor go, or move to the flow's editor where they test something it now
does. `tests/firefox/workflow.js`: build a two-page flow in Build, *Try it*, finish the case.

### Step 3: the Templates tab (`sidebar/templates.js`, new; `lib/flows.js`; `sidebar/sidebar.js`)

The Templates tab is in Build mode (step 2), after *Flows*.

- **What a template is, in the data** (`lib/flows.js`, a pure `templatesOf({ lib, flows })`): one entry for
  each page a flow clips (`role: 'input'`, including pages a fetch step fetches) and each form a flow fills
  (`role: 'output'`), from the library's flows and the flows on this computer. Copies are the same template
  when they have the same library id (`profileId`, `formId`), or, with none, the same address pattern. Each
  entry: `{ kind: 'page' | 'form', id, name, host, address, version, values: [{ key, label }], required: n
  (forms), from: 'library' | 'computer', tested, uses: [{ flowId, flowName, pageId, stepNumber, library }],
  differs: boolean }`. Pages to visit, emails and screenshots aren't templates: they belong to one flow's step.
- **The list** (`renderTemplates()`): *Pages*, then *Forms*, each grouped by system (the address's host, as
  the demo's four systems are). A row has the name, how many values it reads or boxes it fills, whether it
  has been tested on this computer, and *Used in* with a link for each flow. Then *Not in a flow* (D9):
  the library's pages and forms that no flow uses, each with *Make a flow from it*. A search box over names
  and systems, since a library can have hundreds.
- **One template, opened**: its address, the values with their labels (and for a form, which are required),
  *Go to this page* (through `act.openUrl`, so the site rules apply), and its flows: *Step 4 of Rent support
  review* opens the Flows tab at that page of that flow (`openAt(flowId, pageId)`, exported from
  `sidebar/flows.js`). When flows' copies differ, it says which flows and what differs (values read, address).
  With a case open and the page in view, the row for the page in view is marked *This page*.
- **From a flow to its templates** (`sidebar/flows.js`): in a flow's overview each page and form
  (`pageList()`) has *Template* beside it, and so does a page's editor: it opens the Templates tab at that
  template (`templateUi.open = id`).
- **Read-only here** (D12): the tab changes nothing. Changing what a page reads is done in the flow's page
  editor, where the link takes you.
- **Words**: "profile" becomes "template" wherever the sidebar says it (*Your draft v2*, "Reads 7 items with
  the library profile …", the Library page's headings). File names, schemas and code keep "profile".

Tests: `flows.test.js` for `templatesOf()`: the demo library gives the pages and forms its five flows use, each
with the right flows; the two rent support review flows share their case, tenancy and income templates; a copy
changed in one flow on this computer is `differs`; a page to visit isn't a template; a library form no flow
uses is in *Not in a flow*. A new `tests/js/templates-sidebar.test.js`: the tab lists them, a flow's link opens
the flow at the page, a page's *Template* link opens the template, *Make a flow from it* makes one.

### Step 4: the steps list and the open step (`sidebar/caseview.js`, a new `sidebar/steps.js`)

Move the steps out of `caseview.js` into `sidebar/steps.js`. `caseview.js` is imported by the full case page
(`case/case.js`, for `conflictCard`), so nothing in it may import `sidebar.js`: `steps.js` keeps to the same rule.

- From the variant: `stepsCard()` (the head, the progress bar, the list) and `stepBody()` (the open step), with
  `clipBlock()` left for step 6. Until then the open step on a page to clip shows the existing clip controls,
  taken from `contextCard()`.
- `caseview.js` exports what the step needs from it: `contextCard`, `missingInput`, `emailBlock`, `scanBlock`,
  `typeRefInput`, `refNotice`, `blockedLink`, `stepBlocked`, `STEP_ROLE`. `renderCaseTab()` calls `stepsCard()`
  first and leaves `contextCard()` out when the open step has shown the page's controls. In the variant that is
  a module variable set while rendering (`adopted`); in the extension `stepsCard()` returns
  `{ card, showsPage }` instead.
- **One main button** is worked out in one place, as data, not by changing classes on finished elements as the
  variant does. `nextAction(context, cur)` returns `{ kind, label, run }` or null:

  | The open step | Main button |
  |---|---|
  | Its page isn't the one in view, the address is known, not done | *Go to <name>* (or the flow's own link label for that address) |
  | Its page isn't in view and the address needs a value the case lacks | None. The step says which value, names the step that gives it with a link to it, and offers the box to type it |
  | A page to clip, in view, not clipped | *Clip this page* |
  | A form, in view, not filled | *Fill this form* |
  | A form, filled, not submitted | None: *On the page: check every box … submit it yourself* |
  | A page to visit, in view, not done | None: *On the page: …* (for a step that chooses the case, *open the case you're picking up*) |
  | A page to visit, not in view | Its first link |
  | An email, not opened | *Open in your email app* |
  | A fetch step, on its page, not run | *Fetch n pages* |
  | Done, and a later step isn't | *Next: <that step>* |
  | Done, and every step is | *Finish case* (not on a confirmation page, whose own card has it) |

  `emailBlock`, `fetchBlock` and `fillBlock` take `{ main: boolean }` and draw their own button green only when
  it is the main one. This table is a pure function of the case, the library and the page: put it in
  `lib/journey.js` as `nextStepAction(c, lib, { url, info, chosen })` so it is tested without a DOM.
- **The flow's own links** on a step: on a page to clip they are offered once it is clipped (until then the one
  thing to do is clip it). A link to the page in view, to the step's own address, or to the step *Next* goes
  to, isn't repeated. The others are ordinary buttons after the main one.
- **What a link needs** ("the links need Tenancy reference") is asked for only when something shown needs it,
  and says where it comes from.
- **Opening and going.** `ui.view.step` is the step chosen, as now; choosing the open one again closes it.
  Going anywhere (`act.openUrl`) clears it. A step that has just opened is scrolled into view with as much of
  the list above it as fits.
- **The case reference notice** ("set to 1001, from the case you opened", with *Change*) moves into the step
  that chooses the case. The warning for another case's page stays at the top of the card.
- Styles: the variant's `sidebar/steps.css` goes into `sidebar/sidebar.css` (the `.steps-*`, `.step*` rules).

Keys. Kept: `step-go-<id>`, `step-open`, `step-link-<i>`, `step-done`, `step-undo`, `step-current`,
`step-email-open`, `fetch-run`, `clip`, `undo-clip`. New: `steps-rail`, `steps-count`, `step-body`,
`step-next`, `step-jump-<id>`, `step-on-page`, `step-needs`, `step-needs-from`, `steps-finish`. Gone:
`steps-all` (the list is always there) and `fetch-then` when *Next* goes to the same place.

Activity log: *Next* and the arrow log `follow_step_link`, as a step's link does. No new event.

Accessibility: the list is an `ol`; each name is a button with `aria-expanded` and, for the open step,
`aria-current="step"`; its state ("done", "filled, not submitted", "to do", "the site rules block its page") is
in the name for screen readers, as today. Moving on announces "Next: <step>", as today. Focus stays on the
control pressed through a re-render (`rerender()` keeps it by `data-key`); after *Next* loads a page, focus goes
to the open step's main button. Test with the keyboard alone and with NVDA.

### Step 5: tests and words for step 4

- `tests/js/journey.test.js`: `nextStepAction()` for every row of the table, and for a step blocked by the site
  rules.
- `tests/js/flows-sidebar.test.js` and `tests/js/case-ref.test.js` use `step-link-0` for *Go to the work
  queue*: that button is now `step-open` with the same words. `steps-email-scan`, `fetch-sidebar` and
  `triage-sidebar` read the step's text and stay as they are unless they press `steps-all`.
- A new `tests/js/steps-sidebar.test.js`, in jsdom like `sidebar.test.js`: start the rent support review; at
  each point assert there is exactly one `.primary` in `[data-key="step-body"]` and what it says; assert the
  *Recognised* card is absent on a step's page and present on a recognised page that isn't a step's; *Next*
  after the last clip; *Finish case* when all are done.
- `tests/firefox/workflow.js`: one pass through a flow with steps using only the main button.
- Words: `site/try.html`, `site/reviewers.html`, `README.md`, `REVIEWERS.md`, `demo/index.html` and
  `tools/check-site.mjs` where they name *All steps* or say where *Clip this page* is. `tools/preview/shoot.mjs`
  for the screenshots.

### Step 6: the values a page gives, in the sidebar and on the page

- **`lib/gather.js`**, new, from the variant: a content script that outlines what a profile reads. Injected with
  the agent: add it to the files in `ensureAgent()` (`lib/core.js`). It answers `powerloader:showValues`,
  `pointValue`, `clearValues` (and `gatherValues`, step 7), and refuses when `atUrl` isn't the page's address,
  as the agent does.
- **`MESSAGE_ACTIONS`** (`lib/core.js`): `showValues`, `pointValue` and `gatherValues` are `['read']` (D1),
  which is what a message not listed there is checked as, so they are listed only to say so. `clearValues`
  joins the unchecked ones, like `clearNotes`. A page that may not be read is never drawn on, because it is
  never asked.
- **What goes back to the sidebar**: which fields were found, and where on the screen they are. Never their
  text. The words in a travelling value are the page's own, drawn on the page; the sidebar draws the value it
  has just stored.
- **Finding a value's element** uses `PowerLoaderExtract.locate()` with the part of the field's expression
  before its first filter. The variant has its own copy of the split; export `locatorOf(expr)` from
  `lib/extract.js` (it is `splitPipes(expr)[0]`) and use that. A list field outlines its rows (40 at most).
  Known gaps, each shown as a row with no outline, not an error: a value typed into the profile (`=…`); a value
  that is text straight after its label with no element of its own (`findByLabel` returns a string). For the
  second, `locate()` can return a `Range` later; not needed for this plan.
- **Drawing safely on someone else's page.** One host element with a closed shadow root, `pointer-events: none`,
  `aria-hidden`, removed on `clearValues` and when the sidebar closes (with the notes, in the `pagehide`
  handler in `sidebar.js`). **To check in Firefox:** a page with a strict `style-src` may refuse the `<style>`
  in the shadow root. If the Firefox suite shows that, set the boxes' styles as properties (`el.style…`) and
  animate with the Web Animations API, which a page's CSP doesn't block. Add a demo fixture with
  `Content-Security-Policy: default-src 'self'` to find out.
- **Pages that load their data late** (`autoClipDelay`): the outlines are asked for again when the wait ends
  and just before a clip, so they are on what is there then. `gather.js` re-places its boxes on resize; add a
  `ResizeObserver` on the document so they follow a page that grows.
- **`sidebar/gather-ui.js`**, new, from the variant: `valueRows()`, `valueList()` (the rows, before and after),
  `syncValues()` (called after each render of the Case tab; talks to the page only when what should be shown
  has changed). `clipBlock()` in `steps.js` uses them, and so does the *Recognised* card (a page a fetch step reads, opened
  by hand: the only recognised page that isn't a step's).
- Values in the rows are shown with `display()` (`lib/fields.js`), as everywhere else in the sidebar.
- The clip's summary pills, *Clip again*, *Undo this clip* and the link to change the profile come after the
  main button, so *Next* is never pushed out of view by them.

Tests: `tests/js/gather.test.js` with `helpers/agent.js` extended to load `gather.js`: fields found on
`demo/cm/case-1001.html` match the profile; a missing field is reported missing; nothing is returned but keys
and numbers; a wrong `atUrl` is refused; `clearValues` leaves the document as it was. In
`steps-sidebar.test.js`: the rows before and after a clip; a page where `annotate` is blocked and `read` isn't
is outlined all the same; a page where `read` is blocked is sent nothing. jsdom has no layout, `matchMedia`
or `Element.animate`: `gather.js` and `gather-ui.js` must work without them (treat them as "less motion"), which is also the safe behaviour in a browser that lacks one.

### Step 7: the values travel, and auto-clip waits for the outlines

The variant wraps `act.clip` from outside. In the extension it is part of the action.

- **`act.clip()`** (`sidebar/sidebar.js`): after `clipTab()` has stored the clip and the sidebar has rendered,
  and only if the tab is still on that page and the Case tab is showing, call `gather(ctx(), profile, clip)`
  from `gather-ui.js`. Its failure is never the clip's failure: it is caught and the rows simply have their
  values.
- **Auto-clip** (`refreshPage()`): after any `autoClipDelay`, ask the page to outline its values, and start the
  clip `AUTO_CLIP_SHOW_MS` (350) after asking, or when the page has answered if that is later. Reading the page
  and storing the clip takes another 150 to 300 ms, so the values start to move about half a second after the
  page is recognised (D3; the lab measured about 0.4 s on the demo case page, which is quick to read). Before
  clipping, check again that the tab, the page and the case are the same and the page isn't clipped, as the existing wait does. The outlines are all
  drawn within about 150 ms however many there are (`gather.js`: each starts 22 ms after the one before, none
  later than 130 ms). With less animation asked for (D7) there is no wait.
- **Which side is the sidebar on?** The value has to leave the page towards it. Firefox gives every window
  `mozInnerScreenX/Y`: the sidebar sends its own with the message, and the page compares. **To check in
  Firefox**, with the sidebar on each side, at 100% and 150% display scaling, and with
  `privacy.resistFingerprinting` on (the numbers may be zeroed). When they can't be had or don't make sense,
  the values leave to the left (Firefox's default side) and arrive at the height of their rows. The lab fills
  the numbers in for other browsers (`lab/shell/shell.js`, `screenShim`): keep that.
- **Timing.** The page answers with when each value will reach its edge; the sidebar starts that value's
  arrival then. Each is independent: a value whose row has gone (the caseworker changed tab) is just marked
  arrived.
- A second clip of the same page (*Clip again*) travels too. A page fetched by a fetch step doesn't: it was
  never in view. Its row in the step's list is its feedback, as now.

Tests: in `steps-sidebar.test.js`, a clip ends with every row holding its value whether or not the page
answers; an automatic clip doesn't happen before the outlines are asked for; leaving the page during the wait
clips nothing. In `tests/firefox/workflow.js`: clip with the sidebar on the left and on the right and assert
the rows are filled and the page's outlines are in their done state; auto-clip on a page with `autoClipDelay`.

### Step 8: steps with a condition (`lib/journey.js`, `lib/flows.js`, `sidebar/flows.js`, the demo flows)

The rent support review's third step is an email asking the client for their tenancy reference, "only if the
case has no Harbour Homes tenancy reference". Today the caseworker has to open it, read that, and press *Sent
another way, or not needed*. The flow should say when the step is needed.

- **In `steps.json`**, one new optional key on a step:

      when: { field: 'tenancyRef', is: 'missing' }      // or is: 'present'

  `field` is one of the library's field keys, or `ref` for the case reference. One condition a step: enough for
  the cases seen so far, and it can become a list later without changing what exists. `validateSteps()` checks
  the shape and that the field exists.
- **What "missing" means.** The case has no value for the field: `fieldState(c, lib, key).status === 'missing'`.
  A field with a conflict isn't missing (the value is there, and is the caseworker's to decide), so a step
  that asks for it isn't needed.
- **When it is judged.** A value can't be called missing before the pages that give it have been looked at. A
  step with a condition is judged once every step before it is done or not needed. Until then it is listed as
  to do, with *If needed* beside it. From then on it is judged afresh each time the sidebar draws: a value
  removed later (a clip undone) brings the step back.
- **In `lib/journey.js`**: `stepNeeded(c, lib, step)` gives `true`, `false` or `null` (not judged yet).
  `stepStatus()` gains a fourth answer, `'skipped'`, for a step that isn't needed and hasn't been done.
  `currentStep()` and `nextStepAction()` treat `skipped` as done, so *Next* passes over it. A step the
  caseworker marked done, or did, is `done` whatever its condition says.
- **In the list**: a step that isn't needed has a dash where the tick would be, its name greyed, and *Not
  needed* beside it. Opened, it says why ("Only when the case has no Tenancy reference. This case has one.")
  and has one ordinary button, *Do it anyway*, which opens it as a normal step for this case
  (`c.steps[id] = { wanted: true }`). The count says "5 of 8 steps done · 1 not needed".
- **The activity log**: nothing is logged for a step passed over, since the caseworker did nothing. *Do it
  anyway* logs `complete_step`'s neighbour, a new `reopen_step`.
- **Writing it in a flow** (`lib/flows.js`, `sidebar/flows.js`): `page.step.when`, set with
  `setStepWhen(page, when)`, exported to `steps.json` and read back on import. In the step editor
  (`stepEditor()`), under the instructions: *This step is needed* · *always* / *only when the case has no …* /
  *only when the case has …*, and the field, chosen from the flow's fields and the case reference
  (`fieldChoices()`). `validateFlow()` reports a condition on a field the flow doesn't have, on the first step,
  and on a step that chooses the case, each with a fix (*Remove the condition*).
- **The step's own page still counts.** A page to clip that isn't needed can still be opened and clipped: the
  page in view is always the open step. A condition changes what *Next* does and what the list says, never
  what the caseworker is allowed to do.
- **The demo** (`tools/build-demo-flows.mjs`): *Ask the client for a missing reference* gets
  `when: { field: 'tenancyRef', is: 'missing' }` in both rent support review flows, and its text loses "If the
  case has the reference, skip this step with …". Every demo client has a tenancy reference
  (`system-homepages-and-inbox-triage.md` says so), so the step is always passed over in the demo. Give a few
  clients none in `tools/build-demo-systems.mjs`, so the demo and the tests have a case where the step is
  needed. Rebuild the demo library (`pnpm demo:systems`, `tools/build-demo-library.mjs`, `pnpm check:demo`).
- **The AI that drafts steps** (`askSteps()` in `sidebar/flows.js`, its prompt,
  `extension/prompts/flow-steps.md`): tell it `when` exists, so guidance that says "only if" becomes a condition rather than a sentence.

Tests: `journey.test.js` for `stepNeeded()` and `stepStatus()` (missing, present, a conflict, not judged yet, a
value removed after the step was passed over, marked done by hand, *Do it anyway*); `validateSteps()` for a bad
`when`. `flows.test.js` for the round trip through export and import and the three `validateFlow()` problems.
`steps-sidebar.test.js`: on case 1001 *Next* after the case page is *Harbour Homes tenancy*, not the email; on
a client with no tenancy reference it is the email. `demo.test.js` / `library-flows.test.js` for the rebuilt
flows. The film's line about skipping step three is rewritten ("Step three is only for a case with no
reference, so it is passed over") and its check with it.

### Step 9: mending a flow from a case (`sidebar/steps.js`, `sidebar/flows.js`, `lib/core.js`)

After steps 2, 4 and 8, which it uses. This is the one place Casework reaches into Build.

- **A page that isn't in the flow.** Under the steps list, not in place of the open step, an information box
  (`.notice`, not a warning: nothing is wrong with what the caseworker did):

  > **Is this flow incomplete?** This page isn't one of its steps. If you are using it to complete this case,
  > it should be in the flow, perhaps as a step that is only sometimes needed.
  > [Add this page to the flow]   Not needed for this flow

- **Where it is shown** (D15): on any web page, with a case open, that the site rules allow Power Loader to
  read (`allowed(data.access, url, 'read')`: the allow and disallow lists, from policy, the library and the
  caseworker's own). Not only on the systems the flow already uses: people shouldn't be browsing at random in
  the middle of a case, so a page they are on is taken to be part of the work. Never on a page the rules
  block, on a page of another case (`info.otherRef`), on Power Loader's own pages, or on a page a fetch step
  reads (it is in the flow already). Where Firefox hasn't yet been given the site, the existing *Allow on
  <host>* card comes first, as now.
- **Putting it away** (D16): *Not needed for this flow* records the page's address, without its query, in the
  case (`c.notInFlow: [address]`) and the box isn't shown there again for this case. It goes when the case
  does: the next case may need the page.
- **Adding the page.** *Add this page to the flow* changes to Build with the case's flow open and the *Add
  this page* card of step 2 up. A flow from the library is copied to this computer first, as *Make a copy to
  edit* does (`copyLibraryFlow()`), and the box says so before it is pressed: "This flow is from your
  library, so a copy is made on this computer for you to change" (D18). Two things are filled in from the
  case: the new step goes **after the step that was open** (`flow.journey`), and the card has *Only needed
  sometimes*, which opens the step's condition (step 8).
- **The open case takes the changed flow, when asked** (D17; `lib/core.js`). New
  `updateCaseFlow(caseId, flowId)`: compile the flow as `startFlowCase()` does (`flowSet()`), add its set,
  point the case at it (`c.library = { commit, flow }`), keep the clips, the decisions and the reference.
  Steps marked done are kept by step id, which a flow's pages keep when the flow is changed and when a
  library's flow is copied (check `copyLibraryFlow()` keeps page ids; make it if it doesn't). A step that no
  longer exists drops out. A flow that no longer has a form the case has filled is refused, with a message.
  A clip made with a template the changed flow no longer has is kept, as a clip from a removed page is today.
  It is always the caseworker's choice, never done for them: offered as *Use the changed flow for this case*
  in Build, on the flow's overview while that flow's case is open, and by the page editor when a page added
  from a case passes its test; and in Casework as a line on the steps card, "This flow has been changed on
  this computer since the case started · *Use the changed flow*", whenever the case's flow (or the copy made
  from it) has a newer `updated` than the case's set. The activity log records a new `update_flow` event with
  the flow's name, never its contents.

Tests: `steps-sidebar.test.js`: with the rent support review open, a Case Manager page that isn't a step shows
the box, and so does the demo's index page (another site the rules allow); a page the rules block doesn't;
another case's page doesn't; *Not needed for this flow* hides it for that page until the case ends. *Add this
page* copies the library's flow, opens Build, and the new step is after the one that was open. A new
`tests/js/flow-update.test.js` for `updateCaseFlow()`: clips, decisions and done steps kept; a removed step
dropped; a missing form refused; a case that has ended refused; the event logged without the flow's contents.
`tests/firefox/workflow.js`: in a case, add a page from the box, test it, use the changed flow, clip the new
page, finish.

### Step 10: the lab, the film and publishing

- Delete `lab/variants/flow-ux/`: the extension is now what it was. `lab/` stays, with `base` only, for the
  next experiment. `lab/film/record.mjs` takes `--variant base`; record again and check it still passes its own
  checks (each number the narration says is checked against the screen).
- `tools/ci-local.sh`: `lab/*` changes need no job beyond lint. Confirm `tools/check-lint.mjs` covers
  `lab/` or leave it out on purpose and say so in `lab/README.md`.
- Release notes and the version in `extension/manifest.json`; then `tools/publish.sh` once, for the whole of
  steps 1 to 9 (or twice: steps 1 to 5 first).
- `lab/baseline.mjs` and `lab/film/record.mjs` start the flow from the old start screen
  (`[data-key^="start-flow-"]`, the *Start case* dialog): bring them up to date with step 1's.
- By hand in Firefox before publishing: the rent support review and the inbox triage from start to finish
  with the keyboard alone; NVDA on the steps list; the sidebar on the right; a narrow sidebar (the minimum
  width Firefox allows) for the value rows and the long *Next* label.

## What could go wrong

| Risk | What limits it |
|---|---|
| The outlines cover something the caseworker needs to click | `pointer-events: none`, a 2 px border and a light tint; removed with the sidebar. |
| A page's own styles or CSP break the drawing | Closed shadow root; the CSP fixture in step 6 decides between a `<style>` and styles set as properties. |
| Outlines in the wrong place on a page that moves (sticky headers, late content) | Boxes are placed in the document, not the window, and re-placed on resize and when the document's size changes. |
| The *Is this flow incomplete?* box nags | One box, under the steps, never in place of the next thing to do; put away for a page with one click (D16). If it still nags in use, that is a finding about how people work mid-case, and D15 is the decision to revisit. |
| A caseworker's copy of a library flow drifts from the library's | The copy says where it came from (`flow.fromLibrary`) and can be exported for the library team. Telling a caseworker when the library's flow has since changed is not in this plan. |
| Auto-clip feels slower | Half a second a page in all (D3). It shouldn't be zero, or the caseworker never sees what was read. |
| A list with hundreds of rows | 40 rows outlined at most; the row in the step says how many rows the clip has. |
| Two cards' worth of logic in one step makes `caseview.js` harder to follow | `steps.js` owns the steps; `nextStepAction()` is a pure function with its own tests. |
| A flow's text names a button that has moved | Labels are kept (see *What doesn't change*). `tools/build-demo-flows.mjs` texts were read for this plan; a library team's own flows can't be. Say so in the release notes. |

## For whoever builds this

**Start here.**

1. Read `CLAUDE.md` (the repo's and the owner's). This repo is private; commit and push to `origin` as work
   lands. Nothing goes to the public repo except through `tools/publish.sh`, and only when a piece is finished.
2. See the thing working before reading the code. `node lab/serve.mjs` (stop `pnpm demo` first: same port),
   then http://localhost:8787/lab/shell/?variant=flow-ux&fresh=1 and the same address with `variant=base`.
   Start *Rent support review* from the flows at the bottom of the start screen and work it in both. Watch
   `dist/lab/flow-ux.mp4` if it is there (`node lab/film/record.mjs` makes it; about two minutes).
   `lab/README.md` explains the lab. `node lab/baseline.mjs base` and `… flow-ux` write the sidebar's words at
   each point of the flow to `dist/lab/<variant>-walk.txt`: the quickest way to compare before and after.
3. The variant's code is the reference for steps 4 to 7, not the thing to ship:
   `diff -u extension/sidebar/caseview.js lab/variants/flow-ux/extension/sidebar/caseview.js` is the whole of
   step 4; `lab/variants/flow-ux/extension/lib/gather.js` and `…/sidebar/gather-ui.js` are steps 6 and 7.
   Each step above says where the extension's version differs from the variant's (one main button as data,
   not by changing classes afterwards; `act.clip` changed, not wrapped; `adopted` returned, not a module
   variable).

**What the lab does not have**, so there is nothing to copy: steps 1, 2, 3, 8 and 9. In the lab the start
screen still has forms, there are no modes and no Templates tab, step three of the rent support review is
skipped by hand, and a page outside the flow shows the old *Not recognised* card.

**Keep the lab working as you go.** It runs the extension's own files, so each step shows up at
`?variant=base` as soon as it is built, and the variant's overrides (`caseview.js`, `sidebar.html`) will fall
behind the files they copy. When step 4 lands, delete the variant's `caseview.js`, `steps.css` and
`sidebar.html`; when 6 and 7 land, the rest (step 10 says so). The lab is the quickest way to look at any step
by eye: Playwright can drive it (`lab/drive.mjs`, `openLab()`), and on this machine use the `playwright-wsl`
notes (the project's own `@playwright/test`, never `playwright install`).

**Things that will bite.**

- `sidebar/caseview.js` is imported by the full case page (`case/case.js`). Nothing it imports may import
  `sidebar/sidebar.js`, or the case page starts a second sidebar.
- The sidebar re-renders by replacing everything (`rerender()` in `ui/dom.js`). Anything that must outlive a
  render (an animation in flight, which step is open) is module state, and every control needs a stable
  `data-key` or it loses focus.
- The sidebar's tests run in jsdom: no layout, no `matchMedia`, no `Element.animate`, no `Range` rectangles.
  Code for steps 6 and 7 has to work without them. What only a browser can show (where the outlines are, the
  travel, which side the sidebar is on, a strict page CSP) is tested in the Firefox suite (`tests/firefox/`,
  `pnpm test:firefox`) and by hand.
- Every message to a page goes through `ask()` in `lib/core.js`, which checks the site rules for it. Don't
  send to a tab any other way.
- A case's steps are stored as the `steps.json` inside the set its flow compiles to (`flowSet()`,
  `compileSteps()` in `lib/flows.js`). Step 1 stops reading a *library's* `steps.json`; it doesn't touch that.
- `data-key`s are what the tests and the film press. The ones that stay, go and are new are listed in step 4.
- The demo library is generated: `tools/build-demo-flows.mjs`, `tools/build-demo-library.mjs`,
  `tools/build-demo-systems.mjs`, checked by `pnpm check:demo`. Change the generators, not `demo/library/`.
- The film checks what it says against the screen and stops when they differ. After steps 1, 2 and 8 its
  script (`lab/film/script.mjs`) and recorder need bringing up to date, and changed lines need their voice
  made again (`node lab/film/voiceover.mjs`, which only makes the lines that changed).

**Checks.** `pnpm test` after every step. `tools/ci-local.sh --only <job>` for the job a step touches.
`pnpm test:firefox` after steps 2, 4, 7 and 9. Before publishing, the whole local CI through
`tools/publish.sh`, and the hand checks in step 10.

**Only checkable in Firefox, and not yet checked:** that a page's CSP lets the outlines be styled (step 6);
which side the sidebar is on, from `mozInnerScreenX` (step 7). Each has a fallback written into its step. Find
out early: both decide how `gather.js` is written.

**If something here turns out wrong** (a function has moved, a decision doesn't fit what the code can do),
change this file in the same commit and say what and why at the top, as the other plans do under "Where the
build differs". Decisions D1 to D21 are the owner's: a change to one of those is a question for him, not a
judgement call.

## Not in this plan

- **Renaming things in the code and the library to the four words.** The library still has "forms" and
  "profiles", and a step's kinds are `input`, `output` and so on. The sidebar's words change here; the files'
  don't.
- **Templates as one shared thing** (D12): a template changed once for every flow that uses it, made and
  tested on the Templates tab, with flows pointing at templates instead of carrying copies. That changes the
  flow file, export and import, and how a flow compiles. The index in step 3 is what shows whether it is
  needed: if copies rarely differ, flows are already sharing in practice.
- **More than one condition on a step**, or a condition on anything but a value being there (its amount, a
  date, an answer on a form). `when` is one field, present or missing.
- **A case that isn't one run of one flow**: two flows in one case, or changing to a different flow part-way.
- **Values travelling into a form** when it is filled, to match the clip. The fill already marks the boxes it
  filled on the page.
- **Redesigning the flow editor itself.** Build gets a mode, a card for adding the page in view and a
  condition on a step. The editor's own screens (the overview, the page editor, timelines) stay as they are.
