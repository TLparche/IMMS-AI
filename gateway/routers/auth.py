"""
Authentication Router
회원가입, 로그인, 로그아웃 API
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client
from gateway.config import settings

router = APIRouter()
supabase = create_client(settings.supabase_url, settings.supabase_key)

class SignUpRequest(BaseModel):
    email: str
    password: str
    name: str
    role: str = "participant"
    team: str = ""
    job: str = ""

class SignInRequest(BaseModel):
    email: str
    password: str

@router.post("/signup")
async def signup(req: SignUpRequest):
    try:
        # Supabase Auth 회원가입
        res = supabase.auth.sign_up({
            "email": req.email,
            "password": req.password,
            "options": {
                "data": {
                    "name": req.name,
                    "role": req.role,
                    "team": req.team,
                    "job": req.job
                }
            }
        })
        return {"user": res.user, "session": res.session}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/signin")
async def signin(req: SignInRequest):
    try:
        res = supabase.auth.sign_in_with_password({
            "email": req.email,
            "password": req.password
        })
        return {"user": res.user, "session": res.session}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))

@router.post("/signout")
async def signout():
    try:
        supabase.auth.sign_out()
        return {"message": "Signed out successfully"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
