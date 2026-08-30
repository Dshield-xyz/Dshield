import unittest
from pathlib import Path

from asp_sync.sync import FeedError, extract_addresses, fetch_feed, merkle_root, rotate_root


FIXTURE = Path(__file__).with_name("fixtures") / "sdn_enhanced.xml"


class SyncTests(unittest.TestCase):
    def test_fixture_feed_matches_contract_root(self):
        addresses = extract_addresses(FIXTURE.read_bytes())
        self.assertEqual(addresses, ["0xabc123", "bc1qexample"])
        self.assertEqual(
            merkle_root(addresses).hex(),
            "81c90c0b416905dadad32c31f02eeef7e74a6384858f28c8efd48a704ad0d748",
        )

    def test_malformed_feed_fails_safe(self):
        with self.assertRaises(FeedError):
            extract_addresses(b"<sdnList>")

    def test_feed_without_digital_currency_entries_fails_safe(self):
        with self.assertRaises(FeedError):
            extract_addresses(b"<sdnList><ID_Number ID_Type='Passport'>123</ID_Number></sdnList>")

    def test_unavailable_feed_fails_safe_without_runner(self):
        def unavailable(*args, **kwargs):
            raise OSError("offline")

        with self.assertRaises(FeedError):
            fetch_feed("https://example.invalid/feed.xml", unavailable)

        called = False

        def never_run(*args, **kwargs):
            nonlocal called
            called = True

        with self.assertRaises(FeedError):
            extract_addresses(b"not xml")
        with self.assertRaises(FeedError):
            rotate_root(bytes(32), {"COMPLIANCE_CONTRACT_ID": "CA..."}, never_run)
        self.assertFalse(called)


if __name__ == "__main__":
    unittest.main()
