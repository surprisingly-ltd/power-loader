# The film, made again for the new sidebar

Created: 2026-11-26. Revised the same day with the owner's decisions (see *Decisions*). Status: built and recorded with voice, 16 lines, a draft for the owner to listen to (2 minutes 56 seconds). Builds on `flow-steps-ux.md` (the sidebar the film must now show) and the UX lab (`lab/README.md`, `lab/film/`).

## What's built

`node lab/film/record.mjs` records the three acts below into `dist/lab/base.mp4` (2 minutes 56 seconds), checking
every claim against the screen as it goes, and stopping if one isn't true.

- **Act 1** is `lab/film/before.html`: the real case page and form in windows, fourteen copy-and-pastes (three at
  real pace, the rest sped up), then mock-ups of Notepad, Word and Excel filling with the client's details.
- **Act 2** starts from a copy of the library's rent support review with the form's boxes and the case page's
  values not made yet (`window.__lab.copyFlow`). In Build, the form comes first: three boxes matched by hand,
  then a cut to every box matched; *✦ Make the template with AI* is ringed on the case page (with the AI off, as
  the screen says; no AI is called); the case page's values are picked, and the flow's steps shown. **Export**
  is ringed, not pressed: publishing is an export for a library maintainer, and a copy of a library flow carries
  "hasn't been tested" problems from its untested pages, so the second browser's library is the demo library.
- **Act 3** is another caseworker's browser (another made-up login, `?user=`) that has never seen the library
  (`?library=sync`): its sidebar fetches the library on opening, and the flow is starred, started and worked
  through case 1001 to *Finish case*. Pointing at a value shows it on the page; the recorder checks the picture.

Act 2 was rewritten after the owner's first look (see *Decisions*), and `share` and `finish` changed to match the
screen. The voice is Isla Skye on Eleven v4 with stability 0.5, similarity 0.75 and clone strength 0, one take a
line, made again only when its words change or the owner flags it (`voiceover.mjs --only <id> --force`).

## Why

The film (`node lab/film/record.mjs` → `dist/lab/base.mp4`) was recorded on the `flow-ux` lab variant, before the rest of `flow-steps-ux.md` was built. Two things are wrong with it now:

1. **It shows a sidebar that no longer exists.** A case is now started from a flow on a start screen of flows (starred ones first), the sidebar has Casework and Build, and a finished flow ends with *Finish case*. The recorder still starts from the old start screen (`[data-key^="start-flow-"]` and the *Start case* dialog).
2. **It starts in the middle, and tells it from the wrong side.** Its first words are "A flow is a job with steps", and it is all about one caseworker working one case. An organisation only gets anything from Power Loader if it makes its own flows, so the film has to show that first, quickly, and then what the flows do for everyone who uses them.

## The story

Three acts:

1. **The current situation.** People copy and paste details from one system to another, by hand, and park them on the way in Notepad, Word or Excel.
2. **Build flows with Power Loader.** Someone who knows the job shows Power Loader the pages and the form, once. Quick: about half a minute.
3. **Distribute them, and accelerate people.** The flow goes in the team's library, everyone has it, and a case that took fourteen copy-and-pastes takes a few presses.

One idea, said after act 1 and again at the end: **Power Loader carries the details for you, so the work is faster, the people doing it are happier, and the details are safer.** Each is shown, not just claimed.

| Claim | What the film shows for it |
|---|---|
| Faster | One press clips a page; one press reads a set of pages nobody opens; one press fills the form. Act 1 shows the same form filled by hand, one copy-and-paste at a time. |
| Happier | One list, one green button, nothing to hold in your head between windows. And the flow is the team's own: the people who do the job made it, and can change it. |
| More secure | The details go from page to form inside the browser and never sit in a scratchpad. The page shows what will be taken before it is taken. *Finish case* deletes the case and leaves a receipt with counts only. |

The film keeps its rule: **it only says what is true of the screen**, and the recorder stops if the screen disagrees. That now covers the claims too: the line about *Finish case* is checked against the receipt's words.

**The voice doesn't say numbers.** The current script is full of them ("eleven of twelve required answers are ready, so one press fills fourteen boxes"), and heard aloud they are confusing: the listener is doing sums when they should be watching. The voice says what is happening and why it matters; the detail is on the screen for anyone who wants it. So no counts in the narration, and nothing that needs the listener to compare two figures. The numbers still matter to the picture, so the recorder keeps checking them without the voice saying them: the counter in act 1 must end on the number of boxes the form step fills in act 3.

## The scenes

About 2 minutes 50 seconds, 15 lines (the film today has 11). Same case throughout (the rent support review, case 1001). The rules for a line stay: one or two sentences, 15 to 35 words, written to be heard, **bold** for words on the screen. One rule is new: no numbers.

These are draft words. Every line marked † describes a screen built since the last recording, and its words must be checked against the sidebar as built before the voice is made.

### Act 1: the current situation (about 25 seconds)

| # | id | Title | Line | On screen |
|---|---|---|---|---|
| 1 | `today` | The job today | Casework means moving the same details from one system to another. Today that is done by hand: copy, switch window, paste, and back again, for every box on the form. | The *before* scene: the case page and the form as two windows, the pointer copying a value across, a counter in the corner climbing. |
| 2 | `scratchpad` | Where the details wait | And in between, the details need somewhere to wait. So names, dates of birth and account numbers are pasted into Notepad, Word or Excel: copies that nobody controls, and nobody deletes. | The three mock-ups, one after another, each filling with pasted values, then left open on the desktop as the case page closes. |
| 3 | `pitch` | Power Loader | Power Loader does the carrying, inside the browser. The work is faster, there is less to retype and get wrong, and the details never leave the page for a scratchpad. | The mock-ups are swept away; the browser with the real sidebar takes the window. |

### Act 2: build flows (about 30 seconds)

| # | id | Title | Line | On screen |
|---|---|---|---|---|
| 4 | `build` | Build a flow | It starts with someone who knows the job, and with the form the job ends in. In **Build**, they open the form and say which value goes in each box. | Build mode, the flow (*1. Forms to fill: start here*); the form; three boxes matched by hand, then a cut to every box matched. |
| 5 | `build-ai` | Or let the AI suggest | It needn't all be done by hand. With your organisation's AI switched on, **Make the template with AI** suggests the matches, and the author checks them. | The case page in Build; *✦ Make the template with AI* ringed, then *The ✦ Remote AI is off. Turn it on in Settings*. No AI is called. |
| 6 | `build-pages` | Then the pages | Then the pages those values come from. On each one they show Power Loader where a value is, and the pages and the form become the steps of a flow. | One value picked on the case page, the rest sped up; *The caseworker's steps* ringed. |
| 7 | `share` | One flow, the whole team | That is done once. Exported and added to the team's library, the flow reaches everyone who does that job, the next time their browser checks. | **Export** ringed; cut to another caseworker's browser (another made-up login), which fetches the library, where the flow appears. |

As built (2026-11-26): the lines above are the recorded words. Publishing is **Export** (a file for a library
maintainer), not a button in the sidebar; Build's guess of a box's value is right for 7 of the 16 boxes, so
the author chooses; and with the AI switched on, *✦ Make the template with AI* works out what a form's boxes
collect, and on a page where each of the flow's values is. Act 3's `finish` line was changed to what the
screen says: "When the work is done, **Finish case** deletes the case from the browser, and leaves a count of
what went, with no details. Nothing was pasted anywhere, so nothing is left to clear up."

### Act 3: distribute them, and accelerate people (about 1 minute 55 seconds)

| # | id | Title | Line | On screen |
|---|---|---|---|---|
| 7 | `start` † | Start from a flow | Now anyone can work a case with it. Star the flows you use, and start one. Every step stays in view, with one green button for the next thing to do. | The start screen, the star, the flow started, the ring on the green button. |
| 8 | `outline` | See what will be read | On a case, before anything is read, the values the page gives are outlined on the page and listed in the step. Point at one, and the page shows where it comes from. | Case 1001 opened from the queue; the outlines; pointing at two rows. |
| 9 | `clip` | Clip this page | Press **Clip this page**, and each value lifts off the page and lands in its row. Nothing is taken that was not outlined first. | The clip. |
| 10 | `next` | One button onwards | The green button now says where to go: **Next**. A step this case doesn't need is marked **Not needed**, and Next goes straight past it. | The skipped step. |
| 11 | `auto` | Auto-clip | With auto-clip on, opening the page is enough. The values are outlined for a moment, so you see what is about to be read, and then gathered. The step says what was new. | The rent account and the income record, one after the other. |
| 12 | `fetch` | Pages you never open | Some steps read pages you never open. One press reads every message the client has sent, and adds what they hold to the case. | The fetch step. |
| 13 | `form` | Fill the form | Now the form. One press fills it in: every box that was copied and pasted by hand at the start. What is left is yours: check it, and submit it yourself. | The fill; the *On the page* note. |
| 14 | `finish` † | Finish, and it is gone | When the work is done, **Finish case** deletes everything the case held. What stays is a receipt with counts and no details. Nothing was pasted anywhere, so there is nothing to clear up. | *Finish case*, the receipt. |
| 15 | `end` | Power Loader | Faster, because the carrying is done for you. Happier, because the flow is your team's own, to make and to mend. Safer, because the details stay in the browser, and go when the case does. | The steps list, all ticked; then the name. |

Dropped from the current film: `queue` (the case is opened from the queue without a line of its own), `income` (folded into `auto`) and `overview` (`end` does its job). Mending a flow from a case isn't a scene; `end` says it in five words. If the film runs over three minutes, `next` is the one to cut.

**To settle while building scenes 4 to 6.** What the sidebar shows for publishing a flow to the library, and how a second caseworker's sidebar receives it, weren't checked for this plan. If publishing is done outside the sidebar (a file exported and put in the library's repository), scene 6 shows the export and then the other start screen, and the line stays true as written. The recorder needs a starting state for act 2: the rent support review with the case page and the form taken out, so the film adds them back and the finished flow is the same one act 3 works.

## The *before* scene and the three mock-ups

The lab's window is a stand-in browser, and act 1 shows work outside it. So act 1 is a staged page, `lab/film/before.html`: a desktop with windows on it.

- **The case page and the form** are the real demo pages, each in a framed window.
- **Notepad, Word and Excel** are mock-ups drawn in HTML and CSS, recognisable at a glance from their layout:
  - Notepad: a bare window, a menu row (*File Edit View*), monospace text, a status line.
  - Word: a blue title bar, a ribbon of tabs, a white page on grey, a table half filled in.
  - Excel: a green title bar, a ribbon, a formula bar, lettered columns and numbered rows, values pasted down column B.
  - Each has a believable file name in its title bar: `case notes.txt`, `Rent review 1001 - working.docx`, `Book1.xlsx`.
  - They are drawn from scratch. No Microsoft logos, icons or fonts are copied; the app name appears as plain text in the title bar. They are for the film only and never ship with the extension or the site's pages.
- **What happens.** The pointer selects a value on the case page, a *Copied* chip shows, the pointer crosses to a mock-up or to the form, and the value appears. A counter in the corner reads *Copy and paste: 3 of 14*; the voice never says the figure. The first three go at real pace and the rest speed up.
- **The data** is the demo's made-up case 1001, the same values the viewer later sees land by themselves.
- **The end of the act.** The case page closes; the three scratchpads stay on the desktop with a client's details in them. That picture holds for a beat before `pitch`.

The recorder drives this page as it drives the lab (`window.__film` for the pointer and captions), then loads the lab proper from scene 3.

## The voice

**Isla Skye**, the soft Edinburgh voice the walkthrough skill uses: voice id `TVmbglAk3F1GkiCoOq47`. It is already in the ElevenLabs workspace (checked with the API on 2026-11-26: "Isla Skye - Scottish, Soft, and Warm", a professional voice clone, copied into the workspace). It is fine-tuned for `eleven_v4` and verified for Scottish English on it, so nothing needs adding or training.

**Model: Eleven v4**, `eleven_v4`. It is a model id, not a new API: the request is still `POST /v1/text-to-speech/{voice_id}`, with `"model_id": "eleven_v4"`. (Checked against ElevenLabs' models page, the v4 page, the prompting guide and the text-to-speech reference on 2026-11-26. The reference page's examples still show `eleven_multilingual_v2`, which is also the default, so the model must be named.)

What changes in `lab/film/voiceover.mjs` and `script.mjs` for v4, following that guidance:

- **Settings.** v4 uses two: `stability` and `similarity_boost`. The v4 page says style and speed aren't available, so `style`, `speed` and `use_speaker_boost` come out of `VOICE.settings`. (The prompting guide still describes a speed range of 0.7 to 1.2 without naming a model; the two pages disagree, so the plan doesn't rely on speed.) Start at stability 0.5 and similarity 0.75, the documented defaults, and adjust by ear: the guidance gives no numbers for v4.
- **Pace and pauses come from the words.** v4 has no SSML and no `<break>` tags. A pause is an ellipsis or a new sentence; emphasis is word order, or capitals used sparingly. The lines above are already written as short sentences for this reason.
- **Audio tags** (`[pause]`, `[warmly]` and the like, in square brackets) are available. Use at most one or two in the whole film, on `pitch` and `end` if they need lifting. Tags are stripped from the caption the same way `**` is, so `spoken()` and the caption's text need a second rule.
- **Names said right.** If v4 mispronounces a word, it takes IPA between slashes in the text. Keep that for a word that needs it after listening.
- **One clip per line, stitched.** The film needs each line as its own clip so it can be laid where its caption appears. Keep `previous_text` and `next_text`, and add `previous_request_ids` (up to three) from the lines just made, which the reference says gives the best continuity when the same model made them. That means lines are made in order, and remaking one line in the middle means remaking the ones after it, or accepting a small change of tone there.
- **One take a line.** The owner listens and flags a line that is wrong; that line is made again, as is any line whose words change. No transcription check. (`seed` is best effort only on v4, so a remade line may differ; `--takes` can still make more than one to choose from by ear, with `--pick`, but the default is one.) The chosen mp3s are committed; nothing is generated at recording time.
- **The hash** that decides whether a clip is stale already covers the voice, model and settings; it carries on doing so with the new ones.
- **Clone strength.** Because the voice is a professional clone fine-tuned for v4, the new `clone_strength` setting applies to it. ElevenLabs' advice is to start at 0 and try 0.5 only if the voice doesn't sound like itself.
- **Listen first.** Make `today` and `pitch`, listen, and settle stability and clone strength on those two before making the rest.

About 2,500 characters in all, one take a line. The key is `ELEVENLABS_API_KEY` in `.env`, as now.

## What has to change

1. **`lab/film/script.mjs`**: the voice, the model, the lines above; the rule for audio tags. Fix the header comment, which says every number is checked, to say every claim is.
2. **`lab/film/before.html`** with its own stylesheet: the desktop, the two real pages in windows, the three mock-ups. `lab/shell/film.js` gains a *Copied* chip and a counter.
3. **`lab/film/record.mjs`**:
   - act 1 on `before.html`, then the hand-over to the lab;
   - act 2 in Build, from the prepared starting state, with speeded-up stretches (the recorder already keeps each frame's time, so a stretch can be played faster when the film is put together);
   - act 3 from the new start screen, starring the flow;
   - a new scene for `finish`, with a check on the receipt's words;
   - a check that the counter in scene 1 ends on the number on the *Fill … boxes* button in scene 13, and the existing checks on the numbers the screen shows, kept even though the voice no longer says them;
   - the old `queue`, `income` and `overview` scenes folded in or removed.
4. **`lab/baseline.mjs`**: the same new start, so the lab walk works again (step 10 of `flow-steps-ux.md` left this undone).
5. **`lab/film/voiceover.mjs`**: the v4 changes above; one take a line by default (`--takes` for more).
6. **Record**: `node lab/film/record.mjs --no-voice` until every check passes, then with voice. Watch it through once before calling it done: the checks prove the words are true, not that the pointer is in the right place.

## Before starting

- **The sidebar is settled.** The last failing Firefox test from `flow-steps-ux.md` (mending a flow from a case) was fixed on 2026-11-26.
- **Port 8787.** The recorder needs it, and a `node lab/serve.mjs` from an earlier session is holding it. Stop that first.
- **The security lines can only claim what is built.** Clearing a case when the browser closes, and the library checking for new flows every hour, are planned (`org-policy-builds.md`) but not merged. `share` says "the next time their browser checks", which is true today (the library syncs when the sidebar opens) and stays true after. `finish` doesn't mention closing the browser; it can gain a clause once that is merged.

## Decisions

Settled by the owner, 2026-11-26:

1. The narration names Notepad, Word and Excel, and the film shows web-based mock-ups of all three.
2. Where the film goes (the site, a shorter cut) is left for now. It stays a file in `dist/lab/`.
3. Building flows comes first, because an organisation only gets the benefit if it makes its own, but it is got through quickly. The order is: the current situation; build flows with Power Loader; distribute them and accelerate people.
4. The voice is Isla Skye, on Eleven v4, following ElevenLabs' current guidance for it.
5. The voice stays high level and says no numbers; the detail is on the screen.
6. This is a plan only. Nothing is recorded or generated yet. (Since built and recorded: see *What's built*.)
7. After the first recording, on act 2: "it says you first do the pages and then the form, but typically you do it in the other order. also building the form looks kinda tedious. mention you can do it with AI if it is enabled." So act 2 is the form first, a few boxes by hand and then a cut, and a line on the AI.
8. The film is a draft: "don't do three takes each and transcription - i'll flag up if any lines are wrong". One take a line, remade only when its words change or the owner flags it.
