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

type CalibrationState = "idle" | "running" | "done";

interface CalibrationAccumulator {
  chunks: number;
  sumRms: number;
  sumPeak: number;
  sumSpeechRatio: number;
  sumNoiseFloor: number;
}

interface SpeechDetectionProfile {
  rms: number;
  peak: number;
  speechRatio: number;
  noiseFloor: number;
  sampleCount: number;
}

interface SpeechDetectionDecision {
  likely: boolean;
  snr: number;
  thresholds: {
    rms: number;
    peak: number;
    speechRatio: number;
    noiseFloor: number;
  };
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
  const deduped = rows.filter((row) => {
    const key = `${row.speaker}|${row.text}|${row.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return sortTranscriptsByTime(deduped);
}

function buildTranscriptSyncSignature(meetingGoal: string, rows: Transcript[]) {
  return [meetingGoal, ...rows.map((row) => `${row.speaker}\u0001${row.text}\u0001${row.timestamp}`)].join("\u0002");
}

function getTranscriptTime(row: Transcript) {
  const parsed = Date.parse(row.timestamp || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortTranscriptsByTime(rows: Transcript[]) {
  return [...rows].sort((a, b) => {
    const timeDelta = getTranscriptTime(a) - getTranscriptTime(b);
    if (timeDelta !== 0) return timeDelta;
    return a.id.localeCompare(b.id);
  });
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

  return { agendas };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getMessagePayload(message: unknown) {
  if (!isRecord(message)) return message;
  return message.data ?? message;
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getSpeechDetectionDecision(
  metrics: RecordedAudioChunk["metrics"],
  profile: SpeechDetectionProfile | null,
): SpeechDetectionDecision {
  const noiseFloor = Math.max(metrics.noiseFloor || 0, profile?.noiseFloor || 0, 0.0005);
  const baselineRms = Math.max(profile?.rms || noiseFloor, noiseFloor);
  const baselinePeak = Math.max(profile?.peak || noiseFloor * 6, noiseFloor * 6);
  const baselineSpeechRatio = Math.max(profile?.speechRatio || 0, 0);

  const rmsThreshold = Math.max(0.0018, Math.min(0.0045, Math.max(noiseFloor * 2.6, baselineRms * 1.8)));
  const peakThreshold = Math.max(0.012, Math.min(0.04, Math.max(noiseFloor * 8, baselinePeak * 1.6)));
  const speechRatioThreshold = Math.max(0.012, Math.min(0.045, baselineSpeechRatio * 1.8));
  const snr = metrics.rms / noiseFloor;

  return {
    likely:
      metrics.rms >= rmsThreshold ||
      metrics.peak >= peakThreshold ||
      metrics.speechRatio >= speechRatioThreshold ||
      (snr >= 2.4 && metrics.peak >= 0.01),
    snr,
    thresholds: {
      rms: rmsThreshold,
      peak: peakThreshold,
      speechRatio: speechRatioThreshold,
      noiseFloor,
    },
  };
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const meetingId = searchParams.get("meeting_id");

  const [meetingTitle, setMeetingTitle] = useState("회의 워크스페이스");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [analysisState, setAnalysisState] = useState<MeetingState | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [loadingMeeting, setLoadingMeeting] = useState(true);
  const [canvasSyncStatus, setCanvasSyncStatus] = useState("실시간 전사가 canvas 분석 상태에 자동 반영됩니다.");
  const [autoSyncing] = useState(false);
  const [incomingCanvasSync, setIncomingCanvasSync] = useState<CanvasRealtimeSyncPayload | null>(null);
  const [incomingCanvasStateRequestId, setIncomingCanvasStateRequestId] = useState("");
  const [calibrationState, setCalibrationState] = useState<CalibrationState>("idle");
  const [calibrationSecondsLeft, setCalibrationSecondsLeft] = useState(0);
  const [fusionSelectedUserId, setFusionSelectedUserId] = useState<string | null>(null);
  const [fusionSelectedSpeaker, setFusionSelectedSpeaker] = useState<string>("");
  const [liveSpeechPreview, setLiveSpeechPreview] = useState<LiveSpeechPreview | null>(null);
  const [sttProgressText, setSttProgressText] = useState("");
  const [audioImportJob, setAudioImportJob] = useState<AudioImportJobStatusResponse | null>(null);
  const [audioImportRevision, setAudioImportRevision] = useState(0);

  const wsClientRef = useRef<WebSocketClient | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const isRecordingRef = useRef(isRecording);
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
  const deviceCalibratedRef = useRef(false);
  const speechDetectionProfileRef = useRef<SpeechDetectionProfile | null>(null);
  const liveSpeechClearTimerRef = useRef<number | null>(null);
  const audioImportPollTimerRef = useRef<number | null>(null);
  const lastSttStatusLogAtRef = useRef(0);
  const lastGatewayChunkLogAtRef = useRef(0);

  useEffect(() => {
    meetingTitleRef.current = meetingTitle;
  }, [meetingTitle]);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

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
    setSttProgressText("");
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
          supabase.from("transcripts").select("id, speaker, text, timestamp, created_at").eq("meeting_id", meetingId).order("timestamp", { ascending: true }),
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

    wsClient.on("transcript_created", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload)) return;
      if (readString(payload.meeting_id) && readString(payload.meeting_id) !== meetingId) return;
      const transcriptPayload = isRecord(payload.transcript) ? payload.transcript : payload;
      const speaker = readString(transcriptPayload.speaker, "알 수 없음");
      const text = readString(transcriptPayload.text);
      if (!text.trim()) return;
      const nextTimestamp = readString(
        transcriptPayload.timestamp || transcriptPayload.created_at,
        new Date().toISOString(),
      );
      const transcriptId = readString(transcriptPayload.id, `${nextTimestamp}-${speaker}-${text}`);
      const audioMetaPayload = isRecord(payload.audio_meta) ? payload.audio_meta : {};
      const audioStartedAt = readString(transcriptPayload.audio_started_at || audioMetaPayload.started_at);
      const audioEndedAt = readString(transcriptPayload.audio_ended_at || audioMetaPayload.ended_at);
      const chunkIndex = readNumber(transcriptPayload.audio_chunk_index || audioMetaPayload.chunk_index, -1);
      const recordingNow = isRecordingRef.current || Boolean(audioRecorderRef.current?.isRecording());
      const summary = readString(payload.summary_text);
      if (summary) {
        console.info("[STT] 서버 요약 발언", summary);
      }
      console.info("[STT] 서버 전사 수신", {
        id: transcriptId,
        speaker,
        text,
        timestamp: nextTimestamp,
        audioStartedAt,
        audioEndedAt,
        chunkIndex,
        recording: recordingNow,
        elapsedMs: payload.stt_elapsed_ms,
        backendElapsedMs: payload.backend_elapsed_ms,
        originalDurationMs: audioMetaPayload.original_duration_ms,
        removedSilenceMs: audioMetaPayload.removed_silence_ms,
        combinedChunkCount: audioMetaPayload.combined_chunk_count,
      });
      setTranscripts((prev) =>
        dedupeTranscripts([
          ...prev,
          {
            id: transcriptId,
            speaker,
            text,
            timestamp: nextTimestamp,
          },
        ]),
      );
      showLiveSpeechPreview(speaker, text, nextTimestamp);
    });

    wsClient.on("stt_summary_updated", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload)) return;
      if (readString(payload.meeting_id) && readString(payload.meeting_id) !== meetingId) return;
      const summary = isRecord(payload.summary) ? payload.summary : {};
      const text = readString(summary.text || payload.summary_text);
      if (!text.trim()) return;
      setSttProgressText(text);
    });

    wsClient.on("stt_debug", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload)) return;
      const stage = readString(payload.stage);
      const now = Date.now();

      if (stage === "audio_chunk_received" || stage === "audio_chunk_queued") {
        if (now - lastGatewayChunkLogAtRef.current < 5000) return;
        lastGatewayChunkLogAtRef.current = now;
        console.info("[STT] gateway가 오디오를 받는 중", {
          stage,
          bytes: readNumber(payload.bytes),
          fusionWaitMs: readNumber(payload.fusion_wait_ms),
          audioMeta: payload.audio_meta,
        });
        return;
      }

      if (stage === "audio_candidate_selected") {
        console.info("[STT] gateway 후보 선택 완료", {
          bucketId: payload.bucket_id,
          candidateCount: payload.candidate_count,
          bytes: payload.bytes,
          fusionWaitMs: readNumber(payload.fusion_wait_ms),
          audioMeta: payload.audio_meta,
        });
        return;
      }

      if (stage === "audio_candidate_dropped") {
        console.warn("[STT] gateway가 오디오를 음성 아님으로 버림", {
          reason: payload.reason,
          fusionWaitMs: readNumber(payload.fusion_wait_ms),
          thresholds: payload.thresholds,
          candidates: payload.candidates,
        });
        return;
      }

      if (stage === "transcription_audio_prepared") {
        const audioMeta = isRecord(payload.audio_meta) ? payload.audio_meta : {};
        console.info("[STT] STT WAV 청크 준비 완료", {
          bucketId: payload.bucket_id,
          bytes: payload.bytes,
          audioMime: payload.audio_mime,
          fusionWaitMs: readNumber(payload.fusion_wait_ms),
          originalDurationMs: audioMeta.original_duration_ms,
          removedSilenceMs: audioMeta.removed_silence_ms,
          combinedChunkCount: audioMeta.combined_chunk_count,
          audioMeta: payload.audio_meta,
        });
        return;
      }

      if (stage === "transcription_audio_buffered") {
        return;
      }

      if (stage === "transcription_started") {
        console.info("[STT] backend Whisper 전사 시작", {
          bucketId: payload.bucket_id,
          backendUrl: payload.backend_url,
        });
        return;
      }

      if (stage === "transcription_empty") {
        console.warn("[STT] backend 전사 결과가 비어 있음", {
          status: payload.status,
          statusCode: payload.status_code,
          error: payload.error,
          bytes: payload.bytes,
          elapsedMs: payload.elapsed_ms,
          backendElapsedMs: payload.backend_elapsed_ms,
          audioMeta: payload.audio_meta,
        });
        return;
      }

      if (stage === "transcript_saved") {
        console.info("[STT] 전사 저장 완료", {
          preview: payload.text_preview,
          length: payload.text_length,
          elapsedMs: payload.elapsed_ms,
          backendElapsedMs: payload.backend_elapsed_ms,
        });
        return;
      }

      if (stage === "transcript_save_failed") {
        console.warn("[STT] 전사 DB 저장 실패", {
          preview: payload.text_preview,
          length: payload.text_length,
          bucketId: payload.bucket_id,
        });
      }
    });

    wsClient.on("analysis_update", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload)) return;
      if (payload.agenda_outcomes || payload.analysis) {
        const normalizedState = payload.analysis ? (payload as unknown as MeetingState) : ({ analysis: payload } as unknown as MeetingState);
        applyMeetingStateToUi(normalizedState);
      }
    });

    wsClient.on("canvas_sync", (message) => {
      const payload = (message.data ?? message.workspace ?? message) as CanvasRealtimeSyncPayload | null;
      if (!payload || payload.meeting_id !== meetingId) return;
      setIncomingCanvasSync(payload);
    });

    wsClient.on("canvas_state_request", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload) || payload.meeting_id !== meetingId) return;
      if (payload.requested_by === user.id) return;
      setIncomingCanvasStateRequestId(String(payload.request_id || Date.now()));
    });

    wsClient.on("audio_selection", (message) => {
      const payload = getMessagePayload(message);
      if (!isRecord(payload) || payload.meeting_id !== meetingId) return;
      setFusionSelectedUserId(readString(payload.selected_user_id) || null);
      setFusionSelectedSpeaker(readString(payload.speaker));
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
    const sampleCount = Math.max(stats.chunks, 1);
    const avgRms = stats.chunks > 0 ? stats.sumRms / sampleCount : 0.0045;
    const avgPeak = stats.chunks > 0 ? stats.sumPeak / sampleCount : 0.04;
    const avgSpeechRatio = stats.chunks > 0 ? stats.sumSpeechRatio / sampleCount : 0.045;
    const avgNoiseFloor = stats.chunks > 0 ? stats.sumNoiseFloor / sampleCount : 0.0015;
    const profile: SpeechDetectionProfile = {
      rms: avgRms,
      peak: avgPeak,
      speechRatio: avgSpeechRatio,
      noiseFloor: avgNoiseFloor,
      sampleCount: stats.chunks,
    };
    speechDetectionProfileRef.current = profile;

    if (stats.chunks === 0) {
      console.info("[STT] mic calibration finished before first audio chunk; using fallback profile");
    }

    if (wsClientRef.current?.isConnected()) {
      console.info("[STT] mic calibration finished", {
        rms: profile.rms,
        peak: profile.peak,
        speechRatio: profile.speechRatio,
        noiseFloor: profile.noiseFloor,
        sampleCount: profile.sampleCount,
      });
      wsClientRef.current.sendMessage("mic_calibration", {
        profile: {
          rms: profile.rms,
          peak: profile.peak,
          speech_ratio: profile.speechRatio,
          noise_floor: profile.noiseFloor,
          sample_count: profile.sampleCount,
        },
      });
    }
    deviceCalibratedRef.current = true;

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
    deviceCalibratedRef.current = false;
    setCalibrationState("running");
    setCalibrationSecondsLeft(4);

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

  const accumulateCalibrationMetrics = useCallback((metrics: RecordedAudioChunk["metrics"]) => {
    if (!calibrationActiveRef.current && deviceCalibratedRef.current) {
      return;
    }
    calibrationAccumulatorRef.current.chunks += 1;
    calibrationAccumulatorRef.current.sumRms += metrics.rms;
    calibrationAccumulatorRef.current.sumPeak += metrics.peak;
    calibrationAccumulatorRef.current.sumSpeechRatio += metrics.speechRatio;
    calibrationAccumulatorRef.current.sumNoiseFloor += metrics.noiseFloor;
  }, []);

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

  useEffect(() => {
    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = null;
    }

    return () => {
      if (autoSyncTimerRef.current !== null) {
        window.clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, [meetingId]);

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
      recorder.setRecordingInterval(7000);
      recorder.setMeterCallback(accumulateCalibrationMetrics);
      audioRecorderRef.current = recorder;
    } else {
      audioRecorderRef.current.setRecordingInterval(7000);
      audioRecorderRef.current.setMeterCallback(accumulateCalibrationMetrics);
    }

    beginCalibration();
    console.info("[STT] 녹음 파이프라인 시작", {
      intervalMs: 7000,
      mode: "pcm-wav-chunk",
      wsConnected: wsClientRef.current?.isConnected() || false,
    });
    audioRecorderRef.current.start(({ blob, metrics }: RecordedAudioChunk) => {
      const calibrated = deviceCalibratedRef.current;
      console.info("[STT] STT WAV 청크 생성", {
        bytes: blob.size,
        chunkIndex: metrics.chunkIndex,
        durationMs: metrics.durationMs,
        originalDurationMs: metrics.originalDurationMs,
        removedSilenceMs: metrics.removedSilenceMs,
        combinedChunkCount: metrics.combinedChunkCount,
        trimmedFromSilence: metrics.trimmedFromSilence,
        rms: metrics.rms,
        peak: metrics.peak,
        speechRatio: metrics.speechRatio,
        calibrated,
        calibrationActive: calibrationActiveRef.current,
      });
      if (calibrationActiveRef.current || !calibrated) {
        return;
      }
      const speechDecision = getSpeechDetectionDecision(metrics, speechDetectionProfileRef.current);
      if (!speechDecision.likely) {
        const now = Date.now();
        if (now - lastSttStatusLogAtRef.current > 5000) {
          lastSttStatusLogAtRef.current = now;
          console.info("[STT] 듣는 중 - 무음으로 판단해서 전송하지 않음", {
            rms: metrics.rms,
            peak: metrics.peak,
            speechRatio: metrics.speechRatio,
            snr: speechDecision.snr,
            thresholds: speechDecision.thresholds,
            profile: speechDetectionProfileRef.current,
          });
        }
        return;
      }
      if (wsClientRef.current?.isConnected()) {
        console.info("[STT] 음성 감지 - 전사 요청 전송", {
          rms: metrics.rms,
          peak: metrics.peak,
          speechRatio: metrics.speechRatio,
          snr: speechDecision.snr,
          thresholds: speechDecision.thresholds,
          chunkIndex: metrics.chunkIndex,
          durationMs: metrics.durationMs,
          originalDurationMs: metrics.originalDurationMs,
          removedSilenceMs: metrics.removedSilenceMs,
          combinedChunkCount: metrics.combinedChunkCount,
          bytes: blob.size,
        });
        wsClientRef.current.sendAudioChunk(blob, user.email || "Unknown", metrics);
      } else {
        console.warn("[STT] audio chunk not sent because WebSocket is disconnected", {
          bytes: blob.size,
          metrics,
        });
      }
    });
    setIsRecording(true);
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
      <div className="flex min-h-screen items-center justify-center bg-[#eaf0f7]">
        <div className="rounded-[28px] border border-white/70 bg-white/85 px-8 py-7 text-center shadow-[0_24px_70px_rgba(15,23,42,0.12)] backdrop-blur-xl">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-[3px] border-cyan-100 border-t-[#10243f]" />
          <p className="mt-4 text-sm font-medium text-slate-600">로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-white">
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
        isRecording={isRecording}
        onToggleRecording={toggleRecording}
        onStopRecording={toggleRecording}
        onEndMeeting={endMeeting}
        sttProgressText={sttProgressText}
        recordingStatusText={
          calibrationState === "running"
            ? `마이크 캘리브레이션 ${calibrationSecondsLeft}s`
            : fusionSelectedUserId === user.id
            ? "내 마이크가 현재 선택됨"
            : fusionSelectedUserId
            ? `${fusionSelectedSpeaker || "다른 화자"} 마이크 선택 중`
            : wsConnected
            ? "WebSocket 연결됨"
            : "WebSocket 연결 안 됨"
        }
      />
    </div>
  );
}

function HomeFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eaf0f7]">
      <div className="rounded-[28px] border border-white/70 bg-white/85 px-8 py-7 text-center shadow-[0_24px_70px_rgba(15,23,42,0.12)] backdrop-blur-xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-[3px] border-cyan-100 border-t-[#10243f]" />
        <p className="mt-4 text-sm font-medium text-slate-600">워크스페이스를 불러오는 중...</p>
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
