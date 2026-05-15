# IMMS 1차 배포 가이드

이 폴더는 **1차 프로토 배포용 파일만** 모아둔 폴더입니다.

## 들어 있는 파일

- `docker-compose.prod.yml`
- `backend.Dockerfile`
- `gateway.Dockerfile`
- `frontend.Dockerfile`
- `.env.production.example`

루트의 `.dockerignore`는 Docker build context가 저장소 루트라서 그대로 루트에 남겨둡니다.

## 배포 방식

현재 1차 배포는 `frontend + gateway + backend`를 한 서버에서 같이 올리는 구조입니다.

```text
Frontend (3000)
Gateway (8001)
Backend AI (8000)
Supabase (외부)
```

브라우저는 현재 구조상 `frontend`, `gateway`, `backend` 모두에 직접 접근합니다.

## 준비물

- Docker
- Docker Compose Plugin
- Supabase 프로젝트
- Gemini API Key

## 1. Supabase 스키마 적용

Supabase SQL Editor에서 [supabase_schema.sql](/E:/AI/IMMS-AI/supabase_schema.sql)을 실행합니다.

필수 테이블:
- `meeting_runtime_states`
- `meeting_user_states`

## 2. 배포용 env 작성

PowerShell:

```powershell
cd E:\AI\IMMS-AI\deploy
Copy-Item .env.production.example .env.production
notepad .env.production
```

반드시 실제 값으로 채워야 하는 항목:
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_GATEWAY_URL`
- `NEXT_PUBLIC_GATEWAY_WS_URL`
- `CORS_ORIGINS`

예시:

```env
NEXT_PUBLIC_API_BASE_URL=http://123.123.123.123:8000
NEXT_PUBLIC_GATEWAY_URL=http://123.123.123.123:8001/gateway
NEXT_PUBLIC_GATEWAY_WS_URL=ws://123.123.123.123:8001/gateway/ws
CORS_ORIGINS=["http://123.123.123.123:3000"]
```

HTTPS 도메인을 쓰면:
- `http://` -> `https://`
- `ws://` -> `wss://`

## 3. 배포 실행

`deploy` 폴더에서 실행:

```powershell
cd E:\AI\IMMS-AI\deploy
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

## 4. 배포 확인

상태 확인:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

로그 확인:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f frontend
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f gateway
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend
```

헬스체크:
- Frontend: `http://YOUR_SERVER_HOST:3000`
- Gateway: `http://YOUR_SERVER_HOST:8001/gateway/health`
- Backend: `http://YOUR_SERVER_HOST:8000/api/health`

## 5. 중지 / 재배포

중지:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

재배포:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

## 주의

- `NEXT_PUBLIC_*` 값이 바뀌면 프런트는 다시 빌드해야 합니다.
- 현재 1차 배포는 `3000/8000/8001` 포트를 그대로 노출합니다.
- 2차 배포에서는 `nginx` 또는 `caddy` reverse proxy를 붙이는 게 좋습니다.
- 로그인/저장 문제가 나면 먼저 `Supabase 스키마`, `service role key`, `NEXT_PUBLIC_* 주소`, `CORS_ORIGINS`를 확인하세요.
