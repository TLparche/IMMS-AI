from __future__ import annotations

import ipaddress
import json
from typing import Iterable, Mapping


LOCALHOST_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
)


def _normalize_tokens(raw: str | None) -> list[str]:
    if not raw:
        return []

    value = raw.strip()
    if not value:
        return []

    if value.startswith("["):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = []
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]

    return [token.strip() for token in value.split(",") if token.strip()]


def parse_ip_whitelist(raw: str | None):
    networks = []
    for token in _normalize_tokens(raw):
        try:
            if "/" in token:
                networks.append(ipaddress.ip_network(token, strict=False))
            else:
                addr = ipaddress.ip_address(token)
                max_prefix = 32 if addr.version == 4 else 128
                networks.append(ipaddress.ip_network(f"{addr}/{max_prefix}", strict=False))
        except ValueError:
            continue
    return tuple(networks)


def extract_client_ip(headers: Mapping[str, str], client_host: str | None) -> str:
    for header_name in ("cf-connecting-ip", "x-forwarded-for", "x-real-ip"):
        value = headers.get(header_name)
        if not value:
            continue
        candidate = value.split(",")[0].strip()
        if candidate:
            return candidate
    return client_host or ""


def is_ip_allowed(client_ip: str, whitelist: Iterable) -> bool:
    if not client_ip:
        return False

    try:
        address = ipaddress.ip_address(client_ip)
    except ValueError:
        return False

    if any(address in network for network in LOCALHOST_NETWORKS):
        return True

    whitelist = tuple(whitelist)
    if not whitelist:
        return True

    return any(address in network for network in whitelist)
