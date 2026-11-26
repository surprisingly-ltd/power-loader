# no-post

Denies `fetch-post` everywhere. Fetch steps can read pages in the background, but never send a POST.

**What it does**
- A deny rule for `fetch-post` on every address, in the organisation's layer, so no library or caseworker rule can open it.

**What it leaves open**
- Everything else is as the public build: any site, each granted when the caseworker allows it.
- The remote AI, the library and the models are the caseworker's (or the library's) to set.
