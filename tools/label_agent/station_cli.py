"""Setting the station up from a terminal, and rehearsing it without one.

Three commands that belong to the station feature rather than to the HTTP
server, kept out of ``server.py`` so that file stays about the scan path:

* ``--pair``           obtain a SMPL identity by showing a code
* ``--make-fixtures``  write sample instrument cards for ``--sd-simulate``
* assembling the :class:`station.Station` at all

``server.py`` reaches this module through its lazy ``module()`` helper, so an
error anywhere in the station feature - here, in ``station.py``, or in
anything either imports - costs the station feature and nothing else. The
agent still boots, still scans, still counts, still prints.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

import station


def build_station(args, db_path: Path, base_url: str, env_token: str,
                  version: str = "", status_provider=None) -> Optional[station.Station]:
    """Assemble the Pi-only services, or return None and say why.

    Deliberately swallows an import failure. The station's job on a bench is
    scan-count-print, and a syntax error in the SD importer must not be able
    to stop that - it should cost the SD importer, and nothing else.
    """
    try:
        return station.Station(
            db_path,
            base_url=base_url,
            env_token=env_token,
            device_name=args.device_name,
            agent_version=version,
            sd_enabled=not args.no_sd,
            sd_simulate=args.sd_simulate or None,
            sd_poll_s=args.sd_poll,
            status_provider=status_provider,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  station : unavailable ({type(exc).__name__}: {exc})")
        return None


def run_pairing_cli(station) -> int:
    """Pair from a terminal: show the code, wait, report.

    The station page does the same thing more comfortably, but a Pi being set
    up over SSH has no browser yet, and "run one command and read the code out
    loud" is the shortest path from a fresh image to a logged-in station.
    """
    if station is None:
        print("station services are unavailable, so there is nothing to pair.")
        return 1

    snapshot = station.pair_start()
    state = snapshot.get("state")
    if state == "unavailable":
        print(f"This SMPL server does not offer station pairing yet:\n  {snapshot.get('error')}")
        print("\nThe agent still runs unauthenticated, or with SMPL_API_TOKEN set.")
        return 2
    if state not in ("waiting", "paired"):
        print(f"Pairing could not start: {snapshot.get('error') or state}")
        return 1

    if state == "waiting":
        # SMPL's web app keeps its view in React state, not in the URL, so
        # there is no link that lands on the right page. Naming the menu item
        # is more useful than a URL that only gets you to the dashboard.
        print()
        print("  Open SMPL in a browser you are already logged into, go to")
        print("  \"Scan-Station\" in the menu (system administrators only),")
        print("  and approve this code:")
        print()
        print(f"      code:  {snapshot.get('user_code')}")
        where = snapshot.get("verification_uri")
        if where:
            print(f"      SMPL:  {where}")
        print()
        print(f"  This station identifies itself as: {snapshot.get('device_name')}")
        print(f"  ({snapshot.get('device_id')})")
        print()
        print("  Waiting for approval - Ctrl-C to give up...", flush=True)

    try:
        while True:
            time.sleep(1.0)
            snapshot = station.pair_status()
            state = snapshot.get("state")
            if state in ("paired", "denied", "expired", "unavailable", "error", "cancelled"):
                break
    except KeyboardInterrupt:
        station.pair_cancel()
        print("\ngave up.")
        return 1

    if state == "paired":
        info = snapshot.get("token_info") or {}
        print(f"\n  Paired. Token stored 0600 at {station.tokens.path}")
        if info.get("label"):
            print(f"  SMPL calls this station: {info['label']}")
        return 0
    print(f"\n  Pairing ended: {state} ({snapshot.get('error') or 'no detail'})")
    return 1


def write_fixtures(target: str, base_dir: Path) -> int:
    """Build sample instrument cards so --sd-simulate has something to find.

    Keeps the office rehearsal honest: the same cards the test suite asserts
    against are the ones you point the agent at, so "it worked on my machine"
    and "it worked on the Pi" mean the same thing.
    """
    sys.path.insert(0, str(Path(base_dir) / "tests"))
    try:
        import fixtures  # noqa: PLC0415 - optional, test-only
    except ImportError as exc:
        print(f"cannot build fixtures: {exc}")
        return 1
    root = Path(target).expanduser()
    cards = fixtures.build_all(root)
    print(f"wrote {len(cards)} sample cards into {root}:")
    for name in sorted(cards):
        print(f"  {name}")
    print(f"\nRehearse the import path with:\n  ./run.sh --no-printer --sd-simulate {root}")
    return 0
