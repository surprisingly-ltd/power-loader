# Library page, local drafts and profile export

Created: 2026-10-19. Revised the same day after design review (see `release-plan.md`). Status: proposal. See `prototype/case-journeys.html`, step 9.

## Decisions

- The forms library repo is the only source of published profiles. Power Loader never writes to it, and needs no write token.
- Any caseworker can make drafts. A draft is used only on that computer, and only after it has been tested there.
- Publishing is offline for now. The caseworker exports a JSON file, and someone adds it to the repo by hand. Everyone gets it at the next sync.

## Getting the library

A git repository URL is not a download protocol, so the client needs a defined read path:

- **Manifest.** The repo builds a `library.json` at each commit, listing the commit, every file path and each file's SHA-256. Power Loader fetches it from a raw-file or static endpoint, such as GitLab or GitHub raw files, a CI-published artifact, or an internal web server.
- **Files.** Profiles, forms and `privacy.json` are fetched by path and checked against the manifest hashes. One sync is all from one commit; a half-updated set is never used.
- **Read authentication.** Use a token in managed storage, or SSO cookies with a host permission. Decide and test with the enterprise git host.
- **Last known good.** The previous complete set is kept and used if a sync fails or a file fails validation. The library page shows "Using commit 4f2a9c1 from 09:12; latest sync failed: …".
- **Rollback.** Maintainers revert in git. Policy can pin a commit (`library.pinCommit`) during an incident.
- **Version pinning per case.** A case records the form and profile versions it started with, and keeps using them until it ends. A newer published version is offered at the next new case, or explicitly with "Update this case to v5".

## Library page

The Library is an extension page (`library.html`) opened from Settings, from a draft in the sidebar, or after a ✦ draft. Like the case page and the Activity log, it replaces the sidebar.

It has four tabs:

| Tab | What it shows |
|---|---|
| Page profiles | Each profile's name, id, version, link pattern, field count and status. A draft row appears under the profile it changes. |
| Fill profiles | Form box → case field mappings |
| Forms | Forms from the library, read-only. A form with no fill profile offers **Make a fill profile**. |
| Your drafts | Every local draft, with the publishing steps, **Export** and **Delete** |

Opening a profile shows:

- its link pattern and row selector;
- a fields table, with the values the profile reads on the page you were last on (for fill profiles, the case values now);
- its version history from the repo's commits.

A published profile offers **Make a new version**.

## Making a profile

### A new page profile

1. On a page no profile reads, choose **Make a profile for this page**, or ✦ Suggest a profile, which goes through the redaction preview.
2. The page enters pick mode:
   - Readable values get dashed outlines. Clicking a value adds it, and clicking again removes it.
   - The sidebar editor lists each field, with a case-field picker, the generated selector and the value read.
3. **Keyboard alternative.** Pick mode is pointer-only in the prototype. In the extension:
   - Tab moves through the candidate values, and Space adds or removes one.
   - The sidebar editor offers "Add a field by label", which lists the page's labels so no pointer is needed.
4. **Selectors** use the extraction DSL the extension already runs (`extension/lib/extract.js`):
   - `dl label(Address)` for a `dt`/`dd` pair.
   - `regex:` filters when one element holds several values: `| regex:^(\S+)`, `| regex:(\S+)$`, `| regex:^(?:\S+\s+){1}(\S+)`.
   - There is no `part` filter.
   - Selectors must contain no literal values from the page. A selector like `td:contains("Kowalska")` is refused.
5. **Test and use on this computer** runs the real extraction engine on the open page. Each field must match exactly one element, and the result must pass the field's validator.
   - Only a passing draft is used for clipping. New drafts start "Not tested".
   - Any edit sets the draft back to "Not tested".
   - The test also offers "Test on another page", so each field is checked against at least two records. A selector that only works for one person is the common failure.
6. **Done** saves the draft.

### A new version

- **Make a new version** copies the published profile to a draft with the next version number. It records the base version and **commit**.
- You edit it on the page or in the library.
- The library compares it with the base: fields added, removed or remapped, and changes to the link pattern, `when`, the row selector and the row fields.
- **Used on this computer** switches between the draft and the published version for clipping or filling. It stays disabled until the draft has passed a test.

### Fill profiles

- Fill drafts are edited in the library, with one case-field picker per form box. ✦ Map this form with AI saves its result as a fill draft.
- Fill drafts are tested by a dry-run fill plan (see `release-plan.md`, Filling), never by filling a live form.

### What authoring doesn't support yet

Repeating rows, nested groups, conditional sections and duplicate labels on one page can't be authored by picking yet. The editor says so and suggests asking a maintainer. Published profiles can still use them.

## Export format

There is one file per profile, named `{id with / as --}.{version}.json`, for example `cm--client-record.v4.json`. In the plugin it is saved with `browser.downloads`.

```json
{
  "schema": "powerloader-profile/1",
  "id": "cm/client-record",
  "kind": "extract",
  "name": "Client record",
  "version": "v4",
  "basedOn": { "version": "v3", "commit": "9b1e044" },
  "match": ["https://cm.northshire.gov.uk/clients/*"],
  "urlPattern": "https://cm.northshire.gov.uk/clients/{clientId}",
  "fields": {
    "firstName": "h1 | regex:^(?:\\S+\\s+){1}(\\S+)",
    "dob": "dl label(Date of birth)",
    "records": ["table tbody tr", { "label": "td:nth-child(1)", "start": "td:nth-last-child(2) | date" }]
  },
  "exported": { "from": "Power Loader 0.7", "date": "2026-10-19", "contentHash": "1f3c…" }
}
```

- **Repeating rows** are a DSL list, `[rowSelector, { field: selector }]`, inside `fields`. A separate top-level `records` key would be ignored by the engine.
- **Fill profiles** use `"kind": "fill"` and `"form": { "id": "hsr", "version": "v4" }`. Their fields map selector to `"CaseData.firstName"`, as the existing typed fill profiles do.
- **`urlPattern`** is the anonymised link pattern for the activity log. Add it to the DSL schema.
- **`contentHash`** is a hash of the file without its `exported` block.

### Checks before export

Export is blocked until all of these pass:

1. At least one field is mapped.
2. The file passes the engine's own validator (`validateProfile` / `validateFillProfile`). That covers unknown filters, bad regexes and reserved keys.
3. The draft passed its last test, and nothing has changed since.
4. **No case or page data anywhere in the file.** Every string (selectors, literals, `match`, `urlPattern`, names) is scanned against the case values and the values on the tested page. Anything found blocks export.

Library CI runs checks 2 and 4 again on the repo.

## Publishing (manual, for now)

1. The caseworker exports the draft and sends it to a maintainer, or adds it themselves at the path the export dialog shows (`profiles/pages/{id}.json` or `profiles/fill/{name}.json`).
2. A maintainer reviews it. The review must cover:
   - **Privacy-reducing changes.** A profile that starts reading new personal fields, broadens its `match`, or changes `privacy.json` needs explicit sign-off.
   - **Domains.** The `match` hosts must be on the approved systems list.
   - **Regex cost.** Patterns run on every visit, so refuse catastrophic backtracking.
   - **Field limits.**
3. They commit and merge. CI validates.
4. At the next sync, a local draft is **retired only when the published file's content hash equals the hash the draft exported**. Otherwise the draft is kept, and the caseworker sees:
   - "v4 was published, but it isn't the same as your draft." The choices are **Use published**, **Keep using my draft**, or **Compare**, which shows the draft, the published version and the original base side by side.
   - A newer published version than the draft's base leads to the same choice.
   - Nothing is ever deleted silently.

### Later

- Opening a merge request from the plugin would need a write token, so it stays out of scope.

## Profile safety

The extension treats library profiles as untrusted input, even though the repo is internal:

- **Validation.** Every profile is validated on load. Invalid ones are skipped and reported on the library page.
- **Hosts.** `match` must be within the approved hosts in `library.json`.
- **Fill profiles can't click.** They may only set values. Automatic row creation (`lists[].add`, which clicks an element) is removed for the first release (see `release-plan.md`, Filling).
- **Privacy rules.** A profile can't change redaction rules; only `privacy.json` can, under the review above.

## Storage

- **Where drafts are kept.** Drafts live in `storage.local` under `profileDrafts`, with their base version, base commit, test result and exported hash. They are kept apart from the synced library cache.
- **Finish case.** Drafts survive finishing a case. "Finish case" doesn't touch them.
- **Delete all.** "Delete all Power Loader data" removes them.
- **Backups.** Settings backups include drafts.
