#!/bin/sh
set -eu

host=coolzou-prod
remote_dir=/home/ubuntu/coolzou
archive=${1:-/Users/gordonmac/GordonDev/CoolZou/artifacts/coolzou-server-20260917-photo-limits.zip}

if [ ! -f "$archive" ]; then
  echo "部署包不存在: $archive" >&2
  exit 1
fi

remote_archive=/home/ubuntu/coolzou-server-deploy.zip
scp "$archive" "$host:$remote_archive"
ssh "$host" "set -eu
unzip -oq '$remote_archive' -d '$remote_dir'
sudo docker compose -f '$remote_dir/deploy/compose.yaml' up -d --build
sudo sh '$remote_dir/deploy/install-watchdog.sh'
sudo docker compose -f '$remote_dir/deploy/compose.yaml' ps
curl -k --fail --silent --show-error https://127.0.0.1:8443/health
echo
sudo systemctl is-active --quiet coolzou-watchdog
echo 'server deployment: PASS'
"
