# Deploying SMPL to production

There are two deploy paths and they are **not** interchangeable.

| | Operator deploy | Admin Center button |
|---|---|---|
| Command | `scripts/staged_deploy.sh` | `scripts/safe_update.sh` (via `update_runner`) |
| Driven by | a person at a terminal | an unattended HTTP job |
| Shape | two phases you control | one shot |
| Use for | **every deploy we do** | in-app updates when nobody is at a terminal |

Use `staged_deploy.sh`. `safe_update.sh` stays wired to the Admin Center and
must keep working, but do not run it by hand.

## The procedure

```bash
ssh -i ~/.ssh/smpl_prod mac@192.168.1.120
cd ~/SMPL-all

./scripts/staged_deploy.sh stage     # backup, pull, build, verify — users see nothing
./scripts/staged_deploy.sh status    # what is built vs what is running
./scripts/staged_deploy.sh swap      # maintenance -> migrate -> swap -> health -> live
```

### Why the split

`docker compose build` does not touch a running container. So everything in
`stage` — the encrypted backup, the `git pull`, the image builds, the release
stamp check — happens while production keeps serving the **old** containers. If
any of it fails, users never noticed and nothing needs undoing.

Only `swap` is user-visible, and it is measured in seconds: maintenance page up,
migrate, recreate containers, wait for health, maintenance page down.

That means **`stage` is safe to run during business hours**. That is the point.

### What `stage` verifies

It reads `APP_RELEASE_VERSION` back out of the image it just built and compares
it against what `update_release_metadata.sh` wrote. A cached build layer that
silently ships the previous release string is caught here, before the swap,
rather than being discovered in production afterwards.

## Before an irreversible migration

Some migrations have a deliberate no-op `downgrade()` because their mapping is
many-to-one — `20260817_0073` (project statuses, 13 → 4) is the example. **The
only rollback is a database restore.** Read the migration's docstring, take the
backup (`stage` does), and write down the data change you expect so you can
check it afterwards:

```sql
select status, count(*) from projects group by status order by count(*) desc;
```

## Rules learned the hard way

- **Never pipe a deploy through `tail` over ssh.** `ssh host 'cmd | tail -60'`
  returns *tail's* exit status, so a hard failure reads as success. Redirect to
  a log on the host and check the exit code.
- **`/tmp` is a 3.9 GB tmpfs** and a backup stages ~13 GB. `backup.sh` defaults
  to `/var/tmp` via `BACKUP_STAGING_ROOT`; do not override it back to `/tmp`.
- **`backup.sh` uses `docker compose up -d --no-recreate`.** This is load-bearing:
  without it, a `backup.sh` called after images were rebuilt recreates `api` on
  the new image, and the api CMD is `alembic upgrade head` — migrating the
  database outside the maintenance window.
- **The version string comes from `git describe --tags`.** Cut and push a tag,
  or production reports `vX.Y.Z-N-gSHA`. `git pull --ff-only` does not fetch tags.
- **`update_runner` cannot recreate itself** from inside a job. `staged_deploy.sh
  swap` recreates it at the end from the operator shell.

## Verifying afterwards

```bash
git describe --tags                                   # repo
grep APP_RELEASE_VERSION apps/api/.release.env        # metadata
docker compose ps                                      # all healthy
docker compose exec -T api alembic current             # migration head
curl -s .../api/openapi.json | jq -r .info.version     # what is actually served
```

Then check row counts (`users`, `projects`, `construction_reports`) against what
you recorded before, and sweep container logs for errors.
