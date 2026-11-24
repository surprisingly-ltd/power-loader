# Power Loader fill profiles

A fill profile is the reverse of an extraction profile. It says which web form it applies to and,
for each form control, where in the caseworker's collected case data the value comes from. The
extension resolves the values and fills the form in the browser. Nothing is submitted.

```json
{
  "kind": "fill",
  "name": "Northshire housing referral",
  "match": ["https://forms.example.gov.uk/referral*"],
  "when": "form#referral",
  "fields": {
    "#firstName": ["Person.givenName", "Person.name | regex:^(\\S+)"],
    "#dob": "Person.birthDate",
    "#nino": "Person.identifier[propertyID=NI number].value",
    "#address": "Person.address.streetAddress | join:\\n",
    "#consent": "Person.consentToShare",
    "#orgName": "Organization.legalName"
  },
  "lists": [
    {
      "source": "Person.relatedTo",
      "rows": "#household > tr",
      "add": "#addMember",
      "fields": {
        "input[name=memberName]": ".name",
        "input[name=memberDob]": ".birthDate"
      }
    }
  ]
}
```

| key | meaning |
|-----|---------|
| `kind` | Always `"fill"`. |
| `name`, `match`, `when` | As in extraction profiles: a name, URL globs, and an optional selector the page must contain. |
| `fields` | `{ "css selector of a form control": value }`. |
| `lists` | Repeating sections such as table rows. `source` is a path to a list in the case data. `rows` selects the existing rows. `add` is an optional button the extension clicks to add rows until there is one per item. `fields` are selectors *inside a row*, with values usually relative to the item (`.name`). |

## Values

A value is a **path expression**, or a list of them: the first that yields something wins. So
use a list when different records name things differently (`["Person.givenName", "Person.name | regex:^(\\S+)"]`).

```
Type.key.key[selector].key | filter | filter
```

- The first segment is a record's schema.org `@type` (`Person`, `Organization`, …), meaning the
  first record of that type in the case. `Person[1]` is the second Person, and
  `Person[name=Jane Doe]` is the Person whose `name` is that. `*` is the first record of any type.
- Then keys, as found in the data. A key applied to a list collects it from every item
  (`Person.relatedTo.name`).
- `[n]` picks an item from a list (`[-1]` is the last). `[key=value]` picks the first item whose
  `key` equals `value`, ignoring case: `Person.identifier[propertyID=NI number].value`.
- A path starting with `.` is relative to the current list item (only inside `lists[].fields`).
- `=text` is a literal value.

Whatever the path ends on is turned into the control's value: text and numbers as they are,
`true`/`false` for checkboxes, a list as `a, b, c`, and an object as its values joined with `, `.

### Filters

All extraction filters work (`date`, `upper`, `regex:…`, `before:…`, `after:…`, `remove:…`,
`split:…`, `default:…`, …), plus two for lists:

| filter | effect |
|--------|--------|
| `join:SEP` | join a list into text with SEP (default `, `; `\n` means a new line) |
| `first` | the first item of a list |

## How controls are set

- Text inputs and textareas: the value as text.
- `type=date`: needs `YYYY-MM-DD`. Other date formats are converted where possible.
- `<select>`: the option whose value or visible text matches (ignoring case). Failing that, an
  option whose text starts with the value.
- Checkboxes: `true`/`yes`/`1` ticks, `false`/`no`/`0` unticks.
- Radio buttons: target any button in the group; the one whose value or label matches is chosen.

Every filled control is outlined in green, and the caseworker reviews the form before submitting it.
