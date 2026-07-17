#!/usr/bin/env bash
# Sarj — bare Ubuntu 24.04 VPS → running service.
# Usage: bash setup-vps.sh   (as root or sudo-capable user)
# CPU-only friendly: pulls the 3B model by default; override with SARJ_MODEL.
set -euo pipefail

SARJ_MODEL="${SARJ_MODEL:-qwen2.5:3b-instruct}"
REPO="${SARJ_REPO:-https://github.com/yelkamel/sarj.git}"

# 1. Node 22 + git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# 2. Ollama + models
curl -fsSL https://ollama.com/install.sh | sh
ollama pull "$SARJ_MODEL"
ollama pull nomic-embed-text

# 3. App
git clone "$REPO" /opt/sarj || (cd /opt/sarj && git pull)
cd /opt/sarj && npm install

# 4. systemd service
cat > /etc/systemd/system/sarj.service <<EOF
[Unit]
Description=Sarj agent harness
After=network.target ollama.service

[Service]
WorkingDirectory=/opt/sarj
Environment=SARJ_MODEL=$SARJ_MODEL
Environment=PORT=8787
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now sarj

# 5. Caddy for TLS (auto-HTTPS). Point sarj.youcefelkamel.com's DNS A record here first.
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<EOF
sarj.youcefelkamel.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl restart caddy

echo "done → https://sarj.youcefelkamel.com/health"
