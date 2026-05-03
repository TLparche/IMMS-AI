"""
WebSocket Router
실시간 회의 음성 스트리밍 및 전사
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from typing import Any, Dict, List
import asyncio
import httpx
import json
import base64
import copy
from datetime import datetime, timezone
from ..config import get_supabase, settings
from security_utils import extract_client_ip, is_ip_allowed, parse_ip_whitelist

router = APIRouter()

# 회의방별 연결 관리
active_connections: Dict[str, List[Dict]] = {}
latest_canvas_workspace_by_meeting: Dict[str, Dict[str, Any]] = {}
latest_stt_summary_by_meeting: Dict[str, Dict[str, Any]] = {}

# AI 백엔드 URL
AI_BACKEND_URL = settings.ai_module_url.rstrip("/")
IP_WHITELIST = parse_ip_whitelist(settings.ip_whitelist)
FUSION_BUCKET_MS = 1200
FUSION_WAIT_MS = 450
FUSION_STICKY_BONUS = 0.35
FUSION_MIN_RMS = 0.004
FUSION_MIN_SPEECH_RATIO = 0.05
fusion_states: Dict[str, Dict[str, Any]] = {}


def _float_meta(meta: dict[str, Any], *keys: str, default: float = 0.0) -> float:
    for key in keys:
        value = meta.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return default


def normalize_audio_meta(raw_meta: Any) -> dict[str, Any]:
    meta = raw_meta if isinstance(raw_meta, dict) else {}
    return {
        "started_at": meta.get("started_at") or meta.get("startedAt"),
        "ended_at": meta.get("ended_at") or meta.get("endedAt"),
        "duration_ms": _float_meta(meta, "duration_ms", "durationMs"),
        "rms": _float_meta(meta, "rms"),
        "peak": _float_meta(meta, "peak"),
        "speech_ratio": _float_meta(meta, "speech_ratio", "speechRatio"),
        "zero_crossing_rate": _float_meta(meta, "zero_crossing_rate", "zeroCrossingRate"),
        "noise_floor": _float_meta(meta, "noise_floor", "noiseFloor", default=0.0015),
        "source_sample_rate": _float_meta(meta, "source_sample_rate", "sourceSampleRate"),
        "sample_rate": _float_meta(meta, "sample_rate", "sampleRate"),
        "chunk_index": _float_meta(meta, "chunk_index", "chunkIndex", default=-1),
        "mime_type": meta.get("mime_type") or meta.get("mimeType"),
    }


def get_fusion_state(meeting_id: str) -> Dict[str, Any]:
    state = fusion_states.get(meeting_id)
    if state is None:
        state = {
            "lock": asyncio.Lock(),
            "buckets": {},
            "tasks": {},
            "last_winner_user_id": None,
            "last_winner_bucket": None,
            "device_profiles": {},
            "last_transcript_text_by_user": {},
        }
        fusion_states[meeting_id] = state
    return state


def iso_to_epoch_ms(value: str | None) -> int:
    if not value:
        return int(datetime.now(timezone.utc).timestamp() * 1000)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except ValueError:
        return int(datetime.now(timezone.utc).timestamp() * 1000)


def score_audio_candidate(candidate: dict[str, Any], sticky_user_id: str | None, sticky_bucket: int | None, bucket_id: int) -> float:
    meta = candidate.get("audio_meta") or {}
    profile = candidate.get("device_profile") or {}
    rms = float(meta.get("rms") or 0.0)
    peak = float(meta.get("peak") or 0.0)
    speech_ratio = float(meta.get("speech_ratio") or 0.0)
    noise_floor = max(float(meta.get("noise_floor") or 0.0015), 0.0002)
    profile_rms = max(float(profile.get("rms") or 0.0), FUSION_MIN_RMS)
    profile_peak = max(float(profile.get("peak") or 0.0), 0.01)
    profile_speech_ratio = max(float(profile.get("speech_ratio") or 0.0), FUSION_MIN_SPEECH_RATIO)
    snr = max((rms - noise_floor) / noise_floor, 0.0)
    duration_score = min(float(meta.get("duration_ms") or 0.0) / 1200.0, 1.0)
    normalized_rms = min(rms / profile_rms, 1.6)
    normalized_peak = min(peak / profile_peak, 1.4)
    normalized_speech = min(speech_ratio / profile_speech_ratio, 1.8)

    score = (
        (normalized_speech * 1.9)
        + (normalized_rms * 1.2)
        + (normalized_peak * 0.45)
        + (min(snr, 12.0) * 0.22)
        + (duration_score * 0.12)
    )
    if sticky_user_id and sticky_user_id == candidate.get("user_id") and sticky_bucket is not None and bucket_id - sticky_bucket <= 1:
        score += FUSION_STICKY_BONUS
    return score


def pick_dominant_candidate(candidates: list[dict[str, Any]], sticky_user_id: str | None, sticky_bucket: int | None, bucket_id: int) -> dict[str, Any] | None:
    ranked: list[tuple[float, dict[str, Any]]] = []
    for candidate in candidates:
        meta = candidate.get("audio_meta") or {}
        rms = float(meta.get("rms") or 0.0)
        speech_ratio = float(meta.get("speech_ratio") or 0.0)
        if rms < FUSION_MIN_RMS and speech_ratio < FUSION_MIN_SPEECH_RATIO:
          continue
        ranked.append((score_audio_candidate(candidate, sticky_user_id, sticky_bucket, bucket_id), candidate))

    if not ranked:
        return None

    ranked.sort(key=lambda item: item[0], reverse=True)
    best_score, best_candidate = ranked[0]

    if len(ranked) > 1:
        second_score, second_candidate = ranked[1]
        if (
            sticky_user_id
            and second_candidate.get("user_id") == sticky_user_id
            and sticky_bucket is not None
            and bucket_id - sticky_bucket <= 1
            and (best_score - second_score) < 0.18
        ):
            return second_candidate

    return best_candidate


def normalize_transcript_for_dedupe(text: str) -> str:
    return "".join(ch for ch in (text or "").lower().strip() if ch.isalnum())


def trim_text_prefix_by_chars(text: str, prefix_char_count: int) -> str:
    if prefix_char_count <= 0:
        return text.strip()
    consumed = 0
    cut_index = 0
    for index, char in enumerate(text):
        if char.isalnum():
            consumed += 1
        if consumed >= prefix_char_count:
            cut_index = index + 1
            break
    return text[cut_index:].strip(" \n\t,.，。")


def find_longest_normalized_overlap(previous_text: str, current_text: str) -> int:
    previous = normalize_transcript_for_dedupe(previous_text)
    current = normalize_transcript_for_dedupe(current_text)
    if not previous or not current:
        return 0
    max_len = min(len(previous), len(current))
    for size in range(max_len, 12, -1):
        if previous[-size:] == current[:size]:
            return size
    return 0


def extract_incremental_transcript(current_text: str, previous_cumulative_text: str) -> str:
    clean = (current_text or "").strip()
    previous = (previous_cumulative_text or "").strip()
    if not clean or not previous:
        return clean
    if clean == previous:
        return ""
    if clean.startswith(previous):
        return clean[len(previous):].strip(" \n\t,.，。")

    previous_norm = normalize_transcript_for_dedupe(previous)
    clean_norm = normalize_transcript_for_dedupe(clean)
    if clean_norm and previous_norm and clean_norm.startswith(previous_norm):
        return trim_text_prefix_by_chars(clean, len(previous_norm))

    overlap = find_longest_normalized_overlap(previous, clean)
    if overlap > 0:
        return trim_text_prefix_by_chars(clean, overlap)

    # If the new cumulative result is mostly old content with minor Whisper rewrites,
    # avoid saving another duplicate sentence.
    if previous_norm and clean_norm and (clean_norm in previous_norm or previous_norm in clean_norm):
        return "" if len(clean_norm) <= len(previous_norm) + 8 else trim_text_prefix_by_chars(clean, len(previous_norm))

    return clean


def build_transcript_summary(speaker: str, text: str) -> str:
    clean_text = " ".join((text or "").split()).strip()
    if len(clean_text) > 64:
        clean_text = clean_text[:63].strip() + "…"
    lowered = clean_text.lower()
    if any(token in lowered for token in ["?", "？", "궁금", "어떻게", "왜", "가능", "될까", "되나"]):
        intent = "질문 중"
    elif any(token in lowered for token in ["문제", "불편", "어렵", "리스크", "걱정", "한계", "부족"]):
        intent = "문제 제기 중"
    elif any(token in lowered for token in ["하자", "하면", "아이디어", "제안", "추가", "개선", "만들", "넣", "도입", "활용"]):
        intent = "아이디어 제시 중"
    else:
        intent = "의견 공유 중"
    return f"{speaker or '참가자'}: {clean_text} · {intent}" if clean_text else "현재 발언 흐름 대기 중"


def build_stt_progress_summary(stage: str, data: dict[str, Any]) -> str:
    if stage in {"audio_chunk_received", "audio_chunk_queued"}:
        return "오디오 수신 중 · 전사 대기"
    if stage == "audio_candidate_selected":
        return "발화 구간 선택됨 · 전사 준비 중"
    if stage == "audio_candidate_dropped":
        return "입력이 작아 전사하지 않음"
    if stage == "transcription_audio_prepared":
        return "7초 발화 청크 준비됨 · 전사 준비 중"
    if stage == "transcription_started":
        return "Whisper 전사 중 · 잠시만 기다려 주세요"
    if stage == "transcription_empty":
        return "전사 결과 없음 · 다음 발화 대기"
    if stage == "transcript_saved":
        return "전사 저장 완료 · 화면 반영 대기"
    if stage == "transcript_save_failed":
        return "전사 DB 저장 실패"
    if stage == "transcription_duplicate_skipped":
        return "중복 전사 감지 · 새 내용 대기"
    if stage == "mic_calibrated":
        return "마이크 캘리브레이션 완료"
    return ""


async def update_stt_summary(meeting_id: str, text: str, source: str, user_id: str | None = None, **extra):
    summary = {
        "text": text,
        "source": source,
        "user_id": user_id or "",
        "updated_at": datetime.utcnow().isoformat(),
        **extra,
    }
    latest_stt_summary_by_meeting[meeting_id] = copy.deepcopy(summary)
    await broadcast_to_meeting(meeting_id, {
        "type": "stt_summary_updated",
        "meeting_id": meeting_id,
        "summary": summary,
        "summary_text": text,
        "timestamp": summary["updated_at"],
    })


async def transcribe_selected_chunk(candidate: dict[str, Any]) -> dict[str, Any]:
    audio_bytes = candidate.get("audio_bytes") or b""
    audio_mime = str(candidate.get("audio_mime") or candidate.get("audio_meta", {}).get("mime_type") or "audio/wav")
    audio_filename = str(candidate.get("audio_filename") or ("chunk.wav" if audio_mime.lower().startswith("audio/wav") else "chunk.webm"))
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{AI_BACKEND_URL}/api/transcribe-chunk",
            files={'audio_file': (audio_filename, audio_bytes, audio_mime)}
        )
        if response.status_code != 200:
            print(f"❌ Transcription failed: {response.status_code}")
            return {
                "text": "",
                "status": "http_error",
                "status_code": response.status_code,
                "error": response.text[:300],
            }
        result = response.json()
        if result.get("error"):
            print(f"❌ Transcription error: {result.get('error')}")
        if not (result.get('text') or '').strip():
            meta = candidate.get("audio_meta") or {}
            print(
                "ℹ️ Empty transcription "
                f"bytes={len(audio_bytes)} "
                f"mime={audio_mime} "
                f"rms={meta.get('rms')} speech_ratio={meta.get('speech_ratio')} "
                f"duration_ms={meta.get('duration_ms')}"
            )
        text = (result.get('text') or '').strip()
        return {
            "text": text,
            "status": "ok" if text else "empty",
            "status_code": response.status_code,
            "error": result.get("error") or "",
        }


async def flush_audio_bucket(meeting_id: str, bucket_id: int):
    await asyncio.sleep(FUSION_WAIT_MS / 1000)
    state = get_fusion_state(meeting_id)

    async with state["lock"]:
        candidates = list(state["buckets"].pop(bucket_id, []))
        state["tasks"].pop(bucket_id, None)
        sticky_user_id = state.get("last_winner_user_id")
        sticky_bucket = state.get("last_winner_bucket")

    if not candidates:
        return

    winner = pick_dominant_candidate(candidates, sticky_user_id, sticky_bucket, bucket_id)
    if not winner:
        await send_stt_debug(
            meeting_id,
            None,
            "audio_candidate_dropped",
            bucket_id=bucket_id,
            candidate_count=len(candidates),
            reason="below_rms_and_speech_ratio_threshold",
            thresholds={
                "min_rms": FUSION_MIN_RMS,
                "min_speech_ratio": FUSION_MIN_SPEECH_RATIO,
            },
            candidates=[
                {
                    "user_id": item.get("user_id"),
                    "speaker": item.get("speaker"),
                    "bytes": len(item.get("audio_bytes") or b""),
                    "audio_meta": item.get("audio_meta") or {},
                }
                for item in candidates[:6]
            ],
        )
        return

    await send_stt_debug(
        meeting_id,
        winner["user_id"],
        "audio_candidate_selected",
        bucket_id=bucket_id,
        candidate_count=len(candidates),
        bytes=len(winner.get("audio_bytes") or b""),
        audio_meta=winner.get("audio_meta") or {},
    )
    await broadcast_to_meeting(meeting_id, {
        'type': 'audio_selection',
        'meeting_id': meeting_id,
        'selected_user_id': winner["user_id"],
        'speaker': winner["speaker"],
        'bucket_id': bucket_id,
        'timestamp': datetime.utcnow().isoformat(),
    })

    await send_stt_debug(
        meeting_id,
        winner["user_id"],
        "transcription_audio_prepared",
        bucket_id=bucket_id,
        bytes=len(winner.get("audio_bytes") or b""),
        audio_mime=winner.get("audio_mime") or winner.get("audio_meta", {}).get("mime_type") or "audio/wav",
        audio_meta=winner.get("audio_meta") or {},
    )
    await send_stt_debug(
        meeting_id,
        winner["user_id"],
        "transcription_started",
        bucket_id=bucket_id,
        backend_url=AI_BACKEND_URL,
    )
    transcription = await transcribe_selected_chunk(winner)
    transcribed_text = transcription.get("text") or ""
    if not transcribed_text:
        await send_stt_debug(
            meeting_id,
            winner["user_id"],
            "transcription_empty",
            bucket_id=bucket_id,
            status=transcription.get("status"),
            status_code=transcription.get("status_code"),
            error=transcription.get("error") or "",
            audio_meta=winner.get("audio_meta") or {},
            bytes=len(winner.get("audio_bytes") or b""),
        )
        return

    saved_transcript = await save_transcript(meeting_id, winner["user_id"], winner["speaker"], transcribed_text)
    if not saved_transcript:
        await send_stt_debug(
            meeting_id,
            winner["user_id"],
            "transcript_save_failed",
            bucket_id=bucket_id,
            text_preview=transcribed_text[:120],
            text_length=len(transcribed_text),
        )
        return
    await send_stt_debug(
        meeting_id,
        winner["user_id"],
        "transcript_saved",
        bucket_id=bucket_id,
        text_preview=transcribed_text[:120],
        text_length=len(transcribed_text),
        transcript_id=saved_transcript.get("id"),
    )
    summary_text = build_transcript_summary(
        str(saved_transcript.get("speaker") or winner["speaker"]),
        str(saved_transcript.get("text") or transcribed_text),
    )
    await update_stt_summary(
        meeting_id,
        summary_text,
        "transcript_created",
        winner["user_id"],
        transcript_id=saved_transcript.get("id"),
    )
    transcript_message = {
        'type': 'transcript_created',
        'meeting_id': meeting_id,
        'transcript': {
            'id': saved_transcript.get("id"),
            'meeting_id': saved_transcript.get("meeting_id", meeting_id),
            'user_id': saved_transcript.get("user_id", winner["user_id"]),
            'speaker': saved_transcript.get("speaker", winner["speaker"]),
            'text': saved_transcript.get("text", transcribed_text),
            'timestamp': saved_transcript.get("timestamp") or datetime.utcnow().isoformat(),
            'created_at': saved_transcript.get("created_at") or saved_transcript.get("timestamp"),
        },
        'summary_text': summary_text,
        'audio_meta': winner.get("audio_meta") or {},
        'fusion': {
            'bucket_id': bucket_id,
            'selected_user_id': winner["user_id"],
        },
        'timestamp': datetime.utcnow().isoformat(),
    }
    await broadcast_to_meeting(meeting_id, transcript_message)

    async with state["lock"]:
        state["last_winner_user_id"] = winner["user_id"]
        state["last_winner_bucket"] = bucket_id
        state.setdefault("last_transcript_text_by_user", {})[winner["user_id"]] = transcribed_text[-500:]


async def queue_audio_for_fusion(meeting_id: str, candidate: dict[str, Any]):
    state = get_fusion_state(meeting_id)
    bucket_id = int(candidate["started_at_ms"] // FUSION_BUCKET_MS)

    async with state["lock"]:
        candidate["device_profile"] = dict(state["device_profiles"].get(candidate["user_id"], {}))
        state["buckets"].setdefault(bucket_id, []).append(candidate)
        if bucket_id not in state["tasks"]:
            state["tasks"][bucket_id] = asyncio.create_task(flush_audio_bucket(meeting_id, bucket_id))


async def persist_canvas_workspace(meeting_id: str, workspace: dict[str, Any]):
    normalized_workspace = dict(workspace or {})
    normalized_workspace["meeting_id"] = meeting_id

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{AI_BACKEND_URL}/api/canvas/workspace-state",
                json=normalized_workspace,
            )
            if response.status_code >= 400:
                print(f"❌ Failed to persist canvas workspace: {response.status_code} {response.text[:200]}")
    except Exception as e:
        print(f"❌ Failed to persist canvas workspace: {e}")


async def fetch_canvas_workspace(meeting_id: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{AI_BACKEND_URL}/api/canvas/workspace-state",
                params={"meeting_id": meeting_id},
            )
            if response.status_code >= 400:
                print(f"❌ Failed to fetch canvas workspace: {response.status_code} {response.text[:200]}")
                return None
            payload = response.json()
            return payload if isinstance(payload, dict) else None
    except Exception as e:
        print(f"❌ Failed to fetch canvas workspace: {e}")
        return None


async def broadcast_to_meeting(meeting_id: str, message: dict, exclude_user: str = None):
    """회의방의 모든 참가자에게 메시지 브로드캐스트"""
    if meeting_id not in active_connections:
        return
    
    disconnected = []
    for conn_info in active_connections[meeting_id]:
        if exclude_user and conn_info['user_id'] == exclude_user:
            continue
            
        try:
            await conn_info['ws'].send_json(message)
        except Exception as e:
            print(f"❌ Failed to send to {conn_info['user_id']}: {e}")
            disconnected.append(conn_info)
    
    # 연결 끊긴 사용자 제거
    for conn_info in disconnected:
        active_connections[meeting_id].remove(conn_info)


async def send_stt_debug(meeting_id: str, user_id: str | None, stage: str, **data):
    summary_text = build_stt_progress_summary(stage, data)
    if summary_text:
        await update_stt_summary(meeting_id, summary_text, stage, user_id)

    message = {
        "type": "stt_debug",
        "meeting_id": meeting_id,
        "user_id": user_id,
        "stage": stage,
        "timestamp": datetime.utcnow().isoformat(),
        **data,
    }
    if not user_id:
        await broadcast_to_meeting(meeting_id, message)
        return

    for conn_info in list(active_connections.get(meeting_id, [])):
        if conn_info.get("user_id") != user_id:
            continue
        try:
            await conn_info["ws"].send_json(message)
        except Exception as e:
            print(f"❌ Failed to send STT debug to {user_id}: {e}")


async def save_transcript(meeting_id: str, user_id: str, speaker: str, text: str) -> dict[str, Any] | None:
    """전사 결과를 Supabase에 저장"""
    normalized_text = (text or "").strip()
    if not normalized_text:
        return None

    try:
        supabase = get_supabase()
        transcript_timestamp = datetime.utcnow().isoformat()
        insert_payload = {
            'meeting_id': meeting_id,
            'user_id': user_id,
            'speaker': speaker,
            'text': normalized_text,
            'timestamp': transcript_timestamp,
        }
        response = supabase.table('transcripts').insert(insert_payload).execute()
        print(f"💾 Saved transcript: {speaker}: {normalized_text[:50]}...")
        rows = response.data or []
        if rows and isinstance(rows[0], dict):
            return rows[0]
        return insert_payload
    except Exception as e:
        print(f"❌ Failed to save transcript: {e}")
    return None


@router.websocket("/ws/{meeting_id}")
async def websocket_endpoint(
    websocket: WebSocket, 
    meeting_id: str,
    user_id: str = Query(...)
):
    client_ip = extract_client_ip(websocket.headers, websocket.client.host if websocket.client else None)
    if not is_ip_allowed(client_ip, IP_WHITELIST):
        await websocket.close(code=1008, reason="IP not allowed")
        return

    await websocket.accept()
    print(f"✅ User {user_id} connected to meeting {meeting_id}")
    
    # 회의방에 연결 추가
    if meeting_id not in active_connections:
        active_connections[meeting_id] = []
    
    conn_info = {
        'ws': websocket,
        'user_id': user_id
    }
    active_connections[meeting_id].append(conn_info)

    current_workspace = copy.deepcopy(latest_canvas_workspace_by_meeting.get(meeting_id))
    if not isinstance(current_workspace, dict):
        current_workspace = await fetch_canvas_workspace(meeting_id)
        if isinstance(current_workspace, dict):
            latest_canvas_workspace_by_meeting[meeting_id] = copy.deepcopy(current_workspace)
    if current_workspace:
        try:
            await websocket.send_json({
                'type': 'canvas_sync',
                'sync_id': f"initial-{meeting_id}-{int(datetime.utcnow().timestamp() * 1000)}",
                'meeting_id': meeting_id,
                'updated_by': '__server__',
                'updated_at': datetime.utcnow().isoformat(),
                'stage': current_workspace.get('stage', 'ideation'),
                'agenda_overrides': current_workspace.get('agenda_overrides') or {},
                'canvas_items': current_workspace.get('canvas_items') or [],
                'custom_groups': current_workspace.get('custom_groups') or [],
                'problem_groups': current_workspace.get('problem_groups') or [],
                'solution_topics': current_workspace.get('solution_topics') or [],
                'node_positions': current_workspace.get('node_positions') or {},
                'imported_state': current_workspace.get('imported_state'),
            })
        except Exception as e:
            print(f"❌ Failed to send initial canvas sync to {user_id}: {e}")

    current_stt_summary = copy.deepcopy(latest_stt_summary_by_meeting.get(meeting_id))
    if isinstance(current_stt_summary, dict) and current_stt_summary.get("text"):
        try:
            await websocket.send_json({
                'type': 'stt_summary_updated',
                'meeting_id': meeting_id,
                'summary': current_stt_summary,
                'summary_text': current_stt_summary.get("text"),
                'timestamp': current_stt_summary.get("updated_at") or datetime.utcnow().isoformat(),
            })
        except Exception as e:
            print(f"❌ Failed to send initial STT summary to {user_id}: {e}")

    await broadcast_to_meeting(meeting_id, {
        'type': 'canvas_state_request',
        'meeting_id': meeting_id,
        'requested_by': user_id,
        'request_id': f"{meeting_id}:{user_id}:{int(datetime.utcnow().timestamp() * 1000)}",
        'timestamp': datetime.utcnow().isoformat(),
    }, exclude_user=user_id)
    
    # 참가자 입장 알림
    await broadcast_to_meeting(meeting_id, {
        'type': 'user_joined',
        'user_id': user_id,
        'timestamp': datetime.utcnow().isoformat()
    })
    
    try:
        while True:
            # 클라이언트로부터 메시지 수신
            message = await websocket.receive_json()
            message_type = message.get('type')
            
            if message_type == 'audio_chunk':
                # 오디오 청크 처리
                audio_data = message.get('audio_data')  # base64 encoded
                speaker = message.get('speaker', f'User_{user_id[:8]}')
                audio_meta = normalize_audio_meta(message.get('audio_meta') or {})
                audio_mime = str(message.get('audio_mime') or audio_meta.get("mime_type") or "audio/wav")
                audio_filename = str(message.get('audio_filename') or ("chunk.wav" if audio_mime.lower().startswith("audio/wav") else "chunk.webm"))
                
                try:
                    audio_bytes = base64.b64decode(audio_data)
                    await send_stt_debug(
                        meeting_id,
                        user_id,
                        "audio_chunk_received",
                        bytes=len(audio_bytes),
                        speaker=speaker,
                        audio_meta=audio_meta,
                    )
                    candidate = {
                        "meeting_id": meeting_id,
                        "user_id": user_id,
                        "speaker": speaker,
                        "audio_bytes": audio_bytes,
                        "audio_mime": audio_mime,
                        "audio_filename": audio_filename,
                        "audio_meta": audio_meta,
                        "started_at_ms": iso_to_epoch_ms(audio_meta.get("started_at") or message.get("timestamp")),
                    }
                    await queue_audio_for_fusion(meeting_id, candidate)
                    await send_stt_debug(
                        meeting_id,
                        user_id,
                        "audio_chunk_queued",
                        bucket_id=int(candidate["started_at_ms"] // FUSION_BUCKET_MS),
                        bytes=len(audio_bytes),
                        audio_meta=audio_meta,
                    )
                except Exception as e:
                    import traceback
                    print(f"❌ Error processing audio chunk: {e}")
                    print(f"❌ Full traceback:")
                    traceback.print_exc()
                    await send_stt_debug(
                        meeting_id,
                        user_id,
                        "audio_chunk_error",
                        error=str(e),
                    )
            
            elif message_type == 'request_analysis':
                # 분석 요청 처리
                try:
                    supabase = get_supabase()
                    
                    # 최근 전사 데이터 가져오기
                    transcripts_response = supabase.table('transcripts') \
                        .select('*') \
                        .eq('meeting_id', meeting_id) \
                        .order('timestamp', desc=False) \
                        .execute()
                    
                    transcripts = transcripts_response.data
                    
                    if len(transcripts) >= 4:  # 최소 4개 발화 이상
                        # AI 백엔드로 분석 요청
                        async with httpx.AsyncClient(timeout=120.0) as client:
                            response = await client.post(
                                f"{AI_BACKEND_URL}/api/tick-analysis",
                                json={'transcripts': transcripts}
                            )
                            
                            if response.status_code == 200:
                                analysis = response.json()
                                
                                # 분석 결과 브로드캐스트
                                await broadcast_to_meeting(meeting_id, {
                                    'type': 'analysis_update',
                                    'data': analysis,
                                    'timestamp': datetime.utcnow().isoformat()
                                })
                except Exception as e:
                    print(f"❌ Error in analysis: {e}")

            elif message_type == 'canvas_sync':
                workspace = message.get('workspace') or {}
                if not isinstance(workspace, dict):
                    continue

                workspace['meeting_id'] = meeting_id
                latest_canvas_workspace_by_meeting[meeting_id] = copy.deepcopy(workspace)
                sync_message = {
                    'type': 'canvas_sync',
                    'data': workspace,
                    'meeting_id': meeting_id,
                    'user_id': user_id,
                    'timestamp': datetime.utcnow().isoformat(),
                }

                await asyncio.gather(
                    persist_canvas_workspace(meeting_id, workspace),
                    broadcast_to_meeting(meeting_id, sync_message, exclude_user=user_id),
                )

            elif message_type == 'mic_calibration':
                profile = message.get('profile') or {}
                state = get_fusion_state(meeting_id)
                async with state["lock"]:
                    state["device_profiles"][user_id] = {
                        "rms": float(profile.get("rms") or 0.0),
                        "peak": float(profile.get("peak") or 0.0),
                        "speech_ratio": float(profile.get("speech_ratio") or 0.0),
                        "noise_floor": float(profile.get("noise_floor") or 0.0),
                        "sample_count": int(profile.get("sample_count") or 0),
                    }
                await broadcast_to_meeting(meeting_id, {
                    'type': 'audio_calibrated',
                    'meeting_id': meeting_id,
                    'user_id': user_id,
                    'timestamp': datetime.utcnow().isoformat(),
                })
                await send_stt_debug(
                    meeting_id,
                    user_id,
                    "mic_calibrated",
                    profile=state["device_profiles"][user_id],
                )
                    
    except WebSocketDisconnect as exc:
        print(f"ℹ️ User {user_id} disconnected from meeting {meeting_id} (code={exc.code})")
        active_connections[meeting_id].remove(conn_info)
        
        if not active_connections[meeting_id]:
            del active_connections[meeting_id]
            fusion_states.pop(meeting_id, None)
            latest_canvas_workspace_by_meeting.pop(meeting_id, None)
            latest_stt_summary_by_meeting.pop(meeting_id, None)
        
        # 참가자 퇴장 알림
        await broadcast_to_meeting(meeting_id, {
            'type': 'user_left',
            'user_id': user_id,
            'timestamp': datetime.utcnow().isoformat()
        })
    except Exception as e:
        print(f"❌ WebSocket error for meeting {meeting_id}, user {user_id}: {e}")
        if conn_info in active_connections.get(meeting_id, []):
            active_connections[meeting_id].remove(conn_info)
        if meeting_id in active_connections and not active_connections[meeting_id]:
            active_connections.pop(meeting_id, None)
            fusion_states.pop(meeting_id, None)
            latest_canvas_workspace_by_meeting.pop(meeting_id, None)
            latest_stt_summary_by_meeting.pop(meeting_id, None)
