from __future__ import annotations

import json
import os
import re
import ast
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None


ROOT = Path(__file__).resolve().parent
if load_dotenv is not None:
    load_dotenv(ROOT / ".env", override=False)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _extract_json(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass

    l = raw.find("{")
    r = raw.rfind("}")
    if l >= 0 and r > l:
        try:
            parsed = json.loads(raw[l : r + 1])
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _extract_json_loose(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}

    l = raw.find("{")
    r = raw.rfind("}")
    if l >= 0 and r > l:
        raw = raw[l : r + 1]

    raw = raw.replace("\u0000", "")
    raw = re.sub(r",\s*([}\]])", r"\1", raw)
    raw = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)

    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass

    try:
        parsed = ast.literal_eval(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _extract_balanced_json(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}
    start = raw.find("{")
    if start < 0:
        return {}

    depth = 0
    in_str = False
    escape = False
    quote = ""
    end = -1

    for idx, ch in enumerate(raw[start:], start=start):
        if in_str:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == quote:
                in_str = False
            continue

        if ch in {'"', "'"}:
            in_str = True
            quote = ch
            continue
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                end = idx
                break

    if end <= start:
        return {}

    chunk = raw[start : end + 1]
    parsed = _extract_json(chunk)
    if parsed:
        return parsed
    return _extract_json_loose(chunk)


def _append_continuation(prefix: str, continuation: str) -> str:
    base = prefix or ""
    suffix = continuation or ""
    if not suffix:
        return base
    max_overlap = min(len(base), len(suffix), 2000)
    for overlap in range(max_overlap, 0, -1):
        if base.endswith(suffix[:overlap]):
            return base + suffix[overlap:]
    return base + suffix


@dataclass
class GeminiClient:
    model: str
    api_key: str
    base_url: str
    connected: bool = False
    request_count: int = 0
    success_count: int = 0
    error_count: int = 0
    last_operation: str = ""
    last_request_at: str = ""
    last_success_at: str = ""
    last_error: str = ""
    last_error_at: str = ""
    last_raw_preview: str = ""
    last_finish_reason: str = ""
    last_http_status: int = 0

    def status(self) -> dict[str, Any]:
        return {
            "provider": "gemini",
            "model": self.model,
            "base_url": self.base_url,
            "mode": "live",
            "api_key_present": bool(self.api_key),
            "connected": self.connected,
            "note": "Gemini REST API",
            "request_count": self.request_count,
            "success_count": self.success_count,
            "error_count": self.error_count,
            "last_operation": self.last_operation,
            "last_request_at": self.last_request_at,
            "last_success_at": self.last_success_at,
            "last_error": self.last_error,
            "last_error_at": self.last_error_at,
            "last_raw_preview": self.last_raw_preview,
            "last_finish_reason": self.last_finish_reason,
            "last_http_status": self.last_http_status,
        }

    def _call(self, prompt: str, temperature: float = 0.2, max_tokens: int = 1024) -> str:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY 또는 GOOGLE_API_KEY가 설정되지 않았습니다.")

        self.request_count += 1
        self.last_request_at = _now_iso()
        self.last_operation = "generate_content"

        timeout_sec = max(20, int(os.environ.get("GEMINI_TIMEOUT_SEC", "60")))
        max_retries = max(1, int(os.environ.get("GEMINI_MAX_RETRIES", "4")))
        retry_base = max(0.2, float(os.environ.get("GEMINI_RETRY_BASE_SEC", "1.0")))
        fallback_models = [
            m.strip()
            for m in os.environ.get("GEMINI_FALLBACK_MODELS", "gemini-2.0-flash-lite,gemini-1.5-flash").split(",")
            if m.strip()
        ]
        model_candidates = [self.model] + [m for m in fallback_models if m != self.model]

        last_error_msg = "알 수 없는 오류"
        last_status = 0
        data: dict[str, Any] | None = None

        for model_name in model_candidates:
            for attempt in range(1, max_retries + 1):
                data = None
                url = f"{self.base_url}/models/{model_name}:generateContent?key={urllib.parse.quote(self.api_key)}"
                payload = {
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": temperature,
                        "maxOutputTokens": max_tokens,
                        "responseMimeType": "application/json",
                    },
                }
                body = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(url, data=body, method="POST")
                req.add_header("Content-Type", "application/json")

                try:
                    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    # fallback 모델이 성공하면 이후 기본 모델로 승격
                    if model_name != self.model:
                        self.model = model_name
                    self.last_http_status = 200
                    break
                except urllib.error.HTTPError as exc:
                    detail = exc.read().decode("utf-8", errors="ignore")
                    status = int(getattr(exc, "code", 0) or 0)
                    last_status = status
                    retryable = status in {429, 500, 502, 503, 504} or "UNAVAILABLE" in detail or "RESOURCE_EXHAUSTED" in detail
                    last_error_msg = f"HTTP {status}: {detail[:500]}"

                    if retryable and attempt < max_retries:
                        sleep_sec = retry_base * (2 ** (attempt - 1)) + random.uniform(0.0, 0.35)
                        self.last_error = f"{last_error_msg} (재시도 {attempt}/{max_retries}, {sleep_sec:.1f}s 대기)"
                        self.last_error_at = _now_iso()
                        time.sleep(sleep_sec)
                        continue
                    # 재시도 불가 에러는 현재 모델 시도 중단
                    break
                except Exception as exc:
                    last_error_msg = str(exc)
                    status = 0
                    last_status = status
                    if attempt < max_retries:
                        sleep_sec = retry_base * (2 ** (attempt - 1)) + random.uniform(0.0, 0.35)
                        self.last_error = f"{last_error_msg} (재시도 {attempt}/{max_retries}, {sleep_sec:.1f}s 대기)"
                        self.last_error_at = _now_iso()
                        time.sleep(sleep_sec)
                        continue
                    break

            if data is not None:
                break

        if data is None:
            self.error_count += 1
            self.last_error = last_error_msg
            self.last_error_at = _now_iso()
            self.last_http_status = last_status
            raise RuntimeError(self.last_error)

        text = ""
        finish_reason = ""
        try:
            candidates = data.get("candidates") or []
            if candidates:
                finish_reason = str((candidates[0] or {}).get("finishReason") or "")
                parts = (((candidates[0] or {}).get("content") or {}).get("parts") or [])
                if parts:
                    text = str((parts[0] or {}).get("text") or "")
        except Exception:
            text = ""

        if not text:
            self.error_count += 1
            self.last_error = "Gemini 응답 본문이 비어 있습니다."
            self.last_error_at = _now_iso()
            raise RuntimeError(self.last_error)

        self.success_count += 1
        self.last_success_at = _now_iso()
        self.last_error = ""
        self.last_error_at = ""
        self.last_raw_preview = (text or "")[:1000]
        self.last_finish_reason = finish_reason
        return text

    def ping(self) -> dict[str, Any]:
        try:
            raw = self._call(
                "JSON만 반환하세요: {\"ok\": true, \"message\": \"pong\"}",
                temperature=0.0,
                max_tokens=64,
            )
            parsed = _extract_json(raw)
            ok = bool(parsed.get("ok", False))
            msg = str(parsed.get("message", "pong"))
            return {"ok": ok, "message": msg, "mode": "live", "response_preview": parsed}
        except Exception as exc:
            return {"ok": False, "message": str(exc), "mode": "live"}

    def connect(self) -> dict[str, Any]:
        if not self.api_key:
            self.connected = False
            return {"ok": False, "message": "API 키가 없어 연결할 수 없습니다.", "mode": "live"}
        result = self.ping()
        self.connected = bool(result.get("ok"))
        return result

    def disconnect(self) -> dict[str, Any]:
        self.connected = False
        self.last_operation = "disconnect"
        return {"ok": True, "message": "연결 해제됨", "mode": "live"}

    def generate_json(self, prompt: str, temperature: float = 0.2, max_tokens: int = 1400) -> dict[str, Any]:
        if not self.connected:
            raise RuntimeError("LLM이 연결되지 않았습니다. 먼저 연결 버튼을 눌러주세요.")

        def parse_json(raw_text: str) -> dict[str, Any]:
            parsed_json = _extract_json(raw_text)
            if not parsed_json:
                parsed_json = _extract_json_loose(raw_text)
            if not parsed_json:
                parsed_json = _extract_balanced_json(raw_text)
            return parsed_json

        def continue_truncated_json(partial_text: str, source_prompt: str, base_max_tokens: int) -> tuple[dict[str, Any], str]:
            merged = partial_text or ""
            continuation_attempts = max(0, int(os.environ.get("GEMINI_JSON_CONTINUATION_ATTEMPTS", "2")))
            if continuation_attempts <= 0 or not merged:
                return {}, merged

            continuation_limit = int(os.environ.get("GEMINI_JSON_CONTINUATION_MAX_OUTPUT_TOKENS", "4096"))
            continuation_max_tokens = min(max(base_max_tokens, 2048), max(512, continuation_limit))
            prompt_chars = max(1200, int(os.environ.get("GEMINI_JSON_CONTINUATION_PROMPT_CHARS", "8000")))
            tail_chars = max(400, int(os.environ.get("GEMINI_JSON_CONTINUATION_TAIL_CHARS", "1800")))
            prompt_excerpt = source_prompt[:prompt_chars]

            for attempt in range(1, continuation_attempts + 1):
                tail = merged[-tail_chars:]
                continuation_prompt = (
                    "이전 LLM 응답이 MAX_TOKENS 때문에 유효한 JSON 중간에서 잘렸다.\n"
                    "원래 요청과 이미 생성된 JSON 마지막 부분을 보고, 이미 출력된 문자 바로 다음에 이어질 텍스트만 반환한다.\n\n"
                    "[반환 형식]\n"
                    '{"continuation":"이미 출력된 문자 뒤에 붙일 JSON 텍스트", "done": true}\n\n'
                    "[규칙]\n"
                    "- continuation에는 붙일 원문 텍스트만 넣는다.\n"
                    "- 이미 생성된 tail을 반복하지 않는다.\n"
                    "- JSON 전체를 처음부터 다시 쓰지 않는다.\n"
                    "- continuation을 붙였을 때 전체 응답이 유효한 JSON 객체가 되게 한다.\n"
                    "- 설명, 마크다운, 코드펜스는 쓰지 않는다.\n\n"
                    f"[시도]\n{attempt}/{continuation_attempts}\n\n"
                    f"[원래 요청 앞부분]\n{prompt_excerpt}\n\n"
                    f"[이미 생성된 JSON 길이]\n{len(merged)}\n\n"
                    f"[이미 생성된 JSON 마지막 부분]\n{tail}"
                )
                continuation_raw = self._call(
                    continuation_prompt,
                    temperature=0.0,
                    max_tokens=continuation_max_tokens,
                )
                finish_reasons.append(self.last_finish_reason or "")
                continuation_payload = parse_json(continuation_raw)
                continuation_text = ""
                if continuation_payload:
                    continuation_text = str(
                        continuation_payload.get("continuation")
                        or continuation_payload.get("text")
                        or continuation_payload.get("delta")
                        or ""
                    )
                if not continuation_text:
                    break

                merged = _append_continuation(merged, continuation_text)
                parsed_json = parse_json(merged)
                if parsed_json:
                    return parsed_json, merged

                done = bool(continuation_payload.get("done", True)) if continuation_payload else True
                if done and (self.last_finish_reason or "").upper() != "MAX_TOKENS":
                    break

            return {}, merged

        finish_reasons: list[str] = []

        raw = self._call(prompt, temperature=temperature, max_tokens=max_tokens)
        finish_reasons.append(self.last_finish_reason or "")
        parsed = parse_json(raw)
        if parsed:
            return parsed

        if (self.last_finish_reason or "").upper() == "MAX_TOKENS":
            parsed, raw = continue_truncated_json(raw, prompt, max_tokens)
            if parsed:
                return parsed

        repair_input = (raw or "")[:12000]
        repair_prompt = (
            "다음 텍스트를 유효한 JSON 객체 하나로만 정규화해서 반환하세요. "
            "설명/마크다운/코드펜스 없이 JSON만 출력하세요.\n\n"
            f"{repair_input}"
        )
        repair_raw = self._call(repair_prompt, temperature=0.0, max_tokens=max_tokens)
        finish_reasons.append(self.last_finish_reason or "")
        parsed = parse_json(repair_raw)
        if parsed:
            return parsed

        # 마지막 재시도: 원 프롬프트를 더 강한 JSON 제약으로 재호출
        strict_prompt = (
            "반드시 유효한 JSON 객체 하나만 반환하세요. "
            "설명/주석/코드펜스/추가 텍스트 금지.\n\n"
            + prompt
        )
        strict_raw = self._call(strict_prompt, temperature=0.0, max_tokens=max_tokens)
        finish_reasons.append(self.last_finish_reason or "")
        parsed = parse_json(strict_raw)
        if parsed:
            return parsed

        if (self.last_finish_reason or "").upper() == "MAX_TOKENS":
            parsed, strict_raw = continue_truncated_json(strict_raw, strict_prompt, max_tokens)
            if parsed:
                return parsed

        if any(reason.upper() == "MAX_TOKENS" for reason in finish_reasons):
            retry_limit = int(os.environ.get("GEMINI_JSON_RETRY_MAX_OUTPUT_TOKENS", "8192"))
            retry_max_tokens = min(max(max_tokens * 3, max_tokens + 1200), retry_limit)
            if retry_max_tokens > max_tokens:
                compact_strict_prompt = (
                    "반드시 유효한 JSON 객체 하나만 반환하세요. "
                    "설명/주석/코드펜스/추가 텍스트 금지. "
                    "가능한 한 간결하게 출력하고, 배열 항목은 요청된 최대 개수를 넘기지 마세요.\n\n"
                    + prompt
                )
                retry_raw = self._call(compact_strict_prompt, temperature=0.0, max_tokens=retry_max_tokens)
                finish_reasons.append(self.last_finish_reason or "")
                parsed = parse_json(retry_raw)
                if parsed:
                    return parsed
                if (self.last_finish_reason or "").upper() == "MAX_TOKENS":
                    parsed, _retry_merged = continue_truncated_json(
                        retry_raw,
                        compact_strict_prompt,
                        retry_max_tokens,
                    )
                    if parsed:
                        return parsed

        if not parsed:
            finish_reason = next((reason for reason in reversed(finish_reasons) if reason), "-")
            raise RuntimeError(f"LLM JSON 파싱 실패 (finish_reason={finish_reason})")
        return parsed


_LOCK = threading.Lock()
_CLIENT: GeminiClient | None = None


def get_client() -> GeminiClient:
    global _CLIENT
    with _LOCK:
        if _CLIENT is None:
            api_key = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
            model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
            base_url = os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
            _CLIENT = GeminiClient(model=model, api_key=api_key, base_url=base_url)
        return _CLIENT
