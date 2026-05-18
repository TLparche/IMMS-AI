"""
Reports Router
회의 리포트 생성 및 조회
"""
from fastapi import APIRouter, HTTPException
from supabase import create_client
from gateway.config import settings

router = APIRouter()
supabase = create_client(settings.supabase_url, settings.supabase_service_role_key)

@router.get("/{meeting_id}")
async def get_meeting_report(meeting_id: str):
    try:
        # 회의 정보
        meeting = supabase.table("meetings").select("*").eq("id", meeting_id).execute()
        if not meeting.data:
            raise HTTPException(status_code=404, detail="Meeting not found")
        
        # 전사 내역
        transcripts = supabase.table("transcripts").select("*").eq("meeting_id", meeting_id).order("timestamp").execute()
        
        # 안건
        agendas = supabase.table("agendas").select("*").eq("meeting_id", meeting_id).execute()
        
        # 의사결정
        decisions = supabase.table("decisions").select("*").eq("meeting_id", meeting_id).execute()
        
        # 액션 아이템
        actions = supabase.table("action_items").select("*").eq("meeting_id", meeting_id).execute()
        
        return {
            "meeting": meeting.data[0],
            "transcripts": transcripts.data,
            "agendas": agendas.data,
            "decisions": decisions.data,
            "action_items": actions.data
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
