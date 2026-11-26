# Getting through a search page: can Power Loader submit a lookup form?

Created: 2026-11-26. Status: decided 2026-11-26, not built. **Power Loader will not submit forms.** Levels 0, 1 and 2 below are the plan; level 3 and background POST are recorded here as considered and turned down, with the reasons, so the question doesn't have to be worked out again. Builds on `flow-steps-ux.md` (steps, and "a page to go through"), `fetch-steps.md` (background requests, and its unbuilt *Posting* section), `site-access-lists.md` (the site rules and their closed actions) and `conflicts-and-fetch-views.md` (reveal rules, which change classes and never click).

## The problem

Many casework systems have no address for a record. To reach one, a caseworker:

1. goes to a search page,
2. types a reference number,
3. presses Search,
4. clicks the first result,
5. and is then on the page Power Loader can clip.

Power Loader can take them to step 1 and can clip at step 5. It can't do 2 to 4, so on such a system every case starts with the caseworker retyping a reference Power Loader already holds. If a flow can't get through a search page, it can only be used on systems where every record has its own address, which leaves out a lot of them.

Steps 2 to 4 are different kinds of thing, and the danger is nearly all in step 3:

| Step | What it is | Risk |
|---|---|---|
| 2. Type the reference | Filling one box | Low. Power Loader already fills forms, with a plan the caseworker sees. |
| 3. Press Search | **Submitting a form** | The server does whatever that form does. Power Loader can't tell a search from *Approve*, *Delete* or *Send*. |
| 4. Click the first result | Usually following a link | Low if it is a real link: going to an address. Higher if the row only responds to a click. A wrong row means the wrong person's record. |

Today's rule is absolute: Power Loader fills values and never submits or clicks (`release-plan.md`, *Filling*; `REVIEWERS.md`). That rule is a large part of why the tool is easy to approve. Anything here that weakens it has to be worth it and has to be said out loud.

## Can it be made safe?

Safe in one sense, and not in another.

- **It can't be proved that a form only looks something up.** That is decided by the server. A form called Search can write an audit record, lock a record as "opened by", or count against a limit. A form using GET is supposed to change nothing, by the web's own rules, and usually doesn't. A form using POST says nothing either way.
- **It can be made as safe as a named person in the organisation deciding "this form, on this page, is a search", with Power Loader refusing to submit anything else.** That is the same kind of safety the site rules already give: they guard against a mistaken or poisoned flow, not against the organisation's own decision.

So the question isn't whether to trust Power Loader to recognise a search. It is whether to let an organisation name the specific forms it has checked, and how tightly Power Loader holds a flow to exactly those.

## Four levels, safest first

Each level gets further through the search page with fewer presses from the caseworker. They stack: a flow uses the highest level that works for its page and that the organisation allows.

### Level 0: skip the form, go to the address

Many search forms use GET, so the results page has an address with the reference in it: `…/search?ref=CM-58213`. Nothing needs submitting. A step's address can already carry `{ref}` (`fillTemplate()` in `lib/journey.js`), so this works today when the author knows the address.

What to add: in Build, when the author is on a search page, Power Loader reads the form. If its method is GET, it offers the address it would produce as the step's address, with the box's name filled by `{ref}` or a chosen value. The author never sees a query string.

- Risk: none new. It is a navigation to an address, checked by the `navigate` rule, exactly like a step's arrow.
- Limit: only GET forms. Not forms that need a token, or pages that build their results with JavaScript.

### Level 1: follow the result

On the results page, the row for this case is a link. Power Loader reads the link's address from the page and goes to it. That is a navigation, not a click: the address must pass the `navigate` rule and must match the page the flow expects next (the next step's template).

Which row is the dangerous part, because the wrong row is the wrong person. The rule: follow a result only when it is unambiguous. Either there is exactly one result, or exactly one row contains the reference searched for. Otherwise Power Loader outlines the rows and the step says "On the page: open the right result". "The first result" on its own is never enough. The identity check that already runs on a clip (a different person's details raise a warning) stays as the backstop.

- Risk: low, and bounded by the rules above. Worth building whatever is decided about submitting.
- Limit: rows that are not links (they respond only to a click) can't be followed; the caseworker opens them.

### Level 2: fill the box, and point at the button

Power Loader types the reference into the search box and outlines the page's own Search button. The step says "On the page: press Search". The caseworker presses it. On the results page, level 1 takes over.

- Risk: none new. Filling is an existing action (`fill`), and a person presses the button, seeing the page as they do.
- Cost: one press on the page per lookup, in a different place from the sidebar's green button. It breaks the "one green button" rhythm a little, but the step already has a way to say "this one is done on the page".
- Works on anything a person can use: POST forms, tokens, JavaScript pages.

**Levels 0 to 2 together solve the problem as described, with no change to the never-submit rule.** The five manual actions become: press the green button (go to the search page, reference typed for you), press Search on the page, and you are on the record (the single matching result followed for you). Typing the reference, the usual place for a mistake, is gone.

### Level 3: Power Loader submits the form (turned down)

Not to be built: see *Decisions*. What follows is the design that was weighed, kept so that anyone who raises it again can see what it would take and why it was refused.

The green button says **Search for CM-58213**. Power Loader fills the box, submits the form, follows the result, and the caseworker is on the record's page in one press.

This is the level that crosses the line, so it is fenced on every side:

1. **A new closed action, `submit`,** in the site rules, like `fetch-post`. Nothing is allowed until a rule naming `submit` matches the page, and that rule can only come from the organisation's policy file or a locked rule in the library's `access.json`. A flow can't open it for itself, and a caseworker's own Settings can't either. A plain allow rule without actions never opens it.
2. **A switch.** `tools.submitSearch` in the tool switches, off unless the organisation turns it on. Off by default in the public build.
3. **Only a real form, submitted the way the browser would.** The step names a `<form>` and its submit button. Power Loader calls the form's own submit with that button. It does not click arbitrary elements, and a page with no form (a button wired up in JavaScript) isn't supported at this level: it stays at level 2.
4. **A fingerprint, recorded in Build and checked every time.** When the author sets the step up, Power Loader records the form's destination and method, the names of its fields, and the button's label. At run time all of them must still match, or nothing is submitted and the step falls back to level 2 with the reason ("This form has changed since the flow was made"). This is what stops a selector that used to find *Search* from finding *Delete* after a redesign.
5. **Checks on what kind of form it is.** Refused outright: a form with a password box, a file upload, or any field the flow doesn't fill that isn't hidden or wasn't in the fingerprint. In Build, a form that doesn't look like a search (no search box, a button not labelled Search, Find, Look up or similar) can still be set up, but the author is told why Power Loader is doubtful and the library's checks flag the step for review.
6. **The caseworker presses for each one, and sees what it will do.** The press on the green button is the consent, so there is no second dialog, but the button's words are built from the page as it is now: the real button's label and the value going in ("Press *Search* on Housing records with CM-58213"). If the label on the page were *Approve payment*, that is what the button would say.
7. **Never in a loop, never automatic.** One submit for one press. Not on auto-clip, not for every row of a list, not from a fetch step.
8. **Check where it landed.** After submitting, the page must be the results page the step expects. If it isn't, Power Loader stops and says so. (It can't undo the submit; it can only refuse to carry on.)
9. **Logged and listed.** The activity log records that a search was submitted on which system (never the value). `tools/policy.mjs explain` lists every page a policy file allows `submit` on. The library's validation lists every flow with a submit step.

What is left after all nine: an organisation that allows `submit` on a page has decided that form is safe to submit, and Power Loader will submit exactly that form and nothing else. If they are wrong about the form, Power Loader will faithfully do the wrong thing once per press, with the button's real label in front of the caseworker each time.

### Turned down: posting in the background

`fetch-steps.md` designs a background POST (`fetch-post`): the request is built by Power Loader and sent without the page. For a search it is the worst of the options:

- Most POST forms need a token or a block of hidden state from the page (ASP.NET's view state is everywhere in older systems). Power Loader would have to fetch the form, copy fields it doesn't understand, and replay them. That is submitting a form while pretending not to.
- Nothing is on screen. The caseworker can't see the button being pressed or where it led.
- Many systems keep "the current search" in the session, so a background search can change what the caseworker's open tab shows next.

Level 3 does the same job in the open, in the tab, through the page's own form. If level 3 is ever built, `fetch-post` should stay closed and unbuilt.

## How it would sit in a flow

No new kind of step. The owner's definition of a step already includes "going to a search or index page to get to the next step": the guide step, shown as *a page to go through*. It gains a description of how to get through:

```json
{
  "role": "guide",
  "name": "Find the tenancy",
  "url": "https://housing.example.gov.uk/search",
  "through": {
    "fill": [{ "selector": "input[name=ref]", "value": "{ref}" }],
    "button": "form#search button[type=submit]",
    "submit": false,
    "form": { "action": "/search/results", "method": "post", "fields": ["ref", "__token"], "label": "Search" },
    "result": { "rows": "table.results tbody tr", "link": "a", "has": "{ref}" }
  }
}
```

- `fill` and `button` give level 2. `result` gives level 1. An address with `{ref}` in it and no `through` is level 0.
- `"submit": true` asks for level 3, and is only honoured where the site rules allow `submit` on that page and the switch is on. Everywhere else the same step runs at level 2. So one flow works in a strict organisation and a permissive one.
- In Build, the author does it by showing: go to the search page, click the box and say which value goes in, click the button, and on the results page click the row. Power Loader records the rest, including the fingerprint. Nobody writes a selector.

## Trade-offs

| | Levels 0 to 2 | Level 3 |
|---|---|---|
| Presses per lookup | Two: the green button, then Search on the page | One |
| Retyping | None | None |
| Changes the never-submit promise | No | Yes |
| Works on POST forms, tokens, JavaScript pages | Yes (a person presses) | Real forms only |
| What could go wrong | Wrong result followed: bounded by "exactly one match" and the identity check | A form that isn't really a search gets submitted, once per press, if the organisation allowed it wrongly |
| Who has to approve | Nobody new | The organisation, per page; and Power Loader's own reviewers |
| Cost to build | Small: mostly Build and the step's wording | Larger: a new closed action, the fingerprint, the refusals, tests on real forms |

Other costs of level 3 that aren't about code:

- **The pitch gets a qualifier.** "Power Loader never submits anything" becomes "never submits anything, unless your organisation has named a search form it may submit". That sentence has to go in `REVIEWERS.md`, the how-it-works page, the privacy page and the film's claim that what is left is yours to submit.
- **Every organisation's security review gets a new question**, even those that leave it off, because the capability is in the package. An organisation build could leave the code path out entirely when the switch is off in its policy file, as capture's permissions are left out.
- **Searches done through a flow are still the caseworker's searches** in the system's audit trail. That is right, since they pressed the button, but a flow that searches on a system the caseworker wouldn't otherwise have looked at leaves a trail in their name. The step must say which system it is about to search.

## What is to be built

Levels 0, 1 and 2, and nothing that submits.

1. **Level 0, the address.** In Build, on a search page whose form uses GET, offer the results address with `{ref}` (or a chosen value) in it as the step's address. A form that doesn't use GET gets no such offer, and Build says why: "This form can't be reached by an address, so the caseworker will press its button."
2. **Level 2, fill and point.** A page to go through gains `through.fill` and `through.button`. The step's green button types the value into the box, through the existing `fill` action and its site-rule check. The page's own button is then outlined and the step reads "On the page: press *Search*", with the button's real label read from the page. Power Loader never presses it.
3. **Level 1, follow the result.** `through.result`. On the results page, the address of the one matching row is read and gone to, under the `navigate` rule, and only if it matches the next step's page. With no match or more than one, the rows are outlined and the caseworker opens the right one. Rows that aren't links are always the caseworker's to open.
4. **Build.** The author shows it: the box and which value goes in, the button, and a result row. No selectors typed. The step's test in Build runs the same three things on the author's own case.
5. **Validation and export.** `through` in `validateSteps()`, with the selector checks templates already have; a `{name}` only where a link template allows one; export, import and the library.
6. **Tests.** Demo: a search page on one of the demo systems using POST (so level 2 is needed) and one using GET (level 0), each with a results page of one row, several rows, and none. Firefox journeys for each, including the wrong-person case stopped by "more than one match".
7. **Docs.** README and the how-it-works page say plainly what happens at a search page and that the caseworker presses the button. `REVIEWERS.md`'s statement that Power Loader never submits or clicks stays true and unchanged.

`validateSteps()` goes on refusing any `submit` in a step, and `fetch-post` stays closed and unbuilt.

## Recommendation, as accepted

1. **Build levels 0, 1 and 2.** They remove the retyping and most of the clicks, they need no new permission and no change to what Power Loader promises, and they work on every kind of page. The gap to "one press" is a single press on the page's own Search button.
2. **Don't build level 3.** Submitting is dangerous in a way no check can remove, because only the server decides what a form does, and it weakens the thing Power Loader puts forward: that it fills and reads, and a person submits.
3. **Leave background POST unbuilt**, for the same reason and three more (hidden state it would have to replay, nothing on screen, and it can change what the caseworker's open tab shows next).
4. **Follow a result only when it is unambiguous**: exactly one result, or exactly one row containing the reference. Never "the first result".
5. **If one press on the page per lookup turns out to grate on real systems**, the answer to look for first is a better level 0 (more systems have an address for their results than first appears) before reopening level 3.

## Decisions

The owner's, 2026-11-26: "they seem sensible. I agree we should avoid submitting forms as it is dangerous and weakens what we're putting forward".

- Levels 0, 1 and 2 are the plan. Level 3 is not built.
- Background POST (`fetch-post`) stays closed and unbuilt.
- Power Loader's promise is unchanged: it never submits a form and never clicks.

That settles the questions this plan first asked about level 3 (who could allow it, and whether an organisation build should leave its code out): there is no such code.

Accepted as recommended, for the owner to change if it proves too strict or too loose in use:

- A result is followed only when exactly one result, or exactly one row containing the reference, is on the page.
