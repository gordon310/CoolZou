#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run with sudo: sudo sh deploy/install-watchdog.sh' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null
command -v docker >/dev/null
install -d -m 700 /opt/coolzou-watchdog /var/log/coolzou
install -m 600 "$script_dir/watchdog.py" /opt/coolzou-watchdog/watchdog.py
install -m 644 "$script_dir/coolzou-watchdog.service" /etc/systemd/system/coolzou-watchdog.service
systemctl daemon-reload
systemctl enable --now docker
systemctl enable coolzou-watchdog
systemctl restart coolzou-watchdog
systemctl --no-pager status coolzou-watchdog
