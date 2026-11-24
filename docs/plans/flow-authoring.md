# Authoring flows without a library

Created: 2026-11-24. Status: built (0.9.0).

## Why

Before this, Power Loader did nothing useful until a forms library was connected: the draft editor needed the library's field list, forms and approved hosts. The people who write the library had no way to make one in Power Loader. A **flow** is what they author: the forms a case fills, the pages it clips from and the contract between them. A flow is a small library of its own, so it needs no library to start.

## What a flow is

```text
Flow { schema: 'powerloader-flow/1', id, name, guidance, created, updated,
       fields: { key: { label, type?, options?, long?, manual? } },   the contract
       pages: [Page] }
Page { id, role: 'output' | 'input' | 'guide', name, url, required: [key], draft: Draft | null,
       match? (guide), step?: { text, links: [{ id, label, url, to }] } }
Flow.journey?   [pageId], the order the caseworker takes the pages
Flow.timelines? [{ id, name, series: [{ id, label, kind: 'bar' | 'point', colour, shape, gaps,
                  source: { type: 'page', pageId, rows, label, start, end, at } | { type: 'fields', start, end, at } }] }]
```

- **Output pages** are the forms to paste into. Each output page's draft is a fill draft (form box → contract field). The fields its boxes map to, and which of them are required, define what the flow must collect.
- **Input pages** are the pages to clip from. Each input page's draft is an extraction draft (contract field → selector).
- **The contract** is `fields`: every value the flow moves, defined once, with a type the library's validators understand. A field marked `manual` is typed by the caseworker (a declaration, the reason for applying), so no input page needs to provide it.
- Page drafts are the same objects as library drafts (`lib/drafts.js`), so picking, testing, leak checks and the export body are shared.

- **Guide pages** ("Pages to visit") are pages the caseworker goes through that Power Loader neither clips nor fills: a work queue to pick the next case from, a search page. A guide page has an address and a match pattern, and no draft.

A new flow starts with one output page and one input page. More of either can be added; the last of each can't be removed. Guide pages are optional.

## Authoring, output first

1. **Flows → New flow.** Name it and, optionally, paste guidance (both save as you type): what the flow is for, which forms and pages, what to collect. The demo's index page has guidance to paste.
2. **Edit the output page.** If its address isn't set, the sidebar offers **Use the current form** (the page in this tab; Firefox asks to allow Power Loader on the site first if needed, in the same click) or a box to paste the address and **Go to it**, which keeps the address and opens it in this tab. Using the page records its address and match pattern, and the AI and manual tools appear.
3. Make its profile one of two ways:
   - **✦ Generate the extraction profile with AI.** The form's boxes (labels, types and options, never what's typed in), the page title, the link shape, the guidance and the contract so far go through the usual redaction preview. The AI says which fields the form collects, with a key, label, type and whether each is required or typed by the caseworker, and which box each goes in. New fields join the contract; each mapping is marked *Check this*.
   - **Make it by hand.** Type a field's name in the box at the top (a typeahead over the contract, the connected library's fields and the form's own labels) and choose it, or add it as a new field. Then click its box on the page. Every box on the form is outlined while the editor is open.
   The manual tool always works on top of an AI result.
4. **Open each input page** and do the same. The AI gets the reduced page HTML, redacted, with the guidance and the contract fields, and returns selectors (the existing ✦ Suggest a profile request). By hand, the typeahead lists the contract fields still to find; click the value on the page. *Pick something that isn't outlined* reaches anything else.
5. **Test** each page on the page itself. Tests are the same as for drafts: every field matches one element and passes its validator, and no value from the page appears in the profile.
6. **Save and export.** Flows are saved as they change. **Export** downloads one `powerloader-flow/1` file that holds the flow and the library files it becomes (`fields.json` entries, `forms/…`, `profiles/fill/…`, `profiles/pages/…`), ready for a maintainer to add to the library. **Import a flow** opens one again, for example on another computer; its pages must be tested again there.

## Guiding the caseworker

Once a flow is made, a caseworker shouldn't need the written guidance again: the flow carries it, step by step.

- **The steps** are the flow's pages in the order the caseworker takes them (`journeyOf()`: the author's order, then pages not yet placed, guide pages first, then pages to clip, then forms). The overview lists them under *The caseworker's steps*, with ↑ and ↓ to reorder.
- **Each page's step** has instructions ("What the caseworker does here") and links to the next step. A link opens another page of the flow (`to`), or any address. Its address is a template: `{ref}` is the case reference and `{fieldKey}` is the case's value for that field, URL-encoded, so a link can carry a case number or a search (`search?q={lastName}`). A link to a page with no address of its own opens that page's address: a form's address, or a page to clip's link pattern.
- **✦ Write the steps from the guidance** sends the guidance and the pages' names, roles and link shapes (never their content) through the redaction preview. The AI returns instructions and links for each page; only known page ids, web addresses and `{names}` are kept. Steps the author has written are kept as they are.
- **Compiled** into `steps.json` (`powerloader-steps/1`, see `lib/journey.js`) when the flow has a guide page or any instructions or links. Guide pages carry their address and match pattern; pages to clip their profile id; forms their form id.
- **In a case**, the Case tab shows a Steps card: the step for the page in the tab (a guide page by its address, a page to clip by its profile, a form by its fill profile), else the first step not done, with its instructions, *Go to* its page, and its links filled in from the case. A link that needs a value the case hasn't got says so, and the value (the case reference, or a field) can be typed right there. A page to clip is done once clipped, a form once submitted, a guide page once its link to another page is followed or it's marked done; any step can be marked done or skipped. *All steps* lists them with their status. Following a link, completing and skipping steps are logged (`follow_step_link`, `complete_step`, `skip_step`), with the step's name only.

## Timelines

A flow can say which dates the case's timeline shows, as named timelines of series.

- **A series** is a lane: **bars** (a start and an end date; an empty end is ongoing) or **pointers** (one date each). Bars have a colour and say whether they count when finding gaps; pointers have a colour and a shape (circle, square, diamond, triangle). Colours are named (blue, green, orange, purple, red, teal, pink, brown, grey) or any `#rrggbb`.
- **Its dates** come from **rows on a page to clip** (a selector for the rows, and within each row its name, start and end, or date) or from **the flow's date fields** (for example a pointer for the tenancy start date). *Pick* on the page: clicking a cell in a table sets the rows and the part within them (`splitRowSelector()`). *Test on this page* reads the series from the page in the tab and shows how many dated rows it found; nothing from the page is kept.
- **Compiled**: a page series becomes a list field of its page profile, `tl_<series id>: [rows, { "@type": "tlbar" | "tlpoint", label, start, end | at }]`, so a clip carries its rows as records; `timelines.json` (`powerloader-timelines/1`) names each timeline's series, colours and shapes, and where their dates come from.
- **In a case**, the timeline tool's *Show* offers the flow's timelines first, then *Only the ticked dates* (the periods and dates ticked below, as before) and *All dates in the case* (every period, every series and every date field, as pointers). Gaps are measured over the bars that count for gaps.

## Validation

`validateFlow()` runs on every render, so problems show as soon as they exist: on the flow's overview, and on each page for its own problems. Each one says what to do and offers a manual fix (go to the page, mark the field as typed by the caseworker, remove it), and where an AI can help, **✦ Fix with AI**, which runs the page's AI request for just the fields concerned.

| Problem | Level | Fixes |
|---|---|---|
| The flow has no name | error | type one |
| A page isn't made yet, or maps nothing | error | open it; ✦ |
| A page changed since its test, or failed it | error | test it; ✦ for failing fields |
| A required field no input page gathers | error | open an input page and add it; ✦ find it on an input page; mark it typed by the caseworker |
| An optional field no input page gathers | warning | the same |
| An input page reads a field no form uses | warning | remove it from that page |
| A contract field nothing uses | warning | remove it |
| A link with no address, not a web address, or a `{name}` that isn't `ref` or a field | error | edit the link |
| A page to visit with no address | warning | open it on its page |
| A timeline series with no page, no rows or no date, or a field that isn't a date | error | edit the timeline |
| A timeline with no series | warning | add one |
| The compiled files fail the library's checks | error | as the message says |

Export is allowed with problems (the file lists them, and a maintainer can't publish it until they're fixed), except when a page's test found page values in its profile.

## Where flows come from

- **Made here**: Flows → New flow.
- **A file**: Flows → Import a flow, for a `powerloader-flow/1` file someone exported. Its pages need a test on this computer.
- **A library**: Flows → *Make a flow from a library form* (when a library is connected). `flowFromLibrary()` copies the form (id, version, rules, confirmation page, side effects), its fill profile, every page profile that reads one of its fields, and those fields' library definitions (identity, placeholder categories, privacy). A copied profile counts as tested, because the library published it, until it is edited. A page profile that also reads fields the form doesn't use keeps only the form's fields, so it is no longer the published profile and needs a test here. The library itself is never changed.

## Starting a case from a flow

Any flow can start a case: **Start case** on the Flows list or the flow, or **Start** under *Flows* on the Case tab (shown with or without a library). `startable()` needs at least one form with a fill profile, and compiled files that pass the library's checks. Pages that haven't been tested here, failed their test or aren't made yet are listed in a confirmation first; values are still validated as they are clipped.

`startFlowCase()` (`lib/core.js`) compiles the flow with `flowSet()` and stores it in `library.sets` under a commit of its own, `flow-<flow id>-<content hash>`. The case pins that commit exactly as it pins a library commit, so everything that reads a case's library (sidebar, case page, background logging, filling, confirmation pages) works unchanged, and editing the flow during the case doesn't change it. The case records `library.flow = { id, name }`: it is never offered a library update, and *Update this profile* sends you to the Flows tab. A connected library lends its privacy patterns and identifier types. Flow sets are pruned when the next case starts from a flow, and by library sync once no case uses them.

## Not in this version

- A library's own `steps.json` and `timelines.json` are indexed and validated (`indexLibrary()`), but *Make a flow from a library form* doesn't copy them yet.
- Picking a timeline's cells works for tables and lists; anything else needs its selectors typed.
- Repeating rows, nested groups and conditional sections, as for drafts.
- Approved hosts: without a library, the hosts of the flow's own pages are allowed. The export lists them so a maintainer can check them against the approved systems list.
- A library can't publish flow files yet; a flow is made from its forms instead.
