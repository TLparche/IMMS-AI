"""
Gateway FastAPI Application
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from gateway.config import settings
from gateway.routers import auth, meetings, websocket, reports

app = FastAPI(title="IMMS Gateway", version="1.0.0")

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

@app.get("/gateway/health")
async def health():
    return {"status": "ok", "service": "gateway"}
