from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import posixpath
import socket
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8787
MAX_FILE_SIZE = 12 * 1024 * 1024
PARTICIPANT_TTL_SECONDS = 90
ROOM_GRACE_SECONDS = 5
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_CONNECTS_PER_MINUTE = 60
MAX_MESSAGES_PER_10_SECONDS = 45

RATE_LIMITS: dict[str, list[float]] = {}
RATE_LIMITS_LOCK = threading.Lock()


@dataclass
class ClientConnection:
    session_id: str
    sender_name: str
    socket: socket.socket
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_seen: float = field(default_factory=time.time)


@dataclass
class Room:
    next_id: int = 1
    messages: list[dict[str, Any]] = field(default_factory=list)
    clients: dict[str, ClientConnection] = field(default_factory=dict)
    updated_at: float = field(default_factory=time.time)
    pinned_message_id: int | None = None
    password_hash: str | None = None
    expires_at: float | None = None
    message_ttl_seconds: int | None = None
    inactivity_lock_seconds: int | None = None


ROOMS: dict[str, Room] = {}
ROOMS_LOCK = threading.Lock()


def now_ts() -> float:
    return time.time()


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def display_name(session_id: str) -> str:
    return f"Anon {session_id[:4].upper()}"


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def normalize_room_id(room_id: str) -> str:
    allowed = [char for char in room_id.lower() if char.isalnum() or char in {"-", "_"}]
    normalized = "".join(allowed)[:40]
    return normalized or "lobby"


def ensure_room(room_id: str) -> Room:
    room = ROOMS.get(room_id)
    if room is None:
        room = Room()
        ROOMS[room_id] = room
    room.updated_at = now_ts()
    prune_room(room)
    return room


def prune_room(room: Room) -> None:
    room.messages = [
        message
        for message in room.messages
        if not message.get("expires_at") or message["expires_at"] > now_ts()
    ]
    if room.pinned_message_id and not any(message["id"] == room.pinned_message_id for message in room.messages):
        room.pinned_message_id = None


def cleanup_rooms() -> None:
    while True:
        with ROOMS_LOCK:
            cutoff = now_ts() - PARTICIPANT_TTL_SECONDS
            to_delete: list[str] = []
            for room_id, room in ROOMS.items():
                prune_room(room)
                stale_sessions = [
                    session_id
                    for session_id, client in room.clients.items()
                    if client.last_seen < cutoff
                ]
                for session_id in stale_sessions:
                    client = room.clients.pop(session_id, None)
                    if client is not None:
                        try:
                            client.socket.close()
                        except OSError:
                            pass
                room_expired = room.expires_at is not None and room.expires_at <= now_ts()
                room_locked = (
                    room.inactivity_lock_seconds is not None
                    and not room.clients
                    and room.updated_at < now_ts() - room.inactivity_lock_seconds
                )
                if room_expired or room_locked or (not room.clients and room.updated_at < now_ts() - ROOM_GRACE_SECONDS):
                    to_delete.append(room_id)
            for room_id in to_delete:
                ROOMS.pop(room_id, None)
            for key, timestamps in list(RATE_LIMITS.items()):
                RATE_LIMITS[key] = [stamp for stamp in timestamps if stamp >= now_ts() - 60]
                if not RATE_LIMITS[key]:
                    RATE_LIMITS.pop(key, None)
        time.sleep(10)


def is_rate_limited(bucket: str, *, max_hits: int, window_seconds: int) -> bool:
    now = now_ts()
    with RATE_LIMITS_LOCK:
        timestamps = [stamp for stamp in RATE_LIMITS.get(bucket, []) if stamp >= now - window_seconds]
        if len(timestamps) >= max_hits:
            RATE_LIMITS[bucket] = timestamps
            return True
        timestamps.append(now)
        RATE_LIMITS[bucket] = timestamps
        return False


def build_ws_accept(key: str) -> str:
    value = hashlib.sha1(f"{key}{WEBSOCKET_GUID}".encode("utf-8")).digest()
    return base64.b64encode(value).decode("ascii")


def recv_exact(sock: socket.socket, length: int) -> bytes:
    buffer = b""
    while len(buffer) < length:
        chunk = sock.recv(length - len(buffer))
        if not chunk:
            raise ConnectionError("Socket closed")
        buffer += chunk
    return buffer


def recv_ws_frame(sock: socket.socket) -> tuple[bool, int, bytes]:
    header = recv_exact(sock, 2)
    first_byte, second_byte = header[0], header[1]
    fin = bool(first_byte & 0x80)
    opcode = first_byte & 0x0F
    masked = bool(second_byte & 0x80)
    payload_length = second_byte & 0x7F

    if payload_length == 126:
      payload_length = int.from_bytes(recv_exact(sock, 2), "big")
    elif payload_length == 127:
      payload_length = int.from_bytes(recv_exact(sock, 8), "big")

    masking_key = recv_exact(sock, 4) if masked else b""
    payload = recv_exact(sock, payload_length) if payload_length else b""

    if masked:
        payload = bytes(byte ^ masking_key[index % 4] for index, byte in enumerate(payload))

    return fin, opcode, payload


def recv_ws_message(sock: socket.socket) -> tuple[int, bytes]:
    message_parts: list[bytes] = []
    current_opcode: int | None = None

    while True:
        fin, opcode, payload = recv_ws_frame(sock)

        if opcode in {0x8, 0x9, 0xA}:
            return opcode, payload

        if opcode == 0x0:
            if current_opcode is None:
                raise ConnectionError("Unexpected continuation frame")
            message_parts.append(payload)
            if fin:
                return current_opcode, b"".join(message_parts)
            continue

        current_opcode = opcode
        message_parts = [payload]
        if fin:
            return opcode, payload


def send_ws_frame(sock: socket.socket, payload: str, opcode: int = 0x1) -> None:
    data = payload.encode("utf-8")
    header = bytearray()
    header.append(0x80 | opcode)
    length = len(data)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(length.to_bytes(2, "big"))
    else:
        header.append(127)
        header.extend(length.to_bytes(8, "big"))
    sock.sendall(bytes(header) + data)


def safe_send(client: ClientConnection, payload: dict[str, Any]) -> bool:
    try:
        with client.lock:
            send_ws_frame(client.socket, json.dumps(payload))
        return True
    except OSError:
        return False


def broadcast_room_state(room_id: str, payload: dict[str, Any]) -> None:
    with ROOMS_LOCK:
        room = ROOMS.get(room_id)
        if room is None:
            return
        clients = list(room.clients.values())

    stale_sessions: list[str] = []
    for client in clients:
        delivered = safe_send(client, payload)
        if not delivered:
            stale_sessions.append(client.session_id)

    if stale_sessions:
        with ROOMS_LOCK:
            room = ROOMS.get(room_id)
            if room is None:
                return
            for session_id in stale_sessions:
                room.clients.pop(session_id, None)


def participant_count(room_id: str) -> int:
    room = ROOMS.get(room_id)
    return len(room.clients) if room else 0


def update_message_receipts(
    room: Room,
    session_id: str,
    *,
    delivered_up_to: int | None = None,
    read_up_to: int | None = None,
) -> list[int]:
    changed_message_ids: list[int] = []
    for message in room.messages:
        changed = False
        if delivered_up_to is not None and message["id"] <= delivered_up_to:
            delivered_to = message.setdefault("delivered_to", [])
            if session_id not in delivered_to:
                delivered_to.append(session_id)
                changed = True
        if read_up_to is not None and message["id"] <= read_up_to:
            read_by = message.setdefault("read_by", [])
            if session_id not in read_by:
                read_by.append(session_id)
                changed = True
        if changed:
            changed_message_ids.append(message["id"])
    return changed_message_ids


def build_receipt_payload(room: Room, message_ids: list[int]) -> dict[str, Any]:
    receipts = []
    for message in room.messages:
        if message["id"] in message_ids:
            receipts.append(
                {
                    "id": message["id"],
                    "delivered_to": message.get("delivered_to", []),
                    "read_by": message.get("read_by", []),
                }
            )
    return {"type": "receipt_update", "receipts": receipts}


def notify_presence(room_id: str) -> None:
    with ROOMS_LOCK:
        room = ROOMS.get(room_id)
        participants = len(room.clients) if room else 0
        participant_details = [
            {
                "session_id": client.session_id,
                "sender_name": client.sender_name,
                "last_seen": client.last_seen,
            }
            for client in room.clients.values()
        ] if room else []
    broadcast_room_state(
        room_id,
        {"type": "presence", "participants": participants, "participant_details": participant_details},
    )


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "WhisperRoomLive/2.0"

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_common_headers("application/json")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json_response({"status": "ok", "transport": "websocket"})
            return
        if parsed.path == "/ws":
            self._handle_websocket(parsed)
            return
        self._serve_static(parsed.path)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _handle_websocket(self, parsed) -> None:
        upgrade = self.headers.get("Upgrade", "").lower()
        connection = self.headers.get("Connection", "").lower()
        ws_key = self.headers.get("Sec-WebSocket-Key", "")
        if upgrade != "websocket" or "upgrade" not in connection or not ws_key:
            self._json_response({"error": "WebSocket upgrade required"}, status=HTTPStatus.BAD_REQUEST)
            return

        query = parse_qs(parsed.query)
        room_id = normalize_room_id(query.get("room", ["lobby"])[0])
        session_id = str(query.get("session_id", [""])[0]).strip()
        room_passcode = str(query.get("passcode", [""])[0]).strip()
        client_ip = self.client_address[0]
        if not session_id:
            self._json_response({"error": "session_id is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        if is_rate_limited(f"ws-connect:{client_ip}", max_hits=MAX_WS_CONNECTS_PER_MINUTE, window_seconds=60):
            self._json_response({"error": "Too many connection attempts"}, status=HTTPStatus.TOO_MANY_REQUESTS)
            return

        with ROOMS_LOCK:
            existing_room = ROOMS.get(room_id)
            if existing_room is not None:
                if existing_room.expires_at is not None and existing_room.expires_at <= now_ts():
                    self._json_response({"error": "This room link has expired"}, status=HTTPStatus.GONE)
                    return
                if existing_room.password_hash and hash_secret(room_passcode) != existing_room.password_hash:
                    self._json_response({"error": "This room requires the correct passphrase"}, status=HTTPStatus.FORBIDDEN)
                    return

        accept_key = build_ws_accept(ws_key)
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept_key)
        self.end_headers()

        client_socket = self.connection
        client_socket.settimeout(None)
        sender_name = display_name(session_id)

        with ROOMS_LOCK:
            room = ensure_room(room_id)
            previous = room.clients.pop(session_id, None)
            if previous is not None:
                try:
                    previous.socket.close()
                except OSError:
                    pass
            client = ClientConnection(session_id=session_id, sender_name=sender_name, socket=client_socket)
            room.clients[session_id] = client
            room.updated_at = now_ts()
            delivered_history = update_message_receipts(room, session_id, delivered_up_to=room.next_id)
            history = list(room.messages)
            participants = len(room.clients)
            participant_details = [
                {
                    "session_id": room_client.session_id,
                    "sender_name": room_client.sender_name,
                    "last_seen": room_client.last_seen,
                }
                for room_client in room.clients.values()
            ]

        safe_send(
            client,
            {
                "type": "welcome",
                "room_id": room_id,
                "session_id": session_id,
                "sender_name": sender_name,
                "participants": participants,
                "messages": history,
                "pinned_message_id": room.pinned_message_id,
                "participant_details": participant_details,
                "room_policy": {
                    "expires_at": room.expires_at,
                    "message_ttl_seconds": room.message_ttl_seconds,
                    "inactivity_lock_seconds": room.inactivity_lock_seconds,
                    "is_protected": bool(room.password_hash),
                },
            },
        )
        notify_presence(room_id)
        if delivered_history:
            broadcast_room_state(room_id, build_receipt_payload(room, delivered_history))

        try:
            while True:
                opcode, payload = recv_ws_message(client_socket)
                client.last_seen = now_ts()

                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with client.lock:
                        send_ws_frame(client_socket, payload.decode("utf-8", errors="ignore"), opcode=0xA)
                    continue
                if opcode != 0x1:
                    continue

                try:
                    message_data = json.loads(payload.decode("utf-8"))
                except json.JSONDecodeError:
                    continue

                event_type = str(message_data.get("type", "")).strip()
                if event_type == "ping":
                    safe_send(client, {"type": "pong"})
                    continue
                if event_type == "room_settings":
                    passphrase = str(message_data.get("passphrase", "")).strip()
                    expiry_minutes = int(message_data.get("expiry_minutes", 0) or 0)
                    message_ttl_minutes = int(message_data.get("message_ttl_minutes", 0) or 0)
                    inactivity_lock_minutes = int(message_data.get("inactivity_lock_minutes", 0) or 0)
                    with ROOMS_LOCK:
                        room = ensure_room(room_id)
                        room.password_hash = hash_secret(passphrase) if passphrase else None
                        room.expires_at = now_ts() + (expiry_minutes * 60) if expiry_minutes > 0 else None
                        room.message_ttl_seconds = message_ttl_minutes * 60 if message_ttl_minutes > 0 else None
                        room.inactivity_lock_seconds = (
                            inactivity_lock_minutes * 60 if inactivity_lock_minutes > 0 else None
                        )
                        room.updated_at = now_ts()
                        policy_payload = {
                            "type": "room_policy",
                            "room_policy": {
                                "expires_at": room.expires_at,
                                "message_ttl_seconds": room.message_ttl_seconds,
                                "inactivity_lock_seconds": room.inactivity_lock_seconds,
                                "is_protected": bool(room.password_hash),
                            },
                        }
                    broadcast_room_state(room_id, policy_payload)
                    continue
                if event_type == "reaction":
                    message_id = int(message_data.get("message_id", 0) or 0)
                    emoji = str(message_data.get("emoji", "")).strip()[:10]
                    if not message_id or not emoji:
                        continue
                    with ROOMS_LOCK:
                        room = ensure_room(room_id)
                        reaction_payload = None
                        for message in room.messages:
                            if message["id"] != message_id:
                                continue
                            reactions = message.setdefault("reactions", {})
                            sessions = reactions.setdefault(emoji, [])
                            if session_id in sessions:
                                sessions.remove(session_id)
                            else:
                                sessions.append(session_id)
                            if not sessions:
                                reactions.pop(emoji, None)
                            reaction_payload = {
                                "type": "reaction_update",
                                "message_id": message_id,
                                "reactions": reactions,
                            }
                            break
                    if reaction_payload:
                        broadcast_room_state(room_id, reaction_payload)
                    continue
                if event_type == "pin":
                    message_id = int(message_data.get("message_id", 0) or 0)
                    with ROOMS_LOCK:
                        room = ensure_room(room_id)
                        room.pinned_message_id = None if room.pinned_message_id == message_id else message_id
                        pin_payload = {
                            "type": "pin_update",
                            "pinned_message_id": room.pinned_message_id,
                        }
                    broadcast_room_state(room_id, pin_payload)
                    continue
                if event_type == "typing":
                    is_typing = bool(message_data.get("is_typing"))
                    broadcast_room_state(
                        room_id,
                        {
                            "type": "typing",
                            "session_id": session_id,
                            "sender_name": sender_name,
                            "is_typing": is_typing,
                        },
                    )
                    continue
                if event_type == "read":
                    last_message_id = int(message_data.get("last_message_id", 0) or 0)
                    if last_message_id <= 0:
                        continue
                    with ROOMS_LOCK:
                        room = ensure_room(room_id)
                        changed = update_message_receipts(room, session_id, read_up_to=last_message_id)
                    if changed:
                        broadcast_room_state(room_id, build_receipt_payload(room, changed))
                    continue
                if event_type != "message":
                    continue

                text = str(message_data.get("text", "")).strip()
                file_payload = message_data.get("file")
                reply_to = int(message_data.get("reply_to", 0) or 0)
                ttl_minutes = int(message_data.get("self_destruct_minutes", 0) or 0)
                encrypted_text = message_data.get("encrypted_text")
                if not text and not file_payload and not encrypted_text:
                    continue
                if is_rate_limited(f"msg:{room_id}:{session_id}", max_hits=MAX_MESSAGES_PER_10_SECONDS, window_seconds=10):
                    safe_send(client, {"type": "error", "message": "You are sending messages too quickly. Please slow down."})
                    continue

                validated_file = None
                if file_payload:
                    validated_file = self._validate_file_payload(file_payload)
                    if isinstance(validated_file, dict) and validated_file.get("error"):
                        safe_send(client, {"type": "error", "message": validated_file["error"]})
                        continue

                with ROOMS_LOCK:
                    room = ensure_room(room_id)
                    room_client = room.clients.get(session_id)
                    if room_client is not None:
                        room_client.last_seen = now_ts()
                    effective_ttl_seconds = ttl_minutes * 60 if ttl_minutes > 0 else room.message_ttl_seconds
                    message = {
                        "id": room.next_id,
                        "session_id": session_id,
                        "sender_name": sender_name,
                        "text": text,
                        "encrypted_text": encrypted_text if isinstance(encrypted_text, dict) else None,
                        "file": validated_file,
                        "timestamp": iso_now(),
                        "reply_to": reply_to or None,
                        "expires_at": now_ts() + effective_ttl_seconds if effective_ttl_seconds else None,
                        "delivered_to": [session_id],
                        "read_by": [session_id],
                        "reactions": {},
                    }
                    room.next_id += 1
                    room.messages.append(message)
                    room.updated_at = now_ts()
                    recipients = list(room.clients.keys())
                    update_message_receipts(room, session_id, delivered_up_to=message["id"])
                    for recipient_session in recipients:
                        if recipient_session != session_id:
                            update_message_receipts(room, recipient_session, delivered_up_to=message["id"])

                broadcast_room_state(room_id, {"type": "message", "message": message})
                with ROOMS_LOCK:
                    room = ROOMS.get(room_id)
                    receipt_payload = build_receipt_payload(room, [message["id"]]) if room is not None else None
                if receipt_payload is not None:
                    broadcast_room_state(room_id, receipt_payload)
        except (ConnectionError, OSError):
            pass
        finally:
            with ROOMS_LOCK:
                room = ROOMS.get(room_id)
                if room is not None:
                    room.clients.pop(session_id, None)
                    room.updated_at = now_ts()
                    if not room.clients:
                        room.updated_at = now_ts()
            notify_presence(room_id)
            try:
                client_socket.close()
            except OSError:
                pass

    def _validate_file_payload(self, file_payload: Any) -> dict[str, Any] | dict[str, str]:
        if not isinstance(file_payload, dict):
            return {"error": "file payload must be an object"}

        name = str(file_payload.get("name", "")).strip()[:120]
        file_type = str(file_payload.get("type", "")).strip()[:120]
        data_url = str(file_payload.get("data_url", "")).strip()
        size = int(file_payload.get("size", 0) or 0)

        if not name or not data_url:
            return {"error": "file payload is incomplete"}
        if size > MAX_FILE_SIZE:
            return {"error": "file exceeds maximum size"}

        return {
            "name": name,
            "type": file_type or "application/octet-stream",
            "size": size,
            "data_url": data_url,
        }

    def _serve_static(self, path: str) -> None:
        normalized = posixpath.normpath(path.lstrip("/")) or "index.html"
        if normalized in {".", ""}:
            normalized = "index.html"

        file_path = (BASE_DIR / normalized).resolve()
        if not str(file_path).startswith(str(BASE_DIR)) or not file_path.exists() or file_path.is_dir():
            self._json_response({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
            return

        content_type, _ = mimetypes.guess_type(file_path.name)
        body = file_path.read_bytes()
        etag = hashlib.sha1(body).hexdigest()
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self._send_common_headers(content_type or "application/octet-stream")
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(HTTPStatus.OK)
        self._send_common_headers(content_type or "application/octet-stream")
        self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_common_headers(self, content_type: str) -> None:
        self.send_header("Content-Type", content_type)
        cacheable_types = {
            "text/css",
            "application/javascript",
            "text/javascript",
            "image/png",
            "image/jpeg",
            "image/svg+xml",
            "application/manifest+json",
        }
        cache_control = "public, max-age=3600" if content_type in cacheable_types or self.path.endswith("/sw.js") else "no-store"
        self.send_header("Cache-Control", cache_control)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), payment=(), usb=()")

    def _json_response(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_common_headers("application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    cleaner = threading.Thread(target=cleanup_rooms, daemon=True)
    cleaner.start()
    host = os.environ.get("WHISPER_HOST", os.environ.get("HOST", DEFAULT_HOST))
    port = int(os.environ.get("WHISPER_PORT", os.environ.get("PORT", str(DEFAULT_PORT))))
    server = ThreadingHTTPServer((host, port), ChatHandler)
    print(f"Whisper Room Live running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
