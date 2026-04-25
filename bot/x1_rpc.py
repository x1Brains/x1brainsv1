"""Solana JSON-RPC client tuned for X1 mainnet."""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import requests

log = logging.getLogger("rpc")


class RPC:
    def __init__(self, url: str):
        self.url = url
        self.session = requests.Session()
        self._id = 0

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
                return data.get("result")
            except Exception as e:
                last_err = e
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
