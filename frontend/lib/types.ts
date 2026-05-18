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

export interface AudioImportJobStartResponse {
  ok: boolean;
  job_id: string;
  meeting_id: string;
  filename: string;
  status: "queued" | "processing" | "completed" | "error" | string;
  created_at: string;
}

export interface AudioImportJobStatusResponse {
  ok: boolean;
  job_id: string;
  meeting_id: string;
  filename: string;
  status: "queued" | "processing" | "completed" | "error" | string;
  progress: number;
  step: string;
  detail?: string;
  created_at: string;
  updated_at: string;
  transcript_count?: number;
  speaker_count?: number;
  used_diarization?: boolean;
  warning?: string;
  error?: string;
  state?: MeetingState | null;
}

export interface CanvasProblemDefinitionGroup {
  group_id: string;
  parent_group_id?: string;
  depth?: number;
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
  discussion_items?: CanvasProblemDiscussionItem[];
  linked_group_ids?: string[];
  evidence_utterance_ids?: string[];
  source_summary_items: string[];
  conclusion: string;
  conclusion_user_edited?: boolean;
  source_signature?: string;
  source_agenda_signatures?: Record<string, string>;
  source_idea_signatures?: Record<string, string>;
}

export interface CanvasProblemDiscussionItem {
  id: string;
  parent_group_id: string;
  target_node_id?: string;
  target_node_label?: string;
  target_node_kind?: "topic" | "idea" | string;
  title: string;
  body: string;
  keywords?: string[];
  key_evidence?: string[];
  refined_utterances?: CanvasRefinedUtterance[];
  evidence_utterance_ids?: string[];
  ignored_utterance_ids?: string[];
  ai_pending?: boolean;
  ai_generated?: boolean;
  user_edited?: boolean;
  created_by?: "ai" | "user" | "";
  created_at?: string;
}

export interface CanvasProblemDefinitionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  groups: CanvasProblemDefinitionGroup[];
}

export interface CanvasProblemTaxonomyResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  groups: CanvasProblemDefinitionGroup[];
}

export interface CanvasPersonalNote {
  id: string;
  project_id?: string;
  agenda_id: string;
  linked_canvas_item_id?: string;
  linked_canvas_item_title?: string;
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

export interface CanvasProblemGroupingRationaleResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  group_id: string;
  rationale: string;
  basis_items: string[];
}

export interface CanvasProblemStructureGroup {
  id: string;
  title: string;
  node_ids: string[];
  rationale: string;
  created_by?: "ai" | "user" | string;
}

export interface CanvasProblemStructureNode {
  id: string;
  source_group_id?: string;
  title: string;
  body: string;
  status?: string;
  depth?: number;
}

export interface CanvasProblemStructureState {
  phase: "explore" | "structure" | string;
  method: "affinity" | "card-sorting" | string;
  mode?: "" | "manual" | "ai" | string;
  nodes: CanvasProblemStructureNode[];
  groups: CanvasProblemStructureGroup[];
}

export interface CanvasProblemStructureResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  groups: CanvasProblemStructureGroup[];
}

export interface CanvasIdeationSuggestion {
  id: string;
  text: string;
  status?: "draft" | "selected" | "dismissed" | string;
}

export interface CanvasWorkspaceItem {
  id: string;
  agenda_id: string;
  point_id?: string;
  kind: string;
  status?: "discussion" | "confirmed" | "closed" | string;
  title: string;
  body: string;
  keywords?: string[];
  key_evidence?: string[];
  refined_utterances?: CanvasRefinedUtterance[];
  evidence_utterance_ids?: string[];
  ignored_utterance_ids?: string[];
  merged_children?: CanvasWorkspaceItem[];
  compacted_from_ids?: string[];
  compaction_level?: number;
  parent_topic_id?: string;
  parent_topic_source?: "ai" | "user" | "";
  parent_topic_locked?: boolean;
  child_item_ids?: string[];
  topic_collapsed?: boolean;
  created_by?: "ai" | "user" | "";
  manual_position?: boolean;
  ai_generated?: boolean;
  user_edited?: boolean;
  ai_pending?: boolean;
  ai_suggestions?: CanvasIdeationSuggestion[];
  x?: number;
  y?: number;
}

export interface CanvasRefinedUtterance {
  utterance_id: string;
  speaker: string;
  text: string;
  timestamp?: string;
}

export interface CanvasIdeaAssimilationUtterance {
  id: string;
  speaker: string;
  text: string;
  timestamp: string;
}

export interface CanvasIdeaAssimilationIdea {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  key_evidence?: string[];
  refined_utterances?: CanvasRefinedUtterance[];
  evidence_utterance_ids?: string[];
  user_edited?: boolean;
}

export interface CanvasIdeaAssimilationUpdate {
  action: "merge" | "create";
  targetIdeaId?: string;
  title: string;
  summary: string;
  keywords: string[];
  keyEvidence: string[];
  refinedUtterances?: CanvasRefinedUtterance[];
  evidenceUtteranceIds: string[];
  ignoredUtteranceIds: string[];
}

export interface CanvasIdeaAssimilationResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  updates: CanvasIdeaAssimilationUpdate[];
}

export interface CanvasCustomGroup {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  color?: string;
  created_by?: string;
  created_at?: string;
}

export interface CanvasWorkspaceProblemGroup {
  group_id: string;
  parent_group_id?: string;
  depth?: number;
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
  discussion_items?: CanvasProblemDiscussionItem[];
  linked_group_ids?: string[];
  evidence_utterance_ids?: string[];
  source_summary_items: string[];
  conclusion: string;
  conclusion_user_edited?: boolean;
  status?: "draft" | "review" | "final" | string;
  source_signature?: string;
  source_agenda_signatures?: Record<string, string>;
  source_idea_signatures?: Record<string, string>;
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
  meeting_goal?: string;
  meeting_goal_context?: string;
  stage: "ideation" | "problem-definition" | "solution";
  agenda_overrides?: Record<
    string,
    {
      title?: string;
      keywords?: string[];
      summaryBullets?: string[];
    }
  >;
  canvas_items: CanvasWorkspaceItem[];
  custom_groups?: CanvasCustomGroup[];
  problem_groups: CanvasWorkspaceProblemGroup[];
  problem_structure?: CanvasProblemStructureState;
  solution_topics: CanvasSolutionTopicResponse[];
  final_solution_summary?: CanvasFinalSolutionSummary;
  node_positions?: CanvasNodePositionsByStage;
  idea_create_stack?: number;
  idea_processed_utterance_ids?: string[];
  problem_processed_utterance_ids?: string[];
  imported_state?: MeetingState | null;
  saved_at?: string;
}

export interface CanvasWorkspacePatchRequest {
  meeting_id: string;
  meeting_goal?: string;
  meeting_goal_context?: string;
  stage?: "ideation" | "problem-definition" | "solution";
  agenda_overrides?: Record<
    string,
    {
      title?: string;
      keywords?: string[];
      summaryBullets?: string[];
    }
  >;
  canvas_items?: CanvasWorkspaceItem[];
  custom_groups?: CanvasCustomGroup[];
  problem_groups?: CanvasWorkspaceProblemGroup[];
  problem_structure?: CanvasProblemStructureState;
  solution_topics?: CanvasSolutionTopicResponse[];
  final_solution_summary?: CanvasFinalSolutionSummary;
  node_positions?: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
}

export interface CanvasLocalState {
  shared_sync_enabled?: boolean;
  meeting_goal?: string;
  meeting_goal_context?: string;
  agenda_overrides?: Record<
    string,
    {
      title?: string;
      keywords?: string[];
      summaryBullets?: string[];
    }
  >;
  canvas_items?: CanvasWorkspaceItem[];
  custom_groups?: CanvasCustomGroup[];
  stage?: "ideation" | "problem-definition" | "solution";
  problem_groups?: CanvasWorkspaceProblemGroup[];
  problem_structure?: CanvasProblemStructureState;
  solution_topics?: CanvasSolutionTopicResponse[];
  final_solution_summary?: CanvasFinalSolutionSummary;
  node_positions?: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
  import_override_active?: boolean;
}

export interface CanvasPersonalNotesStateResponse {
  ok: boolean;
  meeting_id: string;
  user_id: string;
  personal_notes: CanvasPersonalNote[];
  local_canvas_state?: CanvasLocalState | null;
  saved_at?: string;
}

export interface CanvasRealtimeSyncPayload {
  sync_id: string;
  meeting_id: string;
  meeting_goal?: string;
  meeting_goal_context?: string;
  updated_by: string;
  updated_at: string;
  stage: "ideation" | "problem-definition" | "solution";
  agenda_overrides?: Record<
    string,
    {
      title?: string;
      keywords?: string[];
      summaryBullets?: string[];
    }
  >;
  canvas_items: CanvasWorkspaceItem[];
  custom_groups?: CanvasCustomGroup[];
  problem_groups: CanvasWorkspaceProblemGroup[];
  problem_structure?: CanvasProblemStructureState;
  solution_topics: CanvasSolutionTopicResponse[];
  final_solution_summary?: CanvasFinalSolutionSummary;
  node_positions: CanvasNodePositionsByStage;
  imported_state?: MeetingState | null;
}

export interface CanvasFinalSolutionSummaryItem {
  id: string;
  topic_id: string;
  topic_no: number;
  topic_title: string;
  problem_topic: string;
  problem_conclusion: string;
  solution_conclusion: string;
  note_id: string;
  note_text: string;
  final_comment: string;
  source: "ai" | "user" | string;
  source_ai_id?: string;
  agenda_titles: string[];
}

export interface CanvasFinalSolutionSummaryTopic {
  topic_id: string;
  topic_no: number;
  topic_title: string;
  problem_topic: string;
  solution_conclusion: string;
  final_notes: CanvasFinalSolutionSummaryItem[];
}

export interface CanvasFinalSolutionSummary {
  final_count: number;
  topics: CanvasFinalSolutionSummaryTopic[];
  items: CanvasFinalSolutionSummaryItem[];
  markdown: string;
}

export interface MeetingGoalSuggestionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  topic: string;
  goal: string;
  goals?: string[];
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

export interface CanvasIdeationSuggestionResponse {
  ok: boolean;
  used_llm: boolean;
  warning?: string;
  generated_at: string;
  suggestions: CanvasIdeationSuggestion[];
}
