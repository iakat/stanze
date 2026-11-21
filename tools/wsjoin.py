#!/usr/bin/env python3
"""Minimal WebSocket client used to smoke test the signaling endpoint.

No third-party modules: it performs the HTTP upgrade and speaks just enough of
RFC 6455 to send one JSON message and read one reply.

    python3 tools/wsjoin.py http://127.0.0.1:8095 <room-id> [passphrase]
"""

import base64
import hashlib
import json
import os
import socket
import struct
import sys
import urllib.parse


def connect(url: str) -> socket.socket:
    u = urllib.parse.urlparse(url)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    key = base64.b64encode(os.urandom(16)).decode()
    path = u.path or "/ws"

    sock = socket.create_connection((host, port), timeout=10)
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: http://%s:%d\r\n"
        "\r\n" % (host, port)
    )
    sock.sendall(request.encode())

    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise SystemExit("server closed during handshake")
        response += chunk
    head = response.split(b"\r\n\r\n", 1)[0].decode(errors="replace")
    if "101" not in head.split("\r\n", 1)[0]:
        raise SystemExit("handshake failed: " + head)
    accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    if accept.lower() not in head.lower():
        raise SystemExit("bad Sec-WebSocket-Accept")
    return sock


def send_text(sock: socket.socket, text: str) -> None:
    payload = text.encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack("!H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + mask + masked)


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise SystemExit("connection closed")
        buf += chunk
    return buf


def recv_text(sock: socket.socket) -> str:
    b1, b2 = recv_exact(sock, 2)
    opcode = b1 & 0x0F
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    payload = recv_exact(sock, length)
    if opcode == 0x9:  # ping
        return recv_text(sock)
    return payload.decode(errors="replace")


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    base = sys.argv[1].rstrip("/")
    room = sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else ""
    sock = connect(base.replace("http://", "ws://").replace("https://", "wss://") + "/ws")
    send_text(sock, json.dumps({"t": "join", "room": room, "pass": password, "name": "probe"}))
    print(recv_text(sock))
    sock.close()


if __name__ == "__main__":
    main()
