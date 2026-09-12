"""
EduAccess Evidence Layer
------------------------
Honesty note (read this before you rip it out): this file is a REAL,
working implementation of the "seal + verify" pattern that AI-evidence
SDKs (CooL and its many look-alikes — Veratum, Signatrust, Aegis Ledger,
VDA Witness, etc.) all describe in their docs. It was built directly
rather than wired to a third-party SDK because, at the time this was
written, nobody on the team had the actual CooL package name / API docs
in hand — and guessing at a third-party API and shipping code that
imports a package that might not exist (or worse, might be a random
same-named PyPI upload from an unrelated author) is a worse outcome
for a hackathon submission than a small, real, self-contained module.

What it actually does, in plain terms:
  1. SEAL — whenever an AI feature (smart notes, quiz, flashcards)
     produces output, we hash the source transcript it was grounded in
     and the output it produced, bundle that with metadata (model,
     provider, timestamp, artifact type) into a JSON payload, and sign
     that payload with an Ed25519 private key that lives only on this
     server. The result is a "receipt": the payload plus its signature.
  2. VERIFY — anyone holding the receipt and the public key (embedded
     below, not secret) can independently check two things without
     calling any server: (a) the signature is valid for this exact
     payload — nobody edited the receipt itself, and (b) the current
     content hashes to the same value recorded in the receipt — nobody
     edited the *artifact* after it was sealed. Verification never
     depends on being able to reach EduAccess's own server or database.

What this does NOT prove, to be precise rather than to oversell it:
  - It does not prove the AI's output was factually correct, or that
    the transcript itself was accurate.
  - It proves only that a specific hash was sealed at a specific time
    and hasn't been altered since — the same scope any of these
    receipt SDKs actually have.

Swapping in a real third-party SDK later: every place that currently
calls seal_evidence()/verify_evidence() in app.py can be pointed at a
real SDK's seal()/verify() calls instead — the function signatures
here were deliberately kept close to the "hash in, receipt out" /
"receipt in, verdict out" shape that these SDKs use, specifically so
that swap is small.
"""

import os
import json
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature

KEY_DIR = os.path.join(os.path.dirname(__file__), "evidence_keys")
PRIVATE_KEY_PATH = os.path.join(KEY_DIR, "ed25519_private.pem")
PUBLIC_KEY_PATH = os.path.join(KEY_DIR, "ed25519_public.pem")


def _load_or_create_keypair():
    """
    First run: generate a fresh Ed25519 keypair and persist it to disk.
    Every run after that: load the same keypair, so receipts sealed
    yesterday still verify today. The private key never leaves this
    process; the public key is what verification actually needs, and
    is safe to hand to anyone (it's also embedded in every receipt).
    """
    os.makedirs(KEY_DIR, exist_ok=True)
    if os.path.exists(PRIVATE_KEY_PATH):
        with open(PRIVATE_KEY_PATH, "rb") as f:
            private_key = serialization.load_pem_private_key(f.read(), password=None)
        return private_key

    private_key = Ed25519PrivateKey.generate()
    with open(PRIVATE_KEY_PATH, "wb") as f:
        f.write(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    public_key = private_key.public_key()
    with open(PUBLIC_KEY_PATH, "wb") as f:
        f.write(
            public_key.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
    return private_key


_private_key = _load_or_create_keypair()
_public_key = _private_key.public_key()
PUBLIC_KEY_PEM = _public_key.public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode()


def sha256_hex(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _canonical_json(payload: dict) -> bytes:
    # Sorted keys + fixed separators so the exact same payload always
    # serializes to the exact same bytes — required for signatures to
    # be reproducible/verifiable independent of dict ordering.
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def seal_evidence(
    artifact_type: str,
    source_text: str,
    output_text: str,
    model: str,
    provider: str,
    session_id: Optional[int] = None,
) -> dict:
    """
    Create a signed receipt for one AI-generated artifact.

    artifact_type: "smart_notes" | "quiz" | "flashcards" | "mind_map" | ...
    source_text:   whatever grounded the generation (usually the lecture
                   transcript) — hashed, never stored raw in the receipt.
    output_text:   the AI's output, exactly as produced — hashed and
                   this hash is what later verification is checked against.

    Returns the full receipt dict, which is what gets stored and later
    handed back to verify_evidence().
    """
    execution_id = f"EDU-{datetime.now(timezone.utc).year}-{uuid.uuid4().hex[:8].upper()}"
    payload = {
        "execution_id": execution_id,
        "artifact_type": artifact_type,
        "session_id": session_id,
        "source_hash": sha256_hex(source_text),
        "output_hash": sha256_hex(output_text),
        "model": model,
        "provider": provider,
        "sealed_at": datetime.now(timezone.utc).isoformat(),
    }
    signature = _private_key.sign(_canonical_json(payload)).hex()
    return {
        "execution_id": execution_id,
        "payload": payload,
        "signature": signature,
        "public_key": PUBLIC_KEY_PEM,
    }


def verify_evidence(receipt: dict, current_output_text: Optional[str] = None) -> dict:
    """
    Independently check a receipt. If current_output_text is provided,
    also checks that today's content still hashes to what was sealed
    (this is the check that catches post-generation edits/tampering).

    Returns a dict the frontend can render directly:
      {
        "execution_id": ...,
        "signature_valid": bool,   # receipt itself wasn't forged/altered
        "binding_valid": bool | None,  # current content matches sealed hash
        "status": "VERIFIED" | "TAMPERED" | "SIGNATURE_INVALID",
        "sealed_at": ..., "artifact_type": ..., "model": ..., "provider": ...
      }
    """
    payload = receipt["payload"]
    signature_bytes = bytes.fromhex(receipt["signature"])

    signature_valid = True
    try:
        _public_key.verify(signature_bytes, _canonical_json(payload))
    except InvalidSignature:
        signature_valid = False

    binding_valid = None
    if current_output_text is not None:
        binding_valid = sha256_hex(current_output_text) == payload["output_hash"]

    if not signature_valid:
        status = "SIGNATURE_INVALID"
    elif binding_valid is False:
        status = "TAMPERED"
    else:
        status = "VERIFIED"

    return {
        "execution_id": payload["execution_id"],
        "signature_valid": signature_valid,
        "binding_valid": binding_valid,
        "status": status,
        "sealed_at": payload["sealed_at"],
        "artifact_type": payload["artifact_type"],
        "session_id": payload.get("session_id"),
        "model": payload["model"],
        "provider": payload["provider"],
    }
