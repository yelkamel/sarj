#!/usr/bin/env bash
# Sarj — bare Ubuntu 24.04 VPS → running service, via Docker Compose.
# Usage: bash setup-vps.sh   (as root or sudo-capable user)
# CPU-only friendly: pulls the 3B model by default; override with SARJ_MODEL.
set -euo pipefail

SARJ_MODEL="${SARJ_MODEL:-qwen2.5:3b-instruct}"
REPO="${SARJ_REPO:-https://github.com/yelkamel/sarj.git}"

# 1. Docker Engine + compose plugin, and git
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y git

# 2. Retire the pre-Docker install if present (systemd sarj + host Ollama),
#    so two copies of the model don't fight for RAM. Leads move to the volume below.
if systemctl list-unit-files sarj.service >/dev/null 2>&1; then
  systemctl disable --now sarj || true
  rm -f /etc/systemd/system/sarj.service && systemctl daemon-reload
fi
systemctl disable --now ollama 2>/dev/null || true

# 3. App: sarj + ollama (models pulled by the ollama-init service)
git clone "$REPO" /opt/sarj 2>/dev/null || git -C /opt/sarj pull
cd /opt/sarj
echo "SARJ_MODEL=$SARJ_MODEL" > .env
docker compose build

# Carry over leads written by the old systemd service, once. Done in a throwaway
# container BEFORE `up`: the real sarj container waits minutes for the model pull.
if [ -s /opt/sarj/leads.jsonl ]; then
  docker compose run --rm --no-deps -T sarj sh -c 'cat >> /data/leads.jsonl' < /opt/sarj/leads.jsonl
  mv /opt/sarj/leads.jsonl /opt/sarj/leads.jsonl.migrated
fi

docker compose up -d

# 4. Caddy for TLS (auto-HTTPS), on the host, in front of the container.
#    Compose publishes sarj on 127.0.0.1:8787 only. Point the DNS A record here first.
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<CADDY
sarj.youcefelkamel.com {
    reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl restart caddy

echo "done → https://sarj.youcefelkamel.com/health  (first boot pulls the models: a few minutes)"
