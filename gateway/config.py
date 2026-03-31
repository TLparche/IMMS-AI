"""
Gateway Configuration
환경 변수 관리
"""
from pydantic_settings import BaseSettings
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
    cors_origins: list = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"]
    ip_whitelist: str = ""
    
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
