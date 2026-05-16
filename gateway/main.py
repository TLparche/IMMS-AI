"""
Gateway FastAPI Application
"""
import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from gateway.config import settings
from gateway.routers import auth, meetings, websocket, reports
from security_utils import extract_client_ip, is_ip_allowed, parse_ip_whitelist

app = FastAPI(title="IMMS Gateway", version="1.0.0")
IP_WHITELIST = parse_ip_whitelist(settings.ip_whitelist)
CORS_ORIGIN_RE = re.compile(settings.cors_origin_regex) if settings.cors_origin_regex else None
CORS_ALLOWED_METHODS = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT"


def _resolve_cors_origin(origin: str | None) -> str:
    normalized_origin = (origin or "").strip()
    if not normalized_origin:
        return ""
    if "*" in settings.cors_origins:
        return normalized_origin
    if normalized_origin in settings.cors_origins:
        return normalized_origin
    if CORS_ORIGIN_RE and CORS_ORIGIN_RE.fullmatch(normalized_origin):
        return normalized_origin
    return ""


def _attach_cors_headers(request: Request, response: Response) -> Response:
    allowed_origin = _resolve_cors_origin(request.headers.get("origin"))
    if not allowed_origin:
        return response

    response.headers["Access-Control-Allow-Origin"] = allowed_origin
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = CORS_ALLOWED_METHODS
    response.headers["Access-Control-Allow-Headers"] = (
        request.headers.get("access-control-request-headers") or "*"
    )
    response.headers["Vary"] = "Origin"
    return response


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
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
async def enforce_ip_whitelist_and_cors(request: Request, call_next):
    if request.method == "OPTIONS":
        return _attach_cors_headers(request, Response(status_code=204))

    client_ip = extract_client_ip(request.headers, request.client.host if request.client else None)
    if not is_ip_allowed(client_ip, IP_WHITELIST):
        return _attach_cors_headers(
            request,
            JSONResponse(status_code=403, content={"detail": "IP not allowed"}),
        )

    response = await call_next(request)
    return _attach_cors_headers(request, response)


@app.get("/gateway/health")
async def health():
    return {"status": "ok", "service": "gateway"}
