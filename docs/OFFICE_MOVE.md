# Moving the production server to the office

Written 2026-08-27, for the physical move of `smpl-prod` from the household
network (192.168.1.0/24) to the office (192.168.2.0/24). The public name
`smpl-office.duckdns.org` does not change; the public IP does.

Read the **What has to happen at the office** section before plugging it in.
Everything else is background.

---

## What changed on the server, and why

At home the server did not terminate TLS. A shared Traefik on another machine
(`192.168.1.127`, container `mac-proxy-1`) held the Let's Encrypt certificate,
and a socat relay on that same box forwarded to `192.168.1.120:8080`:

```
internet -> home router -> .127 Traefik (TLS) -> .127 socat -> .120 Caddy :8080 (plain HTTP)
```

Neither of those two hops exists at the office. So the server now does the
whole job itself:

```
internet -> office router -> .120 Caddy :80/:443 (TLS, Let's Encrypt)
```

Three changes were made:

1. **Caddy terminates TLS.** `apps/web/Caddyfile` gained a site block for the
   public domain. Caddy requests and renews the certificate on its own and
   stores it in the `caddy_data` volume, so restarts and the move itself do
   not re-issue it.
2. **Caddy binds 80 and 443.** `SMPL_CADDY_HTTP_PORT` / `SMPL_CADDY_HTTPS_PORT`
   in the server's `.env` changed from 8080/8443 to 80/443. Those ports were
   only ever non-standard because Traefik owned the real ones.
3. **Containers restart with `always`** rather than `unless-stopped`, so they
   come back even if one was stopped by hand before a power cut.

The network configuration needed **no** change: the machine takes its address
by DHCP on any `en*` interface, so it will pick up a 192.168.2.x address by
itself.

---

## What has to happen at the office

### 1. Power on automatically (do this once, in BIOS)

The server must be set to power on when mains returns, or it will sit dark
after a power cut until somebody presses the button.

> BIOS/UEFI -> Power -> **Restore on AC Power Loss** -> **Power On**
> (may be called "After Power Failure" or "AC Recovery")

This cannot be set from the operating system — it needs a keyboard and a
monitor on the machine itself. Everything else in this document is software.

### 2. Forward ports 80 and 443 to the server

On the UDM Pro: **Settings -> Security -> Port Forwarding**, two rules, both
to the server's LAN address:

| Name | Port | Forward IP | Forward port | Protocol |
|------|------|-----------|--------------|----------|
| SMPL HTTP | 80 | *server* | 80 | TCP |
| SMPL HTTPS | 443 | *server* | 443 | TCP |

**Port 80 is not optional.** Let's Encrypt validates over it. Forwarding only
443 gets you a working port and no certificate.

Give the server a fixed address while you are in there — **Client Devices ->
the server -> Settings -> Fixed IP** — so the forwards keep pointing at it.

### 3. Point DuckDNS at the office

**Settings -> Internet -> (your WAN) -> Dynamic DNS -> Create New**

DuckDNS appears directly in the service list on current UniFi OS. If it does,
use it:

- **Service**: `duckdns`
- **Hostname**: `smpl-office.duckdns.org`
- **Username**: anything non-empty (DuckDNS ignores it)
- **Password**: the DuckDNS token

If the list has no `duckdns` entry, pick `custom` and set:

- **Server**: `www.duckdns.org`
- **Hostname**: `smpl-office`
- **Username**: the token
- **Password**: the token

Check it took effect from any machine:

```bash
dig +short smpl-office.duckdns.org
```

It should return the office's public IP. Until it does, the domain still
points at the house and the certificate cannot be issued.

---

## Order of operations

DNS and ports first, then let the certificate happen.

1. Plug in and power on. Containers start by themselves.
2. **The app is usable immediately on the LAN** at `http://<server-ip>/` — no
   DNS, no certificate, no router configuration needed. Use this to confirm
   the move worked before touching anything else.
3. Set the fixed IP, the two port forwards, and DuckDNS.
4. Wait for `dig` to return the office IP.
5. Within about a minute Caddy gets the certificate and
   `https://smpl-office.duckdns.org` works.

### The public domain will not work over plain HTTP

Do not try to reach `http://smpl-office.duckdns.org` as a fallback. That name
has carried an HSTS header for a year, so browsers refuse plain HTTP for it
and will keep refusing until the header expires. **The LAN address is the
fallback** — HSTS is per-hostname, so `http://192.168.2.x/` is unaffected.

---

## Checks and recovery, at the console

```bash
# Everything up?
cd ~/SMPL-all && docker compose ps

# What address did it get?
ip -4 addr show scope global | grep inet

# Is Caddy holding 80 and 443?
sudo ss -tlnp | grep -E ':80 |:443 '

# Does the app answer locally?
curl -sI http://127.0.0.1/ | head -1        # expect: HTTP/1.1 200 OK

# Why has the certificate not arrived?
docker compose logs --tail=50 web | grep -iE 'acme|certificate|error'
```

**"Certificate could not be obtained"** is almost always one of three things,
in this order of likelihood: port 80 is not forwarded, DuckDNS still points at
the old IP, or the office line has no real public IP (carrier-grade NAT). The
first two are router settings. The third needs an outbound tunnel instead of
port forwarding — that is a different setup, not a misconfiguration.

Nothing here needs a redeploy. If the app itself needs updating, that is the
usual `./scripts/staged_deploy.sh stage` then `swap` — see [DEPLOY.md](DEPLOY.md).

---

## Left behind at the household

Once DuckDNS points at the office, these are dead weight on `192.168.1.127`
and can be stopped whenever convenient:

- `smpl-relay` — the socat forwarder to `192.168.1.120:8080`
- the `smplall` router rules on `mac-proxy-1` (Traefik)

Leaving them running is harmless: they will simply forward to a machine that
is no longer there.

`docker-compose.traefik.yml` stays in the repo. It is the override for running
behind a shared Traefik and is not used by this deployment
(`COMPOSE_FILE=docker-compose.yml`), but it documents that arrangement and
would be needed to go back to it.
