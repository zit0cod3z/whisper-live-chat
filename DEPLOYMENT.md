# Whisper Room Live Deployment

This app is fully private.

## Environment variables

- `WHISPER_HOST`
- `WHISPER_PORT`
- optional `PYTHON_VERSION`

Local example:

```powershell
$env:WHISPER_HOST="127.0.0.1"
$env:WHISPER_PORT="8787"
python server.py
```

Production example:

```powershell
$env:WHISPER_HOST="0.0.0.0"
$env:WHISPER_PORT="10000"
python server.py
```

## Windows launcher

You can start the app with:

```powershell
.\start-whisper-room-live.bat
```

Override the bind address before launching if needed:

```powershell
$env:WHISPER_HOST="0.0.0.0"
$env:WHISPER_PORT="8787"
.\start-whisper-room-live.bat
```

## Render

This project includes:

- `Procfile`
- repo-root `render.yaml`

Recommended settings:

- Runtime: `Python`
- Root Directory: `whisper-room-live`
- Build Command: leave blank
- Start command: `python server.py`
- Environment variable: `WHISPER_HOST=0.0.0.0`
- Optional environment variable: `PYTHON_VERSION=3.14.3`
- Health Check Path: `/health`

Render usually provides `PORT` automatically, and `server.py` already reads it. Render officially supports setting Python via `.python-version` or `PYTHON_VERSION`.

## Railway

This project includes:

- `Procfile`
- `railway.json`

Recommended settings:

- Start command: `python server.py`
- Environment variable: `WHISPER_HOST=0.0.0.0`

Railway also provides `PORT`, which `server.py` reads automatically.

## VPS with Nginx reverse proxy

Run the Python app on an internal port:

```powershell
$env:WHISPER_HOST="127.0.0.1"
$env:WHISPER_PORT="8787"
python server.py
```

Then place Nginx in front of it. Example server block:

```nginx
server {
    listen 80;
    server_name chat.example.com;

    location / {
        proxy_http_version 1.1;
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

For HTTPS, terminate TLS at Nginx and keep the Python app behind it on localhost. Those `Upgrade` headers are important because the chat now uses WebSockets for instant delivery.

## Health check

The app exposes:

```text
/health
```

Example:

```text
https://chat.example.com/health
```

## Important note

If you open the app from another phone, that phone must be able to reach the machine or host running the Python server. On a local network, use your computer's LAN IP instead of `127.0.0.1`.
