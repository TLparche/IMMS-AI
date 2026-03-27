export interface TranscriptUtterance {
  speaker: string;
  text: string;
  timestamp: string;
}

export interface AgendaItem {
  title: string;
  status: "PROPOSED" | "ACTIVE" | "CLOSING" | "CLOSED";
}

export interface LlmStatus {
  provider: string;
  model: string;
  base_url: string;
  mode: "mock" | "live";
  api_key_present: boolean;
  connected: boolean;
  note: string;
  request_count?: number;
  success_count?: number;
  error_count?: number;
  last_operation?: string;
  last_request_at?: string;
  last_success_at?: string;
  last_error?: string;
  last_error_at?: string;
  last_raw_preview?: string;
  last_finish_reason?: string;
}

export interface AgendaActionReason {
  turn_id?: number;
  speaker: string;
  timestamp: string;
  quote: string;
  why: string;
}

export interface AgendaActionItemDetail {
  item: string;
  owner: string;
  due: string;
  reasons: AgendaActionReason[];
}

export interface AgendaDecisionDetail {
  opinions: string[];
  conclusion: string;
}

export interface AgendaOutcomeDetail {
  agenda_id?: string;
  agenda_title: string;
  agenda_state?: string;
  flow_type?: string;
  key_utterances: string[];
  agenda_summary_items?: string[];
  summary: string;
  summary_references?: AgendaActionReason[];
  agenda_keywords: string[];
  opinion_groups?: Array<{
    type?: "proposal" | "concern" | "question" | "agree" | "disagree" | "info" | string;
    summary?: string;
    evidence_turn_ids?: number[];
  }>;
  decision_results: AgendaDecisionDetail[];
  action_items: AgendaActionItemDetail[];
  start_turn_id?: number;
  end_turn_id?: number;
}

export interface AnalysisOutput {
  agenda: {
    active: { title: string; confidence: number };
    candidates: Array<{ title: string; confidence: number }>;
  };
  agenda_outcomes: AgendaOutcomeDetail[];
  evidence_gate: {
    claims: Array<{ claim: string; verifiability: number; note: string }>;
  };
}

export interface MeetingState {
  meeting_goal: string;
  initial_context: string;
  window_size: number;
  transcript: TranscriptUtterance[];
  agenda_stack: AgendaItem[];
  llm_enabled?: boolean;
  llm_status?: LlmStatus;
  llm_io_logs?: Array<{
    seq?: number;
    at?: string;
    direction?: "request" | "response" | "error" | string;
    stage?: string;
    payload?: string;
    meta?: Record<string, unknown>;
  }>;
  replay?: {
    queued_total?: number;
    queued_cursor?: number;
    queued_remaining?: number;
    done?: boolean;
    source?: string;
    loaded_at?: string;
  };
  analysis_runtime?: {
    tick_mode?: "full_context" | "full_document" | "windowed";
    transcript_count?: number;
    llm_window_turns?: number;
    engine_window_turns?: number;
    control_plane_source?: string;
    control_plane_reason?: string;
    used_local_fallback?: boolean;
    title_refine_attempts?: number;
    title_refine_success?: number;
    last_llm_json_available?: boolean;
    last_llm_json_at?: string;
    llm_io_count?: number;
    analysis_worker?: {
      inflight?: boolean;
      queued?: number;
      queued_logical?: number;
      queued_observed?: number;
      last_enqueued_id?: number;
      last_started_id?: number;
      last_done_id?: number;
      last_enqueued_at?: string;
      last_started_at?: string;
      last_done_at?: string;
      last_error?: string;
    };
  };
  analysis: AnalysisOutput | null;
}

export interface LastLlmJsonResponse {
  ok: boolean;
  received_at?: string;
  has_json: boolean;
  json: Record<string, unknown>;
}

export interface AgendaMarkdownExportResponse {
  ok: boolean;
  filename: string;
  agenda_count: number;
  transcript_count: number;
  markdown: string;
}

export interface AgendaSnapshotExportResponse {
  ok: boolean;
  filename: string;
  agenda_count: number;
  transcript_count: number;
  snapshot: Record<string, unknown>;
}

export interface AgendaSnapshotImportResponse {
  ok: boolean;
  state: MeetingState;
  import_debug: {
    filename: string;
    meeting_goal: string;
    transcript_count: number;
    agenda_count: number;
    reset_state: boolean;
  };
}

export interface CanvasProblemDefinitionGroup {
  group_id: string;
  topic: string;
  insight_lens?: string;
  insight_user_edited?: boolean;
  keywords: string[];
  agenda_ids: string[];
  agenda_titles: string[];
  ideas: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
  }>;
  source_summary_items: string[];
  conclusion: string;
  conclusion_user_edited?: boolean;
}

export interface CanvasProblemDefinitionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  groups: CanvasProblemDefinitionGroup[];
}

export interface CanvasPersonalNote {
  id: string;
  agenda_id: string;
  kind: string;
  title: string;
  body: string;
}

export interface CanvasProblemConclusionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  group_id: string;
  insight_lens?: string;
  conclusion: string;
}

export interface CanvasWorkspaceProblemGroup {
  group_id: string;
  topic: string;
  insight_lens?: string;
  insight_user_edited?: boolean;
  keywords: string[];
  agenda_ids: string[];
  agenda_titles: string[];
  ideas: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
  }>;
  source_summary_items: string[];
  conclusion: string;
  conclusion_user_edited?: boolean;
  status?: "draft" | "review" | "final" | string;
}

export interface CanvasNodePosition {
  x: number;
  y: number;
}

export interface CanvasNodePositionsByStage {
  ideation?: Record<string, CanvasNodePosition>;
  "problem-definition"?: Record<string, CanvasNodePosition>;
  solution?: Record<string, CanvasNodePosition>;
}

export interface CanvasWorkspaceStateResponse {
  ok: boolean;
  meeting_id: string;
  stage: "ideation" | "problem-definition" | "solution";
  problem_groups: CanvasWorkspaceProblemGroup[];
  solution_topics: CanvasSolutionTopicResponse[];
  node_positions?: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
  saved_at?: string;
}

export interface CanvasWorkspacePatchRequest {
  meeting_id: string;
  stage?: "ideation" | "problem-definition" | "solution";
  problem_groups?: CanvasWorkspaceProblemGroup[];
  solution_topics?: CanvasSolutionTopicResponse[];
  node_positions?: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
}

export interface CanvasPersonalNotesStateResponse {
  ok: boolean;
  meeting_id: string;
  user_id: string;
  personal_notes: CanvasPersonalNote[];
  saved_at?: string;
}

export interface CanvasRealtimeSyncPayload {
  sync_id: string;
  meeting_id: string;
  updated_by: string;
  updated_at: string;
  stage: "ideation" | "problem-definition" | "solution";
  problem_groups: CanvasWorkspaceProblemGroup[];
  solution_topics: CanvasSolutionTopicResponse[];
  node_positions: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
}

export interface MeetingGoalSuggestionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  topic: string;
  goal: string;
}

export interface CanvasPlacementConfirmResponse {
  ok: boolean;
  saved_at: string;
  draft: {
    tool: string;
    ui_x: number;
    ui_y: number;
    flow_x: number;
    flow_y: number;
    agenda_id?: string;
    point_id?: string;
    title?: string;
    body?: string;
    saved_at: string;
  };
  state: MeetingState;
}

export interface CanvasSolutionTopicResponse {
  group_id: string;
  topic_no: number;
  topic: string;
  conclusion: string;
  ideas: string[];
  status?: "draft" | "review" | "final" | string;
  problem_topic?: string;
  problem_insight?: string;
  problem_conclusion?: string;
  problem_keywords?: string[];
  agenda_titles?: string[];
  ai_suggestions?: Array<{
    id: string;
    text: string;
    status?: "draft" | "selected" | "dismissed" | string;
  }>;
  notes?: Array<{
    id: string;
    text: string;
    source?: "ai" | "user" | string;
    source_ai_id?: string;
    is_final_candidate?: boolean;
    final_comment?: string;
  }>;
}

export interface CanvasSolutionStageResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  topics: CanvasSolutionTopicResponse[];
}
