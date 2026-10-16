# ADR 0005 — Secret-store backends

Status: accepted
Date: 2026-10-16

## Issue

Spec §21.1 requires a DEK/KEK hierarchy with unattended OS-backed unlock
where available and passphrase fallback with `DEGRADED/secrets_locked`
otherwise. Floors: 16-byte salt, Argon2id `m=256MiB,t=3,p=4`, AES-256-GCM
or XChaCha20-Poly1305.

## Decision

- Linux with a machine key store: OS-backed KEK, unattended startup.
- Otherwise: Argon2id passphrase KEK, locked boot, local Node Manager
  unlock only. No plaintext key files, ever.
- Helper private keys live outside the secret store: root-owned `0700`
  file or kernel keyring on Linux, DPAPI-machine ACL on Windows.

## Consequences

- The support manifest records `secret_unlock_mode` per combination.
- While `LOCKED`, identity signing and session verification return
  `SECRETS_LOCKED`.
