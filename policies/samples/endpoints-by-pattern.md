# endpoints-by-pattern

The same three as `fixed-endpoints`, constrained by `allowed` patterns instead of fixed. One build serves several teams: each enters its own library repo on the one GitLab instance.

**What it does**
- The caseworker may choose any AI endpoint on `ai.example.gov.uk`, the model `fast` or any `gpt-*` model, any library under `gitlab.example.gov.uk/casework/`, and model files from `models.example.gov.uk`.
- Each request is checked against the patterns when it is sent, so an address saved before the build is never used.
- `build.hosts` is `https://*.example.gov.uk/*`.
- A case left without use is deleted after at most 9 hours (`workstation.clearCaseMaxHours`): caseworkers may choose a shorter time, not a longer one, and not never.

**What it leaves open**
- The caseworker types the addresses in Settings. Until they enter a model mirror on `models.example.gov.uk`, the privacy model can't download: Hugging Face isn't allowed.
