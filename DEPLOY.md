# Despliegue en servidor (SSH)

## Requisitos

- Ubuntu/Debian con acceso root
- Node.js 20+ (recomendado 24+)
- Puerto de salida a Internet habilitado (para Telegram y exchanges)

## Subida inicial

Nota (Windows): los comandos de esta guía que usan rutas tipo `/opt/...` y `rsync` se ejecutan en el servidor Linux (Droplet) o desde WSL. En PowerShell local, usa `ssh` para entrar al droplet y `scp`/zip para subir archivos.

1. En el servidor:

```bash
mkdir -p /opt/trading_bot
```

2. Desde tu PC, sube el código (sin datos runtime):

```bash
SERVER_IP=161.35.107.114
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude memoria_aether.json \
  --exclude trading_notes \
  ./ root@$SERVER_IP:/opt/trading_bot/
```

Alternativa (PowerShell en Windows, sin rsync):

```powershell
$SERVER_IP = "161.35.107.114"
cd $HOME\Music\Trading_bot
$items = Get-ChildItem -Force | Where-Object { $_.Name -notin @('node_modules','.env','trading_notes','memoria_aether.json','.git') }
Compress-Archive -Path $items.FullName -DestinationPath trading_bot.zip -Force
scp .\trading_bot.zip "root@${SERVER_IP}:/opt/trading_bot.zip"
ssh root@$SERVER_IP "mkdir -p /opt/trading_bot && apt-get update -y && apt-get install -y unzip && unzip -o /opt/trading_bot.zip -d /opt/trading_bot"
```

## Atajo PowerShell (SSH estable)

En Windows puedes usar el helper:

```powershell
cd $HOME\Music\Trading_bot
.\scripts\vps.ps1 -Action status
.\scripts\vps.ps1 -Action ssh
.\scripts\vps.ps1 -Action deploy
.\scripts\vps.ps1 -Action logs -Service trading-bot-api
```

3. En el servidor:

```bash
cd /opt/trading_bot
mkdir -p trading_notes
npm ci --omit=dev
cp .env.example .env
```

Edita `/opt/trading_bot/.env` y completa como mínimo:

- `TELEGRAM_BOT_TOKEN` o `TOKEN_TELEGRAM`
- `TELEGRAM_ADMIN_CHAT_ID` o `TELEGRAM_NOTIFY_CHAT_ID` (opcional, pero recomendado para notificaciones)
- `DEEPSEEK_API_KEY` o `DEEPSEEK_KEY` (si usas el módulo de IA)
- `TRADING_BOT_API_KEY` (Llave para el panel web, por defecto el panel usa `AETHER_2026`)

4. Verifica que carga:

```bash
cd /opt/trading_bot
npm run -s selftest
node index.js
```

## Servicio systemd (recomendado)

1. Crea el unit file:

```bash
cat >/etc/systemd/system/trading-bot.service <<'EOF'
[Unit]
Description=Trading Bot Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/trading_bot
EnvironmentFile=/opt/trading_bot/.env
ExecStart=/usr/bin/node /opt/trading_bot/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

2. Activa y arranca:

```bash
systemctl daemon-reload
systemctl enable trading-bot
systemctl restart trading-bot
systemctl status trading-bot --no-pager
```

3. Logs:

```bash
journalctl -u trading-bot -f
```

## Actualización

1. Desde tu PC (no pisa `trading_notes` ni `memoria_aether.json`):

```bash
SERVER_IP=161.35.107.114
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude memoria_aether.json \
  --exclude trading_notes \
  ./ root@$SERVER_IP:/opt/trading_bot/
```

2. En el servidor:

```bash
cd /opt/trading_bot
npm ci --omit=dev
systemctl restart trading-bot
```

## API HTTP (opcional)

Si quieres consumir el bot desde una web (por ejemplo en Vercel), puedes levantar `api.js` como un servicio aparte.

1. Completa en `/opt/trading_bot/.env`:

- `TRADING_BOT_API_KEY`
- `TRADING_BOT_API_HOST` (recomendado `127.0.0.1` si usas reverse proxy)
- `TRADING_BOT_API_PORT`

2. Crea el unit file:

```bash
cat >/etc/systemd/system/trading-bot-api.service <<'EOF'
[Unit]
Description=Trading Bot API (privada)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/trading_bot
EnvironmentFile=/opt/trading_bot/.env
ExecStart=/usr/bin/node /opt/trading_bot/api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

3. Activa y arranca:

```bash
systemctl daemon-reload
systemctl enable trading-bot-api
systemctl restart trading-bot-api
systemctl status trading-bot-api --no-pager
```

### Cloudflare Tunnel (recomendado)

Si mantienes `TRADING_BOT_API_HOST=127.0.0.1`, puedes exponer la API con un dominio HTTPS usando Cloudflare Tunnel, sin abrir puertos entrantes.

Ver [CLOUDFLARE.md](CLOUDFLARE.md).
