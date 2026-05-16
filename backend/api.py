from __future__ import annotations

import json
import math
import os
import platform
import queue
import re
import subprocess
import tempfile
import threading
import time
import wave
import importlib.util
import copy
import hashlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from supabase import Client, create_client

from llm_client import get_client
from security_utils import extract_client_ip, is_ip_allowed, parse_ip_whitelist

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)
load_dotenv(ROOT / "gateway" / ".env", override=False)
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "turbo")
PYANNOTE_DIARIZATION_MODEL = os.environ.get("PYANNOTE_DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1")
SUMMARY_INTERVAL = 4
SUMMARY_POINT_TARGET_LEN = None
REALTIME_MIN_SHIFT_SPAN = 6
LLM_IO_LOG_MAX = 160
LLM_IO_PREVIEW_MAX = 6000
CANVAS_OPERATION_LOG_MAX = 400
CANVAS_NODE_LINEAGE_MAX = 2000
CANVAS_TASK_RECORD_MAX = 800
CANVAS_TOPIC_SUMMARY_RETRY_DELAYS_SECONDS = (20, 60)
CANVAS_IDEA_FAILURE_RETRY_DELAY_SECONDS = 60
CANVAS_IDEA_COMPACTION_MIN_VISIBLE = 6
CANVAS_IDEA_COMPACTION_MAX_MERGES_PER_JOB = 4
CANVAS_TOPIC_CHILD_IDEA_MERGE_MIN_SCORE = 0.42
CANVAS_TOPIC_CHILD_IDEA_MERGE_MAX_MERGES_PER_JOB = 2
CANVAS_TOPIC_CLUSTER_MAX_PASSES_PER_JOB = 8
RUNTIME_SHARED_STATE_TABLE = "meeting_runtime_states"
RUNTIME_USER_STATE_TABLE = "meeting_user_states"
IP_WHITELIST = parse_ip_whitelist(os.environ.get("IP_WHITELIST"))
AUDIO_IMPORT_ALLOWED_SUFFIXES = {".wav", ".mp3", ".m4a", ".webm"}

_SUPABASE_CLIENT: Client | None = None
_SUPABASE_CLIENT_INITIALIZED = False
_SUPABASE_CLIENT_LOCK = threading.Lock()
_SUPABASE_REQUEST_LOCK = threading.Lock()
_RUNTIME_DB_DISABLED_TABLES: set[str] = set()
_RUNTIME_DB_LOGGED_ERRORS: dict[str, float] = {}
_RUNTIME_DB_STATE_LOCK = threading.Lock()

STOPWORDS = {
    "그냥",
    "이제",
    "저기",
    "그게",
    "그거",
    "이거",
    "저거",
    "그리고",
    "하지만",
    "그러면",
    "그래서",
    "또는",
    "이번",
    "그런",
    "이런",
    "저런",
    "정도",
    "부분",
    "관련",
    "대해서",
    "안건",
    "회의",
    "논의",
    "말씀",
    "의견",
    "지금",
    "오늘",
    "내일",
    "이번주",
    "다음주",
    "정말",
    "진짜",
    "아주",
    "거의",
    "일단",
    "맞아요",
    "맞습니다",
    "있습니다",
    "없습니다",
    "한다",
    "했다",
    "하고",
    "해서",
    "하면",
    "하며",
    "이면",
    "이면은",
    "the",
    "and",
    "that",
    "this",
    "with",
    "from",
    "about",
    "저는",
    "저희",
    "저도",
    "제가",
    "그렇죠",
    "거예요",
    "거죠",
    "이게",
    "그게",
    "어떤",
    "그러니까",
    "근데",
    "같아요",
    "같고",
    "있고",
    "있다",
    "하는",
    "하게",
    "되어",
    "그렇게",
    "이렇게",
    "많이",
    "하나",
    "계속",
    "아니라",
    "보니까",
    "나온",
    "있습니다",
    "합니다",
    "겁니다",
    "수도",
    "때문에",
    "가지고",
    "laughing",
    "감사합니다",
    "포인트",
    "처음",
    "틀에서",
    "party",
    "name",
    "있는",
    "되는",
    "번째",
    "우리가",
    "굉장히",
    "아마",
    "거",
    "것",
    "수",
    "등",
    "이런식",
    "그런식",
    "해당",
    "관련된",
    "통해",
    "기반",
    "위해",
    "정리",
    "내용",
    "사항",
    "부분은",
    "부분이",
    "부분을",
    "정도는",
    "다음으로",
    "그리고요",
    "그러고",
    "아니면",
    "진행",
    "완료",
    "중인",
    "그니까",
    "보면",
    "어떻게",
    "좋은",
    "바로",
    "그러니",
    "그런데",
    "company",
    "companies",
    "thing",
    "things",
}

DECISION_PAT = re.compile(r"(결정|확정|합의|채택|의결|하기로|정리하면|정하자)")
ACTION_PAT = re.compile(r"(담당|까지|하겠습니다|진행하겠습니다|준비하겠습니다|검토하겠습니다|공유하겠습니다|작성하겠습니다)")
DUE_PAT = re.compile(r"(\d{4}-\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일|오늘|내일|이번주|다음주|월요일|화요일|수요일|목요일|금요일|토요일|일요일)")
TRANSITION_PAT = re.compile(r"(다음|한편|반면|이제|정리하면|다시|또 하나|두 번째|세 번째|마지막으로)")
LEADING_TIMESTAMP_RE = re.compile(
    r"^\s*\[?\s*(?:"
    r"\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
    r"|\d{1,2}:\d{2}(?::\d{2})?"
    r")\s*\]?\s*"
)


def _now_ts() -> str:
    return time.strftime("%H:%M:%S")


def _safe_text(raw: Any, fallback: str = "") -> str:
    s = str(raw or "").strip()
    return s if s else fallback


def _safe_nonnegative_int(raw: Any, fallback: int = 0) -> int:
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return fallback
    return max(0, value)


def _strip_leading_timestamp(raw: Any) -> str:
    return LEADING_TIMESTAMP_RE.sub("", _safe_text(raw)).strip()


def _boolify(raw: Any, default: bool) -> bool:
    if raw is None:
        return default
    s = str(raw).strip().lower()
    if s in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "f", "no", "n", "off"}:
        return False
    return default


def _sec_to_ts(raw: Any) -> str:
    try:
        sec = max(0, float(raw))
    except Exception:
        return _now_ts()
    total = int(sec)
    hh = (total // 3600) % 24
    mm = (total % 3600) // 60
    ss = total % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[A-Za-z0-9가-힣]{2,}", _safe_text(text).lower()))


def _topic_far_enough(current_title: str, new_title: str) -> bool:
    cur = _tokens(current_title)
    nxt = _tokens(new_title)
    if not cur or not nxt:
        return _safe_text(current_title) != _safe_text(new_title)
    inter = len(cur & nxt)
    union = len(cur | nxt)
    sim = inter / union if union > 0 else 0.0
    return sim < 0.4


def _keyword_tokens(text: str) -> list[str]:
    out: list[str] = []
    for raw_tok in re.findall(r"[A-Za-z0-9가-힣]{2,}", _safe_text(text).lower()):
        tok = _normalize_keyword_token(raw_tok)
        if tok.isdigit():
            continue
        if tok in STOPWORDS:
            continue
        if re.fullmatch(r"name\d+", tok):
            continue
        if tok.startswith("name") or tok.startswith("party"):
            continue
        out.append(tok)
    return out


def _text_similarity(a: str, b: str) -> float:
    ta = set(_keyword_tokens(a))
    tb = set(_keyword_tokens(b))
    if not ta or not tb:
        return 0.0
    union = len(ta | tb)
    return (len(ta & tb) / union) if union else 0.0


def _normalize_agenda_state(raw: Any) -> str:
    s = _safe_text(raw, "PROPOSED").upper()
    if s in {"ACTIVE", "CLOSING", "CLOSED", "PROPOSED"}:
        return s
    return "PROPOSED"


def _normalize_flow_type(raw: Any) -> str:
    s = _safe_text(raw, "discussion").lower()
    if s in {"discussion", "decision", "action-planning"}:
        return s
    return "discussion"


def _normalize_canvas_stage(raw: Any) -> str:
    s = _safe_text(raw, "ideation").lower()
    if s in {"ideation", "problem-definition", "solution"}:
        return s
    return "ideation"


def _utc_iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _env_first(*keys: str) -> str:
    for key in keys:
        value = _safe_text(os.environ.get(key))
        if value:
            return value
    return ""


def _get_supabase_service_client() -> Client | None:
    global _SUPABASE_CLIENT, _SUPABASE_CLIENT_INITIALIZED

    with _SUPABASE_CLIENT_LOCK:
        if _SUPABASE_CLIENT_INITIALIZED:
            return _SUPABASE_CLIENT

        _SUPABASE_CLIENT_INITIALIZED = True
        supabase_url = _env_first("SUPABASE_URL", "supabase_url", "NEXT_PUBLIC_SUPABASE_URL")
        supabase_service_role_key = _env_first(
            "SUPABASE_SERVICE_ROLE_KEY",
            "supabase_service_role_key",
        )
        if not supabase_url or not supabase_service_role_key:
            return None

        try:
            _SUPABASE_CLIENT = create_client(supabase_url, supabase_service_role_key)
        except Exception as exc:
            print(f"❌ Failed to initialize Supabase client: {exc}")
            _SUPABASE_CLIENT = None
        return _SUPABASE_CLIENT


def _runtime_db_table_is_disabled(table_name: str) -> bool:
    with _RUNTIME_DB_STATE_LOCK:
        return table_name in _RUNTIME_DB_DISABLED_TABLES


def _log_runtime_db_error(key: str, message: str, cooldown_sec: float = 10.0) -> None:
    now = time.time()
    with _RUNTIME_DB_STATE_LOCK:
        last_logged_at = _RUNTIME_DB_LOGGED_ERRORS.get(key, 0.0)
        if now - last_logged_at < cooldown_sec:
            return
        _RUNTIME_DB_LOGGED_ERRORS[key] = now
    print(message)


def _handle_runtime_db_exception(table_name: str, action: str, exc: Exception) -> None:
    raw = str(exc)
    if "PGRST205" in raw and table_name in raw:
        with _RUNTIME_DB_STATE_LOCK:
            _RUNTIME_DB_DISABLED_TABLES.add(table_name)
        _log_runtime_db_error(
            f"{table_name}:missing",
            f"⚠️ Supabase 테이블 `{table_name}` 이 없어 runtime DB 저장을 비활성화합니다. "
            "supabase_schema.sql 적용 후 backend를 재시작하세요.",
            cooldown_sec=3600.0,
        )
        return

    _log_runtime_db_error(
        f"{table_name}:{action}:{raw}",
        f"❌ Failed to {action} using Supabase table `{table_name}`: {raw}",
        cooldown_sec=15.0,
    )


def _workspace_payload_from_runtime_workspace(workspace: dict[str, Any]) -> dict[str, Any]:
    return {
        "meeting_goal": _safe_text(workspace.get("meeting_goal")),
        "meeting_goal_context": _safe_text(workspace.get("meeting_goal_context")),
        "stage": _normalize_canvas_stage(workspace.get("stage")),
        "agenda_overrides": _normalize_canvas_agenda_overrides(workspace.get("agenda_overrides")),
        "canvas_items": copy.deepcopy(workspace.get("canvas_items") or []),
        "custom_groups": copy.deepcopy(workspace.get("custom_groups") or []),
        "problem_groups": copy.deepcopy(workspace.get("problem_groups") or []),
        "solution_topics": copy.deepcopy(workspace.get("solution_topics") or []),
        "final_solution_summary": _normalize_canvas_final_solution_summary(
            workspace.get("final_solution_summary")
        ),
        "node_positions": _normalize_canvas_node_positions(workspace.get("node_positions") or {}),
        "idea_create_stack": _safe_nonnegative_int(workspace.get("idea_create_stack")),
        "idea_processed_utterance_ids": [
            _safe_text(item)
            for item in (workspace.get("idea_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "problem_processed_utterance_ids": [
            _safe_text(item)
            for item in (workspace.get("problem_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "operation_log": _normalize_canvas_operation_log(workspace.get("operation_log")),
        "node_lineage": _normalize_canvas_node_lineage(workspace.get("node_lineage")),
        "imported_state": copy.deepcopy(workspace.get("imported_state"))
        if isinstance(workspace.get("imported_state"), dict)
        else None,
        "saved_at": _safe_text(workspace.get("saved_at")),
    }


def _workspace_from_storage_row(meeting_id: str, row: dict[str, Any]) -> dict[str, Any]:
    shared_state = row.get("shared_state")
    if not isinstance(shared_state, dict):
        shared_state = {}
    llm_cache = row.get("llm_cache")
    if not isinstance(llm_cache, dict):
        llm_cache = {}

    return {
        "meeting_id": _safe_text(meeting_id),
        "meeting_goal": _safe_text(shared_state.get("meeting_goal")),
        "meeting_goal_context": _safe_text(shared_state.get("meeting_goal_context")),
        "stage": _normalize_canvas_stage(shared_state.get("stage")),
        "agenda_overrides": _normalize_canvas_agenda_overrides(shared_state.get("agenda_overrides")),
        "canvas_items": copy.deepcopy(shared_state.get("canvas_items") or []),
        "custom_groups": copy.deepcopy(shared_state.get("custom_groups") or []),
        "problem_groups": copy.deepcopy(shared_state.get("problem_groups") or []),
        "solution_topics": copy.deepcopy(shared_state.get("solution_topics") or []),
        "final_solution_summary": _normalize_canvas_final_solution_summary(
            shared_state.get("final_solution_summary")
        ),
        "node_positions": _normalize_canvas_node_positions(shared_state.get("node_positions") or {}),
        "idea_create_stack": _safe_nonnegative_int(shared_state.get("idea_create_stack")),
        "idea_processed_utterance_ids": [
            _safe_text(item)
            for item in (shared_state.get("idea_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "problem_processed_utterance_ids": [
            _safe_text(item)
            for item in (shared_state.get("problem_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "operation_log": _normalize_canvas_operation_log(shared_state.get("operation_log")),
        "node_lineage": _normalize_canvas_node_lineage(shared_state.get("node_lineage")),
        "imported_state": copy.deepcopy(shared_state.get("imported_state"))
        if isinstance(shared_state.get("imported_state"), dict)
        else None,
        "saved_at": _safe_text(shared_state.get("saved_at") or row.get("updated_at")),
        "llm_cache": copy.deepcopy(llm_cache),
    }


def _dedup_canvas_operation_ids(raw_ids: Any, limit: int = 80) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    if isinstance(raw_ids, str):
        iterable_ids = [raw_ids]
    elif isinstance(raw_ids, (list, tuple, set)):
        iterable_ids = raw_ids
    else:
        iterable_ids = []
    for raw_id in iterable_ids:
        node_id = _safe_text(raw_id)
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        ids.append(node_id)
        if len(ids) >= limit:
            break
    return ids


def _safe_operation_epoch(raw: Any) -> float:
    try:
        return max(0.0, float(raw or 0))
    except (TypeError, ValueError):
        return 0.0


def _normalize_canvas_node_lineage(
    raw_lineage: Any,
    limit: int = CANVAS_NODE_LINEAGE_MAX,
) -> dict[str, dict[str, Any]]:
    raw_records: list[tuple[str, Any]] = []
    if isinstance(raw_lineage, dict):
        raw_records = [(_safe_text(key), value) for key, value in raw_lineage.items()]
    elif isinstance(raw_lineage, list):
        raw_records = [("", value) for value in raw_lineage]

    records: list[dict[str, Any]] = []
    for fallback_node_id, raw_record in raw_records:
        if isinstance(raw_record, dict):
            node_id = _safe_text(raw_record.get("node_id") or fallback_node_id)
            current_node_id = _safe_text(
                raw_record.get("current_node_id") or raw_record.get("target_node_id")
            )
            status = _safe_text(raw_record.get("status"), "merged")
            if status not in {"active", "merged", "deleted"}:
                status = "merged" if current_node_id else "deleted"
            source_operation_id = _safe_text(raw_record.get("source_operation_id"))
            source_node_ids = _dedup_canvas_operation_ids(raw_record.get("source_node_ids"), limit=80)
            created_at = _safe_text(raw_record.get("created_at"))[:40]
            created_epoch = _safe_operation_epoch(raw_record.get("created_epoch"))
            updated_at = _safe_text(raw_record.get("updated_at") or raw_record.get("created_at"))[:40]
            updated_epoch = _safe_operation_epoch(
                raw_record.get("updated_epoch") or raw_record.get("created_epoch")
            )
        else:
            node_id = fallback_node_id
            current_node_id = _safe_text(raw_record)
            status = "merged" if current_node_id else "deleted"
            source_operation_id = ""
            source_node_ids = []
            created_at = ""
            created_epoch = 0.0
            updated_at = ""
            updated_epoch = 0.0

        if not node_id:
            continue
        if status != "deleted" and not current_node_id:
            continue
        if current_node_id == node_id and status != "deleted":
            continue
        records.append(
            {
                "node_id": node_id[:160],
                "current_node_id": current_node_id[:160],
                "status": status,
                "source_operation_id": source_operation_id[:120],
                "source_node_ids": source_node_ids,
                "created_at": created_at,
                "created_epoch": created_epoch,
                "updated_at": updated_at,
                "updated_epoch": updated_epoch,
            }
        )

    records = sorted(records, key=lambda item: _safe_operation_epoch(item.get("updated_epoch")))[-limit:]
    return {record["node_id"]: record for record in records}


def _normalize_canvas_operation_log(
    raw_log: Any,
    limit: int = CANVAS_OPERATION_LOG_MAX,
) -> list[dict[str, Any]]:
    if not isinstance(raw_log, list):
        return []

    normalized: list[dict[str, Any]] = []
    for index, raw_entry in enumerate(raw_log[-limit:]):
        if not isinstance(raw_entry, dict):
            continue
        operation_type = _safe_text(raw_entry.get("operation_type"))
        if not operation_type:
            continue
        operation_id = _safe_text(raw_entry.get("operation_id") or raw_entry.get("id"))
        normalized.append(
            {
                "operation_id": operation_id or f"legacy-operation-{index + 1}",
                "operation_type": operation_type[:80],
                "source": _safe_text(raw_entry.get("source"), "server")[:80],
                "target_node_id": _safe_text(raw_entry.get("target_node_id"))[:160],
                "source_node_ids": _dedup_canvas_operation_ids(raw_entry.get("source_node_ids"), limit=80),
                "previous_parent_id": _safe_text(raw_entry.get("previous_parent_id"))[:160],
                "next_parent_id": _safe_text(raw_entry.get("next_parent_id"))[:160],
                "summary": _safe_text(raw_entry.get("summary"))[:240],
                "created_at": _safe_text(raw_entry.get("created_at"))[:40],
                "created_epoch": _safe_operation_epoch(raw_entry.get("created_epoch")),
            }
        )

    return normalized[-limit:]


def _canvas_operation_item_map(workspace: dict[str, Any]) -> dict[str, dict[str, Any]]:
    items = workspace.get("canvas_items") if isinstance(workspace, dict) else []
    mapped: dict[str, dict[str, Any]] = {}
    if not isinstance(items, list):
        return mapped
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = _safe_text(item.get("id"))
        if item_id:
            mapped[item_id] = item
    return mapped


def _canvas_operation_source_ids(item: dict[str, Any]) -> list[str]:
    child_item_ids = item.get("child_item_ids") if isinstance(item.get("child_item_ids"), list) else []
    compacted_from_ids = (
        item.get("compacted_from_ids") if isinstance(item.get("compacted_from_ids"), list) else []
    )
    merged_child_ids = [
        _safe_text(child.get("id"))
        for child in (item.get("merged_children") or [])
        if isinstance(child, dict) and _safe_text(child.get("id"))
    ]
    return _dedup_canvas_operation_ids(
        [*child_item_ids, *compacted_from_ids, *merged_child_ids],
        limit=120,
    )


def _is_canvas_operation_topic_item(item: dict[str, Any] | None) -> bool:
    return isinstance(item, dict) and _safe_text(item.get("kind"), "note") == "topic"


def _canvas_operation_child_ids(workspace: dict[str, Any], topic_id: str) -> list[str]:
    normalized_topic_id = _safe_text(topic_id)
    if not normalized_topic_id:
        return []
    items_by_id = _canvas_operation_item_map(workspace)
    topic = items_by_id.get(normalized_topic_id) or {}
    explicit = _dedup_canvas_operation_ids(topic.get("child_item_ids"), limit=400)
    derived = [
        _safe_text(item.get("id"))
        for item in items_by_id.values()
        if _safe_text(item.get("parent_topic_id")) == normalized_topic_id and _safe_text(item.get("id"))
    ]
    return _dedup_canvas_operation_ids([*explicit, *derived], limit=400)


def _canvas_operation_leaf_child_ids(workspace: dict[str, Any], topic_id: str) -> list[str]:
    leaves: list[str] = []
    items_by_id = _canvas_operation_item_map(workspace)
    pending = list(_canvas_operation_child_ids(workspace, topic_id))
    seen: set[str] = set()

    while pending:
        child_id = _safe_text(pending.pop(0))
        if not child_id or child_id in seen:
            continue
        seen.add(child_id)
        child = items_by_id.get(child_id)
        if _is_canvas_operation_topic_item(child):
            pending.extend(_canvas_operation_child_ids(workspace, child_id))
            continue
        if child:
            leaves.append(child_id)

    return _dedup_canvas_operation_ids(leaves, limit=400)


def _canvas_operation_node_label(item: dict[str, Any] | None, fallback: str = "노드") -> str:
    if not isinstance(item, dict):
        return fallback
    label = _safe_text(item.get("title") or item.get("body") or item.get("id"), fallback)
    return label[:80]


def _canvas_operation_label_for_id(
    node_id: str,
    *item_maps: dict[str, dict[str, Any]],
) -> str:
    normalized_node_id = _safe_text(node_id)
    for item_map in item_maps:
        item = item_map.get(normalized_node_id) if isinstance(item_map, dict) else None
        if isinstance(item, dict):
            return _canvas_operation_node_label(item, normalized_node_id)
    return normalized_node_id[:80] or "노드"


def _quote_canvas_operation_label(label: str) -> str:
    return f'"{_safe_text(label, "노드")[:80]}"'


def _format_canvas_operation_label_list(labels: list[str], limit: int = 3) -> str:
    normalized = [_safe_text(label) for label in labels if _safe_text(label)]
    if not normalized:
        return "원본"
    if len(normalized) == 1:
        return _quote_canvas_operation_label(normalized[0])
    if len(normalized) == 2:
        return f"{_quote_canvas_operation_label(normalized[0])}와 {_quote_canvas_operation_label(normalized[1])}"

    visible = normalized[: max(1, limit - 1)]
    hidden_count = max(0, len(normalized) - len(visible))
    visible_text = ", ".join(_quote_canvas_operation_label(label) for label in visible)
    return f"{visible_text} 외 {hidden_count}개"


def _canvas_operation_labels_for_ids(
    node_ids: list[str],
    *item_maps: dict[str, dict[str, Any]],
    limit: int = 6,
) -> list[str]:
    labels = [
        _canvas_operation_label_for_id(node_id, *item_maps)
        for node_id in _dedup_canvas_operation_ids(node_ids, limit=limit)
    ]
    return [_safe_text(label) for label in labels if _safe_text(label)]


def _canvas_operation_merge_summary(
    target_label: str,
    source_labels: list[str],
    action_label: str = "병합",
) -> str:
    source_text = _format_canvas_operation_label_list(source_labels)
    return f"{source_text}를 {_quote_canvas_operation_label(target_label)}에 {action_label}"


def _canvas_activity_line_from_new_operations(
    workspace: dict[str, Any],
    previous_operation_ids: set[str],
    fallback: str,
    limit: int = 2,
) -> str:
    return _canvas_activity_line_from_activity_events(
        _canvas_activity_events_from_new_operations(workspace, previous_operation_ids),
        fallback,
        limit=limit,
    )


def _canvas_activity_events_from_new_operations(
    workspace: dict[str, Any],
    previous_operation_ids: set[str],
    limit: int = 12,
) -> list[dict[str, Any]]:
    events = [
        {
            "operation_id": _safe_text(entry.get("operation_id")),
            "operation_type": _safe_text(entry.get("operation_type")),
            "summary": _safe_text(entry.get("summary")),
            "target_node_id": _safe_text(entry.get("target_node_id")),
            "source_node_ids": _dedup_canvas_operation_ids(entry.get("source_node_ids"), limit=80),
            "created_at": _safe_text(entry.get("created_at")),
        }
        for entry in _normalize_canvas_operation_log(workspace.get("operation_log"))
        if _safe_text(entry.get("operation_id")) not in previous_operation_ids
        and _safe_text(entry.get("summary"))
    ]
    return events[:limit]


def _canvas_activity_line_from_activity_events(
    events: list[dict[str, Any]],
    fallback: str,
    limit: int = 2,
) -> str:
    lines = [_safe_text(event.get("summary")) for event in events if _safe_text(event.get("summary"))]
    if not lines:
        return fallback
    selected = lines[:limit]
    if len(lines) > len(selected):
        selected.append(f"추가 변경 {len(lines) - len(selected)}건")
    return " · ".join(selected)


def _make_canvas_operation_entry(
    operation_type: str,
    source: str,
    summary: str,
    target_node_id: str = "",
    source_node_ids: list[str] | None = None,
    previous_parent_id: str = "",
    next_parent_id: str = "",
) -> dict[str, Any]:
    created_epoch = time.time()
    return {
        "operation_id": f"op-{int(created_epoch * 1000)}-{uuid4().hex[:8]}",
        "operation_type": operation_type,
        "source": _safe_text(source, "server"),
        "target_node_id": _safe_text(target_node_id),
        "source_node_ids": _dedup_canvas_operation_ids(source_node_ids or [], limit=80),
        "previous_parent_id": _safe_text(previous_parent_id),
        "next_parent_id": _safe_text(next_parent_id),
        "summary": _safe_text(summary)[:240],
        "created_at": _utc_iso_now(),
        "created_epoch": created_epoch,
    }


def _canvas_lineage_current_id(lineage: dict[str, dict[str, Any]], node_id: str) -> str:
    current_id = _safe_text(node_id)
    visited: set[str] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        record = lineage.get(current_id)
        if not isinstance(record, dict):
            break
        next_id = _safe_text(record.get("current_node_id"))
        if not next_id or next_id == current_id:
            break
        current_id = next_id
    return current_id


def _record_canvas_node_lineage(
    lineage: dict[str, dict[str, Any]],
    node_id: str,
    current_node_id: str,
    status: str,
    entry: dict[str, Any] | None = None,
) -> None:
    normalized_node_id = _safe_text(node_id)
    normalized_current_id = _safe_text(current_node_id)
    normalized_status = status if status in {"merged", "deleted"} else "merged"
    if not normalized_node_id:
        return
    if normalized_status != "deleted" and not normalized_current_id:
        return
    if normalized_status != "deleted":
        normalized_current_id = _canvas_lineage_current_id(lineage, normalized_current_id)
    if normalized_status != "deleted" and normalized_node_id == normalized_current_id:
        return

    entry = entry or {}
    existing = lineage.get(normalized_node_id) if isinstance(lineage.get(normalized_node_id), dict) else {}
    created_at = _safe_text((existing or {}).get("created_at") or entry.get("created_at") or _utc_iso_now())[:40]
    created_epoch = _safe_operation_epoch(
        (existing or {}).get("created_epoch") or entry.get("created_epoch") or time.time()
    )
    updated_at = _safe_text(entry.get("created_at") or _utc_iso_now())[:40]
    updated_epoch = _safe_operation_epoch(entry.get("created_epoch") or time.time())
    source_node_ids = _dedup_canvas_operation_ids(
        [
            *((existing or {}).get("source_node_ids") or []),
            *(entry.get("source_node_ids") or []),
            normalized_node_id,
        ],
        limit=80,
    )
    lineage[normalized_node_id] = {
        "node_id": normalized_node_id,
        "current_node_id": normalized_current_id,
        "status": normalized_status,
        "source_operation_id": _safe_text(entry.get("operation_id")),
        "source_node_ids": source_node_ids,
        "created_at": created_at,
        "created_epoch": created_epoch,
        "updated_at": updated_at,
        "updated_epoch": updated_epoch,
    }

    for alias_id, record in list(lineage.items()):
        if alias_id == normalized_node_id or not isinstance(record, dict):
            continue
        if _safe_text(record.get("current_node_id")) != normalized_node_id:
            continue
        _record_canvas_node_lineage(
            lineage,
            alias_id,
            normalized_current_id,
            normalized_status,
            entry,
        )


def _append_canvas_node_lineage_from_change(
    previous_workspace: dict[str, Any],
    next_workspace: dict[str, Any],
    entries: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    lineage = _normalize_canvas_node_lineage(
        next_workspace.get("node_lineage") or (previous_workspace or {}).get("node_lineage")
    )
    previous_items_by_id = _canvas_operation_item_map(previous_workspace)
    next_items_by_id = _canvas_operation_item_map(next_workspace)
    previous_ids = set(previous_items_by_id.keys())
    next_ids = set(next_items_by_id.keys())
    removed_ids = previous_ids - next_ids

    for active_id in next_ids:
        active_record = lineage.get(active_id)
        if isinstance(active_record, dict) and not _safe_text(active_record.get("current_node_id")):
            lineage.pop(active_id, None)

    for entry in entries:
        operation_type = _safe_text(entry.get("operation_type"))
        target_id = _safe_text(entry.get("target_node_id"))
        if operation_type not in {"node_merged", "node_compacted"} or not target_id:
            continue

        target_item = next_items_by_id.get(target_id)
        target_source_ids = set(_dedup_canvas_operation_ids(entry.get("source_node_ids"), limit=400))
        if _is_canvas_operation_topic_item(target_item):
            target_source_ids.update(_canvas_operation_leaf_child_ids(next_workspace, target_id))

        for source_id in list(target_source_ids):
            if source_id in removed_ids:
                _record_canvas_node_lineage(lineage, source_id, target_id, "merged", entry)

        for removed_id in sorted(removed_ids):
            if removed_id in lineage:
                continue
            removed_item = previous_items_by_id.get(removed_id)
            if not _is_canvas_operation_topic_item(removed_item):
                continue
            removed_leaf_ids = set(_canvas_operation_leaf_child_ids(previous_workspace, removed_id))
            if not removed_leaf_ids or not target_source_ids:
                continue
            if removed_leaf_ids.issubset(target_source_ids):
                _record_canvas_node_lineage(lineage, removed_id, target_id, "merged", entry)

    for entry in entries:
        if _safe_text(entry.get("operation_type")) != "node_deleted":
            continue
        for source_id in _dedup_canvas_operation_ids(entry.get("source_node_ids"), limit=80):
            if source_id in next_ids or source_id in lineage:
                continue
            _record_canvas_node_lineage(lineage, source_id, "", "deleted", entry)

    return _normalize_canvas_node_lineage(lineage)


def _resolve_canvas_node_lineage(workspace: dict[str, Any], node_id: str) -> dict[str, Any]:
    normalized_node_id = _safe_text(node_id)
    items_by_id = _canvas_operation_item_map(workspace)
    if not normalized_node_id:
        return {"node_id": "", "current_node_id": "", "status": "missing", "exists": False}
    if normalized_node_id in items_by_id:
        return {
            "node_id": normalized_node_id,
            "current_node_id": normalized_node_id,
            "status": "active",
            "exists": True,
        }

    lineage = _normalize_canvas_node_lineage(workspace.get("node_lineage"))
    record = lineage.get(normalized_node_id)
    if not record:
        return {
            "node_id": normalized_node_id,
            "current_node_id": "",
            "status": "missing",
            "exists": False,
        }

    current_id = _canvas_lineage_current_id(lineage, normalized_node_id)
    status = _safe_text(record.get("status"), "merged")
    return {
        "node_id": normalized_node_id,
        "current_node_id": current_id,
        "status": status,
        "exists": bool(current_id and current_id in items_by_id),
        "record": copy.deepcopy(record),
    }


def _canvas_missing_topic_summary_state(workspace: dict[str, Any], topic_id: str) -> dict[str, str]:
    resolution = _resolve_canvas_node_lineage(workspace, topic_id)
    current_id = _safe_text(resolution.get("current_node_id"))
    if current_id and current_id != _safe_text(topic_id):
        target_item = _canvas_operation_item_map(workspace).get(current_id)
        label = _canvas_operation_node_label(target_item, current_id)
        return {
            "detail": f'정리 대상 topic이 "{label}" 노드로 병합되어 이전 AI 정리 결과를 적용하지 않았습니다.',
            "stale_reason": "absorbed",
            "resolved_node_id": current_id,
        }
    if _safe_text(resolution.get("status")) == "deleted":
        return {
            "detail": "정리 대상 topic이 삭제되어 이전 AI 정리 결과를 적용하지 않았습니다.",
            "stale_reason": "deleted",
            "resolved_node_id": "",
        }
    return {
        "detail": "정리 대상 topic이 이미 이동되었거나 삭제되었습니다.",
        "stale_reason": "obsolete",
        "resolved_node_id": "",
    }


def _append_canvas_operation_log_from_change(
    previous_workspace: dict[str, Any],
    next_workspace: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    workspace = copy.deepcopy(next_workspace) if isinstance(next_workspace, dict) else {}
    previous_items_by_id = _canvas_operation_item_map(previous_workspace)
    next_items_by_id = _canvas_operation_item_map(workspace)
    existing_log = _normalize_canvas_operation_log(
        workspace.get("operation_log") or (previous_workspace or {}).get("operation_log")
    )
    existing_lineage = _normalize_canvas_node_lineage(
        workspace.get("node_lineage") or (previous_workspace or {}).get("node_lineage")
    )

    if not previous_items_by_id:
        workspace["operation_log"] = existing_log
        workspace["node_lineage"] = existing_lineage
        return workspace

    previous_ids = set(previous_items_by_id.keys())
    next_ids = set(next_items_by_id.keys())
    added_ids = next_ids - previous_ids
    common_ids = previous_ids & next_ids
    removed_ids = previous_ids - next_ids
    covered_removed_ids: set[str] = set()
    merge_targets_by_source: dict[str, str] = {}
    entries: list[dict[str, Any]] = []

    for item_id in sorted(added_ids):
        item = next_items_by_id[item_id]
        source_ids = _canvas_operation_source_ids(item)
        previous_source_ids = [source_id for source_id in source_ids if source_id in previous_ids]
        effective_source_ids = previous_source_ids or source_ids
        label = _canvas_operation_node_label(item)
        is_topic = _safe_text(item.get("kind"), "note") == "topic"
        is_ai_created = bool(item.get("ai_generated")) or _safe_text(item.get("created_by")) == "ai"
        absorbed_removed_topic_ids: list[str] = []
        if is_topic and effective_source_ids:
            source_id_set = set(effective_source_ids)
            for removed_id in sorted(removed_ids):
                removed_item = previous_items_by_id.get(removed_id)
                if not _is_canvas_operation_topic_item(removed_item):
                    continue
                removed_leaf_ids = set(_canvas_operation_leaf_child_ids(previous_workspace, removed_id))
                if removed_leaf_ids and removed_leaf_ids.issubset(source_id_set):
                    absorbed_removed_topic_ids.append(removed_id)
                    covered_removed_ids.add(removed_id)
        operation_source_ids = _dedup_canvas_operation_ids(
            [*effective_source_ids, *absorbed_removed_topic_ids],
            limit=120,
        )

        if is_topic and len(effective_source_ids) >= 2:
            source_labels = _canvas_operation_labels_for_ids(
                operation_source_ids,
                previous_items_by_id,
                next_items_by_id,
            )
            entries.append(
                _make_canvas_operation_entry(
                    "node_merged",
                    source,
                    _canvas_operation_merge_summary(label, source_labels),
                    target_node_id=item_id,
                    source_node_ids=operation_source_ids,
                )
            )
            for source_id in operation_source_ids:
                merge_targets_by_source[source_id] = item_id
                if source_id in removed_ids:
                    covered_removed_ids.add(source_id)
        elif is_topic or is_ai_created:
            entries.append(
                _make_canvas_operation_entry(
                    "node_created",
                    source,
                    f'"{label}" 노드가 생성되었습니다.',
                    target_node_id=item_id,
                    source_node_ids=effective_source_ids,
                )
            )

    for item_id in sorted(common_ids):
        previous_item = previous_items_by_id[item_id]
        next_item = next_items_by_id[item_id]
        previous_sources = set(_canvas_operation_source_ids(previous_item))
        next_sources = _canvas_operation_source_ids(next_item)
        added_sources = [source_id for source_id in next_sources if source_id not in previous_sources]
        if _is_canvas_operation_topic_item(next_item) and next_sources:
            next_source_set = set(next_sources)
            for removed_id in sorted(removed_ids):
                if removed_id in covered_removed_ids:
                    continue
                removed_item = previous_items_by_id.get(removed_id)
                if not _is_canvas_operation_topic_item(removed_item):
                    continue
                removed_leaf_ids = set(_canvas_operation_leaf_child_ids(previous_workspace, removed_id))
                if removed_leaf_ids and removed_leaf_ids.issubset(next_source_set):
                    added_sources.append(removed_id)
                    covered_removed_ids.add(removed_id)
        added_sources = _dedup_canvas_operation_ids(added_sources, limit=120)
        if not added_sources:
            continue
        label = _canvas_operation_node_label(next_item)
        source_labels = _canvas_operation_labels_for_ids(
            added_sources,
            previous_items_by_id,
            next_items_by_id,
        )
        entries.append(
            _make_canvas_operation_entry(
                "node_compacted",
                source,
                _canvas_operation_merge_summary(label, source_labels),
                target_node_id=item_id,
                source_node_ids=added_sources,
            )
        )
        for source_id in added_sources:
            if source_id in removed_ids:
                covered_removed_ids.add(source_id)

    for item_id in sorted(common_ids):
        previous_item = previous_items_by_id[item_id]
        next_item = next_items_by_id[item_id]
        previous_parent_id = _safe_text(previous_item.get("parent_topic_id"))
        next_parent_id = _safe_text(next_item.get("parent_topic_id"))
        if previous_parent_id == next_parent_id:
            continue
        if merge_targets_by_source.get(item_id) == next_parent_id:
            continue
        label = _canvas_operation_node_label(next_item)
        next_parent_label = (
            _canvas_operation_label_for_id(next_parent_id, next_items_by_id, previous_items_by_id)
            if next_parent_id
            else "상위 캔버스"
        )
        entries.append(
            _make_canvas_operation_entry(
                "node_moved",
                source,
                f'{_quote_canvas_operation_label(label)}를 {_quote_canvas_operation_label(next_parent_label)} 아래로 이동',
                target_node_id=item_id,
                source_node_ids=[item_id],
                previous_parent_id=previous_parent_id,
                next_parent_id=next_parent_id,
            )
        )

    for item_id in sorted(removed_ids - covered_removed_ids):
        previous_item = previous_items_by_id[item_id]
        label = _canvas_operation_node_label(previous_item, item_id)
        entries.append(
            _make_canvas_operation_entry(
                "node_deleted",
                source,
                f'{_quote_canvas_operation_label(label)} 제거',
                source_node_ids=[item_id],
            )
        )

    if entries:
        existing_log = [*existing_log, *entries[:80]]
    workspace["operation_log"] = _normalize_canvas_operation_log(existing_log)
    workspace["node_lineage"] = _append_canvas_node_lineage_from_change(
        previous_workspace,
        workspace,
        entries,
    )
    return workspace


def _normalize_canvas_workspace_problem_groups(
    groups: list[CanvasWorkspaceProblemGroupInput] | None,
) -> list[dict[str, Any]]:
    return [
        {
            "group_id": _safe_text(group.group_id),
            "topic": _safe_text(group.topic),
            "insight_lens": _safe_text(group.insight_lens),
            "insight_user_edited": bool(group.insight_user_edited),
            "keywords": [_safe_text(item) for item in (group.keywords or []) if _safe_text(item)],
            "agenda_ids": [_safe_text(item) for item in (group.agenda_ids or []) if _safe_text(item)],
            "agenda_titles": [_safe_text(item) for item in (group.agenda_titles or []) if _safe_text(item)],
            "source_group_id": _safe_text(group.source_group_id),
            "source_group_title": _safe_text(group.source_group_title),
            "ideas": [
                {
                    "id": _safe_text(idea.id),
                    "kind": _safe_text(idea.kind, "note"),
                    "title": _safe_text(idea.title),
                    "body": _safe_text(idea.body),
                }
                for idea in (group.ideas or [])
                if _safe_text(idea.id) or _safe_text(idea.title) or _safe_text(idea.body)
            ],
            "source_child_item_ids": [
                _safe_text(item) for item in (group.source_child_item_ids or []) if _safe_text(item)
            ],
            "discussion_items": [
                {
                    "id": _safe_text(item.id),
                    "parent_group_id": _safe_text(item.parent_group_id or group.group_id),
                    "target_node_id": _safe_text(item.target_node_id),
                    "target_node_label": _safe_text(item.target_node_label),
                    "target_node_kind": _safe_text(item.target_node_kind),
                    "title": _safe_text(item.title),
                    "body": _safe_text(item.body),
                    "keywords": [_safe_text(value) for value in (item.keywords or []) if _safe_text(value)][:8],
                    "key_evidence": [_safe_text(value) for value in (item.key_evidence or []) if _safe_text(value)][:8],
                    "refined_utterances": [
                        {
                            "utterance_id": _safe_text(value.utterance_id),
                            "speaker": _safe_text(value.speaker, "참가자"),
                            "text": _safe_text(value.text),
                            "timestamp": _safe_text(value.timestamp),
                        }
                        for value in (item.refined_utterances or [])
                        if _safe_text(value.text)
                    ],
                    "evidence_utterance_ids": [
                        _safe_text(value) for value in (item.evidence_utterance_ids or []) if _safe_text(value)
                    ][:400],
                    "ignored_utterance_ids": [
                        _safe_text(value) for value in (item.ignored_utterance_ids or []) if _safe_text(value)
                    ][:400],
                    "ai_pending": bool(item.ai_pending),
                    "ai_generated": bool(item.ai_generated),
                    "user_edited": bool(item.user_edited),
                    "created_by": _safe_text(item.created_by),
                    "created_at": _safe_text(item.created_at),
                }
                for item in (group.discussion_items or [])
                if _safe_text(item.id) or _safe_text(item.title) or _safe_text(item.body)
            ],
            "linked_group_ids": [
                _safe_text(item) for item in (group.linked_group_ids or []) if _safe_text(item)
            ],
            "source_summary_items": [
                _safe_text(item) for item in (group.source_summary_items or []) if _safe_text(item)
            ],
            "conclusion": _safe_text(group.conclusion),
            "conclusion_user_edited": bool(group.conclusion_user_edited),
            "status": _safe_text(group.status, "draft"),
            "source_signature": _safe_text(group.source_signature),
            "source_agenda_signatures": {
                _safe_text(key): _safe_text(value)
                for key, value in (group.source_agenda_signatures or {}).items()
                if _safe_text(key) and _safe_text(value)
            },
            "source_idea_signatures": {
                _safe_text(key): _safe_text(value)
                for key, value in (group.source_idea_signatures or {}).items()
                if _safe_text(key) and _safe_text(value)
            },
        }
        for group in (groups or [])
        if _safe_text(group.group_id) and _safe_text(group.topic)
    ]


def _normalize_canvas_workspace_solution_topics(
    topics: list[CanvasWorkspaceSolutionTopicInput] | None,
) -> list[dict[str, Any]]:
    return [
        {
            "group_id": _safe_text(topic.group_id),
            "topic_no": int(topic.topic_no or 0),
            "topic": _safe_text(topic.topic),
            "conclusion": _safe_text(topic.conclusion),
            "ideas": [_safe_text(item) for item in (topic.ideas or []) if _safe_text(item)],
            "status": _safe_text(topic.status, "draft"),
            "problem_topic": _safe_text(topic.problem_topic),
            "problem_insight": _safe_text(topic.problem_insight),
            "problem_conclusion": _safe_text(topic.problem_conclusion),
            "problem_keywords": [_safe_text(item) for item in (topic.problem_keywords or []) if _safe_text(item)],
            "agenda_titles": [_safe_text(item) for item in (topic.agenda_titles or []) if _safe_text(item)],
            "ai_suggestions": [
                {
                    "id": _safe_text(item.get("id")),
                    "text": _safe_text(item.get("text")),
                    "status": _safe_text(item.get("status"), "draft"),
                }
                for item in (topic.ai_suggestions or [])
                if isinstance(item, dict) and (_safe_text(item.get("id")) or _safe_text(item.get("text")))
            ],
            "notes": [
                {
                    "id": _safe_text(item.get("id")),
                    "text": _safe_text(item.get("text")),
                    "source": _safe_text(item.get("source"), "user"),
                    "source_ai_id": _safe_text(item.get("source_ai_id")),
                    "is_final_candidate": bool(item.get("is_final_candidate")),
                    "final_comment": _safe_text(item.get("final_comment")),
                }
                for item in (topic.notes or [])
                if isinstance(item, dict) and (_safe_text(item.get("id")) or _safe_text(item.get("text")))
            ],
        }
        for topic in (topics or [])
        if _safe_text(topic.group_id) and _safe_text(topic.topic)
    ]


def _normalize_canvas_final_solution_summary(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {
            "final_count": 0,
            "topics": [],
            "items": [],
            "markdown": "",
        }

    def normalize_item(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        note_text = _safe_text(item.get("note_text") or item.get("text"))
        note_id = _safe_text(item.get("note_id") or item.get("id"))
        topic_id = _safe_text(item.get("topic_id") or item.get("topicId"))
        if not note_text and not note_id:
            return None
        return {
            "id": _safe_text(item.get("id") or f"{topic_id}::{note_id}"),
            "topic_id": topic_id,
            "topic_no": _safe_nonnegative_int(item.get("topic_no") or item.get("topicNo")),
            "topic_title": _safe_text(item.get("topic_title") or item.get("topicTitle")),
            "problem_topic": _safe_text(item.get("problem_topic") or item.get("problemTopic")),
            "problem_conclusion": _safe_text(item.get("problem_conclusion") or item.get("problemConclusion")),
            "solution_conclusion": _safe_text(item.get("solution_conclusion") or item.get("solutionConclusion")),
            "note_id": note_id,
            "note_text": note_text,
            "final_comment": _safe_text(item.get("final_comment") or item.get("finalComment")),
            "source": _safe_text(item.get("source"), "user"),
            "source_ai_id": _safe_text(item.get("source_ai_id") or item.get("sourceAiId")),
            "agenda_titles": [
                _safe_text(value)
                for value in (item.get("agenda_titles") or item.get("agendaTitles") or [])
                if _safe_text(value)
            ][:30],
        }

    topics: list[dict[str, Any]] = []
    flat_items: list[dict[str, Any]] = []
    for topic in raw.get("topics") or []:
        if not isinstance(topic, dict):
            continue
        final_notes = [
            normalized
            for normalized in (normalize_item(item) for item in (topic.get("final_notes") or topic.get("finalNotes") or []))
            if normalized
        ]
        topic_id = _safe_text(topic.get("topic_id") or topic.get("topicId"))
        topic_payload = {
            "topic_id": topic_id,
            "topic_no": _safe_nonnegative_int(topic.get("topic_no") or topic.get("topicNo")),
            "topic_title": _safe_text(topic.get("topic_title") or topic.get("topicTitle")),
            "problem_topic": _safe_text(topic.get("problem_topic") or topic.get("problemTopic")),
            "solution_conclusion": _safe_text(topic.get("solution_conclusion") or topic.get("solutionConclusion")),
            "final_notes": final_notes,
        }
        if final_notes or topic_payload["topic_title"]:
            topics.append(topic_payload)
            flat_items.extend(final_notes)

    explicit_items = [
        normalized
        for normalized in (normalize_item(item) for item in (raw.get("items") or []))
        if normalized
    ]
    items = explicit_items or flat_items

    return {
        "final_count": len(items),
        "topics": topics,
        "items": items,
        "markdown": _safe_text(raw.get("markdown")),
    }


def _normalize_refined_utterances(
    raw_rows: Any,
    limit: int = 120,
    allowed_ids: set[str] | None = None,
    min_relevance_score: float | None = None,
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()

    for idx, raw in enumerate(raw_rows or []):
        if isinstance(raw, dict):
            utterance_id = _safe_text(raw.get("utterance_id") or raw.get("utteranceId") or raw.get("id"))
            speaker = _safe_text(raw.get("speaker"), "참가자")
            text = _strip_leading_timestamp(_safe_text(raw.get("text") or raw.get("refined_text") or raw.get("refinedText")))
            timestamp = _safe_text(raw.get("timestamp"))
            raw_score = raw.get("relevanceScore") or raw.get("relevance_score")
        else:
            utterance_id = _safe_text(
                getattr(raw, "utterance_id", "") or getattr(raw, "utteranceId", "") or getattr(raw, "id", "")
            )
            speaker = _safe_text(getattr(raw, "speaker", ""), "참가자")
            text = _strip_leading_timestamp(
                _safe_text(
                    getattr(raw, "text", "")
                    or getattr(raw, "refined_text", "")
                    or getattr(raw, "refinedText", "")
                )
            )
            timestamp = _safe_text(getattr(raw, "timestamp", ""))
            raw_score = getattr(raw, "relevanceScore", None) or getattr(raw, "relevance_score", None)

        if allowed_ids is not None and (not utterance_id or utterance_id not in allowed_ids):
            continue
        if min_relevance_score is not None:
            try:
                relevance_score = float(raw_score)
            except (TypeError, ValueError):
                relevance_score = 0.0
            if relevance_score < min_relevance_score:
                continue

        text = _to_summary_point(
            re.sub(r"\s+", " ", text).strip().strip(" .,!?:;/|"),
            max_len=72,
        )
        if not text:
            continue
        utterance_id = utterance_id or f"refined-{idx}"
        key = utterance_id or f"{speaker}:{text}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "utterance_id": utterance_id,
                "speaker": speaker,
                "text": text,
                "timestamp": timestamp,
            }
        )
        if len(normalized) >= limit:
            break

    return normalized


def _normalize_canvas_merged_children(raw_children: Any, limit: int = 80, depth: int = 0) -> list[dict[str, Any]]:
    if depth >= 4:
        return []

    normalized: list[dict[str, Any]] = []
    for raw in raw_children or []:
        if not isinstance(raw, dict):
            continue
        child_id = _safe_text(raw.get("id"))
        title = _safe_text(raw.get("title"))
        body = _safe_text(raw.get("body") or raw.get("summary"))
        if not child_id and not (title or body):
            continue
        child = {
            "id": child_id,
            "agenda_id": _safe_text(raw.get("agenda_id")),
            "point_id": _safe_text(raw.get("point_id")),
            "kind": _safe_text(raw.get("kind"), "note"),
            "status": _safe_text(raw.get("status"), "discussion"),
            "title": title,
            "body": body,
            "keywords": [_safe_text(keyword) for keyword in (raw.get("keywords") or []) if _safe_text(keyword)][:8],
            "key_evidence": [_safe_text(value) for value in (raw.get("key_evidence") or []) if _safe_text(value)][:8],
            "refined_utterances": _normalize_refined_utterances(raw.get("refined_utterances") or [], limit=40),
            "evidence_utterance_ids": [
                _safe_text(value) for value in (raw.get("evidence_utterance_ids") or []) if _safe_text(value)
            ][:400],
            "ignored_utterance_ids": [
                _safe_text(value) for value in (raw.get("ignored_utterance_ids") or []) if _safe_text(value)
            ][:400],
            "merged_children": _normalize_canvas_merged_children(raw.get("merged_children") or [], limit=40, depth=depth + 1),
            "compacted_from_ids": [
                _safe_text(value) for value in (raw.get("compacted_from_ids") or []) if _safe_text(value)
            ][:400],
            "compaction_level": _safe_nonnegative_int(raw.get("compaction_level")),
            "auto_summary_disabled": bool(raw.get("auto_summary_disabled")),
            "ai_generated": bool(raw.get("ai_generated")),
            "user_edited": bool(raw.get("user_edited")),
        }
        normalized.append(child)
        if len(normalized) >= limit:
            break

    return normalized


def _normalize_canvas_ideation_suggestions(raw_suggestions: Any, limit: int = 8) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for index, raw in enumerate(raw_suggestions or []):
        if hasattr(raw, "model_dump"):
            item = raw.model_dump()
        elif isinstance(raw, dict):
            item = raw
        else:
            continue
        text = _safe_text(item.get("text"))
        if not text:
            continue
        status = _safe_text(item.get("status"), "draft")
        if status not in {"draft", "selected", "dismissed"}:
            status = "draft"
        suggestion_id = _safe_text(item.get("id")) or f"ideation-suggestion-{index + 1}"
        normalized.append({
            "id": suggestion_id,
            "text": text,
            "status": status,
        })
        if len(normalized) >= limit:
            break
    return normalized


def _normalize_canvas_workspace_items(
    items: list[CanvasWorkspaceCanvasItemInput] | None,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []

    for item in (items or []):
        item_id = _safe_text(item.id)
        if not item_id or not (_safe_text(item.title) or _safe_text(item.body)):
            continue

        payload: dict[str, Any] = {
            "id": item_id,
            "agenda_id": _safe_text(item.agenda_id),
            "point_id": _safe_text(item.point_id),
            "kind": _safe_text(item.kind, "note"),
            "status": _safe_text(item.status, "discussion"),
            "title": _safe_text(item.title),
            "body": _safe_text(item.body),
            "keywords": [_safe_text(keyword) for keyword in (item.keywords or []) if _safe_text(keyword)][:8],
            "key_evidence": [_safe_text(value) for value in (item.key_evidence or []) if _safe_text(value)][:6],
            "refined_utterances": _normalize_refined_utterances(item.refined_utterances),
            "evidence_utterance_ids": [_safe_text(value) for value in (item.evidence_utterance_ids or []) if _safe_text(value)][:400],
            "ignored_utterance_ids": [_safe_text(value) for value in (item.ignored_utterance_ids or []) if _safe_text(value)][:400],
            "merged_children": _normalize_canvas_merged_children(item.merged_children),
            "compacted_from_ids": [_safe_text(value) for value in (item.compacted_from_ids or []) if _safe_text(value)][:400],
            "compaction_level": _safe_nonnegative_int(item.compaction_level),
            "parent_topic_id": _safe_text(item.parent_topic_id),
            "parent_topic_source": _safe_text(item.parent_topic_source)
            if _safe_text(item.parent_topic_source) in {"ai", "user"}
            else "",
            "parent_topic_locked": bool(item.parent_topic_locked),
            "child_item_ids": [_safe_text(value) for value in (item.child_item_ids or []) if _safe_text(value)][:400],
            "topic_collapsed": bool(item.topic_collapsed),
            "auto_summary_disabled": bool(item.auto_summary_disabled),
            "created_by": _safe_text(item.created_by) if _safe_text(item.created_by) in {"ai", "user"} else "",
            "manual_position": False,
            "ai_generated": bool(item.ai_generated),
            "user_edited": bool(item.user_edited),
            "ai_pending": bool(getattr(item, "ai_pending", False)),
            "ai_suggestions": _normalize_canvas_ideation_suggestions(item.ai_suggestions),
        }

        normalized.append(payload)

    return normalized


def _normalize_canvas_custom_groups(groups: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []

    for group in (groups or []):
        if hasattr(group, "model_dump"):
            raw_group = group.model_dump()
        elif isinstance(group, dict):
            raw_group = group
        else:
            continue

        group_id = _safe_text(raw_group.get("id"))
        title = _safe_text(raw_group.get("title"))
        if not group_id or not title:
            continue

        normalized.append(
            {
                "id": group_id,
                "title": title,
                "description": _safe_text(raw_group.get("description")),
                "keywords": [
                    _safe_text(keyword)
                    for keyword in (raw_group.get("keywords") or [])
                    if _safe_text(keyword)
                ][:8],
                "color": _safe_text(raw_group.get("color")),
                "created_by": _safe_text(raw_group.get("created_by")),
                "created_at": _safe_text(raw_group.get("created_at")),
            }
        )

    return normalized


def _normalize_canvas_agenda_overrides(
    overrides: Any,
) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    if not isinstance(overrides, dict):
        return normalized

    for raw_agenda_id, raw_override in overrides.items():
        agenda_id = _safe_text(raw_agenda_id)
        if not agenda_id or not isinstance(raw_override, dict):
            continue

        title = _safe_text(raw_override.get("title"))
        keywords = [_safe_text(item) for item in (raw_override.get("keywords") or []) if _safe_text(item)]
        summary_bullets = [
            _safe_text(item) for item in (raw_override.get("summaryBullets") or []) if _safe_text(item)
        ]

        if title or keywords or summary_bullets:
            normalized[agenda_id] = {
                "title": title,
                "keywords": keywords,
                "summaryBullets": summary_bullets,
            }

    return normalized


def _normalize_canvas_local_state(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    shared_sync_enabled = _boolify(payload.get("shared_sync_enabled"), True)
    normalized: dict[str, Any] = {
        "shared_sync_enabled": shared_sync_enabled,
        "meeting_goal": _safe_text(payload.get("meeting_goal")),
        "meeting_goal_context": _safe_text(payload.get("meeting_goal_context")),
        "agenda_overrides": _normalize_canvas_agenda_overrides(payload.get("agenda_overrides")),
        "canvas_items": copy.deepcopy(payload.get("canvas_items") or []),
        "custom_groups": _normalize_canvas_custom_groups(payload.get("custom_groups") or []),
        "ideation_focus_item_id": _safe_text(payload.get("ideation_focus_item_id")),
    }

    if not shared_sync_enabled:
        normalized["stage"] = _normalize_canvas_stage(payload.get("stage"))
        normalized["problem_groups"] = copy.deepcopy(payload.get("problem_groups") or [])
        normalized["solution_topics"] = copy.deepcopy(payload.get("solution_topics") or [])
        normalized["final_solution_summary"] = _normalize_canvas_final_solution_summary(
            payload.get("final_solution_summary")
        )
        normalized["node_positions"] = _normalize_canvas_node_positions(payload.get("node_positions") or {})
        normalized["imported_state"] = (
            copy.deepcopy(payload.get("imported_state"))
            if isinstance(payload.get("imported_state"), dict)
            else None
        )
        normalized["import_override_active"] = bool(payload.get("import_override_active"))

    return normalized


def _clone_runtime_workspace_state(meeting_id: str, source: dict[str, Any], saved_at: str) -> dict[str, Any]:
    return {
        "meeting_id": _safe_text(meeting_id),
        "meeting_goal": _safe_text(source.get("meeting_goal")),
        "meeting_goal_context": _safe_text(source.get("meeting_goal_context")),
        "stage": _normalize_canvas_stage(source.get("stage")),
        "agenda_overrides": _normalize_canvas_agenda_overrides(source.get("agenda_overrides")),
        "canvas_items": copy.deepcopy(source.get("canvas_items") or []),
        "custom_groups": _normalize_canvas_custom_groups(source.get("custom_groups") or []),
        "problem_groups": copy.deepcopy(source.get("problem_groups") or []),
        "solution_topics": copy.deepcopy(source.get("solution_topics") or []),
        "final_solution_summary": _normalize_canvas_final_solution_summary(source.get("final_solution_summary")),
        "node_positions": _normalize_canvas_node_positions(source.get("node_positions") or {}),
        "idea_create_stack": _safe_nonnegative_int(source.get("idea_create_stack")),
        "idea_processed_utterance_ids": [
            _safe_text(item)
            for item in (source.get("idea_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "problem_processed_utterance_ids": [
            _safe_text(item)
            for item in (source.get("problem_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "operation_log": _normalize_canvas_operation_log(source.get("operation_log")),
        "node_lineage": _normalize_canvas_node_lineage(source.get("node_lineage")),
        "imported_state": copy.deepcopy(source.get("imported_state"))
        if isinstance(source.get("imported_state"), dict)
        else None,
        "saved_at": _safe_text(saved_at),
        "llm_cache": copy.deepcopy(source.get("llm_cache") or {})
        if isinstance(source.get("llm_cache"), dict)
        else {},
    }


def _canvas_workspace_response(workspace: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "meeting_id": _safe_text(workspace.get("meeting_id")),
        "meeting_goal": _safe_text(workspace.get("meeting_goal")),
        "meeting_goal_context": _safe_text(workspace.get("meeting_goal_context")),
        "stage": _normalize_canvas_stage(workspace.get("stage")),
        "agenda_overrides": _normalize_canvas_agenda_overrides(workspace.get("agenda_overrides")),
        "canvas_items": copy.deepcopy(workspace.get("canvas_items") or []),
        "custom_groups": _normalize_canvas_custom_groups(workspace.get("custom_groups") or []),
        "problem_groups": copy.deepcopy(workspace.get("problem_groups") or []),
        "solution_topics": copy.deepcopy(workspace.get("solution_topics") or []),
        "final_solution_summary": _normalize_canvas_final_solution_summary(
            workspace.get("final_solution_summary")
        ),
        "node_positions": _normalize_canvas_node_positions(workspace.get("node_positions") or {}),
        "idea_create_stack": _safe_nonnegative_int(workspace.get("idea_create_stack")),
        "idea_processed_utterance_ids": [
            _safe_text(item)
            for item in (workspace.get("idea_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "problem_processed_utterance_ids": [
            _safe_text(item)
            for item in (workspace.get("problem_processed_utterance_ids") or [])
            if _safe_text(item)
        ][:1000],
        "operation_log": _normalize_canvas_operation_log(workspace.get("operation_log")),
        "node_lineage": _normalize_canvas_node_lineage(workspace.get("node_lineage")),
        "imported_state": copy.deepcopy(workspace.get("imported_state"))
        if isinstance(workspace.get("imported_state"), dict)
        else None,
        "saved_at": _safe_text(workspace.get("saved_at")),
    }


def _load_canvas_workspace_from_db(meeting_id: str) -> dict[str, Any] | None:
    client = _get_supabase_service_client()
    normalized_meeting_id = _safe_text(meeting_id)
    if client is None or not normalized_meeting_id:
        return None
    if _runtime_db_table_is_disabled(RUNTIME_SHARED_STATE_TABLE):
        return None

    try:
        with _SUPABASE_REQUEST_LOCK:
            response = (
                client.table(RUNTIME_SHARED_STATE_TABLE)
                .select("meeting_id,shared_state,llm_cache,updated_at")
                .eq("meeting_id", normalized_meeting_id)
                .limit(1)
                .execute()
            )
        rows = response.data or []
        if not rows:
            return None
        first_row = rows[0] if isinstance(rows[0], dict) else {}
        if not isinstance(first_row, dict):
            return None
        return _workspace_from_storage_row(normalized_meeting_id, first_row)
    except Exception as exc:
        _handle_runtime_db_exception(RUNTIME_SHARED_STATE_TABLE, "load", exc)
        return None


def _save_canvas_workspace_to_db(meeting_id: str, workspace: dict[str, Any]) -> bool:
    client = _get_supabase_service_client()
    normalized_meeting_id = _safe_text(meeting_id)
    if client is None or not normalized_meeting_id:
        return False
    if _runtime_db_table_is_disabled(RUNTIME_SHARED_STATE_TABLE):
        return False

    try:
        with _SUPABASE_REQUEST_LOCK:
            client.table(RUNTIME_SHARED_STATE_TABLE).upsert(
                {
                    "meeting_id": normalized_meeting_id,
                    "shared_state": _workspace_payload_from_runtime_workspace(workspace),
                    "llm_cache": copy.deepcopy(workspace.get("llm_cache") or {}),
                    "updated_at": _utc_iso_now(),
                },
                on_conflict="meeting_id",
            ).execute()
        return True
    except Exception as exc:
        _handle_runtime_db_exception(RUNTIME_SHARED_STATE_TABLE, "save", exc)
        return False


def _load_canvas_personal_notes_from_db(
    meeting_id: str,
    user_id: str,
) -> tuple[list[dict[str, Any]] | None, dict[str, Any] | None]:
    client = _get_supabase_service_client()
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_user_id = _safe_text(user_id)
    if client is None or not normalized_meeting_id or not normalized_user_id:
        return None, None
    if _runtime_db_table_is_disabled(RUNTIME_USER_STATE_TABLE):
        return None, None

    try:
        with _SUPABASE_REQUEST_LOCK:
            response = (
                client.table(RUNTIME_USER_STATE_TABLE)
                .select("meeting_id,user_id,personal_state,updated_at")
                .eq("meeting_id", normalized_meeting_id)
                .eq("user_id", normalized_user_id)
                .limit(1)
                .execute()
            )
        rows = response.data or []
        if not rows:
            return None, None
        first_row = rows[0] if isinstance(rows[0], dict) else {}
        if not isinstance(first_row, dict):
            return None, None
        personal_state = first_row.get("personal_state")
        if not isinstance(personal_state, dict):
            personal_state = {}
        notes = personal_state.get("personal_notes")
        if not isinstance(notes, list):
            notes = []
        local_canvas_state = personal_state.get("local_canvas_state")
        if not isinstance(local_canvas_state, dict):
            local_canvas_state = None
        return (
            copy.deepcopy([item for item in notes if isinstance(item, dict)]),
            copy.deepcopy(local_canvas_state) if isinstance(local_canvas_state, dict) else None,
        )
    except Exception as exc:
        _handle_runtime_db_exception(RUNTIME_USER_STATE_TABLE, "load", exc)
        return None, None


def _save_canvas_personal_notes_to_db(
    meeting_id: str,
    user_id: str,
    personal_notes: list[dict[str, Any]],
    local_canvas_state: dict[str, Any] | None = None,
) -> bool:
    client = _get_supabase_service_client()
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_user_id = _safe_text(user_id)
    if client is None or not normalized_meeting_id or not normalized_user_id:
        return False
    if _runtime_db_table_is_disabled(RUNTIME_USER_STATE_TABLE):
        return False

    try:
        with _SUPABASE_REQUEST_LOCK:
            client.table(RUNTIME_USER_STATE_TABLE).upsert(
                {
                    "meeting_id": normalized_meeting_id,
                    "user_id": normalized_user_id,
                    "personal_state": {
                        "personal_notes": copy.deepcopy(personal_notes or []),
                        "local_canvas_state": copy.deepcopy(local_canvas_state)
                        if isinstance(local_canvas_state, dict)
                        else {},
                    },
                    "updated_at": _utc_iso_now(),
                },
                on_conflict="meeting_id,user_id",
            ).execute()
        return True
    except Exception as exc:
        _handle_runtime_db_exception(RUNTIME_USER_STATE_TABLE, "save", exc)
        return False


def _warm_canvas_workspace_cache(rt: "RuntimeStore", meeting_id: str) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_meeting_id:
        return {}

    with rt.lock:
        cached = copy.deepcopy(rt.canvas_workspace_by_meeting.get(normalized_meeting_id) or {})
        if cached:
            return cached

    loaded = _load_canvas_workspace_from_db(normalized_meeting_id)
    if loaded:
        with rt.lock:
            rt.canvas_workspace_by_meeting[normalized_meeting_id] = copy.deepcopy(loaded)
        return copy.deepcopy(loaded)

    with rt.lock:
        return copy.deepcopy(_ensure_canvas_workspace_entry(rt, normalized_meeting_id))


def _payload_to_primitive(payload: Any) -> Any:
    if hasattr(payload, "model_dump"):
        try:
            return payload.model_dump()
        except Exception:
            pass
    if hasattr(payload, "dict"):
        try:
            return payload.dict()
        except Exception:
            pass
    return payload


def _canvas_llm_signature(payload: Any) -> str:
    return json.dumps(
        _payload_to_primitive(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _canvas_hash_signature(payload: Any) -> str:
    return hashlib.sha256(_canvas_llm_signature(payload).encode("utf-8")).hexdigest()


def _canvas_task_policy(task_type: str) -> CanvasTaskPolicy:
    normalized_task_type = _safe_text(task_type, "generic")
    policy = CANVAS_TASK_POLICIES.get(normalized_task_type)
    if policy:
        return policy
    return CanvasTaskPolicy(
        task_type=normalized_task_type,
        queue_name="generic",
        worker_name="generic-task",
        model_policy="default_json",
        cache_policy="signature",
        stale_policy="manual",
        output_policy="json",
        priority=10,
        description="등록되지 않은 일반 LLM 작업",
    )


def _canvas_task_policy_response(policy: CanvasTaskPolicy) -> dict[str, Any]:
    return {
        "task_type": policy.task_type,
        "queue_name": policy.queue_name,
        "worker_name": policy.worker_name,
        "model_policy": policy.model_policy,
        "cache_policy": policy.cache_policy,
        "stale_policy": policy.stale_policy,
        "output_policy": policy.output_policy,
        "priority": policy.priority,
        "description": policy.description,
    }


def _canvas_task_job_fields(task_type: str) -> dict[str, Any]:
    policy = _canvas_task_policy(task_type)
    return {
        "task_type": policy.task_type,
        "queue_name": policy.queue_name,
        "worker_name": policy.worker_name,
        "model_policy": policy.model_policy,
        "cache_policy": policy.cache_policy,
        "stale_policy": policy.stale_policy,
        "output_policy": policy.output_policy,
        "priority": policy.priority,
    }


def _canvas_task_signature_preview(raw: Any) -> str:
    signature = _safe_text(raw)
    if not signature:
        return ""
    if len(signature) <= 160:
        return signature
    return hashlib.sha256(signature.encode("utf-8")).hexdigest()


def _canvas_task_activity_type(task_type: str) -> str:
    normalized = _safe_text(task_type, "generic")
    if normalized in {"ideation.assimilate", "ideation.assimilate_preview"}:
        return "assimilate"
    if normalized == "ideation.topic_summary":
        return "extract"
    if normalized == "ideation.topic_clustering":
        return "cluster"
    if normalized == "ideation.recommend":
        return "recommend"
    if normalized == "problem.discussion":
        return "summarize"
    if normalized == "problem.definition":
        return "generate_problem"
    if normalized == "problem.conclusion":
        return "conclude"
    if normalized == "meeting.goal":
        return "generate_goal"
    if normalized == "solution.stage":
        return "generate_solution"
    return "task"


def _canvas_task_activity_base(task_type: str, target_count: int = 0) -> str:
    normalized = _safe_text(task_type, "generic")
    count = _safe_nonnegative_int(target_count)
    if normalized == "ideation.assimilate":
        return f"발화 {count}개를 아이디어로 정리" if count > 0 else "발화를 아이디어로 정리"
    if normalized == "ideation.assimilate_preview":
        return f"발화 {count}개 아이디어 정리안 계산" if count > 0 else "아이디어 정리안 계산"
    if normalized == "ideation.topic_summary":
        return "토픽 핵심 추출"
    if normalized == "ideation.topic_clustering":
        return "아이디어를 토픽으로 분류"
    if normalized == "ideation.recommend":
        return "아이디어 추천 생성"
    if normalized == "problem.discussion":
        return f"문제정의 발화 {count}개 정리" if count > 0 else "문제정의 발화 정리"
    if normalized == "problem.definition":
        return "문제정의 그룹 생성"
    if normalized == "problem.conclusion":
        return "문제정의 결론 갱신"
    if normalized == "meeting.goal":
        return "회의 목표 후보 생성"
    if normalized == "solution.stage":
        return "해결책 후보 생성"
    return "AI 작업 처리"


def _short_canvas_activity_reason(detail: Any) -> str:
    text = _safe_text(detail)
    if len(text) <= 48:
        return text
    return f"{text[:45]}..."


def _canvas_task_activity_line(
    task_type: str,
    status: str = "",
    detail: str = "",
    target_count: int = 0,
    stale_reason: str = "",
) -> str:
    normalized_status = _safe_text(status, "idle")
    base = _canvas_task_activity_base(task_type, target_count)
    if normalized_status == "queued":
        return f"{base} 대기"
    if normalized_status == "processing":
        return f"{base} 중"
    if normalized_status in {"error", "error_retryable", "error_final"}:
        reason = _short_canvas_activity_reason(detail)
        return f"{base} 실패: {reason}" if reason else f"{base} 실패"
    if normalized_status.startswith("stale_"):
        reason = _short_canvas_activity_reason(detail or stale_reason)
        return f"{base} 생략: {reason}" if reason else f"{base} 생략"
    if normalized_status == "missing":
        return f"{base} 기록 없음"
    if normalized_status == "idle":
        return f"{base} 대기"
    return base


def _upsert_canvas_task_record_locked(
    rt: "RuntimeStore",
    meeting_id: str,
    task_id: str = "",
    **fields: Any,
) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_meeting_id:
        return {}

    normalized_task_id = _safe_text(task_id) or uuid4().hex
    records = rt.canvas_task_records_by_meeting.setdefault(normalized_meeting_id, {})
    current = records.get(normalized_task_id) if isinstance(records.get(normalized_task_id), dict) else {}
    task_type = _safe_text(fields.get("task_type") or current.get("task_type"), "generic")
    now = _now_ts()
    current_status = _safe_text(fields.get("status") or current.get("status"), "processing")
    target_count = _safe_nonnegative_int(fields.get("target_count", current.get("target_count")))
    explicit_activity_line = _safe_text(fields.get("activity_line"))
    should_refresh_activity_line = bool(fields.get("status")) or bool(fields.get("detail")) or bool(fields.get("target_count"))
    activity_line = (
        explicit_activity_line
        or (
            _canvas_task_activity_line(
                task_type,
                current_status,
                _safe_text(fields.get("detail") or current.get("detail")),
                target_count,
                _safe_text(fields.get("stale_reason") or current.get("stale_reason")),
            )
            if should_refresh_activity_line or not _safe_text(current.get("activity_line"))
            else _safe_text(current.get("activity_line"))
        )
    )
    activity_type = _safe_text(fields.get("activity_type") or current.get("activity_type")) or _canvas_task_activity_type(task_type)

    record = {
        **current,
        **_canvas_task_job_fields(task_type),
        **fields,
        "task_id": normalized_task_id,
        "meeting_id": normalized_meeting_id,
        "status": current_status,
        "activity_type": activity_type,
        "activity_line": activity_line,
        "created_at": _safe_text(current.get("created_at") or fields.get("created_at"), now),
        "updated_at": now,
    }
    if not record.get("created_epoch"):
        record["created_epoch"] = float(fields.get("created_epoch") or time.time())
    if current_status in {"processing"} and not record.get("started_at"):
        record["started_at"] = now
        record["started_epoch"] = time.time()
    if current_status in {
        "completed",
        "error",
        "error_retryable",
        "error_final",
        "stale_superseded",
        "stale_obsolete",
        "stale_rebasable",
        "missing",
        "idle",
    }:
        record.setdefault("completed_at", now)
        record.setdefault("completed_epoch", time.time())
    started_epoch = float(record.get("started_epoch") or record.get("created_epoch") or 0)
    completed_epoch = float(record.get("completed_epoch") or 0)
    if started_epoch > 0 and completed_epoch >= started_epoch:
        record["duration_ms"] = int((completed_epoch - started_epoch) * 1000)

    records[normalized_task_id] = record
    if len(records) > CANVAS_TASK_RECORD_MAX:
        ordered = sorted(
            records.items(),
            key=lambda item: float((item[1] or {}).get("created_epoch") or 0),
        )
        for remove_id, _ in ordered[: max(0, len(records) - CANVAS_TASK_RECORD_MAX)]:
            records.pop(remove_id, None)
    return copy.deepcopy(record)


def _mark_canvas_task_record(
    rt: "RuntimeStore",
    meeting_id: str,
    task_id: str = "",
    **fields: Any,
) -> dict[str, Any]:
    with rt.lock:
        return _upsert_canvas_task_record_locked(rt, meeting_id, task_id, **fields)


def _is_active_canvas_task_status(status: str) -> bool:
    return _safe_text(status) in {"queued", "processing"}


def _canvas_task_record_matches_scope(record: dict[str, Any], task_type: str, scope_key: str) -> bool:
    return (
        _safe_text(record.get("task_type")) == _safe_text(task_type)
        and _safe_text(record.get("scope_key")) == _safe_text(scope_key, "default")
    )


def _supersede_older_canvas_task_scope_records(
    rt: "RuntimeStore",
    meeting_id: str,
    current_task_id: str,
    task_type: str,
    scope_key: str,
    input_signature: str,
) -> int:
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_current_task_id = _safe_text(current_task_id)
    normalized_task_type = _safe_text(task_type, "generic")
    normalized_scope_key = _safe_text(scope_key, "default")
    normalized_signature = _safe_text(input_signature)
    if not normalized_meeting_id or not normalized_current_task_id:
        return 0

    stale_detail = "더 최신 AI 요청으로 대체되었습니다."
    superseded_count = 0
    with rt.lock:
        records = rt.canvas_task_records_by_meeting.get(normalized_meeting_id)
        if not isinstance(records, dict):
            return 0
        current = records.get(normalized_current_task_id)
        if not isinstance(current, dict):
            return 0
        current_epoch = float(current.get("created_epoch") or time.time())
        for task_id, record in list(records.items()):
            if task_id == normalized_current_task_id or not isinstance(record, dict):
                continue
            if not _canvas_task_record_matches_scope(record, normalized_task_type, normalized_scope_key):
                continue
            if not _is_active_canvas_task_status(_safe_text(record.get("status"))):
                continue
            if _safe_text(record.get("target_signature")) == normalized_signature:
                continue
            record_epoch = float(record.get("created_epoch") or 0)
            if record_epoch > current_epoch:
                continue
            _upsert_canvas_task_record_locked(
                rt,
                normalized_meeting_id,
                task_id,
                status="stale_superseded",
                stale_reason="superseded",
                retryable=False,
                detail=stale_detail,
                warning=stale_detail,
            )
            superseded_count += 1
    return superseded_count


def _has_newer_canvas_task_scope_record(
    rt: "RuntimeStore",
    meeting_id: str,
    current_task_id: str,
    task_type: str,
    scope_key: str,
    input_signature: str,
) -> bool:
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_current_task_id = _safe_text(current_task_id)
    normalized_task_type = _safe_text(task_type, "generic")
    normalized_scope_key = _safe_text(scope_key, "default")
    normalized_signature = _safe_text(input_signature)
    if not normalized_meeting_id or not normalized_current_task_id:
        return False

    with rt.lock:
        records = rt.canvas_task_records_by_meeting.get(normalized_meeting_id)
        if not isinstance(records, dict):
            return False
        current = records.get(normalized_current_task_id)
        if not isinstance(current, dict):
            return False
        current_status = _safe_text(current.get("status"))
        if current_status.startswith("stale_"):
            return True
        current_epoch = float(current.get("created_epoch") or 0)
        for task_id, record in records.items():
            if task_id == normalized_current_task_id or not isinstance(record, dict):
                continue
            if not _canvas_task_record_matches_scope(record, normalized_task_type, normalized_scope_key):
                continue
            if _safe_text(record.get("target_signature")) == normalized_signature:
                continue
            if _safe_text(record.get("status")) not in {
                "queued",
                "processing",
                "completed",
                "error",
                "error_retryable",
                "error_final",
            }:
                continue
            if float(record.get("created_epoch") or 0) > current_epoch:
                return True
    return False


def _normalize_canvas_task_activity_events(raw_events: Any, limit: int = 12) -> list[dict[str, Any]]:
    if not isinstance(raw_events, list):
        return []

    events: list[dict[str, Any]] = []
    for raw_event in raw_events[:limit]:
        if not isinstance(raw_event, dict):
            continue
        summary = _safe_text(raw_event.get("summary"))
        if not summary:
            continue
        events.append(
            {
                "operation_id": _safe_text(raw_event.get("operation_id"))[:120],
                "operation_type": _safe_text(raw_event.get("operation_type"))[:80],
                "summary": summary[:240],
                "target_node_id": _safe_text(raw_event.get("target_node_id"))[:160],
                "source_node_ids": _dedup_canvas_operation_ids(raw_event.get("source_node_ids"), limit=80),
                "created_at": _safe_text(raw_event.get("created_at"))[:40],
            }
        )
    return events


def _canvas_task_record_response(record: dict[str, Any]) -> dict[str, Any]:
    task_type = _safe_text(record.get("task_type"), "generic")
    policy_fields = _canvas_task_job_fields(task_type)
    return {
        **policy_fields,
        "task_id": _safe_text(record.get("task_id")),
        "meeting_id": _safe_text(record.get("meeting_id")),
        "source": _safe_text(record.get("source")),
        "job_id": _safe_text(record.get("job_id")),
        "job_type": _safe_text(record.get("job_type")),
        "scope_key": _safe_text(record.get("scope_key")),
        "status": _safe_text(record.get("status"), "idle"),
        "activity_type": _safe_text(record.get("activity_type")) or _canvas_task_activity_type(task_type),
        "activity_line": _safe_text(record.get("activity_line")) or _canvas_task_activity_line(
            task_type,
            _safe_text(record.get("status"), "idle"),
            _safe_text(record.get("detail")),
            int(record.get("target_count") or 0),
            _safe_text(record.get("stale_reason")),
        ),
        "activity_events": _normalize_canvas_task_activity_events(record.get("activity_events")),
        "stale_reason": _safe_text(record.get("stale_reason")),
        "retryable": bool(record.get("retryable")),
        "detail": _safe_text(record.get("detail")),
        "warning": _safe_text(record.get("warning")),
        "cache_key": _safe_text(record.get("cache_key")),
        "cache_hit": bool(record.get("cache_hit")),
        "deduped": bool(record.get("deduped")),
        "input_signature": _safe_text(record.get("input_signature")),
        "pending_item_id": _safe_text(record.get("pending_item_id")),
        "resolved_node_id": _safe_text(record.get("resolved_node_id")),
        "target_count": int(record.get("target_count") or 0),
        "target_signature": _safe_text(record.get("target_signature")),
        "retry_count": _safe_nonnegative_int(record.get("retry_count")),
        "retry_after_epoch": _safe_operation_epoch(record.get("retry_after_epoch")),
        "retry_job_id": _safe_text(record.get("retry_job_id")),
        "retry_source_job_id": _safe_text(record.get("retry_source_job_id")),
        "created_at": _safe_text(record.get("created_at")),
        "updated_at": _safe_text(record.get("updated_at")),
        "started_at": _safe_text(record.get("started_at")),
        "completed_at": _safe_text(record.get("completed_at")),
        "duration_ms": int(record.get("duration_ms") or 0),
    }


def _canvas_task_job_summary(job: dict[str, Any], source: str = "") -> dict[str, Any]:
    normalized_source = _safe_text(source)
    task_type = _safe_text(job.get("task_type"))
    if not task_type:
        task_type = (
            "problem.discussion"
            if normalized_source == "canvas_problem"
            else _canvas_task_type_for_idea_job(_safe_text(job.get("job_type")))
        )
    policy_fields = _canvas_task_job_fields(task_type)
    return {
        **policy_fields,
        "task_id": _safe_text(job.get("task_id") or job.get("job_id")),
        "source": normalized_source,
        "job_id": _safe_text(job.get("job_id")),
        "meeting_id": _safe_text(job.get("meeting_id")),
        "job_type": _safe_text(job.get("job_type")),
        "scope_key": _safe_text(job.get("scope_key")),
        "status": _safe_text(job.get("status"), "idle"),
        "activity_type": _safe_text(job.get("activity_type")) or _canvas_task_activity_type(task_type),
        "activity_line": _safe_text(job.get("activity_line")) or _canvas_task_activity_line(
            task_type,
            _safe_text(job.get("status"), "idle"),
            _safe_text(job.get("detail")),
            int(job.get("target_count") or 0),
            _safe_text(job.get("stale_reason")),
        ),
        "activity_events": _normalize_canvas_task_activity_events(job.get("activity_events")),
        "stale_reason": _safe_text(job.get("stale_reason")),
        "retryable": bool(job.get("retryable")),
        "detail": _safe_text(job.get("detail")),
        "pending_item_id": _safe_text(job.get("pending_item_id")),
        "resolved_node_id": _safe_text(job.get("resolved_node_id")),
        "target_count": int(job.get("target_count") or 0),
        "target_signature": _safe_text(job.get("target_signature")),
        "retry_count": _safe_nonnegative_int(job.get("retry_count")),
        "retry_after_epoch": _safe_operation_epoch(job.get("retry_after_epoch")),
        "retry_job_id": _safe_text(job.get("retry_job_id")),
        "retry_source_job_id": _safe_text(job.get("retry_source_job_id")),
        "created_at": _safe_text(job.get("created_at")),
        "updated_at": _safe_text(job.get("updated_at")),
    }


def _canvas_task_type_for_idea_job(job_type: str) -> str:
    normalized_job_type = _safe_text(job_type)
    if normalized_job_type == "topic_summary":
        return "ideation.topic_summary"
    return "ideation.assimilate"


def _canvas_task_lock(rt: "RuntimeStore", task_type: str, kind: str) -> threading.Lock:
    policy = _canvas_task_policy(task_type)
    attr = "canvas_task_worker_locks" if kind == "worker" else "canvas_task_request_locks"
    lock_key = policy.queue_name
    with rt.lock:
        locks = getattr(rt, attr, None)
        if not isinstance(locks, dict):
            locks = {}
            setattr(rt, attr, locks)
        lock = locks.get(lock_key)
        if lock is None:
            lock = threading.Lock()
            locks[lock_key] = lock
        return lock


def _run_canvas_task_worker_inline(task_type: str, target: Callable[..., None], args: tuple[Any, ...]) -> None:
    lock = _canvas_task_lock(RT, task_type, "worker")
    with lock:
        target(*args)


def _start_canvas_task_worker(
    task_type: str,
    job_id: str,
    target: Callable[..., None],
    args: tuple[Any, ...],
) -> threading.Thread:
    policy = _canvas_task_policy(task_type)
    normalized_job_id = _safe_text(job_id) or uuid4().hex
    thread = threading.Thread(
        target=_run_canvas_task_worker_inline,
        args=(policy.task_type, target, args),
        daemon=True,
        name=f"canvas-{policy.worker_name}-{normalized_job_id[:8]}",
    )
    thread.start()
    return thread


def _run_canvas_task_cached_request(
    rt: "RuntimeStore",
    task_type: str,
    meeting_id: str,
    scope_key: str,
    signature: str,
    compute: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    policy = _canvas_task_policy(task_type)
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_scope_key = _safe_text(scope_key, "default")
    normalized_signature = _safe_text(signature)
    cache_key = f"{policy.task_type}:{normalized_scope_key}"
    task_id = uuid4().hex
    input_signature = _canvas_task_signature_preview(normalized_signature)
    _mark_canvas_task_record(
        rt,
        normalized_meeting_id,
        task_id,
        **_canvas_task_job_fields(policy.task_type),
        source="cached_request",
        activity_type=_canvas_task_activity_type(policy.task_type),
        activity_line=_canvas_task_activity_line(policy.task_type, "processing"),
        scope_key=normalized_scope_key,
        cache_key=cache_key,
        input_signature=input_signature,
        target_signature=input_signature,
        status="processing",
        detail="AI task 처리 중",
    )
    _supersede_older_canvas_task_scope_records(
        rt,
        normalized_meeting_id,
        task_id,
        policy.task_type,
        normalized_scope_key,
        input_signature,
    )
    task_meta: dict[str, Any] = {}
    try:
        if policy.cache_policy == "none":
            result = compute()
            task_meta["cache_hit"] = False
        else:
            result = _run_canvas_llm_cached_request(
                rt,
                normalized_meeting_id,
                cache_key,
                normalized_signature,
                compute,
                task_type=policy.task_type,
                task_meta=task_meta,
            )
    except Exception as exc:
        _mark_canvas_task_record(
            rt,
            normalized_meeting_id,
            task_id,
            status="error",
            detail=f"AI task 실패: {exc}",
            warning=_safe_text(exc),
        )
        raise

    if _has_newer_canvas_task_scope_record(
        rt,
        normalized_meeting_id,
        task_id,
        policy.task_type,
        normalized_scope_key,
        input_signature,
    ):
        stale_detail = "더 최신 AI 요청으로 대체되어 결과를 적용하지 않았습니다."
        stale_record = _mark_canvas_task_record(
            rt,
            normalized_meeting_id,
            task_id,
            status="stale_superseded",
            stale_reason="superseded",
            retryable=False,
            activity_type=_canvas_task_activity_type(policy.task_type),
            detail=stale_detail,
            warning=stale_detail,
            cache_hit=bool(task_meta.get("cache_hit")),
            deduped=bool(task_meta.get("deduped")),
        )
        if isinstance(result, dict):
            return {
                **result,
                **_canvas_task_job_fields(policy.task_type),
                "task_id": task_id,
                "cache_key": cache_key,
                "cache_hit": bool(task_meta.get("cache_hit")),
                "deduped": bool(task_meta.get("deduped")),
                "status": "stale_superseded",
                "stale_reason": "superseded",
                "retryable": False,
                "activity_type": _canvas_task_activity_type(policy.task_type),
                "activity_line": _safe_text(stale_record.get("activity_line")),
                "warning": stale_detail,
                "detail": stale_detail,
            }
        return result

    completed_record = _mark_canvas_task_record(
        rt,
        normalized_meeting_id,
        task_id,
        status="completed",
        activity_type=_canvas_task_activity_type(policy.task_type),
        activity_line=_canvas_task_activity_line(policy.task_type, "completed"),
        detail="AI task 완료",
        cache_hit=bool(task_meta.get("cache_hit")),
        deduped=bool(task_meta.get("deduped")),
    )
    if isinstance(result, dict):
        return {
            **result,
            **_canvas_task_job_fields(policy.task_type),
            "task_id": task_id,
            "cache_key": cache_key,
            "cache_hit": bool(task_meta.get("cache_hit")),
            "deduped": bool(task_meta.get("deduped")),
            "status": _safe_text(completed_record.get("status"), "completed"),
            "activity_type": _canvas_task_activity_type(policy.task_type),
            "activity_line": _safe_text(completed_record.get("activity_line"))
            or _canvas_task_activity_line(policy.task_type, "completed"),
        }
    return result


def _ensure_canvas_workspace_entry(rt: "RuntimeStore", meeting_id: str) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_meeting_id:
        return {}

    workspace = rt.canvas_workspace_by_meeting.get(normalized_meeting_id)
    if not isinstance(workspace, dict):
        workspace = {}
    workspace.setdefault("meeting_id", normalized_meeting_id)
    workspace.setdefault("meeting_goal", "")
    workspace.setdefault("meeting_goal_context", "")
    workspace.setdefault("stage", "ideation")
    workspace.setdefault("agenda_overrides", {})
    workspace.setdefault("canvas_items", [])
    workspace.setdefault("custom_groups", [])
    workspace.setdefault("problem_groups", [])
    workspace.setdefault("solution_topics", [])
    workspace.setdefault("final_solution_summary", _normalize_canvas_final_solution_summary({}))
    workspace.setdefault("node_positions", {})
    workspace.setdefault("idea_create_stack", 0)
    workspace.setdefault("idea_processed_utterance_ids", [])
    workspace.setdefault("problem_processed_utterance_ids", [])
    workspace.setdefault("operation_log", [])
    workspace.setdefault("node_lineage", {})
    workspace.setdefault("imported_state", None)
    workspace.setdefault("saved_at", "")
    workspace.setdefault("llm_cache", {})
    rt.canvas_workspace_by_meeting[normalized_meeting_id] = workspace
    return workspace


def _get_canvas_llm_cached_result(
    rt: "RuntimeStore",
    meeting_id: str,
    cache_key: str,
    signature: str,
) -> dict[str, Any] | None:
    workspace = _ensure_canvas_workspace_entry(rt, meeting_id)
    if not workspace:
        return None
    llm_cache = workspace.get("llm_cache")
    if not isinstance(llm_cache, dict):
        return None
    cached = llm_cache.get(cache_key)
    if not isinstance(cached, dict):
        return None
    if _safe_text(cached.get("signature")) != _safe_text(signature):
        return None
    result = cached.get("result")
    if not isinstance(result, dict):
        return None
    return copy.deepcopy(result)


def _set_canvas_llm_cached_result(
    rt: "RuntimeStore",
    meeting_id: str,
    cache_key: str,
    signature: str,
    result: dict[str, Any],
) -> None:
    workspace = _ensure_canvas_workspace_entry(rt, meeting_id)
    if not workspace:
        return
    llm_cache = workspace.get("llm_cache")
    if not isinstance(llm_cache, dict):
        llm_cache = {}
        workspace["llm_cache"] = llm_cache
    llm_cache[cache_key] = {
        "signature": _safe_text(signature),
        "generated_at": _now_ts(),
        "result": copy.deepcopy(result),
    }


def _get_canvas_llm_inflight_entry(
    rt: "RuntimeStore",
    meeting_id: str,
    cache_key: str,
) -> dict[str, Any] | None:
    meeting_entries = rt.canvas_llm_inflight_by_meeting.get(_safe_text(meeting_id))
    if not isinstance(meeting_entries, dict):
        return None
    entry = meeting_entries.get(_safe_text(cache_key))
    return entry if isinstance(entry, dict) else None


def _finish_canvas_llm_inflight_entry_locked(
    rt: "RuntimeStore",
    meeting_id: str,
    cache_key: str,
    signature: str,
    event: threading.Event | None,
    error: str = "",
) -> None:
    if event is None:
        return
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_cache_key = _safe_text(cache_key)
    normalized_signature = _safe_text(signature)
    meeting_entries = rt.canvas_llm_inflight_by_meeting.get(normalized_meeting_id) or {}
    inflight = meeting_entries.get(normalized_cache_key)
    is_current_inflight = (
        isinstance(inflight, dict)
        and _safe_text(inflight.get("signature")) == normalized_signature
        and inflight.get("event") is event
    )
    if is_current_inflight:
        if error:
            inflight["error"] = error
        meeting_entries.pop(normalized_cache_key, None)
        if not meeting_entries:
            rt.canvas_llm_inflight_by_meeting.pop(normalized_meeting_id, None)
    event.set()


def _run_canvas_llm_cached_request(
    rt: "RuntimeStore",
    meeting_id: str,
    cache_key: str,
    signature: str,
    compute: Callable[[], dict[str, Any]],
    task_type: str = "generic",
    task_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_cache_key = _safe_text(cache_key)
    normalized_signature = _safe_text(signature)
    if not normalized_meeting_id or not normalized_cache_key or not normalized_signature:
        return compute()

    _warm_canvas_workspace_cache(rt, normalized_meeting_id)

    while True:
        wait_event: threading.Event | None = None
        wait_error = ""
        should_compute = False

        with rt.lock:
            cached = _get_canvas_llm_cached_result(
                rt,
                normalized_meeting_id,
                normalized_cache_key,
                normalized_signature,
            )
            if cached:
                if task_meta is not None:
                    task_meta["cache_hit"] = True
                    task_meta["cache_key"] = normalized_cache_key
                return cached

            meeting_entries = rt.canvas_llm_inflight_by_meeting.setdefault(normalized_meeting_id, {})
            inflight = meeting_entries.get(normalized_cache_key)
            if (
                isinstance(inflight, dict)
                and _safe_text(inflight.get("signature")) == normalized_signature
                and isinstance(inflight.get("event"), threading.Event)
            ):
                wait_event = inflight["event"]
                wait_error = _safe_text(inflight.get("error"))
                if task_meta is not None:
                    task_meta["deduped"] = True
            else:
                wait_event = threading.Event()
                meeting_entries[normalized_cache_key] = {
                    "signature": normalized_signature,
                    "event": wait_event,
                    "error": "",
                }
                should_compute = True

        if not should_compute and wait_event is not None:
            wait_event.wait(timeout=90.0)
            with rt.lock:
                cached = _get_canvas_llm_cached_result(
                    rt,
                    normalized_meeting_id,
                    normalized_cache_key,
                    normalized_signature,
                )
                if cached:
                    if task_meta is not None:
                        task_meta["cache_hit"] = False
                        task_meta["deduped"] = True
                        task_meta["cache_key"] = normalized_cache_key
                    return cached

                inflight = _get_canvas_llm_inflight_entry(rt, normalized_meeting_id, normalized_cache_key)
                if (
                    isinstance(inflight, dict)
                    and _safe_text(inflight.get("signature")) == normalized_signature
                    and isinstance(inflight.get("event"), threading.Event)
                    and not inflight["event"].is_set()
                ):
                    continue
                wait_error = _safe_text((inflight or {}).get("error"), wait_error)

            if wait_error:
                raise RuntimeError(wait_error)
            continue

        try:
            request_lock = _canvas_task_lock(rt, task_type, "request")
            with request_lock:
                if task_meta is not None:
                    task_meta["cache_hit"] = False
                    task_meta["cache_key"] = normalized_cache_key
                result = compute()
        except Exception as exc:
            with rt.lock:
                _finish_canvas_llm_inflight_entry_locked(
                    rt,
                    normalized_meeting_id,
                    normalized_cache_key,
                    normalized_signature,
                    wait_event,
                    str(exc),
                )
            raise

        workspace_snapshot: dict[str, Any] | None = None
        with rt.lock:
            _set_canvas_llm_cached_result(
                rt,
                normalized_meeting_id,
                normalized_cache_key,
                normalized_signature,
                result,
            )
            workspace_snapshot = copy.deepcopy(
                _ensure_canvas_workspace_entry(rt, normalized_meeting_id),
            )
            _finish_canvas_llm_inflight_entry_locked(
                rt,
                normalized_meeting_id,
                normalized_cache_key,
                normalized_signature,
                wait_event,
            )
        if workspace_snapshot:
            _save_canvas_workspace_to_db(normalized_meeting_id, workspace_snapshot)
        return copy.deepcopy(result)


def _doc_freq(rows: list[dict[str, Any]]) -> Counter[str]:
    cnt: Counter[str] = Counter()
    for row in rows:
        seen = set(_keyword_tokens(_strip_leading_timestamp(row.get("text"))))
        for tok in seen:
            cnt[tok] += 1
    return cnt


def _top_keywords_from_rows(
    rows: list[dict[str, Any]],
    meeting_goal: str = "",
    limit: int = 6,
    global_doc_freq: Counter[str] | None = None,
    global_turn_count: int = 0,
) -> list[str]:
    banned = _tokens(meeting_goal)
    cnt: Counter[str] = Counter()
    for row in rows:
        text = _strip_leading_timestamp(row.get("text"))
        for tok in _keyword_tokens(text):
            if tok in banned:
                continue
            if global_doc_freq and global_turn_count > 0:
                if global_doc_freq.get(tok, 0) >= max(20, int(global_turn_count * 0.25)):
                    continue
            cnt[tok] += 1
    return [k for k, _ in cnt.most_common(limit)]


TITLE_NOISE_TOKENS = {
    "있는",
    "되는",
    "번째",
    "우리가",
    "굉장히",
    "아마",
    "내용",
    "부분",
    "정리",
    "사항",
    "진행",
    "완료",
    "중인",
    "관련",
    "논의",
    "이슈",
    "그니까",
    "보면",
    "어떻게",
    "좋은",
    "바로",
    "company",
    "companies",
    "thing",
    "things",
}

TITLE_TOKEN_MAP = {
    "company": "기업",
    "companies": "기업",
    "investment": "투자",
    "investments": "투자",
    "market": "시장",
    "economy": "경제",
    "policy": "정책",
    "startup": "스타트업",
    "startups": "스타트업",
}


def _normalize_keyword_token(raw_tok: str) -> str:
    tok = _safe_text(raw_tok).lower()
    if not tok:
        return ""
    tok = TITLE_TOKEN_MAP.get(tok, tok)
    # 조사/어미로 인한 파편화를 줄인다.
    for suf in ("으로", "에서", "에게", "처럼", "까지", "부터", "하고", "랑", "와", "과", "을", "를", "은", "는", "이", "가", "도", "로", "에"):
        if len(tok) > 2 and tok.endswith(suf):
            tok = tok[: -len(suf)]
            break
    return tok


def _is_title_keyword_noise(tok: str) -> bool:
    t = _normalize_keyword_token(tok)
    if not t:
        return True
    if t in STOPWORDS or t in TITLE_NOISE_TOKENS:
        return True
    if len(t) < 2:
        return True
    if re.fullmatch(r".*(하는|되는|있는|같은|보는|보면|좋은)$", t):
        return True
    if re.fullmatch(r"\d+", t):
        return True
    if re.fullmatch(r"(name|party)\d*", t):
        return True
    return False


def _usable_title_keywords(keywords: list[str] | None, meeting_goal: str) -> list[str]:
    goal_tokens = _tokens(meeting_goal)
    out: list[str] = []
    seen: set[str] = set()
    for raw in keywords or []:
        tok = _normalize_keyword_token(raw)
        if not tok or tok in seen:
            continue
        if tok in goal_tokens:
            continue
        if _is_title_keyword_noise(tok):
            continue
        seen.add(tok)
        out.append(tok)
    return out


def _is_low_quality_title(title: str, meeting_goal: str) -> bool:
    txt = _strip_leading_timestamp(title)
    if not txt:
        return True
    goal = _safe_text(meeting_goal)
    if goal and txt == goal:
        return True
    toks = [_normalize_keyword_token(t) for t in re.findall(r"[A-Za-z0-9가-힣]{2,}", txt.lower())]
    toks = [t for t in toks if t]
    meaningful = [t for t in toks if not _is_title_keyword_noise(t) and t not in _tokens(goal)]
    if not meaningful:
        return True
    ratio = len(meaningful) / max(1, len(toks))
    if ratio < 0.35:
        return True
    if len(txt) < 6:
        return True
    if "·" in txt or "|" in txt:
        return True
    if re.search(r"^안건\s*\d+", txt):
        return True
    if re.search(r"(관련\s*\S*\s*논의|핵심\s*쟁점|중심\s*논의|세부\s*쟁점)", txt):
        return True
    if re.search(r"\b(논의|이슈|쟁점)\s*$", txt) and len(meaningful) < 2:
        return True
    return False


def _clean_agenda_title(raw_title: Any, meeting_goal: str = "", keywords: list[str] | None = None) -> str:
    title = _strip_leading_timestamp(raw_title)
    title = re.sub(r"^[0-9]+[.)]\s*", "", title).strip(" -:|")
    title = re.sub(r"\s+", " ", title)
    if (not title) or _is_low_quality_title(title, meeting_goal):
        return ""
    return _safe_text(title[:80], "")


def _split_ts_prefix(line: str) -> tuple[str, str]:
    txt = _safe_text(line)
    m = re.match(
        r"^\[\s*((?:\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:\d{2}:\d{2}(?::\d{2})?))\s*\]\s*(.*)$",
        txt,
    )
    if m:
        return _safe_text(m.group(1)), _safe_text(m.group(2))
    return "", txt


def _to_summary_point(text: str, max_len: int | None = SUMMARY_POINT_TARGET_LEN) -> str:
    s = _strip_leading_timestamp(text)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(음|어|네|예|일단|그리고|근데|그니까|그러니까)\s+", "", s)
    s = re.sub(r"^(저는|제가|저희는|저희가)\s+", "", s)
    s = re.sub(r"(입니다|합니다|했어요|했습니다|같아요|같습니다)\s*$", "", s)
    s = s.strip(" .,!?:;")
    if max_len and max_len > 0 and len(s) > max_len:
        s = s[:max_len].rstrip()
    return _safe_text(s)


def _normalize_summary_item_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    for raw in lines:
        ts, body = _split_ts_prefix(raw)
        summary = _to_summary_point(body)
        if not summary:
            continue
        out.append(f"[{ts}] {summary}" if ts else summary)
    return _dedup_preserve(out, limit=20)


def _extractive_title_from_candidates(candidates: list[str], meeting_goal: str) -> str:
    cleaned = [_to_summary_point(_safe_text(c), max_len=None) for c in candidates if _safe_text(c).strip()]
    cleaned = [_safe_text(c).strip(" ,;:/") for c in cleaned if _safe_text(c).strip(" ,;:/")]
    if not cleaned:
        return ""
    cleaned = _dedup_preserve(cleaned, limit=40)

    goal_tokens = _tokens(meeting_goal)
    doc_freq: Counter[str] = Counter()
    sent_tokens: list[list[str]] = []
    for sent in cleaned:
        toks = [t for t in _keyword_tokens(sent) if t not in goal_tokens and not _is_title_keyword_noise(t)]
        uniq = list(dict.fromkeys(toks))
        sent_tokens.append(uniq)
        for tok in uniq:
            doc_freq[tok] += 1

    if not doc_freq:
        return cleaned[0]

    top_tokens = {tok for tok, _ in doc_freq.most_common(4)}
    ranked: list[tuple[float, str, list[str]]] = []
    for sent, toks in zip(cleaned, sent_tokens):
        if not toks:
            score = min(len(sent), 60) / 120.0
        else:
            coverage = sum(doc_freq[t] for t in toks)
            density = coverage / max(1, len(toks))
            top_hits = sum(1 for t in toks if t in top_tokens)
            score = density + (top_hits * 0.9) + (min(len(sent), 60) / 120.0)
        if _is_low_quality_title(sent, meeting_goal):
            score -= 1.5
        ranked.append((score, sent, toks))

    ranked.sort(key=lambda x: x[0], reverse=True)
    primary = ranked[0][1] if ranked else cleaned[0]
    primary_tokens = set(ranked[0][2]) if ranked else set()

    secondary = ""
    for _, sent, toks in ranked[1:]:
        if not sent:
            continue
        sim = _text_similarity(primary, sent)
        overlap = len(primary_tokens & set(toks))
        # 동일 문장 반복을 피하고, 다른 포인트를 한 줄에 결합하기 위한 보조 문장 선택
        if sim < 0.82 and overlap < max(2, len(primary_tokens)):
            secondary = sent
            break

    def _compact_clause(text: str, max_len: int = 36) -> str:
        s = _strip_leading_timestamp(text)
        s = re.sub(r"\s+", " ", s).strip(" ,;:/")
        s = re.sub(r"^(그리고|또|또한|다만|하지만|근데|그래서)\s+", "", s)
        s = re.split(r"\s*(?:;|/|·)\s*", s)[0]
        s = re.split(r"\s+(?:그리고|근데|하지만|다만)\s+", s)[0]
        if len(s) > max_len:
            s = s[:max_len].rstrip()
        return _safe_text(s)

    p = _compact_clause(primary)
    s = _compact_clause(secondary) if secondary else ""

    if p and s and p != s:
        merged = f"{p}, {s}"
    else:
        merged = p or s or primary

    merged = _safe_text(merged).strip(" ,;:/")
    if _is_low_quality_title(merged, meeting_goal):
        # 최후 폴백: 빈약한 한 문장 대신 상위 핵심어를 추출해 문장형으로 보정
        top_list = [tok for tok, _ in doc_freq.most_common(3)]
        if top_list:
            merged = f"{' '.join(top_list)}에 대한 논의"
    return _safe_text(merged)


def _finalize_agenda_title(
    raw_title: Any,
    meeting_goal: str,
    keywords: list[str],
    summary_items: list[str],
    key_utterances: list[str] | None = None,
) -> str:
    # 요구사항: 안건 구간 전체를 관통하는 상위 논지를 한 문장으로 요약해 제목으로 사용한다.
    candidates: list[str] = []

    for item in summary_items or []:
        _, body = _split_ts_prefix(item)
        sentence = _to_summary_point(body, max_len=None)
        if sentence:
            candidates.append(sentence)

    for item in key_utterances or []:
        _, body = _split_ts_prefix(item)
        sentence = _to_summary_point(body, max_len=None)
        if sentence:
            candidates.append(sentence)

    raw_clean = _to_summary_point(_safe_text(raw_title), max_len=None)
    if raw_clean and not _is_low_quality_title(raw_clean, meeting_goal):
        return _safe_text(raw_clean[:80], "주요 논의 요약")

    if raw_clean:
        candidates.append(raw_clean)

    best = _extractive_title_from_candidates(candidates, meeting_goal)
    if not best:
        best = raw_clean

    return _safe_text(best.strip(), "")


def _extract_json(raw: str) -> dict[str, Any]:
    txt = _safe_text(raw)
    if txt.startswith("```"):
        txt = txt.strip("`")
        if txt.lower().startswith("json"):
            txt = txt[4:].strip()
    try:
        data = json.loads(txt)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass
    l = txt.find("{")
    r = txt.rfind("}")
    if l >= 0 and r > l:
        try:
            data = json.loads(txt[l : r + 1])
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _looks_like_meeting_payload(payload: dict[str, Any]) -> tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, "JSON 최상위가 객체(dict)가 아닙니다."
    if "utterance" not in payload:
        return False, "필수 키 `utterance`가 없습니다."
    utterance = payload.get("utterance")
    if not isinstance(utterance, list):
        return False, "`utterance`는 배열(list)이어야 합니다."
    if len(utterance) == 0:
        return False, "`utterance`가 비어 있습니다."
    return True, ""


def _speaker_profile_label(age: Any, occupation: Any, role: Any, fallback_id: str) -> str:
    parts = [_safe_text(age), _safe_text(occupation), _safe_text(role)]
    label = " ".join([p for p in parts if p]).strip()
    return label if label else _safe_text(fallback_id, "화자")


def _parse_meeting_json_payload(payload: dict[str, Any]) -> tuple[str | None, list[dict[str, str]]]:
    metadata = payload.get("metadata") or {}
    meeting_goal = _safe_text(metadata.get("topic"))

    speaker_map: dict[str, str] = {}
    for spk in payload.get("speaker") or []:
        if not isinstance(spk, dict):
            continue
        sid = _safe_text(spk.get("id"))
        if not sid:
            continue
        speaker_map[sid] = _speaker_profile_label(spk.get("age"), spk.get("occupation"), spk.get("role"), sid)

    rows = []
    for utt in payload.get("utterance") or []:
        if not isinstance(utt, dict):
            continue
        text = _safe_text(utt.get("original_form")) or _safe_text(utt.get("form"))
        if not text:
            continue
        sid = _safe_text(utt.get("speaker_id"))
        speaker = speaker_map.get(sid) or _safe_text(sid, "화자")
        timestamp = _sec_to_ts(utt.get("start"))
        rows.append(
            {
                "speaker": speaker,
                "text": text,
                "timestamp": timestamp,
            }
        )

    rows.sort(key=lambda x: x.get("timestamp", ""))
    return (meeting_goal if meeting_goal else None), rows


class ConfigInput(BaseModel):
    meeting_goal: str = ""
    window_size: int = Field(default=12, ge=4, le=80)


class UtteranceInput(BaseModel):
    speaker: str = "화자"
    text: str
    timestamp: str | None = None


class ImportDirInput(BaseModel):
    folder: str = "dataset/economy"
    recursive: bool = True
    reset_state: bool = True
    auto_tick: bool = True
    max_files: int = Field(default=500, ge=1, le=2000)


class ReplayStepInput(BaseModel):
    lines: int = Field(default=1, ge=1, le=100)
    auto_analyze: bool = True


class TranscriptSyncItemInput(BaseModel):
    speaker: str = "화자"
    text: str
    timestamp: str | None = None


class TranscriptSyncInput(BaseModel):
    meeting_goal: str = ""
    window_size: int = Field(default=12, ge=4, le=80)
    reset_state: bool = True
    auto_analyze: bool = True
    transcript: list[TranscriptSyncItemInput] = Field(default_factory=list)


class SttFlowSummaryTurnInput(BaseModel):
    speaker: str = "화자"
    text: str = ""
    timestamp: str | None = None


class SttFlowSummaryInput(BaseModel):
    meeting_id: str = ""
    turns: list[SttFlowSummaryTurnInput] = Field(default_factory=list, min_length=1, max_length=6)
    max_chars: int = Field(default=30, ge=8, le=60)


class CanvasPlacementConfirmInput(BaseModel):
    tool: str = "note"
    ui_x: float = 0.0
    ui_y: float = 0.0
    flow_x: float = 0.0
    flow_y: float = 0.0
    agenda_id: str = ""
    point_id: str = ""
    title: str = ""
    body: str = ""


class ProblemDefinitionAgendaInput(BaseModel):
    agenda_id: str
    title: str
    keywords: list[str] = Field(default_factory=list)
    summary_bullets: list[str] = Field(default_factory=list)


class ProblemDefinitionIdeaInput(BaseModel):
    id: str
    agenda_id: str
    kind: str = "note"
    title: str = ""
    body: str = ""


class ProblemDefinitionGenerateInput(BaseModel):
    meeting_id: str = ""
    topic: str = ""
    agendas: list[ProblemDefinitionAgendaInput] = Field(default_factory=list)
    source_group_id: str = ""
    source_group_title: str = ""
    ideas: list[ProblemDefinitionIdeaInput] = Field(default_factory=list)


class ProblemConclusionIdeaInput(BaseModel):
    id: str = ""
    kind: str = "note"
    title: str = ""
    body: str = ""


class ProblemConclusionGroupInput(BaseModel):
    group_id: str = ""
    topic: str = ""
    insight_lens: str = ""
    agenda_titles: list[str] = Field(default_factory=list)
    source_summary_items: list[str] = Field(default_factory=list)
    ideas: list[ProblemConclusionIdeaInput] = Field(default_factory=list)


class ProblemConclusionGenerateInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    group: ProblemConclusionGroupInput


class MeetingGoalGenerateInput(BaseModel):
    meeting_id: str = ""
    topic: str = ""


class CanvasIdeaAssimilationUtteranceInput(BaseModel):
    id: str = ""
    speaker: str = ""
    text: str = ""
    timestamp: str = ""


class CanvasRefinedUtteranceInput(BaseModel):
    utterance_id: str = ""
    speaker: str = ""
    text: str = ""
    timestamp: str = ""


class CanvasIdeaAssimilationIdeaInput(BaseModel):
    id: str = ""
    title: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    key_evidence: list[str] = Field(default_factory=list)
    refined_utterances: list[CanvasRefinedUtteranceInput] = Field(default_factory=list)
    evidence_utterance_ids: list[str] = Field(default_factory=list)
    auto_summary_disabled: bool = False
    user_edited: bool = False


class CanvasIdeaAssimilationInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    selected_agenda_id: str = ""
    context_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)
    target_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)
    existing_ideas: list[CanvasIdeaAssimilationIdeaInput] = Field(default_factory=list)


class SolutionStageTopicInput(BaseModel):
    group_id: str
    topic_no: int = 0
    topic: str
    conclusion: str = ""


class SolutionStageGenerateInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    topics: list[SolutionStageTopicInput] = Field(default_factory=list)


class IdeationSuggestionTopicInput(BaseModel):
    id: str = ""
    title: str = ""
    body: str = ""
    keywords: list[str] = Field(default_factory=list)


class IdeationSuggestionChildInput(BaseModel):
    id: str = ""
    kind: str = "note"
    title: str = ""
    body: str = ""
    keywords: list[str] = Field(default_factory=list)


class IdeationSuggestionGenerateInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    topic: IdeationSuggestionTopicInput = Field(default_factory=IdeationSuggestionTopicInput)
    child_items: list[IdeationSuggestionChildInput] = Field(default_factory=list)


class CanvasIdeationSuggestionInput(BaseModel):
    id: str = ""
    text: str = ""
    status: str = "draft"


class CanvasWorkspaceIdeaInput(BaseModel):
    id: str = ""
    kind: str = "note"
    title: str = ""
    body: str = ""


class CanvasProblemDiscussionInput(BaseModel):
    id: str = ""
    parent_group_id: str = ""
    target_node_id: str = ""
    target_node_label: str = ""
    target_node_kind: str = ""
    title: str = ""
    body: str = ""
    keywords: list[str] = Field(default_factory=list)
    key_evidence: list[str] = Field(default_factory=list)
    refined_utterances: list[CanvasRefinedUtteranceInput] = Field(default_factory=list)
    evidence_utterance_ids: list[str] = Field(default_factory=list)
    ignored_utterance_ids: list[str] = Field(default_factory=list)
    ai_pending: bool = False
    ai_generated: bool = False
    user_edited: bool = False
    created_by: str = ""
    created_at: str = ""


class CanvasWorkspaceCanvasItemInput(BaseModel):
    id: str = ""
    agenda_id: str = ""
    point_id: str = ""
    kind: str = "note"
    status: str = "discussion"
    title: str = ""
    body: str = ""
    keywords: list[str] = Field(default_factory=list)
    key_evidence: list[str] = Field(default_factory=list)
    refined_utterances: list[CanvasRefinedUtteranceInput] = Field(default_factory=list)
    evidence_utterance_ids: list[str] = Field(default_factory=list)
    ignored_utterance_ids: list[str] = Field(default_factory=list)
    merged_children: list[dict[str, Any]] = Field(default_factory=list)
    compacted_from_ids: list[str] = Field(default_factory=list)
    compaction_level: int = 0
    parent_topic_id: str = ""
    parent_topic_source: str = ""
    parent_topic_locked: bool = False
    child_item_ids: list[str] = Field(default_factory=list)
    topic_collapsed: bool = False
    auto_summary_disabled: bool = False
    created_by: str = ""
    manual_position: bool = False
    ai_generated: bool = False
    user_edited: bool = False
    ai_pending: bool = False
    ai_suggestions: list[CanvasIdeationSuggestionInput] = Field(default_factory=list)
    x: float | None = None
    y: float | None = None


class CanvasIdeaAssimilationWorkspaceStartInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    selected_agenda_id: str = ""
    context_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)
    target_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)


class CanvasTopicSummaryWorkspaceStartInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    topic_item_id: str = ""


class CanvasProblemDiscussionWorkspaceStartInput(BaseModel):
    meeting_id: str = ""
    meeting_topic: str = ""
    selected_group_id: str = ""
    context_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)
    target_utterances: list[CanvasIdeaAssimilationUtteranceInput] = Field(default_factory=list)


class CanvasCustomGroupInput(BaseModel):
    id: str = ""
    title: str = ""
    description: str = ""
    keywords: list[str] = Field(default_factory=list)
    color: str = ""
    created_by: str = ""
    created_at: str = ""


class CanvasPersonalNoteInput(BaseModel):
    id: str = ""
    project_id: str = ""
    agenda_id: str = ""
    linked_canvas_item_id: str = ""
    linked_canvas_item_title: str = ""
    kind: str = "note"
    title: str = ""
    body: str = ""


class CanvasNodePositionInput(BaseModel):
    x: float = 0
    y: float = 0


class CanvasWorkspaceProblemGroupInput(BaseModel):
    group_id: str = ""
    topic: str = ""
    insight_lens: str = ""
    insight_user_edited: bool = False
    keywords: list[str] = Field(default_factory=list)
    agenda_ids: list[str] = Field(default_factory=list)
    agenda_titles: list[str] = Field(default_factory=list)
    source_group_id: str = ""
    source_group_title: str = ""
    ideas: list[CanvasWorkspaceIdeaInput] = Field(default_factory=list)
    source_child_item_ids: list[str] = Field(default_factory=list)
    discussion_items: list[CanvasProblemDiscussionInput] = Field(default_factory=list)
    linked_group_ids: list[str] = Field(default_factory=list)
    source_summary_items: list[str] = Field(default_factory=list)
    conclusion: str = ""
    conclusion_user_edited: bool = False
    status: str = "draft"
    source_signature: str = ""
    source_agenda_signatures: dict[str, str] = Field(default_factory=dict)
    source_idea_signatures: dict[str, str] = Field(default_factory=dict)


class CanvasWorkspaceSolutionTopicInput(BaseModel):
    group_id: str = ""
    topic_no: int = 0
    topic: str = ""
    conclusion: str = ""
    ideas: list[str] = Field(default_factory=list)
    status: str = "draft"
    problem_topic: str = ""
    problem_insight: str = ""
    problem_conclusion: str = ""
    problem_keywords: list[str] = Field(default_factory=list)
    agenda_titles: list[str] = Field(default_factory=list)
    ai_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    notes: list[dict[str, Any]] = Field(default_factory=list)


class CanvasWorkspaceStateInput(BaseModel):
    meeting_id: str = ""
    meeting_goal: str = ""
    meeting_goal_context: str = ""
    stage: str = "ideation"
    agenda_overrides: dict[str, dict[str, Any]] = Field(default_factory=dict)
    canvas_items: list[CanvasWorkspaceCanvasItemInput] = Field(default_factory=list)
    custom_groups: list[CanvasCustomGroupInput] = Field(default_factory=list)
    problem_groups: list[CanvasWorkspaceProblemGroupInput] = Field(default_factory=list)
    solution_topics: list[CanvasWorkspaceSolutionTopicInput] = Field(default_factory=list)
    final_solution_summary: dict[str, Any] = Field(default_factory=dict)
    node_positions: dict[str, dict[str, CanvasNodePositionInput]] = Field(default_factory=dict)
    imported_state: dict[str, Any] | None = None


class CanvasWorkspacePatchInput(BaseModel):
    meeting_id: str = ""
    meeting_goal: str | None = None
    meeting_goal_context: str | None = None
    stage: str | None = None
    agenda_overrides: dict[str, dict[str, Any]] | None = None
    canvas_items: list[CanvasWorkspaceCanvasItemInput] | None = None
    custom_groups: list[CanvasCustomGroupInput] | None = None
    problem_groups: list[CanvasWorkspaceProblemGroupInput] | None = None
    solution_topics: list[CanvasWorkspaceSolutionTopicInput] | None = None
    final_solution_summary: dict[str, Any] | None = None
    node_positions: dict[str, dict[str, CanvasNodePositionInput]] | None = None
    imported_state: dict[str, Any] | None = None


class CanvasPersonalNotesStateInput(BaseModel):
    meeting_id: str = ""
    user_id: str = ""
    personal_notes: list[CanvasPersonalNoteInput] = Field(default_factory=list)
    local_canvas_state: dict[str, Any] | None = None


@dataclass(frozen=True)
class CanvasTaskPolicy:
    task_type: str
    queue_name: str
    worker_name: str
    model_policy: str
    cache_policy: str
    stale_policy: str
    output_policy: str
    priority: int
    description: str = ""


CANVAS_TASK_POLICIES: dict[str, CanvasTaskPolicy] = {
    "ideation.assimilate": CanvasTaskPolicy(
        task_type="ideation.assimilate",
        queue_name="ideation_realtime",
        worker_name="idea-assimilation",
        model_policy="fast_json",
        cache_policy="none",
        stale_policy="utterance_dedupe",
        output_policy="workspace_patch",
        priority=90,
        description="전사 발화를 아이디어 노드로 정리하거나 기존 노드에 병합",
    ),
    "ideation.assimilate_preview": CanvasTaskPolicy(
        task_type="ideation.assimilate_preview",
        queue_name="ideation_preview",
        worker_name="idea-assimilation-preview",
        model_policy="fast_json",
        cache_policy="signature",
        stale_policy="input_signature",
        output_policy="structured_update",
        priority=45,
        description="workspace 적용 없이 발화-아이디어 병합 결과만 미리 계산",
    ),
    "ideation.topic_summary": CanvasTaskPolicy(
        task_type="ideation.topic_summary",
        queue_name="topic_summary",
        worker_name="topic-summary",
        model_policy="fast_json",
        cache_policy="signature",
        stale_policy="latest_by_topic_signature",
        output_policy="patch",
        priority=50,
        description="topic 노드의 제목, content, 키워드 요약",
    ),
    "ideation.topic_clustering": CanvasTaskPolicy(
        task_type="ideation.topic_clustering",
        queue_name="topic_clustering",
        worker_name="topic-clustering",
        model_policy="fast_json",
        cache_policy="short_signature",
        stale_policy="latest_by_agenda",
        output_policy="workspace_patch",
        priority=35,
        description="아이디어 노드를 topic 계층으로 묶거나 재배치",
    ),
    "ideation.recommend": CanvasTaskPolicy(
        task_type="ideation.recommend",
        queue_name="recommendation",
        worker_name="idea-recommendation",
        model_policy="cheap_fast_json",
        cache_policy="short_signature",
        stale_policy="focus_context",
        output_policy="suggestion",
        priority=40,
        description="선택 topic 기준 아이디어 추천",
    ),
    "problem.discussion": CanvasTaskPolicy(
        task_type="problem.discussion",
        queue_name="problem_discussion",
        worker_name="problem-discussion",
        model_policy="fast_json",
        cache_policy="none",
        stale_policy="utterance_dedupe",
        output_policy="workspace_patch",
        priority=80,
        description="문제정의 단계 발화를 의견 노드로 정리",
    ),
    "problem.definition": CanvasTaskPolicy(
        task_type="problem.definition",
        queue_name="problem_definition",
        worker_name="problem-definition",
        model_policy="strong_json",
        cache_policy="signature",
        stale_policy="source_signature",
        output_policy="structured_groups",
        priority=70,
        description="아이디어 트리에서 문제정의 그룹 생성",
    ),
    "problem.conclusion": CanvasTaskPolicy(
        task_type="problem.conclusion",
        queue_name="problem_conclusion",
        worker_name="problem-conclusion",
        model_policy="fast_json",
        cache_policy="signature",
        stale_policy="group_signature",
        output_policy="structured_text",
        priority=60,
        description="문제정의 그룹의 insight와 결론 생성",
    ),
    "meeting.goal": CanvasTaskPolicy(
        task_type="meeting.goal",
        queue_name="meeting_goal",
        worker_name="meeting-goal",
        model_policy="cheap_fast_json",
        cache_policy="signature",
        stale_policy="topic_signature",
        output_policy="structured_text",
        priority=55,
        description="회의 제목에서 회의 목표 후보 생성",
    ),
    "solution.stage": CanvasTaskPolicy(
        task_type="solution.stage",
        queue_name="solution_stage",
        worker_name="solution-stage",
        model_policy="strong_json",
        cache_policy="signature",
        stale_policy="problem_groups_signature",
        output_policy="structured_topics",
        priority=70,
        description="문제정의 그룹에서 해결책 후보 생성",
    ),
}


@dataclass
class RuntimeStore:
    lock: threading.Lock = field(default_factory=threading.Lock)
    llm_io_lock: threading.Lock = field(default_factory=threading.Lock)
    canvas_llm_request_lock: threading.Lock = field(default_factory=threading.Lock)
    meeting_goal: str = ""
    window_size: int = 12
    transcript: list[dict[str, str]] = field(default_factory=list)
    agenda_outcomes: list[dict[str, Any]] = field(default_factory=list)
    llm_enabled: bool = False
    last_analyzed_count: int = 0
    agenda_seq: int = 0
    stt_chunk_seq: int = 0
    used_local_fallback: bool = False
    last_analysis_warning: str = ""
    last_tick_mode: str = "windowed"
    last_title_refine_attempts: int = 0
    last_title_refine_success: int = 0
    last_llm_parsed_json: dict[str, Any] = field(default_factory=dict)
    last_llm_parsed_at: str = ""
    replay_rows: list[dict[str, str]] = field(default_factory=list)
    replay_index: int = 0
    replay_source: str = ""
    replay_loaded_at: str = ""
    analysis_task_seq: int = 0
    analysis_queued: int = 0
    analysis_inflight: bool = False
    analysis_last_enqueued_at: str = ""
    analysis_last_started_at: str = ""
    analysis_last_done_at: str = ""
    analysis_last_error: str = ""
    analysis_last_enqueued_id: int = 0
    analysis_last_started_id: int = 0
    analysis_last_done_id: int = 0
    analysis_generation: int = 0
    transcript_version: int = 0
    analysis_next_windowed_target: int = SUMMARY_INTERVAL
    llm_io_seq: int = 0
    llm_io_logs: list[dict[str, Any]] = field(default_factory=list)
    canvas_last_placement: dict[str, Any] = field(default_factory=dict)
    canvas_workspace_by_meeting: dict[str, dict[str, Any]] = field(default_factory=dict)
    canvas_llm_inflight_by_meeting: dict[str, dict[str, Any]] = field(default_factory=dict)
    canvas_task_records_by_meeting: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    canvas_task_request_locks: dict[str, threading.Lock] = field(default_factory=dict)
    canvas_task_worker_locks: dict[str, threading.Lock] = field(default_factory=dict)
    canvas_idea_jobs_by_meeting: dict[str, dict[str, Any]] = field(default_factory=dict)
    canvas_problem_jobs_by_meeting: dict[str, dict[str, Any]] = field(default_factory=dict)
    canvas_personal_notes_by_meeting_user: dict[str, dict[str, list[dict[str, Any]]]] = field(default_factory=dict)
    canvas_local_state_by_meeting_user: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)

    def reset(self) -> None:
        self.meeting_goal = ""
        self.window_size = 12
        self.transcript = []
        self.agenda_outcomes = []
        self.last_analyzed_count = 0
        self.agenda_seq = 0
        self.stt_chunk_seq = 0
        self.used_local_fallback = False
        self.last_analysis_warning = ""
        self.last_tick_mode = "windowed"
        self.last_title_refine_attempts = 0
        self.last_title_refine_success = 0
        self.last_llm_parsed_json = {}
        self.last_llm_parsed_at = ""
        self.replay_rows = []
        self.replay_index = 0
        self.replay_source = ""
        self.replay_loaded_at = ""
        self.analysis_task_seq = 0
        self.analysis_queued = 0
        self.analysis_inflight = False
        self.analysis_last_enqueued_at = ""
        self.analysis_last_started_at = ""
        self.analysis_last_done_at = ""
        self.analysis_last_error = ""
        self.analysis_last_enqueued_id = 0
        self.analysis_last_started_id = 0
        self.analysis_last_done_id = 0
        self.analysis_generation += 1
        self.transcript_version = 0
        self.analysis_next_windowed_target = SUMMARY_INTERVAL
        self.llm_io_seq = 0
        self.llm_io_logs = []
        self.canvas_last_placement = {}
        self.canvas_workspace_by_meeting = {}
        self.canvas_llm_inflight_by_meeting = {}
        self.canvas_task_records_by_meeting = {}
        self.canvas_task_request_locks = {}
        self.canvas_task_worker_locks = {}
        self.canvas_idea_jobs_by_meeting = {}
        self.canvas_problem_jobs_by_meeting = {}
        self.canvas_personal_notes_by_meeting_user = {}
        self.canvas_local_state_by_meeting_user = {}


@dataclass
class AudioImportJob:
    job_id: str
    meeting_id: str
    user_id: str
    filename: str
    status: str = "queued"
    progress: float = 0.0
    step: str = "queued"
    detail: str = ""
    created_at: str = field(default_factory=lambda: _now_ts())
    updated_at: str = field(default_factory=lambda: _now_ts())
    transcript_count: int = 0
    speaker_count: int = 0
    used_diarization: bool = False
    warning: str = ""
    error: str = ""
    state: dict[str, Any] | None = None


RT = RuntimeStore()
ANALYSIS_QUEUE: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=2048)
ANALYSIS_WORKER_STARTED = False
_PYANNOTE_PIPELINE = None
_PYANNOTE_LOCK = threading.Lock()
_AUDIO_IMPORT_JOBS: dict[str, AudioImportJob] = {}
_AUDIO_IMPORT_JOBS_LOCK = threading.Lock()


def _analysis_worker_status(rt: RuntimeStore) -> dict[str, Any]:
    observed_waiting = max(0, int(ANALYSIS_QUEUE.qsize()))
    observed_total = observed_waiting + (1 if rt.analysis_inflight else 0)
    logical_total = int(max(0, rt.analysis_queued))
    display_total = max(logical_total, observed_total)
    return {
        "inflight": bool(rt.analysis_inflight),
        "queued": int(display_total),
        "queued_logical": int(logical_total),
        "queued_observed": int(observed_total),
        "last_enqueued_id": int(rt.analysis_last_enqueued_id),
        "last_started_id": int(rt.analysis_last_started_id),
        "last_done_id": int(rt.analysis_last_done_id),
        "last_enqueued_at": _safe_text(rt.analysis_last_enqueued_at),
        "last_started_at": _safe_text(rt.analysis_last_started_at),
        "last_done_at": _safe_text(rt.analysis_last_done_at),
        "last_error": _safe_text(rt.analysis_last_error),
    }


def _truncate_text(raw: Any, limit: int = LLM_IO_PREVIEW_MAX) -> str:
    s = _safe_text(raw)
    if len(s) <= limit:
        return s
    return _safe_text(s[: max(0, limit - 1)] + "…")


def _append_llm_io_log(rt: RuntimeStore, direction: str, stage: str, payload: Any, meta: dict[str, Any] | None = None) -> None:
    with rt.llm_io_lock:
        rt.llm_io_seq += 1
        preview = _truncate_text(payload)
        entry = {
            "seq": int(rt.llm_io_seq),
            "at": _now_ts(),
            "direction": _safe_text(direction),
            "stage": _safe_text(stage),
            "payload": preview,
            "meta": dict(meta or {}),
        }
        rt.llm_io_logs.append(entry)
        if len(rt.llm_io_logs) > LLM_IO_LOG_MAX:
            rt.llm_io_logs = rt.llm_io_logs[-LLM_IO_LOG_MAX:]


def _call_llm_json(
    rt: RuntimeStore,
    client: Any,
    prompt: str,
    stage: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    _append_llm_io_log(
        rt,
        direction="request",
        stage=stage,
        payload=prompt,
        meta={"temperature": temperature, "max_tokens": max_tokens},
    )
    try:
        parsed = client.generate_json(prompt, temperature=temperature, max_tokens=max_tokens)
    except Exception as exc:
        _append_llm_io_log(rt, direction="error", stage=stage, payload=str(exc), meta={})
        raise
    try:
        payload = json.dumps(parsed, ensure_ascii=False)
    except Exception:
        payload = str(parsed)
    _append_llm_io_log(rt, direction="response", stage=stage, payload=payload, meta={})
    return parsed


def _md_text(raw: Any) -> str:
    return re.sub(r"\s+", " ", _safe_text(raw)).strip()


def _compact_problem_source_text(raw: Any, max_chars: int = 140) -> str:
    text = re.sub(r"\s+", " ", _safe_text(raw)).strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "..."


def _build_problem_definition_groups_local(payload: ProblemDefinitionGenerateInput) -> list[dict[str, Any]]:
    agendas = payload.agendas or []
    ideas = payload.ideas or []
    if not agendas and not ideas:
        return []

    agenda_by_id = {_safe_text(agenda.agenda_id): agenda for agenda in agendas if _safe_text(agenda.agenda_id)}
    source_group_id = _safe_text(payload.source_group_id)
    source_group_title = _safe_text(payload.source_group_title)
    if not source_group_id and len(agendas) == 1:
        source_group_id = _safe_text(agendas[0].agenda_id)
    if not source_group_title and len(agendas) == 1:
        source_group_title = _safe_text(agendas[0].title)
    normalized_ideas: list[dict[str, Any]] = []
    for idea in ideas:
        idea_id = _safe_text(idea.id)
        title = _safe_text(idea.title)
        body = _safe_text(idea.body)
        if not idea_id or not (title or body):
            continue
        normalized_ideas.append(
            {
                "id": idea_id,
                "agenda_id": _safe_text(idea.agenda_id),
                "kind": _safe_text(idea.kind, "note"),
                "title": title,
                "body": body,
            }
        )

    def build_group(group_index: int, source_ideas: list[dict[str, Any]]) -> dict[str, Any]:
        source_ids = [_safe_text(idea.get("id")) for idea in source_ideas if _safe_text(idea.get("id"))]
        agenda_ids = list(dict.fromkeys([_safe_text(idea.get("agenda_id")) for idea in source_ideas if _safe_text(idea.get("agenda_id"))]))
        agenda_titles = [
            _safe_text(agenda_by_id.get(agenda_id).title)
            for agenda_id in agenda_ids
            if agenda_by_id.get(agenda_id)
        ]
        keyword_candidates: list[str] = []
        for idea in source_ideas:
            keyword_candidates.extend(_keyword_tokens(_safe_text(idea.get("title"))))
            keyword_candidates.extend(_keyword_tokens(_safe_text(idea.get("body"))))
        keywords = [
            tok
            for tok in ([_normalize_keyword_token(item) for item in keyword_candidates])
            if tok and not _is_title_keyword_noise(tok)
        ]
        keywords = list(dict.fromkeys(keywords))[:8]
        topic_seed = keywords[0] if keywords else source_ideas[0].get("title") if source_ideas else f"주제 {group_index}"
        summaries = [
            _to_summary_point(
                " ".join([_safe_text(idea.get("title")), _safe_text(idea.get("body"))]).strip(),
                max_len=80,
            )
            for idea in source_ideas
        ]
        summaries = [_safe_text(item) for item in summaries if _safe_text(item)]
        return {
            "group_id": f"problem-group-{group_index}",
            "topic": _normalize_problem_topic_label(topic_seed, _safe_text(topic_seed, f"주제 {group_index}")),
            "insight_lens": "원본 아이디어의 공통 문제 관점",
            "keywords": keywords[:6],
            "agenda_ids": agenda_ids,
            "agenda_titles": agenda_titles,
            "source_group_id": source_group_id or (agenda_ids[0] if agenda_ids else ""),
            "source_group_title": source_group_title or (agenda_titles[0] if agenda_titles else ""),
            "ideas": source_ideas[:24],
            "source_child_item_ids": source_ids,
            "source_summary_items": summaries[:8],
            "conclusion": summaries[0] if summaries else f"{_safe_text(topic_seed)} 방향 구체화",
        }

    if normalized_ideas:
        fallback_groups: list[list[dict[str, Any]]] = []
        for idea in normalized_ideas:
            idea_tokens = set(_keyword_tokens(_safe_text(idea.get("title"))) + _keyword_tokens(_safe_text(idea.get("body"))))
            best_index = -1
            best_score = 0
            for index, group_items in enumerate(fallback_groups):
                group_tokens: set[str] = set()
                for group_idea in group_items:
                    group_tokens.update(_keyword_tokens(_safe_text(group_idea.get("title"))))
                    group_tokens.update(_keyword_tokens(_safe_text(group_idea.get("body"))))
                score = len(idea_tokens & group_tokens)
                if score > best_score:
                    best_score = score
                    best_index = index
            if best_index >= 0 and best_score > 0:
                fallback_groups[best_index].append(idea)
            else:
                fallback_groups.append([idea])

        fallback_target_count = max(1, min(5, (len(normalized_ideas) + 2) // 3))
        if len(fallback_groups) > fallback_target_count:
            compacted_groups: list[list[dict[str, Any]]] = []
            for index in range(0, len(normalized_ideas), 3):
                compacted_groups.append(normalized_ideas[index:index + 3])
            fallback_groups = compacted_groups

        return [build_group(index + 1, source_ideas) for index, source_ideas in enumerate(fallback_groups)]

    return [
        {
            "group_id": f"problem-group-{index + 1}",
            "topic": _normalize_problem_topic_label(agenda.title, _safe_text(agenda.title, f"주제 {index + 1}")),
            "insight_lens": "안건 흐름에서 문제 관점 도출",
            "keywords": [
                tok
                for tok in ([_normalize_keyword_token(x) for x in (agenda.keywords or [])] + _keyword_tokens(agenda.title))
                if tok and not _is_title_keyword_noise(tok)
            ][:6],
            "agenda_ids": [_safe_text(agenda.agenda_id)],
            "agenda_titles": [_safe_text(agenda.title)],
            "source_group_id": source_group_id or _safe_text(agenda.agenda_id),
            "source_group_title": source_group_title or _safe_text(agenda.title),
            "ideas": [],
            "source_child_item_ids": [],
            "source_summary_items": [_safe_text(x) for x in (agenda.summary_bullets or []) if _safe_text(x)][:8],
            "conclusion": _to_summary_point((agenda.summary_bullets or [agenda.title])[0], max_len=None),
        }
        for index, agenda in enumerate(agendas)
        if _safe_text(agenda.agenda_id) or _safe_text(agenda.title)
    ]


def _normalize_problem_topic_label(raw: Any, fallback: str = "주제") -> str:
    text = _strip_leading_timestamp(raw) or _safe_text(fallback, "주제")
    parts = re.findall(r"[A-Za-z0-9가-힣]+", text)
    cleaned: list[str] = []
    for part in parts:
        tok = _safe_text(part)
        if not tok:
            continue
        lowered = tok.lower()
        if lowered in STOPWORDS or _is_title_keyword_noise(tok):
            continue
        cleaned.append(tok)
        if len(cleaned) >= 2:
            break
    if cleaned:
        return " ".join(cleaned)
    return _safe_text(fallback, "주제")


def _build_meeting_goal_local(topic: str) -> str:
    clean_topic = _safe_text(topic, "이번 회의").strip()
    if not clean_topic:
        return "이번 회의에서 실행 방향과 우선순위를 정리한다."
    return f"{clean_topic}에 대해 실행 방향과 핵심 우선순위를 정리한다."


def _build_meeting_goal_local_options(topic: str) -> list[str]:
    clean_topic = _safe_text(topic, "이번 회의").strip()
    if not clean_topic:
        return [
            "이번 회의에서 실행 방향과 우선순위를 정리한다.",
            "이번 회의의 핵심 쟁점과 결정 기준을 합의한다.",
            "이번 회의에서 다음 실행 과제를 명확히 한다.",
        ]
    return _dedup_preserve(
        [
            f"{clean_topic}에 대해 실행 방향과 핵심 우선순위를 정리한다.",
            f"{clean_topic}의 핵심 쟁점과 의사결정 기준을 합의한다.",
            f"{clean_topic}에서 다음 실행 과제와 담당 범위를 정리한다.",
        ],
        limit=3,
    )


def _build_meeting_goal_prompt(topic: str) -> str:
    payload = {
        "meeting_topic": _safe_text(topic),
    }
    return (
        "너는 회의 제목을 보고 회의 목표를 한 문장으로 정리하는 분석기다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- meeting_topic을 바탕으로 이번 회의가 무엇을 정리하거나 결정해야 하는지 목표 후보 3개를 쓴다.\n"
        "- 제목을 그대로 반복하지 말고, 회의에서 얻고 싶은 결과나 방향이 드러나게 쓴다.\n"
        "- 너무 추상적이지 않게, 실행 또는 정리의 대상이 보이도록 쓴다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "goal": "키링 굿즈 전략에서 우선 검증할 타깃 수요와 실행 방향을 정리한다.",\n'
        '  "goals": [\n'
        '    "키링 굿즈 전략에서 우선 검증할 타깃 수요와 실행 방향을 정리한다.",\n'
        '    "키링 굿즈 출시를 위한 고객 반응과 제작 우선순위를 합의한다.",\n'
        '    "키링 굿즈 아이디어의 실현 가능성과 다음 실행 과제를 정한다."\n'
        "  ]\n"
        "}\n\n"
        "[규칙]\n"
        "- goal은 가장 추천하는 목표 1개다.\n"
        "- goals는 사용자가 선택할 수 있는 서로 다른 관점의 목표 3개다.\n"
        "- 제목 복붙이 아니라 회의 목적이 드러나는 재작성 문장.\n"
        "- 각 목표는 한국어 1문장, 18~48자 정도의 짧고 분명한 문장.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _idea_assimilation_utterance_dict(item: CanvasIdeaAssimilationUtteranceInput) -> dict[str, str]:
    return {
        "id": _safe_text(item.id),
        "speaker": _safe_text(item.speaker, "참가자"),
        "text": _safe_text(item.text),
        "timestamp": _safe_text(item.timestamp),
    }


def _idea_assimilation_existing_idea_dict(item: CanvasIdeaAssimilationIdeaInput) -> dict[str, Any]:
    return {
        "id": _safe_text(item.id),
        "title": _safe_text(item.title),
        "summary": _safe_text(item.summary),
        "keywords": [_safe_text(keyword) for keyword in (item.keywords or []) if _safe_text(keyword)][:8],
        "key_evidence": [_safe_text(value) for value in (item.key_evidence or []) if _safe_text(value)][:6],
        "refined_utterances": _normalize_refined_utterances(item.refined_utterances, limit=12),
        "evidence_utterance_ids": [
            _safe_text(value) for value in (item.evidence_utterance_ids or []) if _safe_text(value)
        ][:40],
        "auto_summary_disabled": bool(item.auto_summary_disabled),
        "user_edited": bool(item.user_edited),
    }


IDEA_KEYWORD_NOISE = {
    "content",
    "summary",
    "keyword",
    "keywords",
    "title",
    "요약",
    "내용",
    "키워드",
    "제목",
    "아이디어",
    "발화",
    "전사",
    "정리",
    "회의",
    "논의",
    "언급",
    "화자",
    "참가자",
    "speaker",
}


def _strip_idea_reference_text(raw: Any, collapse_whitespace: bool = True) -> str:
    text = _strip_leading_timestamp(raw)
    text = re.sub(r"\[[0-9a-fA-F-]{8,}\]\s*", "", text)
    text = re.sub(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "", text)
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.\w+\b:?\s*", "", text)
    text = re.sub(r"^\s*(?:speaker|화자|참가자|user|root)\d*[:：]\s*", "", text, flags=re.IGNORECASE)
    if collapse_whitespace:
        text = re.sub(r"\s+", " ", text)
    else:
        text = re.sub(r"[ \t\r\f\v]+", " ", text)
        text = re.sub(r"\n\s+", "\n", text)
    return _safe_text(text.strip(" \t\r\n-:：|/.,;"))


def _normalize_idea_keyword(raw: Any) -> str:
    token = _strip_idea_reference_text(raw)
    token = re.sub(r"^#+", "", token).strip()
    token = re.sub(r"^[^\w가-힣]+|[^\w가-힣]+$", "", token)
    token = re.sub(r"\s+", " ", token).strip()
    if not token:
        return ""
    if "@" in token:
        return ""
    if re.fullmatch(r"\d+", token):
        return ""
    if re.fullmatch(r"[0-9a-fA-F-]{8,}", token):
        return ""
    if re.search(r"\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|^\d{1,2}:\d{2}", token):
        return ""
    if len(token) > 24:
        return ""

    if " " not in token:
        normalized = _normalize_keyword_token(token)
    else:
        normalized = " ".join(_normalize_keyword_token(part) for part in token.split())
        normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized or len(normalized) < 2:
        return ""
    lowered = normalized.lower()
    if lowered in STOPWORDS or lowered in TITLE_NOISE_TOKENS or lowered in IDEA_KEYWORD_NOISE:
        return ""
    if _is_title_keyword_noise(normalized):
        return ""
    return normalized


def _extract_light_keywords(text: str, limit: int = 4) -> list[str]:
    tokens: list[str] = []
    for token in re.findall(r"[A-Za-z0-9가-힣]{2,}", _strip_leading_timestamp(text)):
        cleaned = _normalize_idea_keyword(token)
        if not cleaned:
            continue
        if cleaned not in tokens:
            tokens.append(cleaned)
        if len(tokens) >= limit:
            break
    return tokens


def _normalize_idea_keywords(raw_keywords: Any, source_text: str, limit: int = 6) -> list[str]:
    values: list[Any] = []
    if isinstance(raw_keywords, str):
        values.extend(re.split(r"[,/#\n]+", raw_keywords))
    elif isinstance(raw_keywords, list):
        for item in raw_keywords:
            if isinstance(item, str):
                values.extend(re.split(r"[,/#\n]+", item))
            else:
                values.append(item)

    keywords = _dedup_preserve(
        [_normalize_idea_keyword(value) for value in values if _safe_text(value)],
        limit=limit,
    )
    if len(keywords) < min(3, limit):
        keywords = _dedup_preserve(keywords + _extract_light_keywords(source_text, limit), limit=limit)
    return keywords[:limit]


def _clean_idea_title(raw_title: Any, keywords: list[str], fallback: str = "AI 아이디어") -> str:
    title = _strip_idea_reference_text(raw_title)
    title = re.sub(r"^(?:아이디어|요약|핵심|제목)\s*[:：-]\s*", "", title)
    title = re.sub(r"\s+", " ", title).strip(" -:：|/.,;")
    if not title or title.lower() in IDEA_KEYWORD_NOISE:
        title = " ".join(keywords[:2]).strip() or fallback
    if len(title) > 24:
        title = _to_summary_point(title, 24)
    return _safe_text(title, fallback)


def _clean_idea_summary(raw_summary: Any, fallback_title: str, keywords: list[str]) -> str:
    summary = _safe_text(raw_summary)
    if isinstance(raw_summary, list):
        summary = "\n".join(_safe_text(item) for item in raw_summary if _safe_text(item))
    summary = _strip_idea_reference_text(summary, collapse_whitespace=False)
    summary = re.sub(r"^(?:내용|요약|summary|content)\s*[:：-]\s*", "", summary, flags=re.IGNORECASE)
    candidates = [
        _to_summary_point(part, 46)
        for part in re.split(r"\n+|\s*/\s*|[;；]+", summary)
        if _safe_text(part)
    ]
    candidates = [
        item
        for item in candidates
        if item and item.lower() not in IDEA_KEYWORD_NOISE and not re.fullmatch(r"(없음|해당 없음|n/?a)", item, flags=re.IGNORECASE)
    ]
    if not candidates:
        fallback = " / ".join(keywords[:2]) or fallback_title
        candidates = [_to_summary_point(fallback, 46)]
    return "\n".join(_dedup_preserve(candidates, limit=2))


def _normalize_idea_assimilation_update(raw: Any, fallback_ids: list[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    action = _safe_text(raw.get("action")).lower()
    if action not in {"merge", "create"}:
        return None

    target_id = _safe_text(raw.get("targetIdeaId") or raw.get("target_idea_id") or raw.get("target_id"))
    if action == "merge" and not target_id:
        return None

    raw_title = raw.get("title")
    raw_summary = raw.get("summary") or raw.get("content") or raw.get("contentSummary") or raw.get("body")
    keywords = _normalize_idea_keywords(raw.get("keywords") or [], f"{raw_title or ''} {raw_summary or ''}", 6)
    title = _clean_idea_title(raw_title, keywords, "새 아이디어")
    summary = _clean_idea_summary(raw_summary, title, keywords)
    keywords = keywords or _normalize_idea_keywords([], f"{title} {summary}", 6)
    key_evidence = [
        _to_summary_point(_strip_idea_reference_text(value), 72)
        for value in (raw.get("keyEvidence") or raw.get("key_evidence") or [])
        if _safe_text(value)
    ][:6]
    evidence_ids = [
        _safe_text(value)
        for value in (raw.get("evidenceUtteranceIds") or raw.get("evidence_utterance_ids") or [])
        if _safe_text(value)
    ][:400]
    ignored_ids = [
        _safe_text(value)
        for value in (raw.get("ignoredUtteranceIds") or raw.get("ignored_utterance_ids") or [])
        if _safe_text(value)
    ][:400]

    if not evidence_ids and not ignored_ids:
        evidence_ids = fallback_ids[:400]

    refined_utterances = _normalize_refined_utterances(
        raw.get("refinedUtterances") or raw.get("refined_utterances") or raw.get("refined_utterance") or [],
        limit=4,
        allowed_ids=set(evidence_ids),
        min_relevance_score=0.78,
    )

    return {
        "action": action,
        "targetIdeaId": target_id,
        "title": title,
        "summary": summary,
        "keywords": keywords,
        "keyEvidence": key_evidence,
        "refinedUtterances": refined_utterances,
        "evidenceUtteranceIds": evidence_ids,
        "ignoredUtteranceIds": ignored_ids,
    }


def _build_idea_assimilation_prompt(payload: CanvasIdeaAssimilationInput) -> str:
    context_rows = [_idea_assimilation_utterance_dict(item) for item in (payload.context_utterances or [])[-8:]]
    target_rows = [_idea_assimilation_utterance_dict(item) for item in (payload.target_utterances or [])]
    context_transcript_text = " ".join(
        f"{row['speaker']}: {row['text']}" for row in context_rows if _safe_text(row.get("text"))
    )
    target_ref_rows = [
        {
            **row,
            "ref": f"U{index + 1}",
        }
        for index, row in enumerate(target_rows)
        if _safe_text(row.get("text"))
    ]
    target_transcript_text = " ".join(
        f"[{row['ref']}] {row['speaker']}: {row['text']}" for row in target_ref_rows
    )
    prompt_payload = {
        "meeting_topic": _safe_text(payload.meeting_topic),
        "context_transcript_text": context_transcript_text,
        "target_transcript_text": target_transcript_text,
        "target_utterance_refs": [
            {
                "ref": row["ref"],
                "id": row["id"],
                "speaker": row["speaker"],
                "timestamp": row["timestamp"],
            }
            for row in target_ref_rows
            if _safe_text(row.get("id"))
        ],
        "existing_ideas": [
            _idea_assimilation_existing_idea_dict(item) for item in (payload.existing_ideas or [])[:40]
        ],
    }
    return (
        "너는 회의 발화를 아이디어 캔버스에 반영하는 분석기다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- target_transcript_text 전체를 하나의 이어진 전사문으로 보고 기존 아이디어에 편입할지, 새 아이디어를 만들지 결정한다.\n"
        "- meeting_topic과 context_transcript_text는 배경 정보일 뿐이다. title/summary/keywords/refinedUtterances는 반드시 target_transcript_text에서 나온 의미만 사용한다.\n"
        "- 잡담, 단순 맞장구, 반복 확인, 감사 인사는 아이디어 노드에 넣지 말고 ignoredUtteranceIds에만 포함한다.\n"
        "- 아이디어 노드에는 불필요한 대화 흐름이 아니라 전체 전사문에서 드러난 실행/기획 핵심만 정제해서 넣는다.\n"
        "- summary는 노드 본문에 들어갈 content이며, 완성형 설명문이 아니라 핵심만 남긴 압축 문구여야 한다.\n"
        "- summary는 1~2줄로 작성하되 각 줄은 짧은 명사구/핵심 구문 중심으로 쓴다.\n"
        "- summary에는 '해야 한다', '필요하다', '정리된다', '보인다', '논의했다' 같은 일반 서술어를 되도록 쓰지 않는다.\n"
        "- keywords는 target_transcript_text 전체를 모두 읽은 뒤 중심 의미를 이루는 용어만 추출한다. 앞에 나온 단어를 순서대로 뽑지 않는다.\n"
        "- 대괄호 ref, id, timestamp, speaker/email/user/root 같은 식별자는 참조용이다. title/summary/keywords/keyEvidence/refinedUtterances.text에 절대 쓰지 않는다.\n"
        "- keywords에는 '회의', '논의', '요약', '내용', '아이디어', '발화', '전사' 같은 일반어를 넣지 않는다.\n"
        "- refinedUtterances는 summary에 깊게 관련된 주요 발화만 각각 한 줄씩 '요약'한 것이다.\n"
        "- refinedUtterances는 원문을 예쁘게 고친 문장이 아니라, 해당 발화가 content를 만든 직접 근거/의도만 남긴 압축문이다.\n"
        "- refinedUtterances는 content에서 빠지면 summary 의미가 바뀌는 발화만 포함한다.\n"
        "- 기존 아이디어와 의미가 매우 같을 때만 merge한다. 단순 키워드 1개 겹침, 같은 안건, 같은 화자라는 이유만으로 merge하지 않는다.\n"
        "- merge 확신이 낮거나 기존 아이디어와 핵심 대상/방향이 다르면 반드시 create를 사용한다.\n"
        "- auto_summary_disabled가 true인 기존 아이디어는 제목/요약/키워드를 덮어쓰지 않도록 merge 대상으로 삼더라도 근거 보강 중심으로 응답한다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(prompt_payload, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "updates": [\n'
        "    {\n"
        '      "action": "merge",\n'
        '      "targetIdeaId": "idea-id",\n'
        '      "title": "짧은 아이디어 제목",\n'
        '      "summary": "핵심 키워드/방향만 남긴 1~2줄 압축 content",\n'
        '      "keywords": ["키워드1", "키워드2"],\n'
        '      "keyEvidence": ["A: 핵심 근거 발화 요약"],\n'
        '      "refinedUtterances": [\n'
        '        {"utterance_id": "utterance-id-1", "speaker": "A", "text": "주요 발화의 핵심 근거 한 줄 요약", "timestamp": "ISO time", "relevanceScore": 0.9}\n'
        "      ],\n"
        '      "evidenceUtteranceIds": ["utterance-id-1"],\n'
        '      "ignoredUtteranceIds": ["utterance-id-2"]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "[규칙]\n"
        "- updates는 0~3개까지 가능하다. 한 번의 전사 묶음에서 핵심 의미가 하나면 update도 하나만 만든다.\n"
        "- 하나의 target_utterance는 evidenceUtteranceIds 또는 ignoredUtteranceIds 중 하나에만 넣는다.\n"
        "- create의 targetIdeaId는 빈 문자열로 둔다.\n"
        "- title은 12자 이내의 한국어 명사구를 우선한다.\n"
        "- title에는 '이유', '방안', '문제'처럼 의미를 보강하는 말은 쓸 수 있지만, '요약', '정리', '논의' 같은 메타어는 쓰지 않는다.\n"
        "- summary는 회의 잡담을 제거하고 전체 전사문의 핵심만 1~2줄로 남긴다.\n"
        "- summary는 문장형 설명보다 '핵심 대상 + 방향/문제/조건' 형태의 압축 구문을 우선한다.\n"
        "- summary 예시: '사용자별 회의 흐름 유지 / 다중 기기 STT 동기화', '잡담 제외, 의미 단위 아이디어 병합'.\n"
        "- summary에는 회의 주제의 일반 설명을 쓰지 말고, target_transcript_text에서 새로 나온 구체 논지만 쓴다.\n"
        "- keywords는 3~6개로 작성하고, title/summary에서 실제 의미를 구성하는 명사구만 넣는다.\n"
        "- keywords는 target_transcript_text의 첫 단어들이 아니라, 전체 발화에서 반복/강조/결론 역할을 하는 중심 개념이어야 한다.\n"
        "- refinedUtterances에는 핵심 요약문에 직접 영향을 준 주요 발화만 넣고, 잡담은 넣지 않는다.\n"
        "- refinedUtterances에는 단순 배경 설명, 동의/확인, 중복 부연, 간접 관련 발화는 넣지 않는다.\n"
        "- refinedUtterances는 update 하나당 최대 4개까지만 작성한다. 확실한 직접 근거가 1개면 1개만 작성한다.\n"
        "- relevanceScore는 content와의 직접 관련도를 0~1로 평가한다. 0.78 미만이면 refinedUtterances에 넣지 않는다.\n"
        "- refinedUtterances.text는 반드시 14~38자 정도의 짧은 요약문으로 쓴다.\n"
        "- refinedUtterances.text는 발화 원문을 그대로 복사하거나 긴 문장으로 다듬어 쓰지 않는다.\n"
        "- refinedUtterances.text는 '말함', '언급함', '논의함' 같은 메타 표현 없이 핵심 근거만 쓴다.\n"
        "- refinedUtterances 예시: '다중 마이크 전사 중복 문제', '노드 생성 전 LLM 정리 대기', '핵심 요약과 발화 근거 분리'.\n"
        "- refinedUtterances의 utterance_id, speaker, timestamp는 target_utterance_refs 중 ref가 일치하는 실제 id/speaker/timestamp를 사용한다.\n"
        "- evidenceUtteranceIds와 ignoredUtteranceIds는 target_utterance_refs의 id만 사용한다.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _compute_idea_assimilation_result(payload: CanvasIdeaAssimilationInput) -> dict[str, Any]:
    updates: list[dict[str, Any]] = []
    used_llm = False
    warning = ""
    fallback_ids = [_safe_text(item.id) for item in (payload.target_utterances or []) if _safe_text(item.id)]

    client, llm_ready, llm_note = _ensure_llm_ready(RT)
    if payload.target_utterances and llm_ready:
        try:
            parsed = _call_llm_json(
                RT,
                client,
                prompt=_build_idea_assimilation_prompt(payload),
                stage="canvas_idea_assimilation",
                temperature=0.2,
                max_tokens=2200,
            )
            parsed_updates = parsed.get("updates") if isinstance(parsed, dict) else None
            normalized_updates: list[dict[str, Any]] = []
            if isinstance(parsed_updates, list):
                for item in parsed_updates:
                    normalized = _normalize_idea_assimilation_update(item, fallback_ids)
                    if normalized:
                        normalized_updates.append(normalized)
            if normalized_updates:
                updates = normalized_updates[:5]
                used_llm = True
                RT.last_llm_parsed_json = {
                    "stage": "canvas_idea_assimilation",
                    "updates": copy.deepcopy(updates),
                }
                RT.last_llm_parsed_at = _now_ts()
            else:
                warning = "LLM JSON 형식이 예상과 달라 아이디어 노드를 생성하지 않았습니다."
        except Exception as exc:
            warning = f"아이디어 병합 LLM 생성 실패: {exc}"
    elif payload.target_utterances:
        warning = llm_note or "LLM 미연결 상태라 아이디어 노드를 생성하지 않았습니다."

    return {
        "ok": True,
        "used_llm": used_llm,
        "warning": warning,
        "generated_at": _now_ts(),
        "updates": updates,
    }


def _build_problem_definition_prompt(topic: str, groups: list[dict[str, Any]]) -> str:
    source_items: list[dict[str, Any]] = []
    seen_source_ids: set[str] = set()
    for group in groups:
        ideas = group.get("ideas") if isinstance(group.get("ideas"), list) else []
        for idea in ideas:
            if not isinstance(idea, dict):
                continue
            idea_id = _safe_text(idea.get("id"))
            if not idea_id or idea_id in seen_source_ids:
                continue
            seen_source_ids.add(idea_id)
            source_items.append(
                {
                    "id": idea_id,
                    "kind": _safe_text(idea.get("kind"), "note"),
                    "title": _compact_problem_source_text(idea.get("title"), 60),
                    "body": _compact_problem_source_text(idea.get("body"), 140),
                    "agenda_ids": [_safe_text(x) for x in (group.get("agenda_ids") or []) if _safe_text(x)][:2],
                    "agenda_titles": [_compact_problem_source_text(x, 40) for x in (group.get("agenda_titles") or []) if _safe_text(x)][:2],
                    "draft_keywords": [_compact_problem_source_text(x, 24) for x in (group.get("keywords") or []) if _safe_text(x)][:6],
                }
            )
    payload = {
        "meeting_topic": _safe_text(topic),
        "source_group": {
            "id": _safe_text(groups[0].get("source_group_id")) if groups else "",
            "title": _safe_text(groups[0].get("source_group_title")) if groups else "",
        },
        "source_items": source_items,
    }
    return (
        "너는 아이디어 단계의 1차 자식 노드들을 문제 정의 단계용 그룹으로 재분류하는 분석기다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- 입력 source_items는 source_group에 해당하는 그룹분류 아래의 1차 자식들이다.\n"
        "- source_items를 그대로 복사하지 말고, 문제 관점이 비슷한 것끼리 문제정의 그룹으로 재분류한다.\n"
        "- 그룹 개수는 source_items의 의미적 차이를 보고 스스로 결정한다.\n"
        "- 권장 그룹 수는 1~5개이며, 서로 명확히 다른 문제 관점일 때만 그룹을 늘린다.\n"
        "- source_item 개수와 같은 수의 그룹을 만들지 않는다. 단, 모든 source_item이 서로 완전히 다른 문제일 때만 예외다.\n"
        "- 각 그룹에는 반드시 포함한 source_item id 목록(source_child_item_ids)을 넣는다.\n"
        "- 각 source_item id는 가급적 정확히 한 그룹에만 포함한다.\n"
        "- topic은 문제 관점을 드러내는 짧은 명사구로 쓴다.\n"
        "- conclusion은 해당 그룹의 문제 정의 결과를 1문장으로 쓴다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "groups": [\n'
        "    {\n"
        '      "group_id": "problem-group-1",\n'
        '      "topic": "진입 장벽",\n'
        '      "insight_lens": "사용 흐름의 마찰",\n'
        '      "conclusion": "초기 사용자가 핵심 가치를 이해하기 전에 이탈할 가능성이 크다.",\n'
        '      "source_child_item_ids": ["idea-1", "idea-3"]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "[규칙]\n"
        "- group_id는 problem-group-1부터 순서대로 부여한다.\n"
        "- source_child_item_ids는 입력 source_items에 존재하는 id만 사용한다.\n"
        "- source_child_item_ids가 비어 있는 그룹은 만들지 않는다.\n"
        "- insight_lens는 이 묶음의 인사이트를 어떤 관점으로 정리했는지 설명하는 짧은 문구다.\n"
        "- insight_lens는 예를 들면 '행동에서 드러난 니즈', '의사결정 기준의 충돌', '실행 제약과 우선순위' 같은 식으로 쓴다.\n"
        "- insight_lens는 반드시 8~20자 이내의 짧은 한국어 구로 쓴다.\n"
        "- topic은 반드시 1~2단어만 사용한다.\n"
        "- topic은 가급적 10자 이내의 짧은 명사구로 쓴다.\n"
        "- topic은 너무 일반적인 표현(예: 기타, 논의, 안건, 주제)으로 쓰지 않는다.\n"
        "- conclusion은 각 주제당 정확히 1문장.\n"
        "- conclusion은 반드시 insight_lens의 관점으로 해석한 결과여야 한다.\n"
        "- conclusion은 '이 그룹에서는', '~에서는', '~정리된다', '~필요가 있다' 같은 서술 틀로 시작하거나 끝내지 않는다.\n"
        "- conclusion은 바로 핵심 결과 문장만 쓴다.\n"
        "- conclusion은 요약문 재인용이 아니라 새로 쓴 문장.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _materialize_problem_definition_groups_from_llm(
    base_groups: list[dict[str, Any]],
    parsed_groups: list[Any],
) -> list[dict[str, Any]]:
    idea_by_id: dict[str, dict[str, Any]] = {}
    meta_by_idea_id: dict[str, dict[str, Any]] = {}
    keyword_by_idea_id: dict[str, list[str]] = {}
    for group in base_groups:
        for idea in group.get("ideas") or []:
            if not isinstance(idea, dict):
                continue
            idea_id = _safe_text(idea.get("id"))
            if not idea_id:
                continue
            idea_by_id[idea_id] = copy.deepcopy(idea)
            meta_by_idea_id[idea_id] = {
                "agenda_ids": [_safe_text(x) for x in (group.get("agenda_ids") or []) if _safe_text(x)],
                "agenda_titles": [_safe_text(x) for x in (group.get("agenda_titles") or []) if _safe_text(x)],
                "source_group_id": _safe_text(group.get("source_group_id")),
                "source_group_title": _safe_text(group.get("source_group_title")),
            }
            keyword_by_idea_id[idea_id] = [_safe_text(x) for x in (group.get("keywords") or []) if _safe_text(x)]

    if not idea_by_id:
        return base_groups

    used_source_ids: set[str] = set()
    output: list[dict[str, Any]] = []

    def build_group(index: int, raw_group: dict[str, Any] | None, source_ids: list[str]) -> dict[str, Any]:
        source_ideas = [copy.deepcopy(idea_by_id[source_id]) for source_id in source_ids if source_id in idea_by_id]
        agenda_ids: list[str] = []
        agenda_titles: list[str] = []
        source_group_ids: list[str] = []
        source_group_titles: list[str] = []
        keywords: list[str] = []
        summaries: list[str] = []
        for source_id in source_ids:
            meta = meta_by_idea_id.get(source_id) or {}
            agenda_ids.extend([_safe_text(x) for x in (meta.get("agenda_ids") or []) if _safe_text(x)])
            agenda_titles.extend([_safe_text(x) for x in (meta.get("agenda_titles") or []) if _safe_text(x)])
            source_group_ids.append(_safe_text(meta.get("source_group_id")))
            source_group_titles.append(_safe_text(meta.get("source_group_title")))
            keywords.extend(keyword_by_idea_id.get(source_id) or [])
        for idea in source_ideas:
            summaries.append(
                _to_summary_point(
                    " ".join([_safe_text(idea.get("title")), _safe_text(idea.get("body"))]).strip(),
                    max_len=80,
                )
            )
        agenda_ids = list(dict.fromkeys([item for item in agenda_ids if item]))
        agenda_titles = list(dict.fromkeys([item for item in agenda_titles if item]))
        source_group_ids = list(dict.fromkeys([item for item in source_group_ids if item]))
        source_group_titles = list(dict.fromkeys([item for item in source_group_titles if item]))
        keywords = list(dict.fromkeys([item for item in keywords if item]))[:6]
        summaries = [_safe_text(item) for item in summaries if _safe_text(item)][:8]
        topic_seed = _safe_text((raw_group or {}).get("topic"))
        if not topic_seed and source_ideas:
            topic_seed = _safe_text(source_ideas[0].get("title"))
        return {
            "group_id": _safe_text((raw_group or {}).get("group_id"), f"problem-group-{index}"),
            "topic": _normalize_problem_topic_label(topic_seed, _safe_text(topic_seed, f"주제 {index}")),
            "insight_lens": _safe_text((raw_group or {}).get("insight_lens"), "원본 아이디어의 공통 문제 관점"),
            "keywords": keywords,
            "agenda_ids": agenda_ids,
            "agenda_titles": agenda_titles,
            "source_group_id": source_group_ids[0] if source_group_ids else (agenda_ids[0] if agenda_ids else ""),
            "source_group_title": source_group_titles[0] if source_group_titles else (agenda_titles[0] if agenda_titles else ""),
            "ideas": source_ideas[:24],
            "source_child_item_ids": source_ids,
            "source_summary_items": summaries,
            "conclusion": _safe_text((raw_group or {}).get("conclusion")) or (summaries[0] if summaries else f"{topic_seed} 방향 구체화"),
        }

    for raw_index, raw_group in enumerate(parsed_groups, start=1):
        if not isinstance(raw_group, dict):
            continue
        source_ids = []
        for raw_id in raw_group.get("source_child_item_ids") or []:
            source_id = _safe_text(raw_id)
            if source_id and source_id in idea_by_id and source_id not in used_source_ids:
                used_source_ids.add(source_id)
                source_ids.append(source_id)
        if not source_ids:
            continue
        output.append(build_group(len(output) + 1, raw_group, source_ids))

    for missing_id in idea_by_id:
        if missing_id in used_source_ids:
            continue
        output.append(build_group(len(output) + 1, None, [missing_id]))

    used_group_ids: set[str] = set()
    for index, group in enumerate(output, start=1):
        base_id = _safe_text(group.get("group_id"), f"problem-group-{index}")
        next_id = base_id
        suffix = 2
        while next_id in used_group_ids:
            next_id = f"{base_id}-{suffix}"
            suffix += 1
        used_group_ids.add(next_id)
        group["group_id"] = next_id

    return output or base_groups


def _build_problem_group_conclusion_local(payload: ProblemConclusionGenerateInput) -> str:
    summary_items = [_safe_text(item) for item in (payload.group.source_summary_items or []) if _safe_text(item)]
    idea_bodies = [
        _safe_text(item.body) or _safe_text(item.title)
        for item in (payload.group.ideas or [])
        if _safe_text(item.body) or _safe_text(item.title)
    ]
    evidence = summary_items + idea_bodies
    if evidence:
        anchor = _to_summary_point(evidence[0], max_len=None)
        if anchor:
            return anchor
    agenda_titles = [_safe_text(item) for item in (payload.group.agenda_titles or []) if _safe_text(item)]
    if agenda_titles:
        return f"{agenda_titles[0]} 방향 구체화"
    return f"{_safe_text(payload.group.topic, '주제')} 방향 구체화"


def _build_problem_group_insight_lens_local(payload: ProblemConclusionGenerateInput) -> str:
    existing = _safe_text(payload.group.insight_lens)
    if existing:
        return existing
    if payload.group.ideas:
        return "개인 메모와 요약을 함께 해석"
    if payload.group.source_summary_items:
        return "요약 흐름에서 공통 인사이트 도출"
    if payload.group.agenda_titles:
        return "안건 흐름에서 공통 방향 정리"
    return "핵심 방향을 묶어 해석"


def _build_problem_group_conclusion_prompt(payload: ProblemConclusionGenerateInput) -> str:
    serialized = {
        "meeting_topic": _safe_text(payload.meeting_topic),
        "group": {
            "group_id": _safe_text(payload.group.group_id),
            "topic": _safe_text(payload.group.topic),
            "draft_insight_lens": _safe_text(payload.group.insight_lens),
            "agenda_titles": [_safe_text(item) for item in (payload.group.agenda_titles or []) if _safe_text(item)],
            "source_summary_items": [
                _safe_text(item) for item in (payload.group.source_summary_items or []) if _safe_text(item)
            ],
            "ideas": [
                {
                    "id": _safe_text(item.id),
                    "kind": _safe_text(item.kind, "note"),
                    "title": _safe_text(item.title),
                    "body": _safe_text(item.body),
                }
                for item in (payload.group.ideas or [])
                if _safe_text(item.id) or _safe_text(item.title) or _safe_text(item.body)
            ],
        },
    }
    return (
        "너는 문제정의 그룹의 현재 메모와 요약을 보고 결론 한 문장을 작성하는 분석기다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- 먼저 이 그룹의 인사이트를 어떤 관점으로 정리할지 insight_lens를 정한다.\n"
        "- group.topic, source_summary_items, ideas를 종합해 이 그룹의 결론을 한 문장으로 쓴다.\n"
        "- 회의에서 드러난 핵심 인사이트나 방향이 드러나야 한다.\n"
        "- 입력 문장을 그대로 복붙하지 말고 새로운 한국어 문장으로 정리한다.\n"
        "- 너무 추상적이지 않게, 실제 논의된 흐름이 느껴지게 쓴다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(serialized, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "group_id": "problem-group-1",\n'
        '  "insight_lens": "행동에서 드러난 숨은 니즈",\n'
        '  "conclusion": "사용자의 표현 욕구를 반영한 방향으로 아이디어를 정리해야 한다."\n'
        "}\n\n"
        "[규칙]\n"
        "- group_id는 입력값을 그대로 유지한다.\n"
        "- insight_lens는 인사이트를 어떤 각도로 정리했는지 드러내는 8~20자 이내의 짧은 한국어 구다.\n"
        "- insight_lens는 예를 들면 '행동에서 드러난 니즈', '의사결정 기준의 충돌', '실행 제약과 우선순위'처럼 쓴다.\n"
        "- conclusion은 한국어 1문장.\n"
        "- conclusion은 18~45자 정도의 짧고 분명한 문장.\n"
        "- conclusion은 반드시 insight_lens 관점으로 해석한 결과여야 한다.\n"
        "- conclusion은 '이 그룹에서는', '~에서는', '~정리된다', '~필요가 있다' 같은 틀을 쓰지 않는다.\n"
        "- conclusion은 바로 핵심 결과 문장만 쓴다.\n"
        "- topic을 반복만 하지 말고, 근거를 종합한 결과를 써야 한다.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _build_solution_stage_prompt(meeting_topic: str, topics: list[dict[str, Any]]) -> str:
    payload = {
        "meeting_topic": _safe_text(meeting_topic),
        "topics": topics,
    }
    return (
        "너는 회의 해결책 단계용 AI 아이디어 생성기다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- 각 topic마다 실행 가능한 해결책 아이디어를 여러 개 제안한다.\n"
        "- 아이디어는 topic과 conclusion을 바탕으로 새로 작성한다.\n"
        "- 기존 conclusion 문장을 그대로 반복하지 말고, 실제 시도 가능한 해결 방향으로 제안한다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "topics": [\n'
        "    {\n"
        '      "group_id": "problem-group-1",\n'
        '      "topic_no": 1,\n'
        '      "topic": "트렌드",\n'
        '      "ideas": ["아이디어 1", "아이디어 2", "아이디어 3"]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "[규칙]\n"
        "- group_id, topic_no, topic은 입력값을 그대로 유지한다.\n"
        "- ideas는 topic마다 2~4개.\n"
        "- 각 아이디어는 1문장 또는 짧은 명사구.\n"
        "- 서로 중복되지 않게 작성한다.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _build_ideation_suggestions_prompt(payload: IdeationSuggestionGenerateInput) -> str:
    serialized = {
        "meeting_topic": _safe_text(payload.meeting_topic),
        "topic": {
            "id": _safe_text(payload.topic.id),
            "title": _safe_text(payload.topic.title),
            "body": _safe_text(payload.topic.body),
            "keywords": [_safe_text(item) for item in (payload.topic.keywords or []) if _safe_text(item)][:8],
        },
        "child_items": [
            {
                "id": _safe_text(item.id),
                "kind": _safe_text(item.kind, "note"),
                "title": _safe_text(item.title),
                "body": _safe_text(item.body),
                "keywords": [_safe_text(keyword) for keyword in (item.keywords or []) if _safe_text(keyword)][:8],
            }
            for item in (payload.child_items or [])
            if _safe_text(item.title) or _safe_text(item.body)
        ][:12],
    }
    return (
        "너는 아이디어 단계의 topic을 보고 회의에서 추가로 검토할 아이디어를 제안하는 AI다. 출력은 JSON 하나만 반환한다.\n\n"
        "[목표]\n"
        "- topic과 하위 아이디어/메모를 바탕으로 아직 카드로 만들지 않은 새 아이디어를 제안한다.\n"
        "- 기존 내용을 다른 말로 반복하지 말고, 서로 구분되는 제안을 만든다.\n"
        "- 회의 참가자가 선택적으로 채택할 참고 제안처럼 낮은 위계로 쓸 수 있게 짧게 작성한다.\n\n"
        "[입력 JSON]\n"
        f"{json.dumps(serialized, ensure_ascii=False, indent=2)}\n\n"
        "[출력 JSON 스키마]\n"
        "{\n"
        '  "suggestions": [\n'
        '    {"text": "추천 아이디어 1"},\n'
        '    {"text": "추천 아이디어 2"}\n'
        "  ]\n"
        "}\n\n"
        "[규칙]\n"
        "- suggestions는 2~5개.\n"
        "- 각 text는 한국어 1문장 또는 짧은 명사구.\n"
        "- 기존 child_items의 title/body와 의미가 거의 같은 제안은 제외한다.\n"
        "- 너무 추상적인 표현 대신 바로 카드로 채택 가능한 아이디어로 쓴다.\n"
        "- 불필요한 설명 없이 JSON만 반환한다."
    )


def _build_local_ideation_suggestions(payload: IdeationSuggestionGenerateInput) -> list[dict[str, str]]:
    topic_title = _safe_text(payload.topic.title, "선택한 topic")
    topic_keywords = [_safe_text(item) for item in (payload.topic.keywords or []) if _safe_text(item)]
    child_titles = [_safe_text(item.title) for item in (payload.child_items or []) if _safe_text(item.title)]
    anchors = _dedup_preserve([*topic_keywords, *child_titles, topic_title], limit=5)
    if not anchors:
        anchors = [topic_title]
    candidates = [
        f"{anchors[0]}를 빠르게 검증할 수 있는 사용자 시나리오를 만든다.",
        f"{anchors[min(1, len(anchors) - 1)]} 관점에서 비교 가능한 대안을 정리한다.",
        f"{topic_title}에 대한 실행 우선순위를 정하는 판단 기준을 만든다.",
    ]
    return [
        {
            "id": f"ideation-suggestion-{index + 1}",
            "text": text,
            "status": "draft",
        }
        for index, text in enumerate(_dedup_preserve(candidates, limit=3))
        if _safe_text(text)
    ]


def _build_agenda_markdown(rt: RuntimeStore) -> str:
    lines: list[str] = []
    lines.append("# 회의 안건/발언 구조")
    lines.append("")
    lines.append(f"- 생성 시각: {_now_ts()}")
    lines.append(f"- 회의 목표: {_safe_text(rt.meeting_goal, '-')}")
    lines.append(f"- 전사 수: {len(rt.transcript)}")
    lines.append(f"- 안건 수: {len(rt.agenda_outcomes)}")
    lines.append("")

    if not rt.agenda_outcomes:
        lines.append("## 안건 없음")
        lines.append("")
        lines.append("현재 분석된 안건이 없습니다.")
        return "\n".join(lines).strip() + "\n"

    speaker_alias: dict[str, str] = {}
    speaker_seq = 0
    for turn in rt.transcript:
        name = _safe_text(turn.get("speaker"), "화자")
        if name in speaker_alias:
            continue
        speaker_seq += 1
        speaker_alias[name] = f"화자{speaker_seq}"

    lines.append("## 화자 약어")
    lines.append("")
    for name, alias in speaker_alias.items():
        lines.append(f"- {alias}: {name}")
    lines.append("")

    total_turns = len(rt.transcript)
    agenda_outline_rows: list[str] = []
    for idx, row in enumerate(rt.agenda_outcomes, start=1):
        agenda_id = _safe_text(row.get("agenda_id"), f"agenda-{idx}")
        title = _safe_text(row.get("agenda_title"), "안건 제목 미정")
        state = _normalize_agenda_state(row.get("agenda_state"))
        flow = _normalize_flow_type(row.get("flow_type"))
        start_id = int(row.get("start_turn_id") or row.get("_start_turn_id") or 0)
        end_id = int(row.get("end_turn_id") or row.get("_end_turn_id") or 0)
        if start_id <= 0:
            start_id = 1
        if end_id < start_id:
            end_id = min(total_turns, start_id)
        end_id = min(total_turns, end_id)

        lines.append(f"## 안건 {idx}. {title}")
        lines.append("")
        lines.append(f"- agenda_id: `{agenda_id}`")
        lines.append(f"- 상태: `{state}`")
        lines.append(f"- 흐름: `{flow}`")
        lines.append(f"- turn 범위: `{start_id} ~ {end_id}`")
        summary = _md_text(row.get("summary"))
        if summary:
            lines.append(f"- 요약: {summary}")
        lines.append("")
        agenda_outline_rows.append(f"- 안건 {idx}: {title} (`{state}`, turn {start_id}~{end_id})")

        utterances: list[tuple[int, dict[str, Any]]] = []
        if 1 <= start_id <= end_id <= total_turns:
            for turn_id in range(start_id, end_id + 1):
                utterances.append((turn_id, rt.transcript[turn_id - 1]))
        else:
            seen_ids: set[int] = set()
            for ref in list(row.get("summary_references") or []):
                if not isinstance(ref, dict):
                    continue
                tid = int(ref.get("turn_id") or 0)
                if tid <= 0 or tid > total_turns or tid in seen_ids:
                    continue
                seen_ids.add(tid)
                utterances.append((tid, rt.transcript[tid - 1]))
            utterances.sort(key=lambda x: x[0])

        lines.append(f"### 발언 ({len(utterances)})")
        if not utterances:
            lines.append("- 매핑된 발언이 없습니다.")
        else:
            for turn_id, turn in utterances:
                speaker = _safe_text(turn.get("speaker"), "화자")
                speaker_short = speaker_alias.get(speaker, "화자")
                text = _md_text(turn.get("text"))
                lines.append(f"- ({turn_id}) **{speaker_short}**: {text}")
        lines.append("")

    lines.append("## 안건 목록 요약")
    lines.append("")
    lines.extend(agenda_outline_rows if agenda_outline_rows else ["- 안건 없음"])
    lines.append("")

    return "\n".join(lines).strip() + "\n"


def _build_agenda_snapshot(rt: RuntimeStore) -> dict[str, Any]:
    return {
        "snapshot_version": 1,
        "exported_at": _now_ts(),
        "meeting_goal": _safe_text(rt.meeting_goal),
        "window_size": int(rt.window_size or 12),
        "transcript": copy.deepcopy(list(rt.transcript)),
        "agenda_outcomes": copy.deepcopy(list(rt.agenda_outcomes)),
        "last_analyzed_count": int(rt.last_analyzed_count or len(rt.transcript)),
        "analysis_runtime": {
            "tick_mode": _safe_text(rt.last_tick_mode, "snapshot"),
            "used_local_fallback": bool(rt.used_local_fallback),
            "title_refine_attempts": int(rt.last_title_refine_attempts),
            "title_refine_success": int(rt.last_title_refine_success),
        },
        "last_llm_json": copy.deepcopy(dict(rt.last_llm_parsed_json or {})),
        "last_llm_parsed_at": _safe_text(rt.last_llm_parsed_at),
    }


def _load_agenda_snapshot(rt: RuntimeStore, payload: dict[str, Any], reset_state: bool = True) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("스냅샷 JSON 객체가 아닙니다.")

    if reset_state:
        rt.reset()
    else:
        rt.transcript = []
        rt.agenda_outcomes = []
        rt.last_analyzed_count = 0
        rt.agenda_seq = 0
        rt.used_local_fallback = False
        rt.last_analysis_warning = ""
        rt.last_tick_mode = "snapshot"
        rt.last_title_refine_attempts = 0
        rt.last_title_refine_success = 0
        rt.last_llm_parsed_json = {}
        rt.last_llm_parsed_at = ""
        rt.replay_rows = []
        rt.replay_index = 0
        rt.replay_source = ""
        rt.replay_loaded_at = ""
        rt.analysis_task_seq = 0
        rt.analysis_queued = 0
        rt.analysis_inflight = False
        rt.analysis_last_enqueued_at = ""
        rt.analysis_last_started_at = ""
        rt.analysis_last_done_at = ""
        rt.analysis_last_error = ""
        rt.analysis_last_enqueued_id = 0
        rt.analysis_last_started_id = 0
        rt.analysis_last_done_id = 0
        rt.analysis_generation += 1
        rt.transcript_version = 0
        rt.analysis_next_windowed_target = SUMMARY_INTERVAL
        rt.llm_io_seq = 0
        rt.llm_io_logs = []
        rt.canvas_last_placement = {}

    transcript = payload.get("transcript") or []
    if not isinstance(transcript, list):
        raise ValueError("transcript 필드가 배열이 아닙니다.")

    outcomes = payload.get("agenda_outcomes") or []
    if not isinstance(outcomes, list):
        raise ValueError("agenda_outcomes 필드가 배열이 아닙니다.")

    rt.meeting_goal = _safe_text(payload.get("meeting_goal"))
    rt.window_size = max(1, int(payload.get("window_size") or 12))
    rt.transcript = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        rt.transcript.append(
            {
                "speaker": _safe_text(item.get("speaker"), "화자"),
                "text": _safe_text(item.get("text")),
                "timestamp": _safe_text(item.get("timestamp"), _now_ts()),
            }
        )

    rt.agenda_outcomes = copy.deepcopy(outcomes)
    rt.last_analyzed_count = max(0, min(int(payload.get("last_analyzed_count") or len(rt.transcript)), len(rt.transcript)))
    rt.agenda_seq = len(rt.agenda_outcomes)
    rt.last_tick_mode = _safe_text((payload.get("analysis_runtime") or {}).get("tick_mode"), "snapshot")
    rt.used_local_fallback = bool((payload.get("analysis_runtime") or {}).get("used_local_fallback"))
    rt.last_title_refine_attempts = int((payload.get("analysis_runtime") or {}).get("title_refine_attempts") or 0)
    rt.last_title_refine_success = int((payload.get("analysis_runtime") or {}).get("title_refine_success") or 0)
    rt.last_llm_parsed_json = copy.deepcopy(payload.get("last_llm_json") or {})
    rt.last_llm_parsed_at = _safe_text(payload.get("last_llm_parsed_at"))
    rt.last_analysis_warning = "agenda_snapshot_import"
    rt.transcript_version += 1

    return {
        "meeting_goal": rt.meeting_goal,
        "transcript_count": len(rt.transcript),
        "agenda_count": len(rt.agenda_outcomes),
    }
def _snapshot_runtime_for_analysis(rt: RuntimeStore) -> RuntimeStore:
    snap = RuntimeStore()
    snap.meeting_goal = _safe_text(rt.meeting_goal)
    snap.window_size = int(rt.window_size)
    snap.transcript = [dict(row) for row in rt.transcript]
    snap.agenda_outcomes = copy.deepcopy(rt.agenda_outcomes)
    snap.llm_enabled = bool(rt.llm_enabled)
    snap.last_analyzed_count = int(rt.last_analyzed_count)
    snap.agenda_seq = int(rt.agenda_seq)
    snap.stt_chunk_seq = int(rt.stt_chunk_seq)
    snap.used_local_fallback = bool(rt.used_local_fallback)
    snap.last_analysis_warning = _safe_text(rt.last_analysis_warning)
    snap.last_tick_mode = _safe_text(rt.last_tick_mode, "windowed")
    snap.last_title_refine_attempts = int(rt.last_title_refine_attempts)
    snap.last_title_refine_success = int(rt.last_title_refine_success)
    snap.last_llm_parsed_json = copy.deepcopy(rt.last_llm_parsed_json) if isinstance(rt.last_llm_parsed_json, dict) else {}
    snap.last_llm_parsed_at = _safe_text(rt.last_llm_parsed_at)
    snap.analysis_generation = int(rt.analysis_generation)
    snap.transcript_version = int(rt.transcript_version)
    snap.llm_io_seq = int(rt.llm_io_seq)
    snap.llm_io_logs = copy.deepcopy(rt.llm_io_logs) if isinstance(rt.llm_io_logs, list) else []
    return snap


def _apply_analysis_result(rt: RuntimeStore, snap: RuntimeStore) -> None:
    rt.agenda_outcomes = copy.deepcopy(snap.agenda_outcomes)
    rt.last_analyzed_count = int(snap.last_analyzed_count)
    rt.agenda_seq = int(snap.agenda_seq)
    rt.used_local_fallback = bool(snap.used_local_fallback)
    rt.last_analysis_warning = _safe_text(snap.last_analysis_warning)
    rt.last_tick_mode = _safe_text(snap.last_tick_mode, "windowed")
    rt.last_title_refine_attempts = int(snap.last_title_refine_attempts)
    rt.last_title_refine_success = int(snap.last_title_refine_success)
    rt.last_llm_parsed_json = copy.deepcopy(snap.last_llm_parsed_json) if isinstance(snap.last_llm_parsed_json, dict) else {}
    rt.last_llm_parsed_at = _safe_text(snap.last_llm_parsed_at)
    rt.llm_io_seq = int(snap.llm_io_seq)
    rt.llm_io_logs = copy.deepcopy(snap.llm_io_logs) if isinstance(snap.llm_io_logs, list) else []


def _enqueue_analysis(
    rt: RuntimeStore,
    force: bool,
    mode: str,
    source: str = "",
    skip_interval: bool = False,
    target_count: int = 0,
) -> tuple[bool, int, str]:
    rt.analysis_task_seq += 1
    task_id = int(rt.analysis_task_seq)
    task = {
        "id": task_id,
        "force": bool(force),
        "mode": "full_document" if _safe_text(mode) == "full_document" else "windowed",
        "source": _safe_text(source),
        "enqueued_at": _now_ts(),
        "generation": int(rt.analysis_generation),
        "transcript_version": int(rt.transcript_version),
        "skip_interval": bool(skip_interval),
        "target_count": int(max(0, target_count)),
    }
    try:
        ANALYSIS_QUEUE.put_nowait(task)
    except queue.Full:
        return False, task_id, "analysis queue is full"
    rt.analysis_queued += 1
    rt.analysis_last_enqueued_id = task_id
    rt.analysis_last_enqueued_at = _safe_text(task.get("enqueued_at"))
    return True, task_id, ""


def _enqueue_windowed_with_backpressure(rt: RuntimeStore, source: str = "") -> tuple[bool, int, str, bool]:
    transcript_count = len(rt.transcript)
    if rt.analysis_next_windowed_target < SUMMARY_INTERVAL:
        rt.analysis_next_windowed_target = SUMMARY_INTERVAL

    enqueued = 0
    last_task_id = 0
    while rt.analysis_next_windowed_target <= transcript_count:
        ok, task_id, err = _enqueue_analysis(
            rt,
            force=False,
            mode="windowed",
            source=source,
            skip_interval=True,
            target_count=rt.analysis_next_windowed_target,
        )
        if not ok:
            return (enqueued > 0), int(last_task_id), _safe_text(err), False
        enqueued += 1
        last_task_id = int(task_id)
        rt.analysis_next_windowed_target += SUMMARY_INTERVAL

    if enqueued <= 0:
        delta = transcript_count - int(rt.last_analyzed_count)
        return False, 0, f"waiting interval: {delta}/{SUMMARY_INTERVAL}", True
    return True, int(last_task_id), "", False


def _analysis_worker_loop() -> None:
    while True:
        task = ANALYSIS_QUEUE.get()
        try:
            task_gen = int(task.get("generation") or 0)
            snap: RuntimeStore | None = None
            with RT.lock:
                current_gen = int(RT.analysis_generation)
                if task_gen != current_gen:
                    RT.analysis_queued = max(0, int(RT.analysis_queued) - 1)
                    continue
                RT.analysis_inflight = True
                RT.analysis_last_started_id = int(task.get("id") or 0)
                RT.analysis_last_started_at = _now_ts()
                RT.analysis_last_error = ""
                snap = _snapshot_runtime_for_analysis(RT)
                target_count = int(task.get("target_count") or 0)
                if snap is not None and target_count > 0:
                    target_count = max(1, min(target_count, len(snap.transcript)))
                    snap.transcript = list(snap.transcript[:target_count])
                    if snap.last_analyzed_count > target_count:
                        snap.last_analyzed_count = target_count
            try:
                if snap is not None:
                    _run_analysis(
                        snap,
                        force=bool(task.get("force")),
                        mode=_safe_text(task.get("mode"), "windowed"),
                        skip_interval=bool(task.get("skip_interval")),
                    )
            except Exception as exc:
                with RT.lock:
                    RT.analysis_last_error = _safe_text(exc)
                    RT.last_analysis_warning = f"analysis worker 오류: {exc}"
            finally:
                with RT.lock:
                    if task_gen == int(RT.analysis_generation) and snap is not None and not _safe_text(RT.analysis_last_error):
                        _apply_analysis_result(RT, snap)
                        rt_count = len(RT.transcript)
                        next_target = ((int(RT.last_analyzed_count) // SUMMARY_INTERVAL) + 1) * SUMMARY_INTERVAL
                        RT.analysis_next_windowed_target = max(SUMMARY_INTERVAL, min(next_target, rt_count + SUMMARY_INTERVAL))
                    RT.analysis_inflight = False
                    RT.analysis_last_done_id = int(task.get("id") or 0)
                    RT.analysis_last_done_at = _now_ts()
                    RT.analysis_queued = max(0, int(RT.analysis_queued) - 1)
        finally:
            ANALYSIS_QUEUE.task_done()


def _ensure_analysis_worker_started() -> None:
    global ANALYSIS_WORKER_STARTED
    if ANALYSIS_WORKER_STARTED:
        return
    t = threading.Thread(target=_analysis_worker_loop, daemon=True, name="analysis-worker")
    t.start()
    ANALYSIS_WORKER_STARTED = True


def _replay_status(rt: RuntimeStore) -> dict[str, Any]:
    total = len(rt.replay_rows)
    cursor = max(0, min(int(rt.replay_index), total))
    remaining = max(0, total - cursor)
    return {
        "queued_total": total,
        "queued_cursor": cursor,
        "queued_remaining": remaining,
        "done": bool(total > 0 and remaining == 0),
        "source": _safe_text(rt.replay_source),
        "loaded_at": _safe_text(rt.replay_loaded_at),
    }


def _agenda_stack_from_outcomes(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    stack: list[dict[str, str]] = []
    for row in rows:
        st = _safe_text(row.get("agenda_state"), "PROPOSED").upper()
        if st not in {"PROPOSED", "ACTIVE", "CLOSING", "CLOSED"}:
            st = "PROPOSED"
        stack.append({"title": _safe_text(row.get("agenda_title"), "아젠다 미정"), "status": st})
    return stack


def _active_agenda(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    for row in rows:
        if _safe_text(row.get("agenda_state")).upper() in {"ACTIVE", "CLOSING"}:
            return row
    return None


def _refresh_analysis(rt: RuntimeStore) -> dict[str, Any]:
    outcomes = []
    for row in rt.agenda_outcomes:
        if not isinstance(row, dict):
            continue
        summary_items = list(row.get("_summary_items") or [])
        summary = " • ".join(summary_items[-4:]) if summary_items else _safe_text(row.get("summary"))
        key_utterances = list(row.get("key_utterances") or [])
        outcomes.append(
            {
                "agenda_id": _safe_text(row.get("agenda_id")),
                "agenda_title": _safe_text(row.get("agenda_title"), "아젠다 미정"),
                "agenda_state": _safe_text(row.get("agenda_state"), "PROPOSED"),
                "flow_type": _safe_text(row.get("flow_type")),
                "key_utterances": key_utterances,
                "agenda_summary_items": summary_items,
                "summary": summary,
                "summary_references": list(row.get("summary_references") or []),
                "agenda_keywords": list(row.get("agenda_keywords") or []),
                "opinion_groups": list(row.get("opinion_groups") or []),
                "decision_results": list(row.get("decision_results") or []),
                "action_items": list(row.get("action_items") or []),
                "start_turn_id": int(row.get("start_turn_id") or row.get("_start_turn_id") or 0),
                "end_turn_id": int(row.get("end_turn_id") or row.get("_end_turn_id") or 0),
            }
        )

    active = _active_agenda(outcomes)
    candidates = [
        {"title": _safe_text(row.get("agenda_title")), "confidence": 0.7}
        for row in outcomes
        if _safe_text(row.get("agenda_state")).upper() == "PROPOSED"
    ]
    return {
        "agenda": {
            "active": {
                "title": _safe_text((active or {}).get("agenda_title"), ""),
                "confidence": 0.82 if active else 0.0,
            },
            "candidates": candidates[:6],
        },
        "agenda_outcomes": outcomes,
        "evidence_gate": {"claims": []},
    }


def _state_response(rt: RuntimeStore) -> dict[str, Any]:
    client = get_client()
    _ensure_minimum_agenda(rt)
    analysis = _refresh_analysis(rt)
    return {
        "meeting_goal": rt.meeting_goal,
        "initial_context": "",
        "window_size": rt.window_size,
        "transcript": list(rt.transcript),
        "agenda_stack": _agenda_stack_from_outcomes(analysis["agenda_outcomes"]),
        "llm_enabled": rt.llm_enabled,
        "llm_status": client.status(),
        "analysis_runtime": {
            "tick_mode": _safe_text(rt.last_tick_mode, "windowed"),
            "transcript_count": len(rt.transcript),
            "llm_window_turns": rt.window_size,
            "engine_window_turns": rt.window_size,
            "control_plane_source": "gemini",
            "control_plane_reason": rt.last_analysis_warning or ("full_document_once" if rt.last_tick_mode == "full_document" else "summary_every_4_turns"),
            "used_local_fallback": bool(rt.used_local_fallback),
            "title_refine_attempts": int(rt.last_title_refine_attempts),
            "title_refine_success": int(rt.last_title_refine_success),
            "last_llm_json_available": bool(rt.last_llm_parsed_json),
            "last_llm_json_at": _safe_text(rt.last_llm_parsed_at),
            "analysis_worker": _analysis_worker_status(rt),
            "llm_io_count": len(rt.llm_io_logs),
        },
        "replay": _replay_status(rt),
        "llm_io_logs": list(rt.llm_io_logs[-80:]),
        "analysis": analysis,
    }


def _create_agenda(rt: RuntimeStore, title: str, state: str = "ACTIVE") -> dict[str, Any]:
    rt.agenda_seq += 1
    row = {
        "agenda_id": f"agenda-{rt.agenda_seq}",
        "agenda_title": _strip_leading_timestamp(title) or f"안건 {rt.agenda_seq}",
        "agenda_state": state,
        "flow_type": "",
        "key_utterances": [],
        "summary": "",
        "_summary_items": [],
        "summary_references": [],
        "agenda_keywords": [],
        "opinion_groups": [],
        "decision_results": [],
        "action_items": [],
        "start_turn_id": 0,
        "end_turn_id": 0,
    }
    rt.agenda_outcomes.append(row)
    return row


def _ensure_active_agenda(rt: RuntimeStore, title: str) -> dict[str, Any]:
    active = _active_agenda(rt.agenda_outcomes)
    if active is None:
        return _create_agenda(rt, title, "ACTIVE")
    return active


def _ensure_minimum_agenda(rt: RuntimeStore) -> None:
    if rt.agenda_outcomes or not rt.transcript:
        return
    title = _clean_agenda_title("", rt.meeting_goal, []) or "안건 제목 미정"
    row = _create_agenda(rt, title, "ACTIVE")
    row["start_turn_id"] = 1
    row["end_turn_id"] = len(rt.transcript)
    recent = rt.transcript[max(0, len(rt.transcript) - 4) :]
    for t in recent:
        line = f"[{_safe_text(t.get('timestamp'), _now_ts())}] {_safe_text(t.get('text'))}"
        if line:
            row.setdefault("_summary_items", []).append(line)
            row.setdefault("key_utterances", []).append(line)


def _extract_refs(rt: RuntimeStore, evidence_turn_ids: list[int], recent_turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for idx in evidence_turn_ids:
        try:
            pos = int(idx) - 1
        except Exception:
            continue
        if pos < 0 or pos >= len(rt.transcript):
            continue
        t = rt.transcript[pos]
        refs.append(
            {
                "turn_id": pos + 1,
                "speaker": _safe_text(t.get("speaker"), "화자"),
                "timestamp": _safe_text(t.get("timestamp"), _now_ts()),
                "quote": _safe_text(t.get("text")),
                "why": "",
            }
        )
    if refs:
        return refs
    if recent_turns:
        t = recent_turns[-1]
        return [
            {
                "turn_id": int(t.get("turn_id") or 0),
                "speaker": _safe_text(t.get("speaker"), "화자"),
                "timestamp": _safe_text(t.get("timestamp"), _now_ts()),
                "quote": _safe_text(t.get("text")),
                "why": "",
            }
        ]
    return []


def _format_line_from_turn(turn: dict[str, Any], max_chars: int = 180) -> str:
    ts = _safe_text(turn.get("timestamp"), _now_ts())
    text = _strip_leading_timestamp(turn.get("text")).replace("\n", " ").strip()
    if len(text) > max_chars:
        text = text[: max_chars - 1] + "…"
    return f"[{ts}] {text}"


def _ref_from_turn(turn: dict[str, Any], why: str = "요약 근거") -> dict[str, Any]:
    return {
        "turn_id": int(turn.get("turn_id") or 0),
        "speaker": _safe_text(turn.get("speaker"), "화자"),
        "timestamp": _safe_text(turn.get("timestamp"), _now_ts()),
        "quote": _strip_leading_timestamp(turn.get("text")),
        "why": _safe_text(why, "요약 근거"),
    }


def _pick_key_refs(turns: list[dict[str, Any]], keywords: list[str], max_items: int = 6) -> list[dict[str, Any]]:
    scored: list[tuple[float, int, dict[str, Any]]] = []
    kw = [k.lower() for k in keywords[:8]]
    for idx, t in enumerate(turns):
        text = _strip_leading_timestamp(t.get("text"))
        if len(text) < 8:
            continue
        low = text.lower()
        score = min(len(text), 120) / 120.0
        score += sum(2.0 for token in kw if token and token in low)
        if DECISION_PAT.search(text):
            score += 1.4
        if ACTION_PAT.search(text):
            score += 1.0
        scored.append((score, idx, _ref_from_turn(t)))
    if not scored:
        return []
    scored.sort(key=lambda x: (-x[0], x[1]))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _, _, ref in scored:
        key = f"{ref.get('timestamp')}|{ref.get('quote')}"
        if key in seen:
            continue
        out.append(ref)
        seen.add(key)
        if len(out) >= max_items:
            break
    return out


def _segment_turns(turns: list[dict[str, Any]]) -> list[tuple[int, int]]:
    n = len(turns)
    if n == 0:
        return []
    if n <= 40:
        return [(0, n)]

    min_seg = 24
    max_seg = 140
    target = max(2, n // 95)
    target_gap = max(min_seg, n // target)
    win = 16

    bounds = [0]
    last = 0
    i = min_seg
    while i < n - min_seg:
        dist = i - last
        prev_txt = " ".join(_strip_leading_timestamp(t.get("text")) for t in turns[max(last, i - win) : i])
        next_txt = " ".join(_strip_leading_timestamp(t.get("text")) for t in turns[i : min(n, i + win)])
        sim = _text_similarity(prev_txt, next_txt)
        cue = bool(TRANSITION_PAT.search(_strip_leading_timestamp(turns[i].get("text")))) or bool(
            TRANSITION_PAT.search(_strip_leading_timestamp(turns[i - 1].get("text")))
        )
        reached_target = dist >= target_gap
        too_long = dist >= max_seg

        should_split = False
        if too_long:
            should_split = True
        elif sim < 0.22 and dist >= min_seg:
            should_split = True
        elif cue and sim < 0.42 and reached_target:
            should_split = True
        elif reached_target and sim < 0.30:
            should_split = True

        if should_split:
            bounds.append(i)
            last = i
            i += max(4, min_seg // 2)
            continue
        i += 1

    bounds.append(n)
    segments: list[tuple[int, int]] = []
    for s, e in zip(bounds[:-1], bounds[1:]):
        if e <= s:
            continue
        if segments and (e - s) < min_seg:
            ps, _ = segments[-1]
            segments[-1] = (ps, e)
        else:
            segments.append((s, e))

    if len(segments) <= 1 and n >= 120:
        pieces = max(2, min(4, n // 180 + 1))
        step = max(1, n // pieces)
        segments = []
        for p in range(pieces):
            s = p * step
            e = n if p == pieces - 1 else min(n, (p + 1) * step)
            if e > s:
                segments.append((s, e))

    dynamic_cap = max(3, target * 2)
    while len(segments) > dynamic_cap:
        lengths = [(idx, seg[1] - seg[0]) for idx, seg in enumerate(segments)]
        idx = min(lengths, key=lambda x: x[1])[0]
        if idx == 0:
            merged = (segments[0][0], segments[1][1])
            segments = [merged] + segments[2:]
        elif idx == len(segments) - 1:
            merged = (segments[-2][0], segments[-1][1])
            segments = segments[:-2] + [merged]
        else:
            left_len = segments[idx - 1][1] - segments[idx - 1][0]
            right_len = segments[idx + 1][1] - segments[idx + 1][0]
            if left_len <= right_len:
                merged = (segments[idx - 1][0], segments[idx][1])
                segments = segments[: idx - 1] + [merged] + segments[idx + 1 :]
            else:
                merged = (segments[idx][0], segments[idx + 1][1])
                segments = segments[:idx] + [merged] + segments[idx + 2 :]

    return segments


def _pick_key_utterances(turns: list[dict[str, Any]], keywords: list[str], max_items: int = 20) -> list[str]:
    scored: list[tuple[float, int, str]] = []
    kw = [k.lower() for k in keywords[:8]]
    for idx, t in enumerate(turns):
        text = _strip_leading_timestamp(t.get("text"))
        if len(text) < 8:
            continue
        low = text.lower()
        score = min(len(text), 120) / 120.0
        score += sum(2.0 for token in kw if token and token in low)
        if DECISION_PAT.search(text):
            score += 1.4
        if ACTION_PAT.search(text):
            score += 1.0
        scored.append((score, idx, _format_line_from_turn(t)))
    if not scored:
        return []
    scored.sort(key=lambda x: (-x[0], x[1]))
    picked: list[str] = []
    seen: set[str] = set()
    for _, _, line in scored:
        if line in seen:
            continue
        picked.append(line)
        seen.add(line)
        if len(picked) >= max_items:
            break
    return picked


def _extract_decisions_from_turns(turns: list[dict[str, Any]], max_items: int = 6) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for t in turns:
        text = _strip_leading_timestamp(t.get("text"))
        if not text or not DECISION_PAT.search(text):
            continue
        key = text[:120]
        if key in seen:
            continue
        seen.add(key)
        out.append({"opinions": [_format_line_from_turn(t)], "conclusion": key})
        if len(out) >= max_items:
            break
    return out


def _extract_actions_from_turns(turns: list[dict[str, Any]], max_items: int = 10) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for t in turns:
        text = _strip_leading_timestamp(t.get("text"))
        if not text:
            continue
        if not ACTION_PAT.search(text) and not DUE_PAT.search(text):
            continue
        due = ""
        m = DUE_PAT.search(text)
        if m:
            due = _safe_text(m.group(1))
        owner = _safe_text(t.get("speaker"), "-")
        task = text[:160]
        dedup = f"{task}|{owner}|{due}"
        if dedup in seen:
            continue
        seen.add(dedup)
        out.append(
            {
                "item": task,
                "owner": owner,
                "due": due,
                "reasons": [
                    {
                        "speaker": owner,
                        "timestamp": _safe_text(t.get("timestamp"), _now_ts()),
                        "quote": text,
                        "why": "발화 기반 추출",
                    }
                ],
            }
        )
        if len(out) >= max_items:
            break
    return out


def _agenda_turn_overlap_ratio(
    left_start: int,
    left_end: int,
    right_start: int,
    right_end: int,
) -> float:
    if left_start <= 0 or left_end < left_start or right_start <= 0 or right_end < right_start:
        return 0.0
    overlap = min(left_end, right_end) - max(left_start, right_start) + 1
    if overlap <= 0:
        return 0.0
    base = max(1, min(left_end - left_start + 1, right_end - right_start + 1))
    return float(overlap) / float(base)


def _reuse_previous_agenda_ids(
    previous_outcomes: list[dict[str, Any]],
    cleaned_outcomes: list[dict[str, Any]],
) -> list[str]:
    assigned_ids: list[str] = []
    used_prev_indexes: set[int] = set()

    for row_idx, row in enumerate(cleaned_outcomes):
        row_title = _safe_text(row.get("agenda_title"))
        row_start = int(row.get("_start_turn_id") or 0)
        row_end = int(row.get("_end_turn_id") or 0)
        best_prev_idx = -1
        best_score = 0.0

        for prev_idx, prev in enumerate(previous_outcomes):
            if prev_idx in used_prev_indexes:
                continue

            prev_id = _safe_text(prev.get("agenda_id"))
            if not prev_id:
                continue

            prev_title = _safe_text(prev.get("agenda_title"))
            prev_start = int(prev.get("start_turn_id") or 0)
            prev_end = int(prev.get("end_turn_id") or 0)
            title_score = 1.0 if row_title and row_title == prev_title else _text_similarity(row_title, prev_title)
            overlap_score = _agenda_turn_overlap_ratio(row_start, row_end, prev_start, prev_end)
            order_bonus = max(0.0, 0.25 - abs(prev_idx - row_idx) * 0.08)
            score = (title_score * 0.65) + (overlap_score * 0.85) + order_bonus

            if score > best_score:
                best_score = score
                best_prev_idx = prev_idx

        if best_prev_idx >= 0 and best_score >= 0.45:
            used_prev_indexes.add(best_prev_idx)
            assigned_ids.append(_safe_text(previous_outcomes[best_prev_idx].get("agenda_id")))
        else:
            assigned_ids.append("")

    return assigned_ids


def _max_agenda_sequence(agenda_rows: list[dict[str, Any]]) -> int:
    max_seq = 0
    for row in agenda_rows:
        agenda_id = _safe_text(row.get("agenda_id"))
        match = re.match(r"^agenda-(\d+)$", agenda_id)
        if not match:
            continue
        max_seq = max(max_seq, int(match.group(1)))
    return max_seq


def _dedup_preserve(items: list[str], limit: int = 10) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        txt = _safe_text(item)
        if not txt or txt in seen:
            continue
        out.append(txt)
        seen.add(txt)
        if len(out) >= limit:
            break
    return out


def _slice_turns_by_id_range(turns: list[dict[str, Any]], start_id: int, end_id: int) -> list[dict[str, Any]]:
    if not turns:
        return []
    s = int(start_id or 0)
    e = int(end_id or 0)
    if s <= 0 and e <= 0:
        return list(turns)
    if e > 0 and e < s:
        e = s
    out: list[dict[str, Any]] = []
    for t in turns:
        tid = int(t.get("turn_id") or 0)
        if tid <= 0:
            continue
        if s > 0 and tid < s:
            continue
        if e > 0 and tid > e:
            continue
        out.append(t)
    return out


def _sample_turns_for_title(seg_turns: list[dict[str, Any]], max_items: int = 140) -> list[dict[str, Any]]:
    if len(seg_turns) <= max_items:
        return list(seg_turns)
    if max_items <= 0:
        return []

    head = min(20, max_items // 4)
    tail = min(20, max_items // 4)
    mid = max(0, max_items - head - tail)
    n = len(seg_turns)

    idxs: set[int] = set()
    for i in range(head):
        idxs.add(i)
    for i in range(n - tail, n):
        if i >= 0:
            idxs.add(i)

    if mid > 0:
        span_start = head
        span_end = max(span_start, n - tail)
        span = max(1, span_end - span_start)
        for i in range(mid):
            pos = span_start + int((i / max(1, mid - 1)) * (span - 1))
            idxs.add(pos)

    ordered = sorted(idxs)
    return [seg_turns[i] for i in ordered if 0 <= i < n]


def _request_agenda_title_with_llm(
    rt: RuntimeStore,
    client: Any,
    meeting_goal: str,
    turns: list[dict[str, Any]],
    start_turn_id: int,
    end_turn_id: int,
    summary_items: list[str],
    key_utterances: list[str],
    keywords: list[str],
) -> str:
    seg_turns = _slice_turns_by_id_range(turns, start_turn_id, end_turn_id)
    if not seg_turns:
        seg_turns = list(turns)
    if not seg_turns:
        return ""

    sampled = _sample_turns_for_title(seg_turns, max_items=140)
    lines: list[str] = []
    for t in sampled:
        tid = int(t.get("turn_id") or 0)
        ts = _safe_text(t.get("timestamp"), _now_ts())
        speaker = _safe_text(t.get("speaker"), "화자")
        text = _strip_leading_timestamp(t.get("text"))
        if not text:
            continue
        lines.append(f"- turn_id={tid} | {ts} | {speaker} | {text}")
    if not lines:
        return ""

    summary_ctx: list[str] = []
    for item in summary_items[:8]:
        _, body = _split_ts_prefix(item)
        point = _to_summary_point(body, max_len=None)
        if point:
            summary_ctx.append(f"- {point}")

    key_ctx: list[str] = []
    for item in key_utterances[:8]:
        _, body = _split_ts_prefix(item)
        point = _to_summary_point(body, max_len=None)
        if point:
            key_ctx.append(f"- {point}")

    prompt = f"""
너는 회의 안건 제목 생성기다. 출력은 JSON 객체 하나만 반환한다.

[입력]
- 회의 목표: {_safe_text(meeting_goal, "미정")}
- 안건 구간: turn_id {start_turn_id}~{end_turn_id}
- 안건 키워드: {", ".join([_safe_text(k) for k in keywords[:6]]) or "없음"}
- 안건 요약 포인트:
{chr(10).join(summary_ctx) if summary_ctx else "- 없음"}
- 안건 핵심 발언:
{chr(10).join(key_ctx) if key_ctx else "- 없음"}
- 안건 구간 발화(시간순):
{chr(10).join(lines)}

[규칙]
1) 위 안건 구간 전체를 관통하는 상위 논지를 한국어 한 문장으로 요약한다.
2) 발화 한 줄을 그대로 복사하지 않는다.
3) 단어 나열, "A · B 논의", "안건 N" 같은 형식 문구를 금지한다.
4) 자연스러운 한 문장 제목으로 작성한다.

[출력 JSON]
{{
  "agenda_title": "string"
}}
""".strip()

    try:
        parsed = _call_llm_json(
            rt=rt,
            client=client,
            prompt=prompt,
            stage="title_refine.segment",
            temperature=0.05,
            max_tokens=220,
        )
    except Exception:
        return ""

    candidate = _safe_text(parsed.get("agenda_title") or parsed.get("title"))
    candidate = _to_summary_point(candidate, max_len=None)
    candidate = _safe_text(candidate).strip(" .,!?:;/|")
    if not candidate:
        return ""
    if _is_low_quality_title(candidate, meeting_goal):
        return ""
    return _safe_text(candidate[:80], "")


def _refresh_low_quality_titles_with_llm(
    client: Any,
    rt: RuntimeStore,
    turns: list[dict[str, Any]],
    outcomes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    refreshed: list[dict[str, Any]] = []
    attempts = 0
    success = 0
    for row in outcomes:
        item = dict(row)
        title = _safe_text(item.get("agenda_title"))
        if (not title) or _is_low_quality_title(title, rt.meeting_goal):
            attempts += 1
            regenerated = _request_agenda_title_with_llm(
                rt=rt,
                client=client,
                meeting_goal=rt.meeting_goal,
                turns=turns,
                start_turn_id=int(item.get("_start_turn_id") or item.get("start_turn_id") or 0),
                end_turn_id=int(item.get("_end_turn_id") or item.get("end_turn_id") or 0),
                summary_items=[_safe_text(x) for x in (item.get("_summary_items") or [])],
                key_utterances=[_safe_text(x) for x in (item.get("key_utterances") or [])],
                keywords=[_safe_text(x) for x in (item.get("agenda_keywords") or [])],
            )
            if regenerated:
                item["agenda_title"] = regenerated
                success += 1
        refreshed.append(item)
    return refreshed, attempts, success


def _compact_summary_line(text: str, max_len: int = 90) -> str:
    s = _strip_leading_timestamp(text)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(음|어|네|예|일단|그러면|그럼|근데|그러니까)\s+", "", s)
    if len(s) > max_len:
        s = s[: max_len - 1].rstrip() + "…"
    return _safe_text(s)


def _enrich_outcome_summary(
    rt: RuntimeStore,
    row: dict[str, Any],
    turns: list[dict[str, Any]],
) -> dict[str, Any]:
    out = dict(row)
    start_id = int(out.get("_start_turn_id") or out.get("start_turn_id") or 0)
    end_id = int(out.get("_end_turn_id") or out.get("end_turn_id") or 0)
    seg_turns = _slice_turns_by_id_range(turns, start_id, end_id)
    if not seg_turns:
        return out

    keywords = _dedup_preserve([_safe_text(k) for k in out.get("agenda_keywords") or []], limit=6)
    if len(keywords) < 3:
        extra = _top_keywords_from_rows(seg_turns, rt.meeting_goal, limit=6)
        keywords = _dedup_preserve(keywords + extra, limit=6)
    out["agenda_keywords"] = keywords

    refs = _pick_key_refs(seg_turns, keywords, max_items=8)

    key_utterances = _dedup_preserve([_safe_text(x) for x in out.get("key_utterances") or []], limit=20)
    if len(key_utterances) < 3:
        auto_key = [f"[{_safe_text(r.get('timestamp'))}] {_safe_text(r.get('quote'))}" for r in refs[:12]]
        key_utterances = _dedup_preserve(key_utterances + auto_key, limit=20)
    out["key_utterances"] = key_utterances

    summary_items = _normalize_summary_item_lines([_safe_text(x) for x in out.get("_summary_items") or []])
    summary_refs = [dict(x) for x in (out.get("summary_references") or []) if isinstance(x, dict)]

    has_min_summary = len(summary_items) >= 2
    has_min_refs = len(summary_refs) >= 2
    if (not has_min_summary) or (not has_min_refs):
        auto_items: list[str] = []
        auto_refs: list[dict[str, Any]] = []
        for idx, ref in enumerate(refs[:12]):
            quote = _to_summary_point(_safe_text(ref.get("quote")))
            if not quote:
                continue
            ts = _safe_text(ref.get("timestamp"), _now_ts())
            auto_items.append(f"[{ts}] {quote}")
            auto_refs.append(
                {
                    "turn_id": int(ref.get("turn_id") or 0),
                    "speaker": _safe_text(ref.get("speaker"), "화자"),
                    "timestamp": ts,
                    "quote": _safe_text(ref.get("quote")),
                    "why": quote,
                }
            )
            if idx >= 9:
                break

        if not has_min_summary:
            summary_items = _dedup_preserve(summary_items + auto_items, limit=20)
        if not has_min_refs:
            summary_refs = summary_refs + auto_refs

    if not summary_refs:
        summary_refs = [_ref_from_turn(seg_turns[-1], why="요약 근거")]
    out["_summary_items"] = _normalize_summary_item_lines(summary_items)
    out["summary_references"] = summary_refs[:24]
    if not _safe_text(out.get("summary")):
        out["summary"] = " • ".join(x.split("] ", 1)[-1] for x in out["_summary_items"][:10])
    out["agenda_title"] = _finalize_agenda_title(
        out.get("agenda_title"),
        rt.meeting_goal,
        [_safe_text(k) for k in out.get("agenda_keywords") or []],
        out.get("_summary_items") or [],
        out.get("key_utterances") or [],
    )
    return out


def _build_local_outcomes(rt: RuntimeStore, turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments = _segment_turns(turns)
    if not segments and turns:
        segments = [(0, len(turns))]

    global_df = _doc_freq(turns)
    global_turn_count = len(turns)
    outcomes: list[dict[str, Any]] = []
    used_titles: set[str] = set()

    for seg_idx, (s, e) in enumerate(segments):
        seg_turns = turns[s:e]
        if not seg_turns:
            continue
        keywords = _top_keywords_from_rows(
            seg_turns,
            rt.meeting_goal,
            limit=6,
            global_doc_freq=global_df,
            global_turn_count=global_turn_count,
        )

        key_refs = _pick_key_refs(seg_turns, keywords, max_items=8)
        key_utterances = [f"[{_safe_text(r.get('timestamp'))}] {_safe_text(r.get('quote'))}" for r in key_refs]
        summary_refs = key_refs[:10] if key_refs else [_ref_from_turn(seg_turns[-1])]
        summary_items = [f"[{_safe_text(r.get('timestamp'))}] {_to_summary_point(_safe_text(r.get('quote')))}" for r in summary_refs]
        summary_items = _normalize_summary_item_lines(summary_items)

        seed_candidates = [t.get("text") for t in seg_turns[:6]] + [t.get("text") for t in seg_turns[-6:]]
        seed_title = _extractive_title_from_candidates([_safe_text(x) for x in seed_candidates], rt.meeting_goal)
        title = _finalize_agenda_title(seed_title, rt.meeting_goal, keywords, summary_items, key_utterances)
        if not _safe_text(title):
            title = f"안건 {seg_idx + 1}"
        if title in used_titles:
            title = f"{title} #{seg_idx + 1}"
        used_titles.add(title)

        summary = " • ".join(item.split("] ", 1)[-1] for item in summary_items[:10])
        decisions = _extract_decisions_from_turns(seg_turns, max_items=4)
        actions = _extract_actions_from_turns(seg_turns, max_items=6)

        flow_type = "discussion"
        if decisions:
            flow_type = "decision"
        elif actions:
            flow_type = "action-planning"

        outcomes.append(
            {
                "agenda_title": _strip_leading_timestamp(title) or f"안건 {seg_idx + 1}",
                "agenda_state": "ACTIVE" if seg_idx == len(segments) - 1 else "CLOSED",
                "flow_type": flow_type,
                "key_utterances": _dedup_preserve(key_utterances, limit=20),
                "_summary_items": _dedup_preserve(summary_items, limit=20),
                "summary_references": summary_refs,
                "summary": _safe_text(summary),
                "agenda_keywords": _dedup_preserve(keywords, limit=6),
                "opinion_groups": [],
                "decision_results": decisions,
                "action_items": actions,
                "_start_turn_id": int(seg_turns[0].get("turn_id", 1) or 1),
                "_end_turn_id": int(seg_turns[-1].get("turn_id", 1) or 1),
            }
        )

    return outcomes


def _normalize_outcome_ranges(
    outcomes: list[dict[str, Any]],
    min_turn_id: int,
    max_turn_id: int,
) -> list[dict[str, Any]]:
    cleaned = [dict(row) for row in outcomes if isinstance(row, dict)]
    if not cleaned:
        return []
    cleaned.sort(key=lambda x: int(x.get("_start_turn_id") or x.get("start_turn_id") or 10**9))

    lo = int(min_turn_id or 1)
    hi = int(max(max_turn_id, lo))
    prev_end = lo - 1

    for idx, row in enumerate(cleaned):
        start_id = int(row.get("_start_turn_id") or row.get("start_turn_id") or 0)
        end_id = int(row.get("_end_turn_id") or row.get("end_turn_id") or 0)

        if start_id <= 0:
            start_id = prev_end + 1 if prev_end >= lo else lo
        start_id = max(start_id, prev_end + 1, lo)
        start_id = min(start_id, hi)

        if end_id < start_id:
            end_id = start_id
        end_id = max(start_id, min(end_id, hi))

        row["_start_turn_id"] = start_id
        row["_end_turn_id"] = end_id
        prev_end = end_id

    for idx, row in enumerate(cleaned[:-1]):
        next_start = int(cleaned[idx + 1].get("_start_turn_id") or 0)
        start_id = int(row.get("_start_turn_id") or 0)
        end_id = int(row.get("_end_turn_id") or 0)
        if next_start > 0 and end_id >= next_start:
            row["_end_turn_id"] = max(start_id, next_start - 1)

    if cleaned:
        cleaned[0]["_start_turn_id"] = lo
        last_start = int(cleaned[-1].get("_start_turn_id") or lo)
        cleaned[-1]["_end_turn_id"] = max(last_start, hi)

    return cleaned


def _refine_outcomes_by_density(
    rt: RuntimeStore,
    outcomes: list[dict[str, Any]],
    turns: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str]:
    if not outcomes or not turns:
        return outcomes, ""

    turn_ids = [int(t.get("turn_id") or 0) for t in turns if int(t.get("turn_id") or 0) > 0]
    if not turn_ids:
        return outcomes, ""

    min_turn = min(turn_ids)
    max_turn = max(turn_ids)
    total_turns = max_turn - min_turn + 1
    if total_turns <= 0:
        return outcomes, ""

    normalized = _normalize_outcome_ranges(outcomes, min_turn, max_turn)
    if not normalized:
        return outcomes, ""

    # 대화 길이에 맞춰 최소 안건 수와 최대 안건 폭을 동적으로 조정한다.
    expected_min = 1 if total_turns < 90 else max(2, min(10, round(total_turns / 90)))
    max_span = 120 if total_turns < 220 else max(130, min(240, int(total_turns * 0.33)))
    split_min_span = 75 if total_turns < 220 else max(85, int(total_turns * 0.14))

    turn_map = {int(t.get("turn_id") or 0): t for t in turns}
    adjusted: list[dict[str, Any]] = []
    split_rows = 0

    for row in normalized:
        start_id = int(row.get("_start_turn_id") or 0)
        end_id = int(row.get("_end_turn_id") or 0)
        span = end_id - start_id + 1
        need_more = len(normalized) < expected_min
        should_split = span > max_span or (need_more and span >= split_min_span)

        if not should_split:
            adjusted.append(row)
            continue

        seg_turns = [turn_map[i] for i in range(start_id, end_id + 1) if i in turn_map]
        if len(seg_turns) < 40:
            adjusted.append(row)
            continue

        local_rows = _build_local_outcomes(rt, seg_turns)
        local_rows = _normalize_outcome_ranges(local_rows, start_id, end_id)
        if len(local_rows) <= 1:
            adjusted.append(row)
            continue

        base_state = _normalize_agenda_state(row.get("agenda_state"))
        for idx, local in enumerate(local_rows):
            merged = dict(local)
            if base_state in {"ACTIVE", "CLOSING"}:
                merged["agenda_state"] = "ACTIVE" if idx == len(local_rows) - 1 else "CLOSED"
            elif base_state == "CLOSED":
                merged["agenda_state"] = "CLOSED"
            else:
                merged["agenda_state"] = base_state
            adjusted.append(merged)
        split_rows += len(local_rows) - 1

    adjusted = _normalize_outcome_ranges(adjusted, min_turn, max_turn)
    if not adjusted:
        return normalized, ""

    if len(adjusted) < expected_min and total_turns >= 160:
        local_all = _build_local_outcomes(rt, turns)
        local_all = _normalize_outcome_ranges(local_all, min_turn, max_turn)
        if len(local_all) > len(adjusted):
            return local_all, f"LLM 안건 수가 적어 로컬 경계 보정 적용({len(local_all)}개)"

    if split_rows > 0:
        return adjusted, f"과대 안건 범위 자동 분할 적용(+{split_rows})"

    return adjusted, ""


def _apply_outcomes(rt: RuntimeStore, outcomes: list[dict[str, Any]]) -> None:
    cleaned = [dict(row) for row in outcomes if isinstance(row, dict)]
    if not cleaned:
        return
    cleaned.sort(key=lambda x: int(x.get("_start_turn_id") or 10**9))

    prev_end = 0
    for idx, row in enumerate(cleaned):
        start_id = int(row.get("_start_turn_id") or row.get("start_turn_id") or 0)
        end_id = int(row.get("_end_turn_id") or row.get("end_turn_id") or 0)
        if start_id <= 0:
            start_id = prev_end + 1 if prev_end > 0 else (idx + 1)
        if end_id < start_id:
            end_id = start_id
        row["_start_turn_id"] = start_id
        row["_end_turn_id"] = end_id
        prev_end = max(prev_end, end_id)

    for idx, row in enumerate(cleaned):
        if idx >= len(cleaned) - 1:
            continue
        next_start = int(cleaned[idx + 1].get("_start_turn_id") or 0)
        end_id = int(row.get("_end_turn_id") or 0)
        start_id = int(row.get("_start_turn_id") or 0)
        if next_start > 0 and (end_id <= start_id or end_id >= next_start):
            row["_end_turn_id"] = max(start_id, next_start - 1)

    active_idx = -1
    for idx, row in enumerate(cleaned):
        if _normalize_agenda_state(row.get("agenda_state")) in {"ACTIVE", "CLOSING"}:
            active_idx = idx
            break
    if active_idx < 0 and cleaned:
        active_idx = len(cleaned) - 1

    for idx, row in enumerate(cleaned):
        if idx == active_idx:
            row["agenda_state"] = "ACTIVE"
        elif _normalize_agenda_state(row.get("agenda_state")) == "ACTIVE":
            row["agenda_state"] = "CLOSED"
        else:
            row["agenda_state"] = _normalize_agenda_state(row.get("agenda_state"))

    previous_outcomes = [copy.deepcopy(item) for item in rt.agenda_outcomes if isinstance(item, dict)]
    reused_agenda_ids = _reuse_previous_agenda_ids(previous_outcomes, cleaned)

    rt.agenda_outcomes = []
    rt.agenda_seq = 0
    for row_idx, row in enumerate(cleaned):
        created = _create_agenda(rt, _safe_text(row.get("agenda_title"), "안건 제목 미정"), _normalize_agenda_state(row.get("agenda_state")))
        reused_agenda_id = _safe_text(reused_agenda_ids[row_idx] if row_idx < len(reused_agenda_ids) else "")
        if reused_agenda_id:
            created["agenda_id"] = reused_agenda_id
        created["flow_type"] = _safe_text(row.get("flow_type"))
        created["key_utterances"] = _dedup_preserve(list(row.get("key_utterances") or []), limit=20)
        created["_summary_items"] = _dedup_preserve(list(row.get("_summary_items") or []), limit=20)
        created["summary_references"] = list(row.get("summary_references") or [])
        created["summary"] = _safe_text(row.get("summary"))
        created["agenda_keywords"] = _dedup_preserve(list(row.get("agenda_keywords") or []), limit=6)
        created["opinion_groups"] = list(row.get("opinion_groups") or [])
        created["decision_results"] = list(row.get("decision_results") or [])
        created["action_items"] = list(row.get("action_items") or [])
        created["start_turn_id"] = int(row.get("_start_turn_id") or 0)
        created["end_turn_id"] = int(row.get("_end_turn_id") or 0)
    rt.agenda_seq = max(rt.agenda_seq, _max_agenda_sequence(rt.agenda_outcomes))


def _to_ids(raw_ids: Any) -> list[int]:
    out: list[int] = []
    for x in raw_ids or []:
        try:
            out.append(int(str(x)))
        except Exception:
            continue
    return out


def _build_agenda_outline_prompt(rt: RuntimeStore, turns: list[dict[str, Any]], current_agenda_title: str, mode: str = "windowed") -> str:
    meeting_goal = _safe_text(rt.meeting_goal, "미정")
    turn_count = len(turns)
    agenda_hint_min = 1 if turn_count < 90 else max(2, min(10, round(turn_count / 100)))
    agenda_hint_max = max(agenda_hint_min, min(12, agenda_hint_min + 3))
    lines = []
    for turn in turns:
        text = _strip_leading_timestamp(turn.get("text"))
        lines.append(
            f"- turn_id={turn['turn_id']} | {turn['timestamp']} | {turn['speaker']} | {text}"
        )
    transcript_block = "\n".join(lines)

    return f"""
너는 회의 아젠다 구간 분할기다. 출력은 반드시 JSON 하나만 반환한다.

[입력]
- 전체 회의 목표: {meeting_goal}
- 현재 진행 안건: {current_agenda_title or "없음"}
- 분석 모드: {mode}
- 발화 목록(시간순):
{transcript_block}

[중요 규칙]
1) 안건은 "흐름 전환 시점" 기준으로 순서대로 나눈다. 즉, 주제가 전환될 때마다 새 안건을 만든다.
2) 안건 제목은 해당 안건 구간의 모든 발언을 관통하는 "상위 논지"를 한국어 한 문장으로 요약해 작성한다. 단어 나열/문장 복사는 금지한다.
3) 현재 진행 안건이 이미 있으면, 정말로 주제가 크게 바뀌었을 때만 새 ACTIVE 안건으로 둔다.
4) 각 안건은 start_turn_id/end_turn_id를 반드시 포함하고, 안건 간 구간은 시간순/비중첩으로 작성한다.
5) 분석 모드가 full_document이면, 발화 전체를 끝까지 보고 안건을 한 번에 완성한다. 중간 단계 안건 생성은 금지한다.
6) full_document에서는 총 발화 수({turn_count})를 고려해 안건 수를 동적으로 잡아라. 권장 안건 수는 {agenda_hint_min}~{agenda_hint_max}개이며, 마지막 안건만 과도하게 길어지지 않게 분할한다.
7) 이 단계에서는 상세 필드(키워드, 핵심발언, 요약, 근거, 의사결정, 액션아이템)를 생성하지 않는다.

[출력 JSON 스키마]
{{
  "active_agenda_title": "string",
  "agendas": [
    {{
      "agenda_title": "string",
      "agenda_state": "PROPOSED|ACTIVE|CLOSING|CLOSED",
      "start_turn_id": 1,
      "end_turn_id": 20,
      "flow_type": "discussion|decision|action-planning"
    }}
  ]
}}
""".strip()


def _build_agenda_detail_prompt(
    rt: RuntimeStore,
    agenda_title: str,
    agenda_state: str,
    flow_type: str,
    start_turn_id: int,
    end_turn_id: int,
    seg_turns: list[dict[str, Any]],
) -> str:
    meeting_goal = _safe_text(rt.meeting_goal, "미정")
    lines = []
    for turn in seg_turns:
        text = _strip_leading_timestamp(turn.get("text"))
        lines.append(
            f"- turn_id={turn['turn_id']} | {turn['timestamp']} | {turn['speaker']} | {text}"
        )
    transcript_block = "\n".join(lines)

    return f"""
너는 회의 안건 상세 추출기다. 출력은 반드시 JSON 하나만 반환한다.

[입력]
- 전체 회의 목표: {meeting_goal}
- 안건 제목: {_safe_text(agenda_title, "미정")}
- 안건 상태: {_safe_text(agenda_state, "PROPOSED")}
- 안건 흐름 타입: {_safe_text(flow_type, "discussion")}
- 안건 turn 범위: {start_turn_id}~{end_turn_id}
- 안건 구간 발화(시간순):
{transcript_block}

[중요 규칙]
1) 아래 출력 필드만 채운다.
2) evidence_turn_ids, key_utterance_turn_ids는 반드시 입력 turn_id만 사용한다.
3) agenda_keywords는 3~6개 핵심 용어로 작성한다.
4) key_utterance_turn_ids는 핵심 발언 turn_id를 3~10개로 선택한다.
5) agenda_summary_items는 2개 이상 작성하고, 각 항목에 evidence_turn_ids를 포함한다.
6) summary는 위 summary_items를 1~3문장으로 종합한 안건 요약이다.
7) decision_results는 확정된 결론만 포함한다. 없으면 빈 배열.
8) action_items는 누가/무엇/기한/근거를 포함한다. 없으면 빈 배열.
9) 원문 장문 인용은 금지하고, 요약 문장으로 작성한다.
10) opinion_groups를 반드시 작성한다. 안건 내 유사 의견을 묶어 2~8개 그룹으로 정리한다.
11) 각 opinion_groups 항목은 type, summary, evidence_turn_ids를 포함해야 한다.
12) type은 proposal|concern|question|agree|disagree|info 중 하나만 사용한다.

[출력 JSON 스키마]
{{
  "agenda_keywords": ["string", "string"],
  "key_utterance_turn_ids": [1,2,3],
  "agenda_summary_items": [
    {{"summary": "string", "evidence_turn_ids": [1,2]}}
  ],
  "summary": "string",
  "opinion_groups": [
    {{
      "type": "proposal|concern|question|agree|disagree|info",
      "summary": "string",
      "evidence_turn_ids": [1,2]
    }}
  ],
  "decision_results": [
    {{
      "conclusion": "string",
      "opinions": ["string"],
      "evidence_turn_ids": [1,2]
    }}
  ],
  "action_items": [
    {{
      "item": "string",
      "owner": "string",
      "due": "string",
      "reason": "string",
      "evidence_turn_ids": [1,2]
    }}
  ]
}}
""".strip()


def _build_windowed_shift_prompt(
    rt: RuntimeStore,
    current_title: str,
    current_flow_type: str,
    current_start_turn_id: int,
    recent_turns: list[dict[str, Any]],
) -> str:
    meeting_goal = _safe_text(rt.meeting_goal, "미정")
    lines = []
    for turn in recent_turns:
        text = _strip_leading_timestamp(turn.get("text"))
        lines.append(
            f"- turn_id={turn['turn_id']} | {turn['timestamp']} | {turn['speaker']} | {text}"
        )
    transcript_block = "\n".join(lines)
    return f"""
너는 실시간 회의 안건 전환 감지기다. 출력은 JSON 하나만 반환한다.

[입력]
- 회의 목표: {meeting_goal}
- 현재 ACTIVE 안건: {_safe_text(current_title, "없음")}
- 현재 안건 흐름 타입: {_safe_text(current_flow_type, "discussion")}
- 현재 안건 시작 turn_id: {int(current_start_turn_id or 1)}
- 최근 발화:
{transcript_block}

[규칙]
1) 최근 발화가 현재 안건과 동일 흐름이면 shifted=false.
2) 주제 전환이 충분히 명확하면 shifted=true.
3) shifted=true일 때만 new_agenda_title/new_flow_type/shift_turn_id를 채운다.
4) shift_turn_id는 입력 turn_id 중 하나여야 한다.
5) new_agenda_title은 상위 논지 한 문장으로 작성한다.

[출력 JSON]
{{
  "shifted": true,
  "shift_turn_id": 120,
  "new_agenda_title": "string",
  "new_flow_type": "discussion|decision|action-planning",
  "reason": "string"
}}
""".strip()


def _extract_detail_fields_from_parsed(
    rt: RuntimeStore,
    turns: list[dict[str, Any]],
    seg_turns: list[dict[str, Any]],
    detail_parsed: dict[str, Any],
) -> dict[str, Any]:
    keywords = _dedup_preserve([_safe_text(x) for x in (detail_parsed.get("agenda_keywords") or []) if _safe_text(x)], limit=8)
    key_refs = _extract_refs(rt, _to_ids(detail_parsed.get("key_utterance_turn_ids")), turns)
    key_utterances = _dedup_preserve([f"[{r['timestamp']}] {r['quote']}" for r in key_refs], limit=8)

    summary_items: list[str] = []
    summary_references: list[dict[str, Any]] = []
    for it in detail_parsed.get("agenda_summary_items") or []:
        if not isinstance(it, dict):
            continue
        txt = _to_summary_point(_safe_text(it.get("summary")))
        if not txt:
            continue
        refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
        if refs:
            summary_items.append(f"[{refs[0]['timestamp']}] {txt}")
            for ref in refs[:6]:
                summary_references.append(
                    {
                        "turn_id": int(ref.get("turn_id") or 0),
                        "speaker": ref["speaker"],
                        "timestamp": ref["timestamp"],
                        "quote": ref["quote"],
                        "why": txt,
                    }
                )
        else:
            summary_items.append(txt)
    if not summary_items:
        from_keys: list[str] = []
        for line in key_utterances[:10]:
            ts, body = _split_ts_prefix(line)
            point = _to_summary_point(body)
            if not point:
                continue
            from_keys.append(f"[{ts}] {point}" if ts else point)
        summary_items = from_keys
    summary_items = _normalize_summary_item_lines(summary_items)
    if not summary_references:
        for ref in key_refs[:10]:
            summary_references.append(
                {
                    "turn_id": int(ref.get("turn_id") or 0),
                    "speaker": ref["speaker"],
                    "timestamp": ref["timestamp"],
                    "quote": ref["quote"],
                    "why": "핵심 발언",
                }
            )

    if not keywords:
        keywords = _top_keywords_from_rows(seg_turns, rt.meeting_goal, limit=6)
    if not key_utterances and seg_turns:
        key_utterances = [_format_line_from_turn(seg_turns[-1])]

    opinion_groups: list[dict[str, Any]] = []
    for it in detail_parsed.get("opinion_groups") or []:
        if not isinstance(it, dict):
            continue
        typ = _safe_text(it.get("type"), "info").lower()
        if typ not in {"proposal", "concern", "question", "agree", "disagree", "info"}:
            typ = "info"
        summary_txt = _to_summary_point(_safe_text(it.get("summary")), max_len=None)
        if not summary_txt:
            continue
        ids = _to_ids(it.get("evidence_turn_ids"))
        refs = _extract_refs(rt, ids, seg_turns)
        turn_ids = _dedup_preserve([str(int(r.get("turn_id") or 0)) for r in refs if int(r.get("turn_id") or 0) > 0], limit=12)
        evidence_ids = [int(x) for x in turn_ids if str(x).isdigit()]
        if not evidence_ids:
            evidence_ids = [tid for tid in ids if tid > 0][:12]
        opinion_groups.append(
            {
                "type": typ,
                "summary": summary_txt,
                "evidence_turn_ids": evidence_ids,
            }
        )

    decisions: list[dict[str, Any]] = []
    for it in detail_parsed.get("decision_results") or []:
        if not isinstance(it, dict):
            continue
        conclusion = _safe_text(it.get("conclusion"))
        if not conclusion:
            continue
        opinions = [_safe_text(x) for x in (it.get("opinions") or []) if _safe_text(x)]
        refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
        for r in refs[:3]:
            opinions.append(f"[{r['timestamp']}] {r['quote']}")
        decisions.append({"opinions": _dedup_preserve(opinions, 5), "conclusion": conclusion})

    actions: list[dict[str, Any]] = []
    for it in detail_parsed.get("action_items") or []:
        if not isinstance(it, dict):
            continue
        item = _safe_text(it.get("item"))
        if not item:
            continue
        owner = _safe_text(it.get("owner"), "-")
        due = _safe_text(it.get("due"))
        reason = _safe_text(it.get("reason"))
        refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
        reasons = []
        for r in refs:
            reasons.append(
                {
                    "speaker": r["speaker"],
                    "timestamp": r["timestamp"],
                    "quote": r["quote"],
                    "why": reason,
                }
            )
        actions.append({"item": item, "owner": owner, "due": due, "reasons": reasons})

    summary = _to_summary_point(_safe_text(detail_parsed.get("summary")), max_len=None)
    if not summary:
        summary = " • ".join(x.split("] ", 1)[-1] for x in summary_items[:10])

    return {
        "agenda_keywords": _dedup_preserve(keywords, limit=6),
        "key_utterances": _dedup_preserve(key_utterances, limit=20),
        "_summary_items": _dedup_preserve(summary_items, limit=20),
        "summary_references": summary_references[:24],
        "summary": _safe_text(summary),
        "opinion_groups": opinion_groups[:12],
        "decision_results": decisions,
        "action_items": actions,
    }


def _merge_agenda_fields(target: dict[str, Any], fields: dict[str, Any]) -> None:
    target["agenda_keywords"] = _dedup_preserve(
        list(target.get("agenda_keywords") or []) + list(fields.get("agenda_keywords") or []),
        limit=6,
    )
    target["key_utterances"] = _dedup_preserve(
        list(target.get("key_utterances") or []) + list(fields.get("key_utterances") or []),
        limit=20,
    )
    target["_summary_items"] = _dedup_preserve(
        list(target.get("_summary_items") or []) + list(fields.get("_summary_items") or []),
        limit=20,
    )
    refs = [dict(x) for x in (target.get("summary_references") or []) if isinstance(x, dict)] + [
        dict(x) for x in (fields.get("summary_references") or []) if isinstance(x, dict)
    ]
    dedup_refs: list[dict[str, Any]] = []
    seen_ref: set[str] = set()
    for ref in refs:
        key = f"{int(ref.get('turn_id') or 0)}|{_safe_text(ref.get('quote'))}"
        if key in seen_ref:
            continue
        seen_ref.add(key)
        dedup_refs.append(ref)
        if len(dedup_refs) >= 24:
            break
    target["summary_references"] = dedup_refs
    if _safe_text(fields.get("summary")):
        target["summary"] = _safe_text(fields.get("summary"))

    if fields.get("opinion_groups") is not None:
        target["opinion_groups"] = list(fields.get("opinion_groups") or [])

    dec_src = list(target.get("decision_results") or []) + list(fields.get("decision_results") or [])
    dec_out: list[dict[str, Any]] = []
    seen_dec: set[str] = set()
    for d in dec_src:
        if not isinstance(d, dict):
            continue
        key = _safe_text(d.get("conclusion"))
        if not key or key in seen_dec:
            continue
        seen_dec.add(key)
        dec_out.append(d)
    target["decision_results"] = dec_out

    act_src = list(target.get("action_items") or []) + list(fields.get("action_items") or [])
    act_out: list[dict[str, Any]] = []
    seen_act: set[str] = set()
    for a in act_src:
        if not isinstance(a, dict):
            continue
        key = f"{_safe_text(a.get('item'))}|{_safe_text(a.get('owner'))}|{_safe_text(a.get('due'))}"
        if not _safe_text(a.get("item")) or key in seen_act:
            continue
        seen_act.add(key)
        act_out.append(a)
    target["action_items"] = act_out


def _run_realtime_window_analysis(rt: RuntimeStore, client: Any) -> bool:
    if not rt.transcript:
        return False

    turns: list[dict[str, Any]] = []
    for i, row in enumerate(rt.transcript, start=1):
        turns.append(
            {
                "turn_id": i,
                "timestamp": _safe_text(row.get("timestamp"), _now_ts()),
                "speaker": _safe_text(row.get("speaker"), "화자"),
                "text": _safe_text(row.get("text")),
            }
        )
    max_turn = len(turns)
    if max_turn <= 0:
        return False

    active = _active_agenda(rt.agenda_outcomes)
    if active is None:
        seed = _extractive_title_from_candidates([_strip_leading_timestamp(t.get("text")) for t in turns[-8:]], rt.meeting_goal)
        active = _create_agenda(rt, _safe_text(seed, "안건 진행"), "ACTIVE")
        active["start_turn_id"] = max(1, max_turn - min(7, max_turn - 1))
        active["end_turn_id"] = max_turn
        active["flow_type"] = "discussion"

    active_start = int(active.get("start_turn_id") or 1)
    active_end = int(active.get("end_turn_id") or active_start)
    if active_end < active_start:
        active_end = active_start
    active["start_turn_id"] = active_start
    active["end_turn_id"] = max(active_end, max_turn)

    recent_window = max(40, min(160, rt.window_size * 10))
    recent_turns = turns[max(0, len(turns) - recent_window) :]
    shift_prompt = _build_windowed_shift_prompt(
        rt=rt,
        current_title=_safe_text(active.get("agenda_title")),
        current_flow_type=_normalize_flow_type(active.get("flow_type")),
        current_start_turn_id=active_start,
        recent_turns=recent_turns,
    )
    try:
        shift_parsed = _call_llm_json(
            rt=rt,
            client=client,
            prompt=shift_prompt,
            stage="realtime.shift",
            temperature=0.05,
            max_tokens=700,
        )
    except Exception as exc:
        return _run_local_fallback(rt, force=False, reason=f"실시간 안건 전환 감지 실패: {exc}", mode="windowed")

    shifted = _boolify(shift_parsed.get("shifted"), False)
    shift_turn_id = int(shift_parsed.get("shift_turn_id") or 0)
    recent_ids = {int(t.get("turn_id") or 0) for t in recent_turns}
    if shift_turn_id not in recent_ids:
        shift_turn_id = max_turn
    if shift_turn_id <= active_start:
        shifted = False
    shift_guard_reason = ""
    active_title = _safe_text(active.get("agenda_title"))
    candidate_title = _safe_text(shift_parsed.get("new_agenda_title"))
    active_span = max(0, max_turn - active_start + 1)
    if shifted and not candidate_title:
        shifted = False
        shift_guard_reason = "전환 차단: 새 안건 제목 비어 있음"
    if shifted and (not _topic_far_enough(active_title, candidate_title)):
        shifted = False
        shift_guard_reason = "전환 차단: 현재 안건과 제목 유사"
    if shifted and active_span < REALTIME_MIN_SHIFT_SPAN:
        shifted = False
        shift_guard_reason = f"전환 차단: 안건 길이 {active_span}turn < {REALTIME_MIN_SHIFT_SPAN}turn"

    title_refine_attempts = 0
    title_refine_success = 0

    if shifted:
        prev_end = max(active_start, min(max_turn, shift_turn_id - 1))
        active["end_turn_id"] = prev_end
        active["agenda_state"] = "CLOSED"

        prev_turns = _slice_turns_by_id_range(turns, active_start, prev_end)
        prev_detail: dict[str, Any] = {}
        if prev_turns:
            try:
                prev_prompt = _build_agenda_detail_prompt(
                    rt=rt,
                    agenda_title=_safe_text(active.get("agenda_title")),
                    agenda_state="CLOSED",
                    flow_type=_normalize_flow_type(active.get("flow_type")),
                    start_turn_id=active_start,
                    end_turn_id=prev_end,
                    seg_turns=prev_turns,
                )
                prev_detail = _call_llm_json(
                    rt=rt,
                    client=client,
                    prompt=prev_prompt,
                    stage="realtime.prev_detail",
                    temperature=0.1,
                    max_tokens=2200,
                )
            except Exception:
                prev_detail = {}
        prev_fields = _extract_detail_fields_from_parsed(rt, turns, prev_turns or recent_turns, prev_detail or {})
        _merge_agenda_fields(active, prev_fields)

        title = _safe_text(active.get("agenda_title"))
        if (not title) or _is_low_quality_title(title, rt.meeting_goal):
            title_refine_attempts += 1
            regenerated = _request_agenda_title_with_llm(
                client=client,
                meeting_goal=rt.meeting_goal,
                turns=turns,
                start_turn_id=active_start,
                end_turn_id=prev_end,
                summary_items=list(active.get("_summary_items") or []),
                key_utterances=list(active.get("key_utterances") or []),
                keywords=list(active.get("agenda_keywords") or []),
            )
            if regenerated:
                active["agenda_title"] = regenerated
                title_refine_success += 1

        new_title = _safe_text(shift_parsed.get("new_agenda_title"))
        new_flow = _normalize_flow_type(shift_parsed.get("new_flow_type"))
        new_row = _create_agenda(rt, _safe_text(new_title, "새 안건"), "ACTIVE")
        new_row["flow_type"] = new_flow
        new_row["start_turn_id"] = shift_turn_id
        new_row["end_turn_id"] = max_turn

        new_turns = _slice_turns_by_id_range(turns, shift_turn_id, max_turn)
        new_detail: dict[str, Any] = {}
        if new_turns:
            try:
                new_prompt = _build_agenda_detail_prompt(
                    rt=rt,
                    agenda_title=_safe_text(new_row.get("agenda_title")),
                    agenda_state="ACTIVE",
                    flow_type=new_flow,
                    start_turn_id=shift_turn_id,
                    end_turn_id=max_turn,
                    seg_turns=new_turns,
                )
                new_detail = _call_llm_json(
                    rt=rt,
                    client=client,
                    prompt=new_prompt,
                    stage="realtime.new_detail",
                    temperature=0.1,
                    max_tokens=2200,
                )
            except Exception:
                new_detail = {}
        new_fields = _extract_detail_fields_from_parsed(rt, turns, new_turns or recent_turns, new_detail or {})
        _merge_agenda_fields(new_row, new_fields)

        if (not _safe_text(new_row.get("agenda_title"))) or _is_low_quality_title(_safe_text(new_row.get("agenda_title")), rt.meeting_goal):
            title_refine_attempts += 1
            regenerated = _request_agenda_title_with_llm(
                client=client,
                meeting_goal=rt.meeting_goal,
                turns=turns,
                start_turn_id=shift_turn_id,
                end_turn_id=max_turn,
                summary_items=list(new_row.get("_summary_items") or []),
                key_utterances=list(new_row.get("key_utterances") or []),
                keywords=list(new_row.get("agenda_keywords") or []),
            )
            if regenerated:
                new_row["agenda_title"] = regenerated
                title_refine_success += 1
    else:
        active["agenda_state"] = "ACTIVE"
        active["end_turn_id"] = max_turn
        seg_start = max(active_start, max_turn - recent_window + 1)
        seg_turns = _slice_turns_by_id_range(turns, seg_start, max_turn)
        detail_parsed: dict[str, Any] = {}
        if seg_turns:
            try:
                prompt = _build_agenda_detail_prompt(
                    rt=rt,
                    agenda_title=_safe_text(active.get("agenda_title")),
                    agenda_state="ACTIVE",
                    flow_type=_normalize_flow_type(active.get("flow_type")),
                    start_turn_id=seg_start,
                    end_turn_id=max_turn,
                    seg_turns=seg_turns,
                )
                detail_parsed = _call_llm_json(
                    rt=rt,
                    client=client,
                    prompt=prompt,
                    stage="realtime.active_detail",
                    temperature=0.1,
                    max_tokens=2000,
                )
            except Exception:
                detail_parsed = {}
        fields = _extract_detail_fields_from_parsed(rt, turns, seg_turns or recent_turns, detail_parsed or {})
        _merge_agenda_fields(active, fields)

    rt.last_analyzed_count = len(rt.transcript)
    rt.used_local_fallback = False
    rt.last_tick_mode = "windowed"
    rt.last_title_refine_attempts = int(title_refine_attempts)
    rt.last_title_refine_success = int(title_refine_success)
    warn = (
        f"실시간 모드: {'안건 전환 감지' if shifted else '현재 안건 유지'} | "
        f"안건 제목 재요청 {title_refine_success}/{title_refine_attempts} 성공"
    )
    if shift_guard_reason:
        warn = f"{warn} | {shift_guard_reason}"
    rt.last_analysis_warning = warn
    rt.last_llm_parsed_json = {
        "pipeline": "windowed_realtime",
        "shift": shift_parsed,
        "agenda_count": len(rt.agenda_outcomes),
        "active_agenda_title": _safe_text((_active_agenda(rt.agenda_outcomes) or {}).get("agenda_title")),
    }
    rt.last_llm_parsed_at = _now_ts()
    return True


def _run_local_fallback(rt: RuntimeStore, force: bool = False, reason: str = "", mode: str = "windowed") -> bool:
    if not rt.transcript:
        return False
    if mode != "full_document" and (not force) and (len(rt.transcript) - rt.last_analyzed_count) < SUMMARY_INTERVAL:
        return False

    turns: list[dict[str, Any]] = []
    for i, row in enumerate(rt.transcript, start=1):
        turns.append(
            {
                "turn_id": i,
                "timestamp": _safe_text(row.get("timestamp"), _now_ts()),
                "speaker": _safe_text(row.get("speaker"), "화자"),
                "text": _safe_text(row.get("text")),
            }
        )
    outcomes = _build_local_outcomes(rt, turns)
    if outcomes:
        _apply_outcomes(rt, outcomes)

    rt.last_analyzed_count = len(rt.transcript)
    rt.used_local_fallback = True
    rt.last_analysis_warning = reason or "LLM 비활성/실패로 로컬 폴백 분석 사용"
    rt.last_tick_mode = "full_document" if mode == "full_document" else "windowed"
    rt.last_title_refine_attempts = 0
    rt.last_title_refine_success = 0
    return True


def _run_analysis(rt: RuntimeStore, force: bool = False, mode: str = "windowed", skip_interval: bool = False) -> bool:
    if not rt.transcript:
        rt.used_local_fallback = True
        rt.last_analysis_warning = "전사 데이터가 없어 분석할 수 없습니다."
        rt.last_tick_mode = "full_document" if mode == "full_document" else "windowed"
        rt.last_title_refine_attempts = 0
        rt.last_title_refine_success = 0
        return False
    if mode != "full_document" and (not force) and (not skip_interval) and (len(rt.transcript) - rt.last_analyzed_count) < SUMMARY_INTERVAL:
        return False
    if not rt.llm_enabled:
        return _run_local_fallback(rt, force=force, reason="LLM 미연결", mode=mode)

    client = get_client()
    if not client.connected:
        return _run_local_fallback(rt, force=force, reason="LLM 연결 끊김", mode=mode)

    if mode == "windowed" and not force:
        return _run_realtime_window_analysis(rt, client)

    full_document = mode == "full_document"
    base_idx = 0 if (force or full_document) else max(0, len(rt.transcript) - max(220, rt.window_size * 10))
    turns: list[dict[str, Any]] = []
    for i, row in enumerate(rt.transcript[base_idx:], start=base_idx + 1):
        turns.append(
            {
                "turn_id": i,
                "timestamp": _safe_text(row.get("timestamp")),
                "speaker": _safe_text(row.get("speaker")),
                "text": _safe_text(row.get("text")),
            }
        )

    # 1단계: 전체 전사 기준 안건 구간(제목/상태/흐름)만 먼저 추출
    active = _active_agenda(rt.agenda_outcomes)
    current_title = _safe_text((active or {}).get("agenda_title"))
    outline_prompt = _build_agenda_outline_prompt(rt, turns, current_title, mode=mode)
    try:
        outline_parsed = _call_llm_json(
            rt=rt,
            client=client,
            prompt=outline_prompt,
            stage="full.outline",
            temperature=0.1,
            max_tokens=2800,
        )
    except Exception as exc:
        return _run_local_fallback(rt, force=force, reason=f"LLM 1차(안건 구간) 오류: {exc}", mode=mode)

    raw_agendas = outline_parsed.get("agendas") or []
    if not isinstance(raw_agendas, list) or not raw_agendas:
        return _run_local_fallback(rt, force=force, reason="LLM 1차 응답에서 agendas가 비어 로컬 폴백 사용", mode=mode)

    turn_ids = [int(t.get("turn_id") or 0) for t in turns if int(t.get("turn_id") or 0) > 0]
    if not turn_ids:
        return _run_local_fallback(rt, force=force, reason="안건 구간 계산용 turn_id 없음", mode=mode)
    min_turn = min(turn_ids)
    max_turn = max(turn_ids)

    outline_rows: list[dict[str, Any]] = []
    for idx, agenda in enumerate(raw_agendas):
        if not isinstance(agenda, dict):
            continue
        row = {
            "agenda_title": _safe_text(agenda.get("agenda_title")),
            "agenda_state": _normalize_agenda_state(agenda.get("agenda_state")),
            "flow_type": _safe_text(agenda.get("flow_type"), "discussion"),
            "_start_turn_id": int(agenda.get("start_turn_id") or 0),
            "_end_turn_id": int(agenda.get("end_turn_id") or 0),
        }
        if row["_start_turn_id"] <= 0:
            row["_start_turn_id"] = min_turn + idx
        if row["_end_turn_id"] < row["_start_turn_id"]:
            row["_end_turn_id"] = row["_start_turn_id"]
        outline_rows.append(row)

    if not outline_rows:
        return _run_local_fallback(rt, force=force, reason="LLM 1차 안건 파싱 실패", mode=mode)

    outline_rows = _normalize_outcome_ranges(outline_rows, min_turn, max_turn)
    outline_rows, refine_note = _refine_outcomes_by_density(rt, outline_rows, turns)
    if not outline_rows:
        return _run_local_fallback(rt, force=force, reason="1차 안건 구간 보정 실패", mode=mode)

    # 2단계: 안건 구간별 상세 필드 개별 요청
    active_title = _safe_text(outline_parsed.get("active_agenda_title"))
    active_title_norm = active_title.strip().lower()
    outcomes: list[dict[str, Any]] = []
    title_refine_attempts = 0
    title_refine_success = 0
    detail_attempts = 0
    detail_success = 0
    detail_logs: list[dict[str, Any]] = []

    for idx, agenda in enumerate(outline_rows):
        start_turn_id = int(agenda.get("_start_turn_id") or agenda.get("start_turn_id") or 0)
        end_turn_id = int(agenda.get("_end_turn_id") or agenda.get("end_turn_id") or 0)
        seg_turns = _slice_turns_by_id_range(turns, start_turn_id, end_turn_id)
        if not seg_turns:
            seg_turns = list(turns)

        raw_title = _safe_text(agenda.get("agenda_title"))
        state = _normalize_agenda_state(agenda.get("agenda_state"))
        flow_type = _safe_text(agenda.get("flow_type"), "discussion")

        detail_attempts += 1
        detail_parsed: dict[str, Any] = {}
        detail_error = ""
        try:
            detail_prompt = _build_agenda_detail_prompt(
                rt=rt,
                agenda_title=raw_title,
                agenda_state=state,
                flow_type=flow_type,
                start_turn_id=start_turn_id,
                end_turn_id=end_turn_id,
                seg_turns=seg_turns,
            )
            detail_parsed = _call_llm_json(
                rt=rt,
                client=client,
                prompt=detail_prompt,
                stage=f"full.detail.{idx + 1}",
                temperature=0.1,
                max_tokens=3200,
            )
            detail_success += 1
        except Exception as exc:
            detail_error = str(exc)
            detail_parsed = {}

        detail_logs.append(
            {
                "agenda_index": idx + 1,
                "start_turn_id": start_turn_id,
                "end_turn_id": end_turn_id,
                "title_seed": raw_title,
                "error": detail_error,
                "response": detail_parsed,
            }
        )

        keywords = _dedup_preserve([_safe_text(x) for x in (detail_parsed.get("agenda_keywords") or []) if _safe_text(x)], limit=8)
        key_refs = _extract_refs(rt, _to_ids(detail_parsed.get("key_utterance_turn_ids")), turns)
        key_utterances = _dedup_preserve([f"[{r['timestamp']}] {r['quote']}" for r in key_refs], limit=8)

        summary_items: list[str] = []
        summary_references: list[dict[str, Any]] = []
        for it in detail_parsed.get("agenda_summary_items") or []:
            if not isinstance(it, dict):
                continue
            txt = _to_summary_point(_safe_text(it.get("summary")))
            if not txt:
                continue
            refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
            if refs:
                summary_items.append(f"[{refs[0]['timestamp']}] {txt}")
                for ref in refs[:6]:
                    summary_references.append(
                        {
                            "turn_id": int(ref.get("turn_id") or 0),
                            "speaker": ref["speaker"],
                            "timestamp": ref["timestamp"],
                            "quote": ref["quote"],
                            "why": txt,
                        }
                    )
            else:
                summary_items.append(txt)
        if not summary_items:
            from_keys: list[str] = []
            for line in key_utterances[:10]:
                ts, body = _split_ts_prefix(line)
                point = _to_summary_point(body)
                if not point:
                    continue
                from_keys.append(f"[{ts}] {point}" if ts else point)
            summary_items = from_keys
        summary_items = _normalize_summary_item_lines(summary_items)
        if not summary_references:
            for ref in key_refs[:10]:
                summary_references.append(
                    {
                        "turn_id": 0,
                        "speaker": ref["speaker"],
                        "timestamp": ref["timestamp"],
                        "quote": ref["quote"],
                        "why": "핵심 발언",
                    }
                )

        opinion_groups: list[dict[str, Any]] = []
        for it in detail_parsed.get("opinion_groups") or []:
            if not isinstance(it, dict):
                continue
            typ = _safe_text(it.get("type"), "info").lower()
            if typ not in {"proposal", "concern", "question", "agree", "disagree", "info"}:
                typ = "info"
            summary_txt = _to_summary_point(_safe_text(it.get("summary")), max_len=None)
            if not summary_txt:
                continue
            ids = _to_ids(it.get("evidence_turn_ids"))
            refs = _extract_refs(rt, ids, seg_turns)
            turn_ids = _dedup_preserve([str(int(r.get("turn_id") or 0)) for r in refs if int(r.get("turn_id") or 0) > 0], limit=12)
            evidence_ids = [int(x) for x in turn_ids if str(x).isdigit()]
            if not evidence_ids:
                evidence_ids = [tid for tid in ids if tid > 0][:12]
            opinion_groups.append(
                {
                    "type": typ,
                    "summary": summary_txt,
                    "evidence_turn_ids": evidence_ids,
                }
            )

        decisions: list[dict[str, Any]] = []
        for it in detail_parsed.get("decision_results") or []:
            if not isinstance(it, dict):
                continue
            conclusion = _safe_text(it.get("conclusion"))
            if not conclusion:
                continue
            opinions = [_safe_text(x) for x in (it.get("opinions") or []) if _safe_text(x)]
            refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
            for r in refs[:3]:
                opinions.append(f"[{r['timestamp']}] {r['quote']}")
            decisions.append({"opinions": _dedup_preserve(opinions, 5), "conclusion": conclusion})

        actions: list[dict[str, Any]] = []
        for it in detail_parsed.get("action_items") or []:
            if not isinstance(it, dict):
                continue
            item = _safe_text(it.get("item"))
            if not item:
                continue
            owner = _safe_text(it.get("owner"), "-")
            due = _safe_text(it.get("due"))
            reason = _safe_text(it.get("reason"))
            refs = _extract_refs(rt, _to_ids(it.get("evidence_turn_ids")), turns)
            reasons = []
            for r in refs:
                reasons.append(
                    {
                        "speaker": r["speaker"],
                        "timestamp": r["timestamp"],
                        "quote": r["quote"],
                        "why": reason,
                    }
                )
            actions.append({"item": item, "owner": owner, "due": due, "reasons": reasons})

        if not keywords:
            keywords = _top_keywords_from_rows(seg_turns, rt.meeting_goal, limit=6)
        if not key_utterances and turns:
            pick_idx = min(len(turns) - 1, idx * max(1, len(turns) // max(1, len(outline_rows))))
            key_utterances = [_format_line_from_turn(turns[pick_idx])]

        all_ids = _to_ids(detail_parsed.get("key_utterance_turn_ids"))
        for s_item in detail_parsed.get("agenda_summary_items") or []:
            if isinstance(s_item, dict):
                all_ids.extend(_to_ids(s_item.get("evidence_turn_ids")))
        if start_turn_id <= 0:
            start_turn_id = min(all_ids) if all_ids else (idx + 1) * 1000
        if end_turn_id < start_turn_id:
            end_turn_id = max(all_ids) if all_ids else start_turn_id

        need_title_refine = (not _safe_text(raw_title)) or _is_low_quality_title(raw_title, rt.meeting_goal)
        if need_title_refine:
            title_refine_attempts += 1
            regenerated = _request_agenda_title_with_llm(
                client=client,
                meeting_goal=rt.meeting_goal,
                turns=turns,
                start_turn_id=start_turn_id,
                end_turn_id=end_turn_id,
                summary_items=summary_items,
                key_utterances=key_utterances,
                keywords=keywords,
            )
            if regenerated:
                raw_title = regenerated
                title_refine_success += 1

        title = _finalize_agenda_title(raw_title, rt.meeting_goal, keywords, summary_items, key_utterances)
        if (not _safe_text(title)) or _is_low_quality_title(title, rt.meeting_goal):
            title_refine_attempts += 1
            regenerated = _request_agenda_title_with_llm(
                client=client,
                meeting_goal=rt.meeting_goal,
                turns=turns,
                start_turn_id=start_turn_id,
                end_turn_id=end_turn_id,
                summary_items=summary_items,
                key_utterances=key_utterances,
                keywords=keywords,
            )
            if regenerated:
                title = regenerated
                title_refine_success += 1

        direct_match = active_title_norm and title.strip().lower() == active_title_norm
        sim_match = active_title and _text_similarity(active_title, title) >= 0.55
        if direct_match or sim_match:
            state = "ACTIVE"

        summary = _to_summary_point(_safe_text(detail_parsed.get("summary")), max_len=None)
        if not summary:
            summary = " • ".join(x.split("] ", 1)[-1] for x in summary_items[:10])

        outcomes.append(
            {
                "agenda_title": _strip_leading_timestamp(title) or f"안건 {idx + 1}",
                "agenda_state": state,
                "flow_type": flow_type,
                "key_utterances": _dedup_preserve(key_utterances, limit=20),
                "_summary_items": _dedup_preserve(summary_items, limit=20),
                "summary_references": summary_references[:24],
                "summary": _safe_text(summary),
                "agenda_keywords": _dedup_preserve(keywords, limit=6),
                "opinion_groups": opinion_groups[:12],
                "decision_results": decisions,
                "action_items": actions,
                "_start_turn_id": start_turn_id,
                "_end_turn_id": end_turn_id,
            }
        )

    if not outcomes:
        return _run_local_fallback(rt, force=force, reason="LLM agendas 파싱 실패", mode=mode)

    enriched: list[dict[str, Any]] = []
    for row in outcomes:
        enriched.append(_enrich_outcome_summary(rt, row, turns))
    outcomes = enriched
    outcomes, post_attempts, post_success = _refresh_low_quality_titles_with_llm(client, rt, turns, outcomes)
    title_refine_attempts += post_attempts
    title_refine_success += post_success

    rt.last_llm_parsed_json = {
        "pipeline": "two_stage",
        "outline": outline_parsed,
        "details": detail_logs,
    }
    rt.last_llm_parsed_at = _now_ts()

    _apply_outcomes(rt, outcomes)

    rt.last_analyzed_count = len(rt.transcript)
    rt.used_local_fallback = False
    notes: list[str] = []
    if _safe_text(refine_note):
        notes.append(_safe_text(refine_note))
    notes.append(f"안건 상세 추출 {detail_success}/{detail_attempts} 성공")
    notes.append(f"안건 제목 재요청 {title_refine_success}/{title_refine_attempts} 성공")
    rt.last_analysis_warning = " | ".join(notes)
    rt.last_tick_mode = "full_document" if mode == "full_document" else "windowed"
    rt.last_title_refine_attempts = int(title_refine_attempts)
    rt.last_title_refine_success = int(title_refine_success)
    return True


def _append_turn(rt: RuntimeStore, speaker: str, text: str, timestamp: str | None = None) -> None:
    body = _safe_text(text)
    if not body:
        return
    rt.transcript.append(
        {
            "speaker": _safe_text(speaker, "화자"),
            "text": body,
            "timestamp": _safe_text(timestamp, _now_ts()),
        }
    )
    rt.transcript_version += 1


def _append_many_turns(rt: RuntimeStore, rows: list[dict[str, str]]) -> int:
    before = len(rt.transcript)
    for row in rows:
        _append_turn(rt, row.get("speaker", "화자"), row.get("text", ""), row.get("timestamp"))
    return len(rt.transcript) - before


async def _collect_rows_from_uploads(files: list[UploadFile]) -> dict[str, Any]:
    files_scanned = 0
    files_parsed = 0
    files_skipped = 0
    parse_errors: list[dict[str, str]] = []
    file_stats: list[dict[str, Any]] = []
    all_rows: list[dict[str, str]] = []
    applied_goal = None

    for upload in files:
        files_scanned += 1
        try:
            blob = await upload.read()
            raw = blob.decode("utf-8")
        except UnicodeDecodeError:
            try:
                raw = blob.decode("utf-8-sig")
            except Exception:
                files_skipped += 1
                parse_errors.append({"file": upload.filename or "upload.json", "error": "decode failed"})
                continue
        except Exception:
            files_skipped += 1
            parse_errors.append({"file": upload.filename or "upload.json", "error": "read failed"})
            continue

        data = _extract_json(raw)
        if not data:
            files_skipped += 1
            parse_errors.append({"file": upload.filename or "upload.json", "error": "json parse failed"})
            continue
        ok_payload, payload_reason = _looks_like_meeting_payload(data)
        if not ok_payload:
            files_skipped += 1
            parse_errors.append({"file": upload.filename or "upload.json", "error": payload_reason})
            continue
        goal, rows = _parse_meeting_json_payload(data)
        if not rows:
            files_skipped += 1
            parse_errors.append({"file": upload.filename or "upload.json", "error": "utterance rows extracted = 0"})
            continue

        if goal and not applied_goal:
            applied_goal = goal
        all_rows.extend(rows)
        files_parsed += 1
        file_stats.append({"file": upload.filename or "upload.json", "rows": len(rows)})

    return {
        "rows": all_rows,
        "files_scanned": files_scanned,
        "files_parsed": files_parsed,
        "files_skipped": files_skipped,
        "file_stats": file_stats,
        "parse_errors": parse_errors[:20],
        "applied_goal": applied_goal,
    }


def _serialize_audio_import_job(job: AudioImportJob) -> dict[str, Any]:
    return {
        "ok": True,
        "job_id": _safe_text(job.job_id),
        "meeting_id": _safe_text(job.meeting_id),
        "filename": _safe_text(job.filename),
        "status": _safe_text(job.status, "queued"),
        "progress": max(0.0, min(float(job.progress), 100.0)),
        "step": _safe_text(job.step, "queued"),
        "detail": _safe_text(job.detail),
        "created_at": _safe_text(job.created_at),
        "updated_at": _safe_text(job.updated_at),
        "transcript_count": int(job.transcript_count),
        "speaker_count": int(job.speaker_count),
        "used_diarization": bool(job.used_diarization),
        "warning": _safe_text(job.warning),
        "error": _safe_text(job.error),
        "state": copy.deepcopy(job.state) if isinstance(job.state, dict) else None,
    }


def _create_audio_import_job(meeting_id: str, user_id: str, filename: str) -> AudioImportJob:
    job = AudioImportJob(
        job_id=str(uuid4()),
        meeting_id=_safe_text(meeting_id),
        user_id=_safe_text(user_id),
        filename=_safe_text(filename, "audio"),
    )
    with _AUDIO_IMPORT_JOBS_LOCK:
        _AUDIO_IMPORT_JOBS[job.job_id] = job
        stale = list(_AUDIO_IMPORT_JOBS.keys())[:-24]
        for key in stale:
            _AUDIO_IMPORT_JOBS.pop(key, None)
    return job


def _get_audio_import_job(job_id: str) -> AudioImportJob | None:
    with _AUDIO_IMPORT_JOBS_LOCK:
        job = _AUDIO_IMPORT_JOBS.get(_safe_text(job_id))
        return copy.deepcopy(job) if job else None


def _update_audio_import_job(job_id: str, **changes: Any) -> AudioImportJob | None:
    with _AUDIO_IMPORT_JOBS_LOCK:
        job = _AUDIO_IMPORT_JOBS.get(_safe_text(job_id))
        if not job:
            return None
        for key, value in changes.items():
            if hasattr(job, key):
                setattr(job, key, value)
        job.updated_at = _now_ts()
        return copy.deepcopy(job)


def _run_ffmpeg_to_mono_wav(source_path: Path, target_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(target_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not target_path.exists():
        raise RuntimeError((result.stderr or result.stdout or "ffmpeg normalize failed").strip())


def _measure_wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate() or 16000
        return max(float(frames) / float(rate), 0.0)


def _load_pyannote_pipeline():
    global _PYANNOTE_PIPELINE
    token = _env_first("HUGGINGFACE_TOKEN", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN")
    if not token:
        raise RuntimeError("HUGGINGFACE_TOKEN이 없어 diarization을 실행할 수 없습니다.")

    with _PYANNOTE_LOCK:
        if _PYANNOTE_PIPELINE is not None:
            return _PYANNOTE_PIPELINE

        try:
            from pyannote.audio import Pipeline
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("pyannote.audio 패키지가 없습니다. diarization 의존성을 설치하세요.") from exc

        pipeline = Pipeline.from_pretrained(PYANNOTE_DIARIZATION_MODEL, use_auth_token=token)
        try:
            import torch

            if torch.cuda.is_available():
                pipeline.to(torch.device("cuda"))
        except Exception:
            pass

        _PYANNOTE_PIPELINE = pipeline
        return _PYANNOTE_PIPELINE


def _diarize_audio_file(path: Path) -> list[dict[str, Any]]:
    pipeline = _load_pyannote_pipeline()
    diarization = pipeline(str(path))
    rows: list[dict[str, Any]] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = max(0.0, float(turn.start))
        end = max(start, float(turn.end))
        rows.append(
            {
                "start": start,
                "end": end,
                "speaker": _safe_text(speaker, "SPEAKER_00"),
            }
        )
    return rows


def _load_whisper_model():
    try:
        import whisper
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("whisper 패키지가 없습니다. `pip install openai-whisper` 후 다시 실행하세요.") from exc
    return whisper.load_model(WHISPER_MODEL_NAME)


_WHISPER_MODEL = None
_WHISPER_LOCK = threading.Lock()


def _get_whisper_model():
    global _WHISPER_MODEL
    with _WHISPER_LOCK:
        if _WHISPER_MODEL is None:
            _WHISPER_MODEL = _load_whisper_model()
        return _WHISPER_MODEL


def _transcribe_with_whisper(data: bytes, suffix: str, meeting_goal: str = "") -> str:
    model = _get_whisper_model()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        kwargs = {"language": "ko", "task": "transcribe", "verbose": False}
        clean_goal = _safe_text(meeting_goal)
        if clean_goal:
            kwargs["initial_prompt"] = f"회의 목표: {clean_goal}. 회의 관련 고유명사와 핵심 용어를 한국어로 정확히 전사한다."
        try:
            import torch

            kwargs["fp16"] = bool(torch.cuda.is_available())
        except Exception:
            kwargs["fp16"] = False
        result = model.transcribe(tmp_path, **kwargs)
        return _safe_text((result or {}).get("text"))
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _transcribe_file_with_whisper_segments(path: Path) -> dict[str, Any]:
    model = _get_whisper_model()
    kwargs = {"language": "ko", "task": "transcribe", "verbose": False}
    try:
        import torch

        kwargs["fp16"] = bool(torch.cuda.is_available())
    except Exception:
        kwargs["fp16"] = False

    result = model.transcribe(str(path), **kwargs) or {}
    segments: list[dict[str, Any]] = []
    for segment in result.get("segments") or []:
        text = _safe_text(segment.get("text"))
        if not text:
            continue
        start = max(0.0, float(segment.get("start") or 0.0))
        end = max(start, float(segment.get("end") or start))
        segments.append({"start": start, "end": end, "text": text})
    return {
        "text": _safe_text(result.get("text")),
        "segments": segments,
    }


def _speaker_with_max_overlap(
    start_sec: float,
    end_sec: float,
    diarization_rows: list[dict[str, Any]],
    last_speaker: str,
) -> str:
    if not diarization_rows:
        return _safe_text(last_speaker, "화자 1")

    best_speaker = ""
    best_overlap = 0.0
    for row in diarization_rows:
        overlap = min(end_sec, float(row.get("end") or 0.0)) - max(start_sec, float(row.get("start") or 0.0))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = _safe_text(row.get("speaker"))

    if best_speaker:
        return best_speaker
    return _safe_text(last_speaker, "화자 1")


def _ends_like_sentence(text: str) -> bool:
    return bool(re.search(r"[.!?。！？…]$|습니다$|입니다$|어요$|예요$|했어요$|했습니다$", _safe_text(text)))


def _split_sentence_by_length(text: str, max_chars: int = 92) -> list[str]:
    clean = re.sub(r"\s+", " ", _safe_text(text)).strip()
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]

    parts: list[str] = []
    remaining = clean
    while len(remaining) > max_chars:
        candidate = remaining[: max_chars + 1]
        split_at = max(candidate.rfind(marker) for marker in (" ", ",", "·", " / ", " - "))
        if split_at < max_chars // 2:
            split_at = candidate.rfind(" ")
        if split_at < max_chars // 2:
            split_at = max_chars
        chunk = remaining[:split_at].strip(" ,·-/")
        if chunk:
            parts.append(chunk)
        remaining = remaining[split_at:].strip()
    if remaining:
        parts.append(remaining)
    return parts


def _split_text_naturally(text: str, max_chars: int = 92) -> list[str]:
    clean = re.sub(r"\s+", " ", _safe_text(text)).strip()
    if not clean:
        return []

    sentences = [segment.strip() for segment in re.split(r"(?<=[.!?。！？])\s+", clean) if segment.strip()]
    if not sentences:
        sentences = [clean]

    parts: list[str] = []
    current = ""
    for sentence in sentences:
        if not current:
            if len(sentence) <= max_chars:
                current = sentence
            else:
                parts.extend(_split_sentence_by_length(sentence, max_chars=max_chars))
        elif len(current) + 1 + len(sentence) <= max_chars:
            current = f"{current} {sentence}"
        else:
            parts.append(current)
            if len(sentence) <= max_chars:
                current = sentence
            else:
                parts.extend(_split_sentence_by_length(sentence, max_chars=max_chars))
                current = ""
    if current:
        parts.append(current)
    return parts


def _segment_timestamp(base_time: datetime, offset_sec: float) -> str:
    return (base_time + timedelta(seconds=max(offset_sec, 0.0))).isoformat()


def _build_import_utterances(
    whisper_segments: list[dict[str, Any]],
    diarization_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, str]], int]:
    base_time = datetime.now(timezone.utc)
    speaker_aliases: dict[str, str] = {}
    atomic_rows: list[dict[str, Any]] = []
    last_speaker = "SPEAKER_00"

    for segment in whisper_segments:
        raw_text = _safe_text(segment.get("text"))
        if not raw_text:
            continue
        seg_start = max(0.0, float(segment.get("start") or 0.0))
        seg_end = max(seg_start, float(segment.get("end") or seg_start))
        parts = _split_text_naturally(raw_text)
        if not parts:
            continue

        duration = max(seg_end - seg_start, 0.001)
        total_weight = max(sum(max(len(item), 1) for item in parts), 1)
        cursor = seg_start
        remaining = duration
        remaining_weight = total_weight

        for index, part in enumerate(parts):
            weight = max(len(part), 1)
            if index == len(parts) - 1 or remaining_weight <= weight:
                piece_duration = remaining
            else:
                piece_duration = duration * (weight / total_weight)
                piece_duration = min(piece_duration, remaining)
            piece_end = max(cursor, min(seg_end, cursor + piece_duration))
            raw_speaker = _speaker_with_max_overlap(cursor, piece_end, diarization_rows, last_speaker)
            last_speaker = raw_speaker
            speaker_label = speaker_aliases.setdefault(raw_speaker, f"화자 {len(speaker_aliases) + 1}")
            atomic_rows.append(
                {
                    "speaker": speaker_label,
                    "text": part,
                    "timestamp": _segment_timestamp(base_time, cursor),
                }
            )
            remaining -= max(piece_end - cursor, 0.0)
            remaining_weight -= weight
            cursor = piece_end

    utterances: list[dict[str, str]] = []
    for row in atomic_rows:
        body = _safe_text(row.get("text"))
        speaker = _safe_text(row.get("speaker"), "화자 1")
        timestamp = _safe_text(row.get("timestamp"), _now_ts())
        if not body:
            continue

        if (
            utterances
            and utterances[-1]["speaker"] == speaker
            and len(utterances[-1]["text"]) + 1 + len(body) <= 120
            and not _ends_like_sentence(utterances[-1]["text"])
        ):
            utterances[-1]["text"] = f"{utterances[-1]['text']} {body}".strip()
        else:
            utterances.append({"speaker": speaker, "text": body, "timestamp": timestamp})

    return utterances, max(len(speaker_aliases), 1 if utterances else 0)


def _create_working_runtime_for_audio_import(meeting_goal: str, window_size: int, reset_state: bool) -> RuntimeStore:
    with RT.lock:
        llm_enabled = bool(RT.llm_enabled)
        if not reset_state:
            seeded = _snapshot_runtime_for_analysis(RT)
            seeded.meeting_goal = _safe_text(meeting_goal, seeded.meeting_goal)
            seeded.window_size = int(window_size)
            return seeded

    working = RuntimeStore()
    working.llm_enabled = llm_enabled
    working.meeting_goal = _safe_text(meeting_goal)
    working.window_size = int(window_size)
    return working


def _apply_import_runtime_to_live(rt: RuntimeStore, source: RuntimeStore) -> None:
    llm_enabled = bool(rt.llm_enabled)
    canvas_last_placement = copy.deepcopy(rt.canvas_last_placement)
    canvas_workspace_by_meeting = copy.deepcopy(rt.canvas_workspace_by_meeting)
    canvas_llm_inflight_by_meeting = copy.deepcopy(rt.canvas_llm_inflight_by_meeting)
    canvas_task_records_by_meeting = copy.deepcopy(rt.canvas_task_records_by_meeting)
    canvas_idea_jobs_by_meeting = copy.deepcopy(rt.canvas_idea_jobs_by_meeting)
    canvas_problem_jobs_by_meeting = copy.deepcopy(rt.canvas_problem_jobs_by_meeting)
    canvas_personal_notes_by_meeting_user = copy.deepcopy(rt.canvas_personal_notes_by_meeting_user)
    canvas_local_state_by_meeting_user = copy.deepcopy(rt.canvas_local_state_by_meeting_user)

    rt.reset()
    rt.llm_enabled = llm_enabled
    rt.meeting_goal = _safe_text(source.meeting_goal)
    rt.window_size = int(source.window_size)
    rt.transcript = [dict(row) for row in source.transcript]
    rt.transcript_version = int(source.transcript_version)
    rt.analysis_next_windowed_target = int(source.analysis_next_windowed_target)
    _apply_analysis_result(rt, source)
    rt.canvas_last_placement = canvas_last_placement
    rt.canvas_workspace_by_meeting = canvas_workspace_by_meeting
    rt.canvas_llm_inflight_by_meeting = canvas_llm_inflight_by_meeting
    rt.canvas_task_records_by_meeting = canvas_task_records_by_meeting
    rt.canvas_idea_jobs_by_meeting = canvas_idea_jobs_by_meeting
    rt.canvas_problem_jobs_by_meeting = canvas_problem_jobs_by_meeting
    rt.canvas_personal_notes_by_meeting_user = canvas_personal_notes_by_meeting_user
    rt.canvas_local_state_by_meeting_user = canvas_local_state_by_meeting_user


def _reset_runtime_preserving_canvas(rt: RuntimeStore) -> None:
    llm_enabled = bool(rt.llm_enabled)
    canvas_last_placement = copy.deepcopy(rt.canvas_last_placement)
    canvas_workspace_by_meeting = copy.deepcopy(rt.canvas_workspace_by_meeting)
    canvas_llm_inflight_by_meeting = copy.deepcopy(rt.canvas_llm_inflight_by_meeting)
    canvas_task_records_by_meeting = copy.deepcopy(rt.canvas_task_records_by_meeting)
    canvas_idea_jobs_by_meeting = copy.deepcopy(rt.canvas_idea_jobs_by_meeting)
    canvas_problem_jobs_by_meeting = copy.deepcopy(rt.canvas_problem_jobs_by_meeting)
    canvas_personal_notes_by_meeting_user = copy.deepcopy(rt.canvas_personal_notes_by_meeting_user)
    canvas_local_state_by_meeting_user = copy.deepcopy(rt.canvas_local_state_by_meeting_user)

    rt.reset()
    rt.llm_enabled = llm_enabled
    rt.canvas_last_placement = canvas_last_placement
    rt.canvas_workspace_by_meeting = canvas_workspace_by_meeting
    rt.canvas_llm_inflight_by_meeting = canvas_llm_inflight_by_meeting
    rt.canvas_task_records_by_meeting = canvas_task_records_by_meeting
    rt.canvas_idea_jobs_by_meeting = canvas_idea_jobs_by_meeting
    rt.canvas_problem_jobs_by_meeting = canvas_problem_jobs_by_meeting
    rt.canvas_personal_notes_by_meeting_user = canvas_personal_notes_by_meeting_user
    rt.canvas_local_state_by_meeting_user = canvas_local_state_by_meeting_user


def _persist_imported_transcripts_to_db(
    meeting_id: str,
    user_id: str,
    rows: list[dict[str, str]],
    reset_state: bool,
) -> None:
    client = _get_supabase_service_client()
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_user_id = _safe_text(user_id)
    if client is None or not normalized_meeting_id or not normalized_user_id:
        return

    normalized_rows = [
        {
            "meeting_id": normalized_meeting_id,
            "user_id": normalized_user_id,
            "speaker": _safe_text(row.get("speaker"), "화자 1"),
            "text": _safe_text(row.get("text")),
            "timestamp": _safe_text(row.get("timestamp"), _now_ts()),
            "turn_id": idx,
        }
        for idx, row in enumerate(rows, start=1)
        if _safe_text(row.get("text"))
    ]

    if not normalized_rows:
        return

    try:
        with _SUPABASE_REQUEST_LOCK:
            if reset_state:
                client.table("transcripts").delete().eq("meeting_id", normalized_meeting_id).execute()
            for start in range(0, len(normalized_rows), 200):
                batch = normalized_rows[start : start + 200]
                client.table("transcripts").insert(batch).execute()
    except Exception as exc:
        _log_runtime_db_error(
            f"transcripts:audio-import:{normalized_meeting_id}",
            f"❌ Failed to persist imported transcripts to Supabase: {exc}",
            cooldown_sec=10.0,
        )


def _run_audio_import_job(
    job_id: str,
    source_path: Path,
    filename: str,
    meeting_id: str,
    meeting_goal: str,
    user_id: str,
    reset_state: bool,
    window_size: int,
) -> None:
    normalized_path = source_path.with_suffix(".normalized.wav")
    try:
        _update_audio_import_job(job_id, status="processing", progress=4.0, step="normalizing", detail="오디오를 분석용 wav로 변환하는 중입니다.")
        _run_ffmpeg_to_mono_wav(source_path, normalized_path)
        duration_sec = _measure_wav_duration_seconds(normalized_path)

        diarization_rows: list[dict[str, Any]] = []
        used_diarization = False
        diarization_warning = ""
        try:
            _update_audio_import_job(job_id, progress=18.0, step="diarization", detail="화자 분리 구간을 계산하는 중입니다.")
            diarization_rows = _diarize_audio_file(normalized_path)
            used_diarization = len(diarization_rows) > 0
        except Exception as exc:
            diarization_warning = str(exc)
            _update_audio_import_job(job_id, progress=18.0, step="diarization", detail="화자 분리를 건너뛰고 단일 화자 기준으로 계속 진행합니다.", warning=diarization_warning)

        _update_audio_import_job(job_id, progress=42.0, step="transcribing", detail="Whisper로 전체 음성을 전사하는 중입니다.", used_diarization=used_diarization)
        whisper_result = _transcribe_file_with_whisper_segments(normalized_path)
        whisper_segments = whisper_result.get("segments") or []
        if not whisper_segments:
            raise RuntimeError("전사된 segment가 없습니다.")

        _update_audio_import_job(job_id, progress=62.0, step="segmenting", detail="화자와 문장 흐름 기준으로 발화를 정리하는 중입니다.")
        utterances, speaker_count = _build_import_utterances(whisper_segments, diarization_rows)
        if not utterances:
            raise RuntimeError("발화 단위로 정리된 결과가 없습니다.")

        working_rt = _create_working_runtime_for_audio_import(
            meeting_goal=meeting_goal or Path(filename).stem,
            window_size=window_size,
            reset_state=reset_state,
        )
        start_count = len(working_rt.transcript)
        total_new = len(utterances)
        _update_audio_import_job(
            job_id,
            progress=70.0,
            step="analyzing",
            detail="발화 4개 단위로 안건 분석을 진행하는 중입니다.",
            transcript_count=start_count + total_new,
            speaker_count=speaker_count,
        )

        appended = 0
        for row in utterances:
            _append_turn(working_rt, row.get("speaker", "화자 1"), row.get("text", ""), row.get("timestamp"))
            appended += 1
            total_count = len(working_rt.transcript)
            if total_count % SUMMARY_INTERVAL == 0:
                _run_analysis(working_rt, force=False, mode="windowed", skip_interval=True)
            progress = 70.0 + (22.0 * (appended / max(total_new, 1)))
            _update_audio_import_job(
                job_id,
                progress=progress,
                step="analyzing",
                detail=f"발화 {appended}/{total_new}개를 반영했습니다.",
                transcript_count=total_count,
                speaker_count=speaker_count,
            )

        if len(working_rt.transcript) > int(working_rt.last_analyzed_count):
            _run_analysis(working_rt, force=False, mode="windowed", skip_interval=True)

        _update_audio_import_job(job_id, progress=94.0, step="persisting", detail="회의 상태와 전사를 저장하는 중입니다.")
        with RT.lock:
            _apply_import_runtime_to_live(RT, working_rt)
            live_state = _state_response(RT)

        _persist_imported_transcripts_to_db(meeting_id, user_id, working_rt.transcript, reset_state=reset_state)

        _update_audio_import_job(
            job_id,
            status="completed",
            progress=100.0,
            step="completed",
            detail=f"{len(working_rt.transcript)}개 발화를 불러왔습니다.",
            transcript_count=len(working_rt.transcript),
            speaker_count=speaker_count,
            used_diarization=used_diarization,
            warning=diarization_warning,
            state=live_state,
        )
    except Exception as exc:
        _update_audio_import_job(
            job_id,
            status="error",
            progress=100.0,
            step="error",
            detail="오디오 파일 처리에 실패했습니다.",
            error=str(exc),
        )
    finally:
        for target in (source_path, normalized_path):
            try:
                if target.exists():
                    target.unlink()
            except OSError:
                pass


def _ensure_llm_ready(rt: RuntimeStore) -> tuple[Any, bool, str]:
    client = get_client()
    if bool(rt.llm_enabled) and bool(client.connected):
        return client, True, ""

    if not _safe_text(getattr(client, "api_key", "")):
        rt.llm_enabled = False
        return client, False, "LLM API 키가 없어 로컬 결과를 사용했습니다."

    try:
        result = client.connect()
        rt.llm_enabled = bool(result.get("ok"))
        if rt.llm_enabled and client.connected:
            return client, True, ""
        return client, False, _safe_text(result.get("message"), "LLM 연결 실패로 로컬 결과를 사용했습니다.")
    except Exception as exc:
        rt.llm_enabled = False
        return client, False, f"LLM 자동 연결 실패: {exc}"


def _fallback_stt_flow_summary(turns: list[SttFlowSummaryTurnInput], max_chars: int = 30) -> str:
    text = " ".join(_safe_text(turn.text) for turn in turns if _safe_text(turn.text))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^(음|어|네|예|일단|그러면|그럼|근데|그러니까)\s+", "", text)
    if not text:
        return "현재 발언 정리 중"
    return _safe_text(text[:max_chars], "현재 발언 정리 중").strip(" .,!?:;/|")


def _generate_stt_flow_summary(payload: SttFlowSummaryInput) -> dict[str, Any]:
    max_chars = int(payload.max_chars or 30)
    turns = [turn for turn in payload.turns if _safe_text(turn.text)]
    if not turns:
        return {
            "ok": True,
            "summary": "현재 발언 정리 중",
            "used_llm": False,
            "warning": "요약할 발화가 없습니다.",
        }

    lines = []
    for index, turn in enumerate(turns, start=1):
        speaker = _safe_text(turn.speaker, f"화자 {index}")
        text = _safe_text(turn.text)
        lines.append(f"{index}. {speaker}: {text}")

    prompt = f"""
너는 회의 실시간 발언 흐름 요약기다. 출력은 JSON 객체 하나만 반환한다.

[입력 발화]
{chr(10).join(lines)}

[목표]
- 위 발화들이 지금 어떤 발언 흐름인지 한국어로 요약한다.
- 참가자에게 현재 논의 방향을 빠르게 보여주는 짧은 문구여야 한다.

[규칙]
1) summary는 반드시 {max_chars}자 이내.
2) "요약", "논의 중", "발언 중" 같은 형식 문구로 채우지 않는다.
3) 발화 원문을 그대로 복사하지 않는다.
4) 시간 정보, 화자명, 따옴표, 마침표는 쓰지 않는다.
5) 핵심 명사와 행동/의도를 포함한다.

[출력 JSON]
{{
  "summary": "string"
}}
""".strip()

    client, llm_ready, warning = _ensure_llm_ready(RT)
    if llm_ready:
        try:
            parsed = _call_llm_json(
                rt=RT,
                client=client,
                prompt=prompt,
                stage="stt.flow_summary",
                temperature=0.15,
                max_tokens=120,
            )
            summary = _safe_text(parsed.get("summary"))
            summary = re.sub(r"\s+", " ", summary).strip().strip(" .,!?:;/|\"'")
            if summary:
                return {
                    "ok": True,
                    "summary": _safe_text(summary[:max_chars], "현재 발언 정리 중"),
                    "used_llm": True,
                    "warning": "",
                }
        except Exception as exc:
            warning = f"LLM 요약 실패: {exc}"

    return {
        "ok": True,
        "summary": _fallback_stt_flow_summary(turns, max_chars=max_chars),
        "used_llm": False,
        "warning": warning,
    }


def _normalize_canvas_node_positions(
    payload: dict[str, dict[str, Any]] | None,
) -> dict[str, dict[str, dict[str, float]]]:
    normalized: dict[str, dict[str, dict[str, float]]] = {}
    if not isinstance(payload, dict):
        return normalized

    for raw_stage, raw_nodes in payload.items():
        stage = _normalize_canvas_stage(_safe_text(raw_stage))
        if stage not in {"ideation", "problem-definition", "solution"}:
            continue
        if not isinstance(raw_nodes, dict):
            continue

        stage_nodes: dict[str, dict[str, float]] = {}
        for raw_node_id, raw_position in raw_nodes.items():
            node_id = _safe_text(raw_node_id)
            if not node_id or not isinstance(raw_position, dict):
                continue
            if stage == "ideation" and not node_id.startswith("agenda-"):
                continue

            try:
                x = float(raw_position.get("x", 0) or 0)
                y = float(raw_position.get("y", 0) or 0)
            except (TypeError, ValueError):
                continue

            stage_nodes[node_id] = {"x": x, "y": y}

        if stage_nodes:
            normalized[stage] = stage_nodes

    return normalized


def _summarize_canvas_node_positions_for_debug(
    payload: dict[str, dict[str, Any]] | None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {
            "ideation": 0,
            "problem_definition": 0,
            "solution": 0,
            "sample_ideation": [],
        }

    ideation = payload.get("ideation") if isinstance(payload.get("ideation"), dict) else {}
    problem_definition = (
        payload.get("problem-definition")
        if isinstance(payload.get("problem-definition"), dict)
        else {}
    )
    solution = payload.get("solution") if isinstance(payload.get("solution"), dict) else {}
    top_ideation_nodes = sorted(
        ideation.items(),
        key=lambda item: (
            float(item[1].get("y", 0) or 0) if isinstance(item[1], dict) else 0.0,
            float(item[1].get("x", 0) or 0) if isinstance(item[1], dict) else 0.0,
        ),
    )[:4]

    return {
        "ideation": len(ideation),
        "problem_definition": len(problem_definition),
        "solution": len(solution),
        "top_ideation_nodes": top_ideation_nodes,
    }


app = FastAPI(title="Meeting STT + Agenda MVP")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
_ensure_analysis_worker_started()


@app.middleware("http")
async def enforce_ip_whitelist(request, call_next):
    client_ip = extract_client_ip(request.headers, request.client.host if request.client else None)
    if not is_ip_allowed(client_ip, IP_WHITELIST):
        return JSONResponse(status_code=403, content={"detail": "IP not allowed"})
    return await call_next(request)


@app.get("/api/health")
def get_health():
    return {
        "ok": True,
        "whisper_model": WHISPER_MODEL_NAME,
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "deps": {
            "fastapi": importlib.util.find_spec("fastapi") is not None,
            "python_multipart": importlib.util.find_spec("multipart") is not None,
            "whisper": importlib.util.find_spec("whisper") is not None,
            "dotenv": importlib.util.find_spec("dotenv") is not None,
            "numpy": importlib.util.find_spec("numpy") is not None,
        },
    }


@app.get("/api/ai/tasks/policies")
def get_ai_task_policies():
    policies = sorted(CANVAS_TASK_POLICIES.values(), key=lambda item: (-item.priority, item.task_type))
    return {
        "ok": True,
        "policies": [_canvas_task_policy_response(policy) for policy in policies],
    }


def _task_query_filter_values(raw: str) -> set[str]:
    return {
        _safe_text(value)
        for value in _safe_text(raw).split(",")
        if _safe_text(value)
    }


@app.get("/api/ai/tasks")
def get_ai_tasks(
    meeting_id: str = "",
    status: str = "",
    task_type: str = "",
    queue_name: str = "",
    limit: int = 200,
):
    normalized_meeting_id = _safe_text(meeting_id)
    status_filters = _task_query_filter_values(status)
    task_type_filters = _task_query_filter_values(task_type)
    queue_name_filters = _task_query_filter_values(queue_name)
    result_limit = min(max(_safe_nonnegative_int(limit, 200), 1), 500)
    tasks: list[dict[str, Any]] = []
    seen_task_ids: set[str] = set()
    with RT.lock:
        task_records = copy.deepcopy(RT.canvas_task_records_by_meeting)
        idea_meetings = copy.deepcopy(RT.canvas_idea_jobs_by_meeting)
        problem_meetings = copy.deepcopy(RT.canvas_problem_jobs_by_meeting)

    for current_meeting_id, meeting_records in task_records.items():
        if normalized_meeting_id and _safe_text(current_meeting_id) != normalized_meeting_id:
            continue
        for record in (meeting_records or {}).values():
            if not isinstance(record, dict):
                continue
            response = _canvas_task_record_response(record)
            task_id = _safe_text(response.get("task_id"))
            if task_id:
                seen_task_ids.add(task_id)
            tasks.append(response)

    for current_meeting_id, meeting_jobs in idea_meetings.items():
        if normalized_meeting_id and _safe_text(current_meeting_id) != normalized_meeting_id:
            continue
        for job in (meeting_jobs or {}).values():
            if isinstance(job, dict):
                summary = _canvas_task_job_summary(job, "canvas_idea")
                if _safe_text(summary.get("task_id")) in seen_task_ids:
                    continue
                tasks.append(summary)

    for current_meeting_id, meeting_jobs in problem_meetings.items():
        if normalized_meeting_id and _safe_text(current_meeting_id) != normalized_meeting_id:
            continue
        for job in (meeting_jobs or {}).values():
            if isinstance(job, dict):
                summary = _canvas_task_job_summary(job, "canvas_problem")
                if _safe_text(summary.get("task_id")) in seen_task_ids:
                    continue
                tasks.append(summary)

    filtered_tasks = [
        task
        for task in tasks
        if (not status_filters or _safe_text(task.get("status"), "idle") in status_filters)
        and (not task_type_filters or _safe_text(task.get("task_type"), "generic") in task_type_filters)
        and (not queue_name_filters or _safe_text(task.get("queue_name"), "generic") in queue_name_filters)
    ]

    queue_counts: dict[str, dict[str, int]] = {}
    for task in filtered_tasks:
        queue_name = _safe_text(task.get("queue_name"), "generic")
        status = _safe_text(task.get("status"), "idle")
        queue_counts.setdefault(queue_name, {})
        queue_counts[queue_name][status] = queue_counts[queue_name].get(status, 0) + 1

    filtered_tasks.sort(key=lambda item: _safe_text(item.get("updated_at")), reverse=True)
    return {
        "ok": True,
        "meeting_id": normalized_meeting_id,
        "limit": result_limit,
        "total": len(filtered_tasks),
        "filters": {
            "status": sorted(status_filters),
            "task_type": sorted(task_type_filters),
            "queue_name": sorted(queue_name_filters),
        },
        "queues": queue_counts,
        "tasks": filtered_tasks[:result_limit],
        "policies": [_canvas_task_policy_response(policy) for policy in CANVAS_TASK_POLICIES.values()],
    }


@app.get("/api/ai/tasks/{task_id}")
def get_ai_task(task_id: str, meeting_id: str = ""):
    normalized_task_id = _safe_text(task_id)
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_task_id:
        raise HTTPException(status_code=400, detail="task_id is required")
    with RT.lock:
        task_records = copy.deepcopy(RT.canvas_task_records_by_meeting)
    for current_meeting_id, meeting_records in task_records.items():
        if normalized_meeting_id and _safe_text(current_meeting_id) != normalized_meeting_id:
            continue
        record = meeting_records.get(normalized_task_id) if isinstance(meeting_records, dict) else None
        if isinstance(record, dict):
            return {
                "ok": True,
                "task": _canvas_task_record_response(record),
            }
    return {
        "ok": False,
        "task_id": normalized_task_id,
        "meeting_id": normalized_meeting_id,
        "detail": "작업 정보를 찾을 수 없습니다.",
    }


@app.get("/api/state")
def get_state():
    with RT.lock:
        return _state_response(RT)


@app.get("/api/llm/status")
def get_llm_status():
    return get_client().status()


@app.post("/api/llm/connect")
def post_llm_connect():
    with RT.lock:
        client = get_client()
        result = client.connect()
        RT.llm_enabled = bool(result.get("ok"))
        queue_ok = False
        queue_err = ""
        queued_task_id = 0
        if RT.llm_enabled:
            queue_ok, queued_task_id, queue_err = _enqueue_analysis(RT, force=True, mode="full_document", source="llm_connect")
            if not queue_ok:
                RT.analysis_last_error = _safe_text(queue_err)
        return {
            "enabled": RT.llm_enabled,
            "result": result,
            "llm_status": client.status(),
            "queued_analysis": {"ok": queue_ok, "task_id": queued_task_id, "error": queue_err},
            "state": _state_response(RT),
        }


@app.post("/api/llm/disconnect")
def post_llm_disconnect():
    with RT.lock:
        client = get_client()
        result = client.disconnect()
        RT.llm_enabled = False
        return {
            "enabled": False,
            "result": result,
            "llm_status": client.status(),
            "state": _state_response(RT),
        }


@app.post("/api/llm/ping")
def post_llm_ping():
    client = get_client()
    result = client.ping()
    return {"result": result, "llm_status": client.status()}


@app.post("/api/config")
def post_config(payload: ConfigInput):
    with RT.lock:
        RT.meeting_goal = _safe_text(payload.meeting_goal)
        RT.window_size = int(payload.window_size)
        return _state_response(RT)


@app.post("/api/transcript/manual")
def post_transcript_manual(payload: UtteranceInput):
    with RT.lock:
        _append_turn(RT, payload.speaker, payload.text, payload.timestamp)
        _enqueue_windowed_with_backpressure(RT, source="manual_turn")
        return _state_response(RT)


@app.post("/api/transcript/sync")
def post_transcript_sync(payload: TranscriptSyncInput):
    with RT.lock:
        if payload.reset_state:
            _reset_runtime_preserving_canvas(RT)

        RT.meeting_goal = _safe_text(payload.meeting_goal)
        RT.window_size = int(payload.window_size)
        RT.transcript = []
        for row in payload.transcript:
            text = _safe_text(row.text)
            if not text:
                continue
            RT.transcript.append(
                {
                    "speaker": _safe_text(row.speaker, "화자"),
                    "text": text,
                    "timestamp": _safe_text(row.timestamp, _now_ts()),
                }
            )

        RT.transcript_version += 1
        RT.last_analyzed_count = 0 if payload.auto_analyze else len(RT.transcript)
        RT.last_analysis_warning = "meeting_transcript_sync"
        RT.analysis_next_windowed_target = SUMMARY_INTERVAL

        if payload.auto_analyze and RT.transcript:
            ok = _run_analysis(RT, force=True, mode="full_document")
            if not ok:
                RT.last_analysis_warning = "meeting_sync_analyze_failed"

    return _state_response(RT)


@app.post("/api/stt/flow-summary")
def post_stt_flow_summary(payload: SttFlowSummaryInput):
    return _generate_stt_flow_summary(payload)


@app.post("/api/transcript/import-json-dir")
def post_import_json_dir(payload: ImportDirInput):
    with RT.lock:
        folder = Path(payload.folder)
        target = folder if folder.is_absolute() else (ROOT / folder)
        files = []
        if target.exists() and target.is_dir():
            pattern = "**/*.json" if payload.recursive else "*.json"
            files = list(target.glob(pattern))[: payload.max_files]

        if payload.reset_state:
            RT.reset()

        files_scanned = 0
        files_parsed = 0
        files_skipped = 0
        rows_loaded = 0
        file_stats = []
        parse_errors: list[dict[str, str]] = []
        applied_goal = None

        for path in files:
            files_scanned += 1
            try:
                raw = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                try:
                    raw = path.read_text(encoding="utf-8-sig")
                except Exception as exc:
                    files_skipped += 1
                    parse_errors.append({"file": str(path), "error": f"decode failed: {exc}"})
                    continue
            except Exception:
                files_skipped += 1
                parse_errors.append({"file": str(path), "error": "read failed"})
                continue
            data = _extract_json(raw)
            if not data:
                files_skipped += 1
                parse_errors.append({"file": str(path), "error": "json parse failed"})
                continue
            ok_payload, payload_reason = _looks_like_meeting_payload(data)
            if not ok_payload:
                files_skipped += 1
                parse_errors.append({"file": str(path), "error": payload_reason})
                continue
            goal, rows = _parse_meeting_json_payload(data)
            if not rows:
                files_skipped += 1
                parse_errors.append({"file": str(path), "error": "utterance rows extracted = 0"})
                continue
            if goal and not applied_goal:
                applied_goal = goal
            added = _append_many_turns(RT, rows)
            rows_loaded += added
            files_parsed += 1
            file_stats.append({"file": str(path), "rows": added})

        if applied_goal:
            RT.meeting_goal = applied_goal

        ticked = False
        queue_err = ""
        queued_task_id = 0
        if payload.auto_tick and RT.transcript:
            ticked, queued_task_id, queue_err = _enqueue_analysis(RT, force=True, mode="full_document", source="import_json_dir")
            if not ticked:
                RT.analysis_last_error = _safe_text(queue_err)

        return {
            "state": _state_response(RT),
            "import_debug": {
                "folder": str(target),
                "files_scanned": files_scanned,
                "files_parsed": files_parsed,
                "files_skipped": files_skipped,
                "rows_loaded": rows_loaded,
                "meeting_goal": RT.meeting_goal or "",
                "added": rows_loaded,
                "reset_state": bool(payload.reset_state),
                "auto_tick": bool(payload.auto_tick),
                "ticked": bool(ticked),
                "queued_task_id": int(queued_task_id),
                "queue_error": _safe_text(queue_err),
                "analysis_mode": "none" if not RT.llm_enabled else "full_document_once",
                "meeting_goal_applied": bool(applied_goal),
                "warning": "" if files_parsed > 0 else ("파싱된 JSON 파일이 없습니다." + (f" 예: {parse_errors[0]['error']}" if parse_errors else "")),
                "file_stats": file_stats,
                "parse_errors": parse_errors[:20],
            },
        }


@app.post("/api/transcript/import-json-files")
async def post_import_json_files(
    files: list[UploadFile] = File(default=[]),
    reset_state: str = Form(default="true"),
    auto_tick: str = Form(default="true"),
):
    parsed = await _collect_rows_from_uploads(files)
    with RT.lock:
        do_reset = _boolify(reset_state, True)
        do_tick = _boolify(auto_tick, True)
        if do_reset:
            RT.reset()

        rows_loaded = _append_many_turns(RT, parsed["rows"])

        if parsed["applied_goal"]:
            RT.meeting_goal = parsed["applied_goal"]

        ticked = False
        queue_err = ""
        queued_task_id = 0
        if do_tick and RT.transcript:
            ticked, queued_task_id, queue_err = _enqueue_analysis(RT, force=True, mode="full_document", source="import_json_files")
            if not ticked:
                RT.analysis_last_error = _safe_text(queue_err)

        return {
            "state": _state_response(RT),
            "import_debug": {
                "folder": "<uploaded>",
                "files_scanned": int(parsed["files_scanned"]),
                "files_parsed": int(parsed["files_parsed"]),
                "files_skipped": int(parsed["files_skipped"]),
                "rows_loaded": rows_loaded,
                "meeting_goal": RT.meeting_goal or "",
                "added": rows_loaded,
                "reset_state": do_reset,
                "auto_tick": do_tick,
                "ticked": bool(ticked),
                "queued_task_id": int(queued_task_id),
                "queue_error": _safe_text(queue_err),
                "analysis_mode": "none" if not RT.llm_enabled else "full_document_once",
                "meeting_goal_applied": bool(parsed["applied_goal"]),
                "warning": ""
                if int(parsed["files_parsed"]) > 0
                else ("파싱된 JSON 파일이 없습니다." + (f" 예: {parsed['parse_errors'][0]['error']}" if parsed["parse_errors"] else "")),
                "file_stats": list(parsed["file_stats"]),
                "parse_errors": list(parsed["parse_errors"]),
            },
        }


@app.post("/api/transcript/replay/import-json-files")
async def post_replay_import_json_files(
    files: list[UploadFile] = File(default=[]),
    reset_state: str = Form(default="true"),
    apply_goal: str = Form(default="true"),
):
    parsed = await _collect_rows_from_uploads(files)
    with RT.lock:
        do_reset = _boolify(reset_state, True)
        do_apply_goal = _boolify(apply_goal, True)
        if do_reset:
            RT.reset()

        RT.replay_rows = list(parsed["rows"])
        RT.replay_index = 0
        RT.replay_source = "upload_json_files"
        RT.replay_loaded_at = _now_ts() if RT.replay_rows else ""

        if do_apply_goal and parsed["applied_goal"]:
            RT.meeting_goal = parsed["applied_goal"]

        return {
            "state": _state_response(RT),
            "replay_debug": {
                "queued_total": len(RT.replay_rows),
                "queued_cursor": int(RT.replay_index),
                "queued_remaining": max(0, len(RT.replay_rows) - int(RT.replay_index)),
                "done": False,
                "source": _safe_text(RT.replay_source),
                "loaded_at": _safe_text(RT.replay_loaded_at),
                "files_scanned": int(parsed["files_scanned"]),
                "files_parsed": int(parsed["files_parsed"]),
                "files_skipped": int(parsed["files_skipped"]),
                "meeting_goal_applied": bool(do_apply_goal and parsed["applied_goal"]),
                "warning": ""
                if int(parsed["files_parsed"]) > 0
                else ("파싱된 JSON 파일이 없습니다." + (f" 예: {parsed['parse_errors'][0]['error']}" if parsed["parse_errors"] else "")),
                "file_stats": list(parsed["file_stats"]),
                "parse_errors": list(parsed["parse_errors"]),
            },
        }


@app.post("/api/transcript/replay/step")
def post_replay_step(payload: ReplayStepInput):
    with RT.lock:
        total = len(RT.replay_rows)
        cursor = max(0, min(int(RT.replay_index), total))
        if total <= 0 or cursor >= total:
            RT.replay_index = total
            return {
                "state": _state_response(RT),
                "replay_debug": {
                    "added": 0,
                    "requested": int(payload.lines),
                    "analyzed": False,
                    "queued_total": total,
                    "queued_cursor": int(RT.replay_index),
                    "queued_remaining": 0,
                    "done": True,
                    "warning": "주입할 replay 큐가 없습니다.",
                },
            }

        take = max(1, min(int(payload.lines), 100))
        end = min(total, cursor + take)
        batch = RT.replay_rows[cursor:end]
        added = _append_many_turns(RT, batch)
        RT.replay_index = end

        analyzed = False
        queued_task_id = 0
        queue_error = ""
        deferred = False
        if payload.auto_analyze and added > 0:
            analyzed, queued_task_id, queue_error, deferred = _enqueue_windowed_with_backpressure(RT, source="replay_step")
            if (not analyzed) and (not deferred) and _safe_text(queue_error):
                RT.analysis_last_error = _safe_text(queue_error)

        remaining = max(0, total - int(RT.replay_index))
        done = remaining == 0
        return {
            "state": _state_response(RT),
            "replay_debug": {
                "added": added,
                "requested": take,
                "analyzed": bool(analyzed or deferred),
                "queued_task_id": int(queued_task_id),
                "queue_error": _safe_text(queue_error),
                "deferred": bool(deferred),
                "queued_total": total,
                "queued_cursor": int(RT.replay_index),
                "queued_remaining": remaining,
                "done": done,
                "warning": "",
            },
        }


@app.post("/api/analysis/tick")
def post_analysis_tick():
    with RT.lock:
        ok, _, err = _enqueue_analysis(RT, force=True, mode="full_document", source="manual_tick")
        if not ok:
            RT.analysis_last_error = _safe_text(err)
            RT.last_analysis_warning = f"분석 요청 큐 적재 실패: {err}"
        return _state_response(RT)


@app.post("/api/canvas/placement-confirm")
def post_canvas_placement_confirm(payload: CanvasPlacementConfirmInput):
    with RT.lock:
        saved_at = _now_ts()
        RT.canvas_last_placement = {
            "tool": _safe_text(payload.tool, "note"),
            "ui_x": float(payload.ui_x or 0.0),
            "ui_y": float(payload.ui_y or 0.0),
            "flow_x": float(payload.flow_x or 0.0),
            "flow_y": float(payload.flow_y or 0.0),
            "agenda_id": _safe_text(payload.agenda_id),
            "point_id": _safe_text(payload.point_id),
            "title": _safe_text(payload.title),
            "body": _safe_text(payload.body),
            "saved_at": saved_at,
        }
        return {
            "ok": True,
            "saved_at": saved_at,
            "draft": copy.deepcopy(RT.canvas_last_placement),
            "state": _state_response(RT),
        }


@app.get("/api/analysis/last-llm-json")
def get_last_llm_json():
    with RT.lock:
        return {
            "ok": True,
            "received_at": _safe_text(RT.last_llm_parsed_at),
            "has_json": bool(RT.last_llm_parsed_json),
            "json": RT.last_llm_parsed_json if isinstance(RT.last_llm_parsed_json, dict) else {},
        }


@app.post("/api/canvas/idea-assimilation")
@app.post("/api/canvas/ideation/ideas/assimilate-preview")
def post_canvas_idea_assimilation(payload: CanvasIdeaAssimilationInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        return _compute_idea_assimilation_result(payload)

    return _run_canvas_task_cached_request(
        RT,
        "ideation.assimilate_preview",
        normalized_meeting_id,
        "idea_assimilation",
        signature,
        _compute,
    )


def _canvas_idea_processed_ids(workspace: dict[str, Any]) -> set[str]:
    processed = {
        _safe_text(item)
        for item in (workspace.get("idea_processed_utterance_ids") or [])
        if _safe_text(item)
    }
    for item in workspace.get("canvas_items") or []:
        if not isinstance(item, dict):
            continue
        for key in ("evidence_utterance_ids", "ignored_utterance_ids"):
            for utterance_id in item.get(key) or []:
                if _safe_text(utterance_id):
                    processed.add(_safe_text(utterance_id))
    return processed


def _canvas_problem_processed_ids(workspace: dict[str, Any]) -> set[str]:
    processed = {
        _safe_text(item)
        for item in (workspace.get("problem_processed_utterance_ids") or [])
        if _safe_text(item)
    }
    for group in workspace.get("problem_groups") or []:
        if not isinstance(group, dict):
            continue
        for item in group.get("discussion_items") or []:
            if not isinstance(item, dict):
                continue
            for key in ("evidence_utterance_ids", "ignored_utterance_ids"):
                for utterance_id in item.get(key) or []:
                    if _safe_text(utterance_id):
                        processed.add(_safe_text(utterance_id))
    return processed


def _normalize_problem_discussion_llm_result(raw: Any, fallback_ids: list[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    raw_title = raw.get("title")
    raw_body = raw.get("summary") or raw.get("body") or raw.get("content")
    source_text = f"{raw_title or ''} {raw_body or ''}"
    keywords = _normalize_idea_keywords(raw.get("keywords") or [], source_text, 6)
    title = _clean_idea_title(raw_title, keywords, "문제 의견")
    body = _clean_idea_summary(raw_body, title, keywords)
    refined = _normalize_refined_utterances(
        raw.get("refinedUtterances") or raw.get("refined_utterances") or [],
        limit=8,
    )
    evidence_ids = _dedup_preserve(
        [
            _safe_text(value)
            for value in (raw.get("evidenceUtteranceIds") or raw.get("evidence_utterance_ids") or fallback_ids)
            if _safe_text(value)
        ],
        limit=400,
    )
    ignored_ids = _dedup_preserve(
        [
            _safe_text(value)
            for value in (raw.get("ignoredUtteranceIds") or raw.get("ignored_utterance_ids") or [])
            if _safe_text(value)
        ],
        limit=400,
    )
    return {
        "title": title,
        "body": body,
        "keywords": keywords,
        "key_evidence": [_safe_text(value) for value in (raw.get("keyEvidence") or raw.get("key_evidence") or []) if _safe_text(value)][:8],
        "refined_utterances": refined,
        "evidence_utterance_ids": evidence_ids or fallback_ids,
        "ignored_utterance_ids": ignored_ids,
    }


def _build_problem_discussion_prompt(
    payload: CanvasProblemDiscussionWorkspaceStartInput,
    group: dict[str, Any],
) -> str:
    target_rows = [_idea_assimilation_utterance_dict(item) for item in payload.target_utterances]
    context_rows = [_idea_assimilation_utterance_dict(item) for item in (payload.context_utterances or [])[-6:]]
    prompt_payload = {
        "meeting_topic": _safe_text(payload.meeting_topic),
        "problem_group": {
            "group_id": _safe_text(group.get("group_id")),
            "topic": _safe_text(group.get("topic")),
            "insight_lens": _safe_text(group.get("insight_lens")),
            "conclusion": _safe_text(group.get("conclusion")),
            "keywords": [_safe_text(value) for value in (group.get("keywords") or []) if _safe_text(value)][:8],
        },
        "context_utterances": context_rows,
        "target_transcript_text": "\n".join(
            f"{row.get('speaker')}: {row.get('text')}" for row in target_rows if _safe_text(row.get("text"))
        ),
        "target_utterances": target_rows,
    }
    return (
        "너는 문제정의 단계에서 특정 문제정의 노드 아래에 붙일 의견/근거 노드를 생성한다. JSON 하나만 반환한다.\n"
        "규칙:\n"
        "- target_transcript_text에서 나온 의미만 사용한다. 배경 정보는 보조로만 사용한다.\n"
        "- title은 10~24자 정도의 짧은 명사구로 쓴다.\n"
        "- summary는 노드 본문에 들어갈 content이며, 문장형 설명보다 핵심 대상 + 문제/근거/조건의 압축 구문을 우선한다.\n"
        "- summary는 최대 2줄, 각 줄은 12~42자 정도로 쓴다.\n"
        "- keywords는 3~6개, 중심 의미 명사구만 넣는다.\n"
        "- refinedUtterances는 summary에 직접 영향을 준 주요 발화만 14~38자 한 줄 요약으로 넣는다.\n"
        "- 잡담, 맞장구, 회의 진행 멘트는 제외한다.\n"
        "- JSON만 반환한다.\n\n"
        "반환 형식:\n"
        "{\"title\":\"...\",\"summary\":\"...\",\"keywords\":[\"...\"],\"keyEvidence\":[\"...\"],"
        "\"refinedUtterances\":[{\"utterance_id\":\"...\",\"speaker\":\"...\",\"text\":\"...\",\"timestamp\":\"...\"}],"
        "\"evidenceUtteranceIds\":[\"...\"],\"ignoredUtteranceIds\":[\"...\"]}\n\n"
        f"input={json.dumps(prompt_payload, ensure_ascii=False)}"
    )


def _compute_problem_discussion_result(
    payload: CanvasProblemDiscussionWorkspaceStartInput,
    group: dict[str, Any],
) -> dict[str, Any]:
    fallback_ids = [_safe_text(item.id) for item in (payload.target_utterances or []) if _safe_text(item.id)]
    client, llm_ready, warning = _ensure_llm_ready(RT)
    if not llm_ready:
        return {
            "ok": False,
            "used_llm": False,
            "warning": warning or "LLM 미연결",
            "update": None,
        }
    try:
        parsed = _call_llm_json(
            RT,
            client,
            prompt=_build_problem_discussion_prompt(payload, group),
            stage="canvas_problem_discussion",
            temperature=0.18,
            max_tokens=1000,
        )
        raw = parsed.get("update") if isinstance(parsed, dict) and isinstance(parsed.get("update"), dict) else parsed
        update = _normalize_problem_discussion_llm_result(raw, fallback_ids)
        if not update:
            return {
                "ok": False,
                "used_llm": True,
                "warning": "LLM JSON 형식이 예상과 달라 의견 노드를 생성하지 않았습니다.",
                "update": None,
            }
        return {
            "ok": True,
            "used_llm": True,
            "warning": _safe_text(parsed.get("warning")) if isinstance(parsed, dict) else "",
            "update": update,
        }
    except Exception as exc:
        _append_llm_io_log(RT, direction="error", stage="canvas_problem_discussion", payload=str(exc), meta={})
        return {
            "ok": False,
            "used_llm": False,
            "warning": f"문제정의 의견 LLM 생성 실패: {exc}",
            "update": None,
        }


def _canvas_idea_existing_ideas_from_workspace(
    workspace: dict[str, Any],
    pending_item_id: str = "",
    selected_agenda_id: str = "",
) -> list[CanvasIdeaAssimilationIdeaInput]:
    ideas: list[CanvasIdeaAssimilationIdeaInput] = []
    agenda_filter = _safe_text(selected_agenda_id)
    for item in workspace.get("canvas_items") or []:
        if not isinstance(item, dict):
            continue
        if _safe_text(item.get("id")) == pending_item_id:
            continue
        if _safe_text(item.get("kind"), "note") == "topic":
            continue
        if _safe_text(item.get("kind"), "note") == "comment":
            continue
        if bool(item.get("ai_pending")):
            continue
        if agenda_filter and _safe_text(item.get("agenda_id")) != agenda_filter:
            continue
        ideas.append(
            CanvasIdeaAssimilationIdeaInput(
                id=_safe_text(item.get("id")),
                title=_safe_text(item.get("title")),
                summary=_safe_text(item.get("body") or item.get("title")),
                keywords=[_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)],
                key_evidence=[_safe_text(value) for value in (item.get("key_evidence") or []) if _safe_text(value)],
                refined_utterances=[
                    CanvasRefinedUtteranceInput(
                        utterance_id=_safe_text(value.get("utterance_id") or value.get("utteranceId") or value.get("id")),
                        speaker=_safe_text(value.get("speaker"), "참가자"),
                        text=_safe_text(value.get("text")),
                        timestamp=_safe_text(value.get("timestamp")),
                    )
                    for value in (item.get("refined_utterances") or [])
                    if isinstance(value, dict) and _safe_text(value.get("text"))
                ],
                evidence_utterance_ids=[
                    _safe_text(value) for value in (item.get("evidence_utterance_ids") or []) if _safe_text(value)
                ],
                auto_summary_disabled=bool(item.get("auto_summary_disabled")),
                user_edited=bool(item.get("user_edited")),
            )
        )
    return ideas


def _save_canvas_workspace_runtime(meeting_id: str, workspace: dict[str, Any]) -> None:
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_meeting_id:
        return
    workspace["meeting_id"] = normalized_meeting_id
    workspace["saved_at"] = _now_ts()
    with RT.lock:
        previous_workspace = copy.deepcopy(RT.canvas_workspace_by_meeting.get(normalized_meeting_id) or {})
        prepared_workspace = _append_canvas_operation_log_from_change(
            previous_workspace,
            workspace,
            source="runtime_save",
        )
        workspace.clear()
        workspace.update(copy.deepcopy(prepared_workspace))
        RT.canvas_workspace_by_meeting[normalized_meeting_id] = copy.deepcopy(prepared_workspace)
    _save_canvas_workspace_to_db(normalized_meeting_id, workspace)


def _mark_canvas_idea_job(
    meeting_id: str,
    job_id: str,
    **fields: Any,
) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        current = meeting_jobs.get(job_id) if isinstance(meeting_jobs.get(job_id), dict) else {}
        task_type = _safe_text(
            fields.get("task_type")
            or current.get("task_type")
            or _canvas_task_type_for_idea_job(_safe_text(fields.get("job_type") or current.get("job_type"))),
        )
        task_id = _safe_text(fields.get("task_id") or current.get("task_id") or job_id)
        current = {
            **current,
            **_canvas_task_job_fields(task_type),
            **fields,
            "task_id": task_id,
            "job_id": job_id,
            "meeting_id": normalized_meeting_id,
            "updated_at": _now_ts(),
        }
        meeting_jobs[job_id] = current
        _upsert_canvas_task_record_locked(
            RT,
            normalized_meeting_id,
            task_id,
            **_canvas_task_job_fields(task_type),
            source="canvas_idea_job",
            job_id=job_id,
            job_type=_canvas_job_type(current),
            scope_key=_safe_text(current.get("scope_key")),
            status=_safe_text(current.get("status"), "idle"),
            stale_reason=_safe_text(current.get("stale_reason")),
            retryable=bool(current.get("retryable")),
            detail=_safe_text(current.get("detail")),
            warning=_safe_text(current.get("warning")),
            pending_item_id=_safe_text(current.get("pending_item_id")),
            resolved_node_id=_safe_text(current.get("resolved_node_id")),
            target_count=int(current.get("target_count") or 0),
            target_signature=_canvas_task_signature_preview(current.get("target_signature")),
            retry_count=_safe_nonnegative_int(current.get("retry_count")),
            retry_after_epoch=_safe_operation_epoch(current.get("retry_after_epoch")),
            retry_job_id=_safe_text(current.get("retry_job_id")),
            retry_source_job_id=_safe_text(current.get("retry_source_job_id")),
            created_at=_safe_text(current.get("created_at")),
            created_epoch=float(current.get("created_epoch") or time.time()),
        )
        return copy.deepcopy(current)


def _canvas_job_type(job: dict[str, Any]) -> str:
    return _safe_text(job.get("job_type"), "idea_assimilation")


def _canvas_job_created_epoch(job: dict[str, Any]) -> float:
    try:
        return float(job.get("created_epoch") or 0)
    except (TypeError, ValueError):
        return 0.0


def _canvas_job_retry_count(job: dict[str, Any]) -> int:
    return _safe_nonnegative_int(job.get("retry_count"))


def _canvas_topic_summary_retry_delay_seconds(retry_count: int) -> int:
    if retry_count < 0 or retry_count >= len(CANVAS_TOPIC_SUMMARY_RETRY_DELAYS_SECONDS):
        return 0
    return int(CANVAS_TOPIC_SUMMARY_RETRY_DELAYS_SECONDS[retry_count])


def _has_newer_canvas_idea_scope_job(
    meeting_id: str,
    job_id: str,
    job_type: str,
    scope_key: str,
) -> bool:
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_job_id = _safe_text(job_id)
    normalized_job_type = _safe_text(job_type)
    normalized_scope_key = _safe_text(scope_key)
    if not normalized_meeting_id or not normalized_job_id or not normalized_job_type or not normalized_scope_key:
        return False

    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.get(normalized_meeting_id) or {}
        current_job = meeting_jobs.get(normalized_job_id) if isinstance(meeting_jobs.get(normalized_job_id), dict) else {}
        current_epoch = _canvas_job_created_epoch(current_job)
        for candidate_id, candidate in meeting_jobs.items():
            if candidate_id == normalized_job_id or not isinstance(candidate, dict):
                continue
            if _canvas_job_type(candidate) != normalized_job_type:
                continue
            if _safe_text(candidate.get("scope_key")) != normalized_scope_key:
                continue
            if _safe_text(candidate.get("status")) not in {"queued", "processing", "completed"}:
                continue
            if _canvas_job_created_epoch(candidate) > current_epoch:
                return True
    return False


def _supersede_processing_canvas_idea_scope_jobs(
    meeting_id: str,
    job_type: str,
    scope_key: str,
    next_target_signature: str,
    workspace: dict[str, Any],
    exclude_job_id: str = "",
) -> int:
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_job_type = _safe_text(job_type)
    normalized_scope_key = _safe_text(scope_key)
    normalized_signature = _safe_text(next_target_signature)
    normalized_exclude_job_id = _safe_text(exclude_job_id)
    if not normalized_meeting_id or not normalized_job_type or not normalized_scope_key:
        return 0

    superseded = 0
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        for job_id, job in list(meeting_jobs.items()):
            if not isinstance(job, dict):
                continue
            if normalized_exclude_job_id and _safe_text(job_id) == normalized_exclude_job_id:
                continue
            if _safe_text(job.get("status")) not in {"queued", "processing"}:
                continue
            if _canvas_job_type(job) != normalized_job_type:
                continue
            if _safe_text(job.get("scope_key")) != normalized_scope_key:
                continue
            if normalized_signature and _safe_text(job.get("target_signature")) == normalized_signature:
                continue
            updated_job = {
                **job,
                "status": "stale_superseded",
                "stale_reason": "superseded",
                "retryable": False,
                "detail": "더 최신 AI 정리 요청으로 대체되었습니다.",
                "warning": "",
                "workspace": copy.deepcopy(workspace),
                "updated_at": _now_ts(),
            }
            meeting_jobs[job_id] = updated_job
            task_type = _safe_text(updated_job.get("task_type")) or _canvas_task_type_for_idea_job(_canvas_job_type(updated_job))
            _upsert_canvas_task_record_locked(
                RT,
                normalized_meeting_id,
                _safe_text(updated_job.get("task_id") or job_id),
                **_canvas_task_job_fields(task_type),
                source="canvas_idea_job",
                job_id=_safe_text(job_id),
                job_type=_canvas_job_type(updated_job),
                scope_key=_safe_text(updated_job.get("scope_key")),
                status="stale_superseded",
                stale_reason="superseded",
                retryable=False,
                detail=_safe_text(updated_job.get("detail")),
                pending_item_id=_safe_text(updated_job.get("pending_item_id")),
                target_count=int(updated_job.get("target_count") or 0),
                target_signature=_canvas_task_signature_preview(updated_job.get("target_signature")),
                created_at=_safe_text(updated_job.get("created_at")),
                created_epoch=float(updated_job.get("created_epoch") or time.time()),
            )
            superseded += 1
    return superseded


def _finish_stale_canvas_topic_summary_job(
    meeting_id: str,
    job_id: str,
    topic_item_id: str,
    detail: str,
    status: str = "stale_obsolete",
    stale_reason: str = "obsolete",
    retryable: bool = False,
    resolved_node_id: str = "",
) -> None:
    latest_workspace = _clone_runtime_workspace_state(
        meeting_id,
        _warm_canvas_workspace_cache(RT, meeting_id),
        _now_ts(),
    )
    topic_id = _safe_text(topic_item_id)
    if not _has_newer_canvas_idea_scope_job(meeting_id, job_id, "topic_summary", topic_id):
        latest_workspace["canvas_items"] = [
            {**item, "ai_pending": False}
            if isinstance(item, dict) and _safe_text(item.get("id")) == topic_id and _is_canvas_topic_item(item)
            else item
            for item in (latest_workspace.get("canvas_items") or [])
        ]
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)

    updated_job = _mark_canvas_idea_job(
        meeting_id,
        job_id,
        status=status,
        stale_reason=stale_reason,
        retryable=retryable,
        detail=detail,
        workspace=copy.deepcopy(latest_workspace),
        used_llm=False,
        warning="",
        pending_item_id=topic_id,
        resolved_node_id=_safe_text(resolved_node_id),
    )
    if retryable and status in {"stale_rebasable", "error_retryable"}:
        _schedule_canvas_topic_summary_retry(updated_job)


def _canvas_idea_job_response(job: dict[str, Any], workspace: dict[str, Any] | None = None) -> dict[str, Any]:
    response = {
        "ok": True,
        "task_id": _safe_text(job.get("task_id") or job.get("job_id")),
        "job_id": _safe_text(job.get("job_id")),
        "meeting_id": _safe_text(job.get("meeting_id")),
        "status": _safe_text(job.get("status"), "idle"),
        "job_type": _canvas_job_type(job),
        "task_type": _safe_text(job.get("task_type")),
        "queue_name": _safe_text(job.get("queue_name")),
        "worker_name": _safe_text(job.get("worker_name")),
        "model_policy": _safe_text(job.get("model_policy")),
        "cache_policy": _safe_text(job.get("cache_policy")),
        "stale_policy": _safe_text(job.get("stale_policy")),
        "output_policy": _safe_text(job.get("output_policy")),
        "priority": int(job.get("priority") or 0),
        "scope_key": _safe_text(job.get("scope_key")),
        "stale_reason": _safe_text(job.get("stale_reason")),
        "retryable": bool(job.get("retryable")),
        "activity_type": _safe_text(job.get("activity_type")) or _canvas_task_activity_type(_safe_text(job.get("task_type"))),
        "activity_line": _safe_text(job.get("activity_line")) or _canvas_task_activity_line(
            _safe_text(job.get("task_type")),
            _safe_text(job.get("status"), "idle"),
            _safe_text(job.get("detail")),
            int(job.get("target_count") or 0),
            _safe_text(job.get("stale_reason")),
        ),
        "activity_events": _normalize_canvas_task_activity_events(job.get("activity_events")),
        "detail": _safe_text(job.get("detail")),
        "used_llm": bool(job.get("used_llm")),
        "warning": _safe_text(job.get("warning")),
        "pending_item_id": _safe_text(job.get("pending_item_id")),
        "resolved_node_id": _safe_text(job.get("resolved_node_id")),
        "retry_count": _canvas_job_retry_count(job),
        "retry_after_epoch": _safe_operation_epoch(job.get("retry_after_epoch")),
        "retry_job_id": _safe_text(job.get("retry_job_id")),
        "retry_source_job_id": _safe_text(job.get("retry_source_job_id")),
        "target_count": int(job.get("target_count") or 0),
        "created_at": _safe_text(job.get("created_at")),
        "updated_at": _safe_text(job.get("updated_at")),
    }
    if isinstance(workspace, dict):
        response["workspace"] = _canvas_workspace_response(workspace)
    elif isinstance(job.get("workspace"), dict):
        response["workspace"] = _canvas_workspace_response(job["workspace"])
    target_signature = _safe_text(job.get("target_signature"))
    if target_signature:
        response["target_signature"] = target_signature
    if isinstance(job.get("patch"), dict):
        response["patch"] = copy.deepcopy(job.get("patch"))
    return response


def _mark_canvas_problem_job(
    meeting_id: str,
    job_id: str,
    **fields: Any,
) -> dict[str, Any]:
    normalized_meeting_id = _safe_text(meeting_id)
    with RT.lock:
        meeting_jobs = RT.canvas_problem_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        current = meeting_jobs.get(job_id) if isinstance(meeting_jobs.get(job_id), dict) else {}
        task_type = _safe_text(fields.get("task_type") or current.get("task_type") or "problem.discussion")
        current = {
            **current,
            **_canvas_task_job_fields(task_type),
            **fields,
            "task_id": _safe_text(fields.get("task_id") or current.get("task_id") or job_id),
            "job_id": job_id,
            "meeting_id": normalized_meeting_id,
            "updated_at": _now_ts(),
        }
        meeting_jobs[job_id] = current
        _upsert_canvas_task_record_locked(
            RT,
            normalized_meeting_id,
            _safe_text(current.get("task_id") or job_id),
            **_canvas_task_job_fields(task_type),
            source="canvas_problem_job",
            job_id=job_id,
            job_type=_safe_text(current.get("job_type"), "problem_discussion"),
            scope_key=_safe_text(current.get("scope_key") or current.get("pending_item_id")),
            status=_safe_text(current.get("status"), "idle"),
            detail=_safe_text(current.get("detail")),
            warning=_safe_text(current.get("warning")),
            pending_item_id=_safe_text(current.get("pending_item_id")),
            target_count=int(current.get("target_count") or 0),
            target_signature=_canvas_task_signature_preview(current.get("target_signature")),
            created_at=_safe_text(current.get("created_at")),
            created_epoch=float(current.get("created_epoch") or time.time()),
        )
        return copy.deepcopy(current)


def _canvas_problem_job_response(job: dict[str, Any], workspace: dict[str, Any] | None = None) -> dict[str, Any]:
    response = {
        "ok": True,
        "task_id": _safe_text(job.get("task_id") or job.get("job_id")),
        "job_id": _safe_text(job.get("job_id")),
        "meeting_id": _safe_text(job.get("meeting_id")),
        "status": _safe_text(job.get("status"), "idle"),
        "task_type": _safe_text(job.get("task_type")),
        "queue_name": _safe_text(job.get("queue_name")),
        "worker_name": _safe_text(job.get("worker_name")),
        "model_policy": _safe_text(job.get("model_policy")),
        "cache_policy": _safe_text(job.get("cache_policy")),
        "stale_policy": _safe_text(job.get("stale_policy")),
        "output_policy": _safe_text(job.get("output_policy")),
        "priority": int(job.get("priority") or 0),
        "activity_type": _safe_text(job.get("activity_type")) or _canvas_task_activity_type(_safe_text(job.get("task_type"))),
        "activity_line": _safe_text(job.get("activity_line")) or _canvas_task_activity_line(
            _safe_text(job.get("task_type")),
            _safe_text(job.get("status"), "idle"),
            _safe_text(job.get("detail")),
            int(job.get("target_count") or 0),
            _safe_text(job.get("stale_reason")),
        ),
        "activity_events": _normalize_canvas_task_activity_events(job.get("activity_events")),
        "detail": _safe_text(job.get("detail")),
        "used_llm": bool(job.get("used_llm")),
        "warning": _safe_text(job.get("warning")),
        "pending_item_id": _safe_text(job.get("pending_item_id")),
        "target_count": int(job.get("target_count") or 0),
        "created_at": _safe_text(job.get("created_at")),
        "updated_at": _safe_text(job.get("updated_at")),
    }
    if isinstance(workspace, dict):
        response["workspace"] = _canvas_workspace_response(workspace)
    elif isinstance(job.get("workspace"), dict):
        response["workspace"] = _canvas_workspace_response(job["workspace"])
    target_signature = _safe_text(job.get("target_signature"))
    if target_signature:
        response["target_signature"] = target_signature
    return response


def _apply_idea_update_to_canvas_item(item: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    auto_summary_disabled = bool(item.get("auto_summary_disabled"))
    next_evidence_ids = _dedup_preserve(
        [_safe_text(value) for value in (item.get("evidence_utterance_ids") or [])]
        + [_safe_text(value) for value in (update.get("evidenceUtteranceIds") or [])],
        limit=400,
    )
    next_ignored_ids = _dedup_preserve(
        [_safe_text(value) for value in (item.get("ignored_utterance_ids") or [])]
        + [_safe_text(value) for value in (update.get("ignoredUtteranceIds") or [])],
        limit=400,
    )
    existing_keywords = _normalize_idea_keywords(
        item.get("keywords") or [],
        f"{item.get('title') or ''} {item.get('body') or ''}",
        8,
    )
    preserved_keywords = [_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)][:8]
    update_keywords = _normalize_idea_keywords(
        update.get("keywords") or [],
        f"{update.get('title') or ''} {update.get('summary') or ''}",
        8,
    )
    next_keywords = preserved_keywords if auto_summary_disabled else (update_keywords or existing_keywords)
    next_key_evidence = _dedup_preserve(
        [_safe_text(value) for value in (item.get("key_evidence") or [])]
        + [_safe_text(value) for value in (update.get("keyEvidence") or [])],
        limit=8,
    )
    next_refined = _normalize_refined_utterances(
        list(item.get("refined_utterances") or []) + list(update.get("refinedUtterances") or []),
        limit=120,
    )
    next_item = {
        **item,
        "title": _safe_text(item.get("title")) if auto_summary_disabled else (_safe_text(update.get("title")) or _safe_text(item.get("title"))),
        "body": _safe_text(item.get("body")) if auto_summary_disabled else (_safe_text(update.get("summary")) or _safe_text(item.get("body"))),
        "keywords": next_keywords,
        "key_evidence": next_key_evidence,
        "refined_utterances": next_refined,
        "evidence_utterance_ids": next_evidence_ids,
        "ignored_utterance_ids": next_ignored_ids,
        "ai_generated": bool(item.get("ai_generated")) or bool(update),
        "ai_pending": False,
        "manual_position": False,
    }
    next_item.pop("x", None)
    next_item.pop("y", None)
    return next_item


def _idea_update_merge_allowed(item: dict[str, Any], update: dict[str, Any]) -> bool:
    target_text = " ".join(
        [
            _safe_text(item.get("title")),
            _safe_text(item.get("body")),
            " ".join(_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)),
        ]
    )
    update_text = " ".join(
        [
            _safe_text(update.get("title")),
            _safe_text(update.get("summary")),
            " ".join(_safe_text(value) for value in (update.get("keywords") or []) if _safe_text(value)),
        ]
    )
    target_keywords = set(_normalize_idea_keywords(item.get("keywords") or [], target_text, 8))
    update_keywords = set(_normalize_idea_keywords(update.get("keywords") or [], update_text, 8))
    if target_keywords and update_keywords:
        overlap = len(target_keywords & update_keywords) / max(1, min(len(target_keywords), len(update_keywords)))
        if overlap >= 0.45:
            return True

    if _text_similarity(target_text, update_text) >= 0.28:
        return True
    return False


def _canvas_idea_item_text(item: dict[str, Any]) -> str:
    child_text = " ".join(
        _canvas_idea_item_text(child)
        for child in (item.get("merged_children") or [])[:12]
        if isinstance(child, dict)
    )
    refined_text = " ".join(
        _safe_text(row.get("text"))
        for row in (item.get("refined_utterances") or [])[:12]
        if isinstance(row, dict)
    )
    return " ".join(
        [
            _safe_text(item.get("title")),
            _safe_text(item.get("body")),
            " ".join(_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)),
            " ".join(_safe_text(value) for value in (item.get("key_evidence") or []) if _safe_text(value)),
            refined_text,
            child_text,
        ]
    )


def _canvas_idea_leaf_ids(item: dict[str, Any]) -> list[str]:
    explicit = [_safe_text(value) for value in (item.get("compacted_from_ids") or []) if _safe_text(value)]
    if explicit:
        return explicit
    child_ids: list[str] = []
    for child in item.get("merged_children") or []:
        if isinstance(child, dict):
            child_ids.extend(_canvas_idea_leaf_ids(child))
    return _dedup_preserve(child_ids or [_safe_text(item.get("id"))], limit=400)


def _canvas_idea_source_count(item: dict[str, Any]) -> int:
    return max(1, len(_canvas_idea_leaf_ids(item)))


def _canvas_idea_child_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _safe_text(item.get("id")),
        "agenda_id": _safe_text(item.get("agenda_id")),
        "point_id": _safe_text(item.get("point_id")),
        "kind": _safe_text(item.get("kind"), "note"),
        "title": _safe_text(item.get("title")),
        "body": _safe_text(item.get("body")),
        "keywords": [_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)][:8],
        "key_evidence": [_safe_text(value) for value in (item.get("key_evidence") or []) if _safe_text(value)][:8],
        "refined_utterances": _normalize_refined_utterances(item.get("refined_utterances") or [], limit=80),
        "evidence_utterance_ids": [
            _safe_text(value) for value in (item.get("evidence_utterance_ids") or []) if _safe_text(value)
        ][:400],
        "ignored_utterance_ids": [
            _safe_text(value) for value in (item.get("ignored_utterance_ids") or []) if _safe_text(value)
        ][:400],
        "merged_children": _normalize_canvas_merged_children(item.get("merged_children") or []),
        "compacted_from_ids": _canvas_idea_leaf_ids(item),
        "compaction_level": _safe_nonnegative_int(item.get("compaction_level")),
        "auto_summary_disabled": bool(item.get("auto_summary_disabled")),
        "ai_generated": bool(item.get("ai_generated")),
        "user_edited": bool(item.get("user_edited")),
    }


def _canvas_idea_visible_items(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
        and _safe_text(item.get("id"))
        and bool(item.get("ai_generated"))
        and not bool(item.get("ai_pending"))
        and (_safe_text(item.get("title")) or _safe_text(item.get("body")))
    ]


def _is_canvas_topic_item(item: dict[str, Any]) -> bool:
    return _safe_text(item.get("kind"), "note") == "topic"


def _is_canvas_clusterable_item(item: dict[str, Any]) -> bool:
    return (
        isinstance(item, dict)
        and _safe_text(item.get("id"))
        and not _is_canvas_topic_item(item)
        and not bool(item.get("ai_pending"))
        and (_safe_text(item.get("title")) or _safe_text(item.get("body")))
    )


def _is_canvas_topic_clustering_candidate(item: dict[str, Any]) -> bool:
    return (
        _is_canvas_clusterable_item(item)
        or (
            _is_canvas_topic_item(item)
            and not bool(item.get("auto_summary_disabled"))
            and (_safe_text(item.get("title")) or _safe_text(item.get("body")))
        )
    )


def _canvas_direct_child_items(workspace: dict[str, Any], agenda_id: str) -> list[dict[str, Any]]:
    normalized_agenda_id = _safe_text(agenda_id)
    return [
        item
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
        and _safe_text(item.get("agenda_id")) == normalized_agenda_id
        and not _safe_text(item.get("parent_topic_id"))
        and (_is_canvas_topic_item(item) or _is_canvas_clusterable_item(item))
    ]


def _canvas_topic_nodes_for_agenda(workspace: dict[str, Any], agenda_id: str) -> list[dict[str, Any]]:
    normalized_agenda_id = _safe_text(agenda_id)
    return [
        item
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
        and _safe_text(item.get("agenda_id")) == normalized_agenda_id
        and _is_canvas_topic_item(item)
    ]


def _canvas_topic_child_ids(workspace: dict[str, Any], topic_id: str) -> list[str]:
    normalized_topic_id = _safe_text(topic_id)
    topic = next(
        (
            item
            for item in (workspace.get("canvas_items") or [])
            if isinstance(item, dict) and _safe_text(item.get("id")) == normalized_topic_id
        ),
        None,
    )
    explicit = [
        _safe_text(value)
        for value in ((topic or {}).get("child_item_ids") or [])
        if _safe_text(value)
    ]
    derived = [
        _safe_text(item.get("id"))
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict) and _safe_text(item.get("parent_topic_id")) == normalized_topic_id
    ]
    return _dedup_preserve(explicit + derived, limit=400)


def _canvas_topic_descendant_ids(workspace: dict[str, Any], topic_id: str) -> set[str]:
    descendants: set[str] = set()
    pending = list(_canvas_topic_child_ids(workspace, topic_id))

    while pending:
        child_id = _safe_text(pending.pop(0))
        if not child_id or child_id in descendants:
            continue
        descendants.add(child_id)
        child = next(
            (
                item
                for item in (workspace.get("canvas_items") or [])
                if isinstance(item, dict) and _safe_text(item.get("id")) == child_id
            ),
            None,
        )
        if child and _is_canvas_topic_item(child):
            pending.extend(_canvas_topic_child_ids(workspace, child_id))

    return descendants


def _canvas_topic_leaf_child_ids(workspace: dict[str, Any], topic_id: str) -> list[str]:
    leaves: list[str] = []
    pending = list(_canvas_topic_child_ids(workspace, topic_id))
    seen: set[str] = set()

    while pending:
        child_id = _safe_text(pending.pop(0))
        if not child_id or child_id in seen:
            continue
        seen.add(child_id)
        child = next(
            (
                item
                for item in (workspace.get("canvas_items") or [])
                if isinstance(item, dict) and _safe_text(item.get("id")) == child_id
            ),
            None,
        )
        if child and _is_canvas_topic_item(child):
            pending.extend(_canvas_topic_child_ids(workspace, child_id))
            continue
        if child:
            leaves.append(child_id)

    return _dedup_preserve(leaves, limit=400)


def _canvas_topic_summary_signature(workspace: dict[str, Any], topic_id: str) -> str:
    normalized_topic_id = _safe_text(topic_id)
    canvas_items = [
        item
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    item_by_id = {
        _safe_text(item.get("id")): item
        for item in canvas_items
        if _safe_text(item.get("id"))
    }
    topic = item_by_id.get(normalized_topic_id) or {}
    child_ids = _canvas_topic_leaf_child_ids(workspace, normalized_topic_id)
    child_payload = []
    for child_id in child_ids:
        child = item_by_id.get(child_id)
        if not child:
            continue
        child_payload.append(
            {
                "id": child_id,
                "kind": _safe_text(child.get("kind"), "note"),
                "title": _safe_text(child.get("title")),
                "body": _safe_text(child.get("body")),
                "keywords": [_safe_text(value) for value in (child.get("keywords") or []) if _safe_text(value)][:8],
                "evidence_utterance_ids": [
                    _safe_text(value)
                    for value in (child.get("evidence_utterance_ids") or [])
                    if _safe_text(value)
                ][:80],
                "parent_topic_id": _safe_text(child.get("parent_topic_id")),
                "compacted_from_ids": [_safe_text(value) for value in (child.get("compacted_from_ids") or []) if _safe_text(value)][:80],
                "compaction_level": _safe_nonnegative_int(child.get("compaction_level")),
            }
        )

    return _canvas_hash_signature(
        {
            "topic": {
                "id": normalized_topic_id,
                "title": _safe_text(topic.get("title")),
                "body": _safe_text(topic.get("body")),
                "keywords": [_safe_text(value) for value in (topic.get("keywords") or []) if _safe_text(value)][:8],
                "child_item_ids": _canvas_topic_child_ids(workspace, normalized_topic_id),
            },
            "leaf_child_ids": child_ids,
            "children": child_payload,
        }
    )


def _schedule_canvas_topic_summary_retry(source_job: dict[str, Any]) -> dict[str, Any] | None:
    normalized_meeting_id = _safe_text(source_job.get("meeting_id"))
    source_job_id = _safe_text(source_job.get("job_id"))
    topic_id = _safe_text(source_job.get("pending_item_id") or source_job.get("scope_key"))
    if (
        not normalized_meeting_id
        or not source_job_id
        or _canvas_job_type(source_job) != "topic_summary"
        or not topic_id
        or not bool(source_job.get("retryable"))
    ):
        return None

    retry_count = _canvas_job_retry_count(source_job)
    retry_delay = _canvas_topic_summary_retry_delay_seconds(retry_count)
    if retry_delay <= 0:
        return _mark_canvas_idea_job(
            normalized_meeting_id,
            source_job_id,
            retryable=False,
            retry_scheduled=False,
            detail=(
                _safe_text(source_job.get("detail"))
                or "AI topic 정리 재시도 한도에 도달했습니다."
            ),
        )

    if _has_newer_canvas_idea_scope_job(normalized_meeting_id, source_job_id, "topic_summary", topic_id):
        return None

    retry_after_epoch = time.time() + retry_delay
    retry_job_id = uuid4().hex
    meeting_topic = _safe_text(source_job.get("meeting_topic"), "회의 주제")
    workspace = _clone_runtime_workspace_state(
        normalized_meeting_id,
        _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        _now_ts(),
    )

    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        existing_retry = next(
            (
                copy.deepcopy(job)
                for job in meeting_jobs.values()
                if isinstance(job, dict)
                and _safe_text(job.get("status")) == "queued"
                and _canvas_job_type(job) == "topic_summary"
                and _safe_text(job.get("scope_key")) == topic_id
                and _safe_text(job.get("retry_source_job_id")) == source_job_id
            ),
            None,
        )
    if existing_retry:
        return existing_retry

    queued_job = _mark_canvas_idea_job(
        normalized_meeting_id,
        retry_job_id,
        job_type="topic_summary",
        scope_key=topic_id,
        status="queued",
        stale_reason="",
        retryable=False,
        retry_count=retry_count + 1,
        retry_after_epoch=retry_after_epoch,
        retry_source_job_id=source_job_id,
        meeting_topic=meeting_topic,
        detail=f"AI topic 정리 재시도 대기 중 · {retry_delay}초",
        pending_item_id=topic_id,
        target_count=0,
        target_signature="",
        created_at=_now_ts(),
        created_epoch=time.time(),
        workspace=copy.deepcopy(workspace),
    )
    _mark_canvas_idea_job(
        normalized_meeting_id,
        source_job_id,
        retry_scheduled=True,
        retry_job_id=retry_job_id,
        retry_after_epoch=retry_after_epoch,
    )
    threading.Thread(
        target=_run_queued_canvas_topic_summary_retry,
        args=(normalized_meeting_id, retry_job_id, topic_id, meeting_topic, retry_after_epoch),
        daemon=True,
        name=f"canvas-topic-summary-retry-{retry_job_id[:8]}",
    ).start()
    return queued_job


def _run_queued_canvas_topic_summary_retry(
    meeting_id: str,
    job_id: str,
    topic_item_id: str,
    meeting_topic: str,
    retry_after_epoch: float,
) -> None:
    wait_seconds = max(0.0, float(retry_after_epoch or 0) - time.time())
    if wait_seconds > 0:
        time.sleep(wait_seconds)

    normalized_meeting_id = _safe_text(meeting_id)
    normalized_job_id = _safe_text(job_id)
    topic_id = _safe_text(topic_item_id)
    with RT.lock:
        queued_job = copy.deepcopy(
            (RT.canvas_idea_jobs_by_meeting.get(normalized_meeting_id) or {}).get(normalized_job_id) or {}
        )
    if _safe_text(queued_job.get("status")) != "queued":
        return

    workspace = _clone_runtime_workspace_state(
        normalized_meeting_id,
        _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        _now_ts(),
    )
    canvas_items = [
        copy.deepcopy(item)
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    topic = next((item for item in canvas_items if _safe_text(item.get("id")) == topic_id), None)
    if not topic or not _is_canvas_topic_item(topic):
        missing_state = _canvas_missing_topic_summary_state(workspace, topic_id)
        _mark_canvas_idea_job(
            normalized_meeting_id,
            normalized_job_id,
            status="stale_obsolete",
            stale_reason=_safe_text(missing_state.get("stale_reason"), "obsolete"),
            retryable=False,
            detail=_safe_text(missing_state.get("detail")),
            resolved_node_id=_safe_text(missing_state.get("resolved_node_id")),
            workspace=copy.deepcopy(workspace),
            pending_item_id=topic_id,
        )
        return

    if _has_newer_canvas_idea_scope_job(normalized_meeting_id, normalized_job_id, "topic_summary", topic_id):
        _mark_canvas_idea_job(
            normalized_meeting_id,
            normalized_job_id,
            status="stale_superseded",
            stale_reason="superseded",
            retryable=False,
            detail="재시도 대기 중 더 최신 AI topic 정리 요청으로 대체되었습니다.",
            workspace=copy.deepcopy(workspace),
            pending_item_id=topic_id,
        )
        return

    target_signature = _canvas_topic_summary_signature(workspace, topic_id)
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        same_signature_running = next(
            (
                copy.deepcopy(job)
                for candidate_id, job in meeting_jobs.items()
                if _safe_text(candidate_id) != normalized_job_id
                and isinstance(job, dict)
                and _safe_text(job.get("status")) == "processing"
                and _canvas_job_type(job) == "topic_summary"
                and _safe_text(job.get("scope_key")) == topic_id
                and _safe_text(job.get("target_signature")) == target_signature
            ),
            None,
        )
    if same_signature_running:
        _mark_canvas_idea_job(
            normalized_meeting_id,
            normalized_job_id,
            status="stale_superseded",
            stale_reason="superseded",
            retryable=False,
            detail="같은 topic 정리 요청이 이미 처리 중이어서 재시도를 생략했습니다.",
            workspace=copy.deepcopy(workspace),
            pending_item_id=topic_id,
        )
        return

    workspace["canvas_items"] = [
        {
            **item,
            "ai_pending": True,
            "ai_generated": True,
            "user_edited": bool(item.get("user_edited")),
        }
        if _safe_text(item.get("id")) == topic_id
        else item
        for item in canvas_items
    ]
    workspace["node_positions"] = _normalize_canvas_node_positions(workspace.get("node_positions") or {})
    _save_canvas_workspace_runtime(normalized_meeting_id, workspace)
    _supersede_processing_canvas_idea_scope_jobs(
        normalized_meeting_id,
        "topic_summary",
        topic_id,
        target_signature,
        workspace,
        exclude_job_id=normalized_job_id,
    )
    _mark_canvas_idea_job(
        normalized_meeting_id,
        normalized_job_id,
        status="processing",
        stale_reason="",
        retryable=False,
        detail="AI가 topic 제목과 content를 재시도 중",
        pending_item_id=topic_id,
        target_count=len(_canvas_topic_leaf_child_ids(workspace, topic_id)),
        target_signature=target_signature,
        workspace=copy.deepcopy(workspace),
        processing_started_at=_now_ts(),
    )
    _run_canvas_task_worker_inline(
        "ideation.topic_summary",
        _finalize_canvas_topic_summary_workspace_job,
        (
            normalized_meeting_id,
            normalized_job_id,
            topic_id,
            _safe_text(meeting_topic, "회의 주제"),
        ),
    )


def _canvas_idea_create_stack_value(workspace: dict[str, Any]) -> int:
    stored = _safe_nonnegative_int(workspace.get("idea_create_stack"))
    if stored > 0:
        return stored
    return sum(_canvas_idea_source_count(item) for item in _canvas_idea_visible_items(workspace))


def _canvas_idea_visible_target(workspace: dict[str, Any]) -> int:
    source_count = max(1, _canvas_idea_create_stack_value(workspace))
    return max(3, min(7, int(round(2 + math.log2(source_count)))))


def _canvas_topic_cluster_target(workspace: dict[str, Any]) -> int:
    source_count = max(1, _canvas_idea_create_stack_value(workspace))
    return max(3, min(7, int(round(2 + math.log2(source_count)))))


def _canvas_idea_compaction_similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_text = _canvas_idea_item_text(left)
    right_text = _canvas_idea_item_text(right)
    score = _text_similarity(left_text, right_text)
    left_keywords = set(_normalize_idea_keywords(left.get("keywords") or [], left_text, 8))
    right_keywords = set(_normalize_idea_keywords(right.get("keywords") or [], right_text, 8))
    if left_keywords and right_keywords:
        score = max(score, len(left_keywords & right_keywords) / max(1, len(left_keywords | right_keywords)))
    if _safe_text(left.get("agenda_id")) and _safe_text(left.get("agenda_id")) == _safe_text(right.get("agenda_id")):
        score += 0.05
    return score


def _pick_canvas_idea_compaction_pair(items: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    candidates = [item for item in items if not bool(item.get("auto_summary_disabled"))]
    if len(candidates) < 2:
        return None

    best_pair: tuple[dict[str, Any], dict[str, Any]] | None = None
    best_score = -1.0
    for left_index, left in enumerate(candidates):
        for right in candidates[left_index + 1 :]:
            score = _canvas_idea_compaction_similarity(left, right)
            if score > best_score:
                best_score = score
                best_pair = (left, right)
    return best_pair


def _pick_similar_topic_child_idea_pair(
    workspace: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], float] | None:
    items = [
        item
        for item in (workspace.get("canvas_items") or [])
        if _is_canvas_clusterable_item(item)
        and _safe_text(item.get("kind"), "note") != "comment"
        and not bool(item.get("auto_summary_disabled"))
        and _safe_text(item.get("parent_topic_id"))
    ]
    children_by_topic_id: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        children_by_topic_id.setdefault(_safe_text(item.get("parent_topic_id")), []).append(item)

    best_pair: tuple[dict[str, Any], dict[str, Any], float] | None = None
    best_score = -1.0
    for topic_id, topic_children in children_by_topic_id.items():
        if len(topic_children) < 2:
            continue
        ordered_child_ids = _canvas_topic_child_ids(workspace, topic_id)
        order_by_id = {child_id: index for index, child_id in enumerate(ordered_child_ids)}
        sorted_children = sorted(
            topic_children,
            key=lambda item: order_by_id.get(_safe_text(item.get("id")), 10**9),
        )
        for left_index, left in enumerate(sorted_children):
            for right in sorted_children[left_index + 1 :]:
                score = _canvas_idea_compaction_similarity(left, right)
                if score > best_score:
                    best_score = score
                    best_pair = (left, right, score)

    if not best_pair or best_score < CANVAS_TOPIC_CHILD_IDEA_MERGE_MIN_SCORE:
        return None
    return best_pair


def _build_idea_compaction_prompt(left: dict[str, Any], right: dict[str, Any]) -> str:
    ideas = []
    for item in (left, right):
        ideas.append(
            {
                "id": _safe_text(item.get("id")),
                "title": _safe_text(item.get("title")),
                "content": _safe_text(item.get("body")),
                "keywords": [_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)][:8],
                "key_evidence": [_safe_text(value) for value in (item.get("key_evidence") or []) if _safe_text(value)][:8],
                "refined_utterances": _normalize_refined_utterances(item.get("refined_utterances") or [], limit=8),
                "source_node_count": _canvas_idea_source_count(item),
            }
        )

    return (
        "아래 두 개의 아이디어 노드는 의미가 유사해서 canvas에서 하나의 상위 아이디어 노드로 압축하려고 한다.\n"
        "원본 노드는 시스템이 하위 근거로 보존하므로, 너는 상위 노드에 표시할 title/content/keywords/keyEvidence만 재작성한다.\n"
        "규칙:\n"
        "- 두 노드의 공통 의미를 중심으로 압축한다.\n"
        "- content는 1~2줄, 문장형 설명보다 핵심 대상 + 방향/문제/조건의 압축 구문을 우선한다.\n"
        "- keywords는 3~6개, 일반어/메타어를 제외하고 의미 중심 명사구로 쓴다.\n"
        "- keyEvidence는 상위 노드를 이해하는 데 필요한 핵심 근거만 최대 4개로 쓴다.\n"
        "- 없는 내용을 만들지 말고, 두 노드에 있는 내용만 사용한다.\n"
        "- JSON만 반환한다.\n\n"
        "반환 형식:\n"
        "{\"title\":\"...\",\"summary\":\"...\",\"keywords\":[\"...\"],\"keyEvidence\":[\"...\"]}\n\n"
        f"nodes={json.dumps(ideas, ensure_ascii=False)}"
    )


def _compute_idea_compaction_update(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any] | None:
    fallback_ids = _dedup_preserve(
        [
            _safe_text(value)
            for item in (left, right)
            for value in (item.get("evidence_utterance_ids") or [])
            if _safe_text(value)
        ],
        limit=400,
    )
    client, llm_ready, _ = _ensure_llm_ready(RT)
    if not llm_ready:
        return None

    try:
        parsed = _call_llm_json(
            RT,
            client,
            prompt=_build_idea_compaction_prompt(left, right),
            stage="canvas_idea_compaction",
            temperature=0.18,
            max_tokens=900,
        )
    except Exception as exc:
        _append_llm_io_log(RT, direction="error", stage="canvas_idea_compaction", payload=str(exc), meta={})
        return None

    raw = parsed.get("update") if isinstance(parsed, dict) and isinstance(parsed.get("update"), dict) else parsed
    if not isinstance(raw, dict):
        return None
    update = _normalize_idea_assimilation_update(
        {
            **raw,
            "action": "create",
            "evidenceUtteranceIds": raw.get("evidenceUtteranceIds") or raw.get("evidence_utterance_ids") or fallback_ids,
        },
        fallback_ids,
    )
    return update


def _apply_canvas_idea_compaction_pair(
    workspace: dict[str, Any],
    left: dict[str, Any],
    right: dict[str, Any],
    update: dict[str, Any],
) -> None:
    left_id = _safe_text(left.get("id"))
    right_id = _safe_text(right.get("id"))
    if not left_id or not right_id or left_id == right_id:
        return

    canvas_items = [
        copy.deepcopy(item)
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    item_indices = {_safe_text(item.get("id")): index for index, item in enumerate(canvas_items) if _safe_text(item.get("id"))}
    if item_indices.get(right_id, 10**9) < item_indices.get(left_id, 10**9):
        left, right = right, left
        left_id, right_id = right_id, left_id

    combined_refined = _normalize_refined_utterances(
        list(update.get("refinedUtterances") or [])
        + list(left.get("refined_utterances") or [])
        + list(right.get("refined_utterances") or []),
        limit=120,
    )
    combined_evidence_ids = _dedup_preserve(
        [_safe_text(value) for value in (left.get("evidence_utterance_ids") or []) if _safe_text(value)]
        + [_safe_text(value) for value in (right.get("evidence_utterance_ids") or []) if _safe_text(value)]
        + [_safe_text(value) for value in (update.get("evidenceUtteranceIds") or []) if _safe_text(value)],
        limit=400,
    )
    combined_ignored_ids = _dedup_preserve(
        [_safe_text(value) for value in (left.get("ignored_utterance_ids") or []) if _safe_text(value)]
        + [_safe_text(value) for value in (right.get("ignored_utterance_ids") or []) if _safe_text(value)]
        + [_safe_text(value) for value in (update.get("ignoredUtteranceIds") or []) if _safe_text(value)],
        limit=400,
    )
    combined_children = _normalize_canvas_merged_children(
        [_canvas_idea_child_snapshot(left), _canvas_idea_child_snapshot(right)],
        limit=80,
    )
    compacted_from_ids = _dedup_preserve(_canvas_idea_leaf_ids(left) + _canvas_idea_leaf_ids(right), limit=400)
    parent = {
        **left,
        "title": _safe_text(update.get("title")) or _safe_text(left.get("title")),
        "body": _safe_text(update.get("summary")) or _safe_text(left.get("body")),
        "keywords": _normalize_idea_keywords(update.get("keywords") or [], f"{update.get('title') or ''} {update.get('summary') or ''}", 8)
        or _dedup_preserve(
            [_safe_text(value) for value in (left.get("keywords") or []) if _safe_text(value)]
            + [_safe_text(value) for value in (right.get("keywords") or []) if _safe_text(value)],
            limit=8,
        ),
        "key_evidence": _dedup_preserve(
            [_safe_text(value) for value in (update.get("keyEvidence") or []) if _safe_text(value)]
            + [_safe_text(value) for value in (left.get("key_evidence") or []) if _safe_text(value)]
            + [_safe_text(value) for value in (right.get("key_evidence") or []) if _safe_text(value)],
            limit=8,
        ),
        "refined_utterances": combined_refined,
        "evidence_utterance_ids": combined_evidence_ids,
        "ignored_utterance_ids": combined_ignored_ids,
        "merged_children": combined_children,
        "compacted_from_ids": compacted_from_ids,
        "compaction_level": max(
            _safe_nonnegative_int(left.get("compaction_level")),
            _safe_nonnegative_int(right.get("compaction_level")),
        )
        + 1,
        "ai_generated": True,
        "user_edited": False,
        "ai_pending": False,
        "manual_position": False,
    }
    parent.pop("x", None)
    parent.pop("y", None)

    workspace["canvas_items"] = [
        parent if _safe_text(item.get("id")) == left_id else item
        for item in canvas_items
        if _safe_text(item.get("id")) != right_id
    ]
    next_parent_topic_id = _safe_text(parent.get("parent_topic_id"))
    workspace["canvas_items"] = [
        {
            **item,
            "child_item_ids": _dedup_preserve(
                [
                    left_id if _safe_text(child_id) == right_id else _safe_text(child_id)
                    for child_id in (item.get("child_item_ids") or [])
                    if _safe_text(child_id)
                ]
                + ([left_id] if _safe_text(item.get("id")) == next_parent_topic_id else []),
                limit=400,
            ),
        }
        if _is_canvas_topic_item(item)
        else item
        for item in workspace["canvas_items"]
    ]
    node_positions = _normalize_canvas_node_positions(workspace.get("node_positions") or {})
    ideation_positions = dict(node_positions.get("ideation") or {})
    ideation_positions.pop(f"canvas-item-{right_id}", None)
    node_positions["ideation"] = ideation_positions
    workspace["node_positions"] = node_positions


def _maybe_compact_canvas_idea_nodes(workspace: dict[str, Any]) -> dict[str, Any]:
    visible_items = _canvas_idea_visible_items(workspace)
    target = _canvas_idea_visible_target(workspace)
    if len(visible_items) < CANVAS_IDEA_COMPACTION_MIN_VISIBLE or len(visible_items) <= target:
        return {"merged": 0, "target": target, "visible": len(visible_items)}

    merged = 0
    while merged < CANVAS_IDEA_COMPACTION_MAX_MERGES_PER_JOB:
        visible_items = _canvas_idea_visible_items(workspace)
        if len(visible_items) <= target:
            break
        pair = _pick_canvas_idea_compaction_pair(visible_items)
        if not pair:
            break
        update = _compute_idea_compaction_update(pair[0], pair[1])
        if not update:
            break
        _apply_canvas_idea_compaction_pair(workspace, pair[0], pair[1], update)
        merged += 1

    return {"merged": merged, "target": target, "visible": len(_canvas_idea_visible_items(workspace))}


def _maybe_merge_similar_topic_child_ideas(workspace: dict[str, Any]) -> dict[str, Any]:
    merged = 0
    last_score = 0.0
    while merged < CANVAS_TOPIC_CHILD_IDEA_MERGE_MAX_MERGES_PER_JOB:
        pair = _pick_similar_topic_child_idea_pair(workspace)
        if not pair:
            break
        left, right, score = pair
        update = _compute_idea_compaction_update(left, right)
        if not update:
            break
        _apply_canvas_idea_compaction_pair(workspace, left, right, update)
        merged += 1
        last_score = score

    return {
        "merged": merged,
        "threshold": CANVAS_TOPIC_CHILD_IDEA_MERGE_MIN_SCORE,
        "last_score": round(last_score, 3) if last_score else 0,
    }


def _build_canvas_topic_clustering_prompt(
    workspace: dict[str, Any],
    agenda_id: str,
    top_level_items: list[dict[str, Any]],
    candidate_items: list[dict[str, Any]],
) -> str:
    target = _canvas_topic_cluster_target(workspace)

    def node_payload(item: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "id": _safe_text(item.get("id")),
            "kind": _safe_text(item.get("kind"), "note"),
            "title": _safe_text(item.get("title")),
            "content": _safe_text(item.get("body")),
            "keywords": [_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)][:8],
            "refined_utterances": _normalize_refined_utterances(item.get("refined_utterances") or [], limit=6),
            "parent_topic_locked": bool(item.get("parent_topic_locked")),
            "created_by": _safe_text(item.get("created_by")),
            "user_edited": bool(item.get("user_edited")),
        }
        if _is_canvas_topic_item(item):
            payload["child_count"] = len(_canvas_topic_child_ids(workspace, _safe_text(item.get("id"))))
        return payload

    payload = {
        "agenda_id": _safe_text(agenda_id),
        "visibleTarget": target,
        "directChildCount": len(top_level_items),
        "nodes": [node_payload(item) for item in candidate_items],
    }
    return (
        "회의 canvas의 그룹 분류 바로 아래 1차 노드 수가 자동 계산된 visibleTarget을 넘었다.\n"
        "너는 아래 direct child 노드 중 의미가 가장 유사한 2개만 골라 계층적 topic으로 묶어야 한다.\n"
        "규칙:\n"
        "- visibleTarget은 전체 아이디어 source 수를 기준으로 3~7 사이에서 자동 계산된 최적 1차 노드 목표다.\n"
        "- 카운트 기준은 topic node 개수가 아니라 그룹 분류 바로 아래에 있는 1차 노드 전체 개수다.\n"
        "- nodes는 모두 그룹 분류 바로 아래 direct child 후보이다.\n"
        "- 반드시 가장 유사한 2개만 pair로 반환한다. 3개 이상 선택 금지.\n"
        "- 서로 의미가 충분히 유사하지 않으면 pair를 빈 배열로 반환한다.\n"
        "- kind=topic인 노드도 후보가 될 수 있다. topic끼리 유사하면 topic들을 하위에 넣는 것이 아니라 하나의 새 topic으로 통합한다.\n"
        "- topic node 아래에는 다른 topic node가 들어가면 안 된다. topic pair를 고르더라도 서버가 기존 topic의 실제 하위 아이디어만 새 topic 아래로 평탄화한다.\n"
        "- title/body/keywords는 선택한 pair 2개를 대표하는 topic 문구로 작성한다.\n"
        "- title은 10~24자 정도의 짧은 명사구로 쓴다. '요약', '정리', '논의', '관련' 같은 메타어를 쓰지 않는다.\n"
        "- body는 topic 노드 본문에 들어갈 content다. 완성형 설명문이 아니라 핵심 대상 + 방향/문제/조건만 남긴 압축 구문이어야 한다.\n"
        "- body는 최대 2줄로 작성하고, 각 줄은 12~36자 정도의 짧은 명사구/핵심 구문으로 쓴다.\n"
        "- body에 '~합니다', '~됩니다', '~할 수 있습니다', '~로 보입니다' 같은 문장형 어미를 피한다.\n"
        "- keywords는 3~6개로 작성하고, pair 전체의 중심 의미를 이루는 명사구만 넣는다.\n"
        "- 서버가 pair를 검증한 뒤 새 topic 생성 또는 기존 topic 업데이트를 결정한다.\n"
        "- JSON만 반환한다.\n\n"
        "반환 형식:\n"
        "{"
        "\"pair\":[\"node-id-1\",\"node-id-2\"],"
        "\"title\":\"...\","
        "\"body\":\"...\","
        "\"keywords\":[\"...\"]"
        "}\n\n"
        f"input={json.dumps(payload, ensure_ascii=False)}"
    )


def _normalize_topic_cluster_title(raw: Any, fallback: str = "") -> str:
    text = _strip_idea_reference_text(raw, collapse_whitespace=False)
    if not text:
        return fallback
    text = re.sub(r"^(?:주제|topic|제목|요약|정리)\s*[:：-]\s*", "", text, flags=re.IGNORECASE)
    return _to_summary_point(text, 24)


def _normalize_topic_cluster_body(raw: Any, fallback: str = "") -> str:
    text = _safe_text(raw)
    if isinstance(raw, list):
        text = "\n".join(_safe_text(item) for item in raw if _safe_text(item))
    text = _strip_idea_reference_text(text, collapse_whitespace=False)
    text = re.sub(r"^(?:내용|본문|요약|summary|content|body)\s*[:：-]\s*", "", text, flags=re.IGNORECASE)
    candidates = [
        _to_summary_point(part, 42)
        for part in re.split(r"\n+|\s*/\s*|[;；]+", text)
        if _safe_text(part)
    ]
    candidates = [
        item
        for item in candidates
        if item
        and item.lower() not in IDEA_KEYWORD_NOISE
        and not re.fullmatch(r"(없음|해당 없음|n/?a)", item, flags=re.IGNORECASE)
    ]
    if not candidates and fallback:
        candidates = [_to_summary_point(fallback, 42)]
    return "\n".join(_dedup_preserve(candidates, limit=2))


def _build_canvas_topic_summary_prompt(
    meeting_topic: str,
    topic: dict[str, Any],
    child_items: list[dict[str, Any]],
) -> str:
    def child_payload(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": _safe_text(item.get("id")),
            "kind": _safe_text(item.get("kind"), "note"),
            "title": _safe_text(item.get("title")),
            "content": _safe_text(item.get("body")),
            "keywords": [_safe_text(value) for value in (item.get("keywords") or []) if _safe_text(value)][:8],
            "refined_utterances": _normalize_refined_utterances(item.get("refined_utterances") or [], limit=8),
        }

    payload = {
        "meeting_topic": _safe_text(meeting_topic),
        "draft_topic": {
            "id": _safe_text(topic.get("id")),
            "title": _safe_text(topic.get("title")),
            "content": _safe_text(topic.get("body")),
            "keywords": [_safe_text(value) for value in (topic.get("keywords") or []) if _safe_text(value)][:8],
        },
        "children": [child_payload(item) for item in child_items],
    }
    return (
        "너는 회의 아이디어 canvas의 topic node 내부를 정리하는 분석기다. JSON 하나만 반환한다.\n"
        "입력된 children은 사용자가 직접 묶은 아이디어들이다. draft_topic은 참고만 하고 그대로 복사하지 않는다.\n"
        "규칙:\n"
        "- title은 children 전체를 대표하는 10~24자 정도의 짧은 명사구로 쓴다.\n"
        "- title에 '요약', '정리', '논의', '관련', '묶음', '토픽' 같은 메타어를 쓰지 않는다.\n"
        "- body는 topic node content다. 완성형 문장이 아니라 핵심 대상 + 방향/문제/조건만 남긴 압축 구문이어야 한다.\n"
        "- body는 최대 2줄, 각 줄 12~36자 정도의 짧은 명사구/핵심 구문으로 쓴다.\n"
        "- '~합니다', '~됩니다', '~할 수 있습니다', '~로 보입니다' 같은 문장형 어미를 피한다.\n"
        "- keywords는 children 전체를 대표하는 명사구 3~6개만 쓴다.\n"
        "- children에 없는 내용을 새로 만들지 않는다.\n"
        "- JSON만 반환한다.\n\n"
        "반환 형식:\n"
        "{"
        "\"title\":\"...\","
        "\"body\":\"...\","
        "\"keywords\":[\"...\"]"
        "}\n\n"
        f"input={json.dumps(payload, ensure_ascii=False)}"
    )


def _compute_canvas_topic_summary_update(
    meeting_topic: str,
    topic: dict[str, Any],
    child_items: list[dict[str, Any]],
) -> dict[str, Any] | None:
    client, llm_ready, _ = _ensure_llm_ready(RT)
    if not llm_ready or not child_items:
        return None
    try:
        parsed = _call_llm_json(
            RT,
            client,
            prompt=_build_canvas_topic_summary_prompt(meeting_topic, topic, child_items),
            stage="canvas_topic_summary",
            temperature=0.14,
            max_tokens=700,
        )
    except Exception as exc:
        _append_llm_io_log(RT, direction="error", stage="canvas_topic_summary", payload=str(exc), meta={})
        return None
    if not isinstance(parsed, dict):
        return None
    title = _normalize_topic_cluster_title(parsed.get("title"), _safe_text(topic.get("title"), "AI 주제"))
    body = _normalize_topic_cluster_body(parsed.get("body") or parsed.get("summary"), title)
    keywords = _normalize_idea_keywords(parsed.get("keywords") or [], f"{title} {body}", 6)
    if not title and not body and not keywords:
        return None
    return {
        "title": title,
        "body": body,
        "keywords": keywords,
    }


def _build_canvas_topic_summary_patch(
    topic_id: str,
    target_signature: str,
    update: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(update, dict):
        return None
    patch: dict[str, Any] = {}
    title = _safe_text(update.get("title"))
    body = _safe_text(update.get("body"))
    keywords = [_safe_text(value) for value in (update.get("keywords") or []) if _safe_text(value)][:6]
    if title:
        patch["title"] = title
    if body:
        patch["body"] = body
    if keywords:
        patch["keywords"] = keywords
    if not patch:
        return None
    return {
        "operation": "update_topic_summary",
        "target_id": _safe_text(topic_id),
        "base_signature": _safe_text(target_signature),
        "patch": patch,
        "created_at": _utc_iso_now(),
        "created_epoch": time.time(),
    }


def _apply_canvas_topic_summary_patch(
    workspace: dict[str, Any],
    patch_payload: dict[str, Any],
    expected_signature: str = "",
) -> tuple[dict[str, Any], bool, str]:
    next_workspace = _clone_runtime_workspace_state(
        _safe_text(workspace.get("meeting_id")),
        workspace,
        _now_ts(),
    )
    target_id = _safe_text(patch_payload.get("target_id"))
    if not target_id:
        return next_workspace, False, "missing_target"

    canvas_items = [
        copy.deepcopy(item)
        for item in (next_workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    target_item = next((item for item in canvas_items if _safe_text(item.get("id")) == target_id), None)
    if not target_item or not _is_canvas_topic_item(target_item):
        return next_workspace, False, "target_missing"

    expected = _safe_text(expected_signature or patch_payload.get("base_signature"))
    if expected and _canvas_topic_summary_signature(next_workspace, target_id) != expected:
        return next_workspace, False, "input_changed"

    raw_patch = patch_payload.get("patch")
    if not isinstance(raw_patch, dict):
        return next_workspace, False, "empty_patch"

    title = _safe_text(raw_patch.get("title"))
    body = _safe_text(raw_patch.get("body"))
    keywords = [_safe_text(value) for value in (raw_patch.get("keywords") or []) if _safe_text(value)][:6]

    def apply_to_item(item: dict[str, Any]) -> dict[str, Any]:
        if _safe_text(item.get("id")) != target_id:
            return item
        auto_summary_disabled = bool(item.get("auto_summary_disabled"))
        next_item = {
            **item,
            "ai_pending": False,
            "ai_generated": True,
            "manual_position": False,
        }
        if not auto_summary_disabled:
            if title:
                next_item["title"] = title
            if body:
                next_item["body"] = body
            if keywords:
                next_item["keywords"] = keywords
            next_item["user_edited"] = False
        return next_item

    next_workspace["canvas_items"] = [apply_to_item(item) for item in canvas_items]
    return next_workspace, True, "applied"


def _finalize_canvas_topic_summary_workspace_job(
    meeting_id: str,
    job_id: str,
    topic_item_id: str,
    meeting_topic: str,
) -> None:
    try:
        topic_id = _safe_text(topic_item_id)
        with RT.lock:
            current_job = copy.deepcopy(
                (RT.canvas_idea_jobs_by_meeting.get(_safe_text(meeting_id)) or {}).get(_safe_text(job_id)) or {}
            )
        if current_job and _safe_text(current_job.get("status")) != "processing":
            return

        job_target_signature = _safe_text(current_job.get("target_signature"))
        source_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        source_canvas_items = [
            copy.deepcopy(item)
            for item in (source_workspace.get("canvas_items") or [])
            if isinstance(item, dict)
        ]
        topic = next((item for item in source_canvas_items if _safe_text(item.get("id")) == topic_id), None)
        if not topic or not _is_canvas_topic_item(topic):
            missing_state = _canvas_missing_topic_summary_state(source_workspace, topic_id)
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                _safe_text(missing_state.get("detail")),
                stale_reason=_safe_text(missing_state.get("stale_reason"), "obsolete"),
                resolved_node_id=_safe_text(missing_state.get("resolved_node_id")),
            )
            return

        if _has_newer_canvas_idea_scope_job(meeting_id, job_id, "topic_summary", topic_id):
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                "더 최신 AI topic 정리 요청으로 대체되었습니다.",
                status="stale_superseded",
                stale_reason="superseded",
            )
            return

        if job_target_signature and _canvas_topic_summary_signature(source_workspace, topic_id) != job_target_signature:
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                "topic 하위 내용이 바뀌어 이전 AI 정리 결과를 적용하지 않았습니다.",
                status="stale_rebasable",
                stale_reason="input_changed",
                retryable=True,
            )
            return

        child_ids = _canvas_topic_leaf_child_ids({"canvas_items": source_canvas_items}, topic_id)
        child_id_set = set(child_ids)
        child_items = [
            item
            for item in source_canvas_items
            if _safe_text(item.get("id")) in child_id_set and not _is_canvas_topic_item(item)
        ]
        update = _compute_canvas_topic_summary_update(meeting_topic, topic, child_items)
        patch_payload = _build_canvas_topic_summary_patch(topic_id, job_target_signature, update)

        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        canvas_items = [
            copy.deepcopy(item)
            for item in (latest_workspace.get("canvas_items") or [])
            if isinstance(item, dict)
        ]
        latest_topic = next((item for item in canvas_items if _safe_text(item.get("id")) == topic_id), None)
        if not latest_topic or not _is_canvas_topic_item(latest_topic):
            missing_state = _canvas_missing_topic_summary_state(latest_workspace, topic_id)
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                _safe_text(missing_state.get("detail")),
                stale_reason=_safe_text(missing_state.get("stale_reason"), "obsolete"),
                resolved_node_id=_safe_text(missing_state.get("resolved_node_id")),
            )
            return

        if _has_newer_canvas_idea_scope_job(meeting_id, job_id, "topic_summary", topic_id):
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                "더 최신 AI topic 정리 요청으로 대체되었습니다.",
                status="stale_superseded",
                stale_reason="superseded",
            )
            return

        if job_target_signature and _canvas_topic_summary_signature(latest_workspace, topic_id) != job_target_signature:
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                "topic 하위 내용이 바뀌어 이전 AI 정리 결과를 적용하지 않았습니다.",
                status="stale_rebasable",
                stale_reason="input_changed",
                retryable=True,
            )
            return

        if not patch_payload:
            warning = "LLM 응답을 받지 못해 topic 내용을 생성하지 못했습니다."
            latest_workspace["canvas_items"] = [
                {
                    **item,
                    "ai_pending": False,
                    "body": _safe_text(item.get("body")) or "AI topic 정리에 실패했습니다.",
                }
                if _safe_text(item.get("id")) == topic_id
                else item
                for item in canvas_items
            ]
            _save_canvas_workspace_runtime(meeting_id, latest_workspace)
            updated_job = _mark_canvas_idea_job(
                meeting_id,
                job_id,
                status="error_retryable",
                retryable=True,
                detail=warning,
                workspace=copy.deepcopy(latest_workspace),
                used_llm=False,
                warning=warning,
                pending_item_id=topic_id,
                failed_at_epoch=time.time(),
            )
            _schedule_canvas_topic_summary_retry(updated_job)
            return

        patched_workspace, patch_applied, patch_status = _apply_canvas_topic_summary_patch(
            latest_workspace,
            patch_payload,
            job_target_signature,
        )
        if not patch_applied:
            status = "stale_rebasable" if patch_status == "input_changed" else "stale_obsolete"
            stale_reason = "input_changed" if patch_status == "input_changed" else "obsolete"
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                topic_id,
                "topic 상태가 바뀌어 AI patch를 적용하지 않았습니다.",
                status=status,
                stale_reason=stale_reason,
                retryable=patch_status == "input_changed",
            )
            return

        _save_canvas_workspace_runtime(meeting_id, patched_workspace)
        patch_title = _safe_text((patch_payload.get("patch") or {}).get("title")) if isinstance(patch_payload.get("patch"), dict) else ""
        _mark_canvas_idea_job(
            meeting_id,
            job_id,
            status="completed",
            activity_line=f'"{patch_title}" 핵심 추출' if patch_title else "토픽 핵심 추출",
            detail="AI topic 정리 완료",
            workspace=copy.deepcopy(patched_workspace),
            patch=copy.deepcopy(patch_payload),
            used_llm=True,
            warning="",
            pending_item_id=topic_id,
        )
    except Exception as exc:
        if _has_newer_canvas_idea_scope_job(meeting_id, job_id, "topic_summary", _safe_text(topic_item_id)):
            _finish_stale_canvas_topic_summary_job(
                meeting_id,
                job_id,
                _safe_text(topic_item_id),
                "더 최신 AI topic 정리 요청으로 대체되었습니다.",
                status="stale_superseded",
                stale_reason="superseded",
            )
            return
        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        latest_workspace["canvas_items"] = [
            {
                **item,
                "ai_pending": False,
                "body": _safe_text(item.get("body")) or "AI topic 정리에 실패했습니다.",
            }
            if isinstance(item, dict) and _safe_text(item.get("id")) == _safe_text(topic_item_id)
            else item
            for item in (latest_workspace.get("canvas_items") or [])
        ]
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)
        updated_job = _mark_canvas_idea_job(
            meeting_id,
            job_id,
            status="error_retryable",
            retryable=True,
            detail=f"AI topic 정리 실패: {exc}",
            workspace=copy.deepcopy(latest_workspace),
            used_llm=False,
            warning=_safe_text(exc),
            pending_item_id=_safe_text(topic_item_id),
            failed_at_epoch=time.time(),
        )
        _schedule_canvas_topic_summary_retry(updated_job)


def _compute_canvas_topic_clustering_result(
    workspace: dict[str, Any],
    agenda_id: str,
    top_level_items: list[dict[str, Any]],
    candidate_items: list[dict[str, Any]],
) -> dict[str, Any] | None:
    client, llm_ready, _ = _ensure_llm_ready(RT)
    if not llm_ready or not candidate_items:
        return None
    try:
        parsed = _call_llm_json(
            RT,
            client,
            prompt=_build_canvas_topic_clustering_prompt(
                workspace,
                agenda_id,
                top_level_items,
                candidate_items,
            ),
            stage="canvas_topic_clustering",
            temperature=0.16,
            max_tokens=900,
        )
    except Exception as exc:
        _append_llm_io_log(RT, direction="error", stage="canvas_topic_clustering", payload=str(exc), meta={})
        return None
    return parsed if isinstance(parsed, dict) else None


def _apply_canvas_topic_clustering_result(
    workspace: dict[str, Any],
    agenda_id: str,
    result: dict[str, Any],
) -> int:
    canvas_items = [
        copy.deepcopy(item)
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    items_by_id = {_safe_text(item.get("id")): item for item in canvas_items if _safe_text(item.get("id"))}
    direct_child_ids = {
        item_id
        for item_id in [
            _safe_text(item.get("id"))
            for item in _canvas_direct_child_items({"canvas_items": canvas_items}, agenda_id)
        ]
        if item_id
    }
    movable_ids = {
        item_id
        for item_id, item in items_by_id.items()
        if _safe_text(item.get("agenda_id")) == _safe_text(agenda_id)
        and _is_canvas_topic_clustering_candidate(item)
        and not bool(item.get("parent_topic_locked"))
        and item_id in direct_child_ids
    }

    raw_pair = result.get("pair") or result.get("nodeIds") or result.get("node_ids")
    if not isinstance(raw_pair, list):
        return 0
    pair_ids = _dedup_preserve(
        [_safe_text(value) for value in raw_pair if _safe_text(value) in movable_ids],
        limit=2,
    )
    if len(pair_ids) != 2:
        return 0

    left_item = items_by_id.get(pair_ids[0])
    right_item = items_by_id.get(pair_ids[1])
    if not left_item or not right_item:
        return 0
    if pair_ids[0] in _canvas_topic_descendant_ids({"canvas_items": canvas_items}, pair_ids[1]):
        return 0
    if pair_ids[1] in _canvas_topic_descendant_ids({"canvas_items": canvas_items}, pair_ids[0]):
        return 0

    title = _normalize_topic_cluster_title(result.get("title"), "AI 주제")
    body = _normalize_topic_cluster_body(result.get("body") or result.get("summary"), title or "관련 아이디어 묶음")
    keywords = _normalize_idea_keywords(result.get("keywords") or [], f"{title} {body}", 6)
    topic_pair_ids = [item_id for item_id in pair_ids if _is_canvas_topic_item(items_by_id.get(item_id) or {})]

    created_topics: list[dict[str, Any]] = []
    created_topic_insert_index: int | None = None
    removed_topic_ids: set[str] = set()
    now_ms = int(time.time() * 1000)

    assignments: dict[str, str] = {}
    topic_updates: dict[str, dict[str, Any]] = {}
    source_workspace = {"canvas_items": canvas_items}

    if len(topic_pair_ids) == 1:
        topic_id = topic_pair_ids[0]
        child_id = pair_ids[0] if pair_ids[1] == topic_id else pair_ids[1]
        nested_topic_ids = {
            descendant_id
            for descendant_id in _canvas_topic_descendant_ids(source_workspace, topic_id)
            if _is_canvas_topic_item(items_by_id.get(descendant_id) or {})
        }
        for nested_topic_id in nested_topic_ids:
            removed_topic_ids.add(nested_topic_id)
            for leaf_child_id in _canvas_topic_leaf_child_ids(source_workspace, nested_topic_id):
                if leaf_child_id not in removed_topic_ids:
                    assignments[leaf_child_id] = topic_id
        assignments[child_id] = topic_id
        topic_updates[topic_id] = {
            "title": title,
            "body": body,
            "keywords": keywords,
        }
    elif len(topic_pair_ids) == 2:
        removed_topic_ids.update(topic_pair_ids)
        leaf_child_ids: list[str] = []
        for source_topic_id in topic_pair_ids:
            removed_topic_ids.update(
                descendant_id
                for descendant_id in _canvas_topic_descendant_ids(source_workspace, source_topic_id)
                if _is_canvas_topic_item(items_by_id.get(descendant_id) or {})
            )
            leaf_child_ids.extend(_canvas_topic_leaf_child_ids(source_workspace, source_topic_id))
        leaf_child_ids = _dedup_preserve(
            [child_id for child_id in leaf_child_ids if child_id and child_id not in removed_topic_ids],
            limit=400,
        )
        if not leaf_child_ids:
            return 0
        topic_id = f"ai-topic-{now_ms}-0-{uuid4().hex[:6]}"
        topic = {
            "id": topic_id,
            "agenda_id": _safe_text(agenda_id),
            "point_id": "",
            "kind": "topic",
            "title": title,
            "body": body,
            "keywords": keywords,
            "key_evidence": [],
            "refined_utterances": [],
            "evidence_utterance_ids": [],
            "ignored_utterance_ids": [],
            "child_item_ids": leaf_child_ids,
            "topic_collapsed": True,
            "created_by": "ai",
            "ai_generated": True,
            "user_edited": False,
            "manual_position": False,
        }
        created_topics.append(topic)
        items_by_id[topic_id] = topic
        for child_id in leaf_child_ids:
            assignments[child_id] = topic_id
    else:
        topic_id = f"ai-topic-{now_ms}-0-{uuid4().hex[:6]}"
        topic = {
            "id": topic_id,
            "agenda_id": _safe_text(agenda_id),
            "point_id": "",
            "kind": "topic",
            "title": title,
            "body": body,
            "keywords": keywords,
            "key_evidence": [],
            "refined_utterances": [],
            "evidence_utterance_ids": [],
            "ignored_utterance_ids": [],
            "child_item_ids": pair_ids,
            "topic_collapsed": True,
            "created_by": "ai",
            "ai_generated": True,
            "user_edited": False,
            "manual_position": False,
        }
        created_topics.append(topic)
        items_by_id[topic_id] = topic
        for child_id in pair_ids:
            assignments[child_id] = topic_id

    if created_topics:
        original_indices = [
            index
            for index, item in enumerate(canvas_items)
            if _safe_text(item.get("id")) in pair_ids
        ]
        if original_indices:
            created_topic_insert_index = min(original_indices)

    if not assignments and not created_topics:
        return 0

    assigned_by_topic: dict[str, list[str]] = {}
    for child_id, topic_id in assignments.items():
        assigned_by_topic.setdefault(topic_id, []).append(child_id)

    topic_lookup_items = created_topics + canvas_items

    def build_next_item(item: dict[str, Any]) -> dict[str, Any] | None:
        item_id = _safe_text(item.get("id"))
        if not item_id:
            return None
        if item_id in removed_topic_ids:
            return None
        next_item = copy.deepcopy(items_by_id.get(item_id, item))
        if item_id in assignments:
            next_item["parent_topic_id"] = assignments[item_id]
            next_item["parent_topic_source"] = "ai"
            next_item["parent_topic_locked"] = False
            next_item["manual_position"] = False
        if _is_canvas_topic_item(next_item):
            current_children = [
                child_id
                for child_id in _canvas_topic_leaf_child_ids({"canvas_items": topic_lookup_items}, item_id)
                if child_id not in removed_topic_ids
            ]
            next_children = _dedup_preserve(current_children + assigned_by_topic.get(item_id, []), limit=400)
            next_item["child_item_ids"] = next_children
            next_item.setdefault("topic_collapsed", True)
            if not bool(next_item.get("auto_summary_disabled")):
                raw_update = topic_updates.get(item_id)
                if raw_update:
                    if _safe_text(raw_update.get("title")):
                        next_item["title"] = _safe_text(raw_update.get("title"))
                    if _safe_text(raw_update.get("body")):
                        next_item["body"] = _safe_text(raw_update.get("body"))
                    raw_keywords = raw_update.get("keywords")
                    if isinstance(raw_keywords, list) and raw_keywords:
                        next_item["keywords"] = [_safe_text(value) for value in raw_keywords if _safe_text(value)][:6]
        return next_item

    next_items: list[dict[str, Any]] = []
    inserted_created_topics = False
    for index, item in enumerate(canvas_items):
        if created_topic_insert_index == index and not inserted_created_topics:
            for topic in created_topics:
                next_topic = build_next_item(topic)
                if next_topic:
                    next_items.append(next_topic)
            inserted_created_topics = True
        next_item = build_next_item(item)
        if next_item:
            next_items.append(next_item)

    if created_topics and not inserted_created_topics:
        for topic in created_topics:
            next_topic = build_next_item(topic)
            if next_topic:
                next_items.append(next_topic)

    workspace["canvas_items"] = next_items
    return len(assignments) + len(created_topics)


def _maybe_cluster_canvas_topic_nodes(workspace: dict[str, Any]) -> dict[str, Any]:
    target = _canvas_topic_cluster_target(workspace)
    changed = 0
    for _ in range(CANVAS_TOPIC_CLUSTER_MAX_PASSES_PER_JOB):
        pass_changed = 0
        agenda_ids = _dedup_preserve(
            [
                _safe_text(item.get("agenda_id"))
                for item in (workspace.get("canvas_items") or [])
                if isinstance(item, dict) and _safe_text(item.get("agenda_id"))
            ],
            limit=100,
        )
        for agenda_id in agenda_ids:
            top_level_items = _canvas_direct_child_items(workspace, agenda_id)
            if len(top_level_items) <= target:
                continue
            candidate_items = [
                item
                for item in top_level_items
                if _is_canvas_topic_clustering_candidate(item)
                and not bool(item.get("parent_topic_locked"))
            ]
            if len(candidate_items) < 1:
                continue
            if len(candidate_items) < 2:
                continue
            result = _compute_canvas_topic_clustering_result(
                workspace,
                agenda_id,
                top_level_items,
                candidate_items,
            )
            if not result:
                continue
            pass_changed += _apply_canvas_topic_clustering_result(workspace, agenda_id, result)
        changed += pass_changed
        if pass_changed <= 0:
            break
    return {"changed": changed, "target": target}


def _finalize_canvas_idea_workspace_job(
    meeting_id: str,
    job_id: str,
    pending_item_id: str,
    payload: CanvasIdeaAssimilationInput,
) -> None:
    try:
        result = _compute_idea_assimilation_result(payload)
        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        canvas_items = [
            copy.deepcopy(item)
            for item in (latest_workspace.get("canvas_items") or [])
            if isinstance(item, dict)
        ]
        pending_item = next((item for item in canvas_items if _safe_text(item.get("id")) == pending_item_id), None)
        base_items = [item for item in canvas_items if _safe_text(item.get("id")) != pending_item_id]
        target_ids = [_safe_text(item.id) for item in (payload.target_utterances or []) if _safe_text(item.id)]
        starting_create_stack = _canvas_idea_create_stack_value(latest_workspace)
        created_node_count = 0
        merged_update_count = 0
        clustering_result: dict[str, Any] = {"changed": 0, "target": _canvas_topic_cluster_target(latest_workspace)}
        topic_child_merge_result: dict[str, Any] = {
            "merged": 0,
            "threshold": CANVAS_TOPIC_CHILD_IDEA_MERGE_MIN_SCORE,
            "last_score": 0,
        }

        if not bool(result.get("used_llm")):
            positions = copy.deepcopy(latest_workspace.get("node_positions") or {})
            ideation_positions = dict(positions.get("ideation") or {})
            ideation_positions.pop(f"canvas-item-{pending_item_id}", None)
            positions["ideation"] = ideation_positions
            latest_workspace["canvas_items"] = base_items
            latest_workspace["node_positions"] = positions
            _save_canvas_workspace_runtime(meeting_id, latest_workspace)
            warning = _safe_text(result.get("warning"), "LLM 응답을 받지 못해 아이디어 노드를 생성하지 않았습니다.")
            _mark_canvas_idea_job(
                meeting_id,
                job_id,
                status="error",
                detail=warning,
                workspace=copy.deepcopy(latest_workspace),
                used_llm=False,
                warning=warning,
                failed_at_epoch=time.time(),
            )
            return

        updates = [
            update
            for update in (result.get("updates") or [])
            if isinstance(update, dict) and _safe_text(update.get("action")) in {"merge", "create"}
        ]
        items_by_id = {_safe_text(item.get("id")): item for item in base_items if _safe_text(item.get("id"))}
        guarded_updates: list[dict[str, Any]] = []
        for update in updates:
            if _safe_text(update.get("action")) != "merge":
                guarded_updates.append(update)
                continue
            target_item = items_by_id.get(_safe_text(update.get("targetIdeaId")))
            if target_item and _idea_update_merge_allowed(target_item, update):
                guarded_updates.append(update)
                continue
            guarded_updates.append({**update, "action": "create", "targetIdeaId": ""})
        updates = guarded_updates

        if not updates:
            latest_workspace["canvas_items"] = base_items
            positions = copy.deepcopy(latest_workspace.get("node_positions") or {})
            ideation_positions = dict(positions.get("ideation") or {})
            ideation_positions.pop(f"canvas-item-{pending_item_id}", None)
            positions["ideation"] = ideation_positions
            latest_workspace["node_positions"] = positions
            latest_workspace["idea_processed_utterance_ids"] = _dedup_preserve(
                list(latest_workspace.get("idea_processed_utterance_ids") or []) + target_ids,
                limit=1000,
            )
        else:
            next_items = list(base_items)
            create_updates = [update for update in updates if _safe_text(update.get("action")) == "create"]
            merge_updates = [update for update in updates if _safe_text(update.get("action")) == "merge"]
            merged_update_count = len(merge_updates)
            for update in updates:
                if _safe_text(update.get("action")) != "merge":
                    continue
                target_id = _safe_text(update.get("targetIdeaId"))
                next_items = [
                    _apply_idea_update_to_canvas_item(item, update)
                    if _safe_text(item.get("id")) == target_id
                    else item
                    for item in next_items
                ]

            for create_index, update in enumerate(create_updates):
                if create_index == 0 and isinstance(pending_item, dict):
                    created_id = pending_item_id
                    created_item = _apply_idea_update_to_canvas_item(pending_item, update)
                else:
                    created_id = f"ai-idea-{int(time.time() * 1000)}-{create_index}-{uuid4().hex[:6]}"
                    created_item = _apply_idea_update_to_canvas_item(
                        {
                            "id": created_id,
                            "agenda_id": _safe_text(getattr(payload, "selected_agenda_id", "")),
                            "point_id": "",
                            "kind": "note",
                            "title": "AI 아이디어",
                            "body": "",
                            "keywords": [],
                            "key_evidence": [],
                            "refined_utterances": [],
                            "evidence_utterance_ids": [],
                            "ignored_utterance_ids": [],
                            "merged_children": [],
                            "compacted_from_ids": [],
                            "compaction_level": 0,
                            "parent_topic_id": "",
                            "parent_topic_source": "",
                            "parent_topic_locked": False,
                            "child_item_ids": [],
                            "topic_collapsed": False,
                            "created_by": "ai",
                            "manual_position": False,
                            "ai_generated": True,
                            "user_edited": False,
                            "ai_pending": False,
                        },
                        update,
                    )
                next_items.append(created_item)

            created_node_count = len(create_updates)
            if not create_updates and isinstance(pending_item, dict):
                positions = copy.deepcopy(latest_workspace.get("node_positions") or {})
                ideation_positions = dict(positions.get("ideation") or {})
                ideation_positions.pop(f"canvas-item-{pending_item_id}", None)
                positions["ideation"] = ideation_positions
                latest_workspace["node_positions"] = positions

            latest_workspace["canvas_items"] = next_items
            latest_workspace["idea_processed_utterance_ids"] = _dedup_preserve(
                list(latest_workspace.get("idea_processed_utterance_ids") or []) + target_ids,
                limit=1000,
            )
            if created_node_count > 0:
                latest_workspace["idea_create_stack"] = starting_create_stack + created_node_count

        if created_node_count > 0:
            clustering_result = _maybe_cluster_canvas_topic_nodes(latest_workspace)
            topic_child_merge_result = _maybe_merge_similar_topic_child_ideas(latest_workspace)

        previous_operation_ids = {
            _safe_text(entry.get("operation_id"))
            for entry in _normalize_canvas_operation_log(latest_workspace.get("operation_log"))
            if _safe_text(entry.get("operation_id"))
        }
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)
        clustered_count = _safe_nonnegative_int(clustering_result.get("changed"))
        merged_child_count = _safe_nonnegative_int(topic_child_merge_result.get("merged"))
        detail = (
            f"AI 아이디어 정리 완료 · {clustered_count}개 topic 분류, {merged_child_count}개 유사 아이디어 병합"
            if clustered_count > 0 and merged_child_count > 0
            else f"AI 아이디어 정리 완료 · {clustered_count}개 topic 분류 반영"
            if clustered_count > 0
            else f"AI 아이디어 정리 완료 · {merged_child_count}개 유사 아이디어 병합"
            if merged_child_count > 0
            else "AI 아이디어 정리 완료"
        )
        activity_parts = []
        if created_node_count > 0:
            activity_parts.append(f"아이디어 {created_node_count}개 생성")
        if merged_update_count > 0:
            activity_parts.append(f"기존 아이디어 {merged_update_count}개 병합")
        if clustered_count > 0:
            activity_parts.append(f"토픽 분류 {clustered_count}건")
        if merged_child_count > 0:
            activity_parts.append(f"유사 아이디어 {merged_child_count}건 병합")
        activity_line = " · ".join(activity_parts) if activity_parts else "새 발화 확인"
        activity_events = _canvas_activity_events_from_new_operations(latest_workspace, previous_operation_ids)
        activity_line = _canvas_activity_line_from_activity_events(activity_events, activity_line)
        _mark_canvas_idea_job(
            meeting_id,
            job_id,
            status="completed",
            activity_line=activity_line,
            activity_events=activity_events,
            detail=detail,
            workspace=copy.deepcopy(latest_workspace),
            used_llm=bool(result.get("used_llm")),
            warning=_safe_text(result.get("warning")),
        )
    except Exception as exc:
        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        latest_workspace["canvas_items"] = [
            {**item, "ai_pending": False, "body": "AI 정리에 실패했습니다."}
            if isinstance(item, dict) and _safe_text(item.get("id")) == pending_item_id
            else item
            for item in (latest_workspace.get("canvas_items") or [])
        ]
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)
        _mark_canvas_idea_job(
            meeting_id,
            job_id,
            status="error",
            detail=f"AI 아이디어 정리 실패: {exc}",
            workspace=copy.deepcopy(latest_workspace),
            warning=_safe_text(exc),
            failed_at_epoch=time.time(),
        )


@app.post("/api/canvas/ideation/ideas/assimilate")
@app.post("/api/canvas/idea-assimilation-workspace/start")
def post_canvas_idea_assimilation_workspace_start(payload: CanvasIdeaAssimilationWorkspaceStartInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        running_job = next(
            (
                copy.deepcopy(job)
                for job in meeting_jobs.values()
                if isinstance(job, dict)
                and _safe_text(job.get("status")) == "processing"
                and _canvas_job_type(job) == "idea_assimilation"
            ),
            None,
        )
    if running_job:
        workspace = running_job.get("workspace") if isinstance(running_job.get("workspace"), dict) else _warm_canvas_workspace_cache(RT, normalized_meeting_id)
        return _canvas_idea_job_response(running_job, workspace)

    workspace = _clone_runtime_workspace_state(
        normalized_meeting_id,
        _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        _now_ts(),
    )
    processed_ids = _canvas_idea_processed_ids(workspace)
    now_epoch = time.time()
    cooling_failed_ids: set[str] = set()
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        for job in meeting_jobs.values():
            if not isinstance(job, dict) or _safe_text(job.get("status")) != "error":
                continue
            failed_at = float(job.get("failed_at_epoch") or 0)
            if now_epoch - failed_at >= CANVAS_IDEA_FAILURE_RETRY_DELAY_SECONDS:
                continue
            cooling_failed_ids.update(
                _safe_text(item)
                for item in _safe_text(job.get("target_signature")).split("|")
                if _safe_text(item)
            )
    target_rows = [
        item
        for item in (payload.target_utterances or [])
        if _safe_text(item.id)
        and _safe_text(item.text)
        and _safe_text(item.id) not in processed_ids
        and _safe_text(item.id) not in cooling_failed_ids
    ]
    target_text_length = sum(len(_strip_leading_timestamp(_safe_text(item.text))) for item in target_rows)
    if not target_rows or target_text_length < 40:
        cooling_count = len(cooling_failed_ids)
        wait_seconds = 0
        if cooling_count > 0:
            with RT.lock:
                active_failed_at = [
                    float(job.get("failed_at_epoch") or 0)
                    for job in RT.canvas_idea_jobs_by_meeting.get(normalized_meeting_id, {}).values()
                    if isinstance(job, dict)
                    and _safe_text(job.get("status")) == "error"
                    and now_epoch - float(job.get("failed_at_epoch") or 0) < CANVAS_IDEA_FAILURE_RETRY_DELAY_SECONDS
                ]
            if active_failed_at:
                wait_seconds = max(
                    1,
                    int(CANVAS_IDEA_FAILURE_RETRY_DELAY_SECONDS - (now_epoch - max(active_failed_at))),
                )
        job = {
            "job_id": "",
            "meeting_id": normalized_meeting_id,
            "status": "idle",
            "detail": (
                f"이전 LLM 실패 발화 재요청 대기 중 · {wait_seconds}초"
                if wait_seconds > 0 and not target_rows
                else f"아이디어 정리 대기 중 · {len(target_rows)}개 발화"
            ),
            "target_count": len(target_rows),
            "updated_at": _now_ts(),
        }
        return _canvas_idea_job_response(job, workspace)

    target_signature = "|".join([_safe_text(item.id) for item in target_rows if _safe_text(item.id)])
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        failed_same_target_jobs = [
            copy.deepcopy(job)
            for job in meeting_jobs.values()
            if isinstance(job, dict)
            and _safe_text(job.get("status")) == "error"
            and _safe_text(job.get("target_signature")) == target_signature
        ]
    if failed_same_target_jobs:
        latest_failed_job = max(
            failed_same_target_jobs,
            key=lambda job: float(job.get("failed_at_epoch") or 0),
        )
        retry_after = CANVAS_IDEA_FAILURE_RETRY_DELAY_SECONDS - (
            now_epoch - float(latest_failed_job.get("failed_at_epoch") or 0)
        )
        if retry_after > 0:
            retry_seconds = max(1, int(retry_after))
            job = {
                "job_id": _safe_text(latest_failed_job.get("job_id")),
                "meeting_id": normalized_meeting_id,
                "status": "error",
                "detail": f"이전 LLM 실패로 같은 발화 재요청 대기 중 · {retry_seconds}초",
                "warning": _safe_text(latest_failed_job.get("warning") or latest_failed_job.get("detail")),
                "target_count": len(target_rows),
                "target_signature": target_signature,
                "updated_at": _now_ts(),
            }
            return _canvas_idea_job_response(job, workspace)

    job_id = uuid4().hex
    pending_item_id = f"ai-idea-pending-{job_id[:10]}"
    canvas_items = [
        copy.deepcopy(item)
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    pending_item = {
        "id": pending_item_id,
        "agenda_id": _safe_text(payload.selected_agenda_id),
        "point_id": "",
        "kind": "note",
        "title": "AI 정리 중",
        "body": "",
        "keywords": [],
        "key_evidence": [],
        "refined_utterances": [],
        "evidence_utterance_ids": [_safe_text(item.id) for item in target_rows if _safe_text(item.id)][:400],
        "ignored_utterance_ids": [],
        "merged_children": [],
        "compacted_from_ids": [],
        "compaction_level": 0,
        "parent_topic_id": "",
        "parent_topic_source": "",
        "parent_topic_locked": False,
        "child_item_ids": [],
        "topic_collapsed": False,
        "created_by": "ai",
        "manual_position": False,
        "ai_generated": True,
        "user_edited": False,
        "ai_pending": True,
    }
    workspace["canvas_items"] = [*canvas_items, pending_item]
    workspace["node_positions"] = _normalize_canvas_node_positions(workspace.get("node_positions") or {})
    _save_canvas_workspace_runtime(normalized_meeting_id, workspace)

    idea_payload = CanvasIdeaAssimilationInput(
        meeting_id=normalized_meeting_id,
        meeting_topic=_safe_text(payload.meeting_topic, "회의 주제"),
        selected_agenda_id=_safe_text(payload.selected_agenda_id),
        context_utterances=payload.context_utterances,
        target_utterances=target_rows,
        existing_ideas=_canvas_idea_existing_ideas_from_workspace(
            workspace,
            pending_item_id,
            payload.selected_agenda_id,
        ),
    )
    job = _mark_canvas_idea_job(
        normalized_meeting_id,
        job_id,
        task_type="ideation.assimilate",
        job_type="idea_assimilation",
        scope_key="idea_assimilation",
        status="processing",
        detail="AI가 키워드와 content를 생성 중",
        pending_item_id=pending_item_id,
        target_count=len(target_rows),
        target_signature=target_signature,
        created_at=_now_ts(),
        created_epoch=time.time(),
        workspace=copy.deepcopy(workspace),
    )
    _start_canvas_task_worker(
        "ideation.assimilate",
        job_id,
        _finalize_canvas_idea_workspace_job,
        (normalized_meeting_id, job_id, pending_item_id, idea_payload),
    )
    return _canvas_idea_job_response(job, workspace)


@app.post("/api/canvas/ideation/topics/summarize")
@app.post("/api/canvas/topic-summary-workspace/start")
def post_canvas_topic_summary_workspace_start(payload: CanvasTopicSummaryWorkspaceStartInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    topic_item_id = _safe_text(payload.topic_item_id)
    if not normalized_meeting_id or not topic_item_id:
        raise HTTPException(status_code=400, detail="meeting_id and topic_item_id are required")

    workspace = _clone_runtime_workspace_state(
        normalized_meeting_id,
        _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        _now_ts(),
    )
    canvas_items = [
        copy.deepcopy(item)
        for item in (workspace.get("canvas_items") or [])
        if isinstance(item, dict)
    ]
    topic = next((item for item in canvas_items if _safe_text(item.get("id")) == topic_item_id), None)
    if not topic or not _is_canvas_topic_item(topic):
        missing_state = _canvas_missing_topic_summary_state(workspace, topic_item_id)
        job = {
            "job_id": "",
            "meeting_id": normalized_meeting_id,
            "job_type": "topic_summary",
            "scope_key": topic_item_id,
            "status": "stale_obsolete",
            "stale_reason": _safe_text(missing_state.get("stale_reason"), "obsolete"),
            "retryable": False,
            "detail": _safe_text(missing_state.get("detail")),
            "pending_item_id": topic_item_id,
            "resolved_node_id": _safe_text(missing_state.get("resolved_node_id")),
            "updated_at": _now_ts(),
        }
        return _canvas_idea_job_response(job, workspace)

    target_signature = _canvas_topic_summary_signature(workspace, topic_item_id)
    with RT.lock:
        meeting_jobs = RT.canvas_idea_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        running_job = next(
            (
                copy.deepcopy(job)
                for job in meeting_jobs.values()
                if isinstance(job, dict)
                and _safe_text(job.get("status")) == "processing"
                and _safe_text(job.get("job_type")) == "topic_summary"
                and _safe_text(job.get("pending_item_id")) == topic_item_id
                and _safe_text(job.get("target_signature")) == target_signature
            ),
            None,
        )
    if running_job:
        workspace = running_job.get("workspace") if isinstance(running_job.get("workspace"), dict) else _warm_canvas_workspace_cache(RT, normalized_meeting_id)
        return _canvas_idea_job_response(running_job, workspace)

    workspace["canvas_items"] = [
        {
            **item,
            "ai_pending": True,
            "ai_generated": True,
            "user_edited": bool(item.get("user_edited")),
        }
        if _safe_text(item.get("id")) == topic_item_id
        else item
        for item in canvas_items
    ]
    workspace["node_positions"] = _normalize_canvas_node_positions(workspace.get("node_positions") or {})
    _save_canvas_workspace_runtime(normalized_meeting_id, workspace)
    _supersede_processing_canvas_idea_scope_jobs(
        normalized_meeting_id,
        "topic_summary",
        topic_item_id,
        target_signature,
        workspace,
    )

    job_id = uuid4().hex
    job = _mark_canvas_idea_job(
        normalized_meeting_id,
        job_id,
        task_type="ideation.topic_summary",
        job_type="topic_summary",
        scope_key=topic_item_id,
        status="processing",
        detail="AI가 topic 제목과 content를 생성 중",
        pending_item_id=topic_item_id,
        target_count=len(_canvas_topic_leaf_child_ids(workspace, topic_item_id)),
        target_signature=target_signature,
        meeting_topic=_safe_text(payload.meeting_topic, "회의 주제"),
        retry_count=0,
        created_at=_now_ts(),
        created_epoch=time.time(),
        workspace=copy.deepcopy(workspace),
    )
    _start_canvas_task_worker(
        "ideation.topic_summary",
        job_id,
        _finalize_canvas_topic_summary_workspace_job,
        (normalized_meeting_id, job_id, topic_item_id, _safe_text(payload.meeting_topic, "회의 주제")),
    )
    return _canvas_idea_job_response(job, workspace)


@app.get("/api/canvas/ideation/jobs/{job_id}")
@app.get("/api/canvas/idea-assimilation-workspace/jobs/{job_id}")
def get_canvas_idea_assimilation_workspace_job(job_id: str, meeting_id: str):
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_job_id = _safe_text(job_id)
    if not normalized_meeting_id or not normalized_job_id:
        raise HTTPException(status_code=400, detail="meeting_id and job_id are required")
    with RT.lock:
        job = copy.deepcopy(
            (RT.canvas_idea_jobs_by_meeting.get(normalized_meeting_id) or {}).get(normalized_job_id) or {}
        )
    if not job:
        return _canvas_idea_job_response(
            {
                "job_id": normalized_job_id,
                "meeting_id": normalized_meeting_id,
                "status": "missing",
                "detail": "작업 정보를 찾을 수 없습니다.",
                "updated_at": _now_ts(),
            },
            _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        )
    workspace = job.get("workspace") if isinstance(job.get("workspace"), dict) else _warm_canvas_workspace_cache(RT, normalized_meeting_id)
    return _canvas_idea_job_response(job, workspace)


def _finalize_canvas_problem_discussion_workspace_job(
    meeting_id: str,
    job_id: str,
    group_id: str,
    pending_item_id: str,
    payload: CanvasProblemDiscussionWorkspaceStartInput,
) -> None:
    try:
        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        groups = [
            copy.deepcopy(group)
            for group in (latest_workspace.get("problem_groups") or [])
            if isinstance(group, dict)
        ]
        target_group = next((group for group in groups if _safe_text(group.get("group_id")) == group_id), None)
        if not target_group:
            raise RuntimeError("선택된 문제정의 그룹을 찾을 수 없습니다.")

        result = _compute_problem_discussion_result(payload, target_group)
        target_ids = [_safe_text(item.id) for item in (payload.target_utterances or []) if _safe_text(item.id)]
        if not bool(result.get("ok")):
            warning = _safe_text(result.get("warning"), "문제정의 의견 LLM 응답을 받지 못했습니다.")
            next_groups = []
            for group in groups:
                group = copy.deepcopy(group)
                group["discussion_items"] = [
                    item
                    for item in (group.get("discussion_items") or [])
                    if isinstance(item, dict) and _safe_text(item.get("id")) != pending_item_id
                ]
                next_groups.append(group)
            latest_workspace["problem_groups"] = next_groups
            _save_canvas_workspace_runtime(meeting_id, latest_workspace)
            _mark_canvas_problem_job(
                meeting_id,
                job_id,
                status="error",
                detail=warning,
                workspace=copy.deepcopy(latest_workspace),
                used_llm=bool(result.get("used_llm")),
                warning=warning,
                failed_at_epoch=time.time(),
            )
            return

        update = result.get("update") if isinstance(result.get("update"), dict) else {}
        next_groups = []
        found_pending = False
        for group in groups:
            group = copy.deepcopy(group)
            next_discussions = []
            for item in group.get("discussion_items") or []:
                if not isinstance(item, dict):
                    continue
                if _safe_text(item.get("id")) != pending_item_id:
                    next_discussions.append(item)
                    continue
                found_pending = True
                next_discussions.append(
                    {
                        **item,
                        "target_node_id": _safe_text(item.get("target_node_id")),
                        "target_node_label": _safe_text(item.get("target_node_label")),
                        "target_node_kind": _safe_text(item.get("target_node_kind")),
                        "title": _safe_text(update.get("title"), "문제 의견"),
                        "body": _safe_text(update.get("body")),
                        "keywords": update.get("keywords") or [],
                        "key_evidence": update.get("key_evidence") or [],
                        "refined_utterances": update.get("refined_utterances") or [],
                        "evidence_utterance_ids": update.get("evidence_utterance_ids") or target_ids,
                        "ignored_utterance_ids": update.get("ignored_utterance_ids") or [],
                        "ai_pending": False,
                        "ai_generated": True,
                        "user_edited": False,
                    }
                )
            group["discussion_items"] = next_discussions
            next_groups.append(group)
        if not found_pending:
            fallback_group_id = group_id
            next_groups = [
                {
                    **group,
                    "discussion_items": [
                        *(group.get("discussion_items") or []),
                        {
                            "id": pending_item_id,
                            "parent_group_id": fallback_group_id,
                            "target_node_id": "",
                            "target_node_label": "",
                            "target_node_kind": "",
                            "title": _safe_text(update.get("title"), "문제 의견"),
                            "body": _safe_text(update.get("body")),
                            "keywords": update.get("keywords") or [],
                            "key_evidence": update.get("key_evidence") or [],
                            "refined_utterances": update.get("refined_utterances") or [],
                            "evidence_utterance_ids": update.get("evidence_utterance_ids") or target_ids,
                            "ignored_utterance_ids": update.get("ignored_utterance_ids") or [],
                            "ai_pending": False,
                            "ai_generated": True,
                            "user_edited": False,
                            "created_by": "ai",
                            "created_at": _now_ts(),
                        },
                    ],
                }
                if _safe_text(group.get("group_id")) == fallback_group_id
                else group
                for group in next_groups
            ]

        latest_workspace["problem_groups"] = next_groups
        latest_workspace["problem_processed_utterance_ids"] = _dedup_preserve(
            list(latest_workspace.get("problem_processed_utterance_ids") or []) + target_ids,
            limit=1000,
        )
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)
        _mark_canvas_problem_job(
            meeting_id,
            job_id,
            status="completed",
            detail="AI 문제정의 의견 정리 완료",
            workspace=copy.deepcopy(latest_workspace),
            used_llm=bool(result.get("used_llm")),
            warning=_safe_text(result.get("warning")),
        )
    except Exception as exc:
        latest_workspace = _clone_runtime_workspace_state(
            meeting_id,
            _warm_canvas_workspace_cache(RT, meeting_id),
            _now_ts(),
        )
        latest_workspace["problem_groups"] = [
            {
                **group,
                "discussion_items": [
                    item
                    for item in (group.get("discussion_items") or [])
                    if isinstance(item, dict) and _safe_text(item.get("id")) != pending_item_id
                ],
            }
            if isinstance(group, dict)
            else group
            for group in (latest_workspace.get("problem_groups") or [])
        ]
        _save_canvas_workspace_runtime(meeting_id, latest_workspace)
        _mark_canvas_problem_job(
            meeting_id,
            job_id,
            status="error",
            detail=f"문제정의 의견 정리 실패: {exc}",
            workspace=copy.deepcopy(latest_workspace),
            warning=_safe_text(exc),
            failed_at_epoch=time.time(),
        )


@app.post("/api/canvas/problem/discussions/assimilate")
@app.post("/api/canvas/problem-discussion-workspace/start")
def post_canvas_problem_discussion_workspace_start(payload: CanvasProblemDiscussionWorkspaceStartInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    workspace = _clone_runtime_workspace_state(
        normalized_meeting_id,
        _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        _now_ts(),
    )
    groups = [
        copy.deepcopy(group)
        for group in (workspace.get("problem_groups") or [])
        if isinstance(group, dict)
    ]
    if not groups:
        job = {
            "job_id": "",
            "meeting_id": normalized_meeting_id,
            "status": "idle",
            "detail": "문제정의 그룹이 없어 의견 정리를 대기합니다.",
            "updated_at": _now_ts(),
        }
        return _canvas_problem_job_response(job, workspace)

    selected_group_id = _safe_text(payload.selected_group_id) or _safe_text(groups[0].get("group_id"))
    selected_group = next((group for group in groups if _safe_text(group.get("group_id")) == selected_group_id), groups[0])
    selected_group_id = _safe_text(selected_group.get("group_id"))
    processed_ids = _canvas_problem_processed_ids(workspace)
    target_rows = [
        item
        for item in (payload.target_utterances or [])
        if _safe_text(item.id) and _safe_text(item.text) and _safe_text(item.id) not in processed_ids
    ]
    target_text_length = sum(len(_strip_leading_timestamp(_safe_text(item.text))) for item in target_rows)
    if not target_rows or target_text_length < 30:
        job = {
            "job_id": "",
            "meeting_id": normalized_meeting_id,
            "status": "idle",
            "detail": f"문제정의 의견 정리 대기 중 · {len(target_rows)}개 발화",
            "target_count": len(target_rows),
            "updated_at": _now_ts(),
        }
        return _canvas_problem_job_response(job, workspace)

    with RT.lock:
        meeting_jobs = RT.canvas_problem_jobs_by_meeting.setdefault(normalized_meeting_id, {})
        running_job = next(
            (
                copy.deepcopy(job)
                for job in meeting_jobs.values()
                if isinstance(job, dict) and _safe_text(job.get("status")) == "processing"
            ),
            None,
        )
    if running_job:
        job_workspace = running_job.get("workspace") if isinstance(running_job.get("workspace"), dict) else workspace
        return _canvas_problem_job_response(running_job, job_workspace)

    job_id = uuid4().hex
    pending_item_id = f"ai-problem-note-{job_id[:10]}"
    pending_item = {
        "id": pending_item_id,
        "parent_group_id": selected_group_id,
        "target_node_id": "",
        "target_node_label": "",
        "target_node_kind": "",
        "title": "의견 정리 중",
        "body": "",
        "keywords": [],
        "key_evidence": [],
        "refined_utterances": [],
        "evidence_utterance_ids": [_safe_text(item.id) for item in target_rows if _safe_text(item.id)][:400],
        "ignored_utterance_ids": [],
        "ai_pending": True,
        "ai_generated": True,
        "user_edited": False,
        "created_by": "ai",
        "created_at": _now_ts(),
    }

    next_groups = []
    for group in groups:
        if _safe_text(group.get("group_id")) == selected_group_id:
            group = copy.deepcopy(group)
            group["discussion_items"] = [*(group.get("discussion_items") or []), pending_item]
        next_groups.append(group)
    workspace["problem_groups"] = next_groups
    _save_canvas_workspace_runtime(normalized_meeting_id, workspace)

    discussion_payload = CanvasProblemDiscussionWorkspaceStartInput(
        meeting_id=normalized_meeting_id,
        meeting_topic=_safe_text(payload.meeting_topic, "회의 주제"),
        selected_group_id=selected_group_id,
        context_utterances=payload.context_utterances,
        target_utterances=target_rows,
    )
    target_signature = "|".join([_safe_text(item.id) for item in target_rows if _safe_text(item.id)])
    job = _mark_canvas_problem_job(
        normalized_meeting_id,
        job_id,
        task_type="problem.discussion",
        status="processing",
        detail="AI가 문제정의 의견을 생성 중",
        pending_item_id=pending_item_id,
        target_count=len(target_rows),
        target_signature=target_signature,
        created_at=_now_ts(),
        workspace=copy.deepcopy(workspace),
    )
    _start_canvas_task_worker(
        "problem.discussion",
        job_id,
        _finalize_canvas_problem_discussion_workspace_job,
        (normalized_meeting_id, job_id, selected_group_id, pending_item_id, discussion_payload),
    )
    return _canvas_problem_job_response(job, workspace)


@app.get("/api/canvas/problem/jobs/{job_id}")
@app.get("/api/canvas/problem-discussion-workspace/jobs/{job_id}")
def get_canvas_problem_discussion_workspace_job(job_id: str, meeting_id: str):
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_job_id = _safe_text(job_id)
    if not normalized_meeting_id or not normalized_job_id:
        raise HTTPException(status_code=400, detail="meeting_id and job_id are required")
    with RT.lock:
        job = copy.deepcopy(
            (RT.canvas_problem_jobs_by_meeting.get(normalized_meeting_id) or {}).get(normalized_job_id) or {}
        )
    if not job:
        return _canvas_problem_job_response(
            {
                "job_id": normalized_job_id,
                "meeting_id": normalized_meeting_id,
                "status": "missing",
                "detail": "작업 정보를 찾을 수 없습니다.",
                "updated_at": _now_ts(),
            },
            _warm_canvas_workspace_cache(RT, normalized_meeting_id),
        )
    workspace = job.get("workspace") if isinstance(job.get("workspace"), dict) else _warm_canvas_workspace_cache(RT, normalized_meeting_id)
    return _canvas_problem_job_response(job, workspace)


@app.post("/api/canvas/problem/groups/generate")
@app.post("/api/canvas/problem-definition")
def post_canvas_problem_definition(payload: ProblemDefinitionGenerateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    normalized_source_group_id = _safe_text(payload.source_group_id) or "all"
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        groups = _build_problem_definition_groups_local(payload)
        used_llm = False
        warning = ""

        if groups:
            client, llm_ready, llm_note = _ensure_llm_ready(RT)
            if llm_ready:
                try:
                    prompt = _build_problem_definition_prompt(payload.topic, groups)
                    parsed = _call_llm_json(
                        RT,
                        client,
                        prompt=prompt,
                        stage="canvas_problem_definition",
                        temperature=0.2,
                        max_tokens=1200,
                    )
                    parsed_groups = parsed.get("groups") if isinstance(parsed, dict) else None
                    if isinstance(parsed_groups, list):
                        groups = _materialize_problem_definition_groups_from_llm(groups, parsed_groups)
                        used_llm = True
                        RT.last_llm_parsed_json = {
                            "stage": "canvas_problem_definition",
                            "groups": copy.deepcopy(groups),
                        }
                        RT.last_llm_parsed_at = _now_ts()
                    else:
                        warning = "LLM JSON 형식이 예상과 달라 로컬 결과를 사용했습니다."
                except Exception as exc:
                    warning = f"문제 정의 LLM 생성 실패: {exc}"
            else:
                warning = llm_note or "LLM 미연결 상태로 로컬 문제 정의 묶음을 사용했습니다."

        return {
            "ok": True,
            "used_llm": used_llm,
            "warning": warning,
            "generated_at": _now_ts(),
            "groups": groups,
        }
    return _run_canvas_task_cached_request(
        RT,
        "problem.definition",
        normalized_meeting_id,
        f"problem_definition:{normalized_source_group_id}",
        signature,
        _compute,
    )


@app.post("/api/canvas/problem/groups/conclusion")
@app.post("/api/canvas/problem-conclusion")
def post_canvas_problem_conclusion(payload: ProblemConclusionGenerateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    group_id = _safe_text(payload.group.group_id)
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        conclusion = _build_problem_group_conclusion_local(payload)
        insight_lens = _build_problem_group_insight_lens_local(payload)
        used_llm = False
        warning = ""

        client, llm_ready, llm_note = _ensure_llm_ready(RT)
        if llm_ready:
            try:
                parsed = _call_llm_json(
                    RT,
                    client,
                    prompt=_build_problem_group_conclusion_prompt(payload),
                    stage="canvas_problem_conclusion",
                    temperature=0.2,
                    max_tokens=260,
                )
                candidate = _safe_text(parsed.get("conclusion")) if isinstance(parsed, dict) else ""
                candidate_lens = _safe_text(parsed.get("insight_lens")) if isinstance(parsed, dict) else ""
                if candidate:
                    conclusion = candidate
                    if candidate_lens:
                        insight_lens = candidate_lens
                    used_llm = True
                    RT.last_llm_parsed_json = {
                        "stage": "canvas_problem_conclusion",
                        "group_id": group_id,
                        "insight_lens": insight_lens,
                        "conclusion": conclusion,
                    }
                    RT.last_llm_parsed_at = _now_ts()
                else:
                    warning = "LLM JSON 형식이 예상과 달라 로컬 결론을 사용했습니다."
            except Exception as exc:
                warning = f"결론 LLM 생성 실패: {exc}"
        else:
            warning = llm_note or "LLM 미연결 상태로 로컬 결론을 사용했습니다."

        return {
            "ok": True,
            "used_llm": used_llm,
            "warning": warning,
            "generated_at": _now_ts(),
            "group_id": group_id,
            "insight_lens": insight_lens,
            "conclusion": conclusion,
        }
    return _run_canvas_task_cached_request(
        RT,
        "problem.conclusion",
        normalized_meeting_id,
        f"problem_conclusion:{group_id}",
        signature,
        _compute,
    )


@app.post("/api/canvas/meeting/goal")
@app.post("/api/canvas/meeting-goal")
def post_canvas_meeting_goal(payload: MeetingGoalGenerateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    topic = _safe_text(payload.topic)
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        goal = _build_meeting_goal_local(topic)
        goals = _build_meeting_goal_local_options(topic)
        used_llm = False
        warning = ""

        client, llm_ready, llm_note = _ensure_llm_ready(RT)
        if topic and llm_ready:
            try:
                parsed = _call_llm_json(
                    RT,
                    client,
                    prompt=_build_meeting_goal_prompt(topic),
                    stage="canvas_meeting_goal",
                    temperature=0.2,
                    max_tokens=420,
                )
                candidate = _safe_text(parsed.get("goal")) if isinstance(parsed, dict) else ""
                raw_goals = parsed.get("goals") if isinstance(parsed, dict) else []
                llm_goals = [
                    _safe_text(value)
                    for value in (raw_goals if isinstance(raw_goals, list) else [])
                    if _safe_text(value)
                ]
                if not candidate and llm_goals:
                    candidate = llm_goals[0]
                if candidate:
                    goals = _dedup_preserve([candidate, *llm_goals, *goals], limit=3)
                    goal = goals[0] if goals else candidate
                    used_llm = True
                    RT.last_llm_parsed_json = {
                        "stage": "canvas_meeting_goal",
                        "topic": topic,
                        "goal": goal,
                        "goals": goals,
                    }
                    RT.last_llm_parsed_at = _now_ts()
                else:
                    warning = "LLM JSON 형식이 예상과 달라 로컬 회의 목표를 사용했습니다."
            except Exception as exc:
                warning = f"회의 목표 LLM 생성 실패: {exc}"
        elif topic:
            warning = llm_note or "LLM 미연결 상태로 로컬 회의 목표를 사용했습니다."
        else:
            warning = "회의 제목이 없어 기본 회의 목표를 사용했습니다."

        return {
            "ok": True,
            "used_llm": used_llm,
            "warning": warning,
            "generated_at": _now_ts(),
            "topic": topic,
            "goal": goal,
            "goals": goals,
        }
    return _run_canvas_task_cached_request(
        RT,
        "meeting.goal",
        normalized_meeting_id,
        "meeting_goal",
        signature,
        _compute,
    )


@app.post("/api/canvas/solution/stage/generate")
@app.post("/api/canvas/solution-stage")
def post_canvas_solution_stage(payload: SolutionStageGenerateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        topics = [
            {
                "group_id": _safe_text(item.group_id),
                "topic_no": int(item.topic_no or 0),
                "topic": _safe_text(item.topic),
                "conclusion": _safe_text(item.conclusion),
                "ideas": [
                    f"{_safe_text(item.topic, '주제')} 관련 핵심 가설을 빠르게 검증할 실험안을 설계한다.",
                    f"{_safe_text(item.topic, '주제')}에 대한 사용자 반응을 비교할 시범안을 만든다.",
                ],
            }
            for item in (payload.topics or [])
            if _safe_text(item.topic)
        ]
        used_llm = False
        warning = ""

        if topics:
            client, llm_ready, llm_note = _ensure_llm_ready(RT)
            if llm_ready:
                try:
                    prompt = _build_solution_stage_prompt(payload.meeting_topic, topics)
                    parsed = _call_llm_json(
                        RT,
                        client,
                        prompt=prompt,
                        stage="canvas_solution_stage",
                        temperature=0.3,
                        max_tokens=1400,
                    )
                    parsed_topics = parsed.get("topics") if isinstance(parsed, dict) else None
                    if isinstance(parsed_topics, list):
                        by_id = {
                            _safe_text(item.get("group_id")): item
                            for item in parsed_topics
                            if isinstance(item, dict) and _safe_text(item.get("group_id"))
                        }
                        for topic in topics:
                            llm_item = by_id.get(_safe_text(topic.get("group_id")))
                            if not llm_item:
                                continue
                            llm_ideas = llm_item.get("ideas")
                            if isinstance(llm_ideas, list):
                                topic["ideas"] = [_safe_text(x) for x in llm_ideas if _safe_text(x)][:4]
                        used_llm = True
                        RT.last_llm_parsed_json = {
                            "stage": "canvas_solution_stage",
                            "topics": copy.deepcopy(topics),
                        }
                        RT.last_llm_parsed_at = _now_ts()
                    else:
                        warning = "LLM JSON 형식이 예상과 달라 로컬 해결책을 사용했습니다."
                except Exception as exc:
                    warning = f"해결책 단계 LLM 생성 실패: {exc}"
            else:
                warning = llm_note or "LLM 미연결 상태로 로컬 해결책 아이디어를 사용했습니다."

        return {
            "ok": True,
            "used_llm": used_llm,
            "warning": warning,
            "generated_at": _now_ts(),
            "topics": topics,
        }
    return _run_canvas_task_cached_request(
        RT,
        "solution.stage",
        normalized_meeting_id,
        "solution_stage",
        signature,
        _compute,
    )


@app.post("/api/canvas/ideation/suggestions/generate")
@app.post("/api/canvas/ideation-suggestions")
def post_canvas_ideation_suggestions(payload: IdeationSuggestionGenerateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    signature = _canvas_llm_signature(payload)

    def _compute() -> dict[str, Any]:
        suggestions = _build_local_ideation_suggestions(payload)
        used_llm = False
        warning = ""

        client, llm_ready, llm_note = _ensure_llm_ready(RT)
        if llm_ready:
            try:
                parsed = _call_llm_json(
                    RT,
                    client,
                    prompt=_build_ideation_suggestions_prompt(payload),
                    stage="canvas_ideation_suggestions",
                    temperature=0.35,
                    max_tokens=900,
                )
                parsed_suggestions = parsed.get("suggestions") if isinstance(parsed, dict) else None
                if isinstance(parsed_suggestions, list):
                    normalized = _normalize_canvas_ideation_suggestions(
                        [
                            {
                                "id": f"ideation-suggestion-{index + 1}",
                                "text": _safe_text(item.get("text") if isinstance(item, dict) else item),
                                "status": "draft",
                            }
                            for index, item in enumerate(parsed_suggestions)
                        ],
                        limit=5,
                    )
                    if normalized:
                        suggestions = normalized
                        used_llm = True
                        RT.last_llm_parsed_json = {
                            "stage": "canvas_ideation_suggestions",
                            "suggestions": copy.deepcopy(suggestions),
                        }
                        RT.last_llm_parsed_at = _now_ts()
                    else:
                        warning = "LLM 추천 결과가 비어 있어 로컬 추천을 사용했습니다."
                else:
                    warning = "LLM JSON 형식이 예상과 달라 로컬 추천을 사용했습니다."
            except Exception as exc:
                warning = f"아이디어 추천 LLM 생성 실패: {exc}"
        else:
            warning = llm_note or "LLM 미연결 상태로 로컬 추천을 사용했습니다."

        return {
            "ok": True,
            "used_llm": used_llm,
            "warning": warning,
            "generated_at": _now_ts(),
            "suggestions": suggestions,
        }

    return _run_canvas_task_cached_request(
        RT,
        "ideation.recommend",
        normalized_meeting_id,
        "ideation_suggestions",
        signature,
        _compute,
    )


@app.get("/api/canvas/personal-notes")
def get_canvas_personal_notes(meeting_id: str, user_id: str):
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_user_id = _safe_text(user_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")
    if not normalized_user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    loaded_notes, loaded_local_state = _load_canvas_personal_notes_from_db(
        normalized_meeting_id,
        normalized_user_id,
    )
    with RT.lock:
        meeting_notes = RT.canvas_personal_notes_by_meeting_user.setdefault(normalized_meeting_id, {})
        meeting_local_state = RT.canvas_local_state_by_meeting_user.setdefault(normalized_meeting_id, {})
        if loaded_notes is not None:
            meeting_notes[normalized_user_id] = copy.deepcopy(loaded_notes)
        if loaded_local_state is not None:
            meeting_local_state[normalized_user_id] = copy.deepcopy(loaded_local_state)
        personal_notes = copy.deepcopy(meeting_notes.get(normalized_user_id) or [])
        local_canvas_state = copy.deepcopy(meeting_local_state.get(normalized_user_id) or {})
        return {
            "ok": True,
            "meeting_id": normalized_meeting_id,
            "user_id": normalized_user_id,
            "personal_notes": personal_notes,
            "local_canvas_state": local_canvas_state,
            "saved_at": _safe_text((RT.canvas_workspace_by_meeting.get(normalized_meeting_id) or {}).get("saved_at")),
        }


@app.post("/api/canvas/personal-notes")
def post_canvas_personal_notes(payload: CanvasPersonalNotesStateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    normalized_user_id = _safe_text(payload.user_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")
    if not normalized_user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    saved_at = _now_ts()
    normalized_notes = [
        {
            "id": _safe_text(note.id),
            "project_id": _safe_text(note.project_id) or normalized_meeting_id,
            "agenda_id": _safe_text(note.agenda_id),
            "linked_canvas_item_id": _safe_text(note.linked_canvas_item_id),
            "linked_canvas_item_title": _safe_text(note.linked_canvas_item_title),
            "kind": _safe_text(note.kind, "note"),
            "title": _safe_text(note.title),
            "body": _safe_text(note.body),
        }
        for note in (payload.personal_notes or [])
        if _safe_text(note.id) or _safe_text(note.title) or _safe_text(note.body)
    ]
    normalized_local_canvas_state = _normalize_canvas_local_state(payload.local_canvas_state)

    with RT.lock:
        meeting_notes = RT.canvas_personal_notes_by_meeting_user.setdefault(normalized_meeting_id, {})
        meeting_local_state = RT.canvas_local_state_by_meeting_user.setdefault(normalized_meeting_id, {})
        meeting_notes[normalized_user_id] = copy.deepcopy(normalized_notes)
        meeting_local_state[normalized_user_id] = copy.deepcopy(normalized_local_canvas_state)

    _save_canvas_personal_notes_to_db(
        normalized_meeting_id,
        normalized_user_id,
        normalized_notes,
        normalized_local_canvas_state,
    )

    return {
        "ok": True,
        "meeting_id": normalized_meeting_id,
        "user_id": normalized_user_id,
        "personal_notes": copy.deepcopy(normalized_notes),
        "local_canvas_state": copy.deepcopy(normalized_local_canvas_state),
        "saved_at": saved_at,
    }


@app.get("/api/canvas/workspace-state")
def get_canvas_workspace_state(meeting_id: str):
    normalized_meeting_id = _safe_text(meeting_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    saved = _warm_canvas_workspace_cache(RT, normalized_meeting_id)
    print(
        "[canvas workspace GET]",
        {
            "meeting_id": normalized_meeting_id,
            "stage": _safe_text(saved.get("stage")),
            "canvas_items": len(saved.get("canvas_items") or []),
            "node_positions": _summarize_canvas_node_positions_for_debug(saved.get("node_positions")),
        },
    )
    return _canvas_workspace_response(saved)


@app.post("/api/canvas/workspace-state")
def post_canvas_workspace_state(payload: CanvasWorkspaceStateInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    saved_at = _now_ts()
    previous_workspace = _warm_canvas_workspace_cache(RT, normalized_meeting_id)
    workspace = _clone_runtime_workspace_state(normalized_meeting_id, previous_workspace, saved_at)
    workspace["meeting_goal"] = _safe_text(payload.meeting_goal)
    workspace["meeting_goal_context"] = _safe_text(payload.meeting_goal_context)
    workspace["stage"] = _normalize_canvas_stage(payload.stage)
    workspace["agenda_overrides"] = _normalize_canvas_agenda_overrides(payload.agenda_overrides)
    workspace["canvas_items"] = _normalize_canvas_workspace_items(payload.canvas_items)
    workspace["custom_groups"] = _normalize_canvas_custom_groups(payload.custom_groups)
    workspace["problem_groups"] = _normalize_canvas_workspace_problem_groups(payload.problem_groups)
    workspace["solution_topics"] = _normalize_canvas_workspace_solution_topics(payload.solution_topics)
    workspace["final_solution_summary"] = _normalize_canvas_final_solution_summary(payload.final_solution_summary)
    workspace["node_positions"] = _normalize_canvas_node_positions(payload.node_positions)
    workspace["imported_state"] = (
        copy.deepcopy(payload.imported_state) if isinstance(payload.imported_state, dict) else None
    )
    workspace = _append_canvas_operation_log_from_change(
        previous_workspace,
        workspace,
        source="workspace_state",
    )
    with RT.lock:
        RT.canvas_workspace_by_meeting[normalized_meeting_id] = copy.deepcopy(workspace)

    _save_canvas_workspace_to_db(normalized_meeting_id, workspace)
    print(
        "[canvas workspace PUT]",
        {
            "meeting_id": normalized_meeting_id,
            "meeting_goal": _safe_text(workspace.get("meeting_goal"))[:80],
            "meeting_goal_context": _safe_text(workspace.get("meeting_goal_context"))[:80],
            "stage": _safe_text(workspace.get("stage")),
            "canvas_items": len(workspace.get("canvas_items") or []),
            "custom_groups": len(workspace.get("custom_groups") or []),
            "final_solution_count": int((workspace.get("final_solution_summary") or {}).get("final_count") or 0),
            "node_positions": _summarize_canvas_node_positions_for_debug(workspace.get("node_positions")),
        },
    )

    return _canvas_workspace_response(workspace)


@app.post("/api/canvas/workspace-patch")
def post_canvas_workspace_patch(payload: CanvasWorkspacePatchInput):
    normalized_meeting_id = _safe_text(payload.meeting_id)
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    saved_at = _now_ts()
    previous_workspace = _warm_canvas_workspace_cache(RT, normalized_meeting_id)
    workspace = _clone_runtime_workspace_state(normalized_meeting_id, previous_workspace, saved_at)
    provided_fields = set(getattr(payload, "model_fields_set", set()))

    if "meeting_goal" in provided_fields:
        workspace["meeting_goal"] = _safe_text(payload.meeting_goal)
    if "meeting_goal_context" in provided_fields:
        workspace["meeting_goal_context"] = _safe_text(payload.meeting_goal_context)
    if "stage" in provided_fields:
        workspace["stage"] = _normalize_canvas_stage(payload.stage)
    if "agenda_overrides" in provided_fields:
        workspace["agenda_overrides"] = _normalize_canvas_agenda_overrides(payload.agenda_overrides)
    if "canvas_items" in provided_fields:
        workspace["canvas_items"] = _normalize_canvas_workspace_items(payload.canvas_items)
    if "custom_groups" in provided_fields:
        workspace["custom_groups"] = _normalize_canvas_custom_groups(payload.custom_groups)
    if "problem_groups" in provided_fields:
        workspace["problem_groups"] = _normalize_canvas_workspace_problem_groups(payload.problem_groups)
    if "solution_topics" in provided_fields:
        workspace["solution_topics"] = _normalize_canvas_workspace_solution_topics(payload.solution_topics)
    if "final_solution_summary" in provided_fields:
        workspace["final_solution_summary"] = _normalize_canvas_final_solution_summary(
            payload.final_solution_summary
        )
    if "node_positions" in provided_fields:
        workspace["node_positions"] = _normalize_canvas_node_positions(payload.node_positions or {})
    if "imported_state" in provided_fields:
        workspace["imported_state"] = (
            copy.deepcopy(payload.imported_state) if isinstance(payload.imported_state, dict) else None
        )

    workspace = _append_canvas_operation_log_from_change(
        previous_workspace,
        workspace,
        source="workspace_patch",
    )
    with RT.lock:
        RT.canvas_workspace_by_meeting[normalized_meeting_id] = copy.deepcopy(workspace)

    _save_canvas_workspace_to_db(normalized_meeting_id, workspace)
    print(
        "[canvas workspace PATCH]",
        {
            "meeting_id": normalized_meeting_id,
            "fields": sorted(list(provided_fields)),
            "meeting_goal": _safe_text(workspace.get("meeting_goal"))[:80],
            "meeting_goal_context": _safe_text(workspace.get("meeting_goal_context"))[:80],
            "stage": _safe_text(workspace.get("stage")),
            "canvas_items": len(workspace.get("canvas_items") or []),
            "custom_groups": len(workspace.get("custom_groups") or []),
            "node_positions": _summarize_canvas_node_positions_for_debug(workspace.get("node_positions")),
        },
    )
    return _canvas_workspace_response(workspace)


@app.get("/api/export/agenda-markdown")
def get_export_agenda_markdown():
    with RT.lock:
        markdown = _build_agenda_markdown(RT)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        return {
            "ok": True,
            "filename": f"agenda_export_{stamp}.md",
            "agenda_count": len(RT.agenda_outcomes),
            "transcript_count": len(RT.transcript),
            "markdown": markdown,
        }


@app.get("/api/export/agenda-snapshot")
def get_export_agenda_snapshot():
    with RT.lock:
        snapshot = _build_agenda_snapshot(RT)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        return {
            "ok": True,
            "filename": f"agenda_snapshot_{stamp}.json",
            "agenda_count": len(RT.agenda_outcomes),
            "transcript_count": len(RT.transcript),
            "snapshot": snapshot,
        }


@app.post("/api/import/agenda-snapshot")
async def post_import_agenda_snapshot(
    file: UploadFile = File(...),
    reset_state: str = Form(default="true"),
):
    raw = await file.read()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"스냅샷 JSON 파싱 실패: {exc}") from exc

    with RT.lock:
        try:
            loaded = _load_agenda_snapshot(RT, payload, reset_state=_boolify(reset_state, True))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"스냅샷 복원 실패: {exc}") from exc
        return {
            "ok": True,
            "state": _state_response(RT),
            "import_debug": {
                "filename": _safe_text(getattr(file, "filename", ""), "agenda_snapshot.json"),
                "meeting_goal": loaded["meeting_goal"],
                "transcript_count": int(loaded["transcript_count"]),
                "agenda_count": int(loaded["agenda_count"]),
                "reset_state": _boolify(reset_state, True),
            },
        }


@app.post("/api/import/audio-file/start")
async def post_import_audio_file_start(
    file: UploadFile = File(...),
    meeting_id: str = Form(...),
    user_id: str = Form(...),
    meeting_goal: str = Form(default=""),
    reset_state: str = Form(default="true"),
    window_size: str = Form(default="12"),
):
    normalized_meeting_id = _safe_text(meeting_id)
    normalized_user_id = _safe_text(user_id)
    filename = _safe_text(getattr(file, "filename", ""), "audio")
    suffix = Path(filename).suffix.lower()
    if not normalized_meeting_id:
        raise HTTPException(status_code=400, detail="meeting_id is required")
    if not normalized_user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if suffix not in AUDIO_IMPORT_ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 오디오 형식입니다. 허용 형식: {', '.join(sorted(AUDIO_IMPORT_ALLOWED_SUFFIXES))}",
        )

    try:
        blob = await file.read()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"오디오 파일 읽기에 실패했습니다: {exc}") from exc
    if not blob:
        raise HTTPException(status_code=400, detail="비어 있는 오디오 파일입니다.")

    try:
        normalized_window_size = max(4, min(int(window_size), 80))
    except Exception:
        normalized_window_size = 12

    temp_dir = Path(tempfile.mkdtemp(prefix="imms-audio-import-"))
    source_path = temp_dir / f"source{suffix}"
    source_path.write_bytes(blob)

    job = _create_audio_import_job(normalized_meeting_id, normalized_user_id, filename)
    _update_audio_import_job(
        job.job_id,
        status="queued",
        progress=1.0,
        step="queued",
        detail="오디오 파일 처리 작업을 준비하는 중입니다.",
    )

    worker = threading.Thread(
        target=_run_audio_import_job,
        args=(
            job.job_id,
            source_path,
            filename,
            normalized_meeting_id,
            _safe_text(meeting_goal),
            normalized_user_id,
            _boolify(reset_state, True),
            normalized_window_size,
        ),
        daemon=True,
        name=f"audio-import-{job.job_id[:8]}",
    )
    worker.start()

    current_job = _get_audio_import_job(job.job_id)
    return _serialize_audio_import_job(current_job or job)


@app.get("/api/import/audio-file/jobs/{job_id}")
def get_audio_import_job_status(job_id: str):
    job = _get_audio_import_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="audio import job not found")
    return _serialize_audio_import_job(job)


@app.post("/api/reset")
def post_reset():
    with RT.lock:
        llm_enabled = RT.llm_enabled
        RT.reset()
        RT.llm_enabled = llm_enabled
        return _state_response(RT)


@app.post("/api/stt/chunk")
async def post_stt_chunk(
    audio: UploadFile = File(...),
    speaker: str = Form(default="시스템오디오"),
    source: str = Form(default="system_audio"),
):
    t0 = time.perf_counter()
    with RT.lock:
        RT.stt_chunk_seq += 1
        chunk_id = RT.stt_chunk_seq

    try:
        blob = await audio.read()
    except Exception as exc:
        blob = b""
        read_err = str(exc)
    else:
        read_err = ""

    steps = [{"step": "read_chunk", "t_ms": int((time.perf_counter() - t0) * 1000)}]
    status = "ok"
    text = ""
    err_msg = ""

    if read_err:
        status = "error"
        err_msg = read_err
    elif not blob:
        status = "empty"
    else:
        suffix = Path(audio.filename or "chunk.webm").suffix or ".webm"
        try:
            text = _transcribe_with_whisper(blob, suffix=suffix)
        except Exception as exc:
            status = "error"
            err_msg = str(exc)
            text = ""
        if status == "ok" and not _safe_text(text):
            status = "empty"

    with RT.lock:
        if status == "ok" and _safe_text(text):
            _append_turn(RT, speaker, text, _now_ts())
            _enqueue_windowed_with_backpressure(RT, source="stt_chunk")
        state = _state_response(RT)

    steps.append({"step": "done", "t_ms": int((time.perf_counter() - t0) * 1000)})
    duration_ms = int((time.perf_counter() - t0) * 1000)

    return {
        "state": state,
        "stt_debug": {
            "chunk_id": chunk_id,
            "status": status,
            "source": source,
            "speaker": speaker,
            "filename": audio.filename or "chunk.webm",
            "bytes": len(blob),
            "steps": steps,
            "duration_ms": duration_ms,
            "transcript_chars": len(_safe_text(text)),
            "transcript_preview": _safe_text(text)[:240],
            "error": err_msg,
        },
    }


##추가 코드(웹소켓 에러 방지)
@app.post("/api/transcribe-chunk")
async def post_transcribe_chunk(
    audio_file: UploadFile = File(...),
    meeting_goal: str = Form(default=""),
):
    """
    Gateway에서 호출하는 전사 엔드포인트
    오디오 청크를 받아서 Whisper로 전사한 후 텍스트 반환
    """
    try:
        started_at = time.perf_counter()
        blob = await audio_file.read()
        if not blob:
            return {"text": "", "language": "ko", "error": "empty audio"}
        
        suffix = Path(audio_file.filename or "chunk.webm").suffix or ".webm"
        text = _transcribe_with_whisper(blob, suffix=suffix, meeting_goal=meeting_goal)
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        print(
            f"[STT] transcribed chunk model={WHISPER_MODEL_NAME} "
            f"bytes={len(blob)} suffix={suffix} elapsed_ms={elapsed_ms} "
            f"meeting_goal={bool(_safe_text(meeting_goal))} chars={len(_safe_text(text))}"
        )
        
        return {
            "text": _safe_text(text),
            "language": "ko",
            "elapsed_ms": elapsed_ms,
            "model": WHISPER_MODEL_NAME,
        }
    except Exception as exc:
        return {
            "text": "",
            "language": "ko",
            "error": str(exc)
        }
