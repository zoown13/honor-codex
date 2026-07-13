#!/usr/bin/env python3
"""Serve a Next.js static export while preserving an HTTP 404 at the root."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class PilotHandler(SimpleHTTPRequestHandler):
    def _root_404(self, include_body: bool) -> None:
        file_path = Path(self.directory) / "index.html"
        body = file_path.read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path in {"/", "/index.html"}:
            self._root_404(True)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if urlsplit(self.path).path in {"/", "/index.html"}:
            self._root_404(False)
            return
        super().do_HEAD()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="apps/web/out")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    handler = partial(PilotHandler, directory=args.directory)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
