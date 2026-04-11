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

## 2026-04-10T06:13:07Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `5oM2ysH5wZsFXoqb4qN3Cn9hN9SYoRXFVvms5hTZ1in3rEJDXH87AK9DUbHquFz6Cj7EjpnQ6NQfok4oV3XndMss`
- **Slot:**      42207292 (was 42205017)
- **Binary MD5:** `eb5d34a7e5ae2074cd473ffe24ea5e32`
- **Binary size:** 610496 bytes (was 603872)
- **Git:**       `main @ 1ec619f` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-10T06:48:22Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `3v8vtW7QzXD7btSj35u9Yyv2Xm4fnQB6o969i3WoCofBaLdgeoMsLtQXskX156tH1XSGmBkT8GEStV62bWYvk5bW`
- **Slot:**      42212594 (was 42207292)
- **Binary MD5:** `6e0f8d6069b5b95399b201cdce967d72`
- **Binary size:** 611256 bytes (was 610496)
- **Git:**       `main @ d12469d` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-10T07:16:34Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `rKz2HRy84ZC7owXMTfMQ59bY9shx8bRFrBjJ8TtFAaG62WSwJPwRFUzBTVDYRcEFpVUApK2or7xTBw5zCT2MQK3`
- **Slot:**      42216835 (was 42212594)
- **Binary MD5:** `986afdf4a31333543207f219e803e45d`
- **Binary size:** 611992 bytes (was 611256)
- **Git:**       `main @ 1c9a6ad` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T01:41:04Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `qSMHHuHEQvLM1YQ1UJV2eMJVEQRfvpiWV5CwwQKggdjaK2RCeCwN6pnW68x4sDjmTv864q1P1VauHb4yV77YBfE`
- **Slot:**      42381452 (was 42216835)
- **Binary MD5:** `986afdf4a31333543207f219e803e45d`
- **Binary size:** 611992 bytes (was 611992)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T01:47:40Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `STPoFGQz9S16rNawvRvSHcyWQByAWYEoze3ZHgMD2mJmnDdEDTH5yyrhwcdss9LK84muvWe3zzc1wiN4CCmdYvd`
- **Slot:**      42382379 (was 42381452)
- **Binary MD5:** `986afdf4a31333543207f219e803e45d`
- **Binary size:** 611992 bytes (was 611992)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T02:03:47Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `3q2yj7rbxwQ2MHvDV2tw6r1j7S1BFujaSCRB3vSp5d1EdsvPJ6ZvBaeSVJVuyk6poJxLbyFYfUavbGfiKazGVqYL`
- **Slot:**      42384656 (was 42382379)
- **Binary MD5:** `986afdf4a31333543207f219e803e45d`
- **Binary size:** 611992 bytes (was 611992)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T02:22:17Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `2nHF69pn7gSLsj11diwu28ayApaeE3Bkqi8dwcL3RA8gUXzn3ggsoJC9b5SmBLv5qD3Bm3ujMkbZFyPPWY9uxuMM`
- **Slot:**      42387272 (was 42384656)
- **Binary MD5:** `9655f4845d8a4e22b64e1abbd23cfb0b`
- **Binary size:** 608728 bytes (was 611992)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T02:28:45Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `2aas9Lr2vJGTaVk2F6YTDopttikxnMa9cT5aX2qTitG6aSiGZL3RMmcRdGUyJ1aGKDt6LcdTt99ZKQtAtabbqJ9v`
- **Slot:**      42388192 (was 42387272)
- **Binary MD5:** `c42f5f79f35d28d32e506ad41698e847`
- **Binary size:** 615664 bytes (was 611992)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T02:36:30Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `KrS6NHmgKz1iZL5X9eFhFjnJX2YJJn8gCL6yJHzXPW5edayhMSpFE3SbNwAbFmLwwLbcqi8WCCze7Wm1XcryuCG`
- **Slot:**      42389297 (was 42388192)
- **Binary MD5:** `cc0c4672a5631ccf340802631f3a03ba`
- **Binary size:** 616576 bytes (was 615664)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T02:55:57Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `5Exd8qRdUsf7AtWEEKxVSmdbwKdKLBiZq4N55U8UhSGgCMZG6VWWj5FrJaZSGyk7x4k8J3wsjXJxokHTtdxEC8p5`
- **Slot:**      42392096 (was 42389297)
- **Binary MD5:** `1638428f5e3aaa442f310541803a1e74`
- **Binary size:** 620384 bytes (was 616576)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T03:03:32Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `5dSk6aMexnCvHn5jSEXnm4XoZ8g8BNvfndNaygg5snEUGfvvpU3XED2GvAdUDaLXk547Z1WaxTDWuNer93qzQ5XB`
- **Slot:**      42393169 (was 42392096)
- **Binary MD5:** `1f779f6ebbc07549a3991185e2f9c78a`
- **Binary size:** 619680 bytes (was 620384)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T04:42:58Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `2bZLtWaqaR6PtkJ6PkkSsmkKQoDyBA1wybJek1MTCXE1vGf8SbkRsbZQooNRdNjzYTwdDPUAvQ7U9hkUTRvzcCL1`
- **Slot:**      42407563 (was 42393169)
- **Binary MD5:** `f7bb52f4abc8d6e7488108d550163022`
- **Binary size:** 619240 bytes (was 620384)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`

## 2026-04-11T04:52:18Z

- **Program:**   `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Signature:** `3cXbZYbPwgmWQyrcY2dN1y4LKxUReAofACwGg8ASGEyPwa1XrQUjAJZJT3NJDMThhX5BjF1qHCoRJU4gpbRSPa2g`
- **Slot:**      42408986 (was 42407563)
- **Binary MD5:** `53873b7b2b6361a6815023d5b74ffb49`
- **Binary size:** 622832 bytes (was 620384)
- **Git:**       `main @ 2d2774e` (dirty: uncommitted changes)
- **Authority:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
