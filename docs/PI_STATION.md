# The office station on a Raspberry Pi

A small box in the corner of the office that does three things and keeps doing
them when the network does not:

1. **Scans and counts.** A barcode scanner, a Brother label printer, and a
   local database that mirrors SMPL's inventory columns.
2. **Logs into SMPL without a password.** The station shows a short code; an
   admin approves it in SMPL from their own desk.
3. **Swallows test-instrument SD cards.** A card from a Benning ST 760 or a
   Metrel MI 3152 goes into a reader, and its protocols are copied, hashed and
   queued for SMPL before anyone touches a laptop.

Everything below assumes you are standing in front of the Pi with a keyboard
or an SSH session. It is written to be followed without asking anybody
anything.

The code lives in [`tools/label_agent/`](../tools/label_agent/); its
[README](../tools/label_agent/README.md) explains the scan-and-print path in
detail. This document is the *install and operate* half.

---

## What you need

| Part | What exactly | Notes |
|---|---|---|
| Computer | Raspberry Pi 4 (2 GB) or Pi 5 | A Pi 3 works; it is slower to render a label, not slower to count. |
| OS card | 16 GB+ microSD, A1-rated | This is the Pi's *own* boot card. Not the card you import from. |
| Power | The official USB-C supply | An undersized supply is the cause of most "USB device disappears" reports. |
| Printer | Brother PT-P710BT, USB cable | USB, not Bluetooth. The agent speaks raw raster to `04f9:20af`. |
| Tape | 12 mm TZe | Anything narrower loses the second line. See the README's tape budget. |
| Scanner | Any USB HID barcode scanner | It behaves as a keyboard. No driver, no configuration. |
| **Card reader** | **USB SD/microSD reader** | **Required.** The Pi's own card slot holds the OS — the instrument card cannot go there. |
| Network | Ethernet preferred | Wi-Fi works. The station is designed to survive losing either. |

A powered USB hub is worth having if the printer, the scanner and the reader
are all plugged in at once. The printer draws hardest while feeding tape,
which is exactly when you least want a brownout.

---

## Install, start to finish

### 1. Write the OS

Use Raspberry Pi Imager and choose **Raspberry Pi OS (64-bit) Lite**. No
desktop: the station has no monitor, and the desktop's own automounter
competes with ours.

In Imager's settings gear, before writing, set:

- hostname: `smpl-station`
- enable SSH, with your public key
- username: your own, not `pi`
- locale and Wi-Fi if you need them

### 2. First boot

```sh
ssh <you>@smpl-station.local
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

### 3. Get the code onto the Pi

```sh
git clone <your SMPL remote> ~/smpl
cd ~/smpl
```

If the Pi cannot reach the git remote, copy the tree over with
`rsync -a ~/Documents/SMPL\ all/ smpl-station.local:~/smpl/` from a machine
that can.

### 4. Run the installer

```sh
sudo ~/smpl/tools/label_agent/packaging/install-pi.sh \
     --smpl-url https://smpl.example.de
```

It is idempotent — run it again after any `git pull` and it updates the code,
the virtualenv, the udev rules and the service without touching the database,
the token or any staged imports.

What it does, so you can do it by hand if you ever need to:

| Step | Result |
|---|---|
| `apt install` | `libusb-1.0-0`, `python3-venv`, `udisks2`, `rsync` |
| creates user | `smpl-station`, a system user with no login, in group `lp` |
| copies code | `/opt/smpl-station/` |
| builds venv | `/opt/smpl-station/tools/label_agent/.venv` with pyusb + Pillow |
| state dir | `/var/lib/smpl-station/`, mode 0700, owned by the service user |
| config | `/etc/smpl-station/agent.env` |
| udev | `99-brother-ptouch.rules`, `99-smpl-sd-automount.rules`, `/usr/local/sbin/smpl-sd-mount.sh` |
| systemd | `smpl-station.service`, enabled and started |

### 5. Pair the station with SMPL

This is the step that replaces typing a password into a machine with no
keyboard. Either way works; both produce the same token.

**From the terminal you are already in:**

```sh
sudo -u smpl-station AGENT_STATE_DIR=/var/lib/smpl-station \
  /opt/smpl-station/tools/label_agent/.venv/bin/python \
  /opt/smpl-station/tools/label_agent/server.py --pair
```

It prints a short code and waits. Open SMPL in a browser where you are
already logged in as an admin, approve the code, and the terminal says
`Paired.`

**From a browser** — a phone works — open `http://smpl-station.local:8765/setup`
and press *Anmeldung starten*. Same code, same approval, and it is the page to
send someone who is standing at the station without an SSH session.

Pairing is optional. An unpaired station scans, counts, prints and exports
exactly as it does today; it just cannot look up an article it has never seen,
and cannot push imports to SMPL.

### 6. Check it

```sh
curl -s localhost:8765/health | python3 -m json.tool
```

Then open `http://smpl-station.local:8765/` and scan something.

---

## How the three devices attach

### The scanner

Plug it in. It is an HID keyboard; there is nothing to configure on the Pi.

The scanner types into whatever has focus, which is why the station page
keeps focus in a hidden input at all times and why the *setup* page is a
separate URL — a text field on the scan page would swallow scans.

Configure the scanner itself (with the barcodes in its own manual) to:

- send a **carriage return** after each code — this is what commits a scan
- use no prefix
- not require a trigger hold

### The printer

Plug the PT-P710BT into USB, load 12 mm TZe tape, switch it on.

The agent opens the device directly and holds the handle for the life of the
process; re-enumerating per label costs hundreds of milliseconds. It does not
go through CUPS, which is why `/etc/udev/rules.d/99-brother-ptouch.rules`
exists: without it the device is root-only and the agent cannot open it.

Confirm the Pi sees it:

```sh
lsusb | grep 04f9          # Bus ... ID 04f9:20af Brother Industries, Ltd
ls -l /dev/bus/usb/*/*     # the Brother node should be crw-rw---- root lp
id -nG smpl-station        # must include lp
```

### The card reader

Plug a **USB** card reader in. When a card is inserted, udev runs
`/usr/local/sbin/smpl-sd-mount.sh`, which mounts it **read-only** under
`/media/smpl/<label>-<device>` and the agent notices it within about two
seconds.

Read-only is not a precaution, it is the design: a test protocol is evidence
in a DGUV V3 audit, and nothing on the station — including the station — may
alter what an instrument recorded.

Watch it happen:

```sh
journalctl -u smpl-station -f
```

If you are on a Raspberry Pi OS **desktop** image, udisks2 already automounts
removable media and our rule stands aside (`UDISKS_IGNORE`). Re-run the
installer with `--no-automount` to remove our rule entirely.

---

## What happens to a card

```
   card inserted
        │
        ▼
   udev → smpl-sd-mount.sh → mounted read-only under /media/smpl/…
        │
        ▼
   the agent's watcher notices a new mount (polls every 2 s)
        │
        ▼
   ① walk the card, recognise candidate files          ← bounded, symlink-safe
   ② copy each one BYTE FOR BYTE into staging
   ③ sha256 every copy, write manifest.json
        │                                                ← evidence is now safe
        ▼
   ④ *then* try to parse — structure only, never meaning
        │
        ▼
   ⑤ queue for SMPL; if SMPL cannot take it, it stays staged forever
```

Staged under `/var/lib/smpl-station/imports/<import-id>/`:

| File | What it is |
|---|---|
| `files/…` | the card's files, unchanged, in their original directory structure |
| `manifest.json` | one row per file: path, size, sha256, mtime, recognised format, confidence |
| `parsed.json` | present only when something could be structurally parsed |

**The copy happens before the parse, always.** A parser that mangles a test
protocol is worse than no parser, because a mangled record looks correct and
gets believed. So an instrument nobody has ever seen still produces a
complete, hashed, manifested import — it is simply marked `passthrough`.

### What the station actually recognises

Researched against manufacturer manuals and one verified file inspection. The
confidence column is not decoration: it says what the station is willing to
claim.

| Instrument | On the card | What we do | Confidence |
|---|---|---|---|
| Metrel MI 3152 / 3155 / 3325 | `WORKSPACES/`, `EXPORTS/`, `Root\__MOS__\AT` directories | recognise the card by its directory layout | **high** — named in all three manuals |
| Metrel `.padfx` | a ZIP holding `DataSource.padf` (XML) + `a_picts/` | list the container, extract the XML's structure | **high** — verified by unpacking Metrel's own SDK sample |
| Metrel export files | extension **undocumented** | recognised by ZIP magic and payload member, not by name | medium |
| Benning ST 755/760 | `Test.db` at the card **root** + `Backups/Test_Backup.NNN` | copy and hash; never opened | **high** — the layout is stated in the PC-Win manual |
| Benning ST 750 | `.sdf` at the root | copy and hash; never opened | high |
| Benning PC-Win export | `.xml` (the CSV people have is an Excel re-save of it) | parse structure; header row sniffed, never positional | medium |
| Benning IT 130 / IT 200 | `.padfx` | same as Metrel — the IT line *is* rebadged Metrel | high |
| anything else | anything | copy, hash, manifest, mark `passthrough` | — |

### What the station deliberately does **not** do

These are decisions, not omissions:

- **No Metrel measurement is decoded.** A `.padfx` contains `MID`, `<P Id=>`,
  `<L Id=>`, `<R Id=>` and `<S>` — opaque integers with no published
  dictionary. The only open-source mapping in existence covers 7 of the 31
  codes present in Metrel's own sample file. Guessing the rest would produce
  confident, wrong test records.
- **No Benning column is renamed.** Benning's export column set and order
  differ between the ST 750, ST 755 and ST 760. The header row is read every
  time; nothing is ever taken by position.
- **No number is converted.** `0,52` stays the string `0,52`, and `35 kOhm`
  stays `35 kOhm`. Deciding that comma is a decimal separator is a claim about
  a locale we were not told.
- **No `.db` or `.sdf` is opened.** Whether Benning's `.db` is SQLite is
  *unconfirmed* — a plausible hypothesis with no authoritative source behind
  it. The file is copied and its magic bytes reported.
- **There is no cross-vendor interchange format** for DGUV V3 protocols in
  Germany. Every integration in this space is a per-vendor adapter, and this
  one is honest about being the same.

Mapping a vendor field to a SMPL field is a decision for SMPL and a human with
the manufacturer's documentation. The station's job is to make sure the bytes
survive intact until that decision is made.

---

## How data reaches SMPL

Three separate paths, deliberately independent:

| What | Route | If it breaks |
|---|---|---|
| Article lookups | `GET /api/werkstatt/scan/resolve` on each new code | falls back to the local SQLite cache, then to "unknown code". Counting never waits. |
| Counted stock | manual export: `GET /export/<session>.csv` or `.json` | the SQLite file is the product; copy it off with `scp` |
| Test protocols | `POST /api/station/imports` (multipart) | stays staged locally and is retried |
| Liveness | `POST /api/station/heartbeat` every 2 min | the admin page shows the station as stale; nothing else changes |

The station authenticates with the paired token, sent as
`Authorization: Bearer …`. It is stored at
`/var/lib/smpl-station/station-token.json`, mode `0600`, in a directory that
is `0700` and owned by the service user. If SMPL answers `401` or `403`,
`/health` reports `identity.token_rejected: true` — the fix is to re-pair.

The heartbeat is what fills in `last_seen_at` and the printer status on SMPL's
**Scan-Station** admin page. Without it every station on that page reads
"never seen", including the ones working perfectly.

**The SMPL side was built in parallel with this station**, so every endpoint is
treated as possibly absent: the agent tries several plausible paths, and when
none answer it records `unavailable` and carries on. That is a normal state,
not a fault — an import marked `unavailable` is complete and safe on disk, and
only its delivery is pending.

As of writing, SMPL's `/api/station/…` router does exist and the two halves
have been tested against each other: `pair/start`, `pair/poll`, `heartbeat`
and `imports` all round-trip. The agent's tests include a
`TestRealSmplContract` case built from SMPL's own schema file, so a later
change on either side that breaks the handshake fails a test rather than a
station.

---

## When something breaks

Start here, always:

```sh
systemctl status smpl-station
journalctl -u smpl-station -n 50 --no-pager
curl -s localhost:8765/health | python3 -m json.tool
```

`/health` is designed to answer instantly even while a label is feeding, so a
slow answer is itself information.

### The printer

| Symptom | Cause | Fix |
|---|---|---|
| `permission denied` in `error` | udev rule missing or not applied | `sudo udevadm control --reload-rules && sudo udevadm trigger`, then unplug/replug the printer |
| `printer not found on USB` | cable, power, or Bluetooth-only mode | `lsusb \| grep 04f9`. If absent it is hardware, not software. |
| `attached but busy` | CUPS or `usblp` holds it | `lsof /dev/usb/lp*`; `sudo cupsdisable <queue>`. The agent does not need CUPS. |
| `libusb backend not available` | native library missing | `sudo apt install libusb-1.0-0` |
| Prints but blank/garbled | wrong tape width | `/health` reports `media_width_mm`; the station is built for 12 mm |
| `id -nG smpl-station` lacks `lp` | user not in group | `sudo usermod -aG lp smpl-station && sudo systemctl restart smpl-station` |

Counting is unaffected by every row in that table. That is the point of the
design: the operator cannot stop counting to go find a cable.

### The scanner

| Symptom | Fix |
|---|---|
| Nothing happens on scan | Click the page once — the hidden input needs focus. Check `chipScan` on the station page. |
| Codes arrive concatenated | The scanner is not sending a carriage return. Fix in the scanner's own manual. |
| Wrong characters, e.g. `Z`↔`Y` | The scanner is set to a US layout and the Pi to German, or the reverse. Set the scanner to match. |

### The card reader

| Symptom | Check | Fix |
|---|---|---|
| Card inserted, nothing imports | `lsblk` — does the partition appear? | If not, it is the reader or the card |
| Partition appears, no mount | `ls /media/smpl` | `sudo /usr/local/sbin/smpl-sd-mount.sh /dev/sdb1` by hand and read the error |
| Want to see the decision | | `SMPL_SD_MOUNT_DRYRUN=1 ID_FS_LABEL=BENNING ID_FS_TYPE=vfat /usr/local/sbin/smpl-sd-mount.sh /dev/sdb1` |
| Mounted but no import | `curl -s localhost:8765/health` → `sd_import` | `curl -X POST localhost:8765/imports/rescan` |
| Import says `duplicate` | that card's content was already imported | correct behaviour — nothing was lost |
| Import says `empty` | no recognised files | check `skipped` in the response; the card may genuinely be blank |
| Everything says `unavailable` | SMPL has no import endpoint yet | the files are in `/var/lib/smpl-station/imports/` |
| Upload says `over the … upload limit` | the card staged more than 64 MB | deliberate: staging is generous (512 MB) so evidence is never lost, uploading is conservative so a big card cannot wedge the office uplink. Copy that import off by hand. |

An `ext4` card mounts without ownership options and may be unreadable to the
service user. FAT/exFAT — what instruments actually use — get `uid=`/`gid=`
and are fine.

### Pairing

| Symptom | Meaning |
|---|---|
| `no station pairing endpoint yet` | SMPL has not shipped it. Not a fault. Use `SMPL_API_TOKEN` in `/etc/smpl-station/agent.env` in the meantime. |
| `could not reach SMPL` | Network or DNS, not a missing feature. `curl -sI $SMPL_API_URL/api/health` |
| `denied` | An admin refused the code. Ask them why. |
| `expired` | Nobody approved in time. Start again. |
| `token_rejected: true` in `/health` | The token was revoked or expired. Re-pair. |
| `token_file_secure: false` | Something loosened the file. `sudo chmod 600 /var/lib/smpl-station/station-token.json` |

### The whole thing

```sh
sudo systemctl restart smpl-station     # first resort
sudo journalctl -u smpl-station -b      # everything since boot
```

The service is `Restart=always` with no start limit, so it comes back from a
crash on its own. If it is flapping, the journal says why on the way down.

---

## Backups

One directory holds everything that cannot be regenerated:

```sh
sudo tar czf smpl-station-$(date +%F).tar.gz -C /var/lib smpl-station
```

That is the counts database, the pairing token and every staged import. The
code is in git; the OS is a reinstall.

The token is a credential — treat that tarball accordingly, and if a station
is decommissioned, revoke its token in SMPL as well as wiping the Pi. Deleting
the local file stops *this* station using it; only SMPL can stop anyone else.

---

## Rehearsing without hardware

The SD-import path runs end to end with no instrument, no reader and no card.
This is how it was developed and how you should test any change:

```sh
cd /opt/smpl-station/tools/label_agent
python3 server.py --make-fixtures /tmp/cards      # sample Benning + Metrel cards
./run.sh --no-printer --sd-simulate /tmp/cards    # every subdirectory = a card
```

Then open `/setup` and watch the imports appear. Adding a directory under
`/tmp/cards` while it runs is exactly equivalent to inserting a card.

The same fixtures back the test suite:

```sh
cd /opt/smpl-station/tools/label_agent
python3 -m unittest discover -s tests
```

128 tests, no hardware, no network, no printing.

---

## What still needs the Pi

Everything above was built and tested on a Mac. These parts could not be, and
are the checklist for the first hour in the office:

| Needs the Pi because | Verify by |
|---|---|
| The udev rule was never loaded by a real udev | `udevadm test $(udevadm info -q path -n /dev/bus/usb/001/00X)` after plugging the printer in |
| `/proc/self/mountinfo` parsing was tested against a captured file, not a live kernel | insert a card, then `curl -s localhost:8765/health \| grep -A3 sd_import` |
| `systemd-mount` does not exist on macOS | insert a card and watch `journalctl -u smpl-station -f` |
| The systemd unit has never been started by systemd | `systemctl status smpl-station` after the installer |
| Mount propagation into the service's namespace is a Linux behaviour | if imports never appear but `/media/smpl` is populated, relax `ProtectSystem=` in the unit and retest |
| libusb on ARM was resolved by path list, not by loading it | `/health` → `printer_connected: true` |
| No label has been printed from Linux | print one label and look at it |
| The pairing handshake was tested against a stub built from SMPL's schema, not against SMPL itself | pair the Pi against the real server once |

Nothing in that list is expected to fail. They are listed because "we tested
it" should mean something specific, and for these eight it would not.
