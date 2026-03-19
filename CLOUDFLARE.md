# Cloudflare (Tunnel) para exponer la API privada

Objetivo: exponer `api.js` (que puede quedar en `127.0.0.1`) con un dominio HTTPS usando Cloudflare Tunnel, sin abrir puertos entrantes en el VPS.

## Checklist (fin a fin)

1. En tu servidor: configura `.env` (incluye `TRADING_BOT_API_KEY`) y levanta la API privada (`api.js`) en `127.0.0.1:8787` (o tu puerto).
2. En Cloudflare: crea un Tunnel y publícalo como `https://api.tu-dominio.com` apuntando a `http://127.0.0.1:8787`.
3. En Cloudflare Pages: despliega la UI (`public/`) + Functions (`functions/`) y configura `BOT_API_BASE_URL=https://api.tu-dominio.com` + `BOT_API_KEY`.
4. Prueba:
   - UI: `https://<tu-proyecto>.pages.dev/`
   - Salud: `GET https://api.tu-dominio.com/health`

Nota: para Cloudflare Tunnel no se usa “API Token” en la app. Se autentica con `cloudflared tunnel login` + credenciales del tunnel en el servidor. Si compartiste tokens por error, revócalos y genera otros.

## Requisitos

- Tu dominio ya está en Cloudflare (DNS activo).
- La API está levantada en el servidor (ej. `http://127.0.0.1:8787`).
- Tienes definido `TRADING_BOT_API_KEY` en el servidor (la API exige `Authorization: Bearer ...`).

## 1) Crear el Tunnel en Cloudflare

En Cloudflare Zero Trust:

- Access → Tunnels → Create a tunnel
- Elige un nombre (ej. `trading-bot-api`)

## 2) Instalar cloudflared en el servidor (Ubuntu/Debian)

Sigue la guía oficial de Cloudflare para instalar `cloudflared` según tu distro.

## 3) Autenticar y crear el tunnel (CLI)

En el servidor:

- `cloudflared tunnel login`
- `cloudflared tunnel create trading-bot-api`

Esto crea un archivo de credenciales del tunnel (JSON). Guarda su ruta.

## 4) Configurar el ingress (config.yml)

Crea `/etc/cloudflared/config.yml` usando como base el ejemplo:

- [cloudflared-config.yml.example](file:///c:/Users/Alumno.LAPTOP-72MR2U1M/Music/Trading_bot/cloudflare/cloudflared-config.yml.example)

Puntos a ajustar:

- `tunnel`: ID del tunnel
- `credentials-file`: ruta del JSON creado por Cloudflare
- `hostname`: tu subdominio (ej. `api.tu-dominio.com`)
- `service`: URL local de la API (ej. `http://127.0.0.1:8787`)

## 5) Crear el DNS del subdominio

Opción CLI:

- `cloudflared tunnel route dns trading-bot-api api.tu-dominio.com`

O desde el dashboard del tunnel, agrega el Public Hostname.

## 6) Levantar cloudflared como servicio (systemd)

Puedes instalar el servicio automáticamente:

- `cloudflared service install`

O crear un unit file manual usando el ejemplo:

- [cloudflared.service.example](file:///c:/Users/Alumno.LAPTOP-72MR2U1M/Music/Trading_bot/cloudflare/cloudflared.service.example)

## 7) Conectar Vercel a tu API (vía Cloudflare)

En Vercel, configura:

- `BOT_API_BASE_URL=https://api.tu-dominio.com`
- `BOT_API_KEY=<mismo token que TRADING_BOT_API_KEY>`

Tu web llama a Vercel (serverless) y Vercel llama al dominio de Cloudflare. El token no queda expuesto en el navegador.

## 8) Conectar Cloudflare Pages (UI visual) a tu API (vía Cloudflare)

Este repo también incluye una UI para Cloudflare Pages:

- UI: `public/`
- Proxy server-side (Pages Functions): `functions/`

En Cloudflare Pages:

- Output directory: `public`
- Environment Variables:
  - `BOT_API_BASE_URL=https://api.tu-dominio.com`
  - `BOT_API_KEY=<mismo token que TRADING_BOT_API_KEY>`

La UI consume `GET/POST /api/*` en el mismo dominio Pages, y Pages Functions reenvía al dominio del tunnel.

## 9) Publicar tu web como `web.tu-dominio.com` (Custom Domain)

Si quieres que tu UI quede en un subdominio “bonito” como `web.tu-dominio.com` (por ejemplo `web.trading` si tu dominio es `trading`):

1. En Cloudflare Pages → tu proyecto → Custom domains → Add custom domain.
2. Escribe `web.tu-dominio.com`.
3. Sigue el asistente: Cloudflare creará/verificará el DNS (normalmente un `CNAME` o registro equivalente) y emitirá TLS automáticamente.

La UI seguirá llamando a `/api/*` en el mismo dominio, y el proxy de Pages (Functions) seguirá usando `BOT_API_BASE_URL` hacia tu `api.tu-dominio.com` expuesto por Tunnel.

## Extra (opcional)

- Cloudflare Access: además del token, puedes proteger el hostname con Access Policies para permitir solo tu cuenta.
