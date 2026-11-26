#!/usr/bin/env bash
# Runs every check GitHub Actions runs (CI, Security, the Pages build, the release checks) on this machine,
# against one commit, the way the runners do: each job in its own fresh clone of that commit, the Node and
# pnpm versions CI pins, a frozen install, CI=true, TZ=UTC, and the same versions of gitleaks, osv-scanner,
# zizmor, CodeQL and Firefox (ESR and latest). Actions minutes are scarce: nothing should reach GitHub that
# this hasn't passed. .githooks/pre-push runs it before every push to the public repo.
#
#   tools/ci-local.sh [options] [rev]        rev defaults to HEAD (commit first: the working tree is not used)
#     --base rev     run only the jobs the changes since rev can affect; default: the public repo's main
#                    (which passed CI before it merged), when the `public` remote is fetched
#     --full         run every job, whatever changed        --only a,b / --skip a,b   pick jobs by hand
#     --force        rerun jobs that already passed on this tree     --keep   keep the work directories
#     --list         list the jobs
#
# Fast where it can be: a copy change to the site or docs runs the unit tests, the site build and link
# check and the quick scans (gitleaks, osv, zizmor) in about a minute; extension, tooling, workflow and
# dependency changes run everything. A job that passed on the same tree (content, whatever the commit) is
# not run again.
#
# Not reproducible here: Scorecard (it scores the GitHub repo's own settings), the Pages deploy and smoke
# test, and AMO signing (they need GitHub or AMO). The runners are Ubuntu 24.04; this machine may differ.
set -uo pipefail

ALL_JOBS=(test lint-ext build reproducible policy site firefox-esr firefox-latest codeql osv gitleaks zizmor licences)
PUBLIC_REPO=surprisingly-ltd/power-loader

# Tool versions: keep in step with .github/workflows (CI pins them by action SHA; these are what those run).
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb # as in security.yml
OSV_VERSION=2.7.1        # google/osv-scanner-action v2.7.1
CODEQL_VERSION=2.27.6    # bundled with github/codeql-action v4.39.5
ZIZMOR_VERSION=latest    # zizmor-action's default

repo=$(git rev-parse --show-toplevel) || exit 2
cd "$repo"
only="" skip="" force=0 keep=0 rev=HEAD base="" full=0
while [ $# -gt 0 ]; do
  case $1 in
    --only) only=$2; shift ;;
    --skip) skip=$2; shift ;;
    --force) force=1 ;;
    --base) base=$2; shift ;;
    --full) full=1 ;;
    --keep) keep=1 ;;
    --list) printf '%s\n' "${ALL_JOBS[@]}"; exit 0 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) rev=$1 ;;
  esac
  shift
done

sha=$(git rev-parse --verify "$rev^{commit}") || exit 2
tree=$(git rev-parse "$sha^{tree}")
stamp="$(git rev-parse --git-common-dir)/ci-local/passed/$tree" # jobs that passed on this tree, one a line

# Which jobs can the changes since the base affect? Unknown paths, workflows and dependencies: all of them.
QUICK="gitleaks osv zizmor" # seconds each, and they depend on outside databases, so they always run
affected() { # file -> jobs
  case $1 in
    # case patterns: * matches / too. The first match wins, so the narrow folders come first.
    extension/*|tools/*|amo-metadata.json|server/*|.gitignore)
                                                    echo test lint-ext build reproducible policy site firefox-esr firefox-latest codeql ;;
    policies/*)                                     echo test policy ;;
    demo/*)                                         echo test site build firefox-esr firefox-latest codeql ;;
    tests/*|prototype/*|fixtures/*)                 echo test firefox-esr firefox-latest codeql ;;
    # The UX lab is a local tool: nothing ships from it and no CI job builds it (lab/README.md says so).
    lab/*)                                          echo ;;
    site/*.js|site/*.mjs)                           echo test site build codeql ;;
    site/*|docs/*|*.md|LICENSE|NOTICE)              echo test site build ;;
    *)                                              echo ALL ;;
  esac
}
if [ -z "$base" ] && [ $full = 0 ] && [ -z "$only" ] && git rev-parse -q --verify public/main >/dev/null; then
  base=public/main
fi
selected=""
if [ -n "$only" ]; then selected=" ${only//,/ } "
elif [ $full = 1 ] || [ -z "$base" ]; then selected=" ${ALL_JOBS[*]} "
else
  base_sha=$(git rev-parse --verify "$base^{commit}") || exit 2
  selected=" $QUICK "
  while IFS= read -r f; do
    for j in $(affected "$f"); do
      [ "$j" = ALL ] && { selected=" ${ALL_JOBS[*]} "; break 2; }
      [[ $selected == *" $j "* ]] || selected+="$j "
    done
  done < <(git diff --name-only "$base_sha" "$sha")
  # The reproducible check needs the build job's artifact.
  [[ $selected == *" reproducible "* && $selected != *" build "* ]] && selected+="build "
fi
jobs=()
for j in "${ALL_JOBS[@]}"; do
  [[ $selected == *" $j "* ]] || continue
  [[ ",$skip," == *",$j,"* ]] && continue
  if [ $force = 0 ] && [ -e "$stamp" ] && grep -qx "$j" "$stamp" &&
     ! { [ "$j" = build ] && [[ $selected == *" reproducible "* ]] && ! grep -qx reproducible "$stamp"; }; then
    continue
  fi
  jobs+=("$j")
done
if [ ${#jobs[@]} = 0 ]; then
  echo "ci-local: nothing to run for ${sha:0:12}: every job its changes affect already passed on this tree."
  exit 0
fi

cache=${XDG_CACHE_HOME:-$HOME/.cache}/power-loader-ci
mkdir -p "$cache"
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/ci-local.XXXXXX")
logs="$run_dir/logs"
mkdir -p "$logs"
export CI=true TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8
unset POWERLOADER_FIREFOX_HEADFUL

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# --- toolchain: the versions CI uses -------------------------------------------------------------------
want_node=$(sed -n 's/^ *node-version: *//p' .github/actions/setup/action.yml | head -1)
want_pnpm=$(node -p "require('./package.json').packageManager.split('@')[1]")
have_node=$(node -v 2>/dev/null | sed 's/^v//')
have_pnpm=$(pnpm -v 2>/dev/null)
if [ "$have_node" != "$want_node" ] || [ "$have_pnpm" != "$want_pnpm" ]; then
  echo "CI uses Node $want_node and pnpm $want_pnpm; this shell has Node ${have_node:-none} and pnpm ${have_pnpm:-none}." >&2
  echo "Install those versions first (corepack/fnm/nvm) so the results mean the same thing." >&2
  exit 2
fi

fetch() { # url dest
  curl -sSfL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}

tool_gitleaks() {
  local dir="$cache/gitleaks-$GITLEAKS_VERSION"
  if [ ! -x "$dir/gitleaks" ]; then
    mkdir -p "$dir"
    local f=gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz
    fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/$f" "$dir/$f" || return 1
    echo "$GITLEAKS_SHA256  $dir/$f" | sha256sum -c --quiet - || return 1
    tar -xzf "$dir/$f" -C "$dir" gitleaks && rm "$dir/$f"
  fi
  echo "$dir/gitleaks"
}

tool_osv() {
  local dir="$cache/osv-scanner-$OSV_VERSION"
  if [ ! -x "$dir/osv-scanner" ]; then
    mkdir -p "$dir"
    local base="https://github.com/google/osv-scanner/releases/download/v$OSV_VERSION"
    fetch "$base/osv-scanner_linux_amd64" "$dir/osv-scanner_linux_amd64" || return 1
    fetch "$base/osv-scanner_SHA256SUMS" "$dir/SHA256SUMS" || return 1
    (cd "$dir" && grep ' osv-scanner_linux_amd64$' SHA256SUMS | sha256sum -c --quiet -) || return 1
    mv "$dir/osv-scanner_linux_amd64" "$dir/osv-scanner" && chmod +x "$dir/osv-scanner"
  fi
  echo "$dir/osv-scanner"
}

tool_codeql() {
  local dir="$cache/codeql-$CODEQL_VERSION"
  if [ ! -x "$dir/codeql/codeql" ]; then
    mkdir -p "$dir"
    local base="https://github.com/github/codeql-action/releases/download/codeql-bundle-v$CODEQL_VERSION"
    echo "Downloading the CodeQL $CODEQL_VERSION bundle (~560 MB, once)" >&2
    fetch "$base/codeql-bundle-linux64.tar.zst" "$dir/bundle.tar.zst" || return 1
    fetch "$base/codeql-bundle-linux64.tar.zst.checksum.txt" "$dir/checksum.txt" || return 1
    echo "$(awk '{print $1}' "$dir/checksum.txt")  $dir/bundle.tar.zst" | sha256sum -c --quiet - || return 1
    tar --zstd -xf "$dir/bundle.tar.zst" -C "$dir" && rm "$dir/bundle.tar.zst"
  fi
  echo "$dir/codeql/codeql"
}

tool_firefox() { # esr|latest: the version setup-firefox would install today
  local key; [ "$1" = esr ] && key=FIREFOX_ESR || key=LATEST_FIREFOX_VERSION
  local v
  v=$(curl -sSf --retry 3 https://product-details.mozilla.org/1.0/firefox_versions.json |
      node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$key']))") || return 1
  local dir="$cache/firefox-$v"
  if [ ! -x "$dir/firefox/firefox" ]; then
    mkdir -p "$dir"
    local base="https://ftp.mozilla.org/pub/firefox/releases/$v"
    local f="firefox-$v.tar.xz"
    echo "Downloading Firefox $v" >&2
    fetch "$base/linux-x86_64/en-US/$f" "$dir/$f" || return 1
    fetch "$base/SHA256SUMS" "$dir/SHA256SUMS" || return 1
    local want; want=$(grep " linux-x86_64/en-US/$f\$" "$dir/SHA256SUMS" | awk '{print $1}')
    [ -n "$want" ] && echo "$want  $dir/$f" | sha256sum -c --quiet - || return 1
    # Unpack beside the cache entry and keep it only if it runs: an unpacking cut short (a cache once held
    # every file cut to 4 MiB, and Firefox died with a bus error) must not be taken for a good install.
    local tmp; tmp=$(mktemp -d "$dir/unpack.XXXXXX") || return 1
    if tar -xJf "$dir/$f" -C "$tmp" && "$tmp/firefox/firefox" --version >/dev/null; then
      mv "$tmp/firefox" "$dir/firefox" && rm -rf "$tmp" "$dir/$f" "$dir/SHA256SUMS"
    else
      echo "Firefox $v didn't unpack into something that runs; leaving $tmp to look at" >&2; return 1
    fi
  fi
  echo "$dir/firefox/firefox"
}

# --- jobs: each in a fresh clone, as on a runner ------------------------------------------------------
# Only the commit's own history, as a runner checks out: no other branches (gitleaks scans all it sees).
target_ref="refs/ci-local/$$"
git update-ref "$target_ref" "$sha"
trap 'git -C "$repo" update-ref -d "$target_ref"' EXIT
checkout() { # name -> prints work dir
  local w="$run_dir/$1"
  git init -q "$w" && git -C "$w" fetch -q "$repo" "$target_ref" && git -C "$w" checkout -q --detach FETCH_HEAD && echo "$w"
}
setup() { # vendor=true|false, in the current dir: .github/actions/setup
  pnpm install --frozen-lockfile && { [ "${1:-true}" = false ] || pnpm vendor; }
}

job_test()     { setup && pnpm check:demo && pnpm test && pnpm test:prototype; }
job_lint-ext() { setup && pnpm check:lint; }
job_build()    { setup && pnpm check:vendor && pnpm build:ext && pnpm bundle:source &&
                 ls dist/power-loader-*.zip && mkdir -p "$run_dir/artifact" && cp dist/power-loader-*.zip "$run_dir/artifact/"; }
job_reproducible() {
  setup false || return 1
  [ -d "$run_dir/artifact" ] || { echo "Needs the build job's artifact (run build too)"; return 1; }
  local version work; version=$(node -p "require('./extension/manifest.json').version"); work=$(mktemp -d -p "$run_dir")
  unzip -q "$run_dir/artifact/power-loader-${version}-src.zip" -d "$work/src" &&
  (cd "$work/src" && pnpm install --frozen-lockfile && pnpm build:ext) &&
  unzip -q "$run_dir/artifact/power-loader-${version}.zip" -d "$work/ci" &&
  unzip -q "$work/src/dist/power-loader-${version}.zip" -d "$work/rebuilt" &&
  diff -r "$work/ci" "$work/rebuilt" && echo "Rebuilt from source: identical to the CI build"
}
# Organisation builds (docs/organisation-builds.md): every sample policy file builds, and the package lints
# clean against the same baseline; then the locked-down sample runs in Firefox ESR, installed as a normal add-on
# (tests/tools/firefox-org-build.mjs). Local only: it isn't a GitHub Actions job.
job_policy() {
  local ff; ff=$(tool_firefox esr) || return 1
  setup || return 1
  POWERLOADER_FIREFOX=$ff pnpm test:firefox:org || return 1
  local f out dir version; version=$(node -p "require('./extension/manifest.json').version")
  for f in policies/samples/*.json; do
    case $f in *.expect.json) continue ;; esac
    rm -rf dist
    pnpm build:ext --policy "$f" || return 1
    out=$(ls dist/power-loader-"$version"-*.zip | grep -v -- '-src\.zip$' | head -1)
    [ -n "$out" ] || { echo "No package built for $f"; return 1; }
    dir=$(mktemp -d -p "$run_dir") && unzip -q "$out" -d "$dir" &&
      node -e "const m=require('$dir/manifest.json'); if (m.browser_specific_settings.gecko.id.endsWith('@surprisingly.ltd')) process.exit(1)" &&
      cmp -s "$f" "$dir/policy.json" &&
      node tools/check-lint.mjs --source-dir "$dir" || { echo "$f: the organisation build failed its checks"; return 1; }
    echo "$f: built and linted ($out)"
  done
}
job_site() {
  setup || return 1
  # The Pages build also serves the published signed releases; it needs a token, as in pages.yml.
  if GH_TOKEN=${GH_TOKEN:-$(gh auth token 2>/dev/null)} && [ -n "$GH_TOKEN" ]; then
    GH_TOKEN=$GH_TOKEN node tools/fetch-releases.mjs || return 1
  else
    echo "No gh token: skipping tools/fetch-releases.mjs (the Pages build runs it)"
  fi
  pnpm build:site && pnpm check:site
}
job_firefox() { local ff; ff=$(tool_firefox "$1") || return 1; setup && "$ff" --version && POWERLOADER_FIREFOX=$ff pnpm test:firefox; }
job_firefox-esr()    { job_firefox esr; }
job_firefox-latest() { job_firefox latest; }

job_codeql() {
  local cq; cq=$(tool_codeql) || return 1
  local cfg="$run_dir/codeql-config.yml" db="$run_dir/codeql-db" sarif="$run_dir/codeql"
  # security.yml: languages javascript-typescript and actions, queries security-extended, .github/codeql.yml.
  { cat .github/codeql.yml; printf 'queries:\n  - uses: security-extended\n'; } > "$cfg"
  "$cq" database create "$db" --db-cluster --overwrite --language=javascript-typescript,actions \
    --source-root . --codescanning-config "$cfg" --threads=0 || return 1
  mkdir -p "$sarif"
  local lang pack
  for lang in javascript actions; do
    pack=$lang-queries; [ $lang = javascript ] && pack=javascript-queries
    "$cq" database analyze "$db/$lang" "codeql/$pack:codeql-suites/$lang-security-extended.qls" \
      --format=sarif-latest --output="$sarif/$lang.sarif" --threads=0 || return 1
  done
  # Fails on any alert not in tools/codeql-baseline.json: false positives reviewed one by one, each with its
  # reason, matched by rule and file (lines move). GitHub has no in-source suppression for CodeQL, so on
  # GitHub these stay as code-scanning alerts until someone dismisses them there with the same reason.
  node - tools/codeql-baseline.json "$sarif"/*.sarif <<'EOF'
const fs = require('fs');
const [baselineFile, ...sarifs] = process.argv.slice(2);
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : [];
const allowed = new Map(baseline.map((b) => [b.finding, b]));
const seen = new Map(); let bad = 0, known = 0;
for (const f of sarifs) for (const run of JSON.parse(fs.readFileSync(f)).runs)
  for (const r of run.results || []) {
    const loc = r.locations?.[0]?.physicalLocation;
    const key = `${r.ruleId} ${loc?.artifactLocation?.uri}`;
    seen.set(key, (seen.get(key) || 0) + 1);
    const b = allowed.get(key), ok = b && b.reason && seen.get(key) <= b.count;
    console.log(`${ok ? 'baseline ' : ''}${r.ruleId}: ${loc?.artifactLocation?.uri}:${loc?.region?.startLine} ${r.message?.text?.split('\n')[0]}`);
    ok ? known++ : bad++;
  }
for (const b of baseline) if (!seen.has(b.finding)) console.log(`tools/codeql-baseline.json: ${b.finding} no longer occurs: take it out`);
console.log(`${bad} new CodeQL alert(s), ${known} in tools/codeql-baseline.json; on GitHub all of them become code-scanning alerts`);
process.exit(bad ? 1 : 0);
EOF
}
job_osv() { local o; o=$(tool_osv) || return 1; "$o" scan --lockfile=pnpm-lock.yaml; }
job_gitleaks() {
  local g; g=$(tool_gitleaks) || return 1
  "$g" git --config .gitleaks.toml --redact --no-banner --verbose .
}
job_zizmor() {
  # As zizmor-action: the regular persona, online audits with a token. Findings become code-scanning alerts.
  GH_TOKEN=${GH_TOKEN:-$(gh auth token 2>/dev/null)} uvx "zizmor@$ZIZMOR_VERSION" --persona=regular .
}
job_licences() { setup false && node tools/ci-local-licences.mjs "$PUBLIC_REPO"; }

# --- run -----------------------------------------------------------------------------------------------
say "ci-local: ${sha:0:12} $(git log -1 --format=%s "$sha")"
echo "jobs: ${jobs[*]}"
echo "logs: $logs"
declare -A result secs
failed=0
for j in "${jobs[@]}"; do
  start=$SECONDS
  printf '%-16s ' "$j"
  w=$(checkout "$j") || { echo "clone failed"; exit 2; }
  ( cd "$w" && "job_$j" ) > "$logs/$j.log" 2>&1
  rc=$?
  secs[$j]=$((SECONDS - start))
  if [ $rc = 0 ]; then result[$j]=pass; printf '\033[32mpass\033[0m %4ss\n' "${secs[$j]}"
  else
    result[$j]=FAIL; failed=1; printf '\033[31mFAIL\033[0m %4ss  %s\n' "${secs[$j]}" "$logs/$j.log"
    tail -n 25 "$logs/$j.log" | sed 's/^/    | /'
  fi
  [ $keep = 1 ] || [ "$j" = build ] || rm -rf "$w"
done

if [ $failed = 0 ]; then
  mkdir -p "$(dirname "$stamp")" && printf '%s\n' "${jobs[@]}" >> "$stamp"
  say "ci-local: passed (${jobs[*]}) for ${sha:0:12}${base:+, compared with $base}."
  [ $keep = 1 ] || rm -rf "$run_dir"
  exit 0
fi
say "ci-local: failed. Logs in $logs"
exit 1
