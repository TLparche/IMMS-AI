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

# AI 백엔드 URL
AI_BACKEND_URL = settings.ai_module_url.rstrip("/")
IP_WHITELIST = parse_ip_whitelist(settings.ip_whitelist)
FUSION_BUCKET_MS = 1200
FUSION_WAIT_MS = 450
FUSION_STICKY_BONUS = 0.35
FUSION_MIN_RMS = 0.004
FUSION_MIN_SPEECH_RATIO = 0.05
fusion_states: Dict[str, Dict[str, Any]] = {}


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


async def transcribe_selected_chunk(candidate: dict[str, Any]):
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{AI_BACKEND_URL}/api/transcribe-chunk",
            files={'audio_file': ('audio.webm', candidate['audio_bytes'], 'audio/webm')}
        )
        if response.status_code != 200:
            print(f"❌ Transcription failed: {response.status_code}")
            return ""
        result = response.json()
        return (result.get('text') or '').strip()


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
        return

    await broadcast_to_meeting(meeting_id, {
        'type': 'audio_selection',
        'meeting_id': meeting_id,
        'selected_user_id': winner["user_id"],
        'speaker': winner["speaker"],
        'bucket_id': bucket_id,
        'timestamp': datetime.utcnow().isoformat(),
    })

    transcribed_text = await transcribe_selected_chunk(winner)
    if not transcribed_text:
        return

    await save_transcript(meeting_id, winner["user_id"], winner["speaker"], transcribed_text)
    await broadcast_to_meeting(meeting_id, {
        'type': 'transcript',
        'meeting_id': meeting_id,
        'user_id': winner["user_id"],
        'speaker': winner["speaker"],
        'text': transcribed_text,
        'timestamp': datetime.utcnow().isoformat(),
        'audio_meta': winner.get("audio_meta") or {},
        'fusion': {
            'bucket_id': bucket_id,
            'selected_user_id': winner["user_id"],
        },
    })

    async with state["lock"]:
        state["last_winner_user_id"] = winner["user_id"]
        state["last_winner_bucket"] = bucket_id


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


async def save_transcript(meeting_id: str, user_id: str, speaker: str, text: str):
    """전사 결과를 Supabase에 저장"""
    normalized_text = (text or "").strip()
    if not normalized_text:
        return

    try:
        supabase = get_supabase()
        supabase.table('transcripts').insert({
            'meeting_id': meeting_id,
            'user_id': user_id,
            'speaker': speaker,
            'text': normalized_text,
            'timestamp': datetime.utcnow().isoformat()
        }).execute()
        print(f"💾 Saved transcript: {speaker}: {normalized_text[:50]}...")
    except Exception as e:
        print(f"❌ Failed to save transcript: {e}")


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
                'problem_groups': current_workspace.get('problem_groups') or [],
                'solution_topics': current_workspace.get('solution_topics') or [],
                'node_positions': current_workspace.get('node_positions') or {},
                'imported_state': current_workspace.get('imported_state'),
            })
        except Exception as e:
            print(f"❌ Failed to send initial canvas sync to {user_id}: {e}")

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
                audio_meta = message.get('audio_meta') or {}
                
                try:
                    audio_bytes = base64.b64decode(audio_data)
                    candidate = {
                        "meeting_id": meeting_id,
                        "user_id": user_id,
                        "speaker": speaker,
                        "audio_bytes": audio_bytes,
                        "audio_meta": audio_meta,
                        "started_at_ms": iso_to_epoch_ms(audio_meta.get("startedAt") or message.get("timestamp")),
                    }
                    await queue_audio_for_fusion(meeting_id, candidate)
                except Exception as e:
                    import traceback
                    print(f"❌ Error processing audio chunk: {e}")
                    print(f"❌ Full traceback:")
                    traceback.print_exc()
            
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
                    
    except WebSocketDisconnect as exc:
        print(f"ℹ️ User {user_id} disconnected from meeting {meeting_id} (code={exc.code})")
        active_connections[meeting_id].remove(conn_info)
        
        if not active_connections[meeting_id]:
            del active_connections[meeting_id]
            fusion_states.pop(meeting_id, None)
            latest_canvas_workspace_by_meeting.pop(meeting_id, None)
        
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
