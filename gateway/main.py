"""
Gateway FastAPI Application
"""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from gateway.config import settings
from gateway.routers import auth, meetings, websocket, reports
from security_utils import extract_client_ip, is_ip_allowed, parse_ip_whitelist

app = FastAPI(title="IMMS Gateway", version="1.0.0")
IP_WHITELIST = parse_ip_whitelist(settings.ip_whitelist)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth.router, prefix="/gateway/auth", tags=["auth"])
app.include_router(meetings.router, prefix="/gateway/meetings", tags=["meetings"])
app.include_router(websocket.router, prefix="/gateway", tags=["websocket"])
app.include_router(reports.router, prefix="/gateway/reports", tags=["reports"])


@app.middleware("http")
async def enforce_ip_whitelist(request: Request, call_next):
    client_ip = extract_client_ip(request.headers, request.client.host if request.client else None)
    if not is_ip_allowed(client_ip, IP_WHITELIST):
        return JSONResponse(status_code=403, content={"detail": "IP not allowed"})
    return await call_next(request)

@app.get("/gateway/health")
async def health():
    return {"status": "ok", "service": "gateway"}
