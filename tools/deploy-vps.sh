#!/usr/bin/env bash
set -Eeuo pipefail
umask 0002

mode=${1:-}
source_ref=${2:-}
expected_commit=${3:-}
version=${4:-}
force_failure=${5:-false}
app_root=${SCOUT_VPS_APP_ROOT:-/home/ubuntu/apps/Scout}
workspace=${SCOUT_VPS_WORKSPACE:-/home/ubuntu/Documents/Scout Workspace}
service=${SCOUT_VPS_SERVICE:-scout-host.service}
deployment_user=${SCOUT_VPS_DEPLOY_USER:-scout-deploy}
expected_service_user=${SCOUT_VPS_SERVICE_USER:-ubuntu}

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  printf 'Refusing invalid Scout beta version: %s\n' "$version" >&2
  exit 2
fi
case "$mode" in
  release)
    [[ $source_ref == "refs/tags/v$version" && $force_failure == false ]] || {
      printf 'Release deployment requires the matching immutable tag and cannot force a failure.\n' >&2
      exit 2
    }
    fetch_ref="refs/tags/v$version:refs/tags/v$version"
    target_ref="refs/tags/v$version"
    ;;
  rehearsal)
    [[ $source_ref == refs/heads/codex/release-candidate && $force_failure =~ ^(true|false)$ ]] || {
      printf 'Rehearsals are restricted to the protected, stable release-candidate branch.\n' >&2
      exit 2
    }
    fetch_ref="$source_ref:refs/scout-deploy/rehearsal"
    target_ref=refs/scout-deploy/rehearsal
    ;;
  *) printf 'Deployment mode must be release or rehearsal.\n' >&2; exit 2 ;;
esac
if [[ ! $expected_commit =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Expected release commit must be a full Git SHA.\n' >&2
  exit 2
fi
if [[ $(id -un) != "$deployment_user" ]]; then
  printf 'Deployment must run as the restricted %s account.\n' "$deployment_user" >&2
  exit 2
fi
if [[ ! -d $app_root/.git || ! -d $workspace ]]; then
  printf 'Scout application checkout or separate workspace is missing.\n' >&2
  exit 2
fi
case "$workspace/" in
  "$app_root/"*) printf 'Scout workspace must remain outside the application checkout.\n' >&2; exit 2 ;;
esac
if [[ -n $(git -C "$app_root" status --porcelain --untracked-files=normal -- . ':(exclude).scout-runtime/**') ]]; then
  printf 'Refusing to deploy over a dirty Scout application checkout.\n' >&2
  exit 2
fi

remote=$(git -C "$app_root" remote get-url origin)
if [[ ! $remote =~ github\.com[:/]oliver-hitchings/Scout(\.git)?$ ]]; then
  printf 'Scout checkout has an unexpected origin.\n' >&2
  exit 2
fi
service_user=$(systemctl show "$service" --property=User --value)
if [[ $service_user != "$expected_service_user" || $service_user == root ]]; then
  printf 'Service %s must run as the expected unprivileged owner, not %s.\n' "$service" "${service_user:-root}" >&2
  exit 2
fi
service_exec=$(systemctl show "$service" --property=ExecStart --value)
service_node=$(sed -n 's/^{ path=\([^ ;]*\).*/\1/p' <<<"$service_exec")
if [[ ! -x $service_node || $(basename "$service_node") != node ]]; then
  printf 'Service %s must expose an executable Node runtime.\n' "$service" >&2
  exit 2
fi
export PATH="$(dirname "$service_node"):$PATH"
if [[ ! -w $app_root/.git ]]; then
  printf 'Deployment account cannot update the Scout application checkout.\n' >&2
  exit 2
fi
command -v tailscale >/dev/null
command -v curl >/dev/null
command -v npm >/dev/null

serve_before=$(mktemp)
serve_after=$(mktemp)
cleanup() {
  rm -f "$serve_before" "$serve_after"
  if [[ $mode == rehearsal ]]; then git -C "$app_root" update-ref -d refs/scout-deploy/rehearsal >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
tailscale serve status --json >"$serve_before"

previous_commit=$(git -C "$app_root" rev-parse HEAD)
switched=0
rollback() {
  status=$?
  trap - ERR
  set +e
  if [[ $switched == 1 ]]; then
    printf 'Deployment failed; restoring Scout commit %s.\n' "$previous_commit" >&2
    rollback_failed=0
    if [[ $previous_commit != "$expected_commit" ]]; then
      git -C "$app_root" checkout --detach "$previous_commit" || rollback_failed=1
    fi
    (cd "$app_root" && npm ci --omit=dev) || rollback_failed=1
    previous_version=$(cd "$app_root" && node -p "require('./package.json').version") || rollback_failed=1
    sudo -n systemctl restart "$service" || rollback_failed=1
    rollback_healthy=false
    for attempt in {1..60}; do
      response=$(curl --fail --silent --show-error http://127.0.0.1:8459/api/app-info 2>/dev/null || true)
      if [[ -n $response ]] && node -e 'const info=JSON.parse(process.argv[1]); if(info.version!==process.argv[2]) process.exit(1)' "$response" "$previous_version"; then
        rollback_healthy=true
        break
      fi
      sleep 2
    done
    tailscale serve status --json >"$serve_after" || rollback_failed=1
    cmp --silent "$serve_before" "$serve_after" || rollback_failed=1
    if [[ $rollback_failed == 0 && $rollback_healthy == true ]]; then
      printf 'Rollback restored Scout %s and preserved Tailscale Serve.\n' "$previous_version" >&2
    else
      printf 'CRITICAL: automatic rollback did not restore a verified healthy host.\n' >&2
    fi
  fi
  exit "$status"
}
trap rollback ERR

git -C "$app_root" fetch --force origin "$fetch_ref"
target_commit=$(git -C "$app_root" rev-parse "$target_ref^{commit}")
if [[ $target_commit != "$expected_commit" ]]; then
  printf 'Fetched ref %s resolves to %s, not workflow commit %s.\n' "$source_ref" "$target_commit" "$expected_commit" >&2
  exit 2
fi
if [[ $mode == rehearsal && $force_failure == true && $previous_commit == "$target_commit" ]]; then
  printf 'Rollback rehearsal requires the VPS to start on a different commit.\n' >&2
  exit 2
fi

git -C "$app_root" checkout --detach "$target_commit"
switched=1
package_version=$(cd "$app_root" && node -p "require('./package.json').version")
if [[ $package_version != "$version" ]]; then
  printf 'Tag version and package version do not match.\n' >&2
  false
fi

(
  cd "$app_root"
  npm ci --omit=dev
  node tools/typst-runtime.mjs install
  node tools/typst-runtime.mjs verify --compile
  npm test
)

sudo -n systemctl restart "$service"
if [[ $mode == rehearsal && $force_failure == true ]]; then
  printf 'Controlled rehearsal failure requested after service restart.\n' >&2
  false
fi
for attempt in {1..60}; do
  if systemctl is-active --quiet "$service"; then
    response=$(curl --fail --silent --show-error http://127.0.0.1:8459/api/app-info 2>/dev/null || true)
    if [[ -n $response ]] && node -e 'const info=JSON.parse(process.argv[1]); if(info.version!==process.argv[2]) process.exit(1)' "$response" "$version"; then
      break
    fi
  fi
  if [[ $attempt == 60 ]]; then
    printf 'Scout did not become healthy on 127.0.0.1:8459 with version %s.\n' "$version" >&2
    false
  fi
  sleep 2
done

tailscale serve status --json >"$serve_after"
if ! cmp --silent "$serve_before" "$serve_after"; then
  printf 'Tailscale Serve configuration changed during deployment.\n' >&2
  false
fi
node "$app_root/tools/scout.mjs" remote preflight --require-serve-mapping
node "$app_root/tools/typst-runtime.mjs" verify --compile
cv_index=$(curl --fail --silent --show-error http://127.0.0.1:8459/api/cv)
node -e 'const index=JSON.parse(process.argv[1]); if(!Array.isArray(index.entries)) process.exit(1); const sources=index.entries.filter(entry => entry?.source === true || entry?.source?.available === true).length; console.log(`Scout CV index exposes ${sources} source CV(s).`)' "$cv_index"

trap - ERR
printf 'Scout %s is healthy; workspace, provider homes and Tailscale Serve mapping were preserved.\n' "$version"
