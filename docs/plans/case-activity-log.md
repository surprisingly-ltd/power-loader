# Case activity log

Created: 2026-10-19. Revised the same day after design review (see `release-plan.md`). Status: proposal. See `prototype/case-journeys.html`: open the full case page, then the Activity tab.

## Purpose

Record how caseworkers move through the approved systems for each case. Later, use process mining to find common paths, slow steps and steps that can be fully automated. The log describes the process, not the client.

## Data classification

Treat the log as **potentially identifiable personal data**, about staff and possibly about clients, unless an anonymisation assessment shows otherwise:

- Exact timestamps and system paths can be linked with client-system audit logs and staff rotas.
- Free-text notes can hold anything.

So the DPIA, the retention period, who can access it, and a staff-facing notice are **release dependencies**, not follow-ups. ICO guidance on monitoring workers and on identifiability applies.

## What is collected

- **Approved systems only.** A visit is logged only when the page matches a profile or an approved host in `library.json`. Other browsing is not recorded at all, even while a case is open.
- **Explicit case actions.** These are always logged, with the page reduced as below.
- **Fail closed.** An event is logged with its page's `urlPattern` from the library, or with the page-type ID only. A recognised page with no pattern **never** falls back to its real address. Nor does an unknown host, because hostnames can contain identifiers.

## Event shape

One row per event, in the standard event-log shape (case id, activity, timestamp), so it can be imported into PM4Py, Celonis or Disco, or converted to XES/OCEL.

| Column | Example | Notes |
|---|---|---|
| `schema` | `powerloader-activity/1` | Versioned |
| `seq` | `17` | Order within the case. Timestamps can tie. |
| `case_id` | `case-7f3a91` | Random id made when the case starts. Never the CM reference or a client id. |
| `activity` | `visit_page`, `clip_page`, `send_to_ai` … | A stable ID from a fixed vocabulary. The display label is separate, so renaming doesn't break analysis. |
| `timestamp` | `2026-10-19T11:57:08Z` | Policy can coarsen this to the minute if the DPIA asks. |
| `page_type` | `cm/client-record@v3` | Profile ID and version, not its display name. Names drift between library versions. |
| `url_pattern` | `https://cm.northshire.gov.uk/clients/{clientId}` | Or `(link not kept)` |
| `detail` | `11 items`, `Telephone` | Field labels, counts and form names. Never field values. |
| `forms`, `outcome` | `hsr@v4`, `finished` / `discarded` | Added when the case ends. `discarded` means the caseworker chose Discard; `finished` means they confirmed Finish. Neither proves submission. |

### Activities

| Group | Activities |
|---|---|
| Lifecycle | `start_case`, `finish_case`, `discard_case` |
| Navigation | `visit_page`, `open_document` |
| Gathering | `clip_page`, `auto_clip_page`, `read_document`, `read_screen_region`, `read_pasted_image` |
| Decisions and corrections | `resolve_conflict`, `choose_value`, `edit_value`, `clear_my_value`, `exclude_source_value`, `restore_source_value`, `remove_source` |
| Tools and views | `use_calculator`, `save_timeline`, `open_full_case_view` |
| AI | `send_to_ai` (purpose, characters sent, number of values redacted), `ai_extract_page` |
| Forms | `fill_form`, `submit_form` (reported, see `release-plan.md`) |

### Time between events

The gap between consecutive visits is **elapsed time**, which includes calls, breaks and other tabs. The interface labels it "Until next", and analysis must not treat it as time spent working on the page.

## Anonymisation

- **Recognised pages.** Each page profile gets a `urlPattern` with named placeholders, for example `/person/{nino}/employment`. The real link is replaced before anything is kept.
- **Pages with no pattern.** These are logged as `(link not kept)`.
- **Values.** No field values are stored in `detail`. The calculator logs the number of combinations found, not the amounts.
- **While the case is open.** The real links are held with the case so the caseworker can see them on the Activity tab. They are deleted with the case.

## Notes

Caseworkers can add a note to any log item. Notes are free text, so:

- they are kept **on this computer only** by default;
- they are left out of downloads unless the caseworker ticks "Include notes" in the download dialog, which warns them to check for client details;
- they are never included in the central upload, when that exists, unless the DPIA approves it;
- the note box says not to write client details.

If the DPIA rules notes out, replace them with a fixed list of reason codes.

## Removal and purging

- Caseworkers can remove items, or purge everything logged on a page when they clipped the wrong person.
- Purged traces are incomplete. Mining must treat a case with removals as partial: `remove_source` is kept unless the purge removed it. Nothing identifying is kept to mark where items were removed.
- Downloads use one chronological schema (above) for open and kept logs.

## Storage and retention

- **During the case.** The log lives in `case.log`, inside the same serialized storage writer as the rest of the case.
- **When the case is finished or discarded.** The events move to a separate `processLog` store, with real links dropped and notes kept local. Discarded cases are kept too, because abandoned paths are useful for mining.
- **Retention period.** Set by the DPIA. Kept logs older than that are deleted automatically.
- **Later.** Upload to a central store, configured in `library.json`, and delete local copies after a successful upload. The upload path needs its own access controls and retention.

## Caseworker controls

The **Activity log** page lists every event on this computer, from the open case and the kept logs.

- **Search and filters.** Search covers all columns. Filter by case, activity, page type, or "only items with a note".
- **Notes.** As above.
- **Removing items.** One at a time, or select several and confirm. Removed items are deleted locally and never downloaded or uploaded.
- **Download.** CSV or JSON of the rows shown, using `browser.downloads.download` with a `blob:` URL. Downloads always use link patterns. Notes are included only if chosen.

## Before rollout (release dependencies)

- **Sign-off.** Agree the log with HR, data protection and staff representatives. Complete the DPIA.
- **Telling staff.** Tell staff what is recorded, in the plugin and in their guidance.
- **Rules to decide:** the retention period, who can access uploaded logs, and whether caseworkers can pause logging.

## Implementation notes

- **Where logging runs.** Log navigation from the background script (`tabs.onUpdated` / `webNavigation.onCommitted`) for the active case's window, filtered to approved systems. The sidebar may be closed, so it can't be the only place logging happens.
- **Duplicates.** Debounce reloads and same-page hash changes. Add one event when the user switches to a tab that already belongs to the case.
- **Schema change.** Add `urlPattern` to the page-profile schema and its conformance fixtures.
- **Tests.**
  - Every placeholder is replaced.
  - No stored event contains a field value or a real URL.
  - A recognised page with no pattern logs `(link not kept)`.
- **Diagnostics.** `background.js` currently logs `tab.url` when auto-clip fails. Replace it with the page-type ID. Diagnostics follow the same rules as the log (see `release-plan.md`).
