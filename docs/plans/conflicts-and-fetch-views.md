# Conflicts you can see and follow, and fetches you can watch and review

Created: 2026-11-26. Status: built on the branch `conflicts-and-fetch-views` (steps 1 to 9), not yet published. From the owner's notes on trying 1.1.0. Builds on `flow-steps-ux.md` (the steps list, the values outlined on the page, values travelling to the sidebar), `fetch-steps.md` and `json-clips.md` (pages and JSON read in the background) and `site-access-lists.md` (the site rules every action is checked against).

## What's built

`clipValueState()`, `clipTally()` and `addTallies()` in `lib/case.js` give each clip's line from the case as it is now; `tallyLine()` and `goToCard()` in `sidebar/gather-ui.js` draw it and take a conflict's name to its card (`#cf-card-<key>`, focused and ringed). On the page (`lib/gather.js`), a conflict is outlined in orange with a ⚠ Conflict badge, and a card's source link (`sourceLink()` in `sidebar/caseview.js`, through `act.openUrl()`) holds its value in orange once the page is recognised (`pointValue` with `hold`), or the sidebar says it isn't there now. Reveal rules are a template's `reveal` (checked by `validateReveal()` in `lib/extract.js`), applied and put back by `reveal()`/`putBack()` in `lib/gather.js`, with `<details>` and `hidden` opened without a rule and the Build recorder (`revealCard()` in `sidebar/flows.js`, `powerloader:revealBefore`/`revealAfter`). Fetch boxes are `powerloader:fetchBox` in `lib/gather.js`, fed by `runFetchStep()`'s `onShow` with the text view from `lib/fetch-view.js`; each fetched clip keeps `excerpts`, shown in the Fetched view of the case page (`fetchedView()` in `case/case.js`). The demo tenancy page's arrears are in an accordion its template's rule opens.

**Where the build differs.** Orange is `#a33c00` for text (6.6:1 on white) and `#d55a00` for edges (4:1). A fetch step's summary sentence ("Fetched 6 pages: 2 values added") stays as it was, with the new line under it (`fetch-tally`), so it is still the live region's sentence. The automatic "this value has no size, open its section" prompt in Build isn't there: a value can't be picked by clicking while it has no size, so the recorder starts from the card's *It's in a closed part* instead. Opening a `<details>` lets the page see a `toggle` event, and class changes can be seen by the page's own `MutationObserver`s: Power Loader dispatches nothing itself. The fetched view's *Fetch again* goes back to the sidebar and runs the step if the tab is on its page.

## Why

Three things were unclear when working a case in 1.1.0:

1. **A conflict is easy to miss and hard to follow.** After a clip the step says "2 conflicts: Address, Postcode" in a pill. The values in conflict look like every other value in the step's list and on the page. The cards where a conflict is decided are further down the sidebar, with nothing joining the two. A card names the pages that disagree but doesn't take you to them, so checking which one is right means finding the page and the value yourself. And once a conflict is decided, the step's line still says "2 conflicts".
2. **A value can be on the page but out of sight**, inside a closed accordion or an unselected tab. Power Loader reads it, but can't show it.
3. **A fetch step is a button and then a number.** "Fetch 6 pages", then "Fetched 6 pages: 2 values added". Nothing shows which pages were read, what was taken from each, or where in the response it was. There is no way back to look afterwards.

The rule from `flow-steps-ux.md` holds throughout: the caseworker sees what is taken, where it comes from, before and after.

## What exists today

- `lib/case.js` `fieldState()` gives each field `ok`, `resolved`, `manual`, `missing` or `conflict`, with the candidate values and the clips each came from. `addClip()` returns a summary (`added`, `agreed`, `conflicts`) that is true at the moment of the clip. `clipValueState()` already says, for one value of one clip, whether it is in conflict, used or overridden.
- `sidebar/steps.js` shows that summary as pills from `ui.lastClip`, so it never changes after the clip.
- `sidebar/caseview.js` `conflictCard()` lists each candidate value with the names and times of its source clips, as plain text, with *Use this* and a box to type the right value. The cards are in `#conflicts`.
- `lib/gather.js` draws the outlines on the page from a closed shadow root: blue before a clip, green with a tick after. `powerloader:pointValue` marks one value and can scroll to it.
- A clip keeps its page's address (`clip.url`) and, in the schema, `quotes: { key: text }`.
- Fetch steps (`lib/fetch-steps.js`, `sidebar/fetch-ui.js`) make each request from the trigger page's tab, read the response and add a clip. Nothing is drawn on the page, and the response isn't kept.

## 1. Conflicts on a clipped page

### In the step and on the page

- A value in conflict is **orange, with a ⚠ and the word "Conflict"**, in the step's value list and in its outline on the page. Orange, not red: red in the sidebar means something is blocked or broken, and a conflict is a decision waiting. Never colour alone: the icon and the word are always there.
- The row in the step's list is a link to that field's conflict card (below).
- A value whose conflict has been decided goes back to green, with what happened beside it: *used* (the caseworker chose this page's value) or *overridden* (they chose another, or typed one).

### The step's line, kept up to date

The pills are replaced by one line, worked out from the case as it is now, not from the moment of the clip:

> 3 matched · 2 new · ⚠ 2 conflicts: [Address](#), [Postcode](#)

and after deciding:

> 3 matched · 2 new · 1 used · 1 overridden

- **matched**: other pages agree. **new**: only this page has it. **used** and **overridden**: a conflict that has been decided, for or against this page's value. **conflicts**: still to decide.
- Each conflict's name is a link to its card further down the sidebar: the card scrolls into view, takes focus, and is ringed for a moment.
- A count of zero isn't shown. "rows for tools" and "extra kept" stay at the end as they are.
- The same line is used wherever a clip's result is shown, including a fetch step's summary.

### From a conflict card back to the page

Each source named on a conflict card becomes a link:

> **12 Harbour Road** · [Case management 14:02](#) · [Use this]
> **12 Harbor Rd** · [Rent account 14:05](#) · [Use this]

- The link goes to that clip's page, in the case's tab, through the same navigation a step's arrow uses (so the site rules' `navigate` check applies, and a blocked page's link is disabled with the reason).
- When the page has loaded and is recognised, the value is scrolled into view and outlined in orange with ⚠, and stays so until the caseworker moves on. If the value isn't on the page any more (the page changed), the sidebar says so: "Address isn't on this page now. It read 12 Harbor Rd at 14:05."
- A source that isn't a page in a tab has a different link: a fetched page opens its fetched view (section 3); a screenshot, typed value or AI reading has no link.
- Already on that page: no navigation, just the scroll and the outline.

## 2. Values out of sight: reveal rules

A flow's page template can say how to bring a hidden part of the page into view. It is part of the flow's definition, so it is written once in Build and travels with the flow.

```json
"reveal": [
  { "selector": "#tenancy-history", "addClass": ["govuk-accordion__section--expanded"] },
  { "selector": "#tab-arrears", "removeClass": ["govuk-tabs__panel--hidden"] }
]
```

- **What a rule may do, and nothing else:** add class names to, or remove class names from, the elements a selector matches; and for standard HTML, set `open` on a `<details>` and remove the `hidden` attribute. No clicks, no scripts, no styles of Power Loader's own, no other attributes. Clicking is ruled out because a click runs whatever the page attached to it, which could submit, navigate or change a record.
- **Built in, with no rule needed:** a value inside a closed `<details>` or under a `hidden` attribute is opened the same way. That is plain HTML and can't run anything.
- **When it is applied:** only when Power Loader needs to show a value that has no size on the screen: on pointing at its row, on following a conflict's link, and when the page's values are outlined. Reading never needed it (a value is read from the page whether or not it is in view).
- **Undone afterwards:** what was changed is remembered and put back when the outlines are cleared, so the page is left as it was found.
- **Checked like the rest of a template:** selectors validated as profile selectors are; class names must be plain tokens; at most 20 rules a page. It is checked against the site rules as a `read`, since it only shows what is already being read. (If a team would rather it counted as `annotate`, it is one line in `MESSAGE_ACTIONS`.)
- **What it can't do:** a section whose content is only fetched when it is clicked has nothing to reveal. Then the value's row says "in a closed part of the page: open *Tenancy history* to see it", naming the section from its heading.

**Making a rule, in Build.** When a value picked in Build has no size on the screen, or the author says a value is in a closed section, the editor asks them to open that section on the page by hand. Power Loader compares the classes and the two attributes on the value's ancestors before and after, and offers the difference as the rule: "To show this, Power Loader will add `…--expanded` to *Tenancy history*." The author accepts or drops it. Nobody types a selector.

## 3. Fetch steps: watch them, and go back to them

### While it runs: a box on the page for each fetch

When a fetch step runs, each request gets a box drawn on the trigger page, in the same layer the outlines use:

- The box is titled with what is being read (the request's name and the page's address) and shows a **text view** of what came back: for a page, its readable text; for JSON, the response laid out with one key to a line.
- The values the template reads are **outlined in the box**, exactly as on a real page, and then **lift out and travel to their rows** in the sidebar, as a clip's do.
- **If the response is bigger than the box, the box scrolls** to each value in turn before it lifts, so a value deep in a large JSON response is seen where it sits.
- A value in conflict is orange with ⚠ here too.
- When a request is done its box shrinks to a line in a strip along the bottom of the page: "✓ Message 3 of 6: 1 value". A failed one stays amber with its reason.
- At most four boxes at once, which is how many requests run at once. A step with many requests (every row of a list) shows them as they go and doesn't wait on the animation: the reading isn't slowed down to be watched. With *reduce motion* set, boxes appear with their outlines and nothing travels.
- **The text view is text.** The response is never put on the page as HTML: no markup, scripts, images or styles from it are used. Fetch steps only read from the trigger page's own site, so the box shows nothing the page's site didn't already serve to this caseworker.
- The box is drawn only where the site rules allow reading the trigger page, and is cleared with the outlines.

### Afterwards: the fetched view

Every row of a fetch step, and the step's summary, gets **View what was read**. It opens the fetched view on Power Loader's own case page (not on whatever site the tab happens to be showing):

- the same text view, the same outlines, scrolled to the first value; each value listed beside it with what happened to it (matched, new, used, overridden, in conflict);
- when it was fetched, from which address, and the request it came from;
- *Open the page* where the address is one a tab can show, which goes there and outlines the values (as a conflict's link does); and *Fetch again*.

**What is kept to make that possible.** The response isn't kept whole. Each fetched clip keeps, for each value it read, an excerpt: the text around the value (for a page, the block it is in; for JSON, a few lines either side with their path), up to about 500 characters a value and 20 KB a clip. This extends the clip's existing `quotes`. The view says so: "Showing the parts that were read. *Fetch again* to see the whole response." The excerpts are case data: they are in the case, appear in no log, and are deleted with it.

The reasons for excerpts over the whole response: a JSON response can be megabytes and holds far more than the flow reads; keeping all of it would put more personal data on disk than the case needs.

## Build order

1. **`lib/case.js`**: the live tally for a clip (matched, new, used, overridden, conflicts), built on `fieldState()` and `clipValueState()`. Unit tests, including a conflict decided each way and one reopened.
2. **The step**: conflict rows in the value list, the new line with its links, cards that can be scrolled to and focused (`id`, focus, the ring), all updating when a conflict is decided.
3. **The page**: orange ⚠ outlines for values in conflict; a held outline for the value a link points at.
4. **From a card to its page**: the source links, the wait for the page to be recognised, the "isn't on this page now" case, the site-rule check.
5. **Reveal rules**: the template field, validation, export and import, `library` profile support, applying and undoing in `lib/gather.js`, the built-in `<details>` and `hidden` cases, the "closed part of the page" wording, and the Build recorder.
6. **Fetch boxes**: the text view for pages and for JSON (reusing `lib/json-dom.js`'s layout), outlines, scrolling, travel, the strip, four at a time, reduced motion.
7. **Fetched views**: excerpts in the clip, the view on the case page, *View what was read*, links from conflict cards.
8. **Demo and tests**: a demo page with an accordion holding a value the rent support review reads, so reveal rules have something real to work on; Firefox suite journeys for a conflict followed to its page, a revealed value, a watched fetch and a reviewed one; the strict-CSP page (`?csp=strict`) for every new thing drawn on a page.
9. **Docs**: README, the how-it-works page (what is kept from a fetch), REVIEWERS.md (what is drawn on a page and what a reveal rule may change).

## Decisions

The owner's, 2026-11-26:

- A conflict on a clipped page is highlighted in orange or red with a warning icon.
- A conflict's sources link back to the page the data came from, which highlights the value and scrolls it into view where it can.
- A flow can say how to open closed parts of a page, by changing CSS classes on a set of elements. Clicking isn't safe and isn't used.
- The step's conflict names link to the cards further down, and the line updates as conflicts are decided ("3 matched, two used, one overridden").
- Each fetch makes a visible box on the page, with the highlights applied and the data clipped from it; a large response scrolls to where the data is.
- The caseworker can get back into those fetched views to review what happened.

Chosen while planning, for the owner to overturn if wrong:

1. **Orange, not red**, for an undecided conflict, with ⚠ and the word.
2. **A reveal rule may also set `open` on `<details>` and remove `hidden`**, as well as change classes, because those two are how plain HTML hides things and neither can run code.
3. **Reveal counts as a `read`** under the site rules.
4. **The fetch box shows text, never the response's own HTML.**
5. **Excerpts are kept, not whole responses**, and the fetched view opens on Power Loader's own page.
