"""Solana JSON-RPC client tuned for X1 mainnet."""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import requests

log = logging.getLogger("rpc")

# Reset the underlying requests.Session() after this many consecutive failures.
# Prevents a wedged connection pool from silently killing the bot during
# upstream RPC outages — once the upstream recovers, the next call gets a
# fresh session and resumes working without a manual restart.
SESSION_RESET_AFTER = 10


class RPC:
    def __init__(self, url: str):
        self.url = url
        self.session = requests.Session()
        self._id = 0
        self._consecutive_failures = 0

    def _reset_session(self) -> None:
        try:
            self.session.close()
        except Exception:
            pass
        self.session = requests.Session()
        self._consecutive_failures = 0
        log.warning("RPC session reset after %d consecutive failures", SESSION_RESET_AFTER)

    def call(self, method: str, params: list, retries: int = 2) -> Any:
        self._id += 1
        payload = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}
        last_err = None
        for attempt in range(retries + 1):
            try:
                r = self.session.post(self.url, json=payload, timeout=15)
                r.raise_for_status()
                data = r.json()
                if "error" in data:
                    raise RuntimeError(f"RPC {method} error: {data['error']}")
                self._consecutive_failures = 0
                return data.get("result")
            except Exception as e:
                last_err = e
                self._consecutive_failures += 1
                if self._consecutive_failures >= SESSION_RESET_AFTER:
                    self._reset_session()
                if attempt < retries:
                    time.sleep(0.5 * (attempt + 1))
        raise last_err  # type: ignore

    def get_signatures_for_address(self, address: str, limit: int = 25) -> list:
        return self.call("getSignaturesForAddress", [address, {"limit": limit}]) or []

    def get_transaction(self, signature: str) -> Optional[dict]:
        return self.call(
            "getTransaction",
            [signature, {"encoding": "jsonParsed",
                         "maxSupportedTransactionVersion": 0,
                         "commitment": "confirmed"}],
        )

    def get_token_account_balance(self, account: str) -> Optional[dict]:
        try:
            return self.call("getTokenAccountBalance", [account])
        except Exception:
            return None

    def get_token_supply(self, mint: str) -> Optional[dict]:
        try:
            return self.call("getTokenSupply", [mint])
        except Exception:
            return None
