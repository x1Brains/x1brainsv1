# brains_pairing deploy log

Append-only log of every brains_pairing deploy. New entries are added automatically by `scripts/deploy-brains-pairing.sh` after a successful deploy. Manual edits should only happen for retroactive backfill.

---

## 2026-04-09T06:30:00Z (manual backfill — v1.2)

- **Program:**     `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:**   `5qchJsYkYP8e8hVwbQmwe9PL7cDypAXMFHVketWC5eiRnCvatWeHPbZV7SfyX8sZtmb88ND8GDDyD3WzwH5borna`
- **Slot:**        42080045 (was 41952836)
- **Binary MD5:**  `1995bde1a1d7fc0aa2f0b5d317f7db3c`
- **Binary size:** 603368 bytes (was 564816)
- **Git:**         `main @ 9a0fc64`
- **Authority:**   `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
- **Notes:**       v1.2 deploy. Anchor 0.32.1 + Box wrappers + prepare/execute split. Used raw `solana program deploy` because local `target/deploy/brains_pairing-keypair.json` does not match the on-chain program ID (regenerated during the 0.31→0.32 upgrade, original lost). Verified post-deploy with `verify5.js` and `verify_state_compat.js` — all GlobalState fields intact. v1.1 instructions unchanged in account layout, frontend still functional.

## 2026-04-10T04:40:31Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `4B3huZM42EpvmgReqYMubvJxs7qFNJU6q3f5C3iyLMq34AVrnYmKw2VSDWHJaVdop18WH5t4taHcbLk3XvDu3YL7`
- **Slot:**      42193352 (was 42080045)
- **Binary MD5:** `92c373a12e3c682c309ce230a59b890c`
- **Binary size:** 603872 bytes (was 603368)
- **Git:**       `main @ 4c94286` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-10T05:58:03Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `4sNKaRJxV6ymxcFh86ba4FAhfUh5gan2rKE65uGJdDfUCDTEHMUF955vu6W7EaJK6DyhZ2ch1WRrYz1iRxYJi6SS`
- **Slot:**      42205017 (was 42193352)
- **Binary MD5:** `3a8124bdb34d6fd84d09d0b4f4bd6a81`
- **Binary size:** 603872 bytes (was 603872)
- **Git:**       `main @ 4928451` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
