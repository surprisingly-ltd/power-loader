# Redact before sending to AI

Created: 2026-10-19. Revised the same day after design review (see `release-plan.md`). Status: proposal. See `prototype/case-journeys.html`, step 5 and the sidebar's Privacy tab. This builds on the Privacy tab in `../powerloader-pii`.

## What it does

Nothing reaches the AI gateway without passing one boundary, `previewBeforeSend()`:

1. Power Loader builds the exact payload that would be sent.
2. It finds personal data in that payload on this computer.
3. It replaces each finding with a placeholder.
4. It shows the caseworker the result.

The caseworker can switch any value between redacted and sent as written, add their own redactions, and send or cancel. The AI answers with the same placeholders. Power Loader restores the real values on this computer with strict rules, before anything joins the case.

### Every AI call goes through the boundary

There is no other code path to the gateway. `lib/ai/client.js` accepts only an approved payload object, which `previewBeforeSend()` returns frozen, and refuses anything else. Retries resend the same approved payload; they never rebuild it.

| Action | What is sent |
|---|---|
| ✦ Extract with AI (case notes, unrecognised pages) | Page text from the snapshot |
| ✦ Map this form with AI | Form labels, options and any current values |
| ✦ Suggest a profile | Reduced page snapshot |
| ✦ Read with AI (document, region, pasted image, file) | Text layer, or the covered page image (see Images) |
| ✦ Ask (calculator) | The ticked amounts with labels and dates, the question, and the case notes |
| ✦ Find periods in the notes (timeline) | Case notes |
| ✦ Explain the timeline | The timeline summary |

The calculator and timeline do their arithmetic locally. The AI only explains or finds candidates, and its suggestions are reviewed before use.

## The payload is what gets checked

The preview must show and scan what actually leaves the computer, not a friendlier text version of it.

- **HTML snapshots** (`lib/ai/snapshot.js` `cleanHtml()`) currently keep `href`, `src`, `data-*`, `title`, `alt`, `value` and JSON-LD.
  - Scan attribute values and script data the same way as text.
  - Drop `href`, `src` and `data-*` values that aren't needed for the task. Keep only the path shape, for example `/clients/{id}`.
  - Redact the rest.
  - The preview has a "Show the HTML that will be sent" view.
- **Request metadata** (page title, URL, file names) is scanned too.
- **Model and transport errors** must not echo the payload into logs.

## Placeholder format

```
<redacted:{category}|ref:{ns}.{n}[|format:{hint}]|confidence:{pct}%>

<redacted:first_name|ref:q7m.3|confidence:99%>
<redacted:nino|ref:q7m.4|format:AA999999A|confidence:99%>
<redacted:date_of_birth|ref:q7m.5|format:DD MMM YYYY|confidence:95%>
```

- **category:** one of `first_name`, `last_name`, `person_name`, `date_of_birth`, `date`, `nino`, `client_id`, `reference`, `phone`, `email`, `address`, `postcode`.
- **ref:** `{ns}.{n}`.
  - `ns` is a random namespace made fresh for each request (at least 3 characters from `[a-z0-9]`; use 6 in production).
  - `n` counts within the request.
  - The same value gets the same ref everywhere in one request. Matching is case-insensitive and treats any run of whitespace as one space.
  - The ref map keeps every occurrence's original text, so quotes are restored exactly as written.
  - The map lives in memory for the request only. It is never stored or logged.
- **format:** comes from the library's definition of that kind of identifier, never from the value itself.
  - Shape example: `AA999999A` for an NI number. Pattern example: `[A-Z]{2}\d{6}[A-D]`.
  - Dates get a date format string (`DD/MM/YYYY`, `D MMM YYYY`), because the format reveals nothing about the date.
  - Names and addresses never get a format.
  - The library CI rejects format strings that contain `|`, `<` or `>`.
  - The default is **Shape**. Policy can force **Off**.
- **confidence:** the detector's score.

The system prompt states the grammar. It tells the model to:

- copy placeholders exactly;
- never invent, alter or guess them;
- put a placeholder only where the hidden value itself belongs;
- leave out what it cannot read.

### Text that already looks like a placeholder

Before detection, any text in the payload that matches `<redacted:` or `</redacted:` is neutralised to `‹redacted:`, and the preview says how many were found. A page cannot plant a token that would later be "restored". Because `ns` is random, an old or copied token cannot match either.

## Restoring the answer (strict)

1. Parse the model's JSON. Restore only inside string values of fields the task asked for. Never restore into keys, and never into fields outside the expected schema.
2. Match placeholders exactly against `<redacted:([a-z_]+)\|ref:([a-z0-9]+\.\d+)>`. The model may also return the long form with format and confidence. Validate that those parts equal what was sent.
3. A placeholder is accepted only if every check passes:
   - its `ns` is this request's;
   - its ref was issued in this request;
   - its category equals the issued category;
   - the field may receive that category. For example, a `phone` ref can't fill `firstName`; an allow-list per case field comes from the library.
4. Anything else is left in place and reported, and that field is left empty and flagged in the review. This covers unknown refs, the wrong category, the wrong field, malformed tokens and placeholder fragments left in the text. Never guess.
5. Normalise locally after restoring (for example `14 Mar 1986` → `1986-03-14`). Re-run the field validators.
6. Comparisons with the case (match, differs, conflict) and any arithmetic run locally on the restored values.

Restored values go through the normal review and are added as a clip of kind `ai`, which can be undone like any other clip.

## Detection, all on this computer

| Detector | Finds | Confidence |
|---|---|---|
| Values already in the case | Exact matches of the case's personal fields, with variants: formatted dates, NINO and postcode with and without spaces, the address without its last part | 99% |
| Library patterns | NINO, postcode, UK phone, email, client ID, local references, dates. A date right after "born", "birth" or "DOB" is a date of birth even when the case has none yet (household members, new clients). | Set per pattern |
| On-device model | OpenAI Privacy Filter via Transformers.js, as in the earlier PII prototype. Finds names and addresses not in the case. | Its score |
| You | "Redact something else" | 100% |

- **Overlaps: cover the union.** Process findings from the strongest down. Each keeps its own label. Any part of a weaker finding that the stronger ones don't cover stays a finding of its own, with its own label and score. For example, a person-name finding for "Maria Kowalska" plus a stronger first-name finding for "Maria" gives `first_name` + `person_name` for "Kowalska", never `[NAME] Kowalska`. This replaces `normalize()` in `powerloader-pii/extension/lib/pii.js`, which keeps only the higher-scoring span.
- **Threshold.** Findings scored at or above the threshold (70% by default) are redacted. Lower ones are listed as "sent as written" and can be ticked.
  - Policy sets a **maximum** threshold, because a lower threshold redacts more. Policy can also stop caseworkers from un-ticking a finding.
  - Validate the default on representative documents before rollout.
- **Categories.** Groups can be turned off. "Other dates" is off by default, so the AI can still build timelines. Policy can lock groups on.
- **Coverage gaps.**
  - The model is trained mostly on English. Test multilingual names before rollout.
  - Free text such as notes and letters is the highest-risk input.

## Images and scans

- **Find the areas.** Run OCR on this computer (tesseract.js) to get word boxes, run the detectors on the OCR text, and map each finding back to its boxes.
- **Cover them on a canvas.**
  - Enlarge each box by a margin and fill it.
  - Put the short placeholder (`<redacted:first_name|ref:q7m.1>`) inside the box when it fits, or as a numbered marker beside it, with the full placeholders as a text legend sent alongside.
  - Send the flattened image, never the original with an overlay.
- **What OCR can miss.** OCR misses handwriting, signatures, faces, stamps and low-contrast text. So:
  - The preview always shows the final flattened image, at full size, with zoom.
  - The caseworker can draw extra masks.
  - Regions where OCR confidence is low are masked by default ("when the reader isn't sure, it redacts").
  - Policy can block Enhanced reading of images entirely, or require a manual "I've checked this image" tick.
- **Built so far (0.10):** the reader can send a picture **uncovered**, only when the caseworker chooses *Send the picture itself* and ticks in the preview that it goes unredacted; `redaction.blockImages` turns this off. Covering found areas, above, is still to do. See `magic-reader.md`.
- **Region capture and pasted snips** go through the same preview.

## Model source (Hugging Face is blocked)

The model files (about 920 MB) come from a server inside the organisation. Transformers.js supports this. `privacy/worker.js` in the earlier PII prototype already takes a `remoteHost` in `load()`, but nothing passes it yet.

### Settings

- **Source:** organisation model server, or Hugging Face.
- **Server address.**
- **Model id:** default `openai/privacy-filter`.
- **Revision:** pin a commit hash.
- **Expected file hashes:** from policy or the library, so a changed file is refused.

### "Ready" means it has actually run

"Load and test the model" checks the files and their hashes, downloads them if needed, starts the model on WebGPU, and runs a test scan on a fixed sample with known findings. Only then does the status say "Ready · WebGPU · test scan 0.4 s at 09:14". A reachable server, or a successful `HEAD` request, is not "ready".

The other states are:

- not loaded;
- downloading (bytes and total);
- starting;
- failed, with the reason: blocked, 401/403, wrong hash, no WebGPU adapter, out of disk, or the test scan failed.

### Worker

- Set `env.remoteHost = base` and `env.remotePathTemplate = '{model}/resolve/{revision}/'`, then call `pipeline(..., { revision })`. Keep `env.allowLocalModels = false`.
- The files use Hugging Face's layout: `{base}{model}/resolve/{revision}/config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_q4.onnx` (plus any `.onnx_data`).

### Hosting

- An Artifactory or Nexus Hugging Face remote repository.
- Any static HTTPS server with the files copied in that layout (`huggingface-cli download openai/privacy-filter --revision <hash> --include "onnx/model_q4*" "*.json"`).
- The server must:
  - send CORS headers (`Access-Control-Allow-Origin`, and `Access-Control-Expose-Headers: Content-Length` for progress), or be covered by a host permission;
  - follow redirects only within allowed hosts;
  - support authenticated downloads if the server needs them. Decide between a token in managed storage and SSO cookies, and test it.

### Cache and lifetime

- The model is cached in the extension's Cache Storage.
- Changing the address or revision starts a fresh download and deletes the old entry.
- Interrupted downloads resume or restart cleanly.
- Low disk space is reported, not retried forever.
- Pre-seeding at machine build must be done **in the deployed Firefox profile with the installed extension**. Opening the model page in a browser does not fill the extension's cache. Verify it.
- The worker is owned by the sidebar today, so closing the sidebar (for example when the full case page opens) destroys it. Move the worker to an extension page that outlives the sidebar (the background page can't start WebGPU workers in all versions), or accept a warm reload and measure it.

### When the model isn't ready

Case values and library patterns still run. The preview and the Privacy tab say that names and addresses outside the case may be missed. Under policy `privacyModel.required` (the Northshire default), ✦ actions refuse to send until the model is ready.

## Policy (`storage.managed`)

- **Model:** `privacyModel.source`, `.baseUrl`, `.modelId`, `.revision`, `.hashes`, `.required`.
- **Redaction:** `redaction.maxThreshold`, `.lockedGroups`, `.allowSendAsWritten`, `.format` (`shape` or `off`), `.blockImages`.
- **Preview:** it is always shown. There is no setting to skip it.
- **Restart:** Firefox reads managed storage at startup, so support guidance must say that a policy change needs a browser restart.

## Logging

- **What is logged:** `Send to AI` with the purpose, the character count and how many values were redacted, then `AI extract page` when values are added.
- **What is never logged:** text, tokens, the ref map, or values.

## Wording

Detectors miss things, so the interface never promises safety.

| Instead of | Use |
|---|---|
| "70% sure" | "scored 70% or more" |
| "share it safely" | "read it through before you share it" |
| "the real values stay on this computer" | "placeholders are swapped back on this computer" |

## Code changes

- **`lib/pii.js`.**
  - Add the token format, `newNs()`, `restore()` with the strict rules, union-cover merging, the DOB context rule, and library format lookup.
  - Keep `chunkText` and `locate`.
- **`lib/privacy-detect.js` (new).** Case-value and library-pattern detectors, merged with the model's spans.
- **`lib/ai/boundary.js` (new).**
  - `previewBeforeSend({ purpose, payload })` resolves to a frozen approved payload, or `null`.
  - `client.js` accepts only those.
- **`lib/ai/snapshot.js`.** Scan and reduce attributes as above.
- **`sidebar/privacy.js`.** The settings, model status and the preview UI.
- **`privacy/worker.js`.** The model-source settings, hash checks and the test scan.

## Tests

- **Grammar and restoring:**
  - The grammar round-trips.
  - Refs are stable for repeated values and differ across requests.
  - A planted token is neutralised.
  - `restore()` rejects a foreign `ns`, unknown refs, the wrong category, the wrong field, and fragments.
  - Quotes are restored with their original spelling.
- **Detection:**
  - Union cover with overlapping findings (full name plus first name, address plus postcode).
  - The DOB context rule, with and without a case.
- **Payload:** nothing in a sent payload, including HTML attributes and metadata, matches a case value that was marked redacted.
- **Model:** the readiness states, a hash mismatch, and the block under `required`.
- **Logging:** the log holds no values.
