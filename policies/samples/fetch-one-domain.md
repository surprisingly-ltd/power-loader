# fetch-one-domain

Background requests (fetch steps) only go to `example.gov.uk`, and never as a POST.

**What it does**
- An allow rule for `fetch-get` on `https://*.example.gov.uk/*`. A layer with allow rules for an action must have one that matches, so a background GET anywhere else is refused.
- A deny rule for `fetch-post` everywhere.

**What it leaves open**
- Reading and filling the page the caseworker is on is unchanged: the allow rule names only `fetch-get`, so this layer has no opinion on the other actions.
- Sites, the remote AI, the library and the models are as the public build.
