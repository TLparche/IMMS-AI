"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter, useSearchParams } from "next/navigation";
import { WebSocketClient } from "@/lib/websocket";
import { AudioRecorder, type RecordedAudioChunk } from "@/lib/audio-recorder";
import { supabase } from "@/lib/supabase";
import { getAudioImportJobStatus, getCanvasWorkspaceState, startAudioImportJob, syncTranscript } from "@/lib/api";
import type { AudioImportJobStatusResponse, CanvasRealtimeSyncPayload, MeetingState } from "@/lib/types";
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
type CalibrationState = "idle" | "running" | "done";

interface CalibrationAccumulator {
  chunks: number;
  sumRms: number;
  sumPeak: number;
  sumSpeechRatio: number;
  sumNoiseFloor: number;
}

export interface LiveSpeechPreview {
  speaker: string;
  text: string;
  timestamp: string;
}

function createCalibrationAccumulator(): CalibrationAccumulator {
  return {
    chunks: 0,
    sumRms: 0,
    sumPeak: 0,
    sumSpeechRatio: 0,
    sumNoiseFloor: 0,
  };
}

function dedupeTranscripts(rows: Transcript[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.speaker}|${row.text}|${row.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTranscriptSyncSignature(meetingGoal: string, rows: Transcript[]) {
  return [meetingGoal, ...rows.map((row) => `${row.speaker}\u0001${row.text}\u0001${row.timestamp}`)].join("\u0002");
}

function mapMeetingStateToTranscriptRows(state: MeetingState): Transcript[] {
  return dedupeTranscripts(
    (state.transcript || []).map((row, index) => ({
      id: `import-${index}-${row.timestamp || Date.now()}`,
      speaker: row.speaker || "알 수 없음",
      text: row.text || "",
      timestamp: row.timestamp || new Date().toISOString(),
    })),
  );
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

function HomeContent() {
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
  const [incomingCanvasStateRequestId, setIncomingCanvasStateRequestId] = useState("");
  const [calibrationState, setCalibrationState] = useState<CalibrationState>("idle");
  const [calibrationSecondsLeft, setCalibrationSecondsLeft] = useState(0);
  const [fusionSelectedUserId, setFusionSelectedUserId] = useState<string | null>(null);
  const [fusionSelectedSpeaker, setFusionSelectedSpeaker] = useState<string>("");
  const [deviceCalibrated, setDeviceCalibrated] = useState(false);
  const [liveSpeechPreview, setLiveSpeechPreview] = useState<LiveSpeechPreview | null>(null);
  const [audioImportJob, setAudioImportJob] = useState<AudioImportJobStatusResponse | null>(null);
  const [audioImportRevision, setAudioImportRevision] = useState(0);

  const wsClientRef = useRef<WebSocketClient | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const meetingTitleRef = useRef(meetingTitle);
  const transcriptsRef = useRef(transcripts);
  const autoSyncTimerRef = useRef<number | null>(null);
  const autoSyncInFlightRef = useRef(false);
  const queuedSyncSignatureRef = useRef("");
  const lastSyncedSignatureRef = useRef("");
  const calibrationFinishTimerRef = useRef<number | null>(null);
  const calibrationCountdownTimerRef = useRef<number | null>(null);
  const calibrationAccumulatorRef = useRef<CalibrationAccumulator>(createCalibrationAccumulator());
  const calibrationActiveRef = useRef(false);
  const liveSpeechClearTimerRef = useRef<number | null>(null);
  const audioImportPollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    meetingTitleRef.current = meetingTitle;
  }, [meetingTitle]);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  const showLiveSpeechPreview = useCallback((speaker: string, text: string, timestamp: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    setLiveSpeechPreview({
      speaker: speaker || "알 수 없음",
      text: trimmedText,
      timestamp,
    });

    if (liveSpeechClearTimerRef.current !== null) {
      window.clearTimeout(liveSpeechClearTimerRef.current);
    }

    liveSpeechClearTimerRef.current = window.setTimeout(() => {
      setLiveSpeechPreview(null);
      liveSpeechClearTimerRef.current = null;
    }, 5200);
  }, []);

  useEffect(() => {
    return () => {
      if (calibrationFinishTimerRef.current !== null) {
        window.clearTimeout(calibrationFinishTimerRef.current);
      }
      if (calibrationCountdownTimerRef.current !== null) {
        window.clearInterval(calibrationCountdownTimerRef.current);
      }
      if (liveSpeechClearTimerRef.current !== null) {
        window.clearTimeout(liveSpeechClearTimerRef.current);
      }
      if (audioImportPollTimerRef.current !== null) {
        window.clearTimeout(audioImportPollTimerRef.current);
      }
      audioRecorderRef.current?.cleanup();
    };
  }, []);

  const stopAudioImportPolling = useCallback(() => {
    if (audioImportPollTimerRef.current !== null) {
      window.clearTimeout(audioImportPollTimerRef.current);
      audioImportPollTimerRef.current = null;
    }
  }, []);

  const applyMeetingStateToUi = useCallback((state: MeetingState) => {
    const mapped = mapAnalysisToUi(state);
    setAnalysisState(state);
    setAgendas(mapped.agendas);
    setDecisions(mapped.decisions);
    setActionItems(mapped.actionItems);
  }, []);

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
    setIncomingCanvasStateRequestId("");
    setCanvasSyncStatus("실시간 전사가 canvas 분석 상태에 자동 반영됩니다.");
    setAudioImportJob(null);
    setAudioImportRevision(0);
    stopAudioImportPolling();

    const loadMeeting = async () => {
      setLoadingMeeting(true);
      try {
        const [
          { data: meetingData, error: meetingError },
          { data: transcriptData, error: transcriptError },
          workspaceState,
        ] = await Promise.all([
          supabase.from("meetings").select("title").eq("id", meetingId).single(),
          supabase.from("transcripts").select("id, speaker, text, timestamp, created_at").eq("meeting_id", meetingId).order("created_at", { ascending: true }),
          getCanvasWorkspaceState(meetingId).catch(() => null),
        ]);

        if (meetingError) throw meetingError;
        if (transcriptError) throw transcriptError;

        const nextMeetingTitle = meetingData?.title || "회의 워크스페이스";
        const nextTranscripts = dedupeTranscripts(
          (transcriptData || []).map((row) => ({
            id: String(row.id),
            speaker: row.speaker || "알 수 없음",
            text: row.text || "",
            timestamp: row.timestamp || row.created_at || new Date().toISOString(),
          })),
        );

        setMeetingTitle(nextMeetingTitle);
        setTranscripts(nextTranscripts);

        if (workspaceState?.imported_state) {
          applyMeetingStateToUi(workspaceState.imported_state);
          lastSyncedSignatureRef.current = buildTranscriptSyncSignature(nextMeetingTitle, nextTranscripts);
        } else {
          setAnalysisState(null);
          setAgendas([]);
          setDecisions([]);
          setActionItems([]);
          lastSyncedSignatureRef.current = "";
        }
      } catch (error) {
        console.error("Failed to load meeting context:", error);
      } finally {
        setLoadingMeeting(false);
      }
    };

    void loadMeeting();
  }, [user, meetingId, stopAudioImportPolling]);

  useEffect(() => {
    if (!user || !meetingId) return;

    const wsClient = new WebSocketClient(meetingId, user.id);
    wsClientRef.current = wsClient;
    setWsConnected(false);

    wsClient.onConnectionStateChange((connected) => {
      setWsConnected(connected);
    });

    wsClient.on("transcript", (message: any) => {
      const payload = message?.data ?? message;
      const nextTimestamp = payload.timestamp || new Date().toISOString();
      setTranscripts((prev) =>
        dedupeTranscripts([
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            speaker: payload.speaker || "알 수 없음",
            text: payload.text || "",
            timestamp: nextTimestamp,
          },
        ]),
      );
      showLiveSpeechPreview(payload.speaker || "알 수 없음", payload.text || "", nextTimestamp);
    });

    wsClient.on("analysis_update", (message: any) => {
      const payload = message?.data ?? message;
      if (!payload) return;
      if (payload.agenda_outcomes || payload.analysis) {
        const normalizedState = payload.analysis ? payload : ({ analysis: payload } as MeetingState);
        applyMeetingStateToUi(normalizedState);
      }
    });

    wsClient.on("canvas_sync", (message: any) => {
      const payload = (message?.data ?? message?.workspace ?? message) as CanvasRealtimeSyncPayload | null;
      if (!payload || payload.meeting_id !== meetingId) return;
      setIncomingCanvasSync(payload);
    });

    wsClient.on("canvas_state_request", (message: any) => {
      const payload = message?.data ?? message;
      if (!payload || payload.meeting_id !== meetingId) return;
      if (payload.requested_by === user.id) return;
      setIncomingCanvasStateRequestId(String(payload.request_id || Date.now()));
    });

    wsClient.on("audio_selection", (message: any) => {
      const payload = message?.data ?? message;
      if (!payload || payload.meeting_id !== meetingId) return;
      setFusionSelectedUserId(payload.selected_user_id || null);
      setFusionSelectedSpeaker(payload.speaker || "");
    });

    wsClient.connect();

    return () => {
      wsClient.disconnect();
      setWsConnected(false);
    };
  }, [user, meetingId, showLiveSpeechPreview, applyMeetingStateToUi]);

  const finishCalibration = useCallback(() => {
    if (!user) return;

    if (calibrationFinishTimerRef.current !== null) {
      window.clearTimeout(calibrationFinishTimerRef.current);
      calibrationFinishTimerRef.current = null;
    }
    if (calibrationCountdownTimerRef.current !== null) {
      window.clearInterval(calibrationCountdownTimerRef.current);
      calibrationCountdownTimerRef.current = null;
    }

    const stats = calibrationAccumulatorRef.current;
    calibrationActiveRef.current = false;
    if (stats.chunks > 0 && wsClientRef.current?.isConnected()) {
      const avgRms = stats.sumRms / stats.chunks;
      const avgPeak = stats.sumPeak / stats.chunks;
      const avgSpeechRatio = stats.sumSpeechRatio / stats.chunks;
      const avgNoiseFloor = stats.sumNoiseFloor / stats.chunks;

      wsClientRef.current.sendMessage("mic_calibration", {
        profile: {
          rms: avgRms,
          peak: avgPeak,
          speech_ratio: avgSpeechRatio,
          noise_floor: avgNoiseFloor,
          sample_count: stats.chunks,
        },
      });
      setDeviceCalibrated(true);
    }

    setCalibrationState("done");
    setCalibrationSecondsLeft(0);
  }, [user]);

  const beginCalibration = useCallback(() => {
    if (calibrationFinishTimerRef.current !== null) {
      window.clearTimeout(calibrationFinishTimerRef.current);
    }
    if (calibrationCountdownTimerRef.current !== null) {
      window.clearInterval(calibrationCountdownTimerRef.current);
    }

    calibrationAccumulatorRef.current = createCalibrationAccumulator();
    calibrationActiveRef.current = true;
    setCalibrationState("running");
    setCalibrationSecondsLeft(4);
    setDeviceCalibrated(false);

    calibrationCountdownTimerRef.current = window.setInterval(() => {
      setCalibrationSecondsLeft((prev) => {
        if (prev <= 1) {
          if (calibrationCountdownTimerRef.current !== null) {
            window.clearInterval(calibrationCountdownTimerRef.current);
            calibrationCountdownTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    calibrationFinishTimerRef.current = window.setTimeout(() => {
      finishCalibration();
    }, 4000);
  }, [finishCalibration]);

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
    applyMeetingStateToUi(state);
    return state;
  };

  const transcriptSyncSignature = useMemo(
    () => buildTranscriptSyncSignature(meetingTitle, transcripts),
    [meetingTitle, transcripts],
  );

  const pollAudioImportJob = useCallback(
    async (jobId: string) => {
      try {
        const result = await getAudioImportJobStatus(jobId);
        setAudioImportJob(result);

        if (result.status === "completed") {
          stopAudioImportPolling();
          if (result.state) {
            const nextTranscripts = mapMeetingStateToTranscriptRows(result.state);
            setTranscripts(nextTranscripts);
            applyMeetingStateToUi(result.state);
            lastSyncedSignatureRef.current = buildTranscriptSyncSignature(meetingTitleRef.current, nextTranscripts);
            queuedSyncSignatureRef.current = "";
            setAudioImportRevision((prev) => prev + 1);
            setCanvasSyncStatus(
              `오디오 파일을 불러왔습니다. 발화 ${result.transcript_count || nextTranscripts.length}개가 반영되었습니다.`,
            );
          }
          return;
        }

        if (result.status === "error") {
          stopAudioImportPolling();
          setCanvasSyncStatus(result.error || "오디오 파일 처리에 실패했습니다.");
          return;
        }

        setCanvasSyncStatus(
          result.detail || `오디오 파일 처리 중입니다. ${Math.round(result.progress || 0)}%`,
        );
        audioImportPollTimerRef.current = window.setTimeout(() => {
          void pollAudioImportJob(jobId);
        }, 1500);
      } catch (error) {
        console.error("Failed to poll audio import job:", error);
        stopAudioImportPolling();
        setCanvasSyncStatus("오디오 파일 처리 상태를 가져오지 못했습니다.");
      }
    },
    [applyMeetingStateToUi, stopAudioImportPolling],
  );

  const handleAudioImport = useCallback(
    async (file: File) => {
      if (!user || !meetingId) return;
      if (audioImportJob && (audioImportJob.status === "queued" || audioImportJob.status === "processing")) {
        setCanvasSyncStatus("이미 다른 오디오 파일을 처리 중입니다. 완료 후 다시 시도해 주세요.");
        return;
      }

      stopAudioImportPolling();
      setAudioImportJob(null);
      setCanvasSyncStatus(`오디오 파일을 업로드했습니다. ${file.name} 처리 작업을 시작합니다.`);

      const started = await startAudioImportJob({
        meeting_id: meetingId,
        meeting_goal: meetingTitleRef.current,
        user_id: user.id,
        file,
        reset_state: true,
        window_size: 12,
      });

      setAudioImportJob({
        ok: true,
        job_id: started.job_id,
        meeting_id: started.meeting_id,
        filename: started.filename,
        status: started.status,
        progress: 1,
        step: "queued",
        created_at: started.created_at,
        updated_at: started.created_at,
      });
      audioImportPollTimerRef.current = window.setTimeout(() => {
        void pollAudioImportJob(started.job_id);
      }, 600);
    },
    [audioImportJob, meetingId, pollAudioImportJob, stopAudioImportPolling, user],
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
      const recorder = audioRecorderRef.current;
      audioRecorderRef.current = null;
      await recorder?.stopAndCleanup();
      finishCalibration();
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

    beginCalibration();
    audioRecorderRef.current.start(({ blob, metrics }: RecordedAudioChunk) => {
      if (calibrationActiveRef.current || !deviceCalibrated) {
        calibrationAccumulatorRef.current.chunks += 1;
        calibrationAccumulatorRef.current.sumRms += metrics.rms;
        calibrationAccumulatorRef.current.sumPeak += metrics.peak;
        calibrationAccumulatorRef.current.sumSpeechRatio += metrics.speechRatio;
        calibrationAccumulatorRef.current.sumNoiseFloor += metrics.noiseFloor;
      }
      if (wsClientRef.current?.isConnected()) {
        wsClientRef.current.sendAudioChunk(blob, user.email || "Unknown", metrics);
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
      const recorder = audioRecorderRef.current;
      audioRecorderRef.current = null;
      await recorder?.stopAndCleanup();
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
  const audioImportBusy = audioImportJob?.status === "queued" || audioImportJob?.status === "processing";
  const audioImportStatusText = audioImportJob
    ? audioImportJob.status === "completed"
      ? `오디오 불러오기 완료 · 발화 ${audioImportJob.transcript_count || 0}개`
      : audioImportJob.status === "error"
      ? `오디오 불러오기 실패 · ${audioImportJob.error || "처리 중 오류"}`
      : `${audioImportJob.detail || "오디오 파일 처리 중"} · ${Math.round(audioImportJob.progress || 0)}%`
    : "";

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
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <header ref={headerRef} className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{meetingTitle}</h1>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-sm text-gray-600">Meeting ID: {meetingId.substring(0, 8)}...</p>
                <span className={`inline-block w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-red-500"}`} />
                <span className="text-xs text-gray-500">{wsConnected ? "WebSocket 연결됨" : "WebSocket 연결 안 됨"}</span>
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                  calibrationState === "running"
                    ? "bg-amber-100 text-amber-800"
                    : deviceCalibrated
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-100 text-slate-600"
                }`}>
                  {calibrationState === "running"
                    ? `마이크 캘리브레이션 ${calibrationSecondsLeft}s`
                    : deviceCalibrated
                    ? "캘리브레이션 완료"
                    : "캘리브레이션 대기"}
                </span>
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                  fusionSelectedUserId === user.id
                    ? "bg-blue-100 text-blue-800"
                    : fusionSelectedUserId
                    ? "bg-gray-100 text-gray-700"
                    : "bg-slate-100 text-slate-600"
                }`}>
                  {fusionSelectedUserId === user.id
                    ? "내 마이크가 현재 선택됨"
                    : fusionSelectedUserId
                    ? `${fusionSelectedSpeaker || "다른 화자"} 마이크 선택 중`
                    : "선택된 마이크 없음"}
                </span>
              </div>
              {audioImportStatusText ? (
                <p className="mt-2 text-xs text-slate-500">{audioImportStatusText}</p>
              ) : null}
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

      <main className={activeTab === "canvas" ? "flex-1 min-h-0 overflow-hidden p-0" : "max-w-7xl mx-auto w-full flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:px-8"}>
        {activeTab === "canvas" ? (
          <div className="min-h-0" style={{ height: canvasViewportHeight ?? undefined }}>
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
              incomingCanvasStateRequestId={incomingCanvasStateRequestId}
              syncStatusText={canvasSyncStatus}
              autoSyncing={autoSyncing}
              liveSpeechPreview={liveSpeechPreview}
              onImportAudioFile={handleAudioImport}
              audioImportBusy={audioImportBusy}
              audioImportStatusText={audioImportStatusText}
              audioImportRevision={audioImportRevision}
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
                  <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {calibrationState === "running"
                      ? `현재 ${calibrationSecondsLeft}초 동안 주 화자 기준을 학습하고 있습니다. 마이크 가까이에서 자연스럽게 말해 주세요.`
                      : fusionSelectedUserId === user.id
                      ? "현재 내 기기의 입력이 프로젝트 단일 스트림에 채택되고 있습니다."
                      : fusionSelectedUserId
                      ? `${fusionSelectedSpeaker || "다른 화자"} 입력이 현재 선택되고 있습니다.`
                      : "주 화자 선택 정보를 기다리는 중입니다."}
                  </div>
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

function HomeFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">워크스페이스를 불러오는 중...</p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<HomeFallback />}>
      <HomeContent />
    </Suspense>
  );
}
