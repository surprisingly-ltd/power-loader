# Power Loader extraction profile DSL

A profile is a JSON document that says which pages it applies to and how to turn a
page into a JSON record. The same profile runs in the browser extension
(`extension/lib/extract.js`), including local evaluation during AI generation.

```json
{
  "id": "wikipedia-person",
  "name": "Wikipedia – person",
  "match": ["https://*.wikipedia.org/wiki/*"],
  "when": "table.infobox.biography",
  "autoClip": false,
  "fields": {
    "@type": "Person",
    "name": "#firstHeading",
    "birthDate": "table.infobox label(Born) .bday | date",
    "birthPlace": "table.infobox label(Born) .birthplace",
    "occupation": ["table.infobox label(Occupations) li"]
  }
}
```

| key        | meaning |
|------------|---------|
| `name`     | Human name for the profile (required). |
| `match`    | URL glob or list of globs; `*` matches anything. The `#fragment` is ignored. |
| `when`     | Optional locator (see below) that must match something on the page for the profile to apply. Lets several profiles share a URL pattern (e.g. Wikipedia people vs organisations). |
| `autoClip` | Optional. `true`: clip automatically whenever a matching page loads. `false`: only on click. Omitted: follow the extension's global setting. |
| `fields`   | The output shape (required). |

## Output shape (`fields`)

A **spec** is one of:

| spec | result |
|------|--------|
| `"expression"` | a single value (string, number, boolean, or `null` if nothing matched) |
| `{ "key": spec, ... }` | an object; each key evaluated against the same context |
| `["locator"]` | a list: the value of every element the locator matches |
| `["locator", spec]` | a list: `spec` evaluated once per matched element, using that element as context |
| `[{...}, {...}]` | a fixed list: when the first item is an object, every item is a spec evaluated in the current context (e.g. several `PropertyValue` identifiers) |

List items that come out empty (`null`, or an object whose non-`@` fields are all `null`) are left out. That means a row selector can safely match header or spacer rows.

Inside an object:

- `"$scope": "locator"` narrows the context for all sibling keys to the first match. If it matches nothing the whole object is `null`.
- Keys starting with `@` (e.g. `"@type": "Person"`, `"@context": "https://schema.org"`) are copied into the output literally.
- Any other key starting with `$` is reserved and ignored.

An expression starting with `=` is a literal: `"addressCountry": "=GB"`.

## Expressions

```
[locator] [| filter[:arg]] [| filter[:arg]] ...
```

### Locators

```
[css-selector] [label(Label text)] [css-selector] [@attribute]
```

All parts are optional and are applied left to right, relative to the current context:

1. **css-selector**: the first descendant matching a standard CSS selector (`querySelector` semantics). Use only selectors that both browsers and soupsieve support: ids, classes, attributes (`[name=dob]`, `[href^=mailto]`), combinators, `:nth-child()`, `:nth-of-type()`, `:first-child`, `:not()`. Don't use `:contains()`, `:has()` or jQuery extensions.
2. **`label(Text)`**: find the element whose own text is `Text` and return the value that sits *next to* it. Matching ignores case, surrounding whitespace, and trailing `:` or `*`. The value is:
   - `<label for=x>` → element `#x` (or the control nested in the label)
   - text directly after the label, up to the next element (`<b>Name:</b> Jane Doe <span>…`) → `Jane Doe`
   - otherwise the label's next element sibling (`dt`→`dd`, `th`→`td`, `span`→`span`), climbing up to 4 ancestors to find one (`<td><b>Name</b></td><td>…</td>`)
   - failing all of those, an element whose text *starts* with `Text:` (`<li>Status: Open</li>`) → the text after the colon.
   Quote the text if it contains `)`: `label("Date of birth (DOB)")`. A CSS selector before `label()` limits where the label is searched for; one after it searches inside the found value.
3. **`@attr`**: take an attribute instead of the text (`a @href`, `img @src`, `@data-id` on the context itself). `@value` and `@checked` read the live form state.
4. An empty locator or `.` means the context element itself (useful inside lists: `["li", "."]`).

### Values

Without `@attr`, the value of an element is:

- `<input>`: its current value; checkboxes and radios give `"true"`/`"false"`
- `<textarea>`: its current value
- `<select>`: the text of the selected option
- anything else: its text, with whitespace collapsed and line breaks kept at block boundaries (`<br>`, `<p>`, `<div>`, `<li>`, `<tr>`…). Text in `script`, `style` and `template` is ignored.

Empty strings become `null`. Hidden text (`display:none`) is *included*, because pages often put machine-readable values there (e.g. Wikipedia's `.bday`).

### Filters

Filters run left to right. A `null` value passes straight through every filter except `default`. If a value is a list, each filter is applied to every item.

| filter | effect |
|--------|--------|
| `trim`, `upper`, `lower` | the obvious |
| `oneline` | join lines with `, ` (addresses) |
| `lines` | split into a list of non-empty lines |
| `split:SEP` | split on `SEP` (default `,`) into a list of trimmed, non-empty parts |
| `number` | first number in the text, ignoring thousands separators and currency (`"£1,234.50"` → `1234.5`) |
| `int` | first integer |
| `date` | ISO date `YYYY-MM-DD`. Accepts `2020-03-12`, `12/03/2020` (day first; use `date:mdy` for US order), `12 March 2020`, `March 12, 2020`, `Thu 12 Mar 2020 14:00`. `March 2020` becomes `2020-03`. Unparseable text is kept unchanged. |
| `bool` | yes/no/true/false/on/off/1/0/checked → boolean, anything else → `null` |
| `after:TEXT` / `before:TEXT` | the text after/before the first occurrence of TEXT (unchanged if TEXT is absent) |
| `remove:TEXT` | delete every occurrence of TEXT |
| `drop:REGEX` | delete every match of REGEX (e.g. `drop:\[[0-9]+\]` strips citation markers) |
| `regex:REGEX` | first capture group of the first match (or the whole match); `null` if no match |
| `abs` | resolve a relative URL against the page URL |
| `json` | parse the text as JSON (e.g. `script[type="application/ld+json"] \| json`) |
| `default:VALUE` | use VALUE if the value is `null` |

Filters are separated by `|`. A `|` inside `()` or `[]`, or escaped as `\|`, does not split, so put alternations in a group: `regex:(Mr|Mrs|Ms)`. Regexes should stick to syntax shared by JavaScript and Python: no flags, lookbehind, or named groups.

## schema.org

Where it fits, shape records using [schema.org](https://schema.org) types and property names, so that the same kind of information looks the same whichever system it came from:

- `Person`: `name`, `givenName`, `familyName`, `honorificPrefix`, `birthDate`, `deathDate`, `gender`, `nationality`, `email`, `telephone`, `address`, `jobTitle`, `worksFor`, `identifier`
- `Organization`: `name`, `legalName`, `identifier`, `foundingDate`, `dissolutionDate`, `address`, `email`, `telephone`, `url`, `numberOfEmployees`, `founder`, `employee`
- `PostalAddress`: `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`
- `ContactPoint`: `contactType`, `email`, `telephone`
- `PropertyValue` for named identifiers: `{"@type": "PropertyValue", "propertyID": "=NI number", "value": "..."}`
- Lists of related records: e.g. `"knows"`/`"relatedTo"` for household members, `"subjectOf"` for notes
- Dates as ISO strings (`| date`), money as numbers (`| number`)

Use camelCase for any field that has no schema.org equivalent (`caseReference`, `riskLevel`).

## Example

```html
<h1 class="client-name">Jane Doe</h1>
<dl>
  <dt>Date of birth</dt><dd>12/03/1980</dd>
  <dt>Email</dt><dd><a href="mailto:jane@example.org">jane@example.org</a></dd>
</dl>
<table id="household">
  <tr><th>Name</th><th>Relationship</th></tr>
  <tr><td>John Doe</td><td>Partner</td></tr>
</table>
```

```json
{
  "@type": "Person",
  "name": "h1.client-name",
  "birthDate": "label(Date of birth) | date",
  "email": "label(Email) a @href | remove:mailto:",
  "relatedTo": ["#household tr:not(:first-child)", {
    "@type": "Person",
    "name": "td:nth-child(1)",
    "relationship": "td:nth-child(2)"
  }]
}
```

→

```json
{
  "@type": "Person",
  "name": "Jane Doe",
  "birthDate": "1980-03-12",
  "email": "jane@example.org",
  "relatedTo": [{"@type": "Person", "name": "John Doe", "relationship": "Partner"}]
}
```
