# Whisper Room Live: Scale, Security, and Caching

## What is implemented in this lightweight version

- WebSocket realtime delivery with reconnect handling
- In-memory room isolation
- Rate limiting for connection attempts and message bursts
- Security headers for static responses
- Static asset caching headers plus service-worker caching
- End-to-end encrypted message content when a room passphrase is used
- Password-protected rooms, room expiry, message self-destruct, and inactivity lock

## What a true 10,000-user rollout needs

This single-process Python server is good for lightweight rooms and demos, but a real 10,000-user launch needs horizontal scaling.

Recommended production layout:

1. Load balancer in front of multiple app instances
   - Nginx, HAProxy, Cloudflare, or Render/railway edge proxy
   - WebSocket upgrade support must stay enabled

2. Shared realtime state
   - Redis pub/sub or Redis streams for room fan-out
   - Shared room policy storage instead of in-memory-only state

3. Shared file storage
   - S3-compatible object storage for uploads
   - CDN delivery for media files

4. Worker split
   - WebSocket gateway nodes
   - media processing/background cleanup workers

5. Observability
   - structured logs
   - per-room and per-node metrics
   - alerting on connection spikes and queue lag

## API request security notes

- Keep the current rate limits and tune them under load
- Terminate TLS at the proxy
- Add origin allow-list enforcement for WebSocket upgrades
- Add signed room tokens if rooms should not be guessable
- Move passphrase and room policy validation to a shared store in multi-node mode

## Caching notes

- Cache only static files aggressively
- Never cache live room payloads or message history responses
- Use CDN caching for `styles.css`, `app.js`, `manifest.json`, and icons
- Keep WebSocket traffic uncached
