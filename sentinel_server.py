"""
Local dev server + capture tool for Probe-Droid Sentinel.

    python sentinel_server.py capture     # run once live, save outputs/patrol.json
    python sentinel_server.py serve       # http://localhost:8766 — live run + local replay

Mirrors the HOLOCRON-9 viz_server.py pattern (institutional-memory repo): a
tiny stdlib HTTP server that holds the API key server-side, streams frames to
the browser over SSE, and saves completed runs for offline replay. Once a good
capture exists, copy outputs/patrol.json to replays/patrol.json and commit it —
that's what GitHub Pages serves (no backend, no key).

Endpoints:
    GET  /                  -> viz.html
    GET  /run?run=patrol    -> SSE stream of a LIVE patrol run
    GET  /replay?run=patrol -> SSE replay of the last saved outputs/patrol.json
    GET  /replays/<file>    -> serve replays/*.json (same as static Pages hosting)
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from sentinel_driver import run_patrol

PORT = 8766
ROOT = Path(__file__).parent
OUTPUT_DIR = ROOT / "outputs"


def _load_dotenv():
    """Minimal .env loader (KEY=VALUE per line) — no external dependency."""
    import os

    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def sse(frame: dict) -> bytes:
    return f"data: {json.dumps(frame)}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # quiet

    def _send_html(self):
        body = (ROOT / "viz.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _open_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html", "/viz.html"):
            return self._send_html()
        if parsed.path in ("/viz.css", "/viz.js"):
            return self._serve_static(parsed.path[1:])
        if parsed.path == "/run":
            return self._run_live()
        if parsed.path == "/replay":
            return self._replay()
        if parsed.path.startswith("/replays/"):
            return self._serve_replay_file(parsed.path)
        self.send_response(404)
        self.end_headers()

    def _serve_static(self, fname):
        fpath = ROOT / fname
        if not fpath.exists():
            self.send_response(404); self.end_headers(); return
        body = fpath.read_bytes()
        ctype = "text/css" if fname.endswith(".css") else "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _run_live(self):
        self._open_sse()
        record = []

        def emit(frame):
            record.append(frame)
            try:
                self.wfile.write(sse(frame)); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                raise

        try:
            run_patrol(emit)
        except Exception as e:
            try:
                emit({"type": "error", "text": f"{type(e).__name__}: {e}"})
            except Exception:
                pass
        finally:
            completed = any(f.get("type") == "done" for f in record)
            if completed:
                OUTPUT_DIR.mkdir(exist_ok=True)
                (OUTPUT_DIR / "patrol.json").write_text(
                    json.dumps(record, ensure_ascii=False), encoding="utf-8"
                )

    def _replay(self):
        path = OUTPUT_DIR / "patrol.json"
        self._open_sse()
        if not path.exists():
            self.wfile.write(sse({"type": "error", "text": "No saved run — run capture first."}))
            return
        frames = json.loads(path.read_text(encoding="utf-8"))
        for frame in frames:
            try:
                self.wfile.write(sse(frame)); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(0.02 if frame.get("type") == "answer" else (frame.get("delay", 400) / 1000))

    def _serve_replay_file(self, path):
        fname = path[len("/replays/"):]
        if "/" in fname or ".." in fname:
            self.send_response(403); self.end_headers(); return
        fpath = ROOT / "replays" / fname
        if not fpath.exists() or fpath.suffix != ".json":
            self.send_response(404); self.end_headers(); return
        body = fpath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def capture():
    """Run one patrol live from the CLI (no HTTP), printing progress and
    saving outputs/patrol.json for promotion to replays/patrol.json."""
    record = []

    def emit(frame):
        record.append(frame)
        kind = frame.get("type")
        if kind == "think":
            print(f"  🧠 {frame['text'][:200]}")
        elif kind == "tool":
            print(f"  ⚙ {frame['name']}  {frame.get('target', '')}")
        elif kind == "tool_result":
            print(f"    ↳ {frame['text']}")
        elif kind == "answer":
            print(f"  ✍ {frame['text'][:200]}")
        elif kind in ("status", "flag", "observation"):
            print(f"  [{kind}] {frame.get('text', '')}")
        elif kind == "usage":
            print(f"  [usage] in={frame['input']} out={frame['output']}")

    print("Running Probe-Droid Sentinel patrol live…")
    run_patrol(emit)

    completed = any(f.get("type") == "done" for f in record)
    if completed:
        OUTPUT_DIR.mkdir(exist_ok=True)
        out_path = OUTPUT_DIR / "patrol.json"
        out_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nSaved {len(record)} frames to {out_path}")
        print("Review it, then copy to replays/patrol.json to publish as the demo's replay.")
    else:
        print("\nRun did not complete cleanly — not saving (avoid poisoning a good capture).")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    _load_dotenv()

    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY (env var or .env) before running.")

    mode = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if mode == "capture":
        capture()
    elif mode == "serve":
        print(f"Probe-Droid Sentinel viz server -> http://localhost:{PORT}")
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    else:
        raise SystemExit(f"Unknown mode: {mode!r} (use 'capture' or 'serve')")


if __name__ == "__main__":
    main()
