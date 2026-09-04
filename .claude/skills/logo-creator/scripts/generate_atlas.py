#!/usr/bin/env python3
"""Generate one logo image with the optional Atlas Cloud backend."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib import request
from urllib.parse import quote, urlparse


API_BASE = "https://api.atlascloud.ai/api/v1/model"
DEFAULT_MODEL = "openai/gpt-image-2/text-to-image"
ALLOWED_QUALITIES = ("low", "medium", "high")
ALLOWED_FORMATS = ("jpeg", "png")
ALLOWED_SIZES = (
    "1024x1024",
    "1024x768",
    "768x1024",
    "1024x1536",
    "1536x1024",
    "2048x2048",
    "2048x1152",
    "1152x2048",
    "2560x1088",
    "1088x2560",
    "2880x2160",
    "2160x2880",
    "3840x2160",
    "2160x3840",
)


class AtlasError(RuntimeError):
    """Raised when Atlas returns an invalid or failed prediction."""


def _json_body(response: Any) -> dict[str, Any]:
    raw = response.read()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AtlasError("Atlas returned a non-JSON response") from exc
    if not isinstance(payload, dict):
        raise AtlasError("Atlas returned an unexpected JSON response")
    return payload


def _data(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("data", payload)
    if not isinstance(value, dict):
        raise AtlasError("Atlas response is missing an object data field")
    return value


def _api_request(
    opener: Any,
    url: str,
    api_key: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    timeout: float,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {api_key}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=body, headers=headers, method=method)
    with opener.open(req, timeout=timeout) as response:
        return _json_body(response)


def _prediction_id(payload: dict[str, Any]) -> str:
    data = _data(payload)
    prediction_id = data.get("id") or data.get("prediction_id")
    if not isinstance(prediction_id, str) or not prediction_id:
        raise AtlasError("Atlas submission did not return a prediction ID")
    return prediction_id


def _output_url(payload: dict[str, Any]) -> str:
    data = _data(payload)
    outputs = data.get("outputs")
    if isinstance(outputs, list) and outputs and isinstance(outputs[0], str):
        return outputs[0]
    for key in ("output_url", "output"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    raise AtlasError("Completed prediction did not return an output URL")


def _safe_output_path(output: Path, workspace: Path) -> Path:
    resolved_workspace = workspace.resolve()
    resolved_output = output.resolve()
    try:
        resolved_output.relative_to(resolved_workspace)
    except ValueError as exc:
        raise ValueError("output must stay inside the current workspace") from exc
    if resolved_output.exists():
        raise FileExistsError(f"refusing to overwrite existing file: {output}")
    return resolved_output


def generate(
    *,
    prompt: str,
    output: Path,
    api_key: str,
    model: str = DEFAULT_MODEL,
    size: str = "1024x1024",
    quality: str = "medium",
    output_format: str = "png",
    poll_attempts: int = 20,
    poll_interval: float = 3.0,
    timeout: float = 30.0,
    workspace: Path | None = None,
    opener: Any | None = None,
    sleeper: Callable[[float], None] = time.sleep,
) -> Path:
    """Submit exactly once, poll with bounded backoff, then download the result."""
    if not prompt.strip():
        raise ValueError("prompt must not be empty")
    if poll_attempts < 1 or poll_attempts > 100:
        raise ValueError("poll_attempts must be between 1 and 100")
    if poll_interval < 0:
        raise ValueError("poll_interval must not be negative")
    if size not in ALLOWED_SIZES:
        raise ValueError(f"unsupported size: {size}")
    if quality not in ALLOWED_QUALITIES:
        raise ValueError(f"unsupported quality: {quality}")
    if output_format not in ALLOWED_FORMATS:
        raise ValueError(f"unsupported output format: {output_format}")

    output_path = _safe_output_path(output, workspace or Path.cwd())
    client = opener or request.build_opener()
    submission = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "output_format": output_format,
    }

    # Generation POSTs are intentionally never retried.
    submitted = _api_request(
        client,
        f"{API_BASE}/generateImage",
        api_key,
        method="POST",
        payload=submission,
        timeout=timeout,
    )
    prediction_id = _prediction_id(submitted)

    result_url = None
    for attempt in range(poll_attempts):
        polled = _api_request(
            client,
            f"{API_BASE}/prediction/{quote(prediction_id, safe='')}",
            api_key,
            method="GET",
            timeout=timeout,
        )
        prediction = _data(polled)
        status = str(prediction.get("status", "")).lower()
        if status == "completed":
            result_url = _output_url(polled)
            break
        if status == "failed":
            detail = prediction.get("error") or prediction.get("message") or "unknown error"
            raise AtlasError(f"Atlas prediction failed: {detail}")
        if attempt + 1 < poll_attempts:
            sleeper(min(poll_interval * (2**attempt), 15.0))

    if result_url is None:
        raise AtlasError(f"prediction did not complete after {poll_attempts} checks")
    if urlparse(result_url).scheme not in {"http", "https"}:
        raise AtlasError("Atlas returned an unsupported output URL")

    # Signed result URLs must not receive the Atlas API credential.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    download = request.Request(result_url, method="GET")
    with client.open(download, timeout=timeout) as response:
        output_path.write_bytes(response.read())
    return output_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True, help="Logo generation prompt")
    parser.add_argument("--output", type=Path, required=True, help="Output image path")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--size", choices=ALLOWED_SIZES, default="1024x1024")
    parser.add_argument("--quality", choices=ALLOWED_QUALITIES, default="medium")
    parser.add_argument("--output-format", choices=ALLOWED_FORMATS, default="png")
    parser.add_argument("--poll-attempts", type=int, default=20)
    parser.add_argument("--poll-interval", type=float, default=3.0)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Submit the paid request; omitted by default for a request preview",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    request_preview = {
        "model": args.model,
        "prompt": args.prompt,
        "size": args.size,
        "quality": args.quality,
        "output_format": args.output_format,
    }
    if not args.execute:
        print(json.dumps(request_preview, indent=2))
        print("Preview only. Add --execute to submit one generation request.", file=sys.stderr)
        return 0

    api_key = os.environ.get("ATLASCLOUD_API_KEY")
    if not api_key:
        print("Error: ATLASCLOUD_API_KEY is required with --execute", file=sys.stderr)
        return 2
    try:
        saved = generate(
            prompt=args.prompt,
            output=args.output,
            api_key=api_key,
            model=args.model,
            size=args.size,
            quality=args.quality,
            output_format=args.output_format,
            poll_attempts=args.poll_attempts,
            poll_interval=args.poll_interval,
            timeout=args.timeout,
        )
    except (AtlasError, FileExistsError, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Saved Atlas output to {saved}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
