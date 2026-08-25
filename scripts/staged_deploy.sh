#!/usr/bin/env bash
#
# Staged deploy — build everything, verify it, THEN swap containers.
#
# Why this exists alongside safe_update.sh
# ----------------------------------------
# safe_update.sh is one shot: it backs up, migrates and swaps in a single
# unattended run. That is the right shape for the Admin Center's Update button,
# where nobody is watching a terminal — and it stays wired to that.
#
# It is the wrong shape for a remote deploy an operator is driving. There you
# want to do all the slow, risky, failure-prone work (backup, pull, build)
# while production keeps serving the OLD containers, confirm the artifacts are
# what you think they are, and only then take the short maintenance window.
#
# The split matters because `docker compose build` does not touch a running
# container. Everything in `stage` is therefore invisible to users: if the
# build breaks, the pull conflicts, or the backup dies, production never
# noticed. Only `swap` is user-visible, and it is measured in seconds.
#
#   ./scripts/staged_deploy.sh stage    # backup, pull, build, verify. No swap.
#   ./scripts/staged_deploy.sh swap     # maintenance -> migrate -> swap -> verify
#   ./scripts/staged_deploy.sh status   # what is built vs what is running
#
# Run `stage` whenever you like — during business hours is fine, that is the
# point. Run `swap` when you are ready to spend the window.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRANCH="${BRANCH:-main}"
STAGE_MARKER="$ROOT_DIR/.staged-deploy.json"
MAINTENANCE_FLAG_FILE="$ROOT_DIR/infra/maintenance/.flag"
# Stage multi-GB archives on real disk, never the /tmp tmpfs. These are the
# scripts' own knobs — deliberately not TMPDIR, which arrives from too many
# places (cron, the runner container) to be trustworthy.
export BACKUP_STAGING_ROOT="${BACKUP_STAGING_ROOT:-/var/tmp}"
export PREFLIGHT_STAGING_ROOT="${PREFLIGHT_STAGING_ROOT:-/var/tmp}"

# ── Single-deploy lock ──────────────────────────────────────────────────────
# The Admin Center (update_runner) and an operator shell can otherwise deploy
# at the same time and lift each other's maintenance page. jobs.py has only an
# in-process lock, which does not see a second process. The repo directory is
# bind-mounted into the runner at /repo, so both paths flock the same inode.
DEPLOY_LOCK="${DEPLOY_LOCK:-$ROOT_DIR/.deploy.lock}"
# flock comes from busybox in the runner image rather than an explicit package,
# so treat it as best-effort: warn and continue if it ever disappears. Silently
# losing the Admin Center's update button would be a worse failure than the
# concurrent-deploy race this guards against.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$DEPLOY_LOCK"
  if ! flock -n 9; then
    echo "Another deploy is already running (lock: $DEPLOY_LOCK). Refusing to start a second one." >&2
    exit 75   # EX_TEMPFAIL — the runner surfaces this as a failed job, not a crash
  fi
else
  echo "WARNING: flock unavailable; running without the concurrent-deploy guard." >&2
fi

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Resolve through compose rather than guessing container names: the project
# prefix depends on the directory/COMPOSE_PROJECT_NAME and is not ours to assume.
container_id() { docker compose ps -q "$1" 2>/dev/null | head -1; }

running_image_id() {
  local cid; cid="$(container_id "$1")"
  [[ -n "$cid" ]] || { echo ""; return 0; }
  docker inspect -f '{{.Image}}' "$cid" 2>/dev/null | sed 's/^sha256://' || echo ""
}

# Full digest, so it is comparable with running_image_id. `docker images -q`
# returns a 12-char id, which can never equal a 64-char digest — that made the
# update_runner check below fire on every single swap.
built_image_id() {
  # Anchor on the service suffix. A bare `grep api` also matches
  # `smpl-all-api_worker`, and `docker compose config --images` does not
  # guarantee an order — so `status` intermittently compared the api service
  # against api_worker's image and reported a swap that had actually worked.
  local image
  image="$(docker compose config --images 2>/dev/null | grep -m1 -E "(^|[-_/])$1\$" || echo "$1")"
  docker image inspect -f '{{.Id}}' "$image" 2>/dev/null | sed 's/^sha256://' || echo ""
}

health_of() {
  local cid; cid="$(container_id "$1")"
  [[ -n "$cid" ]] || { echo "missing"; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown"
}

# ────────────────────────────────────────────────────────────────────────────
cmd_status() {
  log "Built vs running"
  printf '   %-16s %-22s %s\n' SERVICE BUILT RUNNING
  for svc in api api_worker web update_runner; do
    printf '   %-16s %-22s %s\n' "$svc" "$(built_image_id "$svc" | cut -c1-12)" \
      "$(running_image_id "$svc" | sed 's/^sha256://' | cut -c1-12)"
  done
  echo
  info "repo:    $(git rev-parse --short HEAD) ($(git describe --tags --always))"
  info "release: $(grep -h APP_RELEASE_VERSION apps/api/.release.env 2>/dev/null || echo '(none)')"
  if [[ -f "$STAGE_MARKER" ]]; then
    echo; info "STAGED and awaiting swap:"; sed 's/^/     /' "$STAGE_MARKER"
  else
    echo; info "Nothing staged."
  fi
  [[ -f "$MAINTENANCE_FLAG_FILE" ]] && { echo; info "NOTE: maintenance page is currently UP."; }
  return 0
}

# ────────────────────────────────────────────────────────────────────────────
cmd_stage() {
  log "1/5  Encrypted backup (production still serving)"
  ./scripts/backup.sh || die "backup failed — nothing was changed"
  local backup
  # No `ls | head` here: under `set -o pipefail` head's SIGPIPE kills the
  # assignment before the guard below can print anything useful.
  backup="$(find backups -maxdepth 1 -name '*.tar.enc' -newermt '-2 hours' -print 2>/dev/null | sort | tail -1)"
  info "backup: ${backup:-<none>}"
  [[ -n "$backup" ]] || die "backup.sh reported success but produced no archive"

  # Captured BEFORE the pull: a failed swap needs the commit to go back to,
  # which the post-pull HEAD no longer tells us.
  ROLLBACK_COMMIT="$(git rev-parse HEAD)"

  log "2/5  Fetch + fast-forward $BRANCH"
  git fetch --tags --prune origin
  # Check the pull can actually land BEFORE spending anything on it. An
  # untracked file on the host that the incoming commit also adds makes
  # `git pull` abort with "untracked working tree file would be overwritten" —
  # and safe_update.sh carries a whole stash dance for exactly this. Rather
  # than reimplement that, detect it and say precisely which files are in the way.
  local blocking
  blocking="$(git merge-tree --name-only HEAD "origin/$BRANCH" 2>/dev/null | while read -r f; do
      [[ -n "$f" && -e "$f" ]] && git ls-files --error-unmatch "$f" >/dev/null 2>&1 || { [[ -e "$f" ]] && echo "$f"; }
    done || true)"
  if [[ -n "$blocking" ]]; then
    echo "$blocking" | sed 's/^/     /' >&2
    die "untracked files above would be overwritten by the pull — move or remove them, then re-run stage"
  fi
  git pull --ff-only origin "$BRANCH" || die "pull is not a fast-forward — resolve by hand"
  info "repo now at $(git rev-parse --short HEAD) ($(git describe --tags --always))"

  log "3/5  Release metadata"
  ./scripts/update_release_metadata.sh
  # Export so `docker compose build` forwards them as build args.
  set -a; . apps/api/.release.env; set +a
  info "APP_RELEASE_VERSION=$APP_RELEASE_VERSION"

  log "4/5  Build images (running containers untouched)"
  docker compose build api api_worker web update_runner

  log "5/5  Verify the built image carries the right stamp"
  # The mistake this catches: a build that silently reuses a cached layer and
  # ships the previous release string. Read it out of the image we just built,
  # before it can reach production.
  local baked
  baked="$(docker run --rm --entrypoint sh "smpl-all-api:latest" \
             -c 'cat /app/.release.env 2>/dev/null' | grep APP_RELEASE_VERSION || true)"
  info "baked into image: ${baked:-<missing>}"
  [[ "$baked" == "APP_RELEASE_VERSION=$APP_RELEASE_VERSION" ]] \
    || die "image stamp mismatch — built '$baked', expected 'APP_RELEASE_VERSION=$APP_RELEASE_VERSION'"

  cat > "$STAGE_MARKER" <<EOF
{
  "staged_at":       "$(date -Is)",
  "deploying_to":    "$(git rev-parse HEAD)",
  "rollback_to":     "$ROLLBACK_COMMIT",
  "version":         "$APP_RELEASE_VERSION",
  "backup":          "$backup"
}
EOF

  log "STAGED — production is still on the old containers"
  info "Nothing user-visible has happened yet."
  info "Migration state (db 'current' vs repo 'head' — differing means work pending):"
  { docker compose exec -T api alembic current 2>/dev/null | tail -1 | sed 's/^/     db:   /'; } || true
  { docker compose run --rm --no-deps -T api alembic heads 2>/dev/null | tail -1 | sed 's/^/     repo: /'; } || true
  echo
  info "When ready:  ./scripts/staged_deploy.sh swap"
}

# ────────────────────────────────────────────────────────────────────────────
cmd_swap() {
  [[ -f "$STAGE_MARKER" ]] || die "nothing staged — run 'stage' first"
  log "Swapping to:"; sed 's/^/     /' "$STAGE_MARKER"

  # From here on the clock is running. Keep this section as short as possible.
  log "1/4  Maintenance page up"
  mkdir -p "$(dirname "$MAINTENANCE_FLAG_FILE")"
  touch "$MAINTENANCE_FLAG_FILE"
  # Caddy's file matcher is evaluated per request, so this is instant.
  # Deliberately NOT an "rm -f the flag" trap. Every die() below says
  # "maintenance stays up", and that is the correct behaviour: the only way to
  # reach a failure here is after migrations have started, so the old
  # containers can no longer safely serve the new schema. Leaving users on the
  # maintenance page is the safe state; dropping them onto a half-migrated
  # stack is not. The flag is removed only on the success path.
  trap 'echo "SWAP FAILED — maintenance page left UP on purpose. Fix, then re-run swap, or restore from the backup named in '"$STAGE_MARKER"'." >&2' ERR

  log "2/4  Migrations"
  docker compose run --rm --no-deps -T api alembic upgrade head || die "migration failed — maintenance stays up, restore from $(grep -o '"backup":.*' "$STAGE_MARKER")"

  log "3/4  Swap containers"
  # Explicitly guarded rather than left to `set -e`: web and api_worker both
  # `depends_on: api: condition: service_healthy`, so a crash-looping new api
  # makes this exit non-zero — and that happens AFTER the migration committed.
  # Maintenance must stay up.
  # --force-recreate is REQUIRED, not defensive. `docker compose up -d` decides
  # staleness from the service's config hash, not the image digest — so an
  # image rebuilt under the same tag does NOT trigger a recreate. On the
  # v2.10.1 swap that silently skipped `web` entirely (api and api_worker were
  # only recreated by luck: they env_file `apps/api/.release.env`, whose
  # contents changed, which DID move their hash). A frontend-only release would
  # otherwise build, report success, and never go live.
  docker compose up -d --force-recreate api api_worker web \
    || die "container swap failed after the database was migrated — maintenance stays UP. Fix forward, or restore the backup named in $STAGE_MARKER"

  log "4/4  Wait for health, then lift maintenance"
  local tries=90
  until [[ "$(health_of api)" == "healthy" && "$(health_of web)" == "healthy" ]]; do
    tries=$((tries-1))
    [[ $tries -gt 0 ]] || die "api=$(health_of api) web=$(health_of web) — not healthy, maintenance stays UP"
    sleep 2
  done
  # api_worker has no healthcheck; make sure it is at least running.
  [[ "$(health_of api_worker)" =~ ^(running|healthy)$ ]] \
    || die "api_worker is $(health_of api_worker) — maintenance stays UP"
  trap - ERR
  rm -f "$MAINTENANCE_FLAG_FILE"
  rm -f "$STAGE_MARKER"

  # Restored from safe_update.sh: without this, every deploy leaves a full set
  # of superseded images behind. That is what caused the 2026-05-28 disk-full
  # outage, and the operator path had silently dropped the fix.
  log "Post-swap disk hygiene"
  docker image prune -f 2>&1 | tail -1 || echo "  (image prune skipped)"
  docker builder prune -f --keep-storage 10GB 2>&1 | tail -1 \
    || docker builder prune -f 2>&1 | tail -1 \
    || echo "  (builder prune skipped)"
  df -h / | tail -1 || true

  log "Swapped"
  # update_runner powers the Admin Center. It cannot recreate itself from
  # inside a job, but from here (an operator shell) it is a plain recreate.
  if [[ "$(built_image_id update_runner)" != "$(running_image_id update_runner | sed 's/^sha256://')" ]]; then
    info "update_runner image changed — recreating so the Admin Center matches this release"
    docker compose up -d --force-recreate update_runner
  fi
  cmd_status
}

case "${1:-}" in
  stage)  cmd_stage ;;
  swap)   cmd_swap ;;
  status) cmd_status ;;
  *) echo "Usage: $0 {stage|swap|status}" >&2; exit 2 ;;
esac
