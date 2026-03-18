# Trading Bot Telegram

Bot de Telegram en Node.js para utilidades de trading (integración con exchanges vía CCXT y automatizaciones).

## Uso rápido

```bash
npm ci
cp .env.example .env
npm start
```

## Despliegue

Ver [DEPLOY.md](DEPLOY.md).

## API privada (para tu web/Vercel)

Este repo incluye una API HTTP simple para consumir desde tu web (por ejemplo un dashboard en Vercel).

Variables en `.env`:

- `TRADING_BOT_API_KEY`: token para `Authorization: Bearer ...`
- `TRADING_BOT_API_HOST` / `TRADING_BOT_API_PORT`
- `TRADING_BOT_API_ALLOWED_ORIGINS`: lista separada por comas (solo si llamas desde el navegador)

Arranque:

```bash
npm run api
```

Endpoints:

- `GET /health`
- `POST /api/signal` body: `{ "exchange": "...", "symbol": "BTC/USDT", "timeframe": "15m" | "all" }`
- `GET /api/paper/positions`
- `POST /api/paper/open`
- `POST /api/paper/close`
- `POST /api/paper/partial`
- `GET /api/paper/trades?limit=100`

Recomendación para Vercel: no expongas `TRADING_BOT_API_KEY` al navegador; úsalo en un endpoint server-side (route handler) que haga proxy hacia esta API.

### UI en Cloudflare Pages (visual)

Este repo incluye una UI estática en `public/` y un proxy server-side en `functions/` para Cloudflare Pages, para que tengas un apartado visual sin exponer tokens en el navegador.

En Cloudflare Pages:

- Build command: vacío
- Output directory: `public`
- Environment Variables (para Pages Functions):
  - `BOT_API_BASE_URL=https://api.tu-dominio.com`
  - `BOT_API_KEY=<mismo token que TRADING_BOT_API_KEY>`

La UI queda en `https://<tu-proyecto>.pages.dev/` y consume:

- `POST /api/signal`
- `GET /api/paper/positions`
- `GET /api/paper/trades?limit=100`

### Proxy en Vercel

Este repo incluye endpoints serverless en `api/` para usar Vercel como “puente” y así no filtrar el token al navegador.

En Vercel (Project Settings → Environment Variables):

- `BOT_API_BASE_URL`: URL pública de tu servidor (ej. `https://api.tu-dominio.com`)
- `BOT_API_KEY`: el mismo valor que `TRADING_BOT_API_KEY` en tu servidor

Luego, desde tu web, llama a tu dominio de Vercel:

- `POST https://<tu-app>.vercel.app/api/signal`
- `GET https://<tu-app>.vercel.app/api/paper/positions`
- `GET https://<tu-app>.vercel.app/api/paper/trades?limit=100`

Para publicar el dominio `api.tu-dominio.com` sin abrir puertos en el servidor: ver [CLOUDFLARE.md](CLOUDFLARE.md).

## Bots (referencia)

| Bot | Lenguaje | Enfoque Principal | Dificultad |
| --- | --- | --- | --- |
| Freqtrade | Python | Estrategias técnicas / ML | Media |
| Hummingbot | Python/C++ | Arbitraje / Market Making | Alta |
| OctoBot | Python | Multiestrategia / IA | Baja-Media |
| Jesse | Python | Backtesting preciso | Media |
