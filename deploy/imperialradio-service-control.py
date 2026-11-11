#!/usr/bin/env python3
"""Systemd socket-activated, allowlisted radio service restart helper.

Install root-owned (0755). Only the application's Unix socket owner and root
can connect. The request cannot select a shell command or an arbitrary unit.
"""
import json
import os
import pwd
import socket
import struct
import subprocess

UNITS = {
    'liquidsoap': 'imperialradio-liquidsoap.service',
    'icecast': 'icecast2.service',
    'mediamtx': 'mediamtx.service',
}
SYSTEMCTL = '/usr/bin/systemctl'
MAX_MESSAGE = 1024


def run_service_command(service):
    if not isinstance(service, str) or service not in UNITS:
        return {'ok': False, 'error': 'Invalid service'}
    unit = UNITS[service]
    try:
        subprocess.run([SYSTEMCTL, 'restart', '--', unit], check=True,
                       capture_output=True, text=True, timeout=35)
        result = subprocess.run([SYSTEMCTL, 'show', '--property=ActiveState',
                                 '--value', '--', unit], check=True,
                                capture_output=True, text=True, timeout=5)
        return {'ok': True, 'status': result.stdout.strip()}
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {'ok': False, 'error': 'Service restart failed'}


def receive_request(conn):
    message = bytearray()
    while len(message) <= MAX_MESSAGE:
        chunk = conn.recv(min(1024, MAX_MESSAGE + 1 - len(message)))
        if not chunk:
            break
        message.extend(chunk)
        if b'\n' in chunk:
            break
    if len(message) > MAX_MESSAGE or b'\n' not in message:
        return {'ok': False, 'error': 'Invalid request'}
    try:
        data = json.loads(bytes(message).split(b'\n', 1)[0])
    except (UnicodeDecodeError, ValueError):
        return {'ok': False, 'error': 'Invalid JSON'}
    if not isinstance(data, dict) or set(data) != {'service'}:
        return {'ok': False, 'error': 'Invalid request'}
    return run_service_command(data['service'])


def main():
    # Socket permissions already enforce the authorized service identity.
    # SO_PEERCRED also rejects requests arriving from an unexpectedly shared FD.
    app_user = os.environ.get('IMPERIALRADIO_APP_USER', 'imperialradio')
    app_uid = pwd.getpwnam(app_user).pw_uid
    if int(os.environ.get('LISTEN_PID', '0')) != os.getpid() or int(os.environ.get('LISTEN_FDS', '0')) != 1:
        raise SystemExit('Must be activated by the systemd socket unit')
    listener = socket.socket(fileno=3)
    while True:
        conn, _ = listener.accept()
        with conn:
            try:
                conn.settimeout(45)
                peer_cred = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                _pid, uid, _gid = struct.unpack('3i', peer_cred)
                if uid not in (0, app_uid):
                    result = {'ok': False, 'error': 'Unauthorized'}
                else:
                    result = receive_request(conn)
            except (OSError, UnicodeError, ValueError):
                result = {'ok': False, 'error': 'Invalid request'}
            try:
                conn.sendall((json.dumps(result, separators=(',', ':')) + '\n').encode('utf-8'))
            except OSError:
                pass


if __name__ == '__main__':
    main()
