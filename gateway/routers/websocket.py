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
from datetime import datetime
from ..config import get_supabase, settings

router = APIRouter()

# 회의방별 연결 관리
active_connections: Dict[str, List[Dict]] = {}

# AI 백엔드 URL
AI_BACKEND_URL = settings.ai_module_url.rstrip("/")


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
                
                try:
                    # AI 백엔드로 전사 요청
                    async with httpx.AsyncClient(timeout=120.0) as client:
                        # base64를 바이너리로 디코드
                        audio_bytes = base64.b64decode(audio_data)
                        
                        response = await client.post(
                            f"{AI_BACKEND_URL}/api/transcribe-chunk",
                            files={'audio_file': ('audio.webm', audio_bytes, 'audio/webm')}
                        )
                        
                        if response.status_code == 200:
                            result = response.json()
                            transcribed_text = result.get('text', '').strip()
                            
                            if transcribed_text:
                                print(f"📝 Transcribed: {speaker}: {transcribed_text}")
                                
                                # Supabase에 저장 (중요 발화만)
                                await save_transcript(meeting_id, user_id, speaker, transcribed_text)
                                
                                # 모든 참가자에게 브로드캐스트
                                await broadcast_to_meeting(meeting_id, {
                                    'type': 'transcript',
                                    'meeting_id': meeting_id,
                                    'user_id': user_id,
                                    'speaker': speaker,
                                    'text': transcribed_text,
                                    'timestamp': datetime.utcnow().isoformat()
                                })
                        else:
                            print(f"❌ Transcription failed: {response.status_code}")
                            
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
                    
    except WebSocketDisconnect as exc:
        print(f"ℹ️ User {user_id} disconnected from meeting {meeting_id} (code={exc.code})")
        active_connections[meeting_id].remove(conn_info)
        
        if not active_connections[meeting_id]:
            del active_connections[meeting_id]
        
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
