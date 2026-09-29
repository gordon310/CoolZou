#!/bin/sh
set -eu

server_ip=${1:-}
case "$server_ip" in
  ''|*[!0-9.]*) echo "Usage: $0 <server-ipv4>" >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tls_dir="$script_dir/tls"
mkdir -p "$tls_dir"
umask 077

openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout "$tls_dir/server.key" \
  -out "$tls_dir/server.crt" \
  -subj "/CN=$server_ip" \
  -addext "subjectAltName=IP:$server_ip" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

base64 < "$tls_dir/server.crt" | tr -d '\n' > "$tls_dir/server-ca.b64"
chmod 600 "$tls_dir/server.key"
echo "TLS certificate created in $tls_dir"
echo "Copy server-ca.b64 into CloudBase variable UPSTREAM_CA_B64."

