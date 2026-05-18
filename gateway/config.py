"""
Gateway Configuration
환경 변수 관리
"""
import json
from pydantic_settings import BaseSettings
from pydantic import field_validator
from pathlib import Path
from supabase import create_client, Client


class Settings(BaseSettings):
    # Supabase
    supabase_url: str
    supabase_key: str  # anon key
    supabase_service_role_key: str
    
    # AI 모듈 연동
    ai_module_url: str = "http://localhost:8000"
    
    # Gateway
    gateway_port: int = 8001
    gateway_host: str = "0.0.0.0"
    
    # JWT
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    
    # CORS
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "https://imms-ai.vercel.app",
    ]
    cors_origin_regex: str = r"https://.*\.vercel\.app"
    ip_whitelist: str = ""

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value):
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return []
            if raw.startswith("["):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = []
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip() for item in raw.split(",") if item.strip()]
        return value
    
    class Config:
        env_file = str(Path(__file__).parent / ".env")
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"  # ignore unrelated vars from root .env

settings = Settings()

# Supabase 클라이언트 (싱글톤)
_supabase_client: Client = None

def get_supabase() -> Client:
    """Supabase 클라이언트 반환 (싱글톤 패턴)"""
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = create_client(
            settings.supabase_url,
            settings.supabase_service_role_key
        )
    return _supabase_client
