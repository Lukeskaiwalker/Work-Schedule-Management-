#!/usr/bin/env bash
#
# Install the DuckDNS updater on this machine.
#
# WHY IT LIVES HERE. DuckDNS records the source IP of whoever calls it, so the
# updater has to run on the network the name should point at. It used to run on
# the Synology at the house, which was right while the server was there and is
# exactly wrong once the server moves: the NAS would keep publishing the house's
# address for a machine that is no longer behind it.
#
# Putting it on the server itself also fixes the coupling. The record exists to
# reach this host; if this host is down, a stale record costs nothing, because
# there is nothing at the other end either way.
#
# The token is read interactively and written to a root-only file. It is never
# passed as an argument (arguments are visible in `ps`), never echoed, and
# never written to the log.
#
# Run once, as root:   sudo ./scripts/setup_duckdns.sh

set -euo pipefail

ENV_FILE=/etc/smpl-duckdns.env
BIN=/usr/local/bin/smpl-duckdns-update
UNIT=/etc/systemd/system/smpl-duckdns.service
TIMER=/etc/systemd/system/smpl-duckdns.timer

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

read -rp "DuckDNS subdomain (without .duckdns.org) [smpl-office]: " DOMAIN
DOMAIN=${DOMAIN:-smpl-office}

# -s so it is not echoed to the terminal or captured by anything watching.
read -rsp "DuckDNS token (input hidden): " TOKEN
echo

if [[ -z ${TOKEN} ]]; then
  echo "No token given — nothing installed." >&2
  exit 1
fi

umask 077
cat > "${ENV_FILE}" <<EOF
# DuckDNS credentials for ${DOMAIN}.duckdns.org
# Written by scripts/setup_duckdns.sh. Root-only on purpose.
DUCKDNS_DOMAIN=${DOMAIN}
DUCKDNS_TOKEN=${TOKEN}
EOF
chmod 600 "${ENV_FILE}"
chown root:root "${ENV_FILE}"
unset TOKEN

cat > "${BIN}" <<'EOF'
#!/usr/bin/env bash
# Publish this machine's public IP to DuckDNS. Installed by setup_duckdns.sh.
set -euo pipefail
# shellcheck disable=SC1091
source /etc/smpl-duckdns.env

# `ip=` deliberately left empty: DuckDNS then uses the source address of this
# request, which is this site's public IP as the internet actually sees it.
# Sending a locally-detected address would publish whatever the router handed
# out, which behind NAT is a private address and useless.
response=$(curl -fsS --max-time 20 \
  "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=" \
  || echo "REQUEST_FAILED")

# DuckDNS answers a bare "OK" or "KO". The token is not in the response, and
# must not be in the log either — only the verdict is recorded.
case "${response}" in
  OK) echo "duckdns: ${DUCKDNS_DOMAIN}.duckdns.org updated" ;;
  KO) echo "duckdns: REJECTED — wrong domain or token" >&2; exit 1 ;;
  *)  echo "duckdns: request failed (no answer from duckdns.org)" >&2; exit 1 ;;
esac
EOF
chmod 755 "${BIN}"

cat > "${UNIT}" <<EOF
[Unit]
Description=Publish this machine's public IP to DuckDNS
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${BIN}
EOF

cat > "${TIMER}" <<EOF
[Unit]
Description=Refresh the DuckDNS record every 5 minutes

[Timer]
# Soon after boot, because a machine that has just been plugged in somewhere
# new is exactly when the record is most likely to be wrong.
OnBootSec=45s
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now smpl-duckdns.timer >/dev/null

echo
echo "Installed. Running once now to check the token…"
if systemctl start smpl-duckdns.service; then
  journalctl -u smpl-duckdns.service -n 3 --no-pager -o cat
  echo
  echo "Timer: $(systemctl is-enabled smpl-duckdns.timer), $(systemctl is-active smpl-duckdns.timer)"
  echo "Next:  $(systemctl list-timers smpl-duckdns.timer --no-pager | awk 'NR==2 {print $1, $2, $3}')"
else
  echo "The update failed — see: journalctl -u smpl-duckdns.service -n 20" >&2
  exit 1
fi

echo
echo "REMEMBER: turn off the DuckDNS task on the Synology, or the two will"
echo "fight and the domain will flap between the house and the office."
