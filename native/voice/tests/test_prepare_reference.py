"""The rights gate in front of voice cloning: what it refuses and what it records."""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from miss_voice import prepare_reference as prep

STATEMENT = "set up given voice and build character motherfucker, legal and ethics i handle with permission"


def parse_quietly(argv: list[str]):
    with contextlib.redirect_stderr(io.StringIO()):
        return prep.parse_args(argv)


class RightsGateTest(unittest.TestCase):
    def test_owner_attested_without_statement_is_refused(self):
        for argv in (["--rights", "owner-attested"], ["--rights", "owner-attested", "--statement", "   "]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit) as caught:
                parse_quietly(argv)
            self.assertEqual(caught.exception.code, 2)

    def test_rights_basis_is_required_and_closed(self):
        for argv in ([], ["--rights", "fan-made"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                parse_quietly(argv)

    def test_owner_attested_with_statement_is_accepted_verbatim(self):
        args = parse_quietly(["--rights", "owner-attested", "--statement", STATEMENT, "--statement-date", "2026-10-31"])
        self.assertEqual(args.rights, "owner-attested")
        self.assertEqual(args.statement, STATEMENT)
        self.assertEqual(args.statement_date, "2026-10-31")

    def test_bad_statement_date_is_refused(self):
        with self.assertRaises(SystemExit):
            parse_quietly(["--rights", "owner-attested", "--statement", STATEMENT, "--statement-date", "31/10/2026"])

    def test_stronger_bases_need_no_statement(self):
        for basis in ("own-voice", "licensed", "written-permission"):
            with self.subTest(basis=basis):
                self.assertIsNone(parse_quietly(["--rights", basis]).statement)

    def test_record_builder_refuses_owner_attested_without_statement(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "clip.webm"
            source.write_bytes(b"clip")
            with self.assertRaises(ValueError):
                prep.build_rights_record("owner-attested", None, source)
            with self.assertRaises(ValueError):
                prep.build_rights_record("borrowed", STATEMENT, source)


class RightsRecordTest(unittest.TestCase):
    def test_rights_record_round_trips(self):
        statement = STATEMENT + ' (quoted: "yes", café, 100%)'
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "videoplayback.webm"
            reference = Path(tmp) / "reference.wav"
            source.write_bytes(b"source bytes" * 100)
            reference.write_bytes(b"reference bytes")
            when = dt.datetime(2026, 10, 31, 13, 5, 12, tzinfo=dt.timezone(dt.timedelta(hours=5, minutes=30)))
            record = prep.build_rights_record("owner-attested", statement, source, statement_date="2026-10-31",
                                              reference=reference, now=when)
            target = Path(tmp) / "reference" / "rights.json"
            prep.write_rights_record(target, record)

            loaded = prep.read_rights_record(target)
            self.assertEqual(loaded, record)
            self.assertEqual(loaded["statement"], statement)
            self.assertEqual(loaded["basis"], "owner-attested")
            self.assertEqual(loaded["recorded_at"], "2026-10-31T13:05:12+05:30")
            self.assertIsNotNone(dt.datetime.fromisoformat(loaded["recorded_at"]).tzinfo)
            self.assertEqual(loaded["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(loaded["reference_sha256"], hashlib.sha256(reference.read_bytes()).hexdigest())
            self.assertFalse(target.with_name("rights.json.tmp").exists())
            # Stored as readable UTF-8, so the owner's words can be checked by eye.
            self.assertIn("café", target.read_text(encoding="utf-8"))

    def test_default_timestamp_carries_an_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "clip.webm"
            source.write_bytes(b"clip")
            record = prep.build_rights_record("own-voice", None, source)
            self.assertIsNotNone(dt.datetime.fromisoformat(record["recorded_at"]).tzinfo)
            self.assertIsNone(record["reference"])

    def test_unreadable_or_foreign_records_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken.json"
            broken.write_text("{not json", encoding="utf-8")
            foreign = Path(tmp) / "foreign.json"
            foreign.write_text(json.dumps({"basis": "trust me"}), encoding="utf-8")
            self.assertIsNone(prep.read_rights_record(broken))
            self.assertIsNone(prep.read_rights_record(foreign))
            self.assertIsNone(prep.read_rights_record(Path(tmp) / "missing.json"))


if __name__ == "__main__":
    unittest.main()
