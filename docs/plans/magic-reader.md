# Magic reader: reading documents, images and screen regions

Created: 2026-10-19. Revised the same day after design review (see `release-plan.md`). Status: built (1.0.0). This plan records the design and its decisions; the code and README describe what ships. See `prototype/case-journeys.html`, step 5.

## What it does

The caseworker points the reader at a document, and it extracts values for the active case's fields. The document can be a PDF, a scan, a photo, part of the screen, or a pasted snip. Values then go through the same review as clipped pages: confidence, a quote of the source text, and whether each value is new, matches the case or conflicts with it. Nothing joins the case without review.

There are two modes, as for the other tools:

| | Standard (local) | Enhanced ✦ (AI gateway) |
|---|---|---|
| PDF with a text layer | pdf.js text extraction | Sends the **text**, not images |
| Scan, photo or region | OCR on the device (tesseract.js) | Sends page or region **images** to a vision model |
| Matching text to fields | Labels, synonyms and type validators from the library | The model gets the case's field list and returns values with quotes |
| Leaves the browser | Nothing | The images or text shown in the preview |

## How Power Loader gets the pixels or bytes

The reader tries these sources in order. Each one falls back to the next.

1. **Download the document.** This gives exact text and full resolution.
   - *Top-level PDF tab.* Firefox's built-in viewer runs at the PDF's own URL, so `tab.url` is the document. Content scripts cannot run inside that viewer, but Power Loader can fetch the URL.
   - *PDF or image in a frame.*
     - **Discovery.** A content script in the top frame lists `iframe`, `embed`, `object` and `img` sources, and `webNavigation.getAllFrames` lists nested frame URLs.
     - **Running inside the frame.** With host permission for the document store, `scripting.executeScript({ allFrames: true })` runs inside cross-origin frames. There it can read a site-hosted pdf.js text layer directly.
     - **Fetching the file.** `content.fetch` was an MV2 Firefox feature and is **not available in MV3**, so the earlier plan to use it is withdrawn. Candidate MV3 paths, to verify in order:
       1. `scripting.executeScript({ world: 'MAIN', frameIds: [id] })` runs `fetch()` as the frame itself (same origin, the site's cookies, and the frame's own `blob:` URLs) and returns the bytes to the extension.
       2. A content-script `fetch()` in the frame, if Firefox makes it with the page's origin and cookies.
       3. A fetch from the extension page with host permission. This may miss session cookies under Total Cookie Protection.
     - Each path is a separate capability, with its own error message and fallback.
   - This fails when Power Loader has no host permission for the frame, when none of the fetch paths gets the session, or when the viewer only streams rendered tiles or a canvas.
2. **Select a region.** This reads whatever is drawn on screen, including cross-origin frames.
   - Inject an overlay into the top frame. The user drags a box around the area, and Power Loader calls `tabs.captureVisibleTab(windowId, { format: 'png', rect, scale })`. Firefox supports `rect` and `scale` there and in `tabs.captureTab`. The capture is pixels, so cross-origin iframes and plugin-rendered PDFs are included. The sidebar is not part of the tab, so it is never captured.
   - Where no overlay can be injected (the built-in PDF viewer, `about:` pages, restricted domains), capture the whole visible tab and show a crop view in an extension page.
3. **Paste or drop.** This works for anything the user can see on screen.
   - The sidebar listens for `paste` and reads `clipboardData.files`. Windows Snipping Tool (Win+Shift+S) and Firefox's own screenshot "Copy" both put a PNG on the clipboard. Dropping and `<input type="file">` cover saved PDFs and images.
   - The Ctrl+V path needs no permission. A "Paste" button would need the optional `clipboardRead` permission.

## Pipeline

```
source → pages (PDF) or one image
  ├─ each PDF page: getTextContent(); fewer than ~20 characters → treat it as a scan
  ├─ scan page: render at about 2.5× (≈200 dpi) → OCR (Standard) or image (Enhanced)
  └─ image: downscale to ≤1600 px long side → OCR (Standard) or image (Enhanced)
→ text with positions → match to the case's fields
→ validate types (money, date, NINO, postcode, phone) → review rows
→ add the ticked values as a clip { kind: 'document', name, url, page, quote }
```

- **Standard matching.** Add a `document` profile kind to the library repo next to page profiles: anchors such as "Gross pay" or "Total payment", value regexes, and a field key for each. Known document types (payslips, UC statements, tenancy agreements, landlord letters) then extract reliably without AI. For unknown documents, fall back to matching field labels and synonyms near typed values, using OCR line positions.
- **Enhanced matching.** Send OpenAI-compatible content parts: `[{ type: 'text', text: instructions + field list }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,…' } }, …]`. Ask for JSON `{ key: { value, confidence, quote, page } }` and validate it locally. Cap the request at about 5 page images. The gateway's model alias must accept images, which is a proxy-side choice.
- **Case model.** A read becomes an ordinary clip, so agreement, conflicts, removal and finish-and-delete all keep working. Store the quote and page number. Optionally store a small JPEG crop for provenance, deleted with the case.

## Sending the picture itself (built)

In ✦ Enhanced, *For a picture, a screen region or a screenshot* offers **Read it here, then send the text** (the default: OCR here, then the redacted text) or **Send the picture itself**, for handwriting, stamps and poor scans. The picture is downscaled to 2000 px and sent as a JPEG `image_url` part (`readImage`, prompt `read-image.md`). Power Loader can't find or redact personal details in a picture, so this is a deliberate exception to "covered images only" below: the preview shows the picture exactly as it will be sent, and **Send stays disabled until the caseworker ticks that they understand it goes unredacted** (`state.imageAck`; `approve()` refuses otherwise). The picture's name is still redacted as text. Policy `redaction.blockImages: true` removes the option and the boundary refuses image parts. PDFs with a text layer are always read here and sent as text.

## Text that matches no field (built)

A customer's letter or PDF often has nothing that matches the case's fields. The reader then shows **Text read** instead of "No form fields found": all the text, to copy, and **Keep the text in the case**, which adds it as a clip with one note record. It goes at teardown like any clip, and the ✦ timeline and calculator read it as a case note. When fields do match, the same text is under *All the text read*.

## Code changes

- `manifest.json`
  - Add `webNavigation` to the permissions.
  - Add host permissions for the document store domains.
  - For screen capture, `tabs.captureVisibleTab` / `captureTab` require **`<all_urls>` or `activeTab`**. Per-domain host permissions are not enough. `activeTab` is only granted by a toolbar, menu or keyboard command, not by a click in the sidebar, so either deploy `<all_urls>` through the managed install (and justify it in the DPIA), or make region capture start from a keyboard command or context menu.
  - Add `'wasm-unsafe-eval'` to `extension_pages` `script-src` (tesseract's WASM), and `blob:` to `img-src` for previews.
- `lib/ai/client.js` and `generate.js`. `complete()` already passes `messages` through. `generate.js` budgets with `m.content.length`, which assumes string content. Count text parts and add a fixed cost per image instead.
- Vendored files, loaded from extension URLs and never a CDN:
  - `pdfjs-dist` legacy build and its worker, about 3 MB.
  - tesseract.js worker and core (SIMD and plain WASM), about 4 MB.
  - `eng.traineddata` from tessdata_fast, about 4 MB.
  - Set `workerPath`, `corePath` and `langPath` with `runtime.getURL`, and turn off blob workers.
- New `lib/reader/` module: `sources.js` (discovery and download), `pdf.js`, `ocr.js`, `match.js` and `capture.js`. Add a sidebar Reader view.

## States to handle

- **Documents that can't be read:**
  - password-protected;
  - corrupt;
  - too large (set a page and size cap, and offer "read pages 1–5");
  - mixed text and scan. Pages are checked one by one; a thin text layer on one page doesn't prove the others are readable.
- **Readable but unsuitable:** a document with no matching fields; a viewer that blocks download (the region fallback).
- **Interruptions:** the caseworker cancels; the case ends while a read is running. Late results are discarded (see `release-plan.md`, Teardown).
- **Bad values:** invalid values can't be added. The review re-validates on **Add to case**, not just on display.
- **Provenance:** each value's quote and page number are stored with the clip, so the full case page can show where a document value came from.

## Delivery order

1. **Paste, drop and file, Standard only.** No new permissions. Includes pdf.js text and OCR, document profiles and the review UI. This is most of the value at the least risk.
2. **Document discovery and download** from tabs and frames.
3. **Select a region**, with the overlay and the crop-page fallback.
4. **Enhanced**, with vision requests through the same redaction preview as every other AI action (`redact-before-ai.md`). Images are sent only as the covered, flattened version the caseworker has checked.

## Check in real Firefox before committing

- Which MV3 fetch path above gets the document store's session cookies and the frame's `blob:` URLs under Total Cookie Protection and containers. This decides how often the region fallback is needed.
- `captureVisibleTab` with `rect` on a HiDPI Windows laptop, to confirm crop coordinates at 125%, 150% and 200% scaling, with browser zoom and page scroll.
- tesseract.js speed and accuracy on the contact-centre laptops with real scanned agreements and phone photos.
- That the LiteLLM `fast` alias accepts image parts and stays within budget for 3 to 5 pages.
- That signing and enterprise deployment accept an XPI of about 12 MB with WASM.

## Tests

- Offline: pdf.js text extraction on text-layer fixtures. Document-profile matching on stored OCR output, so tests don't run tesseract. Validators. Clip and conflict integration.
- Opt-in: tesseract on scanned fixtures, and a live vision request, following the existing live-test rules.
