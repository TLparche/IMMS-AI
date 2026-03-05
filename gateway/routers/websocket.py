"""
WebSocket Router
실시간 회의 음성 스트리밍 및 전사
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict
import asyncio

router = APIRouter()

# 회의방별 연결 관리
active_connections: Dict[str, list] = {}

@router.websocket("/ws/{meeting_id}")
async def websocket_endpoint(websocket: WebSocket, meeting_id: str):
    await websocket.accept()
    
    # 회의방에 연결 추가
    if meeting_id not in active_connections:
        active_connections[meeting_id] = []
    active_connections[meeting_id].append(websocket)
    
    try:
        while True:
            # 클라이언트로부터 오디오 청크 수신
            data = await websocket.receive_bytes()
            
            # TODO: 
            # 1. 오디오 청크를 backend/api.py의 /api/transcribe-chunk로 전달
            # 2. user_id 기반 화자 구분
            # 3. 전사 결과를 같은 회의방의 모든 연결에 브로드캐스트
            
            # 임시로 에코백 테스트
            for connection in active_connections[meeting_id]:
                if connection != websocket:
                    await connection.send_json({
                        "type": "audio_chunk",
                        "data": "received"
                    })
                    
    except WebSocketDisconnect:
        active_connections[meeting_id].remove(websocket)
        if not active_connections[meeting_id]:
            del active_connections[meeting_id]
