#!/usr/bin/python3
import json
import subprocess
import sys


SERVICES = {
    "liquidsoap": "imperialradio-liquidsoap.service",
    "icecast": "icecast2.service",
    "mediamtx": "mediamtx.service",
}


def respond(payload):
    print(json.dumps(payload), flush=True)


request_line = sys.stdin.readline(256)
try:
    request = json.loads(request_line)
except json.JSONDecodeError:
    respond({"ok": False, "error": "invalid_request"})
    sys.exit(0)

service_id = request.get("service") if isinstance(request, dict) else None
unit = SERVICES.get(service_id) if isinstance(service_id, str) else None
if unit is None:
    respond({"ok": False, "error": "invalid_service"})
    sys.exit(0)

try:
    subprocess.run(
        ["/usr/bin/systemctl", "restart", unit],
        check=True,
        capture_output=True,
        text=True,
        timeout=40,
    )
    status = subprocess.run(
        ["/usr/bin/systemctl", "show", "--property=ActiveState", "--value", unit],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
except subprocess.TimeoutExpired as error:
    print(f"Service operation timed out: {error}", file=sys.stderr, flush=True)
    respond({"ok": False, "error": "service_restart_failed"})
    sys.exit(0)
except subprocess.CalledProcessError as error:
    print(error.stderr.strip(), file=sys.stderr, flush=True)
    respond({"ok": False, "error": "service_restart_failed"})
    sys.exit(0)

if status != "active":
    respond({"ok": False, "error": "service_not_active"})
    sys.exit(0)

respond({"ok": True, "status": status})
