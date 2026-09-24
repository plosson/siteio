import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError


SCRIPT = Path(__file__).parents[1] / "scripts" / "generate_atlas.py"
SPEC = importlib.util.spec_from_file_location("generate_atlas", SCRIPT)
atlas = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(atlas)


class FakeResponse:
    def __init__(self, body):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, req, timeout=None):
        self.requests.append((req, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(response)


class GenerateAtlasTests(unittest.TestCase):
    def test_generate_submits_once_and_does_not_leak_auth_to_download(self):
        opener = FakeOpener(
            [
                {"code": 200, "data": {"id": "prediction-1", "status": "starting"}},
                {"code": 200, "data": {"status": "processing"}},
                {
                    "code": 200,
                    "data": {
                        "status": "completed",
                        "outputs": ["https://cdn.example/logo.png"],
                    },
                },
                b"image-bytes",
            ]
        )
        sleeps = []
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output = root / ".skill-archive" / "logo.png"
            saved = atlas.generate(
                prompt="Minimal geometric logo",
                output=output,
                api_key="secret-key",
                workspace=root,
                opener=opener,
                sleeper=sleeps.append,
            )
            self.assertEqual(saved.read_bytes(), b"image-bytes")

        requests = [item[0] for item in opener.requests]
        self.assertEqual([req.get_method() for req in requests].count("POST"), 1)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer secret-key")
        self.assertEqual(requests[-1].full_url, "https://cdn.example/logo.png")
        self.assertIsNone(requests[-1].get_header("Authorization"))
        self.assertEqual(sleeps, [3.0])

    def test_submission_error_is_not_retried(self):
        error = HTTPError("https://example", 402, "payment required", {}, None)
        opener = FakeOpener([error])
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaises(HTTPError):
                atlas.generate(
                    prompt="Logo",
                    output=root / "logo.png",
                    api_key="secret-key",
                    workspace=root,
                    opener=opener,
                )
        self.assertEqual(len(opener.requests), 1)

    def test_polling_is_bounded(self):
        opener = FakeOpener(
            [
                {"data": {"id": "prediction-1"}},
                {"data": {"status": "processing"}},
                {"data": {"status": "processing"}},
            ]
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaisesRegex(atlas.AtlasError, "after 2 checks"):
                atlas.generate(
                    prompt="Logo",
                    output=root / "logo.png",
                    api_key="secret-key",
                    workspace=root,
                    opener=opener,
                    poll_attempts=2,
                    poll_interval=0,
                )
        self.assertEqual(len(opener.requests), 3)

    def test_output_must_stay_inside_workspace(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaisesRegex(ValueError, "inside the current workspace"):
                atlas.generate(
                    prompt="Logo",
                    output=root.parent / "outside.png",
                    api_key="secret-key",
                    workspace=root,
                    opener=FakeOpener([]),
                )

    def test_existing_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output = root / "logo.png"
            output.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                atlas.generate(
                    prompt="Logo",
                    output=output,
                    api_key="secret-key",
                    workspace=root,
                    opener=FakeOpener([]),
                )
            self.assertEqual(output.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
