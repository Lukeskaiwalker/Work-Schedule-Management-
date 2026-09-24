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

Where two monitors are attached it also **shows two pages at once** — the
storage racks on one screen, the construction boxes on the other, full screen
from boot, driven by the barcode scanner and a card of command barcodes beside
it. Two decisions are made at the screen rather than scanned: who an Ausgabe
goes out to, and whether an arriving pallet is a Wareneingang. That part is
optional and has its own section: [The two screens](#the-two-screens).

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
| Scanner | USB HID barcode scanner — this one is `1a86:5456` | It behaves as a keyboard, and there is no driver. There *is* configuration: the agent finds it by USB id and decodes its scancodes with a German table. See [The scanner types German](#the-scanner-types-german-and-the-agent-knows-it). |
| **Card reader** | **USB SD/microSD reader** | **Required.** The Pi's own card slot holds the OS — the instrument card cannot go there. |
| Network | Ethernet preferred | Wi-Fi works. The station is designed to survive losing either. |
| Screens | Two HDMI monitors, optional | One faces the racks, one faces the boxes. See [The two screens](#the-two-screens). Without them the station is headless and everything else still works. |

A powered USB hub is worth having if the printer, the scanner and the reader
are all plugged in at once. The printer draws hardest while feeding tape,
which is exactly when you least want a brownout.

---

## Install, start to finish

### 1. Write the OS

Use Raspberry Pi Imager, and which image depends on whether this station gets
the two workshop screens:

- **headless station → Raspberry Pi OS (64-bit) Lite.** No desktop, because
  there is no monitor and the desktop's own automounter competes with ours.
- **station with the two screens → Raspberry Pi OS (64-bit) with desktop.**
  The kiosk is two Chromium windows started by a *desktop session*: it needs
  labwc, `~/.config/autostart` and a logged-in `pi`, none of which exist on
  Lite. `--with-kiosk` on a Lite box installs files that nothing ever runs.
  On a desktop image udisks2 automounts cards and our rule stands aside —
  see [The card reader](#the-card-reader).

In Imager's settings gear, before writing, set:

- hostname: `smpl-station`
- enable SSH, with your public key
- username: your own, not `pi` — but see the note under `--with-kiosk` below
  if this station gets the two screens, because the kiosk installs into a
  desktop user's home and defaults to `pi`
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

On a station with the two workshop screens, add `--with-kiosk`:

```sh
sudo ~/smpl/tools/label_agent/packaging/install-pi.sh \
     --smpl-url https://smpl.example.de --with-kiosk
```

It is off by default because this installer also provisions headless boxes,
where Chromium is 300 MB of nothing useful. It is additive: forgetting the
flag on a later re-run does not remove a kiosk that is already there. Take
one away deliberately with `--purge-kiosk`.

The kiosk installs into a **desktop user's** home — the autostart entry, the
kanshi pin and the two Chromium profiles all live there — and that user
defaults to `pi`. If the account that logs into the desktop is called
something else, say so, or the installer stops with *„no such user"*:

```sh
sudo ~/smpl/tools/label_agent/packaging/install-pi.sh \
     --smpl-url https://smpl.example.de --with-kiosk --kiosk-user <name>
```

It is idempotent — run it again after any `git pull` and it updates the code,
the virtualenv, the udev rules and the service without touching the database,
the token or any staged imports.

What it does, so you can do it by hand if you ever need to:

| Step | Result |
|---|---|
| `apt install` | `python3`, `python3-venv`, `python3-dev`, `libusb-1.0-0`, `udisks2`, `rsync` |
| creates user | `smpl-station`, a system user with no login, in group `lp` |
| copies code | `/opt/smpl-station/` |
| builds venv | `/opt/smpl-station/tools/label_agent/.venv` with pyusb + Pillow |
| state dir | `/var/lib/smpl-station/`, mode 0700, owned by the service user |
| config | `/etc/smpl-station/agent.env` |
| udev | `99-brother-ptouch.rules`, `99-smpl-sd-automount.rules`, `/usr/local/sbin/smpl-sd-mount.sh` |
| systemd | `smpl-station.service`, enabled and started |

And with `--with-kiosk`, additionally:

| Step | Result |
|---|---|
| `apt install` | `chromium`, `wlr-randr`, `x11-xserver-utils` — only what is missing |
| kiosk script | `/usr/local/bin/smpl-kiosk.sh` |
| autostart | `~<kiosk user>/.config/autostart/smpl-kiosk.desktop`, owned by that user — `pi` unless `--kiosk-user` says otherwise |
| screen layout | `~<kiosk user>/.config/kanshi/config` (only if yours is empty or ours) |
| config | `/etc/smpl-station/kiosk.env`, written once and never again |
| drop-ins | `smpl-station.service.d/10-nowplaying.conf`, `20-scanner.conf` |

### 5. Pair the station with SMPL

This is the step that replaces typing a password into a machine with no
keyboard. Both ways below produce the same token.

**From the terminal you are already in** — the way that always works:

```sh
sudo -u smpl-station AGENT_STATE_DIR=/var/lib/smpl-station \
  /opt/smpl-station/tools/label_agent/.venv/bin/python \
  /opt/smpl-station/tools/label_agent/server.py --pair
```

It prints a short code and waits. Open SMPL in a browser where you are
already logged in as an admin, approve the code, and the terminal says
`Paired.`

**From a browser on the Pi** — open `http://127.0.0.1:8765/setup` and press
*Anmeldung starten*. Same code, same approval.

> **Not from a phone any more, and this will catch you.** `/setup` is still
> reachable across the office LAN, and it still renders: the station's name,
> whether it is paired, the staged imports. But *starting* a pairing is a
> `POST /pair/start`, and that route — with `/pair/cancel` and `/pair/forget`
> beside it — now refuses anything that is not this machine. From a phone the
> page loads, the button answers `403 this route is local-only`, and nothing
> is wrong with the network. Pair from the terminal above, from a browser on
> the Pi's own desktop, or tunnel loopback to your laptop for one minute:
>
> ```sh
> ssh -L 8765:127.0.0.1:8765 <you>@smpl-station.local
> # then open http://127.0.0.1:8765/setup on the laptop
> ```
>
> The reason is `/pair/forget`, which deletes the station's credential from
> disk. It is in the same set as the other two because a pairing route
> reachable from the far side of the workshop is a way for anybody on the LAN
> to unpair the station. See [Which routes leave the
> box](#which-routes-leave-the-box).

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

Plug it in. It is an HID keyboard, and there is no driver to install.

Configure the scanner itself (with the barcodes in its own manual) to:

- send a **carriage return** after each code — this is what commits a scan
- use no prefix
- not require a trigger hold

Its *layout* is the one setting that is not obvious and not optional; it has
its own subsection below.

On this station it appears as `/dev/input/event4`, named `NT USB Keyboard`:

```sh
ls -l /dev/input/by-id/          # usb-NT_USB_Keyboard-event-kbd -> ../event4
```

#### The grab, and what it costs you

With two screens and no keyboard at either of them, "types into whatever has
focus" stops being good enough: there is no correct answer to *which* window
should receive a scan, and the wrong one is a page that quietly swallows it.
So the agent opens the scanner's evdev node directly and **grabs** it
(`EVIOCGRAB`), which takes the device away from the rest of the system and
routes every scan through the station itself.

That grab is the point, and it is also the thing that will confuse you:

> **While the station is running and holding the grab, the scanner cannot
> type anywhere else on the Pi.** Not into a terminal, not into the desktop,
> not into the Chromium windows. It is not broken; it belongs to the agent.
> `sudo systemctl stop smpl-station` gives it back.

Reading the node needs group `input`, which the service user does not have by
default. `install-pi.sh --with-kiosk` drops in
`/etc/systemd/system/smpl-station.service.d/20-scanner.conf` with
`SupplementaryGroups=input`; the device nodes themselves are already
`root:input 0660` from the stock `/etc/udev/rules.d/99-com.rules`, so there
is no new udev rule anywhere in this repository. Check it landed with:

```sh
id -nG smpl-station              # must include: lp input
```

The `input` group grants read access to *every* input device, not only the
scanner — the keyboard and mouse included. There is no narrower group on
Bookworm, and narrowing it would mean editing a stock OS udev file to give
the scanner a group of its own. For an appliance in a locked workshop with
one service account, that trade was not judged worth making. If this Pi ever
grows a second service, revisit it.

#### The scanner types German, and the agent knows it

This is the least obvious thing in the whole station, so it is written out in
full rather than left in a comment.

An HID scanner does not send characters. It sends **scancodes**, exactly as a
keyboard does, and what a scancode *means* is decided by whichever keyboard
layout the receiver applies. The agent grabs the evdev node (above), so there
is no receiver: X11, Wayland and the desktop's own XKB map are all on the far
side of the grab and never see a scan. The agent therefore has to pick a
layout itself, and picking the wrong one does not fail — it silently returns
the wrong code.

**What was measured.** The scanner on this Pi is USB `1a86:5456`,
`NT USB Keyboard`, a 2D imager: it reads both a machine's DataMatrix and an
SMPL Code label. Being an imager is also why the command codes on the crate
screen are QR codes: it reads a QR symbol off the glass in one frame at any
angle, where the Code 128 they used to be had to be swept level across a
reflecting screen above eye height, and missed. Two real scans, captured
read-only from `/dev/input/event4` on 2026-09-10 and decoded with a US
keycode table:

```
label reads M-0062       keycodes 50 53 11 11 7 3                     → "M/0062"
label reads SMPL-RPJN7H  keycodes 31 50 25 38 53 19 25 36 49 8 35     → "SMPL/RPJN7H"
both terminated by ENTER (keycode 28); 1-2 ms between keycodes
```

Both labels carry a **hyphen** where the US table produced a slash. So
keycode 53 is a hyphen here, and this scanner emits **German** scancodes.
What that implies for the rest of the alphabet comes from the Pi's own XKB
data — `/usr/share/X11/xkb/symbols/de` against `.../us`:

| evdev code | XKB key | German | US / GB | how we know |
|---|---|---|---|---|
| 53 | `<AB10>` | `-` | `/` | **measured**, twice, off the device |
| 21 | `<AD06>` | `z` | `y` | inferred from the layout files |
| 44 | `<AB01>` | `y` | `z` | inferred from the layout files |

That last column is not pedantry, and it is why the safety net below exists:
neither captured scan contains a Y or a Z, so the letter half of the German
table is a conclusion drawn from `de` being `de`, not a thing anybody watched
happen.

**Why the letters matter more than the hyphen.** `CODE_ALPHABET` in
`apps/api/app/services/werkstatt_internal_codes.py` is
`0123456789ABCDEFGHJKLMNPQRSTUVWXYZ` — it contains **both Y and Z**, and 14 of
the 55 coded articles in production carry one of them. Decode with a US table
and those two letters swap, so roughly a quarter of every article scan
resolves to the wrong article or to nothing at all — with the label, the
scanner and the network all provably fine. That is the failure this
subsection exists to prevent.

So: **the agent decodes with a German table.** Not the Pi's configured layout,
not `setxkbmap`, not the desktop's — none of those are reachable from behind
an `EVIOCGRAB`, and the station is meant to work with no desktop at all.

The terminator is **Enter** (keycode 28) — the carriage return the scanner's
own manual calls a suffix. Keypad Enter and Tab commit a scan too, because a
wedge can be configured to send either.

**The Y/Z safety net.** Because that half is inferred — and because a layout
is a fact about a device somebody can replace — the inference is checked
rather than trusted. A code that comes back **unknown** and that contains a Y
or a Z is looked up once more with those two letters swapped. If the swapped
spelling resolves, *that* is the code that gets booked and shown, so the
operator sees the article on the label rather than the one the keycode table
guessed.

Three conditions keep it cheap and honest. It fires only on a miss, only for
a code containing one of the two letters, and only when SMPL actually
answered — during an outage every lookup is a miss, and doubling the timeout
on the one path that must stay under five seconds would buy nothing. So it
costs one extra lookup on codes that were going to fail anyway.

When it does hit, it says so, once per start — repeat it per scan and it
becomes a message nobody reads:

```
scanner layout: 'SMPL-RPJY7H' was unknown but 'SMPL-RPJZ7H' resolved — Y and Z
are swapped, so the scanner is no longer sending de scancodes. Check
--scanner-layout / SCANNER_LAYOUT (logged once per start).
```

That line is the whole point of the net. It is a diagnosis, not a fix: a
scanner that trips it on every second article should have its layout setting
corrected, not be left leaning on a retry.

**Switching the table** is a setting, not a code change. `input_reader.py`
carries two tables — `de` (the default, what the office scanner sends) and
`us` — and the agent picks one:

```sh
# /etc/smpl-station/agent.env
SCANNER_LAYOUT=us
# then: sudo systemctl restart smpl-station
```

`agent.env` is the unit's `EnvironmentFile`, so that is all it takes;
`--scanner-layout us` does the same thing when you are running the agent by
hand. On the command line the only two accepted spellings are `de` and `us`
and anything else is an argparse error, but a typo *in the env file* is not:
it falls back to `de` rather than refusing to start, because a misspelled
setting must never be the reason a workshop has no scanner. Read back the one
it actually settled on rather than the one you typed — the startup banner
prints it, and so does `/health`:

```sh
sudo journalctl -u smpl-station -b | grep 'scanner :'
curl -s localhost:8765/health | python3 -m json.tool | grep -A8 '"scanner"'
```

Each table covers only what a code of ours can contain — digits, A–Z, `-`,
`.`, `/`, space, and the numeric keypad, which means its own digits on every
layout and so is shared. Everything else a German keyboard puts on those keys
(ß, ü, ö, ä, ^, #, ´) is deliberately absent: an unmapped key is **dropped,
never guessed**. One hole is worth knowing about because it looks like an
omission and is not — the *shifted* digit row is not decoded at all. Shift+7
on a German layout is `/`, and no code we mint contains one, while a wedge
that holds shift across a whole numeric barcode is a real thing and would
turn an EAN's `7` into `/`. A scanner that genuinely must send a slash has
the keypad slash (evdev 98), which is in both tables.

The other way round is equally valid: configure the scanner itself to send US
scancodes, with the barcodes in its own manual, and leave the agent on `us`.
That has the merit that the station and any laptop the scanner is ever
plugged into agree. What you must not do is both — write down which one this
station uses, because the two changes cancel out and the second person to
"fix" it re-breaks it.

#### The command-barcode card

A laminated card of barcodes lives next to the scanner. It is how you drive
the station with no keyboard: the scanner is the input device that is always
in somebody's hand, so the verbs have to be scannable too. Two things are
deliberately *not* on the card and are chosen at the screen instead — who an
Ausgabe goes to, and the Wareneingang direction. Both are below.

| Barcode | What it does |
|---|---|
| `SMPL-CMD-FERTIG` | Closes the open crate. Commits nothing — every line was written to SMPL as it was scanned. |
| `SMPL-CMD-ABBRUCH` | Undoes the **last** booking on this screen, by writing its opposite to SMPL. Once only. A Wareneingang cannot be undone. |
| `SMPL-CMD-MENGE-5` | the next scanned article counts as 5, not 1 |
| `SMPL-CMD-MENGE-10` | …as 10 |
| `SMPL-CMD-MENGE-50` | …as 50 |
| `SMPL-CMD-AUS` | Regal: book **Ausgabe** — stock leaves with the person tapped on the screen |
| `SMPL-CMD-EIN` | Regal: book **Rückgabe** — a borrowed item comes back |
| `SMPL-CMD-ENTNAHME` | Kiste: switch between packing in and taking back out. Stock is never touched. |
| `SMPL-CMD-MITNEHMEN` | Kiste: the open crate is taken to the customer — SMPL books the checkout for every line. Refuses with *Erst die Kiste scannen* when no crate is open, and SMPL refuses unless the crate is **gepackt**. The crate screen carries this one on the glass too, next to the *Mitnehmen* button, which posts exactly the same thing. |

**Wareneingang is not on the card.** A delivery is booked by tapping
*Wareneingang* on the rack screen — see [The rack screen books three
directions](#the-rack-screen-books-three-directions). It has no barcode on
purpose: it is the one direction where a mis-scan is expensive, so it costs a
deliberate tap.

Four things worth knowing before somebody reports a bug:

- A quantity command applies to **the next article only** and then falls back
  to 1. It is a modifier, not a mode — nobody has ever wanted to leave a
  station silently multiplying by 50.
- `AUS` and `EIN` set the rack's **direction**, and it stays set until it is
  changed. `FERTIG` does not reset it and closing a crate does not reset it.
  The direction is on the rack screen in words, in large type, because a
  direction you cannot see is a direction you will get wrong.
- `ENTNAHME` sets the crate's **mode**, and that one *does* reset: opening a
  crate, switching to another crate, `FERTIG`, and the ten-minute idle timeout
  all put it back to packing in. A crate therefore always starts in the
  harmless direction. Scanned at the rack `ENTNAHME` books nothing and its
  message lands on the crate screen — the same mirroring `FERTIG` does.
- A command shares the `SMPL-` prefix with an article code and can still never
  be mistaken for one, and the reason is narrower than the prefix: an internal
  article code is `SMPL-` followed by **exactly six** characters from
  `0123456789ABCDEFGHJKLMNPQRSTUVWXYZ` — an alphabet with no hyphen in it (and
  no I and no O, which read back as 1 and 0 off a 4 pt label). Every command
  has a second hyphen, so it fails that test on the hyphen alone. Do not print
  anything else with the `SMPL-CMD-` prefix.

`FERTIG` only ever speaks to the crate screen: scanned at the rack it closes
nothing and simply reports *„Kiste geschlossen"* on the other monitor.

If the card is lost, any Code-128 generator reproduces it: the payload is the
literal text in the left column, nothing encoded, nothing prefixed. Print it
big enough to scan from arm's length and laminate it — this card lives on a
workbench.

##### What `ABBRUCH` really does

It is not "throw the list away" — there is no list. Every scan is written to
SMPL before the next one is read, so taking one back means **writing a
compensating request**:

| What this screen did last | What `ABBRUCH` writes |
|---|---|
| staged an article SMPL refused | nothing at all — the staged article is dropped |
| added a line to a crate | removes that line again (`POST …/boxes/<id>/items/remove`) |
| took a line out of a crate | adds it back (`POST …/boxes/<id>/items`) |
| booked a stock movement | the opposite movement (`POST …/movements`) — an Ausgabe is compensated with a Rückgabe **onto the same name**, so the loan it created is the loan it clears. A Rückgabe is compensated with an Ausgabe, and that one has a rule of its own — see below. |

Three things it cannot take back:

- **A Wareneingang.** An intake has no honest opposite: "it left again" is a
  claim about where the goods went, and a wall screen does not know. The
  screen says *„Ein Wareneingang lässt sich nicht per Abbruch zurücknehmen.
  Bitte in SMPL korrigieren."* and writes nothing.
- **Anything older than the last booking.** The station remembers exactly one
  booking per screen and forgets it in the act of undoing it. A second
  `ABBRUCH` answers *„Nichts zum Rückgängigmachen"*.
- **A booking made at the other screen.** The rack and the crate keep separate
  memories. An `ABBRUCH` scanned while a crate is open takes back the crate
  line, never the last rack movement — and the other way round. The crate undo
  also remembers *which* crate the line went into, so switching crates and
  then scanning `ABBRUCH` cannot quietly take a part out of the wrong job.

Because the undo is itself a booking, it can fail like any other: if SMPL is
unreachable the screen says *„Abbruch fehlgeschlagen"* and the original
booking still stands. A failed undo **keeps its record**, so scanning
`ABBRUCH` again once the network is back still works — one blip must not cost
the operator the ability to undo at all, and the blip is precisely why the
screen looks wrong. Only an undo SMPL accepted is forgotten. Either way both
rows stay in the ledger: SMPL has no "delete a movement" and should not grow
one — a ledger you can delete from is not a ledger.

##### Undoing a Rückgabe needs a name

`ABBRUCH` on a Rückgabe writes an **Ausgabe**, and an Ausgabe names somebody.
That rule has no exception, and least of all one reachable by scanning two
barcodes — a nameless checkout let in through the undo is exactly the tool
nobody can find. But a Rückgabe is allowed to carry no name, so the booking
being taken back frequently has none to hand back.

When it does carry one — somebody tapped a name on the way in — that is the
name the Ausgabe goes back onto, and nothing is asked. When it does not, the
undo uses the name **tapped on the screen right now**:

- a name is tapped → the Ausgabe is booked onto that person. Whoever is
  standing at the rack undoing a return is the person the tool is going back
  out with, which is the honest answer as well as the convenient one, and
  tapping is still a deliberate human act rather than a guess;
- nobody is tapped → the undo is **refused**, in the same words as a scanned
  Ausgabe (*„Bitte zuerst Namen antippen"*), and nothing is written. Tap a
  name and scan `ABBRUCH` again — the record is still there, because a
  refused undo is not a spent one.

It is deliberately not a flat refusal. The booking being undone can never grow
a name it did not have, so refusing outright would make *every* later
`ABBRUCH` on that Rückgabe fail too, and the row it should have taken back
would stand forever.

Undoing an **Ausgabe** never asks: it writes a Rückgabe, and a Rückgabe is
allowed to be anonymous — though this one is not, because it goes back onto
the name the original checkout carried.

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

## The two screens

The station has two monitors on the Pi's two HDMI outputs, each showing one
page of the station's own web UI, full screen, from boot, with no browser
chrome. Almost everything is driven by the scanner. What is left to press is
mostly on the rack screen — the direction and the names, listed under [The
rack screen books three
directions](#the-rack-screen-books-three-directions) — while the crate screen
keeps its own two: the pack-in/take-out mode and closing a crate. Each button
belongs to exactly one screen, and `/screen/action` says so:

| Screen | Page | Faces |
|---|---|---|
| `HDMI-A-1` — Philips TV, 1360x768 | `http://127.0.0.1:8765/regal` | the storage racks |
| `HDMI-A-2` — Samsung U28E590, 3840x2160 @ 30 Hz | `http://127.0.0.1:8765/kisten` | the construction boxes |

Both URLs are `127.0.0.1`, and they have to stay that way: the screens keep
working with the office network unplugged, and every route they use — the
reads as much as the writes — refuses anything that is not this machine. See
[Which routes leave the box](#which-routes-leave-the-box).

### The box screen is worked with the scanner alone

There is one mouse and one keyboard on this station and both are at the rack
screen. Nothing is plugged in at the box screen: it is a monitor on a wall
above the crates, and everything it is ever told arrives through the scanner
in somebody's hand.

Two consequences, both of which look like faults if you do not know:

**The buttons on the crate page cannot be pressed from where it hangs.** The
two actions that belong to that screen — the pack-in/take-out mode and closing
a crate — are on the page as QR codes as well, drawn by the station itself and
big enough to scan off the glass at arm's length, next to the quantity
commands. Same codes as [the laminated card](#the-command-barcode-card) and
the same handler behind them; the card is the copy that travels, the screen is
the copy that is always there. Those symbols are served from `/qr.svg` on the
station itself (`/barcode.svg`, the Code 128 they used to be, stays for
printed sheets — the imager reads a QR code off the glass at any angle, the
bars it had to sweep level), and both routes are refused to every caller that
is not this machine — a command code reachable from the office network is a
command code somebody can print at their desk.

**The mouse pointer does not stay on the rack screen by itself**, which is
what the pointer guard is for.

#### The pointer guard

Both monitors are one X desktop — a single coordinate space, 5200x2160 today —
so a mouse pushed a hand's width too far to the right leaves the rack screen,
lands on the box screen and stays there, an arrow parked on a page with
nothing at it to pick it up again. `smpl-kiosk.sh` runs a small loop that
walks it back: it reads the pointer a few times a second and, when it is
outside the rectangle of `KIOSK_REGAL_OUTPUT`, warps it to the nearest point
just inside that rectangle.

Only the axis that went too far moves. Push the mouse hard to the right and
the pointer stops at the right-hand edge, at the height you left it, the way
it stops at the edge of a single screen. Pulling it to the middle instead
would be a fight with the hand that is still moving the mouse.

Measured on the station with the guard running, racks on the Philips at 0,0:

| pointer put at | where it is a moment later |
|---|---|
| `3000 400` | `1359 400` — back to the edge, same height |
| `1400 700` | `1359 700` — one pixel across the border is still across |
| `5199 2159` | `1359 767` — the far corner of the box screen, so both axes |
| `500 300` | `500 300` — already on the rack screen, left alone |

Two knobs, both in `/etc/smpl-station/kiosk.env`:

| Variable | Default | What it decides |
|---|---|---|
| `KIOSK_POINTER_GUARD` | `on` | `on` or `off` — whether the pointer is fenced at all |
| `KIOSK_POINTER_INTERVAL` | `0.4` | seconds between checks |

Set `KIOSK_POINTER_GUARD=off` and log back in if somebody needs a mouse on the
box screen, or while debugging that screen from a chair. Plugging a second
mouse in at the box screen is not a way round it: X has one pointer for the
whole desktop and the guard applies to that one.

The guard follows `KIOSK_REGAL_OUTPUT`, so [swapping the two
screens](#swapping-which-screen-shows-which-page) takes the mouse with it —
there is no second line to remember. The rectangle is re-read on every pass
rather than once at startup, for the same reason the window placer re-reads
it: a TV switched off and on comes back, and not always in the same position.
A guard holding a stale rectangle does not fail quietly, it drags the pointer
somewhere nobody asked for twice a second. While that output is missing
altogether the guard does nothing at all.

One trap for anybody working on that loop. The pointer lives in **unscaled**
desktop coordinates and no window's `--force-device-scale-factor` touches it.
Window coordinates are the opposite: everything handed to Chromium or to
`xdotool windowmove` is divided by that window's scale, which is what
`logical()` in the script is for. Measured with the Samsung at scale 2 —
`xdotool mousemove 2000 1500` reads back as `x:2000 y:1500`, while that same
window sits physically at x=1360 and is reported by `wmctrl` at 2720. Reusing
`logical()` here would fence the pointer into a quarter of the wrong
rectangle.

### The rack screen books three directions

| On screen | What it means | Movement written in SMPL |
|---|---|---|
| **Ausgabe** | something leaves the rack with somebody | `checkout` |
| **Rückgabe** | a borrowed item comes back | `return` |
| **Wareneingang** | a delivery arrives — this is new stock | `intake` |

`SMPL-CMD-AUS` and `SMPL-CMD-EIN` pick the first two from the command card;
Wareneingang is picked by tapping it on the screen.

**One word per direction, everywhere.** Those three nouns are the whole
vocabulary: on the screen, in a flash message, in this document. A direction
that is called two things is a direction somebody will get wrong reading a
log next to a wall, so nothing here is ever softened into a synonym —
*Entnahme* in particular is **not** a word for the rack. It names the crate's
take-back-out mode (`SMPL-CMD-ENTNAHME`) and nothing else; a rack booking that
takes stock out is an **Ausgabe**. If you find "Entnahme" on the rack screen
or in a rack message, that is the bug, not a wording preference.

The third one is the one to get right. Booking a delivery as an Ausgabe does
not merely point the arithmetic the wrong way: it takes the count *down* by
what has just arrived, and it hangs the delivery on a person, who then stands
in SMPL as holding twenty metres of cable they have never touched. Nobody
notices until somebody goes looking for stock the ledger says is out with a
colleague. Check the word on the screen before the first scan of a pallet.

SMPL catches only the loud half of that mistake: it refuses a checkout larger
than the stock it believes is on the shelf, so booking a pallet of something
rare as an Ausgabe fails with an error somebody reads. A delivery of something
already well stocked passes straight through and is wrong in silence. The
guard is a backstop, not the rule.

#### A Wareneingang for something SMPL has never stocked

This used to be a dead end: the screen said *„SMPL kennt diesen Code nicht"*
and the delivery had to wait for somebody at a PC. Now the rack finishes the
job, and the order of operations is the point.

1. The agent **asks before it writes** — `GET /station/werkstatt/lookup`, a
   read. SMPL tries its own articles, then the wholesaler catalogue, then the
   public Unielektro webshop. The screen shows *„Suche im Webshop…"*, the one
   flash level that does not clear itself.
2. Found: the article is created from that data and the intake is booked in
   one transaction. The flash names where the identity came from —
   *„Artikel angelegt (Unielektro), Wareneingang 3"*.
3. Nobody knows the code: the screen asks for **Bezeichnung** and **Einheit**
   and creates the consumable from that. This is why the rack has a keyboard
   and the crate screen does not — the crate screen keeps its old message.

The write carries a `request_id` the Pi mints once per prompt. A web search
can take longer than the screen is willing to wait, and the obvious retry
would otherwise book the same pallet twice; with the token SMPL replays its
first answer instead. That is also why step 1 is a read: a lookup that times
out has changed nothing.

#### Tap your name first

Before anything goes out, the worker taps their name. The list of names comes
from SMPL over the station's own token (`GET /api/station/werkstatt/crew`) and
is cached, so the screen keeps working while the switch reboots; when SMPL has
never answered, the list is empty and nobody can be selected.

A tap is checked against that cached list, and an id outside it is refused
with a `400` rather than accepted — the buttons were built from the list, so
an id that is not on it did not come from a finger. Accepting one published a
name-less chip on the wall and booked a tool out to somebody the station
could not name.

- **An Ausgabe needs a name.** With nobody tapped, the scan is refused with
  *„Bitte zuerst Namen antippen"* and **nothing is written** — not the
  movement, not a half of it. That refusal is the whole point of the rule: the
  ledger has to be able to answer "who has the drill".
- **A Rückgabe may carry one** — the person whose loan it clears — but does
  not require one. A tool coming back is a tool coming back.
- **A Wareneingang never carries one.** A delivery belongs to the shelf.

**The rule is one rule, at every door.** There are three ways an Ausgabe can
reach the ledger from this box, and all three ask the same question through
the same function (`movement_needs_assignee()` in `scan_router.py`):

| Door | What happens with nobody tapped |
|---|---|
| a scanned article, direction *Ausgabe* | refused before anything is consumed — the quantity survives, tap a name and scan again |
| `POST /rack/movement`, which the screen's own buttons use | `400` with the same sentence, and the screen flashes *„Ausgabe nur mit Namen — nichts gebucht."* |
| the Ausgabe an `ABBRUCH` re-creates when it takes back a Rückgabe | refused, in those same words — see [Undoing a Rückgabe needs a name](#undoing-a-rückgabe-needs-a-name) |

That third door is the one that was open: the undo used to post a checkout
with no assignee, which walked past the rule by the back way and left a tool
out with nobody on it. A rule with two copies is a rule with two behaviours,
so there is now one copy.

The selected name **clears itself after 120 seconds** of nothing happening, so
the next person to walk up cannot book onto the last person's name — the rack
screen says *„Name zurückgesetzt / Bitte vor der Ausgabe wieder antippen."*
when it goes. Every accepted scan pushes those 120 seconds out again, so the
clock measures idleness, not the length of a job. While a name is set it is on
the screen in large type, for the same reason the direction is.

Tapping a name is an action of the **rack** screen and only the rack screen,
and so is setting the direction; the crate screen owns the mode and closing a
crate. `/screen/action` checks that the screen a tap claims to come from is
the one that owns the action, and answers `400` otherwise. (Dismissing a
message and setting the quantity genuinely belong to both screens, so those
two are not checked.) It used to take the screen name and ignore it, which
let the crate screen set the rack's direction or tap a name onto an Ausgabe
nobody at the rack had asked for.

### Verteiler-Kommissionierung am Regal

Every Schrank-Etikett carries the panel number (`VT-0007`) as a DataMatrix,
bottom-left. Scanning it at the rack opens a **panel session**: the rack
screen swaps the article card for that panel's material list, and every
article scanned from then on is booked as consumption *for that Verteiler*
until the session is closed. It is the rack's answer to "which parts of this
cabinet have already been taken off the shelf".

The flow, scanner only:

1. **Scan the `VT-` code.** The agent recognises the prefix itself (SMPL's
   `/resolve` answers `not_found` for it, like a crate code) and fetches
   `GET /api/station/werkstatt/panels/{code}`. Any spelling works — `VT-7`,
   `vt0007` — and is normalised to `VT-0007`. An unknown number is refused
   with *„Verteiler unbekannt"* and nothing stays open.
2. **Scan parts.** Each one is `POST …/panels/{id}/scan` with the pending
   quantity (`SMPL-CMD-MENGE-n` still applies), and the flash reads
   *„3 / 8 · WAGO 2003-7641"* — scanned over planned for the line the part
   landed on, which the list highlights. A part the panel does not plan for
   is booked anyway and shown as *„nicht geplant"*; more than planned shows
   *„zu viel"*. A scan that takes more than the shelf holds is booked too —
   the person is holding the part — and flashes the server's
   *„Bestand war 0 — Inventur prüfen."* as a warning. Something SMPL does not
   stock at all is refused: *„Nicht gebucht"* plus the server's sentence, and
   the list stays as it was.
3. **`SMPL-CMD-ABBRUCH`** takes back the last booking of this session
   (`POST …/panels/{id}/undo` with that booking's article and quantity);
   **`SMPL-CMD-FERTIG`** closes the session. The screen offers both as
   buttons — **Rückgängig** (`/screen/action` `undo_panel`) and **Fertig**
   (`close_panel`) — and both are actions of the rack screen only.

What the session changes on the rack:

- **The direction and the name do not matter** and are shown dimmed. A part
  going into a panel is neither an Ausgabe to a person nor a Rückgabe; it is
  written as `consumption` (total and available both go down), taken back as
  `consumption_undo`, both carrying the panel and its project. Neither kind
  is accepted through `POST /station/werkstatt/movements` — the two panel
  routes are the only station writers of them.
- **A machine is refused**, as in a crate session, and the panel stays open.
- **A panel session and a crate session never coexist.** Scanning a `VT-`
  code closes an open crate (the crate screen says so); scanning a `KISTE-`
  code closes an open panel. A rescan of the same number keeps the session
  and resets its clock; a different number switches. An `ABBRUCH` only ever
  takes back a part picked for the panel that is open — never a rack
  movement from before the session, never a part picked for another panel.
- **It closes itself** after the same 600 s of nothing as a crate —
  *„Verteiler automatisch geschlossen"* — and the card shows a countdown for
  the last 90 s, as the crate screen does.

`/screen/state?screen=regal` carries the session as `panel` (null when none
is open): the panel's id, number, designation, name, customer, project, the
material lines with `scanned / planned` and a status per line (`open`,
`done`, `over`, `unplanned`), the totals, `last_line_key` for the line the
last scan landed on, `opened_at` / `expires_at`, and `error` when the list
could not be re-read.

### How it starts

`~/.config/autostart/smpl-kiosk.desktop` (owned by `pi`) runs
`/usr/local/bin/smpl-kiosk.sh` when the desktop session comes up. That script:

1. waits for `http://127.0.0.1:8765/health` to answer `200`, so nobody ever
   sees *"site cannot be reached"* on a wall screen;
2. asks `wlr-randr` where each named output currently is;
3. launches one Chromium per screen, positioned on it;
4. restarts either window, independently and forever, if it dies.

It is an autostart `.desktop` file rather than a systemd unit on purpose: it
needs the desktop session's `WAYLAND_DISPLAY` and `DISPLAY`, and it should
die with that session. It is *not* `~/.config/labwc/autostart`, which would
risk replacing the system autostart that starts `pcmanfm --desktop`,
`wf-panel-pi` and `kanshi` — a failure nobody would connect to "I added a
kiosk" when the taskbar disappeared a week later.

### Swapping which screen shows which page

Two lines in `/etc/smpl-station/kiosk.env`:

```sh
KIOSK_REGAL_OUTPUT=HDMI-A-2
KIOSK_KISTEN_OUTPUT=HDMI-A-1
```

(and swap `KIOSK_REGAL_SCALE` / `KIOSK_KISTEN_SCALE` with them, since the
scale belongs to the panel, not to the page). Log out and back in, or reboot.

**That is the whole procedure.** It is not a code change, there is nothing to
rebuild, nothing to redeploy, and nothing in the repository knows or cares
which way round the office is. If somebody ever tells you the screens are
swapped and the fix is a pull request, they are looking at the wrong file.

Check the mapping before rebooting — this launches nothing:

```sh
sudo -u pi SMPL_KIOSK_DRYRUN=1 /usr/local/bin/smpl-kiosk.sh
```

It prints the exact `argv` each window would get, which output each resolved
to, and the geometry it read. It is also the fastest way to debug a screen
showing the wrong page while you are standing in front of it.

### Every knob

All of them live in `/etc/smpl-station/kiosk.env`; the installed
`kiosk.env.example` beside it documents each one at length.

| Variable | Default | What it decides |
|---|---|---|
| `KIOSK_REGAL_OUTPUT` | `HDMI-A-1` | which connector shows `/regal` |
| `KIOSK_KISTEN_OUTPUT` | `HDMI-A-2` | which connector shows `/kisten` |
| `KIOSK_REGAL_URL` | `http://127.0.0.1:8765/regal` | the racks page |
| `KIOSK_KISTEN_URL` | `http://127.0.0.1:8765/kisten` | the boxes page |
| `KIOSK_REGAL_SCALE` | `1` | Chromium device scale factor on that screen |
| `KIOSK_KISTEN_SCALE` | `2` | ditto — 4K at scale 1 is unreadable across a workshop |
| `KIOSK_BACKEND` | `x11` | `x11` or `wayland` (see below) |
| `KIOSK_FULLSCREEN` | `window` | `window` or `kiosk` — see [Swapping which screen shows which page](#swapping-which-screen-shows-which-page) |
| `KIOSK_HEALTH_URL` | `http://127.0.0.1:8765/health` | what must answer 200 first |
| `KIOSK_HEALTH_TIMEOUT` | `180` | seconds to wait for it before opening anyway |
| `KIOSK_OUTPUT_TIMEOUT` | `60` | seconds to wait for a screen to appear |
| `KIOSK_RESPAWN_DELAY` | `3` | seconds before a dead window is restarted |
| `KIOSK_POINTER_GUARD` | `on` | keep the mouse pointer on the rack screen |
| `KIOSK_POINTER_INTERVAL` | `0.4` | seconds between pointer checks |
| `KIOSK_CHROMIUM` | *(auto)* | browser path, if not the first one on `PATH` |
| `KIOSK_PROFILE_ROOT` | `~/.local/share/smpl-kiosk` | where the two profiles live |

### Why X11 on a Wayland compositor

The compositor here is labwc on Wayland, and the default backend is
nevertheless `--ozone-platform=x11`. That is deliberate: XWayland presents
labwc's two outputs as **one** root window spanning both of them (5200x2160
today), so `--window-position` addresses an absolute desktop coordinate and
the window lands where it was told. Native Wayland has no mechanism for a
client to choose its output at all — placement has to come from a compositor
rule instead.

`KIOSK_BACKEND=wayland` exists and launches each window with a distinct
`app_id` (`smpl-kiosk-regal`, `smpl-kiosk-kisten`), but it places nothing on
its own: it needs labwc window rules in `~/.config/labwc/rc.xml`, roughly

```xml
<windowRule identifier="smpl-kiosk-regal">
  <action name="MoveToOutput" output="HDMI-A-1"/>
</windowRule>
```

The script prints the rules it expects and does **not** write `rc.xml`. This
path is documented, not delivered — it has never run on this station.

Two traps in this area, both of which have cost time already:

- **Under XWayland the outputs are not called `HDMI-A-1`/`HDMI-A-2`.**
  `xrandr` calls them `XWAYLAND1` and `XWAYLAND2`, in an order that is not
  the connector order, and `xrandr --listmonitors` rounds the Philips to
  1366 px wide where the actual layout gives it 1360. That is why geometry is
  always read from `wlr-randr` when a Wayland session is present, even though
  Chromium is then driven through X11: `wlr-randr` is the only tool on the
  box that knows the name written in `kiosk.env`.
- **The second Chromium must have its own `--user-data-dir`.** Chromium keeps
  one browser process per profile, guarded by `SingletonLock`. A second
  launch against the same profile does not start a second browser — it hands
  its command line to the first process, that process opens a *tab*, and the
  second launch exits `0`. One window, on one screen, and a script that
  believes it succeeded. Each window therefore gets its own profile
  directory and its own `--class`.

For the same family of reasons the respawn is a plain `while` loop and not
`/usr/bin/lwrespawn`, which the system autostart uses for the panel:
`lwrespawn` deduplicates with `pgrep` on the process *name*, so once one
Chromium is up it refuses to start the second.

### Which monitor is where, pinned

`~/.config/kanshi/config` pins both screens by make and model at fixed
positions. Before this, that file was zero bytes and the arrangement was
whatever wlroots decided on that boot — and it genuinely varied. Two probes
of this Pi weeks apart, with nobody touching a cable:

```
probe 1:  HDMI-A-1 (Philips) at 0,0       HDMI-A-2 (Samsung) at 1360,0
probe 2:  HDMI-A-2 (Samsung) at 0,0       HDMI-A-1 (Philips) at 3840,0
```

The kiosk does not depend on the pin — it re-reads the geometry every start —
but a pinned layout is what makes "the left screen shows the racks" a fact
rather than a coincidence. Installing it will move the desktop back to
Philips-at-origin on the next login, which is a visible one-off change.

Both screens are pinned at compositor scale 1 on purpose. Compositor scaling
would change the pixel geometry the kiosk reads back and computes positions
from; the 4K screen is made legible with Chromium's own device scale factor
(`KIOSK_KISTEN_SCALE=2`) instead, which leaves the window geometry alone.

### When a screen is wrong

| Symptom | Check | Fix |
|---|---|---|
| Both pages on one screen | `sudo -u pi SMPL_KIOSK_DRYRUN=1 /usr/local/bin/smpl-kiosk.sh` | if it prints two identical `user_data_dir` values, the profiles collided; if only one window is listed, the other output was not found |
| Nothing on either screen | `systemctl is-active smpl-station`; `curl -s localhost:8765/health` | the kiosk waits for `/health` — a station that never starts means screens that never open |
| One screen black, no error | `ls ~/.config/autostart/smpl-kiosk.desktop` | the autostart entry is missing, or was installed root-owned; it must be owned by `pi` |
| The pages are swapped | | two lines in `/etc/smpl-station/kiosk.env` — see above |
| A window is on the wrong screen but fullscreen | | set `KIOSK_FULLSCREEN=window` — placement without `--kiosk` is fully deterministic |
| "output … is not connected" and nothing opened | `wlr-randr` | correct behaviour: a missing screen stops the kiosk rather than stacking both pages on the survivor |
| A window closes and does not come back | the kiosk logs each restart to the session's stderr — look in `~/.xsession-errors` first, then `journalctl -b \| grep smpl-kiosk` | the respawn loop is unconditional, so silence there means the script itself is not running |
| The mouse will not go onto the box screen | | working as intended — see [The pointer guard](#the-pointer-guard). `KIOSK_POINTER_GUARD=off` in `/etc/smpl-station/kiosk.env`, then log out and back in |
| Screens blank after a while | | nothing on this box configures blanking (`consoleblank=0`, no swayidle), and the kiosk runs `xset s off s noblank -dpms` as insurance. If they still blank, something new was installed. |
| The crate list is greyed out and dated | `curl -s localhost:8765/boxes/state` | correct behaviour: the box screen keeps rendering the last list SMPL gave it and marks it stale rather than going blank. `error` in that answer says why the refresh failed, `fetched_at` says how old the rows are. |
| Nobody can be picked on the rack screen | `curl -s localhost:8765/screen/state?screen=regal` | an empty `crew` means SMPL has never answered `/api/station/werkstatt/crew` — usually an unpaired or revoked station. An Ausgabe stays refused until it is fixed. |

To stop the kiosk for an afternoon without root, rename the autostart entry
and log out:

```sh
mv ~/.config/autostart/smpl-kiosk.desktop ~/.config/autostart/smpl-kiosk.desktop.off
```

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

Four separate paths, deliberately independent:

| What | Route | If it breaks |
|---|---|---|
| Article lookups | `GET /api/station/werkstatt/resolve?code=…` on each new code — both the wall screens and the older scan-and-print page | the two differ. The scan-and-print page falls back to the local SQLite cache and then to "unknown code", so counting never waits. The wall screens have **no** cache: an unresolved code is flashed as *„Code nicht zugeordnet"* and nothing is booked, because a rack booking needs an article id and guessing one would move the wrong stock. |
| Verteiler-Kommissionierung | `GET /api/station/werkstatt/panels/{code}` when a `VT-` code is scanned, then `POST …/panels/{id}/scan` per part and `POST …/panels/{id}/undo` for an `ABBRUCH` — see [Verteiler-Kommissionierung am Regal](#verteiler-kommissionierung-am-regal) | an unknown number closes the session at once; a list that cannot be re-read stays on the card marked stale; a part that cannot be booked is flashed *„Nicht gebucht"* and nothing is written |
| Counted stock | manual export: `GET /export/<session>.csv` or `.json` | the SQLite file is the product; copy it off with `scp` |
| Test protocols | `POST /api/station/imports` (multipart) | stays staged locally and is retried |
| Liveness | `POST /api/station/heartbeat` every 2 min — printer state plus the agent's own LAN `host`/`port`, `uptime_seconds`, `session_count` and a `hardware` summary | the admin page shows the station as stale; nothing else changes |

The station authenticates with the paired token, sent as
`Authorization: Bearer …`. It is stored at
`/var/lib/smpl-station/station-token.json`, mode `0600`, in a directory that
is `0700` and owned by the service user. If SMPL answers `401` or `403`,
`/health` reports `identity.token_rejected: true` — the fix is to re-pair.

> **The one endpoint that looks right and is not.**
> `GET /api/werkstatt/scan/resolve` answers the same question and returns the
> same union, and it is the endpoint a browser uses. It is a *user* endpoint:
> in `apps/api/app/routers/workflow_werkstatt_mobile.py` it depends on
> `get_current_user`, i.e. a logged-in person's JWT. A station bearer token
> presented to it is **rejected**, not accepted-with-fewer-rights — which the
> agent swallows into "unknown code", because a lookup that fails must never
> stop a count. So the symptom is a station that resolves nothing at all while
> a phone standing next to it resolves the same barcode perfectly, and nothing
> in the log says "credential". Both of the agent's lookup paths — the kiosk's
> (`smpl_werkstatt.PATHS["resolve"]`) and the scan-and-print page's
> (`Upstream.resolve` in `server.py`) — must therefore point at
> `/api/station/werkstatt/resolve`, the only router on the SMPL side that
> knows what a station token is. If a station ever resolves nothing again,
> check those two before you check the network.

The heartbeat is what fills in `last_seen_at` and the printer status on SMPL's
**Scan-Station** admin page. Without it every station on that page reads
"never seen", including the ones working perfectly.

It is also how that page learns **where to call back**. Every button on it
that touches the Pi — *Testetikett drucken*, *Hardware prüfen*, *Agent neu
starten*, the session list and *Übernehmen* — is SMPL's api calling the
agent's port 8765 across the office LAN, and SMPL cannot read the address off
the request: the office router hairpins NAT, so every station arrives from
the router's address. The agent therefore reports the address of its own
NIC (the interface that routes to SMPL, found with a UDP connect that sends
nothing), and SMPL stores it only if it is a private address. Until an agent
that reports one has beaten at least once, the page says *„Adresse unbekannt
— Agent auf dem Pi aktualisieren"* and every action answers with that same
sentence: **after updating SMPL, re-run `install-pi.sh` on the Pi** (it is
idempotent) so the agent is new enough to report its address. If the Pi
guesses the wrong interface (a VPN, docker0) or sits on another subnet, the
page's *Bearbeiten* form takes a manual `http://<ip>:8765` that wins over the
reported one — private addresses and `*.local` names only.

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

### What a station is allowed to write

The station token is not a login, and the router behind it
(`apps/api/app/routers/workflow_station_werkstatt.py`) is deliberately narrow.
Three of its rules are worth knowing while you are standing at the Pi:

- **Every ledger row says which station wrote it.** A movement booked from a
  screen carries the station's id, and its note begins `Regal-Station <name>`.
  A note sent from the Pi is added *after* that prefix and can never replace
  it — a caller that could erase the marker could make a device's booking read
  like a person's. So "who booked this?" is answerable in SMPL without
  guessing, and answerable months later.
- **A device is not a person.** `werkstatt_movements.user_id` is NOT NULL, so
  the row is booked as the administrator who approved the pairing, or — if
  that account is gone — the lowest-id active admin. Lowest *id*, because it
  is stable: "the newest admin" would move the authorship of the ledger
  between two deploys. If there is no active admin at all the write is
  refused with a `409` and the German sentence *„Die Station … hat keinen
  Besitzer, auf den gebucht werden kann"* — a booking that did not happen
  being the better half of that trade, since a ledger row with a wrong name
  is a lie somebody acts on. Who *has* the item is a separate field, and that
  one is the name that was tapped on the screen. Conflating the two is how a
  tool becomes unfindable, so the API keeps them apart.
- **Three movement types, and no corrections.** Through the movements route
  a station may write `checkout`, `return` and `intake` and nothing else —
  exactly the three directions on the rack screen. Write-offs and repair
  bookkeeping are refused, and so is a stock-take correction: a correction
  is the one movement that is *allowed* to disagree with the counters, which
  means nothing stops it going arbitrarily negative, and a wall screen with
  no keyboard cannot type the reason such a decision needs. Corrections
  belong in SMPL's inventory-session flow, where a named person signs for
  them. The two other kinds a station writes — `consumption` and
  `consumption_undo`, a part picked for a Verteiler and that pick taken back
  — go only through the panel routes, which pin them to a panel and its
  project; the movements route refuses them.

Quantities are bounded twice on the way: the agent's own routes take at most
9999 per scan, and SMPL refuses anything above 10 000.

### Which routes leave the box

On the Pi the agent binds `0.0.0.0` (`AGENT_HOST` in the unit file), so port
8765 is reachable from the office LAN. That is deliberate: the station page,
`/setup` and the older print-and-count API are meant to be usable from a
laptop or a phone. But *reachable* stopped being the same thing as *trusted*
the moment a route could move stock — or hand out a customer list — so the
**whole kiosk** refuses any caller that is not this machine, its reads
included, under every verb. `GET` and `HEAD` are checked exactly as `POST`
is; the guard used to live in `do_POST` alone, which left every read open.

| Route | Reachable from the LAN | Why |
|---|---|---|
| `POST /scan/route`, `/screen/action` | **no — 403** | they drive the wall screens, and a scan books stock |
| `POST /box/session`, `/box/item`, `/box/item/remove` | **no — 403** | they change what is in a crate |
| `POST /rack/movement` | **no — 403** | it writes the ledger |
| `GET /regal`, `/kisten`, `/screen/state`, `/boxes/state` | **no — 403** | not "they only read": the crate list is the customer, the project and every packed item of every open job, and `/screen/state` is a 25-second long poll on a threaded server — one held thread per caller, which is a lever against the two screens as much as it is a leak |
| `GET /now-playing`, `/now-playing/cover.jpg` | **no — 403** | the same kiosk furniture, and it says what is playing in the workshop |
| `GET /barcode.svg` | **no — 403** | it draws the command codes as Code 128, for printed sheets and any screen that wants bars. Reachable, it is a barcode generator anyone on the LAN can point at a printer — and the codes it draws move stock |
| `GET /qr.svg` | **no — 403** | the same command codes as QR symbols, which is what the crate screen embeds now; same generator, same reasoning |
| `POST /pair/start`, `/pair/cancel`, `/pair/forget` | **no — 403** | `/pair/forget` deletes the station credential from disk. A route that unpairs a Pi from the far side of the workshop LAN is not a route, it is a prank |
| `GET /pair/status` | yes | the readable half of pairing: paired or not, and whether a code is outstanding. It writes nothing and holds no thread |
| `GET /health`, `/sessions`, `/session/…`, `/export/…` | yes | monitoring, and copying counts off the box — and what SMPL's Scan-Station page reads for *Hardware prüfen* and the session list |
| `POST /restart` | yes, **with proof** | SMPL's *Agent neu starten* button. SMPL is not this machine, so the route cannot be loopback-only; instead it demands `X-SMPL-Station-Proof: sha256(<station token>)` — the hash SMPL stores, which only this Pi can compute from the token it holds — and answers `403` to anything else, `503` while unpaired. The agent exits half a second after answering and systemd's `Restart=always` brings it back; the kiosk launcher waits on `/health`, so the screens survive. A restart mid-SD-import aborts that upload, which the agent's own queue retries |
| `GET /`, `/setup`, `/preview.png`, `/static/…`, `/imports`, `/imports/<id>` | yes | the two pages somebody opens from a laptop or a phone, and the label preview |
| `POST /resolve`, `/count`, `/print`, `/imports/rescan`, `/imports/retry` | yes | the older scan-and-print path the README documents `--host 0.0.0.0` for |

Both browsers run on the Pi and talk to `127.0.0.1`, so they never meet the
lock. There is exactly one way to trip over it: point `KIOSK_REGAL_URL` or
`KIOSK_KISTEN_URL` at `http://smpl-station.local:8765/…` instead of
`127.0.0.1`. The request then arrives from the Pi's own LAN address, which is
not loopback, and the wall shows `403 this route is local-only` where the page
should be — the page itself is one of the locked routes, so this now fails
loudly at the first load rather than quietly at the first scan. Keep both
kiosk URLs on `127.0.0.1`.

The same split is why `/setup` opened from a phone can *show* you the pairing
state and not start one: the page is LAN-reachable, the button behind it is
not. See [Pair the station with SMPL](#5-pair-the-station-with-smpl).

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
| Wrong characters, e.g. `Z`↔`Y` or `-` read as `/` | Not the Pi's layout — the agent grabs the evdev node, so the desktop's keyboard map never touches a scan. The scanner is sending scancodes the agent's table does not expect. See [The scanner types German](#the-scanner-types-german-and-the-agent-knows-it). |

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
| `could not reach SMPL` | Network or DNS, not a missing feature. `curl -sI $SMPL_API_URL/api/healthz` — that is the API's only health route, and there is no `/api/health` to spell it with. |
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

The whole suite: no hardware, no network, no printing, no screens.

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

### And the kiosk

The kiosk was written against a Pi that was probed read-only. No window has
ever been opened by this script on a real screen, and the tests exercise its
*decisions* with a fake `wlr-randr`, not its effects. These need a person in
the office, roughly in this order:

| Step | Why it needs a human | How you know it worked |
|---|---|---|
| Decide which physical screen faces the racks and which faces the boxes | Nobody remote can see the room. The defaults are a guess. | Both pages are readable from where the work happens |
| `sudo install-pi.sh --with-kiosk`, then reboot | First real run | Two full-screen pages, one per monitor |
| Confirm the mapping, and swap the two lines in `kiosk.env` if it is wrong | The mapping is a fact about furniture | `/regal` on the racks screen |
| Confirm `--kiosk` fullscreens on the intended monitor | Chromium's interaction between `--kiosk` and `--window-position` could not be tested without two real outputs. If a window fullscreens onto the wrong screen, set `KIOSK_FULLSCREEN=window`. | Neither window has moved after a reboot |
| Kill the stale Chromium a probe found running as `pi` | It sits on the *default* profile and holds `~/.config/chromium/SingletonLock`. Harmless to the kiosk, which uses its own profiles, but it is a browser nobody has looked at in a long time. Ask the box how long rather than guessing: `ps -o lstart= -p $(pgrep -u pi -o chromium)`. | `pgrep -u pi chromium` shows only the two kiosk windows |
| Insert an SD card **after** the drop-ins land | `10-nowplaying.conf` sets `PrivateTmp=no`, and the unit's own header warns that its namespace settings are what the card watcher depends on. This loosens rather than tightens, so it should be fine — "should" is why it is on this list. | An import appears in `journalctl -u smpl-station -f` |
| Scan something, then try to scan into a terminal | Confirms the evdev grab is working and demonstrates its cost | The station registers the scan; the terminal stays empty |
| Enable shairport-sync metadata, if the now-playing panel is wanted | `/etc/shairport-sync.conf` has no `metadata` block today, so the pipe at `/tmp/shairport-sync-metadata` exists but nothing is fed through it. Turning it on **restarts the AirPlay receiver**, which cuts off whatever is playing in the workshop at that moment. Pick your moment. | The panel shows a track while something is playing |
| Verify kanshi actually applied the pinned layout | A profile applies only on an exact output-set match; a wrong model string means it silently does nothing | `wlr-randr` shows Philips at `0,0` and Samsung at `1360,0` |

The last one has a specific reason to be checked rather than assumed. Two
probes of this Pi weeks apart found the two outputs at *opposite* ends of the
layout with nobody touching a cable. If the pin is not working, that will
come back.
