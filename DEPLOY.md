# Despliegue en servidor (SSH)

## Requisitos

- Ubuntu/Debian con acceso root
- Node.js 20+ (recomendado 24+)
- Puerto de salida a Internet habilitado (para Telegram y exchanges)

## Subida inicial

1. En el servidor:

```bash
mkdir -p /opt/trading_bot
```

2. Desde tu PC, sube el código (sin datos runtime):

```bash
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude memoria_aether.json \
  --exclude trading_notes \
  ./ root@137.184.131.36:/opt/trading_bot/
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
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude memoria_aether.json \
  --exclude trading_notes \
  ./ root@137.184.131.36:/opt/trading_bot/
```

2. En el servidor:

```bash
cd /opt/trading_bot
npm ci --omit=dev
systemctl restart trading-bot
```
