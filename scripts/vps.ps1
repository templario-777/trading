param(
  [ValidateSet("ssh", "deploy", "status", "restart", "logs")]
  [string]$Action = "status",
  [string]$RemoteHost = "161.35.107.114",
  [string]$User = "root",
  [string]$Key = "$HOME\\.ssh\\id_ed25519",
  [string]$Service = "trading-bot-api"
)

$sshOpts = @(
  "-i", $Key,
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3"
)

function Invoke-Remote([string]$cmd) {
  & ssh @sshOpts "$User@$RemoteHost" $cmd
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Action) {
  "ssh" {
    & ssh @sshOpts "$User@$RemoteHost"
    exit $LASTEXITCODE
  }
  "status" {
    Invoke-Remote "systemctl --no-pager is-active trading-bot trading-bot-api; ss -lntp | grep -E ':8787\\s' || true"
  }
  "restart" {
    Invoke-Remote "systemctl restart trading-bot trading-bot-api; systemctl --no-pager is-active trading-bot trading-bot-api"
  }
  "logs" {
    Invoke-Remote "journalctl -u $Service -n 120 --no-pager"
  }
  "deploy" {
    Invoke-Remote "set -euo pipefail; cd /opt/trading_bot; git fetch -q origin main; git reset -q --hard origin/main; npm ci --omit=dev >/dev/null; systemctl restart trading-bot trading-bot-api; echo git=$(git rev-parse --short HEAD)"
  }
}
