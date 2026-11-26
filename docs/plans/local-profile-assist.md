# Make a profile with a local model

Created: 2026-11-24. Status: built (1.0.0). This plan records the design and its decisions; the code and README describe what ships.

**Make a profile for this page** should start with a draft already filled in, worked out on this computer, rather than an empty draft. The caseworker then corrects it on the page. Nothing leaves the computer. The existing **✦ Suggest a profile with AI** (gateway, redaction preview) stays as the other route.

## Target first

Profiles are always made from the target backwards:

1. **The target form.** On the form's page, *Make a fill profile* (or *Make a profile for this page* → "This page is a form to fill") reads the form's boxes. It matches each box to one of that library form's fields, using the box's label, its name and id, its input type and options, plus the model. The caseworker checks the box → field list in the sidebar.
2. **The gather pages.** *Make a profile for this page* → "This page has details for…" asks which target forms the values are for. Only forms that already have a fill profile (the library's or a draft) can be chosen; the others say "map that form first". The target fields are the chosen forms' fields, listed in the sidebar as **drop zones**.
3. **Highlight and auto-match.** Every candidate value on the page is outlined. The rules, the privacy categories and the model match candidates to the target fields. The matched elements show a badge with their field's name, and each sidebar row shows the value it will read, with *Matched by label*, *Matched by model* or *Check this*.
4. **Correct.** Drag a highlighted element from the page onto a field in the sidebar. Or click it on the page, which selects it, and choose its field in the sidebar (this also works with the keyboard: Tab and Space). Each row has a list of the page's values and *Not this*.
5. **Override tool.** *Pick something that isn't highlighted* lets any element on the page be chosen: the element under the pointer is outlined, and a click selects it. It then becomes draggable and mappable like any other candidate. Esc cancels. A labelled-value list in the sidebar gives keyboard users the same reach.

## Decisions

- **The model never writes selectors.** Heuristics find the candidate elements and write the selector for each one with the existing `pickSelector()` (label-based first, never the value itself). The model only *classifies*: for each candidate id it picks a field key from the library's vocabulary, or `none`, plus a filter from a closed list. A wrong answer is a wrong label, which the caseworker can see and fix. It can never be a broken or unsafe locator.
- **Output is validated, never trusted.** Unknown ids, keys and filters are dropped. Each field keeps its best-scoring candidate only. The draft goes through the usual test before use, unchanged.
- **The model is optional.** With no WebGPU, or before the model has downloaded, the same pipeline runs on heuristics alone (library `accepts` categories, regex patterns, `guessKey()` on labels). The model improves the mapping but nothing depends on it.
- **Model: Gemma 3 1B instruct** (`onnx-community/gemma-3-1b-it-ONNX`, q4f16, about 785 MB), loaded with Transformers.js on WebGPU, with the same pinned revision, SHA-256 checks and cache handling as the privacy model (but its own cache). Policy (`assistModel.*`) can switch it off, or pin another model and revision with its hashes.
- **One value per prompt, with the answer started.** The model is asked about one value at a time ("A web page shows "Owner": "Harbour Homes Ltd". Which of these form fields does it fill?"), and its answer is begun for it (`The field is "`), with generation stopping at the closing quote. The field name it gives is read back with the rules' own label scoring.

### What was measured (2026-11-24, CPU, `tests/tools/assist-model-eval.mjs`)

On the demo pages the rules alone match every field the library's own profiles read (`tests/tools/assist-eval.mjs`). The table below covers 16 values whose labels the rules don't know ("Owner", "Weekly pay", "Moved in"…), 12 of which belong to a field:

| Model, prompt | Right | Wrong | Notes |
|---|---|---|---|
| Rules only | 2 | 2 | |
| Gemma 3 270M, numbered batch | 0 | – | copies the example back, invents lines |
| Gemma 3 270M, one value, answer started | 2 | 2 | adds nothing over the rules |
| Gemma 3 1B, one value | – | – | explains instead of answering |
| **Gemma 3 1B, one value, answer started** | **6** | **3** | the default |
| Qwen3 0.6B, one value | 5 | 3 | not usable in the target environment |
| Qwen2.5 0.5B, one value | ~ chance | | |

On the demo pages Gemma 3 1B never changed a rule match. It agreed with 17 of them and added one wrong field ("Allocated worker" as Current employer). A model's addition is always marked **Check this**, and it never replaces a confident rule match or a value the field's validator rejects.
## Pipeline

1. **Candidates (content script, `agent.js`).** Extend `candidates()` to return, for each visible value element: `id`, `selector` (from `pickSelector`), `label` (dt/th/`<label>`/lead text/`aria-label`), `value` (at most 120 characters), `tag`, `section` (nearest heading), and a short `path` (an abbreviated xpath, such as `main/table.details/tr[3]/td`). Repeating structures (table rows and same-class siblings, three or more) become one **row group** candidate, so lists like `notes` can be proposed.
2. **Pre-filter and categorise (sidebar).** Run `detect()` from `privacy-detect.js` over each value: library patterns, the DOB context rule and, if it's loaded, the privacy model's spans. This gives each candidate a category (`nino`, `date_of_birth`, `person_name`, `address`, …). Drop chrome (nav text, buttons, empty or one-character values), and rank by the following signals: has a label, has a category, sits in a details block. Keep at most about 60 candidates, so the prompt fits a small context window.
3. **Classify (local model, `extension/assist/worker.js`).** For each labelled, non-repeating candidate (at most 40, best first), one prompt: its label, value and section, and the target fields' names. The answer is started for the model and read back as a field key or nothing (see *Decisions*). Values are included because nothing leaves the machine.
4. **Merge and score.** Final key = model answer if it agrees with the category (`accepts`) or the label match; otherwise flag it **Check this** in the editor. Add filters by field type deterministically (date → `| date`, money → `| number`, multi-line address → `| oneline`, postcode inside the address → `regex`), not by the model. This becomes a draft with `from: 'local'`, through the existing `newPageDraft` + `editPicks`.
5. **Refine.** See *Target first*, steps 3 to 5, above. The vocabulary sent to the model is the target forms' fields, not the whole library.

## Merge from power-loader (`../power-loader`, `docs/flows.md`)

The DSLs share a common origin. Power-loader has moved ahead in these places worth bringing back into `extract.js` / `fill.js` (with new hand-written DSL cases; the frozen fixtures stay untouched):

| From power-loader | Where | Why |
|---|---|---|
| `first`, `last` filters; `join:SEP` with `\n` | extract | lists of names and notes → one field |
| `label("text with )")` quoting; `CSS label() CSS` (CSS after label looks inside the value) | extract | better picker selectors for odd labels |
| path fallbacks `["a", "b \| regex:…"]` and `[propertyID=NI number]` path selectors | fill | `firstName` from `name` when absent; identifiers |
| `same` identity checks on the form page | fill | refuse to fill a form showing another client's ID; complements the case identity check |
| `lists` (repeating rows: `source`, `rows`, row-relative `.paths`) | fill | household members and similar |
| `next` link with `{path}` substitution (site origin must be written out) | profile | "Open the referral form for this client" after clipping |
| schema.org naming guidance and `@type` | prompt + docs | consistent keys across profiles |

The picker can also borrow power-loader's `frontend/pagetools.js` label-finding if it's better than ours. Compare the two on the demo pages before choosing.

## Steps

Implemented on 2026-11-24 (steps 1–4, with the target-first flow): `extension/lib/assist.js` (candidates → matches, prompt and merge, pure), `extension/assist/worker.js` + `lib/assist-client.js` (Gemma 3 1B on WebGPU, pinned and hash-checked), the agent's drag, select and override modes, and the target chooser and drop-zone editor in `sidebar/draft-editor.js`. `tests/js/assist.test.js` scores the rules against the demo library's own profiles. Step 5 (the power-loader DSL merge) is still to do.

1. **Eval set first.** Save 8–10 pages (the demo pages, plus 3–4 from the Firefox suite) with hand-made "right" profiles. A script `tests/tools/assist-eval.mjs` scores each pipeline run: share of fields correct, wrong keys and missed fields. It runs offline with heuristics only and, opt-in, with the model on the desktop GPU.
2. **Candidates and heuristics-only draft** (steps 1, 2 and 4, no model). Ship this on its own: it already makes "Make a profile" start filled in.
3. **Relabel UI and confidence colours** (step 5).
4. **Assist worker** (step 3): load, verify, cache and show progress in the draft editor, with a policy switch and a setting. Measured above; Gemma 3 1B kept.
5. **power-loader DSL merge** (the table above), one commit per feature, with DSL cases.
6. **Docs and checks:** README, `dsl.md`, the release-plan checklist (model size, WebGPU on target laptops) and `web-ext lint`.

## Risks

- A 270M model does no better than the heuristics (measured above), so the default is the 1B. It still guesses wrong about a third of the time on unfamiliar labels, so every model match is marked Check this.
- Downloading a second model adds about 785 MB to disk on locked-down laptops. Download only when the caseworker first presses Make a profile, never at install.
- WebGPU memory, with both models loaded: unload the assist model after use.
