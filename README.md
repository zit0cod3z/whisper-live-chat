# Whisper Room Live

A standalone lightweight chat app that stays completely separate from the Django fuel delivery project.

## What it uses

- Python standard library only
- In-memory rooms with no database
- Native WebSocket transport for instant updates across devices
- Shareable room links via the URL hash
- Automatic room cleanup when the last participant leaves

## Run it

```powershell

python server.py
```

Then open:

```text
http://127.0.0.1:8787
```

Or use the Windows launcher:

```powershell
.\start-whisper-room-live.bat
```

## Notes

- This is a lightweight Python WebSocket backend, not a database-backed chat server.
- Another phone can join only if it can reach the machine running the server.
- Messages and uploads live in server memory only and disappear when the process stops or the room is deleted.
- `server.py` reads `WHISPER_HOST`, `WHISPER_PORT`, and fallback `PORT` automatically.
- Production deployment notes are in `DEPLOYMENT.md`.
- Render Blueprint config for this repo layout now lives at the repo root in `render.yaml`.
- Python runtime is pinned in `.python-version`.
