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
auth_supabase = create_client(settings.supabase_url, settings.supabase_key)

class CreateMeetingRequest(BaseModel):
    title: str
    goal: str = ""
    scheduled_at: Optional[str] = None


def _extract_user_id(auth_response) -> str:
    user = getattr(auth_response, "user", None)
    if user is None and isinstance(auth_response, dict):
        user = auth_response.get("user")

    user_id = getattr(user, "id", None)
    if user_id is None and isinstance(user, dict):
        user_id = user.get("id")

    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid authorization token")
    return str(user_id)


async def resolve_user_id(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is required")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Bearer token is required")

    try:
        auth_response = auth_supabase.auth.get_user(token.strip())
        return _extract_user_id(auth_response)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid authorization token: {exc}") from exc


def user_can_access_meeting(meeting_id: str, user_id: str) -> bool:
    meeting = supabase.table("meetings").select("id,host_id").eq("id", meeting_id).limit(1).execute()
    if not meeting.data:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.data[0].get("host_id") == user_id:
        return True

    participant = (
        supabase.table("participants")
        .select("id")
        .eq("meeting_id", meeting_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return bool(participant.data)


@router.post("")
async def create_meeting(req: CreateMeetingRequest, authorization: Optional[str] = Header(None)):
    user_id = await resolve_user_id(authorization)
    try:
        result = supabase.table("meetings").insert({
            "title": req.title,
            "goal": req.goal,
            "host_id": user_id,
            "status": "waiting"
        }).execute()
        meeting = result.data[0] if result.data else {}
        if meeting.get("id"):
            supabase.table("participants").upsert(
                {
                    "meeting_id": meeting["id"],
                    "user_id": user_id,
                    "role": "host",
                },
                on_conflict="meeting_id,user_id",
            ).execute()
        return meeting
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("")
async def list_meetings(authorization: Optional[str] = Header(None)):
    user_id = await resolve_user_id(authorization)
    try:
        host_result = supabase.table("meetings").select("*").eq("host_id", user_id).execute()
        participant_result = supabase.table("participants").select("meeting_id").eq("user_id", user_id).execute()

        meetings_by_id = {
            row["id"]: row
            for row in (host_result.data or [])
            if row.get("id")
        }
        participant_meeting_ids = [
            row.get("meeting_id")
            for row in (participant_result.data or [])
            if row.get("meeting_id") and row.get("meeting_id") not in meetings_by_id
        ]
        if participant_meeting_ids:
            joined_result = supabase.table("meetings").select("*").in_("id", participant_meeting_ids).execute()
            for row in joined_result.data or []:
                if row.get("id"):
                    meetings_by_id[row["id"]] = row

        return sorted(
            meetings_by_id.values(),
            key=lambda row: row.get("created_at") or "",
            reverse=True,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/{meeting_id}")
async def get_meeting(meeting_id: str, authorization: Optional[str] = Header(None)):
    user_id = await resolve_user_id(authorization)
    try:
        if not user_can_access_meeting(meeting_id, user_id):
            raise HTTPException(status_code=403, detail="Meeting access denied")
        result = supabase.table("meetings").select("*").eq("id", meeting_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
