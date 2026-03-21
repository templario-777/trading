# SKILL: bot-trading-ssh-adaptativo

## Descripción
Skill para integrar comunicaciones con el bot de trading experto a través de SSH y habilitar ciclo de aprendizaje continuo.

- El usuario tiene un bot de trading ya experto.
- Quieren comandos remotos (SSH / API) para operar y monitorizar.
- Quieren registro de eventos, análisis y retroalimentación para autoajuste.

## Alcance
- Se alinea a un proyecto local `Trading_bot`.
- Usable desde servidores remotos (SSH) y pipelines de despliegue (VPS/Cloudflare/Verce).
- Fácil de extender con tareas de `api/paper/*` y `api/signal` existentes.

## Flujo de trabajo propuesto
1. Recibir comando SSH en servidor (ej: `ssh <host> "trading-bot run").
2. Consultar estado actual (saldo, posiciones, reglas activas).
3. Ejecutar acción pedida (open/close/partial/positions/trades/signal).
4. Guardar eventos en `trading_notes/daily_stats.json` o `memoria_aether.json`.
5. Analizar resultados y generar métricas (profit, drawdown, aciertos).
6. Emitir sugerencias de ajuste a estrategias (draft) y notificar al usuario.

## Reglas de decisión
- Si hay pérdidas repetidas > `riskThreshold`, sugerir reducir tamaño de lote o pausas.
- Si hay rachas de aciertos > `winStreakThreshold`, proponer optimización de agresividad.
- Si recibe `learn` o `auto-adapt`, iniciar entrenamiento incremental automático de parámetros.

## Checklist de completitud
- [ ] Se puede ejecutar el bot desde SSH con comando único.
- [ ] Los resultados quedan guardados en JSON de historial.
- [ ] Existe endpoint local/función `evaluar_riesgo()` que devuelve señal de ajuste.
- [ ] El sistema puede emitir recomendaciones a través de `stdout`/log.
- [ ] Se documenta cómo levantar un servicio remoto (systemd/pm2/vps.ps1).

## Integración con el proyecto actual
1. Añadir endpoint POST `/api/signal` y `/api/paper/*` en `functions/api/`.
2. En tu script de servidor (`index.js`, `api.js`) incorporar bandera `--adaptive`.
3. En `scripts/vps.ps1`, incluir comandos SSH para ejecutar y recolectar logs:
   - `ssh user@host "cd /path/Trading_bot && npm run trade -- --adaptive"

## Requisitos previos
- Node.js 18+
- Dependencias de `package.json` instaladas
- Ruta absoluta (`CWD`) bien configurada para el bot en producción

## Instrucciones de uso
1. Desde estación local:
   ```powershell
   ssh user@host "cd /path/Trading_bot && npm run trade -- --mode=live --adaptive"
   ```
2. El bot imprime métricas adaptativas y writes a `trading_notes/daily_stats.json`.
3. Para inspeccionar siri:
   ```powershell
   cat trading_notes/daily_stats.json | jq
   ```

## Siguientes mejoras sugeridas
- Crear un endpoint `/api/feedback` que reciba anotações manuales y ajuste modelo.
- Implementar `ML retraining` con logs semanales y compara resultados mensuales.
- Añadir alertas SMTP/Telegram cuando encuentre patrón nuevo fuera de rango.
