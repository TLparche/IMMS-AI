"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter, useSearchParams } from "next/navigation";
import { WebSocketClient } from "@/lib/websocket";
import { AudioRecorder } from "@/lib/audio-recorder";
import { supabase } from "@/lib/supabase";
import { syncTranscript } from "@/lib/api";
import type { CanvasRealtimeSyncPayload, MeetingState } from "@/lib/types";
import MeetingCanvasTab, { type MeetingAgenda as CanvasAgenda, type MeetingTranscript as CanvasTranscript } from "@/components/MeetingCanvasTab";

interface Transcript {
  id: string;
  speaker: string;
  text: string;
  timestamp: string;
}

interface Agenda {
  id: string;
  title: string;
  status: string;
}

interface Decision {
  id: string;
  text: string;
  status: string;
}

interface ActionItem {
  id: string;
  task: string;
  owner: string;
  due_date: string;
  status: string;
}

type WorkspaceTab = "meeting" | "canvas";

function dedupeTranscripts(rows: Transcript[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.speaker}|${row.text}|${row.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapAnalysisToUi(state: MeetingState) {
  const outcomes = state.analysis?.agenda_outcomes || [];
  const agendas: Agenda[] = outcomes.map((outcome, index) => ({
    id: outcome.agenda_id || `agenda-${index + 1}`,
    title: outcome.agenda_title || `안건 ${index + 1}`,
    status: outcome.agenda_state || "PROPOSED",
  }));

  const decisions: Decision[] = outcomes.flatMap((outcome, agendaIndex) =>
    (outcome.decision_results || []).map((decision, decisionIndex) => ({
      id: `${outcome.agenda_id || agendaIndex}-decision-${decisionIndex}`,
      text: decision.conclusion || decision.opinions?.join(" / ") || "결정 내용 없음",
      status: decision.conclusion ? "approved" : "pending",
    })),
  );

  const actionItems: ActionItem[] = outcomes.flatMap((outcome, agendaIndex) =>
    (outcome.action_items || []).map((item, itemIndex) => ({
      id: `${outcome.agenda_id || agendaIndex}-action-${itemIndex}`,
      task: item.item || "액션 아이템",
      owner: item.owner || "미정",
      due_date: item.due || "미정",
      status: item.due ? "in_progress" : "open",
    })),
  );

  return { agendas, decisions, actionItems };
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const meetingId = searchParams.get("meeting_id");
  const headerRef = useRef<HTMLElement | null>(null);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("meeting");
  const [meetingTitle, setMeetingTitle] = useState("회의 워크스페이스");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [analysisState, setAnalysisState] = useState<MeetingState | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [loadingMeeting, setLoadingMeeting] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [canvasSyncStatus, setCanvasSyncStatus] = useState("실시간 전사가 canvas 분석 상태에 자동 반영됩니다.");
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [canvasViewportHeight, setCanvasViewportHeight] = useState<number | null>(null);
  const [incomingCanvasSync, setIncomingCanvasSync] = useState<CanvasRealtimeSyncPayload | null>(null);

  const wsClientRef = useRef<WebSocketClient | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const meetingTitleRef = useRef(meetingTitle);
  const transcriptsRef = useRef(transcripts);
  const autoSyncTimerRef = useRef<number | null>(null);
  const autoSyncInFlightRef = useRef(false);
  const queuedSyncSignatureRef = useRef("");
  const lastSyncedSignatureRef = useRef("");

  useEffect(() => {
    meetingTitleRef.current = meetingTitle;
  }, [meetingTitle]);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  useEffect(() => {
    const updateCanvasViewport = () => {
      const headerHeight = headerRef.current?.offsetHeight || 0;
      const nextHeight = Math.max(window.innerHeight - headerHeight, 520);
      setCanvasViewportHeight(nextHeight);
    };

    updateCanvasViewport();
    window.addEventListener("resize", updateCanvasViewport);

    return () => {
      window.removeEventListener("resize", updateCanvasViewport);
    };
  }, []);

  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        router.push("/login");
      } else if (!meetingId) {
        router.push("/dashboard");
      }
    }
  }, [user, authLoading, meetingId, router]);

  useEffect(() => {
    if (!user || !meetingId) return;

    lastSyncedSignatureRef.current = "";
    queuedSyncSignatureRef.current = "";
    autoSyncInFlightRef.current = false;
    setIncomingCanvasSync(null);
    setCanvasSyncStatus("실시간 전사가 canvas 분석 상태에 자동 반영됩니다.");

    const loadMeeting = async () => {
      setLoadingMeeting(true);
      try {
        const [{ data: meetingData, error: meetingError }, { data: transcriptData, error: transcriptError }] = await Promise.all([
          supabase.from("meetings").select("title").eq("id", meetingId).single(),
          supabase.from("transcripts").select("id, speaker, text, timestamp, created_at").eq("meeting_id", meetingId).order("created_at", { ascending: true }),
        ]);

        if (meetingError) throw meetingError;
        if (transcriptError) throw transcriptError;

        setMeetingTitle(meetingData?.title || "회의 워크스페이스");
        setTranscripts(
          dedupeTranscripts(
            (transcriptData || []).map((row) => ({
              id: String(row.id),
              speaker: row.speaker || "알 수 없음",
              text: row.text || "",
              timestamp: row.timestamp || row.created_at || new Date().toISOString(),
            })),
          ),
        );
      } catch (error) {
        console.error("Failed to load meeting context:", error);
      } finally {
        setLoadingMeeting(false);
      }
    };

    void loadMeeting();
  }, [user, meetingId]);

  useEffect(() => {
    if (!user || !meetingId) return;

    const wsClient = new WebSocketClient(meetingId, user.id);
    wsClientRef.current = wsClient;

    wsClient.on("transcript", (message: any) => {
      const payload = message?.data ?? message;
      setTranscripts((prev) =>
        dedupeTranscripts([
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            speaker: payload.speaker || "알 수 없음",
            text: payload.text || "",
            timestamp: payload.timestamp || new Date().toISOString(),
          },
        ]),
      );
    });

    wsClient.on("analysis_update", (message: any) => {
      const payload = message?.data ?? message;
      if (!payload) return;
      if (payload.agenda_outcomes || payload.analysis) {
        const normalizedState = payload.analysis ? payload : ({ analysis: payload } as MeetingState);
        const mapped = mapAnalysisToUi(normalizedState);
        setAnalysisState(normalizedState);
        setAgendas(mapped.agendas);
        setDecisions(mapped.decisions);
        setActionItems(mapped.actionItems);
      }
    });

    wsClient.on("canvas_sync", (message: any) => {
      const payload = (message?.data ?? message?.workspace ?? message) as CanvasRealtimeSyncPayload | null;
      if (!payload || payload.meeting_id !== meetingId) return;
      setIncomingCanvasSync(payload);
    });

    wsClient.connect();
    setWsConnected(true);

    return () => {
      wsClient.disconnect();
      setWsConnected(false);
    };
  }, [user, meetingId]);

  const syncBackendFromMeeting = async (analyze = true) => {
    const currentMeetingTitle = meetingTitleRef.current;
    const currentTranscripts = transcriptsRef.current;
    const state = await syncTranscript({
      meeting_goal: currentMeetingTitle,
      window_size: 12,
      reset_state: true,
      auto_analyze: analyze,
      transcript: currentTranscripts.map((row) => ({
        speaker: row.speaker,
        text: row.text,
        timestamp: row.timestamp,
      })),
    });
    setAnalysisState(state);
    if (analyze) {
      const mapped = mapAnalysisToUi(state);
      setAgendas(mapped.agendas);
      setDecisions(mapped.decisions);
      setActionItems(mapped.actionItems);
    }
    return state;
  };

  const transcriptSyncSignature = useMemo(
    () =>
      [
        meetingTitle,
        ...transcripts.map((row) => `${row.speaker}\u0001${row.text}\u0001${row.timestamp}`),
      ].join("\u0002"),
    [meetingTitle, transcripts],
  );

  const runAutoSync = async (signature: string) => {
    if (!meetingId || lastSyncedSignatureRef.current === signature) {
      return;
    }

    if (autoSyncInFlightRef.current) {
      queuedSyncSignatureRef.current = signature;
      return;
    }

    autoSyncInFlightRef.current = true;
    setAutoSyncing(true);
    setCanvasSyncStatus(
      transcriptsRef.current.length > 0
        ? "새 전사를 canvas 분석 상태에 자동 반영하는 중입니다."
        : "회의 상태를 canvas에 자동 반영하는 중입니다.",
    );

    try {
      const state = await syncBackendFromMeeting(true);
      lastSyncedSignatureRef.current = signature;
      const agendaCount = state?.analysis?.agenda_outcomes?.length || 0;
      if (agendaCount > 0) {
        setCanvasSyncStatus(`실시간 전사가 자동 동기화되었습니다. 안건 ${agendaCount}개가 canvas에 반영되었습니다.`);
      } else if (transcriptsRef.current.length > 0) {
        setCanvasSyncStatus("실시간 전사를 자동 반영했지만 분석된 안건은 아직 없습니다.");
      } else {
        setCanvasSyncStatus("canvas가 현재 회의 상태와 자동 동기화되었습니다.");
      }
    } catch (error) {
      console.error("Failed to auto-sync canvas state:", error);
      setCanvasSyncStatus("실시간 전사를 canvas에 자동 반영하지 못했습니다. 잠시 후 다시 시도합니다.");
    } finally {
      autoSyncInFlightRef.current = false;
      setAutoSyncing(false);

      if (queuedSyncSignatureRef.current && queuedSyncSignatureRef.current !== lastSyncedSignatureRef.current) {
        const nextSignature = queuedSyncSignatureRef.current;
        queuedSyncSignatureRef.current = "";
        if (autoSyncTimerRef.current !== null) {
          window.clearTimeout(autoSyncTimerRef.current);
        }
        autoSyncTimerRef.current = window.setTimeout(() => {
          void runAutoSync(nextSignature);
        }, 0);
      }
    }
  };

  useEffect(() => {
    if (!user || !meetingId || loadingMeeting) return;

    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
    }

    autoSyncTimerRef.current = window.setTimeout(() => {
      void runAutoSync(transcriptSyncSignature);
    }, 1200);

    return () => {
      if (autoSyncTimerRef.current !== null) {
        window.clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, [user, meetingId, loadingMeeting, transcriptSyncSignature]);

  const toggleRecording = async () => {
    if (!user) return;

    if (isRecording) {
      audioRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    if (!audioRecorderRef.current) {
      const recorder = new AudioRecorder();
      const initialized = await recorder.initialize();
      if (!initialized) {
        alert("마이크 접근 권한이 필요합니다.");
        return;
      }
      audioRecorderRef.current = recorder;
    }

    audioRecorderRef.current.start((audioBlob: Blob) => {
      if (wsClientRef.current?.isConnected()) {
        wsClientRef.current.sendAudioChunk(audioBlob, user.email || "Unknown");
      }
    });
    setIsRecording(true);
  };

  const requestAnalysis = async () => {
    try {
      setAnalysisLoading(true);
      await syncBackendFromMeeting(true);
      alert("현재 회의 전사를 기준으로 분석을 갱신했습니다.");
    } catch (error) {
      console.error("Failed to run analysis:", error);
      alert("분석 갱신에 실패했습니다.");
    } finally {
      setAnalysisLoading(false);
    }
  };

  const endMeeting = async () => {
    if (!meetingId) return;
    if (!confirm("회의를 종료하시겠습니까?")) return;

    if (isRecording) {
      audioRecorderRef.current?.stop();
      setIsRecording(false);
    }

    wsClientRef.current?.disconnect();

    try {
      const { error } = await supabase
        .from("meetings")
        .update({
          status: "completed",
          ended_at: new Date().toISOString(),
        })
        .eq("id", meetingId);

      if (error) throw error;
      router.push("/dashboard");
    } catch (error) {
      console.error("Failed to end meeting:", error);
      alert("회의 종료에 실패했습니다.");
    }
  };

  const canvasTranscripts = useMemo<CanvasTranscript[]>(
    () => transcripts.map((item) => ({ ...item })),
    [transcripts],
  );
  const canvasAgendas = useMemo<CanvasAgenda[]>(
    () => agendas.map((item) => ({ ...item })),
    [agendas],
  );

  const broadcastCanvasSync = useCallback((payload: CanvasRealtimeSyncPayload) => {
    wsClientRef.current?.sendMessage("canvas_sync", {
      workspace: payload,
    });
  }, []);

  if (authLoading || !user || !meetingId || loadingMeeting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-4 text-gray-600">로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header ref={headerRef} className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{meetingTitle}</h1>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-sm text-gray-600">Meeting ID: {meetingId.substring(0, 8)}...</p>
                <span className={`inline-block w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-red-500"}`} />
                <span className="text-xs text-gray-500">{wsConnected ? "WebSocket 연결됨" : "WebSocket 연결 안 됨"}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setActiveTab("meeting")} className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${activeTab === "meeting" ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}>
                Meeting
              </button>
              <button onClick={() => setActiveTab("canvas")} className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${activeTab === "canvas" ? "bg-slate-900 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}>
                Canvas
              </button>
              <button onClick={() => router.push("/dashboard")} className="px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl transition font-medium hover:bg-gray-50">
                대시보드로
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className={activeTab === "canvas" ? "flex-1 min-h-0 overflow-y-auto p-0 xl:overflow-hidden" : "max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8"}>
        {activeTab === "canvas" ? (
          <div style={{ minHeight: canvasViewportHeight ?? 520, height: canvasViewportHeight ?? undefined }}>
            <MeetingCanvasTab
              userId={user.id}
              meetingId={meetingId}
              meetingTitle={meetingTitle}
              transcripts={canvasTranscripts}
              agendas={canvasAgendas}
              analysisState={analysisState}
              onSyncFromMeeting={syncBackendFromMeeting}
              incomingSharedCanvasSync={incomingCanvasSync}
              onSharedCanvasSync={broadcastCanvasSync}
              syncStatusText={canvasSyncStatus}
              autoSyncing={autoSyncing}
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1 bg-white rounded-xl shadow-md border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">실시간 전사</h2>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {transcripts.length === 0 ? (
                    <p className="text-gray-500 text-sm">녹음을 시작하면 전사 내용이 여기에 표시됩니다.</p>
                  ) : (
                    transcripts.map((t) => (
                      <div key={t.id} className="bg-blue-50 p-3 rounded-lg">
                        <p className="text-sm text-gray-700">
                          <span className="font-semibold">{t.speaker}:</span> {t.text}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">{new Date(t.timestamp).toLocaleTimeString("ko-KR")}</p>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <button
                    onClick={() => void toggleRecording()}
                    className={`w-full px-4 py-3 rounded-lg font-semibold transition ${
                      isRecording ? "bg-red-600 hover:bg-red-700 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"
                    }`}
                  >
                    {isRecording ? "녹음 중지" : "녹음 시작"}
                  </button>
                </div>
              </div>

              <div className="lg:col-span-1 bg-white rounded-xl shadow-md border border-gray-200 p-6">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <h2 className="text-lg font-semibold text-gray-900">안건 분석</h2>
                  <button
                    onClick={() => void requestAnalysis()}
                    disabled={analysisLoading}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
                  >
                    {analysisLoading ? "분석 중..." : "분석 갱신"}
                  </button>
                </div>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {agendas.length === 0 ? (
                    <p className="text-gray-500 text-sm">분석 갱신 버튼을 누르면 현재 전사를 기준으로 안건을 다시 계산합니다.</p>
                  ) : (
                    agendas.map((agenda, idx) => (
                      <div key={agenda.id} className="border-l-4 border-blue-500 pl-3 py-2">
                        <h3 className="font-semibold text-gray-900">
                          {idx + 1}. {agenda.title}
                        </h3>
                        <div className="mt-2">
                          <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                            agenda.status === "ACTIVE"
                              ? "bg-yellow-100 text-yellow-800"
                              : agenda.status === "CLOSED"
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-600"
                          }`}>
                            {agenda.status}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="lg:col-span-1 space-y-6">
                <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">의사결정</h2>
                  <div className="space-y-3 max-h-48 overflow-y-auto">
                    {decisions.length === 0 ? (
                      <p className="text-gray-500 text-sm">분석 결과가 여기에 표시됩니다.</p>
                    ) : (
                      decisions.map((decision) => (
                        <div key={decision.id} className="bg-green-50 p-3 rounded-lg border border-green-200">
                          <p className="text-sm text-gray-700">{decision.text}</p>
                          <div className="mt-2">
                            <span className={`inline-block px-2 py-1 text-xs rounded-full ${decision.status === "approved" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                              {decision.status === "approved" ? "✓ 승인" : "대기 중"}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">액션 아이템</h2>
                  <div className="space-y-3 max-h-48 overflow-y-auto">
                    {actionItems.length === 0 ? (
                      <p className="text-gray-500 text-sm">분석 결과가 여기에 표시됩니다.</p>
                    ) : (
                      actionItems.map((item) => (
                        <div key={item.id} className="p-3 border border-gray-200 rounded-lg">
                          <p className="text-sm text-gray-700 font-medium">{item.task}</p>
                          <p className="text-xs text-gray-500 mt-1">담당: {item.owner}</p>
                          <p className="text-xs text-gray-500">기한: {item.due_date}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 bg-white rounded-xl shadow-md border border-gray-200 p-6">
              <div className="flex justify-center gap-4">
                <button onClick={() => void requestAnalysis()} disabled={analysisLoading} className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition disabled:opacity-60">
                  분석 갱신
                </button>
                <button onClick={endMeeting} className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition">
                  회의 종료
                </button>
                <button onClick={() => setActiveTab("canvas")} className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-semibold transition">
                  Canvas 열기
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
