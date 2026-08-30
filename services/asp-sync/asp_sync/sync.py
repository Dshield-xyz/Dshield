"""OFAC SDN enhanced XML to ASP Merkle-root synchronizer."""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable, Iterable

DEFAULT_FEED_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ENHANCED.XML"
MAX_FEED_BYTES = 25 * 1024 * 1024
TIMEOUT_SECONDS = 30


class FeedError(ValueError):
    """Raised when the remote feed is unavailable or cannot be trusted."""


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def extract_addresses(xml_bytes: bytes) -> list[str]:
    """Extract and validate digital-currency addresses from enhanced SDN XML.

    Only ``Digital_Currency`` entries are included. Values are trimmed and
    case-folded because the on-chain format is defined over canonical text.
    """
    if not xml_bytes or len(xml_bytes) > MAX_FEED_BYTES:
        raise FeedError("feed is empty or exceeds the size limit")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise FeedError("feed is not valid XML") from exc

    addresses: set[str] = set()
    for node in root.iter():
        if _local_name(node.tag).lower() not in {"id", "id_number"}:
            continue
        id_type = (node.attrib.get("ID_Type") or node.attrib.get("idType") or "").strip().lower()
        if "digital" not in id_type and "crypto" not in id_type and "virtual" not in id_type:
            continue
        value = (node.text or "").strip().casefold()
        if not value or any(ch.isspace() for ch in value) or len(value) > 256:
            raise FeedError("feed contains an invalid digital-currency address")
        addresses.add(value)

    if not addresses:
        raise FeedError("feed contains no digital-currency addresses")
    return sorted(addresses)


def merkle_root(addresses: Iterable[str]) -> bytes:
    """Compute SHA-256(sorted canonical address leaves, duplicate-last tree)."""
    canonical = sorted({a.strip().casefold() for a in addresses if a.strip()})
    if not canonical:
        raise FeedError("cannot compute a root from an empty address set")
    level = [hashlib.sha256(value.encode("utf-8")).digest() for value in canonical]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [hashlib.sha256(level[i] + level[i + 1]).digest() for i in range(0, len(level), 2)]
    return level[0]


def fetch_feed(url: str = DEFAULT_FEED_URL, opener: Callable = urllib.request.urlopen) -> bytes:
    try:
        with opener(url, timeout=TIMEOUT_SECONDS) as response:
            data = response.read(MAX_FEED_BYTES + 1)
    except Exception as exc:  # network and HTTP errors must fail closed
        raise FeedError(f"unable to fetch feed: {exc}") from exc
    if len(data) > MAX_FEED_BYTES:
        raise FeedError("feed exceeds the size limit")
    return data


def rotate_root(root: bytes, env: dict[str, str] | None = None, runner: Callable = subprocess.run) -> str:
    """Submit the root through the Stellar CLI and return its output.

    The caller must provision the named source identity in the runner
    environment. No command is constructed until parsing/root computation has
    completed successfully.
    """
    if len(root) != 32 or root == bytes(32):
        raise FeedError("refusing to submit an invalid root")
    config = env or os.environ
    contract_id = config.get("COMPLIANCE_CONTRACT_ID")
    source = config.get("STELLAR_SOURCE", "asp-sync")
    network = config.get("STELLAR_NETWORK", "testnet")
    if not contract_id:
        raise FeedError("COMPLIANCE_CONTRACT_ID is required")
    command = [
        config.get("STELLAR_BIN", "stellar"), "contract", "invoke",
        "--id", contract_id, "--source", source, "--network", network,
        "--send=yes", "--", "rotate_asp_root", "--root", root.hex(),
    ]
    result = runner(command, check=True, capture_output=True, text=True, env=dict(config))
    return result.stdout


def run() -> int:
    feed = fetch_feed(os.environ.get("ASP_FEED_URL", DEFAULT_FEED_URL))
    addresses = extract_addresses(feed)
    root = merkle_root(addresses)
    expected = os.environ.get("EXPECTED_ASP_ROOT", "").lower().removeprefix("0x")
    if expected and expected != root.hex():
        raise FeedError("computed root does not match EXPECTED_ASP_ROOT")
    if os.environ.get("DRY_RUN", "").lower() in {"1", "true", "yes"}:
        print(root.hex())
        return 0
    output = rotate_root(root)
    print(output, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except FeedError as exc:
        print(f"asp-sync: {exc}", file=sys.stderr)
        raise SystemExit(1)
