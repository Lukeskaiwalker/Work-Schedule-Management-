# Handoff Changelog Snapshot

## Latest Completed Areas
- Hardened auth/bootstrap lifecycle to reduce default-admin exposure risk.
- Extended project/workflow UX across overview, tasks, weekly planning, files, chat, and construction reports.
- Added/imported richer project master data and normalized Excel import behavior.
- Added encrypted backup + restore scripts and restore smoke integrity checks.
- Added WebDAV project file access and default project folder structure handling.
- Added wiki module and local wiki folder ingestion for browser preview.
- Added project activity tracking and finance update surface.
- Added weather integration with backend caching/throttling and ZIP fallback geocoding path.

## Operationally Important Fixes
- Unicode filename download/preview stability fixes.
- Time tracking edge-case fixes (overnight/day-boundary handling).
- Chat unread/read-state and attachment flow improvements.
- Compose reliability improvements (health checks, restart policy, startup ordering).

## Current Risk/Watch Items
- External provider dependency for weather data (geocoding quality depends on source address format).
- WebDAV client behavior can differ by OS client version; verify on target devices.
- Keep bootstrap/admin env flags aligned with deployment policy to avoid lockouts.

## Recommended First Actions In New Workspace
1. Re-run `./scripts/test.sh`.
2. Re-open `docs/STATE.md` and continue from the latest compact update section.
3. Validate weather on known project samples and confirm address format/import quality.
4. If deploying, run restore smoke once before production cutover.
