"""Loopback-only development bridge for Windows installations without WSL port forwarding."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess


class Bridge(BaseHTTPRequestHandler):
    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        if not (self.path in ("/", "/client") or self.path.startswith("/api/platform/")):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 4096:
            self.send_error(413)
            return
        command = ["wsl", "-d", self.server.distro, "--", "curl", "--silent", "--show-error", "--include", "--max-time", "25", "--request", self.command]
        for key in ("Host", "Origin", "Content-Type", "Authorization"):
            if self.headers.get(key):
                command += ["--header", key + ": " + self.headers[key]]
        body = self.rfile.read(length) if length else None
        if body is not None:
            command += ["--data-binary", "@-"]
        command += ["--url", "http://127.0.0.1:" + str(self.server.upstream) + self.path]
        try:
            result = subprocess.run(command, input=body, capture_output=True, timeout=30)
            headers, data = result.stdout.split(b"\r\n\r\n", 1)
            lines = headers.decode("iso-8859-1").split("\r\n")
            self.send_response(int(lines[0].split()[1]))
            for line in lines[1:]:
                key, value = line.split(":", 1)
                if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(key, value.strip())
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            self.send_error(502, "Local WSL data console unavailable")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8190)
    parser.add_argument("--upstream", type=int, default=8090)
    parser.add_argument("--distro", default="Ubuntu-22.04")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Bridge)
    server.upstream, server.distro = args.upstream, args.distro
    print("Local preview http://127.0.0.1:" + str(args.port), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
