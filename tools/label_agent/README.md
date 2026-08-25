# SMPL Label Agent

A small local service that turns a barcode scan into a printed label and a
counted line of stock — in under five seconds, on the bench, whether or not
the network is up.

It runs on the machine the hardware is plugged into:

- **Brother PT-P710BT** over USB (raw raster, no driver, no CUPS)
- an **HID barcode scanner**, which behaves as a keyboard and types into the
  browser page the agent serves

There is no framework. The HTTP server, the database and the SMPL client are
all Python standard library; the only third-party code is pyusb and Pillow,
and both are reached through the two sibling modules (`brother_raster.py`,
`label_render.py`). If either is missing the agent still boots, still scans,
still counts — you just cannot print. That is deliberate: **the SQLite file is
the product, the printer is an accessory.**

The same process is meant to move onto a Raspberry Pi later as a LAN print
bridge. Nothing in it is macOS-specific — see *Running it on a Pi* below.

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
./run.sh --no-printer     # no hardware attached: prints are simulated
AGENT_PORT=9000 ./run.sh  # different port
NO_BROWSER=1 ./run.sh     # headless box
```

Default URL: <http://127.0.0.1:8765/>

Optional environment, for the catalog lookup:

```sh
export SMPL_API_URL=https://smpl.example.de
export SMPL_API_TOKEN=<a token for a user with werkstatt access>
```

Both are optional. **With neither set the agent is fully usable** — it just
cannot name an article it has never seen before.

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

**No authentication.** The agent binds `127.0.0.1` by default and trusts
whoever can reach it. Do not expose it to an untrusted network.

**`--no-printer`** simulates the print step (real render, real timing, no
tape) so the station page and the counting flow can be exercised without
hardware.

---

## Running it on a Pi

```sh
sudo apt install libusb-1.0-0
./run.sh --host 0.0.0.0
```

`--host 0.0.0.0` makes it a LAN print bridge for other machines. On Linux the
USB device needs a udev rule so the service user may open it without root:

```
# /etc/udev/rules.d/99-brother-ptouch.rules
SUBSYSTEM=="usb", ATTR{idVendor}=="04f9", ATTR{idProduct}=="20af", MODE="0660", GROUP="lp"
```

Nothing else changes — same process, same database, same endpoints.
