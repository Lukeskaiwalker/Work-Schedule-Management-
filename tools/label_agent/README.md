# SMPL Label Agent

A small local service that turns a barcode scan into a printed label and a
counted line of stock — in under five seconds, on the bench, whether or not
the network is up.

It runs on the machine the hardware is plugged into:

- **Brother PT-P710BT** over USB (raw raster, no driver, no CUPS)
- an **HID barcode scanner**, which behaves as a keyboard and types into the
  browser page the agent serves
- on the office Pi, a **USB card reader** for Benning and Metrel test
  instruments - see *The office Pi* below

There is no framework. The HTTP server, the database and the SMPL client are
all Python standard library; the only third-party code is pyusb and Pillow,
and both are reached through the two sibling modules (`brother_raster.py`,
`label_render.py`). If either is missing the agent still boots, still scans,
still counts — you just cannot print. That is deliberate: **the SQLite file is
the product, the printer is an accessory.**

The same process runs on macOS and on Raspberry Pi OS. On the Pi it gains two
things it does not need on a bench: a SMPL identity it can obtain without
anybody typing a password into it, and an importer for test-instrument SD
cards. Both are optional, and neither can stop the agent booting.
[`docs/PI_STATION.md`](../../docs/PI_STATION.md) is the install and operate
guide for that machine.

---

## Starting it

```sh
cd "tools/label_agent"
./run.sh
```

`run.sh` picks an interpreter that already has pyusb and Pillow, builds a
`.venv` only if nothing on the box does, starts the server, waits for
`/health`, prints the URL and opens the station page.

```sh
./run.sh --no-printer          # no hardware attached: prints are simulated
./run.sh --no-sd               # do not watch for test-instrument cards
./run.sh --sd-simulate DIR     # every subdirectory of DIR is an "inserted" card
AGENT_PORT=9000 ./run.sh       # different port
NO_BROWSER=1 ./run.sh          # headless box
```

Default URL: <http://127.0.0.1:8765/>, and <http://127.0.0.1:8765/setup> for
the one-time setup page.

Optional environment, for the catalog lookup:

```sh
export SMPL_API_URL=https://smpl.example.de
export SMPL_API_TOKEN=<a token for a user with werkstatt access>
```

Both are optional. **With neither set the agent is fully usable** — it just
cannot name an article it has never seen before. `SMPL_API_TOKEN` is also
optional once a station is *paired*; see *Logging in to SMPL* below, which is
the better answer because a paired token can be revoked centrally.

Everything the agent owns lives under one directory — the counts database, the
pairing token and any staged imports — so a station has a single thing to back
up and a single thing to wipe:

```sh
export AGENT_STATE_DIR=~/.smpl-label-agent   # the default
```

---

## The five-second path

One scan is four local calls. Measured on a MacBook with the modules warm:

| Step | Endpoint | Typical | Worst case |
|---|---|---|---|
| identify the code | `POST /resolve` | 1 ms cached, 160 ms via SMPL | 1.5 s (upstream timeout, then falls back) |
| count it | `POST /count` | 2 ms | 5 ms |
| render the bitmap | inside `POST /print` | 4 ms | 15 ms |
| feed and print | inside `POST /print` | ~2 s of tape | ~3 s |

`POST /print` returns `ms_render`, `ms_print`, `ms_total`, `budget_ms` and
`within_budget`, so the budget is **measured, not assumed**. If the station
page starts creeping over five seconds, the numbers say which step did it.

Three design choices carry that budget:

1. **The USB handle is opened once** at startup (a background thread warms it
   before the first scan) and held for the life of the process. Re-enumerating
   per label costs hundreds of milliseconds.
2. **Only printing is serialised.** One lock guards the printer, because it
   accepts no commands mid-feed. `/resolve`, `/count`, `/health` and the
   exports never touch that lock, so a label that is physically feeding cannot
   delay the next scan. `/health` will not even wait for it — it answers from
   a 2-second status cache and marks itself `busy` instead of blocking.
3. **The catalog is cached in SQLite.** The first scan of a code may cost a
   network round trip; the second is a local read, forever, offline. A cached
   entry older than an hour is revalidated in a background thread — the
   operator never waits for it.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the station page (`static/station.html`) |
| `GET` | `/health` | `printer_connected`, `media_width_mm`, `error`, `upstream_ok` |
| `POST` | `/resolve` | `{code}` → article name, from SMPL or the local cache |
| `POST` | `/count` | `{session, code, article_name, qty}` → running total for that code |
| `POST` | `/print` | `{code, title, subtitle?}` → renders and prints, returns timing |
| `GET` | `/preview.png?code=..&title=..` | PNG preview of the label (`&subtitle=`, `&tape=`) |
| `GET` | `/session/{name}` | every count in the session, plus totals |
| `GET` | `/export/{name}.json` | the session as JSON, ready for SMPL |
| `GET` | `/export/{name}.csv` | the same as CSV (UTF-8 with BOM, so Excel behaves) |
| `GET` | `/sessions` | every session the database knows about |
| `GET` | `/setup` | the one-time setup page: SMPL login, imports, diagnostics |
| `POST` | `/pair/start` | ask SMPL for a pairing code and start waiting |
| `GET` | `/pair/status` | the code, the countdown, or the resulting token's details |
| `POST` | `/pair/cancel` | stop waiting |
| `POST` | `/pair/forget` | delete the local token (revoke it in SMPL separately) |
| `GET` | `/imports` | every SD-card import, newest first |
| `GET` | `/imports/{id}` | one import, with its full manifest |
| `POST` | `/imports/rescan` | look at every mounted card again |
| `POST` | `/imports/retry` | re-queue everything SMPL has not taken yet |

```sh
curl -s localhost:8765/health
curl -s -X POST localhost:8765/resolve -d '{"code":"4011923456789"}'
curl -s -X POST localhost:8765/count \
     -d '{"session":"inventur-q3","code":"4011923456789","article_name":"Schraube M6x40","qty":1}'
curl -s -X POST localhost:8765/print \
     -d '{"code":"SP-1042","title":"Kabelbinder 200mm","subtitle":"SP-1042"}'
```

A repeat scan of the same code **increments** — `counted_qty` grows by `qty`
and `scan_count` by one. It never inserts a second row. Send a negative `qty`
to correct a miscount.

`/count` is happy without an `article_name`: it reuses the name already stored
for that code, so the second scan of a shelf does not need the lookup at all.

---

## Getting the data into SMPL

The local database is not an ad-hoc format. `counts` mirrors SMPL's own
`werkstatt_inventory_counts` column for column:

```
code  item_name  counted_qty  scan_count  first_counted_at  last_counted_at
```

so an export maps onto the inventory model without a translation step.

```sh
curl -s "localhost:8765/export/inventur-q3.csv" -o inventur-q3.csv
curl -s "localhost:8765/export/inventur-q3.json" -o inventur-q3.json
```

The JSON carries the same rows under `counts`, plus `session`, `started_at`,
`status` and `exported_at`. Import it against a Werkstatt inventory session in
SMPL (`POST /api/werkstatt/inventory/sessions/{id}/scan` per row, or a bulk
import if one exists by then) — `code` resolves through the documented scan
cascade, `counted_qty` is the counted quantity, and `scan_count` is preserved
because SMPL treats it as an audit trail, not a total.

Timestamps are ISO-8601 UTC with a `Z` suffix.

The database lives at `~/.smpl-label-agent/inventory.db` (override with
`--db`). It is a normal SQLite file in WAL mode — back it up by copying it, or
read it directly:

```sh
sqlite3 ~/.smpl-label-agent/inventory.db \
  "SELECT code, item_name, counted_qty FROM counts WHERE session='inventur-q3';"
```

---

## Known constraints

**12 mm tape gives you 70 printable dots. That is the whole budget.**
The head has 128 pins at 180 dpi; on 12 mm tape 29 pins at each edge sit off
the printable area, leaving 70 dots — about 9.9 mm — across the tape. Title,
subtitle and barcode height all come out of those 70 dots. There is no setting
that increases it; wider tape is the only answer.

**The printer always feeds at least 24.5 mm per label.**
Anything shorter is padded, so a very short label wastes tape rather than
saving it. Practically: a two-line label costs the same tape as a one-line
label, so use the second line.

**Printing is one-at-a-time, by physics.** The printer accepts no commands
while feeding. Concurrent `/print` calls queue on a lock; scanning and counting
run past them unaffected.

**Unplugging mid-session is survivable.** A USB failure drops the handle,
`/health` reports `printer_connected: false` with the reason, and the next
print reconnects automatically. Counting is untouched throughout — this is the
case the design is built around, because the operator cannot stop counting to
go find a cable.

**No authentication on the local API.** The agent binds `127.0.0.1` by default
and trusts whoever can reach it. Pairing gives the station an identity *toward
SMPL*; it does not put a lock on port 8765. `--host 0.0.0.0` is therefore a
decision about the network the station sits on, and the agent says so at
startup when you make it. Staged import files are deliberately not served over
HTTP for the same reason — `/imports` returns metadata, and the files stay on
disk.

**`--no-printer`** simulates the print step (real render, real timing, no
tape) so the station page and the counting flow can be exercised without
hardware. `--sd-simulate` does the same for card imports.

---

## Logging in to SMPL

The station has no keyboard and, on the Pi, no screen. Typing a password into
a shared appliance would be both awkward and wrong — a password typed into a
shared appliance now lives on a shared appliance.

So it uses the **OAuth 2.0 Device Authorization Grant** (RFC 8628), the same
pattern a smart TV uses for the same reason:

```sh
python3 server.py --pair          # or open /setup in a browser
```

The station shows a short code. An admin opens SMPL in a browser where they
are already logged in, approves it, and the station's next poll collects a
long-lived token. The token is written to
`~/.smpl-label-agent/station-token.json` with mode `0600`, is sent as
`Authorization: Bearer …` from then on, and can be revoked centrally without
anyone touching the hardware.

**The SMPL side of this was built in parallel**, so `pairing.py` treats every
endpoint as possibly absent: it tries several plausible paths, accepts
several spellings of every field, and when nothing answers it reports
`unavailable` and the agent falls back to `SMPL_API_TOKEN` or to the
unauthenticated local behaviour it has today. A station that has never been
paired counts, prints and exports exactly as before.

---

## Test-instrument SD cards

On the Pi, a card from a Benning ST 760 or a Metrel MI 3152 goes into a USB
reader and its protocols are copied, hashed and queued for SMPL without
anybody opening a laptop.

The order matters and is the whole design:

```
copy byte-for-byte  →  sha256 + manifest  →  *then* try to parse
```

A test protocol is evidence in a DGUV V3 audit. A parser that mangles one is
worse than no parser, because a mangled record looks correct and gets
believed. So the evidence is safe before anything is interpreted, an
unrecognised instrument still produces a complete import, and cards are
mounted **read-only** — the station never writes to one.

What is parsed is *structure*, never *meaning*. Column names, element names
and container entries come through exactly as the instrument wrote them;
`0,52` stays the string `0,52` and `35 kOhm` stays `35 kOhm`. Metrel's `MID` /
`Id` codes and Benning's column vocabulary are **not** mapped to anything,
because no published dictionary for them exists.
[`sd_formats.py`](sd_formats.py) documents what was established, with
confidence levels, and `docs/PI_STATION.md` has the table.

Rehearse the whole path with no hardware at all:

```sh
python3 server.py --make-fixtures /tmp/cards      # sample Benning + Metrel cards
./run.sh --no-printer --sd-simulate /tmp/cards    # each subdirectory = a card
```

---

## Tests

```sh
python3 -m unittest discover -s tests
```

128 tests. No hardware, no network, no printing, no fixed ports — the HTTP
tests bind port 0 and the pairing tests run against a stub SMPL that can be
told to behave like a canonical implementation, like a plausible one with
different field names, like a server that has never heard of pairing, or like
SMPL's actual station router (`TestRealSmplContract`, transcribed from
`apps/api/app/schemas/station.py` so the two halves cannot drift apart
silently).

A good half of them assert a *negative*: that no unit was converted, no column
renamed, no vendor code given a meaning, no symlink followed off a card, no
staged file written outside the staging directory. Those are the tests that
stop a later change from quietly turning a passthrough into a wrong answer.

---

## The office Pi

Full install, wiring, failure modes and backups:
**[`docs/PI_STATION.md`](../../docs/PI_STATION.md)**.

The short version:

```sh
sudo tools/label_agent/packaging/install-pi.sh --smpl-url https://smpl.example.de
```

That installs the udev rules, builds the virtualenv, creates the service user
and starts `smpl-station.service`. Then pair it, and scan something.

Everything in [`packaging/`](packaging/) is readable on its own if you would
rather do it by hand:

| File | What it is for |
|---|---|
| `99-brother-ptouch.rules` | lets the service user open `04f9:20af` without root |
| `99-smpl-sd-automount.rules` | mounts an inserted card on a headless Pi, where nothing else will |
| `smpl-sd-mount.sh` | the mount helper — read-only, and sanitises the card label before it becomes a path |
| `smpl-station.service` | the systemd unit: starts on boot, restarts on failure, logs to the journal |
| `install-pi.sh` | all of the above, idempotently |

On Linux the agent needs the native libusb that pip does not install:

```sh
sudo apt install libusb-1.0-0
```

Bind the LAN with `--host 0.0.0.0` to serve other machines. The agent has no
authentication of its own, so that is a decision about the network it is on,
not a default.
