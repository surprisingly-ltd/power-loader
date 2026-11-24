# Security policy

Power Loader handles casework data, so we take reports seriously and reply quickly.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately, either:

- through GitHub's [private vulnerability reporting](https://github.com/surprisingly-ltd/auto-loader/security/advisories/new), or
- by email to **privacy@surprisingly.ltd**.

Include the version (Firefox → Add-ons → Power Loader), what you did, what happened and, if you can, a
minimal page or library that shows it. We acknowledge reports within 3 working days, and agree a fix and
disclosure date with you. We credit reporters who want to be credited.

## Supported versions

Only the latest signed release receives fixes. Installed copies update themselves from
`https://powerloader.surprisingly.ltd/updates.json`.

## Scope

In scope: the extension in `extension/`, the build and release tooling, and the site at
powerloader.surprisingly.ltd. Especially interesting: anything that sends case data off the computer
without the redaction preview and the caseworker's approval; a library or page profile that runs code or
reaches a host it shouldn't; fills or submissions the caseworker didn't approve; and bypasses of policy
locks.

Out of scope: the demo pages under `/demo/` (fictional, with no back end), and findings that need a
malicious Firefox build or an attacker who already controls the computer.

## How releases are verified

Every release is signed by Mozilla. The GitHub release also carries `SHA256SUMS` and build provenance
attestations; check a download with:

    gh attestation verify power-loader-<version>.xpi -R surprisingly-ltd/auto-loader
