"""
Meetings Router
회의 CRUD API
"""
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
from supabase import create_client
from gateway.config import settings

router = APIRouter()
supabase = create_client(settings.supabase_url, settings.supabase_service_role_key)

class CreateMeetingRequest(BaseModel):
    title: str
    goal: str = ""
    scheduled_at: Optional[str] = None

@router.post("")
async def create_meeting(req: CreateMeetingRequest, authorization: str = Header(None)):
    # TODO: JWT 토큰 검증
    user_id = "temp-user-id"  # 실제로는 JWT에서 추출
    try:
        result = supabase.table("meetings").insert({
            "title": req.title,
            "goal": req.goal,
            "host_id": user_id,
            "status": "waiting"
        }).execute()
        return result.data[0] if result.data else {}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("")
async def list_meetings(authorization: str = Header(None)):
    # TODO: JWT 토큰 검증
    user_id = "temp-user-id"
    try:
        result = supabase.table("meetings").select("*").eq("host_id", user_id).execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/{meeting_id}")
async def get_meeting(meeting_id: str, authorization: str = Header(None)):
    try:
        result = supabase.table("meetings").select("*").eq("id", meeting_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
