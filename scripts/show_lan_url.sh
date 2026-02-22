#!/usr/bin/env bash
set -euo pipefail

get_lan_ip() {
  local iface
  for iface in en0 en1 en2; do
    if ip="$(ipconfig getifaddr "$iface" 2>/dev/null)"; then
      if [[ -n "${ip}" ]]; then
        echo "$ip"
        return 0
      fi
    fi
  done
  return 1
}

if ! LAN_IP="$(get_lan_ip)"; then
  echo "Could not determine LAN IP automatically." >&2
  exit 1
fi

echo "LAN preview URL: http://${LAN_IP}"
echo "Local secure URL: https://localhost"
