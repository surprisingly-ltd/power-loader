# fixed-endpoints

The AI endpoint and model, the library address and the model files are fixed, and the build may only connect to `example.gov.uk`.

**What it does**
- `gateway.baseUrl` and `gateway.model`, `library.baseUrl`, `privacyModel.filesUrl` and `assistModel.filesUrl` are fixed. Their boxes in Settings are locked.
- The library is read with the caseworker's own sign-in (`library.auth: "cookies"`), so no token is needed.
- `build.hosts` is `https://*.example.gov.uk/*`: Firefox grants it at install, never asks site by site, and can't grant anything else.

**What it leaves open**
- Each caseworker still enters the gateway key and agrees to what is sent.
- Which pages Power Loader works on within `example.gov.uk` is left to the library's and the caseworker's site rules.
