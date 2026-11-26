# locked-down

All of the above together, to show a fully closed build.

**What it does**
- `build.hosts` is `https://*.example.gov.uk/*`, and a site allow rule says Power Loader works only there, for every action.
- Background requests only `fetch-get` on `example.gov.uk`, never a POST.
- No remote AI. The profile assistant is off. Selecting a region of the screen is off (`tools.capture: false`), so the build has no permission to capture; the reader still reads pasted screenshots.
- The library address and the privacy model's files are fixed, on `example.gov.uk`.
- The open case is deleted when Firefox closes, and after 4 hours without use. Caseworkers can't change either.

**What it leaves open**
- Flows, forms and the library's own site rules still arrive through the library, without a new build. Its rules can only narrow these.
