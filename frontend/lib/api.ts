import type {
  AgendaMarkdownExportResponse,
  AgendaSnapshotExportResponse,
  AgendaSnapshotImportResponse,
  CanvasNodePositionsByStage,
  CanvasPlacementConfirmResponse,
  CanvasPersonalNotesStateResponse,
  CanvasWorkspacePatchRequest,
  CanvasProblemConclusionResponse,
  CanvasProblemDefinitionResponse,
  CanvasSolutionStageResponse,
  CanvasWorkspaceProblemGroup,
  CanvasWorkspaceStateResponse,
  LastLlmJsonResponse,
  LlmStatus,
  MeetingState,
  MeetingGoalSuggestionResponse,
} from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");

function apiPath(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiPath(path), init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch: ${apiPath(path)} - ${msg}`);
  }
  return parse<T>(res);
}

export async function getState(): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/state", { cache: "no-store" });
}

export async function getLlmStatus(): Promise<LlmStatus> {
  return requestJson<LlmStatus>("/api/llm/status", { cache: "no-store" });
}

export async function getLastLlmJson(): Promise<LastLlmJsonResponse> {
  return requestJson<LastLlmJsonResponse>("/api/analysis/last-llm-json", { cache: "no-store" });
}

export async function saveConfig(payload: {
  meeting_goal: string;
  window_size: number;
}): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/config", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function addUtterance(payload: {
  speaker: string;
  text: string;
  timestamp?: string;
}): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/transcript/manual", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function syncTranscript(payload: {
  meeting_goal: string;
  window_size?: number;
  reset_state?: boolean;
  auto_analyze?: boolean;
  transcript: Array<{
    speaker: string;
    text: string;
    timestamp?: string;
  }>;
}): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/transcript/sync", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      meeting_goal: payload.meeting_goal,
      window_size: payload.window_size ?? 12,
      reset_state: payload.reset_state ?? true,
      auto_analyze: payload.auto_analyze ?? true,
      transcript: payload.transcript,
    }),
  });
}

export async function tickAnalysis(): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/analysis/tick", { method: "POST" });
}

export async function confirmCanvasPlacement(payload: {
  tool: string;
  ui_x: number;
  ui_y: number;
  flow_x: number;
  flow_y: number;
  agenda_id?: string;
  point_id?: string;
  title?: string;
  body?: string;
}): Promise<CanvasPlacementConfirmResponse> {
  return requestJson<CanvasPlacementConfirmResponse>("/api/canvas/placement-confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function generateCanvasProblemDefinition(payload: {
  meeting_id: string;
  topic: string;
  agendas: Array<{
    agenda_id: string;
    title: string;
    keywords: string[];
    summary_bullets: string[];
  }>;
  ideas: Array<{
    id: string;
    agenda_id: string;
    kind: string;
    title: string;
    body: string;
  }>;
}): Promise<CanvasProblemDefinitionResponse> {
  return requestJson<CanvasProblemDefinitionResponse>("/api/canvas/problem-definition", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function generateProblemGroupConclusion(payload: {
  meeting_id: string;
  meeting_topic: string;
  group: {
    group_id: string;
    topic: string;
    insight_lens?: string;
    agenda_titles: string[];
    source_summary_items: string[];
    ideas: Array<{
      id: string;
      kind: string;
      title: string;
      body: string;
    }>;
  };
}): Promise<CanvasProblemConclusionResponse> {
  return requestJson<CanvasProblemConclusionResponse>("/api/canvas/problem-conclusion", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function generateMeetingGoal(payload: {
  meeting_id: string;
  topic: string;
}): Promise<MeetingGoalSuggestionResponse> {
  return requestJson<MeetingGoalSuggestionResponse>("/api/canvas/meeting-goal", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function generateCanvasSolutionStage(payload: {
  meeting_id: string;
  meeting_topic: string;
  topics: Array<{
    group_id: string;
    topic_no: number;
    topic: string;
    conclusion: string;
  }>;
}): Promise<CanvasSolutionStageResponse> {
  return requestJson<CanvasSolutionStageResponse>("/api/canvas/solution-stage", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function getCanvasWorkspaceState(meetingId: string): Promise<CanvasWorkspaceStateResponse> {
  const params = new URLSearchParams({ meeting_id: meetingId });
  return requestJson<CanvasWorkspaceStateResponse>(`/api/canvas/workspace-state?${params.toString()}`, {
    cache: "no-store",
  });
}

export async function saveCanvasWorkspaceState(payload: {
  meeting_id: string;
  stage: "ideation" | "problem-definition" | "solution";
  problem_groups: CanvasWorkspaceProblemGroup[];
  solution_topics: CanvasSolutionStageResponse["topics"];
  node_positions?: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
}): Promise<CanvasWorkspaceStateResponse> {
  return requestJson<CanvasWorkspaceStateResponse>("/api/canvas/workspace-state", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function saveCanvasWorkspacePatch(
  payload: CanvasWorkspacePatchRequest,
): Promise<CanvasWorkspaceStateResponse> {
  return requestJson<CanvasWorkspaceStateResponse>("/api/canvas/workspace-patch", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function getCanvasPersonalNotes(
  meetingId: string,
  userId: string,
): Promise<CanvasPersonalNotesStateResponse> {
  const params = new URLSearchParams({ meeting_id: meetingId, user_id: userId });
  return requestJson<CanvasPersonalNotesStateResponse>(`/api/canvas/personal-notes?${params.toString()}`, {
    cache: "no-store",
  });
}

export async function saveCanvasPersonalNotes(payload: {
  meeting_id: string;
  user_id: string;
  personal_notes: Array<{
    id: string;
    agenda_id: string;
    kind: string;
    title: string;
    body: string;
  }>;
}): Promise<CanvasPersonalNotesStateResponse> {
  return requestJson<CanvasPersonalNotesStateResponse>("/api/canvas/personal-notes", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export async function exportAgendaMarkdown(): Promise<AgendaMarkdownExportResponse> {
  return requestJson<AgendaMarkdownExportResponse>("/api/export/agenda-markdown", { cache: "no-store" });
}

export async function exportAgendaSnapshot(): Promise<AgendaSnapshotExportResponse> {
  return requestJson<AgendaSnapshotExportResponse>("/api/export/agenda-snapshot", { cache: "no-store" });
}

export async function importAgendaSnapshot(payload: {
  file: File;
  reset_state?: boolean;
}): Promise<AgendaSnapshotImportResponse> {
  const form = new FormData();
  form.append("file", payload.file, payload.file.name);
  form.append("reset_state", String(payload.reset_state ?? true));
  return requestJson<AgendaSnapshotImportResponse>("/api/import/agenda-snapshot", {
    method: "POST",
    body: form,
  });
}

export async function resetState(): Promise<MeetingState> {
  return requestJson<MeetingState>("/api/reset", { method: "POST" });
}
