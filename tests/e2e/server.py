import http.server, sys, json
LOG = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type","text/html"); self._cors(); self.end_headers()
        self.wfile.write(f"<title>{self.path}</title>page {self.path}".encode())
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        with open(LOG, "a") as f: f.write(body + "\n")
        self.send_response(204); self._cors(); self.end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
