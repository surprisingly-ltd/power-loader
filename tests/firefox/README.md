# Firefox stability suites

Use Node.js 24.19.0, pnpm 11.3.0 and a desktop Firefox executable:

```sh
pnpm install --frozen-lockfile
pnpm vendor
pnpm test
POWERLOADER_FIREFOX=/path/to/firefox pnpm test:firefox
```

If Firefox is on PATH, omit POWERLOADER_FIREFOX. Run this command separately against the supported ESR
and the deployed release. Firefox 151 was used during implementation. Headless is the default;
set POWERLOADER_FIREFOX_HEADFUL=1 to show the browser. The runner requires localhost networking and
permission to start Firefox and child processes.

The full suite uses a temporary copy of the extension, a fresh Firefox profile, synthetic documents
and a local demo/gateway server. The production background, sidebar, injected agent, workers, CSP,
storage and network transport run together. Only the temporary manifest gets pre-granted loopback
origins and a test bootstrap; no production file or installed Firefox profile is changed.

## Coverage

- Library connection over real HTTP, verified files, rendered forms, keyboard sidebar navigation,
  case creation, clipping real tabs, conflict resolution and wrong-person removal.
- Fill preview and cancellation, approval, actual target values and page side effects, no submission,
  modal focus wrapping/Escape, finishing a case, sanitised receipts and retained logs.
- Real AI redaction preview, cancellation and required-model blocking; observed outgoing HTTP proves
  that only the approved payload is sent, browser cookies are omitted, credentials stay on the
  configured endpoint, retries reuse identical bytes, and redirects are refused.
- Gateway timeouts, authentication failures, malformed/oversized responses, corrupt and denied
  library updates, and preservation of the last good library.
- Actual PDF worker and OCR: text, rotated pages, scanned PDFs, pictures, malformed/oversized files,
  unsupported types, protected PDFs with absent/wrong/correct passwords, page budgets, cancellation,
  stopping during OCR startup and restarting after cancellation.
- Two real browser restarts with injected durable teardown checkpoints, before archival and after
  archival. The original background recovers deletion exactly once. The first restart also interrupts
  a real library-file download and verifies the previous commit survives.
- Packaged Transformers import, model hash/unknown-file rejection, unavailable mirrors and actionable
  worker failure when WebGPU or model files are unavailable.

The encrypted PDF contains only synthetic text and the password `test-password`. Regenerate it with
`node tests/tools/make-document-fixtures.mjs`; the output is deterministic. Its old PDF encryption is
used solely as a compatibility fixture.

The ordinary `pnpm test` suite also covers concurrent storage writers, refused website senders,
extension-tab access, deletion failure/retry, PDF range limits, and privacy-worker cancellation,
late results and abort-listener cleanup without needing a GPU or Firefox.

## Privacy model on target hardware

```sh
POWERLOADER_FIREFOX=/path/to/firefox POWERLOADER_FIREFOX_HEADFUL=1 POWERLOADER_TEST_MODEL=1 pnpm test:firefox
```

This explicitly enables downloading the pinned privacy model (about 920 MB) from Hugging Face.
It requires WebGPU and allows 20 minutes per browser phase. It verifies the model's built-in scan,
synthetic name/address spans, and a worker restart loading verified cached files. Without this flag,
the suite never downloads the model or contacts an AI provider. Test gateways are local and free.

## Reports and limits

Each check prints PASS/FAIL. A failure or timeout makes the command exit nonzero. The machine-readable
report is `dist/test-results/firefox.json`. On failure, the runner prints the retained temporary
directory containing its isolated profile, extension copy and browser logs. Set
POWERLOADER_KEEP_TEST_PROFILE=1 to keep these after success too. Test profiles contain only synthetic data.

`pnpm test:firefox:smoke` retains the shorter module-import/OCR/PDF check.

The suite pre-grants loopback origins, so native installation and permission prompts still need manual
checks. Restart tests inject precise persisted failure checkpoints and restart Firefox; they do not
simulate an OS power failure or disk corruption. Keyboard/focus tests do not replace NVDA testing.
Real casework sites, display-scaling capture, production managed policy and the target hardware/GPU
matrix remain rollout checks.
