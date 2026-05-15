# IMMS Real-time Meeting System

실시간 AI 기반 회의 전사 및 안건 분석 시스템

## 프로젝트 개요

- **이름**: IMMS (Intelligent Meeting Management System)
- **목표**: 실시간 회의 참여 시 음성을 자동 전사하고 AI가 안건, 의사결정, 액션 아이템을 분석하여 회의 효율을 극대화
- **주요 기능**:
  - 실시간 회의 참여 (Zoom 방식)
  - 각 참여자의 마이크 입력 개별 수집 및 화자 구분
  - Whisper 기반 실시간 STT 전사
  - Gemini LLM 기반 자동 안건 분석
  - 회의 종료 후 리포트 자동 생성 및 PDF 다운로드

## URLs

- **Production**: (배포 후 업데이트 예정)
- **GitHub**: https://github.com/Sangminyeee/IMMS-AI

## 아키텍처

### 전체 구조
```
Frontend (Next.js) ↔ Gateway (FastAPI) ↔ Backend AI Module (FastAPI)
                             ↓
                        Supabase DB
```

### 데이터 모델
- **meetings**: 회의 정보 (제목, 목표, 호스트, 상태, 일정 등)
- **participants**: 회의 참여자
- **transcripts**: 실시간 전사 내역 (화자별)
- **agendas**: AI 분석 안건 목록
- **decisions**: 의사결정 항목
- **action_items**: 액션 아이템 (담당자, 기한)
- **reports**: 회의 종료 후 생성된 리포트

### 저장 서비스
- **Supabase**: PostgreSQL 기반 실시간 DB, 인증, Row-Level Security

## 사용 기술

### Backend
- **FastAPI**: AI Module (backend/api.py) + Gateway (gateway/)
- **Whisper**: 음성 전사 (로컬 large 모델)
- **Gemini LLM**: 안건 분석 (gemini-2.0-flash)
- **Supabase**: 데이터베이스 및 인증

### Frontend
- **Next.js 14**: React 기반 웹 앱
- **TailwindCSS**: 스타일링
- **WebSocket**: 실시간 통신
- **getUserMedia**: 마이크 입력

## 프로젝트 구조

```
IMMS-AI/
├── backend/              # AI 모듈 (팀원 원본, 변경 없음)
│   └── api.py
├── gateway/              # 인증 및 실시간 통신 게이트웨이
│   ├── main.py
│   ├── config.py
│   └── routers/
│       ├── auth.py       # 회원가입, 로그인
│       ├── meetings.py   # 회의 CRUD
│       ├── websocket.py  # 실시간 음성 스트리밍
│       └── reports.py    # 리포트 생성
├── frontend/             # Next.js 웹 앱 (팀원 UI 유지)
│   ├── app/
│   │   ├── page.tsx      # 메인 회의 워크스페이스 (팀원 원본 UI)
│   │   ├── login/        # (추가 필요)
│   │   ├── register/     # (추가 필요)
│   │   └── dashboard/    # (추가 필요)
│   └── lib/
│       ├── api.ts
│       └── websocket.ts
├── llm_client.py         # Gemini LLM 클라이언트
├── run_dev.py            # 개발 서버 실행 스크립트
├── requirements.txt      # Python 의존성
├── supabase_schema.sql   # DB 스키마
├── .gitignore
├── .env.example          # 환경 변수 예제
└── README.md
```

## 설치 및 실행

### 1. 환경 변수 설정

루트에 `.env` 파일 생성:
```
# Gemini API
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_MODEL=gemini-2.0-flash
WHISPER_MODEL=large

# Ports
BACKEND_PORT=8000
FRONTEND_PORT=5173
```

`gateway/.env` 파일 생성:
```
# Supabase
SUPABASE_URL=https://uqlrawufmurqnqnbkuzz.supabase.co
SUPABASE_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# AI Module
AI_MODULE_URL=http://localhost:8000

# Gateway
GATEWAY_PORT=8001
GATEWAY_HOST=0.0.0.0

# JWT
JWT_SECRET=your_jwt_secret_here
JWT_ALGORITHM=HS256

# CORS
CORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173","http://localhost:3000"]
```

`frontend/.env.local` 파일 생성:
```
NEXT_PUBLIC_SUPABASE_URL=https://uqlrawufmurqnqnbkuzz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8001/gateway
NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:8001/gateway/ws
```

### 2. Supabase DB 설정

Supabase 대시보드에서 `supabase_schema.sql` 파일을 실행하여 테이블 및 RLS 정책 생성

### 3. 의존성 설치

```bash
# Python 의존성
pip install -r requirements.txt
pip install fastapi uvicorn websockets python-multipart pydantic pydantic-settings supabase python-jose reportlab python-dotenv email-validator

# Frontend 의존성
cd frontend
npm install
cd ..
```

### 4. 서비스 실행

**권장: 한 번에 실행**
```bash
python run_dev.py
```

이 스크립트는 `backend + gateway + frontend`를 함께 실행하고, 포트가 이미 사용 중이면 가능한 포트를 찾아 자동으로 연결합니다.

**수동 실행이 필요할 때만**
```bash
python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000 --reload
python -m uvicorn gateway.main:app --host 0.0.0.0 --port 8001 --reload
cd frontend && npm run dev
```

### 5. 접속

- **Frontend**: http://localhost:5173
- **Gateway**: http://localhost:8001
- **AI Module**: http://localhost:8000

## 사용 방법

1. **회원가입**: `/register`에서 이메일, 이름, 역할, 팀, 직무 입력
2. **로그인**: `/login`에서 이메일, 비밀번호 입력
3. **대시보드**: 회의 목록 확인, 새 회의 생성
4. **회의 참여**:
   - 회의 목록에서 회의 클릭 → 대기실 진입
   - 마이크 권한 허용 (최초 1회)
   - 호스트가 시작 버튼 클릭 → 실시간 전사 시작
   - 좌측: 실시간 전사, 중앙: 안건 분석, 우측: 의사결정/액션
5. **회의 종료**: 호스트가 종료 버튼 클릭 → 자동 리포트 생성
6. **리포트 확인**: 리포트 탭에서 회의별 리포트 조회 및 PDF 다운로드

## 현재 구현 상태

###  완료
- [x] AI Module (backend/api.py, llm_client.py) - 팀원 원본 코드
- [x] Gateway 스캐폴딩 (FastAPI, 인증, 회의 CRUD, WebSocket, 리포트)
- [x] Supabase 스키마 및 RLS 정책
- [x] Frontend 인증 통합 (AuthContext, login, register, dashboard 페이지)
- [x] 실시간 회의 기능 (WebSocket 클라이언트, audio-recorder, 완전한 websocket.py)
- [x] Supabase 용량 최적화 (중요 발화만 저장 로직)
- [x] .gitignore, README.md 작성

### 🚧 진행 중 (로컬에서 진행)
- [ ] 메인 회의 워크스페이스 UI 통합 (frontend/app/page.tsx에 WebSocket + Audio Recorder 연결)
- [ ] 회의 시작/종료 흐름 테스트
- [ ] 리포트 생성 및 PDF 다운로드 테스트

### 예정
- [ ] 2차 배포 구조 고도화 (도메인/리버스 프록시/운영 최적화)
- [ ] 성능 최적화 및 실전 테스트
- [ ] 사용자 피드백 반영

## 배포

1차 프로토 배포용 파일과 자세한 가이드는 [deploy/README.md](/E:/AI/IMMS-AI/deploy/README.md)에 분리해 두었습니다.

배포 관련 파일 위치:
- [deploy/docker-compose.prod.yml](/E:/AI/IMMS-AI/deploy/docker-compose.prod.yml)
- [deploy/.env.production.example](/E:/AI/IMMS-AI/deploy/.env.production.example)
- [deploy/backend.Dockerfile](/E:/AI/IMMS-AI/deploy/backend.Dockerfile)
- [deploy/gateway.Dockerfile](/E:/AI/IMMS-AI/deploy/gateway.Dockerfile)
- [deploy/frontend.Dockerfile](/E:/AI/IMMS-AI/deploy/frontend.Dockerfile)

## 기여자

- **Sangminyeee** (crescendo0914@gmail.com)

## 라이선스

MIT License

## 추가 정보
- **Supabase Project**: uqlrawufmurqnqnbkuzz
- **API 문서**: http://localhost:8001/docs (Gateway), http://localhost:8000/docs (AI Module)
