"""Tiny stdlib-only server: serves the quiz and appends each submission to a CSV.

Submissions must carry an ALTCHA (https://altcha.org, MIT) proof-of-work payload.
The challenge/verify logic below is a port of altcha@3's lib (v3 protocol,
counter mode, PBKDF2/SHA-256)."""

import base64
import csv
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).parent
STATIC = BASE / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CSV_PATH = DATA_DIR / "results.csv"
COMMENTS_PATH = DATA_DIR / "comments.csv"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 16 * 1024

# ALTCHA settings. Set ALTCHA_HMAC_KEY so challenges survive restarts.
ALTCHA_KEY = (os.environ.get("ALTCHA_HMAC_KEY") or secrets.token_hex(32)).encode()
ALTCHA_ALGORITHM = "PBKDF2/SHA-256"
ALTCHA_COST = int(os.environ.get("ALTCHA_COST", "1000"))  # PBKDF2 iterations per attempt
ALTCHA_COUNTER_MIN = int(os.environ.get("ALTCHA_COUNTER_MIN", "1000"))  # attempts the browser must make
ALTCHA_COUNTER_MAX = int(os.environ.get("ALTCHA_COUNTER_MAX", "4000"))
ALTCHA_TTL = 600  # seconds a challenge stays valid

QUIZ = json.loads((STATIC / "questions.json").read_text(encoding="utf-8"))
LISTS = list(QUIZ["lists"].keys())
QUESTIONS = QUIZ["questions"]
NEUTRAL = "-"
# How many questions offer an option for each list (used to normalise scores,
# so a list that appears in fewer questions isn't structurally disadvantaged).
OPPORTUNITIES = {k: sum(any(o["list"] == k for o in q["options"]) for q in QUESTIONS) for k in LISTS}

_lock = threading.Lock()
_used_lock = threading.Lock()
_used: dict[str, int] = {}  # challenge signature -> expiresAt (replay protection)


def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _derive(nonce_hex: str, salt_hex: str, counter: int, cost: int, key_len: int) -> bytes:
    password = bytes.fromhex(nonce_hex) + counter.to_bytes(4, "big")
    return hashlib.pbkdf2_hmac("sha256", password, bytes.fromhex(salt_hex), cost, key_len)


def altcha_challenge() -> dict:
    key_len = 32
    params = {
        "algorithm": ALTCHA_ALGORITHM,
        "nonce": secrets.token_hex(16),
        "salt": secrets.token_hex(16),
        "cost": ALTCHA_COST,
        "keyLength": key_len,
        "expiresAt": int(time.time()) + ALTCHA_TTL,
    }
    counter = ALTCHA_COUNTER_MIN + secrets.randbelow(ALTCHA_COUNTER_MAX - ALTCHA_COUNTER_MIN + 1)
    derived = _derive(params["nonce"], params["salt"], counter, params["cost"], key_len)
    params["keyPrefix"] = derived[: key_len // 2].hex()
    signature = hmac.new(ALTCHA_KEY, _canonical(params), hashlib.sha256).hexdigest()
    return {"parameters": dict(sorted(params.items())), "signature": signature}


def altcha_verify(payload_b64) -> bool:
    try:
        payload = json.loads(base64.b64decode(payload_b64, validate=True))
        params = payload["challenge"]["parameters"]
        signature = payload["challenge"]["signature"]
        solution = payload["solution"]
        counter = solution["counter"]
        derived_hex = solution["derivedKey"]
        if not (isinstance(params, dict) and isinstance(signature, str) and isinstance(derived_hex, str)):
            return False
        if not isinstance(counter, int) or isinstance(counter, bool) or not 0 <= counter <= 0xFFFFFFFF:
            return False
        expected = hmac.new(ALTCHA_KEY, _canonical(params), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return False
        now = int(time.time())
        if params.get("algorithm") != ALTCHA_ALGORITHM or int(params["expiresAt"]) < now:
            return False
        derived = _derive(params["nonce"], params["salt"], counter, int(params["cost"]), int(params["keyLength"]))
        if not hmac.compare_digest(derived.hex(), derived_hex.lower()):
            return False
        if not derived.hex().startswith(params["keyPrefix"].lower()):
            return False
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return False
    with _used_lock:  # each solved challenge can be used once
        for sig, exp in list(_used.items()):
            if exp < now:
                del _used[sig]
        if signature in _used:
            return False
        _used[signature] = int(params["expiresAt"])
    return True


def score(answers: dict) -> tuple[dict, str]:
    picks = {k: 0 for k in LISTS}
    for a in answers.values():
        if a in picks:
            picks[a] += 1
    pct = {k: round(100 * picks[k] / OPPORTUNITIES[k], 1) if OPPORTUNITIES[k] else 0.0 for k in LISTS}
    best = max(pct.values())
    if best == 0:
        winner = "ninguna"
    else:
        top = [k for k in LISTS if pct[k] == best]
        winner = top[0] if len(top) == 1 else "empate (" + "/".join(top) + ")"
    return pct, winner


def validate(payload) -> dict | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
        return None
    raw = payload["answers"]
    clean = {}
    for q in QUESTIONS:
        a = raw.get(q["id"])
        valid = {o["list"] for o in q["options"]} | {NEUTRAL}
        if a not in valid:
            return None
        clean[q["id"]] = a
    return clean


RESULTS_HEADER = (
    ["timestamp_utc", "id"] + [q["id"] for q in QUESTIONS] + ["resultado"] + [f"afinidad_{k}" for k in LISTS]
)
COMMENTS_HEADER = ["timestamp_utc", "id", "comentario"]
MAX_COMMENT = 1000
COMMENT_WINDOW = 3600  # seconds after submitting during which a comment is accepted

_pending_comments: dict[str, float] = {}  # submission id -> deadline (one comment each)
_pending_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rotate_if_header_changed(path: Path, header: list[str]) -> None:
    """If questions changed since the file was started, move the old file aside instead of mixing formats."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with path.open(newline="", encoding="utf-8") as f:
        current = next(csv.reader(f), [])
    if current != header:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = path.with_name(f"{path.stem}.{stamp}.old{path.suffix}")
        path.rename(backup)
        print(f"{path.name} had a different header; moved it to {backup.name}", flush=True)


def append_csv(path: Path, header: list[str], row: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        new = not path.exists() or path.stat().st_size == 0
        with path.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(header)
            w.writerow(row)


def append_result(answers: dict, pct: dict, winner: str) -> str:
    sid = secrets.token_hex(6)
    row = [_now_iso(), sid] + [answers[q["id"]] for q in QUESTIONS] + [winner] + [pct[k] for k in LISTS]
    append_csv(CSV_PATH, RESULTS_HEADER, row)
    with _pending_lock:
        now = time.time()
        for k, deadline in list(_pending_comments.items()):
            if deadline < now:
                del _pending_comments[k]
        _pending_comments[sid] = now + COMMENT_WINDOW
    return sid


def clean_comment(text) -> str | None:
    if not isinstance(text, str):
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text or len(text) > MAX_COMMENT:
        return None
    if text[0] in "=+-@\t":  # keep spreadsheet apps from treating it as a formula
        text = "'" + text
    return text


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):  # don't log client IPs
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/results.csv":
            return self._download(CSV_PATH)
        if route == "/api/comments.csv":
            return self._download(COMMENTS_PATH)
        if route == "/api/altcha":
            body = json.dumps(altcha_challenge()).encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        return super().do_GET()

    def _download(self, path: Path):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if "?" in self.path and not token:
            from urllib.parse import parse_qs, urlsplit
            token = parse_qs(urlsplit(self.path).query).get("token", [""])[0]
        if not ADMIN_TOKEN or not hmac.compare_digest(token, ADMIN_TOKEN):
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        data = path.read_bytes() if path.exists() else b""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path not in ("/api/submit", "/api/comment"):
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "bad request"})
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
        if self.path == "/api/comment":
            return self._comment(payload)
        if not isinstance(payload, dict) or not altcha_verify(payload.get("altcha")):
            return self._json(HTTPStatus.FORBIDDEN, {"error": "captcha"})
        answers = validate(payload)
        if answers is None:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid answers"})
        pct, winner = score(answers)
        sid = append_result(answers, pct, winner)
        return self._json(HTTPStatus.OK, {"id": sid, "scores": pct, "winner": winner})

    def _comment(self, payload):
        # Comments ride on a captcha-verified submission: its id is good for one comment.
        if not isinstance(payload, dict):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "bad request"})
        comment = clean_comment(payload.get("comment"))
        if comment is None:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid comment"})
        sid = payload.get("id")
        with _pending_lock:
            deadline = _pending_comments.pop(sid, None) if isinstance(sid, str) else None
        if deadline is None or deadline < time.time():
            return self._json(HTTPStatus.FORBIDDEN, {"error": "expired"})
        append_csv(COMMENTS_PATH, COMMENTS_HEADER, [_now_iso(), sid, comment])
        return self._json(HTTPStatus.OK, {"ok": True})


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rotate_if_header_changed(CSV_PATH, RESULTS_HEADER)
    rotate_if_header_changed(COMMENTS_PATH, COMMENTS_HEADER)
    print(f"Listening on :{PORT}, writing to {CSV_PATH} and {COMMENTS_PATH}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
