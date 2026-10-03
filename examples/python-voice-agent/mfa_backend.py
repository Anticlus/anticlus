"""A stand-in for the MFA system a company already runs.

It receives the gateway's signed challenge, "asks" the supplier's contact on
file (here: a rule, --approve or --refuse), and posts the signed answer back.
Only the signature is trusted; no bearer key exists on this side.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from anticlus import InvalidSignature, MfaClient

GATEWAY = "http://127.0.0.1:8787"
SECRET = "demo-mfa-secret"
APPROVE = "--refuse" not in sys.argv
mfa = MfaClient(GATEWAY, SECRET)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("content-length", "0"))).decode()
        try:
            challenge = mfa.verify_webhook(raw, self.headers.get("anticlus-signature"))
        except InvalidSignature as e:
            self.send_response(401); self.end_headers(); print(f"mfa      refused an unsigned challenge ({e.reason})"); return
        print(f"mfa      challenge for {challenge.action}: confirm with the contact on file ({challenge.target})")
        print("mfa      " + ("the contact on file approved" if APPROVE else "the contact on file says: we never asked for this"))
        mfa.answer(challenge.id, passed=APPROVE, method="app")
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"accepted": True}).encode())

    def log_message(self, *_: object) -> None:  # quiet
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8788), Handler).serve_forever()
