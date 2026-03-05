"""
Gateway Configuration
환경 변수 관리
"""
from pydantic_settings import BaseSettings
from pathlib import Path


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
    
    class Config:
        env_file = str(Path(__file__).parent / ".env")
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"  # ignore unrelated vars from root .env

settings = Settings()
