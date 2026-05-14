"use client";

import "@xyflow/react/dist/style.css";
import {
  Controls,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from "react";
import {
  getCanvasWorkspaceState,
  getCanvasPersonalNotes,
  confirmCanvasPlacement,
  getCanvasIdeaAssimilationWorkspaceJob,
  getCanvasProblemDiscussionWorkspaceJob,
  generateProblemGroupConclusion,
  generateCanvasProblemDefinition,
  generateCanvasIdeationSuggestions,
  generateCanvasSolutionStage,
  flushCanvasPersonalNotes,
  flushCanvasWorkspacePatch,
  importAgendaSnapshot,
  saveCanvasPersonalNotes,
  saveCanvasWorkspacePatch,
  startCanvasIdeaAssimilationWorkspace,
  startCanvasProblemDiscussionWorkspace,
  startCanvasTopicSummaryWorkspace,
} from "@/lib/api";
import type {
  AgendaActionItemDetail,
  AgendaDecisionDetail,
  CanvasCustomGroup,
  CanvasFinalSolutionSummary,
  CanvasLocalState,
  CanvasNodePositionsByStage,
  CanvasProblemDefinitionGroup,
  CanvasRealtimeSyncPayload,
  CanvasRefinedUtterance,
  CanvasIdeationSuggestion,
  CanvasProblemDiscussionItem,
  CanvasSolutionTopicResponse,
  CanvasWorkspaceStateResponse,
  CanvasWorkspaceItem,
  MeetingState,
  TranscriptUtterance,
} from "@/lib/types";
import type { LiveSpeechPreview, SttFlowSummaryItem } from "@/app/page";

export type MeetingTranscript = {
  id: string;
  speaker: string;
  text: string;
  timestamp: string;
  canvas_stage?: CanvasStage | string;
  canvas_target_id?: string;
};

export type MeetingAgenda = {
  id: string;
  title: string;
  status: string;
};

type CanvasStage = "ideation" | "problem-definition" | "solution";
type ComposerTool = "note" | "comment" | "topic";
type CanvasTool = ComposerTool | "group" | "problem-idea";
type LeftPanelTab = "detail";
type ProblemGroupStatus = "draft" | "review" | "final";
type CanvasItemStatus = "discussion" | "confirmed" | "closed";
type SolutionAiSuggestionStatus = "draft" | "selected" | "dismissed";
type SolutionNoteSource = "ai" | "user";
const CANVAS_STAGES: CanvasStage[] = ["ideation", "problem-definition", "solution"];
const CANVAS_ITEM_STATUSES: CanvasItemStatus[] = ["discussion", "confirmed", "closed"];
const IDEA_ASSIMILATION_FAILURE_RETRY_DELAY_MS = 60_000;
const IDEA_ASSIMILATION_AUTO_FLUSH_MS = 30_000;
const IDEA_ASSIMILATION_SILENCE_FLUSH_MS = 8_000;
const DEFAULT_LEFT_PANEL_RATIO = 0.19;
const DEFAULT_RIGHT_PANEL_RATIO = 0.2;
const MIN_LEFT_PANEL_RATIO = 0.13;
const MAX_LEFT_PANEL_RATIO = 0.28;
const MIN_RIGHT_PANEL_RATIO = 0.14;
const MAX_RIGHT_PANEL_RATIO = 0.3;
const COMPOSER_PERSONAL_NOTE_LINK_ID = "__composer_personal_note__";

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

type PersonalNote = {
  id: string;
  projectId: string;
  agendaId: string;
  linkedCanvasItemId?: string;
  linkedCanvasItemTitle?: string;
  kind: ComposerTool;
  title: string;
  body: string;
};

type ProblemGroupViewModel = CanvasProblemDefinitionGroup & {
  status: ProblemGroupStatus;
};

type ProblemDiscussionViewModel = CanvasProblemDiscussionItem;

type CanvasItemViewModel = CanvasWorkspaceItem;
type CustomGroupViewModel = CanvasCustomGroup;

type SolutionTopicViewModel = CanvasSolutionTopicResponse & {
  status: ProblemGroupStatus;
  problem_topic: string;
  problem_insight: string;
  problem_conclusion: string;
  problem_keywords: string[];
  agenda_titles: string[];
  ai_suggestions: Array<{
    id: string;
    text: string;
    status: SolutionAiSuggestionStatus;
  }>;
  notes: Array<{
    id: string;
    text: string;
    source: SolutionNoteSource;
    source_ai_id?: string;
    is_final_candidate: boolean;
    final_comment: string;
  }>;
};

type WorkspaceFieldSignatures = {
  meeting_goal: string;
  meeting_goal_context: string;
  stage: string;
  agenda_overrides: string;
  canvas_items: string;
  custom_groups: string;
  problem_groups: string;
  solution_topics: string;
  final_solution_summary: string;
  node_positions: string;
  imported_state: string;
};

type CanvasIdeaAssimilationJobSnapshot = {
  ok?: boolean;
  job_id?: string;
  meeting_id?: string;
  status?: string;
  detail?: string;
  used_llm?: boolean;
  warning?: string;
  pending_item_id?: string;
  target_count?: number;
  target_signature?: string;
};

type IdeationDropPreviewState = {
  draggedItemId: string;
  targetId: string;
  mode: "topic" | "merge" | "topic-merge" | "topic-idea-merge" | "detach";
  agendaId: string;
  position: { x: number; y: number };
  label: string;
  hint: string;
};

type StableIdeationDragState = {
  nodeId: string;
  anchor: { x: number; y: number };
};

function logCanvasIdeaAssimilationJob(
  label: string,
  job: CanvasIdeaAssimilationJobSnapshot | undefined | null,
  extra: Record<string, unknown> = {},
) {
  const status = job?.status || "";
  const warning = job?.warning || "";
  const detail = job?.detail || "";
  const hasError =
    status === "error" ||
    status === "missing" ||
    Boolean(warning) ||
    (status === "completed" && job?.used_llm === false);
  const errorDetail =
    status === "missing"
      ? detail || "작업 정보를 찾을 수 없습니다."
      : warning || (hasError ? detail : "");
  const payload = {
    label,
    hasError,
    errorDetail,
    status,
    usedLlm: Boolean(job?.used_llm),
    warning,
    detail,
    jobId: job?.job_id || "",
    pendingItemId: job?.pending_item_id || "",
    targetCount: job?.target_count || 0,
    targetSignature: job?.target_signature || "",
    ok: Boolean(job?.ok),
    ...extra,
  };

  if (hasError) {
    console.error("[canvas idea assimilation]", payload);
    return;
  }

  console.info("[canvas idea assimilation]", payload);
}

function createWorkspaceFieldSignatures(): WorkspaceFieldSignatures {
  return {
    meeting_goal: "",
    meeting_goal_context: "",
    stage: "",
    agenda_overrides: "",
    canvas_items: "",
    custom_groups: "",
    problem_groups: "",
    solution_topics: "",
    final_solution_summary: "",
    node_positions: "",
    imported_state: "",
  };
}

function buildWorkspaceProblemGroupsPayload(groups: ProblemGroupViewModel[]) {
  return groups.map((group) => ({
    group_id: group.group_id,
    topic: group.topic,
    insight_lens: group.insight_lens,
    insight_user_edited: group.insight_user_edited,
    keywords: group.keywords,
    agenda_ids: group.agenda_ids,
    agenda_titles: group.agenda_titles,
    ideas: group.ideas,
    source_summary_items: group.source_summary_items,
    discussion_items: group.discussion_items || [],
    conclusion: group.conclusion,
    conclusion_user_edited: group.conclusion_user_edited,
    status: group.status,
    source_signature: group.source_signature,
    source_agenda_signatures: group.source_agenda_signatures,
    source_idea_signatures: group.source_idea_signatures,
  }));
}

function buildWorkspaceSolutionTopicsPayload(topics: SolutionTopicViewModel[]) {
  return topics.map((topic) => ({
    group_id: topic.group_id,
    topic_no: topic.topic_no,
    topic: topic.topic,
    conclusion: topic.conclusion,
    ideas: topic.ideas,
    status: topic.status,
    problem_topic: topic.problem_topic,
    problem_insight: topic.problem_insight,
    problem_conclusion: topic.problem_conclusion,
    problem_keywords: topic.problem_keywords,
    agenda_titles: topic.agenda_titles,
    ai_suggestions: topic.ai_suggestions,
    notes: topic.notes,
  }));
}

function buildFinalSolutionSummaryPayload(topics: SolutionTopicViewModel[]): CanvasFinalSolutionSummary {
  const summaryTopics = topics
    .map((topic) => {
      const finalNotes = solutionTopicFinalNotes(topic).map((note) => ({
        id: `${topic.group_id}::${note.id}`,
        topic_id: topic.group_id,
        topic_no: topic.topic_no,
        topic_title: topic.topic,
        problem_topic: topic.problem_topic || "",
        problem_conclusion: topic.problem_conclusion || "",
        solution_conclusion: topic.conclusion || "",
        note_id: note.id,
        note_text: note.text,
        final_comment: note.final_comment || "",
        source: note.source || "user",
        source_ai_id: note.source_ai_id || "",
        agenda_titles: topic.agenda_titles || [],
      }));

      return {
        topic_id: topic.group_id,
        topic_no: topic.topic_no,
        topic_title: topic.topic,
        problem_topic: topic.problem_topic || "",
        solution_conclusion: topic.conclusion || "",
        final_notes: finalNotes,
      };
    })
    .filter((topic) => topic.final_notes.length > 0);
  const items = summaryTopics.flatMap((topic) => topic.final_notes);
  const markdown = summaryTopics
    .map((topic) => {
      const title = topic.topic_title || `해결책 ${topic.topic_no}`;
      const lines = topic.final_notes.map((note) => {
        const comment = note.final_comment ? `\n  - 설명: ${note.final_comment}` : "";
        return `- ${note.note_text}${comment}`;
      });
      return [`## ${title}`, ...lines].join("\n");
    })
    .join("\n\n");

  return {
    final_count: items.length,
    topics: summaryTopics,
    items,
    markdown,
  };
}

function normalizeRefinedUtterances(
  rows: CanvasRefinedUtterance[] | undefined,
  limit = 120,
): CanvasRefinedUtterance[] {
  const seen = new Set<string>();
  const normalized: CanvasRefinedUtterance[] = [];

  (rows || []).forEach((row, index) => {
    const text = trimText(row.text || "", 72);
    if (!text) return;
    const utteranceId = (row.utterance_id || `refined-${index}`).trim();
    const key = utteranceId || `${row.speaker || ""}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push({
      utterance_id: utteranceId,
      speaker: (row.speaker || "참가자").trim(),
      text,
      timestamp: (row.timestamp || "").trim(),
    });
  });

  return normalized.slice(0, limit);
}

function buildWorkspaceCanvasItemsPayload(items: CanvasItemViewModel[]): CanvasWorkspaceItem[] {
  return items.map((item) => ({
    id: item.id,
    agenda_id: item.agenda_id,
    point_id: item.point_id || "",
    kind: item.kind,
    status: normalizeCanvasItemStatus(item.status),
    title: item.title,
    body: item.body,
    keywords: (item.keywords || []).map((keyword) => keyword.trim()).filter(Boolean),
    key_evidence: (item.key_evidence || []).map((value) => value.trim()).filter(Boolean),
    refined_utterances: normalizeRefinedUtterances(item.refined_utterances),
    evidence_utterance_ids: (item.evidence_utterance_ids || []).map((value) => value.trim()).filter(Boolean),
    ignored_utterance_ids: (item.ignored_utterance_ids || []).map((value) => value.trim()).filter(Boolean),
    merged_children: buildWorkspaceCanvasItemsPayload(item.merged_children || []),
    compacted_from_ids: (item.compacted_from_ids || []).map((value) => value.trim()).filter(Boolean),
    compaction_level: typeof item.compaction_level === "number" ? item.compaction_level : 0,
    parent_topic_id: item.parent_topic_id || "",
    parent_topic_source: item.parent_topic_source || "",
    parent_topic_locked: Boolean(item.parent_topic_locked),
    child_item_ids: (item.child_item_ids || []).map((value) => value.trim()).filter(Boolean),
    topic_collapsed: Boolean(item.topic_collapsed),
    created_by: item.created_by || "",
    manual_position: false,
    ai_generated: Boolean(item.ai_generated),
    user_edited: Boolean(item.user_edited),
    ai_pending: Boolean(item.ai_pending),
    ai_suggestions: (item.ai_suggestions || [])
      .map((suggestion) => ({
        id: suggestion.id,
        text: suggestion.text.trim(),
        status: normalizeIdeationSuggestionStatus(suggestion.status),
      }))
      .filter((suggestion) => suggestion.id && suggestion.text)
      .slice(0, 8),
  }));
}

function serializeCustomGroups(groups: CustomGroupViewModel[]) {
  return groups
    .map((group) => ({
      id: group.id,
      title: group.title.trim(),
      description: (group.description || "").trim(),
      keywords: (group.keywords || []).map((keyword) => keyword.trim()).filter(Boolean),
      color: (group.color || "").trim(),
      created_by: group.created_by || "",
      created_at: group.created_at || "",
    }))
    .filter((group) => group.id && group.title);
}

function buildWorkspaceFieldSignatures(input: {
  meetingGoal: string;
  meetingGoalContext: string;
  stage: CanvasStage;
  agendaOverrides: Record<string, AgendaOverride>;
  canvasItems: CanvasItemViewModel[];
  customGroups: CustomGroupViewModel[];
  problemGroups: ProblemGroupViewModel[];
  solutionTopics: SolutionTopicViewModel[];
  nodePositions: CanvasNodePositionsByStage;
  importedState: MeetingState | null;
}): WorkspaceFieldSignatures {
  return {
    meeting_goal: input.meetingGoal.trim(),
    meeting_goal_context: input.meetingGoalContext.trim(),
    stage: input.stage,
    agenda_overrides: JSON.stringify(serializeAgendaOverrides(input.agendaOverrides)),
    canvas_items: JSON.stringify(buildWorkspaceCanvasItemsPayload(input.canvasItems)),
    custom_groups: JSON.stringify(serializeCustomGroups(input.customGroups)),
    problem_groups: JSON.stringify(buildWorkspaceProblemGroupsPayload(input.problemGroups)),
    solution_topics: JSON.stringify(buildWorkspaceSolutionTopicsPayload(input.solutionTopics)),
    final_solution_summary: JSON.stringify(buildFinalSolutionSummaryPayload(input.solutionTopics)),
    node_positions: JSON.stringify(normalizeCanvasNodePositionsForComputedIdeation(input.nodePositions)),
    imported_state: JSON.stringify(input.importedState || null),
  };
}

function buildFullWorkspacePatchPayload(input: {
  meetingId: string;
  meetingGoal: string;
  meetingGoalContext: string;
  stage: CanvasStage;
  agendaOverrides: Record<string, AgendaOverride>;
  canvasItems: CanvasItemViewModel[];
  customGroups: CustomGroupViewModel[];
  problemGroups: ProblemGroupViewModel[];
  solutionTopics: SolutionTopicViewModel[];
  nodePositions: CanvasNodePositionsByStage;
  importedState: MeetingState | null;
}) {
  return {
    meeting_id: input.meetingId,
    meeting_goal: input.meetingGoal.trim(),
    meeting_goal_context: input.meetingGoalContext.trim(),
    stage: input.stage,
    agenda_overrides: serializeAgendaOverrides(input.agendaOverrides),
    canvas_items: serializeSharedCanvasItems(input.canvasItems),
    custom_groups: serializeCustomGroups(input.customGroups),
    problem_groups: buildWorkspaceProblemGroupsPayload(input.problemGroups),
    solution_topics: buildWorkspaceSolutionTopicsPayload(input.solutionTopics),
    final_solution_summary: buildFinalSolutionSummaryPayload(input.solutionTopics),
    node_positions: normalizeCanvasNodePositionsForComputedIdeation(input.nodePositions),
    imported_state: input.importedState,
  };
}

function getSharedWorkspaceSessionStorageKey(meetingId: string) {
  return `imms:canvas-shared-workspace:${meetingId}`;
}

function writeSharedWorkspaceSessionCache(
  meetingId: string,
  snapshot: ReturnType<typeof buildFullWorkspacePatchPayload>,
) {
  if (typeof window === "undefined" || !meetingId) return;
  try {
    window.sessionStorage.setItem(
      getSharedWorkspaceSessionStorageKey(meetingId),
      JSON.stringify({
        ...snapshot,
        cached_at: Date.now(),
      }),
    );
  } catch {
    // ignore sessionStorage errors
  }
}

function readSharedWorkspaceSessionCache(meetingId: string): Partial<ReturnType<typeof buildFullWorkspacePatchPayload>> | null {
  if (typeof window === "undefined" || !meetingId) return null;
  try {
    const raw = window.sessionStorage.getItem(getSharedWorkspaceSessionStorageKey(meetingId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getTopicCollapseStorageKey(meetingId: string, userId: string) {
  return `imms:canvas-topic-collapse:${meetingId}:${userId || "anonymous"}`;
}

function readTopicCollapseOverrides(meetingId: string, userId: string): Record<string, boolean> {
  if (typeof window === "undefined" || !meetingId) return {};
  try {
    const raw = window.localStorage.getItem(getTopicCollapseStorageKey(meetingId, userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => (
        typeof entry[0] === "string" && typeof entry[1] === "boolean"
      )),
    );
  } catch {
    return {};
  }
}

function writeTopicCollapseOverrides(meetingId: string, userId: string, overrides: Record<string, boolean>) {
  if (typeof window === "undefined" || !meetingId) return;
  try {
    window.localStorage.setItem(getTopicCollapseStorageKey(meetingId, userId), JSON.stringify(overrides));
  } catch {
    // ignore localStorage errors
  }
}

function summarizeNodePositionsForDebug(nodePositions: CanvasNodePositionsByStage) {
  const topIdeationNodes = Object.entries(nodePositions.ideation || {})
    .sort((a, b) => {
      const ay = Number(a[1]?.y ?? 0);
      const by = Number(b[1]?.y ?? 0);
      if (ay !== by) return ay - by;
      return Number(a[1]?.x ?? 0) - Number(b[1]?.x ?? 0);
    })
    .slice(0, 4);

  return {
    ideation: Object.keys(nodePositions.ideation || {}).length,
    problemDefinition: Object.keys(nodePositions["problem-definition"] || {}).length,
    solution: Object.keys(nodePositions.solution || {}).length,
    topIdeationNodes,
  };
}

function summarizeRenderedNodesForDebug(nodes: Node[]) {
  const topIdeationNodes = nodes
    .filter((node) => node.id.startsWith("agenda-") || node.id.startsWith("canvas-item-"))
    .sort((a, b) => {
      const ay = Number(a.position?.y ?? 0);
      const by = Number(b.position?.y ?? 0);
      if (ay !== by) return ay - by;
      return Number(a.position?.x ?? 0) - Number(b.position?.x ?? 0);
    })
    .slice(0, 4)
    .map((node) => [node.id, { x: node.position.x, y: node.position.y }] as const);

  return {
    total: nodes.length,
    topIdeationNodes,
  };
}

function normalizeCanvasNodePositionsForComputedIdeation(
  positions: CanvasNodePositionsByStage | undefined,
): CanvasNodePositionsByStage {
  if (!positions) return {};

  const normalized: CanvasNodePositionsByStage = {};
  CANVAS_STAGES.forEach((stageKey) => {
    const stagePositions = positions[stageKey] || {};
    const entries = Object.entries(stagePositions)
      .filter(([nodeId]) => stageKey !== "ideation" || nodeId.startsWith("agenda-"))
      .map(([nodeId, position]) => [
        nodeId,
        {
          x: Number(position?.x || 0),
          y: Number(position?.y || 0),
        },
      ] as const);

    if (entries.length > 0) {
      normalized[stageKey] = Object.fromEntries(entries);
    }
  });

  return normalized;
}

function buildCanvasPersonalNotesPayload(
  meetingId: string,
  userId: string,
  personalNotes: PersonalNote[],
  localCanvasState?: CanvasLocalState | null,
) {
  return {
    meeting_id: meetingId,
    user_id: userId,
    personal_notes: personalNotes.map((note) => ({
      id: note.id,
      project_id: note.projectId || meetingId,
      agenda_id: note.agendaId,
      linked_canvas_item_id: note.linkedCanvasItemId || "",
      linked_canvas_item_title: note.linkedCanvasItemTitle || "",
      kind: note.kind,
      title: note.title,
      body: note.body,
    })),
    local_canvas_state: localCanvasState || null,
  };
}

function buildMeetingStateSignature(state: MeetingState | null) {
  if (!state) {
    return "";
  }

  return JSON.stringify({
    transcript: (state.transcript || []).map((row) => `${row.speaker}\u0001${row.text}\u0001${row.timestamp}`),
    agendas: (state.analysis?.agenda_outcomes || []).map((row) => ({
      id: row.agenda_id,
      title: row.agenda_title,
      start: row.start_turn_id,
      end: row.end_turn_id,
    })),
  });
}

function serializeAgendaOverrides(overrides: Record<string, AgendaOverride>) {
  return Object.fromEntries(
    Object.entries(overrides).flatMap(([agendaId, override]) => {
      const title = (override.title || "").trim();
      const keywords = (override.keywords || []).map((item) => item.trim()).filter(Boolean);
      const summaryBullets = (override.summaryBullets || []).map((item) => item.trim()).filter(Boolean);

      if (!title && keywords.length === 0 && summaryBullets.length === 0) {
        return [];
      }

      return [[agendaId, { title, keywords, summaryBullets }]];
    }),
  );
}

type SolutionAiSuggestionViewModel = SolutionTopicViewModel["ai_suggestions"][number];
type SolutionNoteViewModel = SolutionTopicViewModel["notes"][number];
type IdeationSuggestionViewModel = CanvasIdeationSuggestion;

type AgendaViewModel = {
  id: string;
  title: string;
  status: string;
  keywords: string[];
  summaryBullets: string[];
  utterances: Array<TranscriptUtterance & { turnId: number }>;
  decisions: AgendaDecisionDetail[];
  actionItems: AgendaActionItemDetail[];
  isCustom?: boolean;
};

type AgendaOverride = {
  title?: string;
  keywords?: string[];
  summaryBullets?: string[];
};

type ProblemGroupDisplayCard = {
  id: string;
  title: string;
  body: string;
  kind: string;
  sourceNodeId: string;
  sourceNodeKind: "topic" | "idea" | "summary";
  attachable: boolean;
  cardKind: "summary" | "idea";
  sourceIndex: number;
  draggable: boolean;
  ideaId?: string;
  summaryText?: string;
};

type AgendaDragPreviewState = {
  agendaId: string;
  originPosition: { x: number; y: number };
};

type ProblemIdeaDragState = {
  sourceGroupId: string;
  sourceNodeId: string;
  sourceNodeKind: "topic" | "idea" | "summary";
  cardKind: "summary" | "idea";
  sourceIndex: number;
  title: string;
  ideaId?: string;
  summaryText?: string;
};

type ProblemIdeaDropPreviewState = {
  targetGroupId: string;
  cardKind: "summary" | "idea";
  insertIndex: number;
};

type ProblemIdeaDragPointState = {
  x: number;
  y: number;
};

type ProblemIdeaPointerDragState = {
  groupId: string;
  card: ProblemGroupDisplayCard;
  startX: number;
  startY: number;
  active: boolean;
};

type MeetingCanvasTabProps = {
  userId: string;
  meetingId: string;
  meetingTitle: string;
  meetingGoal: string;
  meetingGoalContext: string;
  onMeetingGoalChange: (goal: string) => void;
  onMeetingGoalContextChange: (context: string) => void;
  onMeetingGoalSync?: (goal: string, context?: string) => void;
  transcripts: MeetingTranscript[];
  agendas: MeetingAgenda[];
  analysisState: MeetingState | null;
  onSyncFromMeeting: (analyze?: boolean) => Promise<MeetingState | null>;
  incomingSharedCanvasSync: CanvasRealtimeSyncPayload | null;
  onSharedCanvasSync: (payload: CanvasRealtimeSyncPayload) => void;
  incomingCanvasStateRequestId: string;
  syncStatusText: string;
  autoSyncing: boolean;
  liveSpeechPreview: LiveSpeechPreview | null;
  sttFlowSummaries?: SttFlowSummaryItem[];
  onImportAudioFile: (file: File) => Promise<void>;
  audioImportBusy: boolean;
  audioImportStatusText: string;
  audioImportRevision: number;
  isRecording?: boolean;
  onToggleRecording?: () => void | Promise<void>;
  onEndMeeting?: () => void | Promise<void>;
  onStopRecording?: () => void | Promise<void>;
  sttProgressText?: string;
  onCanvasStageContextChange?: (context: {
    stage: CanvasStage;
    targetId?: string;
    selectedNodeId?: string;
  }) => void;
  recordingStatusText?: string;
};

function stageLabel(stage: CanvasStage) {
  if (stage === "ideation") return "아이디어";
  if (stage === "problem-definition") return "문제정의";
  return "해결책";
}

function syncModeLabel(enabled: boolean) {
  return enabled ? "공유 ON" : "공유 OFF";
}

function KeyboardDoubleArrowDownIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
    >
      <path d="M5.41 5.59 12 12.17l6.59-6.58L20 7l-8 8-8-8 1.41-1.41Zm0 6L12 18.17l6.59-6.58L20 13l-8 8-8-8 1.41-1.41Z" />
    </svg>
  );
}

function KeyboardDoubleArrowLeftIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
    >
      <path d="M18.41 5.41 11.83 12l6.58 6.59L17 20l-8-8 8-8 1.41 1.41Zm-6 0L5.83 12l6.58 6.59L11 20l-8-8 8-8 1.41 1.41Z" />
    </svg>
  );
}

function RightDrawerPanel({
  className,
  bodyClassName,
  bodyStyle,
  children,
}: {
  className: string;
  bodyClassName: string;
  bodyStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <aside className={className}>
      <div className={bodyClassName} style={bodyStyle}>
        {children}
      </div>
    </aside>
  );
}

function RightDrawerSectionHeader({
  eyebrow,
  title,
  titleClassName = "mt-1 text-lg font-semibold leading-tight text-black",
  action,
}: {
  eyebrow: string;
  title: string;
  titleClassName?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-black/50">{eyebrow}</p>
        <h3 className={titleClassName}>{title}</h3>
      </div>
      {action}
    </div>
  );
}

function RightDetailPanelContent({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`imms-left-panel-detail mt-[clamp(0.875rem,1.5vw,1rem)] ${collapsed ? "hidden" : ""}`}>
      {children}
    </div>
  );
}

function RightDetailPanelShell({
  collapsed,
  onToggleCollapsed,
  children,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="border-b border-black/10 pb-[clamp(0.875rem,1.4vw,1rem)]">
        <RightDrawerSectionHeader
          eyebrow="선택 정보"
          title="내용 상세보기"
          action={
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="shrink-0 rounded-full border border-black/10 bg-[#eff0f6] px-3 py-1 text-sm font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee]"
            >
              {collapsed ? "열기" : "접기"}
            </button>
          }
        />
      </div>
      <RightDetailPanelContent collapsed={collapsed}>
        {children}
      </RightDetailPanelContent>
    </>
  );
}

function RightDetailEmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-black/10 bg-[#fafafa] px-4 py-5">
      <p className="text-base font-semibold text-slate-900">선택된 내용이 없습니다</p>
      <p className="mt-2 text-sm leading-6 text-slate-500">
        왼쪽 캔버스에서 그룹을 선택하거나 오른쪽 캔버스에서 아이디어/댓글을 선택하면 상세 정보가 표시됩니다.
      </p>
    </div>
  );
}

function RightDrawerNotesPanel({
  collapsed,
  noteCount,
  onToggleCollapsed,
  children,
}: {
  collapsed: boolean;
  noteCount: number;
  onToggleCollapsed: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-black/10 pb-[clamp(1rem,2vh,1.5rem)]">
      <RightDrawerSectionHeader
        eyebrow="Personal note"
        title="개인 노트"
        titleClassName="mt-1 text-xl font-semibold leading-tight text-black"
        action={
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="shrink-0 rounded-full border border-black/10 bg-[#eff0f6] px-3 py-1 text-sm font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee]"
          >
            {collapsed ? "열기" : `${noteCount}개 · 접기`}
          </button>
        }
      />
      {collapsed ? null : children}
    </section>
  );
}

function PersonalNoteComposer({
  agendaModels,
  composerAgendaId,
  composerTitle,
  composerBody,
  composerLinkedCanvasItemId,
  composerLinkedCanvasItemTitle,
  pendingPersonalNoteLinkId,
  composerBodyRef,
  onAgendaChange,
  onTitleChange,
  onBodyChange,
  onStartLinkSelection,
  onClearLinkedIdea,
  onCancelPendingLink,
  onSave,
}: {
  agendaModels: AgendaViewModel[];
  composerAgendaId: string;
  composerTitle: string;
  composerBody: string;
  composerLinkedCanvasItemId: string;
  composerLinkedCanvasItemTitle: string;
  pendingPersonalNoteLinkId: string;
  composerBodyRef: RefObject<HTMLTextAreaElement | null>;
  onAgendaChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onStartLinkSelection: () => void;
  onClearLinkedIdea: () => void;
  onCancelPendingLink: () => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      <select value={composerAgendaId} onChange={(event) => onAgendaChange(event.target.value)} className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base text-[#4d4d4d] focus:border-black/30 focus:outline-none">
        <option value="">프로젝트 전체 메모</option>
        {agendaModels.map((agenda) => (
          <option key={agenda.id} value={agenda.id}>
            {agenda.title}
          </option>
        ))}
      </select>
      <input value={composerTitle} onChange={(event) => onTitleChange(event.target.value)} placeholder="메모 제목" className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base text-[#4d4d4d] focus:border-black/30 focus:outline-none" />
      <textarea ref={composerBodyRef} value={composerBody} onChange={(event) => onBodyChange(event.target.value)} placeholder="메모 내용" className="min-h-[118px] w-full rounded-2xl border border-black/10 bg-white px-4 py-3.5 text-base leading-7 text-[#4d4d4d] focus:border-black/30 focus:outline-none" />
      <div className="rounded-xl border border-black/10 bg-white px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#4d4d4d]">연결 아이디어</p>
            <p className="mt-1 truncate text-xs leading-5 text-black/45">
              {composerLinkedCanvasItemId
                ? composerLinkedCanvasItemTitle || "선택된 아이디어"
                : "선택하지 않아도 메모를 저장할 수 있습니다."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onStartLinkSelection}
              className="rounded-full border border-black/10 bg-[#fafafa] px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
            >
              {composerLinkedCanvasItemId ? "다시 선택" : "아이디어 선택"}
            </button>
            {composerLinkedCanvasItemId ? (
              <button
                type="button"
                onClick={onClearLinkedIdea}
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
              >
                해제
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {pendingPersonalNoteLinkId ? (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-3 text-sm leading-6 text-blue-700">
          {pendingPersonalNoteLinkId === COMPOSER_PERSONAL_NOTE_LINK_ID
            ? "작성 중인 메모에 연결할 아이디어 노드를 캔버스에서 선택해 주세요."
            : "연결할 아이디어 노드를 캔버스에서 선택해 주세요."}
          <button
            type="button"
            onClick={onCancelPendingLink}
            className="ml-2 font-semibold underline underline-offset-2"
          >
            취소
          </button>
        </div>
      ) : null}
      <button type="button" onClick={onSave} className="ml-auto block rounded-full bg-[#eff0f6] px-5 py-2 text-sm font-medium text-[#4d4d4d] hover:bg-[#e3e5ee]">
        개인 메모 저장
      </button>
    </div>
  );
}

function PersonalNoteList({
  notes,
  stage,
  agendaModels,
  editingPersonalNoteId,
  draggingPersonalNoteId,
  personalNoteDraftAgendaId,
  personalNoteDraftTitle,
  personalNoteDraftBody,
  onDragStartNote,
  onDragEndNote,
  onDraftAgendaChange,
  onDraftTitleChange,
  onDraftBodyChange,
  onCancelEdit,
  onSaveEdit,
  onStartEdit,
  onDelete,
  onFocusLinkedIdea,
  onStartRelink,
  onUnlinkIdea,
}: {
  notes: PersonalNote[];
  stage: CanvasStage;
  agendaModels: AgendaViewModel[];
  editingPersonalNoteId: string;
  draggingPersonalNoteId: string;
  personalNoteDraftAgendaId: string;
  personalNoteDraftTitle: string;
  personalNoteDraftBody: string;
  onDragStartNote: (noteId: string) => void;
  onDragEndNote: () => void;
  onDraftAgendaChange: (value: string) => void;
  onDraftTitleChange: (value: string) => void;
  onDraftBodyChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (noteId: string) => void;
  onStartEdit: (note: PersonalNote) => void;
  onDelete: (noteId: string) => void;
  onFocusLinkedIdea: (itemId: string) => void;
  onStartRelink: (noteId: string, hasExistingLink: boolean) => void;
  onUnlinkIdea: (noteId: string) => void;
}) {
  return (
    <section className="pt-[clamp(1rem,2vh,1.5rem)]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-black">내 메모 목록</h3>
        <span className="rounded-full border border-black/10 bg-[#eff0f6] px-3 py-1 text-sm font-medium text-[#4d4d4d]">
          {notes.length}
        </span>
      </div>
      {stage === "problem-definition" ? (
        <p className="mt-2 text-sm leading-6 text-slate-500">메모 카드를 문제 정의 그룹으로 드래그해서 편입할 수 있습니다.</p>
      ) : null}
      <div className="mt-4 space-y-3">
        {notes.length === 0 ? (
          <p className="text-base leading-7 text-slate-500">이 프로젝트에 저장한 개인 메모가 없습니다.</p>
        ) : (
          notes.map((note) => {
            const isEditing = editingPersonalNoteId === note.id;

            return (
              <article
                key={note.id}
                draggable={stage === "problem-definition" && !isEditing}
                onDragStart={(event) => {
                  if (stage !== "problem-definition" || isEditing) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-imms-note-id", note.id);
                  event.dataTransfer.setData("text/plain", note.id);
                  onDragStartNote(note.id);
                }}
                onDragEnd={onDragEndNote}
                className={`rounded-xl border border-black/10 bg-white p-4 shadow-[0_1px_0_rgba(0,0,0,0.04)] ${stage === "problem-definition" && !isEditing ? "cursor-grab active:cursor-grabbing" : ""} ${draggingPersonalNoteId === note.id ? "opacity-60" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600">{toolLabel(note.kind)}</p>
                    {isEditing ? (
                      <input
                        value={personalNoteDraftTitle}
                        onChange={(event) => onDraftTitleChange(event.target.value)}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base font-semibold text-slate-900"
                      />
                    ) : (
                      <h4 className="mt-1 text-base font-semibold text-slate-900">{note.title}</h4>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {isEditing ? (
                      <>
                        <button type="button" onClick={onCancelEdit} className="text-sm font-medium text-slate-500 hover:text-slate-700">
                          취소
                        </button>
                        <button type="button" onClick={() => onSaveEdit(note.id)} className="text-sm font-medium text-slate-700 hover:text-slate-900">
                          저장
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => onStartEdit(note)} className="text-sm font-medium text-slate-400 hover:text-slate-600">
                          수정
                        </button>
                        <button type="button" onClick={() => onDelete(note.id)} className="text-sm font-medium text-slate-400 hover:text-slate-600">
                          삭제
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <>
                    <select
                      value={personalNoteDraftAgendaId}
                      onChange={(event) => onDraftAgendaChange(event.target.value)}
                      className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700"
                    >
                      <option value="">프로젝트 전체 메모</option>
                      {agendaModels.map((agenda) => (
                        <option key={agenda.id} value={agenda.id}>
                          {agenda.title}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={personalNoteDraftBody}
                      onChange={(event) => onDraftBodyChange(event.target.value)}
                      className="mt-3 min-h-[140px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
                    />
                  </>
                ) : (
                  <p className="mt-2 text-base leading-7 text-slate-600">{note.body}</p>
                )}
                {!isEditing ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {note.linkedCanvasItemId ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onFocusLinkedIdea(note.linkedCanvasItemId || "")}
                          className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                        >
                          연결 아이디어: {note.linkedCanvasItemTitle || "아이디어"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onStartRelink(note.id, true)}
                          className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                        >
                          다른 아이디어 연결
                        </button>
                        <button
                          type="button"
                          onClick={() => onUnlinkIdea(note.id)}
                          className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                        >
                          연결 해제
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onStartRelink(note.id, false)}
                        className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                      >
                        아이디어 연결
                      </button>
                    )}
                  </div>
                ) : null}
                <p className="mt-3 text-sm text-slate-400">연결 그룹: {agendaModels.find((agenda) => agenda.id === (isEditing ? personalNoteDraftAgendaId : note.agendaId))?.title || "프로젝트 전체"}</p>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function isComposerTool(tool: CanvasTool): tool is ComposerTool {
  return tool === "note" || tool === "comment" || tool === "topic";
}

function toolLabel(tool: CanvasTool, stage?: CanvasStage) {
  if (tool === "note") return stage === "problem-definition" ? "의견추가" : "추가";
  if (tool === "problem-idea") return "아이디어 추가";
  if (tool === "comment") return "댓글";
  if (tool === "group") return stage === "problem-definition" ? "문제정의 그룹 추가" : "그룹";
  return "주제";
}

function toolPreviewHint(tool: CanvasTool, stage?: CanvasStage) {
  if (stage === "problem-definition") {
    if (tool === "group") return "새 문제정의 그룹을 만들 위치";
    if (tool === "problem-idea") return "문제정의 그룹에 아이디어를 추가할 위치";
    if (tool === "comment") return "문제정의 댓글을 남길 위치";
    return "문제 의견을 추가할 위치";
  }
  if (tool === "group") return "프로젝트 그룹을 만들 위치";
  if (tool === "topic") return "새 주제를 만들 위치";
  if (tool === "comment") return "코멘트를 남길 위치";
  return "메모를 붙일 위치";
}

function toolPreviewTone(tool: CanvasTool, stage?: CanvasStage) {
  if (stage === "problem-definition") {
    if (tool === "group") return "border-violet-200 bg-violet-50/92 text-violet-700";
    if (tool === "problem-idea") return "border-fuchsia-200 bg-fuchsia-50/92 text-fuchsia-700";
    if (tool === "comment") return "border-sky-200 bg-sky-50/92 text-sky-700";
    return "border-amber-200 bg-amber-50/92 text-amber-700";
  }
  if (tool === "group") return "border-emerald-200 bg-emerald-50/92 text-emerald-700";
  if (tool === "topic") return "border-fuchsia-200 bg-fuchsia-50/92 text-fuchsia-700";
  if (tool === "comment") return "border-sky-200 bg-sky-50/92 text-sky-700";
  return "border-amber-200 bg-amber-50/92 text-amber-700";
}

function isAudioImportFile(file: File) {
  const suffix = file.name.split(".").pop()?.toLowerCase() || "";
  return ["wav", "mp3", "m4a", "webm"].includes(suffix);
}

function extractAgendaIdFromNodeId(nodeId: string) {
  if (nodeId.startsWith("agenda-")) return nodeId.slice("agenda-".length);
  const summaryMatch = nodeId.match(/^summary-(.+)-(\d+)$/);
  if (summaryMatch) return summaryMatch[1];
  return "";
}

function extractCanvasItemIdFromNodeId(nodeId: string) {
  return nodeId.startsWith("canvas-item-") ? nodeId.slice("canvas-item-".length) : "";
}

function extractSolutionDetailTopicIdFromNodeId(nodeId: string) {
  const prefixes = [
    "solution-detail::",
    "solution-ai-header::",
    "solution-ai::",
    "solution-note-header::",
    "solution-note::",
    "solution-composer::",
    "solution-final-header::",
    "solution-final::",
    "solution-empty::",
  ];
  const prefix = prefixes.find((candidate) => nodeId.startsWith(candidate));
  if (!prefix) return "";
  const topicId = nodeId.slice(prefix.length).split("::")[0] || "";
  return topicId === "none" ? "" : topicId;
}

function stripLeadingTimestamp(text: string) {
  return text
    .replace(
      /^\s*\[?\s*(?:\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)\s*\]?\s*/,
      "",
    )
    .trim();
}

function trimText(text: string, maxLength: number) {
  const clean = stripLeadingTimestamp(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function buildLiveFlowHint(row: MeetingTranscript | null) {
  if (!row || !row.text.trim()) return "";
  const clean = trimText(row.text, 56);
  const normalized = row.text.toLowerCase();
  const intent =
    /[?？]|궁금|어떻게|왜|가능|될까|되나/.test(normalized)
      ? "질문 중"
      : /문제|불편|어렵|리스크|걱정|한계|부족/.test(normalized)
        ? "문제 제기 중"
        : /하자|하면|아이디어|제안|추가|개선|만들|넣|도입|활용/.test(normalized)
          ? "아이디어 제시 중"
          : "의견 공유 중";
  return `${row.speaker || "참가자"}: ${clean} · ${intent}`;
}

function summarizeDecision(decision: AgendaDecisionDetail) {
  return stripLeadingTimestamp(decision.conclusion || decision.opinions?.[0] || "결정 내용 없음");
}

function summarizeActionItem(actionItem: AgendaActionItemDetail) {
  const owner = stripLeadingTimestamp(actionItem.owner || "");
  const item = stripLeadingTimestamp(actionItem.item || "액션 내용 없음");
  return owner ? `${owner} · ${item}` : item;
}

function problemGroupStatusLabel(status: ProblemGroupStatus) {
  if (status === "review") return "검토중";
  if (status === "final") return "확정";
  return "초안";
}

function problemGroupStatusTone(status: ProblemGroupStatus) {
  if (status === "review") return "bg-blue-100 text-blue-700";
  if (status === "final") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}

function normalizeCanvasItemStatus(raw: string | undefined): CanvasItemStatus {
  if (raw === "confirmed" || raw === "final") return "confirmed";
  if (raw === "closed") return "closed";
  return "discussion";
}

function canvasItemStatusLabel(status: CanvasItemStatus) {
  if (status === "confirmed") return "확정";
  if (status === "closed") return "종료";
  return "논의";
}

function canvasItemStatusTone(status: CanvasItemStatus) {
  if (status === "confirmed") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (status === "closed") return "bg-zinc-900 text-white border-zinc-900";
  return "bg-blue-100 text-blue-700 border-blue-200";
}

function normalizeSolutionAiSuggestionStatus(raw: string | undefined): SolutionAiSuggestionStatus {
  if (raw === "selected" || raw === "dismissed") return raw;
  return "draft";
}

function normalizeIdeationSuggestionStatus(raw: string | undefined) {
  if (raw === "selected" || raw === "dismissed") return raw;
  return "draft";
}

function normalizeSolutionNoteSource(raw: string | undefined): SolutionNoteSource {
  if (raw === "ai") return "ai";
  return "user";
}

function makeSolutionAiSuggestion(
  value: {
    id?: string;
    text?: string;
    status?: string;
  },
  fallbackId: string,
): SolutionAiSuggestionViewModel {
  return {
    id: value.id || fallbackId,
    text: value.text || "",
    status: normalizeSolutionAiSuggestionStatus(value.status),
  };
}

function makeSolutionNote(
  value: {
    id?: string;
    text?: string;
    source?: string;
    source_ai_id?: string;
    is_final_candidate?: boolean;
    final_comment?: string;
  },
  fallbackId: string,
): SolutionNoteViewModel {
  return {
    id: value.id || fallbackId,
    text: value.text || "",
    source: normalizeSolutionNoteSource(value.source),
    source_ai_id: value.source_ai_id || "",
    is_final_candidate: Boolean(value.is_final_candidate),
    final_comment: value.final_comment || "",
  };
}

function problemGroupPalette(index: number) {
  const palettes = [
    {
      shell: "from-violet-50 via-white to-violet-50/40 border-violet-200",
      pill: "from-violet-500 to-violet-600 text-white shadow-violet-300/60",
      note: "border-violet-100 bg-violet-100/90",
      noteAccent: "text-violet-700",
      conclusion: "bg-slate-900 text-white",
    },
    {
      shell: "from-cyan-50 via-white to-cyan-50/40 border-cyan-200",
      pill: "from-cyan-300 to-cyan-400 text-slate-900 shadow-cyan-200/70",
      note: "border-cyan-100 bg-cyan-100/85",
      noteAccent: "text-cyan-700",
      conclusion: "bg-slate-900 text-white",
    },
    {
      shell: "from-amber-50 via-white to-amber-50/40 border-amber-200",
      pill: "from-amber-300 to-yellow-400 text-slate-900 shadow-amber-200/70",
      note: "border-amber-100 bg-amber-100/85",
      noteAccent: "text-amber-700",
      conclusion: "bg-slate-900 text-white",
    },
    {
      shell: "from-fuchsia-50 via-white to-fuchsia-50/40 border-fuchsia-200",
      pill: "from-fuchsia-400 to-pink-500 text-white shadow-fuchsia-200/70",
      note: "border-fuchsia-100 bg-fuchsia-100/85",
      noteAccent: "text-fuchsia-700",
      conclusion: "bg-slate-900 text-white",
    },
  ];
  return palettes[index % palettes.length];
}

function makeProblemSummarySourceNodeId(groupId: string, index: number) {
  return `${groupId}-summary-${index}`;
}

function makeProblemSummaryTitle(index: number) {
  return `아이디어${index + 1}`;
}

function getProblemSummarySourceNodeKind(index: number): "topic" | "summary" {
  return index === 0 ? "topic" : "summary";
}

type ProblemSummaryEntry = {
  value: string;
  originSourceNodeId: string;
};

function buildProblemSummaryEntries(group: ProblemGroupViewModel): ProblemSummaryEntry[] {
  return (group.source_summary_items || []).map((value, index) => ({
    value,
    originSourceNodeId: makeProblemSummarySourceNodeId(group.group_id, index),
  }));
}

function remapProblemSummaryDiscussionTargets(
  groupId: string,
  discussionItems: ProblemDiscussionViewModel[] | undefined,
  nextSummaryEntries: ProblemSummaryEntry[],
) {
  const summaryTargetMap = new Map<string, {
    nodeId: string;
    label: string;
    kind: "topic" | "summary";
  }>();

  nextSummaryEntries.forEach((entry, index) => {
    summaryTargetMap.set(entry.originSourceNodeId, {
      nodeId: makeProblemSummarySourceNodeId(groupId, index),
      label: makeProblemSummaryTitle(index),
      kind: getProblemSummarySourceNodeKind(index),
    });
  });

  return (discussionItems || []).map((item) => {
    const target = item.target_node_id ? summaryTargetMap.get(item.target_node_id) : undefined;
    if (!target) return item;

    return {
      ...item,
      target_node_id: target.nodeId,
      target_node_label: target.label,
      target_node_kind: target.kind,
    };
  });
}

function buildProblemGroupDisplayCards(group: ProblemGroupViewModel): ProblemGroupDisplayCard[] {
  const summaryCards = (group.source_summary_items || []).map((item, index) => {
    const sourceNodeId = makeProblemSummarySourceNodeId(group.group_id, index);
    const hasAttachedDiscussion = (group.discussion_items || []).some(
      (discussion) => discussion.target_node_id === sourceNodeId,
    );

    return {
      id: sourceNodeId,
      title: makeProblemSummaryTitle(index),
      body: stripLeadingTimestamp(item) || "아직 요약된 아이디어가 없습니다.",
      kind: "summary",
      sourceNodeId,
      sourceNodeKind: getProblemSummarySourceNodeKind(index),
      attachable: index === 0 || hasAttachedDiscussion,
      cardKind: "summary" as const,
      sourceIndex: index,
      draggable: true,
      summaryText: item,
    };
  });
  const personalCards = (group.ideas || []).map((idea, index) => ({
    id: idea.id || `${group.group_id}-idea-${index}`,
    title: idea.title || `메모${index + 1}`,
    body: idea.body || "메모 내용 없음",
    kind: idea.kind || "memo",
    sourceNodeId: idea.id || `${group.group_id}-idea-${index}`,
    sourceNodeKind: "idea" as const,
    attachable: true,
    cardKind: "idea" as const,
    sourceIndex: index,
    draggable: Boolean(idea.id),
    ideaId: idea.id,
  }));

  if (summaryCards.length === 0 && personalCards.length === 0) {
    return [];
  }

  return [...summaryCards, ...personalCards];
}

function hydrateProblemGroups(
  groups: Array<CanvasProblemDefinitionGroup & { status?: string }>,
  previousGroups: ProblemGroupViewModel[] = [],
): ProblemGroupViewModel[] {
  const previousById = new Map(previousGroups.map((group) => [group.group_id, group]));

  return groups.map((group) => {
    const previous = previousById.get(group.group_id);
    const mergedIdeas = [...(group.ideas || [])];
    const hasIncomingDiscussions = Object.prototype.hasOwnProperty.call(group, "discussion_items");
    const incomingDiscussions = (group.discussion_items || []).filter((item) => item.id || item.title || item.body);
    const mergedDiscussions: ProblemDiscussionViewModel[] = [...incomingDiscussions];

    if (previous) {
      previous.ideas.forEach((idea) => {
        if (!mergedIdeas.some((item) => item.id === idea.id)) {
          mergedIdeas.push(idea);
        }
      });
      if (!hasIncomingDiscussions) {
        (previous.discussion_items || []).forEach((item) => {
          if (!mergedDiscussions.some((candidate) => candidate.id === item.id)) {
            mergedDiscussions.push(item);
          }
        });
      }
    }

    return {
      ...group,
      ideas: mergedIdeas,
      discussion_items: mergedDiscussions,
      insight_user_edited: group.insight_user_edited ?? previous?.insight_user_edited ?? false,
      conclusion_user_edited:
        group.conclusion_user_edited ?? previous?.conclusion_user_edited ?? false,
      source_signature: group.source_signature || previous?.source_signature || "",
      source_agenda_signatures: group.source_agenda_signatures || previous?.source_agenda_signatures || {},
      source_idea_signatures: group.source_idea_signatures || previous?.source_idea_signatures || {},
      status:
        group.status === "review" || group.status === "final" || group.status === "draft"
          ? group.status
          : previous?.status || "draft",
    };
  });
}

function makeStableSignature(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function resolveProblemDefinitionAgendaId(
  item: CanvasItemViewModel,
  itemById: Map<string, CanvasItemViewModel>,
) {
  if (item.agenda_id) {
    return item.agenda_id;
  }

  let parentTopicId = item.parent_topic_id || "";
  const visitedParentIds = new Set<string>();
  while (parentTopicId && !visitedParentIds.has(parentTopicId)) {
    visitedParentIds.add(parentTopicId);
    const parent = itemById.get(parentTopicId);
    if (!parent) break;
    if (parent.agenda_id) {
      return parent.agenda_id;
    }
    parentTopicId = parent.parent_topic_id || "";
  }

  return "";
}

function buildProblemDefinitionAgendaInputs(agendaModels: AgendaViewModel[]) {
  return agendaModels.map((agenda) => ({
    agenda_id: agenda.id,
    title: agenda.title,
    keywords: agenda.keywords,
    summary_bullets: agenda.summaryBullets,
  }));
}

function buildProblemDefinitionIdeaBody(
  item: CanvasItemViewModel,
  childItems: CanvasItemViewModel[],
) {
  const childSummaries = childItems
    .map((child) => [child.title, child.body].filter(Boolean).join(": ").trim())
    .filter(Boolean)
    .slice(0, 8);

  return [
    item.body || "",
    childSummaries.length > 0 ? `하위 아이디어: ${childSummaries.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function orderProblemDefinitionChildren(
  parent: CanvasItemViewModel,
  childItemsByParentId: Map<string, CanvasItemViewModel[]>,
) {
  const children = childItemsByParentId.get(parent.id) || [];
  const orderById = new Map((parent.child_item_ids || []).map((id, index) => [id, index]));

  return [...children].sort((left, right) => {
    const leftOrder = orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
  });
}

function collectProblemDefinitionDescendants(
  item: CanvasItemViewModel,
  childItemsByParentId: Map<string, CanvasItemViewModel[]>,
  limit = 24,
) {
  const descendants: CanvasItemViewModel[] = [];
  const visitedIds = new Set<string>();
  const visit = (parent: CanvasItemViewModel) => {
    if (descendants.length >= limit) return;
    orderProblemDefinitionChildren(parent, childItemsByParentId).forEach((child) => {
      if (descendants.length >= limit || visitedIds.has(child.id)) return;
      visitedIds.add(child.id);
      descendants.push(child);
      visit(child);
    });
  };

  visit(item);
  return descendants;
}

function buildProblemDefinitionIdeaInputs(
  canvasItems: CanvasItemViewModel[],
  personalNotes: PersonalNote[],
) {
  const itemById = new Map(canvasItems.map((item) => [item.id, item]));
  const childItemsByParentId = new Map<string, CanvasItemViewModel[]>();
  canvasItems.forEach((item) => {
    if (!item.parent_topic_id) return;
    const children = childItemsByParentId.get(item.parent_topic_id) || [];
    children.push(item);
    childItemsByParentId.set(item.parent_topic_id, children);
  });

  const canvasIdeas = canvasItems
    .filter((item) => !item.parent_topic_id)
    .map((item) => ({
      id: item.id,
      agenda_id: resolveProblemDefinitionAgendaId(item, itemById),
      kind: item.kind || "note",
      title: item.title || "",
      body: buildProblemDefinitionIdeaBody(
        item,
        collectProblemDefinitionDescendants(item, childItemsByParentId),
      ),
      ai_pending: Boolean(item.ai_pending),
    }))
    .filter((item) => (
      item.agenda_id &&
      !item.ai_pending &&
      Boolean(item.title.trim() || item.body.trim())
    ))
    .map((item) => ({
      id: item.id,
      agenda_id: item.agenda_id,
      kind: item.kind,
      title: item.title,
      body: item.body,
    }));

  const personalIdeas = personalNotes
    .map((note) => ({
      id: note.id,
      agenda_id: note.agendaId,
      kind: note.kind,
      title: note.title,
      body: note.body,
    }))
    .filter((item) => item.agenda_id && Boolean(item.title.trim() || item.body.trim()));

  return [...canvasIdeas, ...personalIdeas];
}

function buildProblemDefinitionIdeaSourceSignatures(
  canvasItems: CanvasItemViewModel[],
  personalNotes: PersonalNote[],
) {
  const signatures: Record<string, string> = {};
  const itemById = new Map(canvasItems.map((item) => [item.id, item]));
  const childItemsByParentId = new Map<string, CanvasItemViewModel[]>();

  canvasItems.forEach((item) => {
    if (!item.parent_topic_id) return;
    const children = childItemsByParentId.get(item.parent_topic_id) || [];
    children.push(item);
    childItemsByParentId.set(item.parent_topic_id, children);
  });

  canvasItems
    .filter((item) => !item.parent_topic_id && !item.ai_pending)
    .forEach((item) => {
      const descendants = collectProblemDefinitionDescendants(item, childItemsByParentId);
      signatures[item.id] = makeStableSignature({
        root: {
          id: item.id,
          agenda_id: resolveProblemDefinitionAgendaId(item, itemById),
          kind: item.kind || "note",
          title: item.title || "",
          body: item.body || "",
          keywords: item.keywords || [],
          child_item_ids: item.child_item_ids || [],
        },
        descendants: descendants.map((child) => ({
          id: child.id,
          parent_topic_id: child.parent_topic_id || "",
          kind: child.kind || "note",
          title: child.title || "",
          body: child.body || "",
          keywords: child.keywords || [],
          child_item_ids: child.child_item_ids || [],
          compacted_from_ids: child.compacted_from_ids || [],
          evidence_utterance_ids: child.evidence_utterance_ids || [],
          ignored_utterance_ids: child.ignored_utterance_ids || [],
        })),
      });
    });

  personalNotes.forEach((note) => {
    signatures[note.id] = makeStableSignature({
      id: note.id,
      agenda_id: note.agendaId,
      kind: note.kind,
      title: note.title,
      body: note.body,
      linked_canvas_item_id: note.linkedCanvasItemId || "",
    });
  });

  return signatures;
}

function buildProblemDefinitionAgendaSignatures(
  agendaModels: AgendaViewModel[],
) {
  const signatures: Record<string, string> = {};

  agendaModels.forEach((agenda) => {
    signatures[agenda.id] = makeStableSignature({
      agenda: {
        id: agenda.id,
        title: agenda.title,
        keywords: agenda.keywords || [],
        summary_bullets: agenda.summaryBullets || [],
      },
    });
  });

  return signatures;
}

function stampProblemGroupSource(
  group: ProblemGroupViewModel,
  agendaSignatures: Record<string, string>,
  ideaSignatures: Record<string, string>,
): ProblemGroupViewModel {
  const sourceAgendaSignatures = Object.fromEntries(
    (group.agenda_ids || [])
      .map((agendaId) => [agendaId, agendaSignatures[agendaId] || ""] as const)
      .filter(([, signature]) => Boolean(signature)),
  );
  const sourceIdeaSignatures = Object.fromEntries(
    (group.ideas || [])
      .map((idea) => [idea.id, ideaSignatures[idea.id] || ""] as const)
      .filter(([, signature]) => Boolean(signature)),
  );

  return {
    ...group,
    source_agenda_signatures: sourceAgendaSignatures,
    source_idea_signatures: sourceIdeaSignatures,
    source_signature: makeStableSignature({
      agendas: sourceAgendaSignatures,
      ideas: sourceIdeaSignatures,
    }),
  };
}

function getProblemGroupSourceIdeaIds(
  group: ProblemGroupViewModel,
  currentIdeaIds: Set<string>,
) {
  const savedIdeaIds = Object.keys(group.source_idea_signatures || {}).filter((id) => currentIdeaIds.has(id));
  if (savedIdeaIds.length > 0) return savedIdeaIds;

  return (group.ideas || [])
    .map((idea) => idea.id)
    .filter((id) => currentIdeaIds.has(id));
}

function makeUniqueProblemGroupId(baseId: string, usedIds: Set<string>) {
  const normalizedBase = baseId.trim() || "problem-group";
  if (!usedIds.has(normalizedBase)) {
    usedIds.add(normalizedBase);
    return normalizedBase;
  }

  let suffix = 2;
  while (usedIds.has(`${normalizedBase}-${suffix}`)) {
    suffix += 1;
  }
  const nextId = `${normalizedBase}-${suffix}`;
  usedIds.add(nextId);
  return nextId;
}

function shouldRefreshProblemGroup(
  group: ProblemGroupViewModel,
  agendaSignatures: Record<string, string>,
  agendaIdSet: Set<string>,
  ideaSignatures: Record<string, string>,
) {
  const currentAgendaIds = (group.agenda_ids || []).filter((agendaId) => agendaIdSet.has(agendaId));
  if (currentAgendaIds.length === 0) return false;

  const savedIdeaSignatures = group.source_idea_signatures || {};
  const savedIdeaIds = Object.keys(savedIdeaSignatures);
  if (savedIdeaIds.length > 0) {
    const hasChangedIdea = savedIdeaIds.some(
      (ideaId) => savedIdeaSignatures[ideaId] !== ideaSignatures[ideaId],
    );
    if (hasChangedIdea) return true;
  }

  const savedSignatures = group.source_agenda_signatures || {};
  if (!group.source_signature || Object.keys(savedSignatures).length === 0) return true;

  return currentAgendaIds.some((agendaId) => savedSignatures[agendaId] !== agendaSignatures[agendaId]);
}

function safeDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function normalizeTranscriptRows(rows: MeetingTranscript[] | TranscriptUtterance[]) {
  return rows.map((row, index) => ({
    id: "id" in row ? row.id : `${row.timestamp || "turn"}-${index}`,
    speaker: row.speaker,
    text: row.text,
    timestamp: row.timestamp,
    canvas_stage: "canvas_stage" in row ? row.canvas_stage || "ideation" : "ideation",
    canvas_target_id: "canvas_target_id" in row ? row.canvas_target_id || "" : "",
    turnId: index + 1,
  }));
}

function buildAgendaModels(
  analysisState: MeetingState | null,
  agendas: MeetingAgenda[],
  transcripts: MeetingTranscript[],
): AgendaViewModel[] {
  const transcriptRows = normalizeTranscriptRows((analysisState?.transcript?.length ? analysisState.transcript : transcripts) || []);
  const outcomes = analysisState?.analysis?.agenda_outcomes || [];

  if (outcomes.length > 0) {
    return outcomes.map((outcome, index) => {
      const start = Math.max(1, Number(outcome.start_turn_id || 1));
      const end = Math.max(start, Number(outcome.end_turn_id || transcriptRows.length || start));
      return {
        id: outcome.agenda_id || `agenda-${index + 1}`,
        title: stripLeadingTimestamp(outcome.agenda_title || "") || `안건 ${index + 1}`,
        status: outcome.agenda_state || "PROPOSED",
        keywords: (outcome.agenda_keywords || []).map(stripLeadingTimestamp).filter(Boolean),
        summaryBullets:
          (outcome.agenda_summary_items || []).filter(Boolean).slice(0, 4).length > 0
            ? (outcome.agenda_summary_items || []).filter(Boolean).slice(0, 4).map(stripLeadingTimestamp)
            : [outcome.summary].filter(Boolean).map(stripLeadingTimestamp),
        utterances: transcriptRows.filter((row) => row.turnId >= start && row.turnId <= end),
        decisions: outcome.decision_results || [],
        actionItems: outcome.action_items || [],
      };
    });
  }

  if (agendas.length > 0) {
    return agendas.map((agenda, index) => ({
      id: agenda.id,
      title: agenda.title,
      status: agenda.status || "PROPOSED",
      keywords: [],
      summaryBullets: [],
      utterances: index === 0 ? transcriptRows : [],
      decisions: [],
      actionItems: [],
    }));
  }

  return [
    {
      id: "agenda-fallback",
      title: "현재 회의",
      status: "ACTIVE",
      keywords: [],
      summaryBullets: [],
      utterances: transcriptRows,
      decisions: [],
      actionItems: [],
    },
  ];
}

function makeNodeLabel(badge: string, title: string, body: string | string[], meta: string[], accent: string) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${accent}`}>{badge}</span>
        {meta[0] ? <span className="text-xs text-slate-400">{meta[0]}</span> : null}
      </div>
      <strong className="mt-3 block text-base text-slate-900">{title}</strong>
      {Array.isArray(body) ? (
        <div className="mt-3 space-y-2">
          {body.filter(Boolean).slice(0, 3).map((line, index) => (
            <div key={`${title}-line-${index}`} className="rounded-xl bg-white/75 px-3 py-2 text-sm leading-6 text-slate-600">
              {line}
            </div>
          ))}
        </div>
      ) : body ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
      ) : null}
      {meta.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {meta.slice(1, 4).map((item) => (
            <span key={`${title}-${item}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function makeAgendaNodeLabel(title: string, summary: string, status: string, keywords: string[]) {
  return (
    <div className="min-w-0 p-1">
      <div className="rounded-[24px] bg-gradient-to-br from-amber-50 via-white to-white p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
            Group
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
            {status}
          </span>
        </div>
        <strong className="mt-4 block text-[17px] leading-7 text-slate-900">
          {title}
        </strong>
        <div className="mt-4 px-1">
          <p className="text-sm leading-6 text-slate-600">
            {summary}
          </p>
        </div>
        {keywords.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {keywords.slice(0, 3).map((item) => (
              <span key={`${title}-${item}`} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                #{item}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function canvasItemTone(kind: ComposerTool) {
  if (kind === "comment") {
    return {
      shell: "bg-[linear-gradient(128deg,#eef7ff_0%,#ffffff_100%)]",
      badge: "bg-sky-100 text-sky-700",
      accent: "text-sky-700",
    };
  }
  if (kind === "topic") {
    return {
      shell: "bg-[linear-gradient(128deg,#eefbf7_0%,#ffffff_100%)]",
      badge: "bg-fuchsia-100 text-fuchsia-700",
      accent: "text-fuchsia-700",
    };
  }
  return {
    shell: "bg-[linear-gradient(128deg,#fefbee_0%,#ffffff_100%)]",
    badge: "bg-amber-100 text-amber-700",
    accent: "text-amber-700",
  };
}

const CANVAS_ITEM_NODE_WIDTH = 320;
const CANVAS_ITEM_NODE_MIN_HEIGHT = 252;
const CANVAS_TOPIC_CHILD_GAP_X = 24;
const CANVAS_TOPIC_CHILD_GAP_Y = 14;
const CANVAS_TOPIC_CHILDS_PER_ROW = 999;
const CANVAS_IDEATION_DROP_ZONE_VERTICAL_PADDING = 28;
const CANVAS_IDEATION_LEFT_X = 0;
const CANVAS_IDEATION_RIGHT_X = 0;
const CANVAS_IDEATION_FRAME_Y = 0;
const CANVAS_IDEATION_LEFT_WIDTH = 360;
const CANVAS_IDEATION_RIGHT_WIDTH = 820;
const CANVAS_IDEATION_HEADER_HEIGHT = 92;
const CANVAS_IDEATION_GROUP_GAP_Y = 18;
const CANVAS_IDEATION_DETAIL_GAP_X = 28;
const CANVAS_IDEATION_DETAIL_GAP_Y = 24;
const CANVAS_TOP_LEVEL_GAP_Y = 16;
const CANVAS_AGENDA_TO_ITEMS_GAP_Y = 18;
const CANVAS_AGENDA_BLOCK_GAP_X = 1080;
const CANVAS_AGENDA_BLOCK_GAP_Y = 56;

function estimateCanvasItemNodeHeight(item: CanvasItemViewModel) {
  const pending = Boolean(item.ai_pending);
  const titleLines = Math.min(3, estimateWrappedLines(pending ? "AI 정리 중" : item.title || "내용 상세보기", 18));
  const body = pending ? "요약 생성 중" : cleanCanvasNodeBodyText(item.body);
  const bodyLines = body ? estimateWrappedLines(body, 26) : 0;
  const keywordCount = pending ? 3 : Math.max((item.keywords || []).filter(Boolean).length, 3);
  const keywordRows = Math.max(1, Math.ceil(keywordCount / 3));
  const footerLines = item.point_id ? 1 : 0;

  return Math.max(
    CANVAS_ITEM_NODE_MIN_HEIGHT,
    88 + titleLines * 26 + bodyLines * 25 + keywordRows * 28 + footerLines * 18,
  );
}

const CANVAS_ITEM_KEYWORD_STOPWORDS = new Set([
  "note",
  "comment",
  "topic",
  "memo",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "메모",
  "코멘트",
  "주제",
  "내용",
  "입력",
  "입력해",
  "작성",
  "정리",
  "정리해",
  "해주세요",
  "주세요",
  "새",
  "신규",
  "공용",
  "canvas",
  "캔버스",
]);

function normalizeCanvasItemKeyword(raw: string) {
  const token = raw
    .trim()
    .replace(/^#+/, "")
    .replace(/^[^\w가-힣]+|[^\w가-힣]+$/g, "");
  if (!token || token.length < 2 || /^\d+$/.test(token)) return "";

  const normalized = /[A-Za-z]/.test(token)
    ? token.toLowerCase()
    : token.replace(/(으로|에서|에게|까지|부터|처럼|보다|은|는|이|가|을|를|에|와|과|로|의|도|만)$/u, "");
  if (!normalized || normalized.length < 2) return "";
  if (CANVAS_ITEM_KEYWORD_STOPWORDS.has(normalized)) return "";

  return normalized;
}

function extractCanvasItemKeywords(title: string, body: string, limit = 5) {
  const scores = new Map<string, { value: string; score: number; firstSeen: number }>();
  let cursor = 0;

  const addSource = (source: string, weight: number) => {
    const matches = source.match(/[A-Za-z0-9가-힣][A-Za-z0-9가-힣+#._-]{1,}/g) || [];
    matches.forEach((match) => {
      const keyword = normalizeCanvasItemKeyword(match);
      if (!keyword) return;

      const existing = scores.get(keyword);
      if (existing) {
        existing.score += weight;
        return;
      }

      scores.set(keyword, {
        value: keyword,
        score: weight,
        firstSeen: cursor,
      });
      cursor += 1;
    });
  };

  addSource(title, 2);
  addSource(body, 1);

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, limit)
    .map((entry) => entry.value);
}

function getCanvasItemMergedSourceCount(item: CanvasItemViewModel): number {
  const explicitCount = (item.compacted_from_ids || []).filter(Boolean).length;
  if (explicitCount > 0) return explicitCount;

  const childCount = (item.merged_children || []).reduce(
    (sum, child) => sum + getCanvasItemMergedSourceCount(child),
    0,
  );
  return childCount || 1;
}

function isTopicCanvasItem(item: CanvasItemViewModel) {
  return item.kind === "topic";
}

function isCountableIdeationChildNode(item: CanvasItemViewModel) {
  if (isTopicCanvasItem(item)) return true;
  return !item.ai_pending && Boolean(item.title.trim() || item.body.trim());
}

function getCanvasIdeaCreateStackFallback(items: CanvasItemViewModel[]) {
  return items
    .filter((item) => item.ai_generated && !item.ai_pending && Boolean(item.title.trim() || item.body.trim()))
    .reduce((sum, item) => sum + getCanvasItemMergedSourceCount(item), 0);
}

function getTopicChildCount(item: CanvasItemViewModel) {
  return (item.child_item_ids || []).filter(Boolean).length;
}

function getTopicDirectChildIds(
  items: CanvasItemViewModel[],
  topicId: string,
) {
  const topic = items.find((item) => item.id === topicId);
  return [
    ...new Set([
      ...(topic?.child_item_ids || []),
      ...items.filter((item) => item.parent_topic_id === topicId).map((item) => item.id),
    ]),
  ].filter((childId) => childId !== topicId);
}

function getTopicFlattenedIdeaChildIds(
  items: CanvasItemViewModel[],
  topicId: string,
) {
  const childIds: string[] = [];
  const visitedTopicIds = new Set<string>();

  const visitTopic = (currentTopicId: string) => {
    if (visitedTopicIds.has(currentTopicId)) return;
    visitedTopicIds.add(currentTopicId);

    getTopicDirectChildIds(items, currentTopicId).forEach((childId) => {
      const child = items.find((item) => item.id === childId);
      if (!child) return;
      if (isTopicCanvasItem(child)) {
        visitTopic(child.id);
        return;
      }
      childIds.push(child.id);
    });
  };

  visitTopic(topicId);
  return [...new Set(childIds)];
}

function getTopicDescendantTopicIds(
  items: CanvasItemViewModel[],
  topicId: string,
) {
  const topicIds: string[] = [];
  const visitedTopicIds = new Set<string>();

  const visitTopic = (currentTopicId: string) => {
    if (visitedTopicIds.has(currentTopicId)) return;
    visitedTopicIds.add(currentTopicId);

    getTopicDirectChildIds(items, currentTopicId).forEach((childId) => {
      const child = items.find((item) => item.id === childId);
      if (!child || !isTopicCanvasItem(child)) return;
      topicIds.push(child.id);
      visitTopic(child.id);
    });
  };

  visitTopic(topicId);
  return [...new Set(topicIds)];
}

function getCanvasItemTopLevelAncestorId(
  items: CanvasItemViewModel[],
  itemId: string,
) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  let current = itemById.get(itemId) || null;
  const visited = new Set<string>();

  while (current?.parent_topic_id && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = itemById.get(current.parent_topic_id);
    if (!parent) break;
    current = parent;
  }

  return current?.id || itemId;
}

function getCanvasItemDescendantIds(
  items: CanvasItemViewModel[],
  itemId: string,
) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const descendantIds: string[] = [];
  const visited = new Set<string>();

  const visit = (parentId: string) => {
    if (visited.has(parentId)) return;
    visited.add(parentId);

    getTopicDirectChildIds(items, parentId).forEach((childId) => {
      const child = itemById.get(childId);
      if (!child || descendantIds.includes(child.id)) return;
      descendantIds.push(child.id);
      visit(child.id);
    });
  };

  visit(itemId);
  return descendantIds;
}

function getCanvasItemDepth(
  items: CanvasItemViewModel[],
  itemId: string,
) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  let current = itemById.get(itemId) || null;
  let depth = 0;
  const visited = new Set<string>();

  while (current?.parent_topic_id && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = itemById.get(current.parent_topic_id);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  return depth;
}

function buildUserMergedTopicTitle(
  left: CanvasItemViewModel,
  right: CanvasItemViewModel,
) {
  const keywords = [...(left.keywords || []), ...(right.keywords || [])]
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  if (keywords.length > 0) {
    return `${keywords[0]} 묶음`;
  }

  const titleSource = [left.title, right.title]
    .map((title) => title.trim())
    .filter(Boolean)[0];
  return titleSource ? `${titleSource.slice(0, 12)} 묶음` : "새 주제 묶음";
}

function makeIdeationMergeDropPreview(
  draggedItem: CanvasItemViewModel,
  targetItem: CanvasItemViewModel,
  position: { x: number; y: number },
): IdeationDropPreviewState | null {
  if (draggedItem.id === targetItem.id) return null;

  if (isTopicCanvasItem(targetItem)) {
    if (isTopicCanvasItem(draggedItem)) {
      return {
        draggedItemId: draggedItem.id,
        targetId: targetItem.id,
        mode: "topic-merge",
        agendaId: targetItem.agenda_id || draggedItem.agenda_id,
        position,
        label: "토픽 통합",
        hint: `"${targetItem.title || "토픽"}"과 합쳐 새 토픽으로 재구성합니다.`,
      };
    }

    return {
      draggedItemId: draggedItem.id,
      targetId: targetItem.id,
      mode: "topic",
      agendaId: targetItem.agenda_id || draggedItem.agenda_id,
      position,
      label: "이 토픽에 병합",
      hint: `"${targetItem.title || "토픽"}" 하위로 넣고 토픽 내용을 다시 정리합니다.`,
    };
  }

  if (isTopicCanvasItem(draggedItem)) {
    return {
      draggedItemId: draggedItem.id,
      targetId: targetItem.id,
      mode: "topic-idea-merge",
      agendaId: targetItem.agenda_id || draggedItem.agenda_id,
      position,
      label: "새 토픽으로 통합",
      hint: `"${targetItem.title || "대상 노드"}"와 토픽을 새 주제로 묶습니다.`,
    };
  }

  return {
    draggedItemId: draggedItem.id,
    targetId: targetItem.id,
    mode: "merge",
    agendaId: targetItem.agenda_id || draggedItem.agenda_id,
    position,
    label: "새 토픽으로 묶기",
    hint: `"${targetItem.title || "대상 노드"}"와 함께 새 토픽을 만듭니다.`,
  };
}

function getCanvasItemChangeSignature(item: CanvasItemViewModel) {
  return makeStableSignature({
    id: item.id,
    kind: item.kind,
    status: normalizeCanvasItemStatus(item.status),
    title: item.title,
    body: item.body,
    keywords: item.keywords || [],
    parent_topic_id: item.parent_topic_id || "",
    child_item_ids: item.child_item_ids || [],
    compacted_from_ids: item.compacted_from_ids || [],
    evidence_utterance_ids: item.evidence_utterance_ids || [],
    ignored_utterance_ids: item.ignored_utterance_ids || [],
    ai_pending: Boolean(item.ai_pending),
  });
}

function cleanCanvasNodeBodyText(value: string | undefined) {
  const text = (value || "").trim();
  if (!text || /^content\s*:?\s*$/i.test(text)) {
    return "";
  }
  return text;
}

function makeCanvasItemNodeLabel(
  item: CanvasItemViewModel,
  selected: boolean,
  _linkedAgendaTitle: string,
  onToggleTopicCollapsed?: (itemId: string) => void,
  highlighted = false,
) {
  const tone = canvasItemTone((item.kind as ComposerTool) || "note");
  const keywords = (item.keywords || []).filter(Boolean);
  const pending = Boolean(item.ai_pending);
  const mergedSourceCount = getCanvasItemMergedSourceCount(item);
  const topicChildCount = getTopicChildCount(item);
  const showTopicToggle = isTopicCanvasItem(item) && topicChildCount > 0;
  const title = pending ? "AI 정리 중" : item.title || "내용 상세보기";
  const body = pending ? "" : cleanCanvasNodeBodyText(item.body);
  const backgroundClass = highlighted ? "bg-[linear-gradient(128deg,#fef1ee_0%,#ffffff_100%)]" : tone.shell;
  const borderClass = selected ? "border-black" : "border-black/10";
  const displayKeywords = pending ? [] : keywords.length > 0 ? keywords : ["키워드", "키워드", "키워드"];

  return (
    <div className="min-w-0">
      <div
        className={`nopan imms-canvas-node-drag-handle relative flex h-full min-h-[252px] w-full cursor-grab flex-col rounded-[18px] border px-5 py-4 text-center font-['Inter','Noto_Sans_KR',sans-serif] transition-colors active:cursor-grabbing ${backgroundClass} ${borderClass}`}
      >
        <div className="flex min-h-[28px] w-full items-start justify-between gap-2">
          <span />
          {showTopicToggle ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleTopicCollapsed?.(item.id);
              }}
              className="nodrag shrink-0 rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#4d4d4d] shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-white"
            >
              {item.topic_collapsed ? "펼치기" : "접기"} {topicChildCount}
            </button>
          ) : mergedSourceCount > 1 ? (
            <span className="shrink-0 rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#4d4d4d] shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
              묶음 {mergedSourceCount}
            </span>
          ) : null}
        </div>
        <strong className="mt-3 max-w-full text-[18px] font-semibold leading-[24.811px] text-black line-clamp-2">
          {title}
        </strong>
        {pending ? (
          <p className="mt-3 text-[16px] font-normal leading-[24.811px] text-[#4d4d4d]">
            요약 생성 중
          </p>
        ) : body ? (
          <p className="mx-auto mt-3 max-w-full whitespace-pre-wrap break-words text-[16px] font-normal leading-[24.811px] text-[#4d4d4d]">
            {body}
          </p>
        ) : null}
        {pending ? (
          <div className="mt-auto flex justify-center gap-2.5 pt-4">
            {[0, 1, 2].map((index) => (
              <span key={`${item.id}-pending-keyword-${index}`} className="h-4 w-[48px] animate-pulse rounded-full bg-black/10" />
            ))}
          </div>
        ) : (
          <div className="mt-auto flex max-w-full flex-wrap justify-center gap-x-2.5 gap-y-1.5 pt-4">
            {displayKeywords.map((keyword, index) => (
              <span key={`${item.id}-${keyword}-${index}`} className="max-w-[86px] truncate whitespace-nowrap text-[15px] font-normal leading-[24.811px] text-[#4d4d4d]">
                #{keyword}
              </span>
            ))}
          </div>
        )}
        {item.point_id ? (
          <p className={`mt-1 truncate text-[11px] font-medium ${tone.accent}`}>
            연결 노드: {item.point_id}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function makeIdeationFrameLabel(title: string, subtitle: string, countLabel: string) {
  return (
    <div className="h-full min-h-full rounded-[28px] border border-black/10 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#1b59f8]">{title}</p>
          <p className="mt-1 text-sm leading-6 text-[#4d4d4d]">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full bg-[#eef4ff] px-3 py-1 text-xs font-semibold text-[#1b59f8]">
          {countLabel}
        </span>
      </div>
    </div>
  );
}

function makeIdeationGroupNodeLabel(
  item: CanvasItemViewModel,
  selected: boolean,
  childItems: CanvasItemViewModel[],
  descendantCount: number,
  highlighted = false,
  dropTarget = false,
  dropTargetLabel = "여기로 이동",
  dropTargetHint = "",
) {
  const tone = canvasItemTone((item.kind as ComposerTool) || "topic");
  const title = item.ai_pending ? "AI 정리 중" : item.title || "그룹";
  const body = item.ai_pending ? "하위 내용을 정리하는 중" : cleanCanvasNodeBodyText(item.body);
  const childPreview = childItems.slice(0, 3);
  const status = normalizeCanvasItemStatus(item.status);
  const borderClass = dropTarget
    ? "border-[#1b59f8] shadow-[0_0_0_4px_rgba(27,89,248,0.14),0_14px_30px_rgba(15,23,42,0.16)]"
    : selected
      ? "border-black shadow-[0_14px_30px_rgba(15,23,42,0.16)]"
      : "border-black/10";
  const backgroundClass = highlighted ? "bg-[linear-gradient(128deg,#fef1ee_0%,#ffffff_100%)]" : tone.shell;

  return (
    <div className="min-w-0">
      <div className={`nopan imms-canvas-node-drag-handle cursor-grab rounded-[20px] border px-4 py-4 font-['Inter','Noto_Sans_KR',sans-serif] transition active:cursor-grabbing ${backgroundClass} ${borderClass}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${canvasItemStatusTone(status)}`}>
            {dropTarget ? dropTargetLabel : canvasItemStatusLabel(status)}
          </span>
          <span className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-[#4d4d4d]">
            하위 {descendantCount}
          </span>
        </div>
        {dropTarget && dropTargetHint ? (
          <p className="mt-3 rounded-xl border border-[#1b59f8]/20 bg-white/85 px-3 py-2 text-xs font-semibold leading-5 text-[#1b59f8]">
            {dropTargetHint}
          </p>
        ) : null}
        <strong className="mt-3 block line-clamp-2 text-[17px] font-semibold leading-6 text-black">
          {title}
        </strong>
        {body ? (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#4d4d4d]">
            {body}
          </p>
        ) : null}
        {childPreview.length > 0 ? (
          <div className="mt-4 space-y-1.5 border-l border-black/15 pl-3">
            {childPreview.map((child) => (
              <div key={`${item.id}-child-preview-${child.id}`} className="flex items-center gap-2 text-xs text-[#4d4d4d]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#1b59f8]/60" />
                <span className="truncate">{child.title || toolLabel((child.kind as ComposerTool) || "note")}</span>
              </div>
            ))}
            {descendantCount > childPreview.length ? (
              <p className="text-xs font-medium text-[#1b59f8]">+{descendantCount - childPreview.length}개 더 있음</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-black/10 bg-white/60 px-3 py-2 text-xs leading-5 text-[#777]">
            아직 오른쪽 캔버스에 하위 내용이 없습니다.
          </p>
        )}
      </div>
    </div>
  );
}

function makeIdeationEmptyDetailLabel(title: string, body: string) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center rounded-[24px] border border-dashed border-black/10 bg-white/75 px-6 py-8 text-center">
      <p className="text-base font-semibold text-slate-900">{title}</p>
      <p className="mt-2 max-w-[320px] text-sm leading-6 text-slate-500">{body}</p>
    </div>
  );
}

function makeIdeationDragGhostLabel(item: CanvasItemViewModel, dropLabel = "이동 중") {
  const tone = canvasItemTone((item.kind as ComposerTool) || "note");
  const body = cleanCanvasNodeBodyText(item.body);

  return (
    <div className={`rounded-[18px] border px-4 py-3 shadow-[0_20px_48px_rgba(15,23,42,0.22)] backdrop-blur ${tone.shell} border-black/10`}>
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-semibold text-[#1b59f8]">
          {dropLabel}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-black/35">
          Drag
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-black">
        {item.title || toolLabel((item.kind as ComposerTool) || "note")}
      </p>
      {body ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#4d4d4d]">
          {body}
        </p>
      ) : null}
    </div>
  );
}

function solutionTopicSelectedSuggestions(topic: SolutionTopicViewModel) {
  return (topic.ai_suggestions || []).filter((item) => item.status === "selected");
}

function solutionTopicFinalNotes(topic: SolutionTopicViewModel) {
  return (topic.notes || []).filter((note) => note.is_final_candidate);
}

function makeSolutionNodeLabel(topic: SolutionTopicViewModel, selected: boolean) {
  const selectedAiCount = solutionTopicSelectedSuggestions(topic).length;
  const finalCount = solutionTopicFinalNotes(topic).length;
  return (
    <div
      className={`nopan box-border flex h-full w-full min-w-0 cursor-pointer flex-col justify-start border bg-white px-4 py-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] transition ${
        selected
          ? "border-black shadow-[0_14px_30px_rgba(15,23,42,0.16)]"
          : "border-black/10 shadow-[0_1px_0_rgba(0,0,0,0.04)] hover:border-emerald-300"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
            Insight {topic.topic_no || 0}
          </p>
          <strong className="mt-2 block line-clamp-2 text-[17px] font-semibold leading-6 text-slate-950">
            {topic.topic}
          </strong>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${problemGroupStatusTone(topic.status)}`}>
          {problemGroupStatusLabel(topic.status)}
        </span>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-[#4d4d4d]">
        {topic.conclusion || topic.problem_conclusion || "해결 방향이 아직 없습니다."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold">
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">
          AI {topic.ai_suggestions.length}
        </span>
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">
          채택 {selectedAiCount}
        </span>
        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">
          결론 {finalCount}
        </span>
      </div>
    </div>
  );
}

function makeSolutionOverviewNodeLabel(topic: SolutionTopicViewModel) {
  return (
    <div className="nopan box-border flex h-full w-full flex-col justify-start border border-black/10 bg-white px-5 py-5 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">해결 방향</p>
          <h4 className="mt-2 text-xl font-semibold leading-8 text-slate-950">{topic.topic}</h4>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${problemGroupStatusTone(topic.status)}`}>
          {problemGroupStatusLabel(topic.status)}
        </span>
      </div>
      <p className="mt-4 line-clamp-4 text-base leading-7 text-[#4d4d4d]">
        {topic.conclusion || topic.problem_conclusion || "해결 방향이 아직 없습니다."}
      </p>
      <div className="mt-4 grid gap-3 text-sm leading-6 text-[#4d4d4d] md:grid-cols-3">
        <div className="border border-black/10 bg-[#fafafa] px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777]">문제정의</p>
          <p className="mt-1 line-clamp-2">{topic.problem_topic || "연결된 문제정의 없음"}</p>
        </div>
        <div className="border border-black/10 bg-[#fafafa] px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777]">인사이트</p>
          <p className="mt-1 line-clamp-2">{topic.problem_insight || "인사이트 없음"}</p>
        </div>
        <div className="border border-black/10 bg-[#fafafa] px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777]">출처</p>
          <p className="mt-1 line-clamp-2">{topic.agenda_titles.length > 0 ? topic.agenda_titles.join(", ") : "연결 안건 없음"}</p>
        </div>
      </div>
    </div>
  );
}

function makeSolutionAiSuggestionNodeLabel(
  suggestion: SolutionAiSuggestionViewModel,
  index: number,
  onAdopt: (event: React.MouseEvent<HTMLButtonElement>) => void,
  busy = false,
) {
  const selected = suggestion.status === "selected";
  if (busy) {
    return (
      <article className="nopan box-border flex h-full w-full flex-col justify-center border border-emerald-100 bg-white px-4 py-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)]">
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 animate-ping rounded-full bg-emerald-500" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
              AI 추천 생성 중
            </p>
            <p className="mt-1 text-sm leading-6 text-[#4d4d4d]">
              선택한 인사이트 기준으로 해결책 아이디어를 다시 정리하고 있습니다.
            </p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`nopan box-border flex h-full w-full flex-col justify-start border px-4 py-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] ${
      selected ? "border-blue-100 bg-slate-50/90 opacity-80" : "border-black/10 bg-white"
    } shadow-[0_1px_0_rgba(0,0,0,0.04)]`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#777]">AI 제안 {index + 1}</p>
          <p className={`mt-2 line-clamp-5 text-sm leading-6 ${selected ? "text-slate-500" : "text-[#4d4d4d]"}`}>
            {suggestion.text}
          </p>
          {selected ? (
            <p className="mt-2 text-xs font-semibold text-blue-600">채택 카드로 이동됨</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onAdopt}
          disabled={selected}
          className="nodrag shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {selected ? "채택됨" : "채택"}
        </button>
      </div>
    </article>
  );
}

function makeSolutionNoteNodeLabel(
  note: SolutionNoteViewModel,
  index: number,
  onToggleFinal: (event: React.MouseEvent<HTMLButtonElement>) => void,
  editing: boolean,
  textDraft: string,
  finalCommentDraft: string,
  onStartEdit: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onTextDraftChange: (value: string) => void,
  onFinalCommentDraftChange: (value: string) => void,
  onSaveEdit: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onCancelEdit: (event: React.MouseEvent<HTMLButtonElement>) => void,
) {
  const sourceLabel = note.source === "ai" ? `AI 채택 카드 ${index + 1}` : `사용자 카드 ${index + 1}`;
  const shellClass = note.is_final_candidate
    ? "border-slate-900 bg-white"
    : note.source === "ai"
      ? "border-blue-100 bg-blue-50/70"
      : "border-amber-100 bg-amber-50/80";
  const labelClass = note.is_final_candidate
    ? "text-slate-900"
    : note.source === "ai"
      ? "text-blue-700"
      : "text-amber-700";

  return (
    <article className={`nopan box-border flex h-full w-full flex-col justify-start border px-4 py-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)] ${shellClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${labelClass}`}>
            {sourceLabel}
          </p>
          {editing ? (
            <textarea
              value={textDraft}
              onChange={(event) => onTextDraftChange(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              placeholder="해결책 카드 내용을 입력합니다."
              className="nodrag mt-2 min-h-[92px] w-full rounded-xl border border-black/10 bg-white px-3 py-3 text-sm leading-6 text-slate-700 focus:border-black/30 focus:outline-none"
            />
          ) : (
            <p className="mt-2 line-clamp-5 text-sm leading-6 text-slate-700">{note.text}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            onClick={onToggleFinal}
            className={`nodrag rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              note.is_final_candidate
                ? "bg-slate-900 text-white"
                : "border border-black/10 bg-white text-[#4d4d4d] hover:bg-[#f5f6f8]"
            }`}
          >
            {note.is_final_candidate ? "최종 결론" : "결론 후보"}
          </button>
          {editing ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onCancelEdit}
                className="nodrag rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#777] transition hover:bg-[#f5f6f8]"
              >
                취소
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                className="nodrag rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
              >
                저장
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onStartEdit}
              className="nodrag rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8]"
            >
              편집
            </button>
          )}
        </div>
      </div>
      {note.is_final_candidate && editing ? (
        <textarea
          value={finalCommentDraft}
          onChange={(event) => onFinalCommentDraftChange(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder="최종 결론에 붙일 설명을 입력합니다."
          className="nodrag mt-3 min-h-[72px] w-full rounded-xl border border-black/10 bg-white px-3 py-3 text-sm leading-6 text-slate-700 focus:border-black/30 focus:outline-none"
        />
      ) : note.is_final_candidate ? (
        <p className="mt-3 rounded-xl border border-black/10 bg-white px-3 py-3 text-xs leading-5 text-slate-500">
          {note.final_comment || "최종 결론 설명은 편집을 눌러 추가할 수 있습니다."}
        </p>
      ) : null}
    </article>
  );
}

function makeSolutionComposerNodeLabel(
  draft: string,
  onDraftChange: (value: string) => void,
  onAdd: (event: React.MouseEvent<HTMLButtonElement>) => void,
) {
  return (
    <div className="nopan box-border flex h-full w-full flex-col justify-start border border-black/10 bg-[#fafafa] px-4 py-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)]">
      <p className="text-sm font-semibold text-slate-700">사용자 해결책 추가</p>
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        placeholder="직접 해결책 메모를 추가합니다."
        className="nodrag mt-3 min-h-[96px] w-full rounded-xl border border-black/10 bg-white px-3 py-3 text-sm leading-6 text-slate-700 focus:border-black/30 focus:outline-none"
      />
      <button
        type="button"
        onClick={onAdd}
        className="nodrag mt-3 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        카드 추가
      </button>
    </div>
  );
}

function makeSolutionFinalNoteNodeLabel(
  note: {
    id: string;
    topicId: string;
    topicTitle: string;
    text: string;
    final_comment: string;
  },
  active: boolean,
  onFocus: (event: React.MouseEvent<HTMLButtonElement>) => void,
) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className={`nopan nodrag box-border block h-full w-full border px-4 py-3 text-left font-['Inter','Noto_Sans_KR',sans-serif] transition ${
        active ? "border-slate-900 bg-white" : "border-black/10 bg-[#fafafa] hover:bg-white"
      }`}
    >
      <p className="text-sm font-semibold text-slate-700">{note.topicTitle}</p>
      <p className="mt-2 line-clamp-4 text-sm leading-6 text-slate-700">{note.text}</p>
      {note.final_comment ? (
        <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500">{note.final_comment}</p>
      ) : null}
    </button>
  );
}

function makeSolutionEmptyNodeLabel() {
  return (
    <div className="nopan box-border flex h-full w-full flex-col items-center justify-center border border-dashed border-black/10 bg-white px-6 py-8 text-center font-['Inter','Noto_Sans_KR',sans-serif]">
      <p className="text-base font-semibold text-slate-950">해결책 인사이트를 선택해 주세요</p>
      <p className="mt-2 text-sm leading-6 text-[#777]">
        왼쪽 인사이트를 클릭하면 AI 추천 아이디어와 채택 카드가 오른쪽 캔버스에 표시됩니다.
      </p>
    </div>
  );
}

function makeProblemGroupNodeLabel(
  group: ProblemGroupViewModel,
  index: number,
  selected: boolean,
  loading: boolean,
  dropTarget: boolean,
  selectedSourceNodeId: string,
  problemIdeaDrag: ProblemIdeaDragState | null,
  problemIdeaDropPreview: ProblemIdeaDropPreviewState | null,
  onSourceNodeSelect: (sourceNodeId: string) => void,
  onProblemIdeaDragStart: (event: React.DragEvent<HTMLDivElement>, card: ProblemGroupDisplayCard) => void,
  onProblemIdeaDragMove: (event: React.DragEvent<HTMLDivElement>) => void,
  onProblemIdeaPointerDown: (event: React.PointerEvent<HTMLDivElement>, card: ProblemGroupDisplayCard) => void,
  onProblemIdeaDragOver: (event: React.DragEvent<HTMLDivElement>, card?: ProblemGroupDisplayCard) => void,
  onProblemIdeaDrop: (event: React.DragEvent<HTMLDivElement>) => void,
  onProblemIdeaDragEnd: () => void,
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void,
  onDragLeave: () => void,
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void,
) {
  const palette = problemGroupPalette(index);
  const noteCards = buildProblemGroupDisplayCards(group);
  const visibleCards = noteCards.filter(
    (card) =>
      !(
        problemIdeaDrag &&
        group.group_id === problemIdeaDrag.sourceGroupId &&
        card.cardKind === problemIdeaDrag.cardKind &&
        card.sourceNodeId === problemIdeaDrag.sourceNodeId
      ),
  );
  const renderItems: Array<ProblemGroupDisplayCard | { placeholder: true; id: string }> = [...visibleCards];
  if (problemIdeaDrag && problemIdeaDropPreview?.targetGroupId === group.group_id) {
    const previewKind = problemIdeaDropPreview.cardKind;
    const safeInsertIndex = Math.max(
      0,
      Math.min(
        problemIdeaDropPreview.insertIndex,
        visibleCards.filter((card) => card.cardKind === previewKind).length,
      ),
    );
    let visualIndex = renderItems.length;
    let seenTargetKind = 0;
    for (let itemIndex = 0; itemIndex < visibleCards.length; itemIndex += 1) {
      if (visibleCards[itemIndex].cardKind !== previewKind) continue;
      if (seenTargetKind === safeInsertIndex) {
        visualIndex = itemIndex;
        break;
      }
      seenTargetKind += 1;
    }
    if (safeInsertIndex >= seenTargetKind) {
      const lastSummaryIndex = visibleCards.reduce(
        (latest, card, cardIndex) => (card.cardKind === "summary" ? cardIndex : latest),
        -1,
      );
      const lastIdeaIndex = visibleCards.reduce(
        (latest, card, cardIndex) => (card.cardKind === "idea" ? cardIndex : latest),
        -1,
      );
      if (previewKind === "summary") {
        visualIndex = lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : 0;
      } else {
        visualIndex = lastIdeaIndex >= 0 ? lastIdeaIndex + 1 : visibleCards.length;
      }
    }
    renderItems.splice(visualIndex, 0, {
      placeholder: true,
      id: `${group.group_id}-${previewKind}-placeholder`,
    });
  }

  return (
    <div
      data-problem-group-drop-id={group.group_id}
      className={`min-w-0 rounded-[30px] p-2 transition ${selected ? "ring-2 ring-violet-300" : ""} ${dropTarget ? "ring-2 ring-blue-300 ring-offset-2" : ""}`}
      onDragOver={(event) => {
        onProblemIdeaDragOver(event);
        if (!event.defaultPrevented) {
          onDragOver(event);
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        onProblemIdeaDrop(event);
        if (!event.defaultPrevented) {
          onDrop(event);
        }
      }}
    >
      <div className={`rounded-[30px] border bg-gradient-to-br p-6 ${palette.shell}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`inline-flex max-w-full items-center rounded-[24px] bg-gradient-to-r px-7 py-3.5 text-[17px] font-bold shadow-lg ${palette.pill}`}>
              <span className="truncate">{group.topic}</span>
            </div>
          </div>
          <span className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-medium ${problemGroupStatusTone(group.status)}`}>
            {problemGroupStatusLabel(group.status)}
          </span>
        </div>

        <div
          className="mt-6 grid grid-cols-2 gap-5"
          onDragOver={(event) => onProblemIdeaDragOver(event)}
          onDrop={onProblemIdeaDrop}
        >
          {renderItems.length > 0 ? (
            renderItems.map((item, itemIndex) => (
              "placeholder" in item ? (
                <div
                  key={item.id}
                  className="imms-problem-source-placeholder min-h-[136px] rounded-[12px] border-2 border-dashed border-violet-400 bg-white/70 shadow-[inset_0_0_0_4px_rgba(139,92,246,0.10)]"
                >
                  <div className="flex h-full min-h-[136px] items-center justify-center px-4 text-center text-sm font-semibold text-violet-600">
                    여기에 배치
                  </div>
                </div>
              ) : (
              <div
                key={item.id}
                draggable={false}
                data-problem-source-group-id={group.group_id}
                data-problem-source-node-id={item.attachable ? item.sourceNodeId : undefined}
                data-problem-source-node-kind={item.attachable ? item.sourceNodeKind : undefined}
                data-problem-source-node-label={item.attachable ? item.title : undefined}
                data-problem-card-kind={item.cardKind}
                data-problem-card-id={item.ideaId || item.id}
                data-problem-card-source-node-id={item.sourceNodeId}
                onDragStart={(event) => onProblemIdeaDragStart(event, item)}
                onDrag={onProblemIdeaDragMove}
                onPointerDown={(event) => onProblemIdeaPointerDown(event, item)}
                onDragOver={(event) => onProblemIdeaDragOver(event, item)}
                onDrop={onProblemIdeaDrop}
                onDragEnd={onProblemIdeaDragEnd}
                onClick={(event) => {
                  if (!item.attachable) return;
                  event.stopPropagation();
                  onSourceNodeSelect(item.sourceNodeId);
                }}
                className={`imms-problem-source-card nodrag min-h-[136px] rounded-[12px] border p-5 shadow-[0_10px_22px_rgba(15,23,42,0.08)] ${
                  item.draggable ? "cursor-grab active:cursor-grabbing" : item.attachable ? "cursor-pointer" : ""
                } ${
                  selectedSourceNodeId === item.sourceNodeId ? "ring-2 ring-slate-900 ring-offset-2" : ""
                } ${palette.note}`}
              >
                <p className="text-[19px] font-semibold leading-7 text-slate-900">
                  {item.title || `아이디어${itemIndex + 1}`}
                </p>
                <p className="mt-3 line-clamp-4 text-[15px] leading-7 text-slate-600">
                  {item.body}
                </p>
              </div>
              )
            ))
          ) : (
            <div className="col-span-2 rounded-[12px] border border-dashed border-slate-200 bg-white/80 px-4 py-10 text-center text-base text-slate-500">
              아직 편입된 아이디어가 없습니다.
            </div>
          )}
        </div>

        {loading ? (
          <div className="mt-6 rounded-[12px] border border-slate-200 bg-white/85 px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="relative mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
                <span className="absolute inset-0 rounded-full border-2 border-slate-200" />
                <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-violet-500 border-r-violet-300" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">Insight</p>
                <div className="mt-3 space-y-2">
                  <div className="h-3 w-4/5 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-3 w-3/5 animate-pulse rounded-full bg-slate-200" />
                </div>
              </div>
            </div>
          </div>
        ) : group.insight_lens ? (
          <div className="mt-6 rounded-[12px] border border-slate-200 bg-white/85 px-5 py-4">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">Insight</p>
            <p className="mt-2 text-[15px] leading-7 text-slate-700">{group.insight_lens}</p>
          </div>
        ) : null}

        <div className={`mt-6 rounded-[12px] px-6 py-5 shadow-[0_10px_20px_rgba(15,23,42,0.18)] ${palette.conclusion}`}>
          <div className="flex items-start gap-3">
            {loading ? (
              <span className="relative mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center">
                <span className="absolute inset-0 rounded-full border-2 border-white/25" />
                <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-white border-r-white/60" />
              </span>
            ) : null}
            <p className="text-[22px] font-semibold leading-8">
            {group.topic} 결론
            </p>
          </div>
          {loading ? (
            <div className="mt-4 space-y-2">
              <div className="h-3 w-5/6 animate-pulse rounded-full bg-white/25" />
              <div className="h-3 w-2/3 animate-pulse rounded-full bg-white/20" />
            </div>
          ) : (
            <p className="mt-2 text-[15px] leading-7 text-white/85">
              {group.conclusion || "아직 정리된 결론이 없습니다."}
            </p>
          )}
        </div>

        <div className="mt-4 rounded-[14px] border border-dashed border-slate-200 bg-white/75 px-4 py-3 text-sm text-slate-500">
          개인 메모를 이 그룹 위로 드래그해 편입
        </div>
      </div>
    </div>
  );
}

function estimateWrappedLines(text: string, charsPerLine: number) {
  const normalized = stripLeadingTimestamp(text).replace(/\s+/g, " ").trim();
  if (!normalized) return 1;
  return normalized
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.trim().length / charsPerLine)), 0);
}

function estimateAgendaNodeHeight(title: string, summary: string, keywordCount: number) {
  const titleLines = estimateWrappedLines(title, 14);
  const summaryLines = estimateWrappedLines(summary, 24);
  const keywordRows = keywordCount > 0 ? Math.ceil(Math.min(keywordCount, 3) / 2) : 0;
  return 122 + titleLines * 28 + summaryLines * 24 + keywordRows * 30;
}

function estimateStandardNodeHeight(title: string, body: string, metaCount: number, bodyCharsPerLine: number) {
  const titleLines = estimateWrappedLines(title, 18);
  const bodyLines = estimateWrappedLines(body, bodyCharsPerLine);
  const metaRows = metaCount > 1 ? Math.ceil(Math.min(metaCount - 1, 3) / 2) : 0;
  return 118 + titleLines * 24 + bodyLines * 22 + metaRows * 28;
}

function estimateProblemIdeaCardHeight(title: string, body: string) {
  const titleLines = estimateWrappedLines(title || "아이디어", 11);
  const bodyLines = Math.min(4, estimateWrappedLines(body || "메모 내용 없음", 17));
  return 126 + titleLines * 18 + bodyLines * 16;
}

function estimateProblemGroupNodeHeight(group: ProblemGroupViewModel) {
  const topicLines = estimateWrappedLines(group.topic, 17);
  const insightLines = group.insight_lens ? Math.min(3, estimateWrappedLines(group.insight_lens, 28)) : 0;
  const conclusionLines = Math.min(
    4,
    estimateWrappedLines(group.conclusion || "아직 정리된 결론이 없습니다.", 28),
  );
  const noteCards = buildProblemGroupDisplayCards(group).map((item) => ({
    title: item.title,
    body: item.body,
  }));
  const noteCount = Math.max(1, noteCards.length);
  const rows = Math.ceil(noteCount / 2);
  const cardHeights = noteCards.map((item) => estimateProblemIdeaCardHeight(item.title, item.body));
  const noteRowHeights: number[] = [];

  for (let index = 0; index < Math.max(cardHeights.length, 1); index += 2) {
    const rowHeight = Math.max(cardHeights[index] || 152, cardHeights[index + 1] || 152);
    noteRowHeights.push(rowHeight);
  }

  const notesHeight = noteRowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rows - 1) * 20;
  const headerHeight = 88 + Math.max(0, topicLines - 1) * 22;
  const insightHeight = group.insight_lens ? 84 + Math.max(0, insightLines - 1) * 18 : 0;
  const conclusionHeight = 102 + Math.max(0, conclusionLines - 1) * 18;
  const dropZoneHeight = 60;
  return headerHeight + notesHeight + insightHeight + conclusionHeight + dropZoneHeight + 72;
}

function estimateProblemDiscussionNodeHeight(item: ProblemDiscussionViewModel) {
  const titleLines = Math.min(3, estimateWrappedLines(item.title || "의견 정리", 18));
  const bodyLines = item.ai_pending ? 2 : Math.max(1, estimateWrappedLines(item.body || "정리 중", 26));
  const keywordRows = Math.ceil(Math.max(0, (item.keywords || []).length) / 3);
  return Math.max(180, 86 + titleLines * 24 + bodyLines * 24 + keywordRows * 28);
}

function makeProblemDiscussionNodeLabel(item: ProblemDiscussionViewModel, selected: boolean) {
  const pending = Boolean(item.ai_pending);
  const keywords = (item.keywords || []).filter(Boolean);

  return (
    <div className={`min-w-0 rounded-[22px] border bg-white p-4 shadow-[0_14px_30px_rgba(15,23,42,0.10)] ${selected ? "border-violet-400 ring-2 ring-violet-100" : "border-violet-100"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-600">
          Problem Note
        </p>
        {pending ? (
          <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-600">
            AI 정리 중
          </span>
        ) : null}
      </div>
      <strong className="mt-3 block text-[17px] font-semibold leading-7 text-slate-900">
        {pending ? "의견 정리 중" : item.title || "의견 정리"}
      </strong>
      {pending ? (
        <div className="mt-4 space-y-2">
          <div className="h-3 w-5/6 animate-pulse rounded-full bg-violet-100" />
          <div className="h-3 w-3/5 animate-pulse rounded-full bg-violet-100" />
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-6 text-slate-600">
          {item.body || "정리된 의견이 없습니다."}
        </p>
      )}
      {keywords.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {keywords.slice(0, 6).map((keyword) => (
            <span key={`${item.id}-${keyword}`} className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
              #{keyword}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function estimateSolutionNodeHeight(topic: SolutionTopicViewModel) {
  const topicLines = estimateWrappedLines(topic.topic, 18);
  const conclusionLines = Math.min(
    3,
    estimateWrappedLines(topic.conclusion || topic.problem_conclusion || "해결 방향이 아직 없습니다.", 28),
  );

  return (
    118 +
    Math.max(0, topicLines - 1) * 22 +
    Math.max(0, conclusionLines - 1) * 18 +
    42
  );
}

function buildGridPositions(heights: number[], gapX: number, gapY: number, baseX: number, baseY: number) {
  const total = heights.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(total, 1))));
  const rowHeights: number[] = [];

  heights.forEach((height, index) => {
    const row = Math.floor(index / columns);
    rowHeights[row] = Math.max(rowHeights[row] || 0, height);
  });

  const rowOffsets: number[] = [];
  let currentY = baseY;
  rowHeights.forEach((height, rowIndex) => {
    rowOffsets[rowIndex] = currentY;
    currentY += height + gapY;
  });

  return heights.map((_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: baseX + column * gapX,
      y: rowOffsets[row] ?? baseY,
    };
  });
}

function buildColumnPositions(
  heights: number[],
  columns: number,
  gapX: number,
  gapY: number,
  baseX: number,
  baseY: number,
) {
  const safeColumns = Math.max(1, columns);
  const rowHeights: number[] = [];

  heights.forEach((height, index) => {
    const row = Math.floor(index / safeColumns);
    rowHeights[row] = Math.max(rowHeights[row] || 0, height);
  });

  const rowOffsets: number[] = [];
  let nextY = baseY;
  rowHeights.forEach((height, rowIndex) => {
    rowOffsets[rowIndex] = nextY;
    nextY += height + gapY;
  });

  return heights.map((_, index) => {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);
    return {
      x: baseX + column * gapX,
      y: rowOffsets[row] ?? baseY,
    };
  });
}

function estimateSolutionCardLineChars(width: number) {
  return Math.max(22, Math.floor(width / 10.5));
}

function serializeSharedProblemGroups(groups: ProblemGroupViewModel[]) {
  return groups.map((group) => ({
    group_id: group.group_id,
    topic: group.topic,
    insight_lens: group.insight_lens,
    insight_user_edited: group.insight_user_edited,
    keywords: group.keywords,
    agenda_ids: group.agenda_ids,
    agenda_titles: group.agenda_titles,
    ideas: group.ideas,
    source_summary_items: group.source_summary_items,
    discussion_items: group.discussion_items || [],
    conclusion: group.conclusion,
    conclusion_user_edited: group.conclusion_user_edited,
    status: group.status,
    source_signature: group.source_signature,
    source_agenda_signatures: group.source_agenda_signatures,
    source_idea_signatures: group.source_idea_signatures,
  }));
}

function serializeSharedCanvasItems(items: CanvasItemViewModel[]) {
  return buildWorkspaceCanvasItemsPayload(items);
}

function hydrateCanvasItems(items: CanvasItemViewModel[] = []): CanvasItemViewModel[] {
  return items.map((item) => {
    const keywords = (item.keywords || []).map((keyword) => keyword.trim()).filter(Boolean);
    const keyEvidence = (item.key_evidence || []).map((value) => value.trim()).filter(Boolean);
    const refinedUtterances = normalizeRefinedUtterances(item.refined_utterances);
    const evidenceUtteranceIds = (item.evidence_utterance_ids || []).map((value) => value.trim()).filter(Boolean);
    const ignoredUtteranceIds = (item.ignored_utterance_ids || []).map((value) => value.trim()).filter(Boolean);
    const mergedChildren = hydrateCanvasItems(item.merged_children || []);
    return {
      ...item,
      keywords: keywords.slice(0, 8),
      key_evidence: keyEvidence.slice(0, 8),
      refined_utterances: refinedUtterances,
      evidence_utterance_ids: evidenceUtteranceIds.slice(0, 400),
      ignored_utterance_ids: ignoredUtteranceIds.slice(0, 400),
      merged_children: mergedChildren,
      compacted_from_ids: (item.compacted_from_ids || []).map((value) => value.trim()).filter(Boolean).slice(0, 400),
      compaction_level: typeof item.compaction_level === "number" ? item.compaction_level : 0,
      parent_topic_id: item.parent_topic_id || "",
      parent_topic_source: item.parent_topic_source || "",
      parent_topic_locked: Boolean(item.parent_topic_locked),
      child_item_ids: (item.child_item_ids || []).map((value) => value.trim()).filter(Boolean).slice(0, 400),
      status: normalizeCanvasItemStatus(item.status),
      topic_collapsed: Boolean(item.topic_collapsed),
      created_by: item.created_by || "",
      manual_position: false,
      ai_generated: Boolean(item.ai_generated),
      user_edited: Boolean(item.user_edited),
      ai_pending: Boolean(item.ai_pending),
      ai_suggestions: (item.ai_suggestions || [])
        .map((suggestion) => ({
          id: (suggestion.id || "").trim(),
          text: (suggestion.text || "").trim(),
          status: normalizeIdeationSuggestionStatus(suggestion.status),
        }))
        .filter((suggestion) => suggestion.id && suggestion.text)
        .slice(0, 8),
      x: undefined,
      y: undefined,
    };
  });
}

function hydrateCustomGroups(groups: CustomGroupViewModel[] = []): CustomGroupViewModel[] {
  return groups
    .map((group) => ({
      id: (group.id || "").trim(),
      title: (group.title || "").trim(),
      description: (group.description || "").trim(),
      keywords: (group.keywords || []).map((keyword) => keyword.trim()).filter(Boolean).slice(0, 8),
      color: (group.color || "").trim(),
      created_by: group.created_by || "",
      created_at: group.created_at || "",
    }))
    .filter((group) => group.id && group.title);
}

function hydrateSolutionTopics(
  topics: CanvasSolutionTopicResponse[],
  problemGroups: ProblemGroupViewModel[],
  previousTopics: SolutionTopicViewModel[] = [],
): SolutionTopicViewModel[] {
  const previousById = new Map(previousTopics.map((topic) => [topic.group_id, topic]));
  const problemById = new Map(problemGroups.map((group) => [group.group_id, group]));

  return topics.map((topic) => {
    const previous = previousById.get(topic.group_id);
    const problemGroup = problemById.get(topic.group_id);
    const ideaTexts = (topic.ideas || []).filter(Boolean);
    const aiSuggestions: SolutionAiSuggestionViewModel[] =
      (topic.ai_suggestions || []).length > 0
        ? (topic.ai_suggestions || [])
            .filter((item) => item?.id || item?.text)
            .map((item, index) =>
              makeSolutionAiSuggestion(item, `${topic.group_id}-ai-${index + 1}`),
            )
        : ideaTexts.map((text, index) =>
            makeSolutionAiSuggestion(
              {
                text,
                status: previous?.ai_suggestions?.find((item) => item.text === text)?.status,
              },
              `${topic.group_id}-ai-${index + 1}`,
            ),
          );
    const notes: SolutionNoteViewModel[] =
      (topic.notes || []).length > 0
        ? (topic.notes || [])
            .filter((item) => item?.id || item?.text)
            .map((item, index) => makeSolutionNote(item, `${topic.group_id}-note-${index + 1}`))
        : previous?.notes || [];

    return {
      ...topic,
      ideas: ideaTexts,
      status:
        topic.status === "review" || topic.status === "final" || topic.status === "draft"
          ? topic.status
          : previous?.status || "draft",
      problem_topic: topic.problem_topic || problemGroup?.topic || previous?.problem_topic || "",
      problem_insight: topic.problem_insight || problemGroup?.insight_lens || previous?.problem_insight || "",
      problem_conclusion:
        topic.problem_conclusion || problemGroup?.conclusion || previous?.problem_conclusion || "",
      problem_keywords:
        (topic.problem_keywords || []).filter(Boolean).length > 0
          ? (topic.problem_keywords || []).filter(Boolean)
          : problemGroup?.keywords || previous?.problem_keywords || [],
      agenda_titles:
        (topic.agenda_titles || []).filter(Boolean).length > 0
          ? (topic.agenda_titles || []).filter(Boolean)
          : problemGroup?.agenda_titles || previous?.agenda_titles || [],
      ai_suggestions: aiSuggestions,
      notes,
    };
  });
}

function pruneUnselectedSolutionSuggestions(
  topics: SolutionTopicViewModel[],
  targetTopicId = "",
): { topics: SolutionTopicViewModel[]; removedCount: number } {
  let removedCount = 0;
  const nextTopics = topics.map((topic) => {
    if (targetTopicId && topic.group_id !== targetTopicId) {
      return topic;
    }

    const adoptedAiIds = new Set(
      topic.notes
        .filter((note) => note.source === "ai" && note.source_ai_id)
        .map((note) => note.source_ai_id || ""),
    );
    const keptSuggestions = topic.ai_suggestions.filter(
      (suggestion) => suggestion.status === "selected" || adoptedAiIds.has(suggestion.id),
    );
    removedCount += topic.ai_suggestions.length - keptSuggestions.length;

    if (keptSuggestions.length === topic.ai_suggestions.length) {
      return topic;
    }

    return {
      ...topic,
      ideas: keptSuggestions.map((suggestion) => suggestion.text),
      ai_suggestions: keptSuggestions.map((suggestion) =>
        makeSolutionAiSuggestion({ ...suggestion, status: "selected" }, suggestion.id),
      ),
    };
  });

  return { topics: nextTopics, removedCount };
}

function makeSolutionNoteEditKey(topicId: string, noteId: string) {
  return `${topicId}::${noteId}`;
}

function parseSolutionNoteEditKey(key: string) {
  const [topicId = "", noteId = ""] = key.split("::");
  return { topicId, noteId };
}

function applySolutionNoteDraft(
  topics: SolutionTopicViewModel[],
  editKey: string,
  textDraft: string,
  finalCommentDraft: string,
): SolutionTopicViewModel[] {
  const { topicId, noteId } = parseSolutionNoteEditKey(editKey);
  if (!topicId || !noteId) return topics;

  return topics.map((topic) =>
    topic.group_id === topicId
      ? {
          ...topic,
          notes: topic.notes.map((note) =>
            note.id === noteId
              ? makeSolutionNote(
                  {
                    ...note,
                    text: textDraft.trim() || note.text,
                    final_comment: note.is_final_candidate ? finalCommentDraft : note.final_comment,
                  },
                  note.id,
                )
              : makeSolutionNote(note, note.id),
          ),
        }
      : topic,
  );
}

function preserveEditingSolutionNoteDraft(
  incomingTopics: SolutionTopicViewModel[],
  currentTopics: SolutionTopicViewModel[],
  editKey: string,
  textDraft: string,
  finalCommentDraft: string,
): SolutionTopicViewModel[] {
  const { topicId, noteId } = parseSolutionNoteEditKey(editKey);
  if (!topicId || !noteId) return incomingTopics;

  const currentTopic = currentTopics.find((topic) => topic.group_id === topicId);
  const currentNote = currentTopic?.notes.find((note) => note.id === noteId);
  if (!currentTopic || !currentNote) return incomingTopics;

  let foundTopic = false;
  let foundNote = false;
  const draftNote = makeSolutionNote(
    {
      ...currentNote,
      text: textDraft.trim() || currentNote.text,
      final_comment: currentNote.is_final_candidate ? finalCommentDraft : currentNote.final_comment,
    },
    currentNote.id,
  );

  const nextTopics = incomingTopics.map((topic) => {
    if (topic.group_id !== topicId) return topic;
    foundTopic = true;
    const nextNotes: SolutionNoteViewModel[] = topic.notes.map((note) => {
      if (note.id !== noteId) return makeSolutionNote(note, note.id);
      foundNote = true;
      return makeSolutionNote(note, note.id);
    });

    return {
      ...topic,
      notes: foundNote ? nextNotes : [...nextNotes, draftNote],
    };
  });

  if (foundTopic) return nextTopics;

  return [
    {
      ...currentTopic,
      notes: currentTopic.notes.map((note) =>
        note.id === noteId ? draftNote : makeSolutionNote(note, note.id),
      ),
    },
    ...nextTopics,
  ];
}

function serializeSharedSolutionTopics(topics: SolutionTopicViewModel[]) {
  return topics.map((topic) => ({
    group_id: topic.group_id,
    topic_no: topic.topic_no,
    topic: topic.topic,
    conclusion: topic.conclusion,
    ideas: topic.ideas,
    status: topic.status,
    problem_topic: topic.problem_topic,
    problem_insight: topic.problem_insight,
    problem_conclusion: topic.problem_conclusion,
    problem_keywords: topic.problem_keywords,
    agenda_titles: topic.agenda_titles,
    ai_suggestions: topic.ai_suggestions,
    notes: topic.notes,
  }));
}

function buildSharedCanvasSignature(payload: {
  meeting_goal?: string;
  meeting_goal_context?: string;
  stage: CanvasStage;
  agenda_overrides: Record<string, unknown>;
  canvas_items: unknown[];
  custom_groups?: unknown[];
  problem_groups: unknown[];
  solution_topics: unknown[];
  final_solution_summary?: unknown;
  node_positions: CanvasNodePositionsByStage;
  imported_state: MeetingState | null;
}) {
  return JSON.stringify(payload);
}

function createLocalNodeOverrideMap() {
  return {
    ideation: new Set<string>(),
    "problem-definition": new Set<string>(),
    solution: new Set<string>(),
  };
}

function mergeNodePositionsWithLocalOverrides(
  currentPositions: CanvasNodePositionsByStage,
  incomingPositions: CanvasNodePositionsByStage,
  localOverrides: Record<CanvasStage, Set<string>>,
) {
  const nextPositions: CanvasNodePositionsByStage = {};

  CANVAS_STAGES.forEach((stage) => {
    const remoteStage = { ...(incomingPositions[stage] || {}) };
    const localStage = currentPositions[stage] || {};

    localOverrides[stage].forEach((nodeId) => {
      if (localStage[nodeId]) {
        remoteStage[nodeId] = localStage[nodeId];
      }
    });

    if (Object.keys(remoteStage).length > 0) {
      nextPositions[stage] = remoteStage;
    }
  });

  return normalizeCanvasNodePositionsForComputedIdeation(nextPositions);
}

type CanvasNodeData = {
  label: React.ReactNode;
  contentSignature: string;
};

type CanvasEdgeData = {
  kind?: "canvasItemLink";
  canvasItemId?: string;
  linkField?: "agenda_id" | "point_id";
};

type CanvasNodeDescriptor = {
  id: string;
  position: { x: number; y: number };
  positionSource: "persisted" | "computed" | "fallback";
  sourcePosition: Position;
  targetPosition: Position;
  className: string;
  style: React.CSSProperties;
  data: CanvasNodeData;
  draggable?: boolean;
  dragHandle?: string;
  selectable?: boolean;
  zIndex?: number;
};

function buildNodeContentSignature(parts: Array<string | number | boolean | undefined>) {
  return parts
    .map((part) => (part === undefined ? "" : String(part)))
    .join("|");
}

function positionsEqual(
  left?: { x: number; y: number },
  right?: { x: number; y: number },
) {
  return (left?.x ?? 0) === (right?.x ?? 0) && (left?.y ?? 0) === (right?.y ?? 0);
}

function rectIntersectionArea(left: DOMRect, right: DOMRect) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function getReactFlowCanvasRect(container: HTMLElement | null) {
  if (!container) {
    return null;
  }

  const flowElement = container.querySelector<HTMLElement>(".react-flow");
  return (flowElement || container).getBoundingClientRect();
}

function pointInRect(clientX: number, clientY: number, rect: DOMRect | null) {
  return Boolean(
    rect &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom,
  );
}

function getReactFlowNodeElement(nodeId: string) {
  if (typeof document === "undefined" || !nodeId) {
    return null;
  }
  return Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"))
    .find((element) => element.getAttribute("data-id") === nodeId) || null;
}

type ProblemSourceDropTarget = {
  groupId: string;
  nodeId: string;
  nodeKind: "topic" | "idea";
  nodeLabel: string;
  element: HTMLElement;
};

function makeProblemSourceDropTarget(candidate: HTMLElement): ProblemSourceDropTarget | null {
  const nodeKind = candidate.dataset.problemSourceNodeKind;
  if (nodeKind !== "topic" && nodeKind !== "idea") {
    return null;
  }

  return {
    groupId: candidate.dataset.problemSourceGroupId || "",
    nodeId: candidate.dataset.problemSourceNodeId || "",
    nodeKind,
    nodeLabel: candidate.dataset.problemSourceNodeLabel || "",
    element: candidate,
  };
}

function findProblemSourceDropTarget(clientX: number, clientY: number, draggedNodeId?: string): ProblemSourceDropTarget | null {
  if (typeof document === "undefined" || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-problem-source-node-id][data-problem-source-group-id]"),
  );

  const draggedElement = draggedNodeId ? getReactFlowNodeElement(draggedNodeId) : null;
  if (draggedElement) {
    const draggedRect = draggedElement.getBoundingClientRect();
    const best = candidates
      .map((candidate) => ({
        candidate,
        area: rectIntersectionArea(draggedRect, candidate.getBoundingClientRect()),
      }))
      .filter((entry) => entry.area >= 900)
      .sort((left, right) => right.area - left.area)[0];
    if (best) {
      return makeProblemSourceDropTarget(best.candidate);
    }
  }

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      continue;
    }

    return makeProblemSourceDropTarget(candidate);
  }

  return null;
}

function styleSignature(style?: React.CSSProperties) {
  return buildNodeContentSignature([
    style?.width,
    style?.height,
    style?.minHeight,
    style?.borderRadius,
    style?.padding,
  ]);
}

function reconcileNodes(
  currentNodes: Node[],
  descriptors: CanvasNodeDescriptor[],
  preserveNodeIds = new Set<string>(),
) {
  const currentNodeMap = new Map(currentNodes.map((node) => [node.id, node]));
  let changed = currentNodes.length !== descriptors.length;

  const nextNodes = descriptors.map((descriptor, index) => {
    const existingNode = currentNodeMap.get(descriptor.id);
    const nextPosition =
      existingNode && preserveNodeIds.has(descriptor.id)
        ? existingNode.position
        : existingNode && descriptor.positionSource === "fallback"
        ? existingNode.position
        : descriptor.position;
    const nextContentSignature =
      (descriptor.data as CanvasNodeData | undefined)?.contentSignature || "";
    const existingContentSignature =
      ((existingNode?.data as CanvasNodeData | undefined)?.contentSignature) || "";

    const nodeChanged =
      !existingNode ||
      currentNodes[index]?.id !== descriptor.id ||
      !positionsEqual(existingNode.position, nextPosition) ||
      existingNode.className !== descriptor.className ||
      styleSignature(existingNode.style) !== styleSignature(descriptor.style) ||
      existingNode.sourcePosition !== descriptor.sourcePosition ||
      existingNode.targetPosition !== descriptor.targetPosition ||
      existingNode.draggable !== descriptor.draggable ||
      existingNode.dragHandle !== descriptor.dragHandle ||
      existingNode.selectable !== descriptor.selectable ||
      existingNode.zIndex !== descriptor.zIndex ||
      existingContentSignature !== nextContentSignature;

    if (!nodeChanged && existingNode) {
      return existingNode;
    }

    changed = true;

    return {
      ...existingNode,
      ...descriptor,
      position: nextPosition,
      data: descriptor.data,
    };
  });

  return changed ? nextNodes : currentNodes;
}

export default function MeetingCanvasTab({
  userId,
  meetingId,
  meetingTitle,
  meetingGoal,
  meetingGoalContext,
  onMeetingGoalChange,
  onMeetingGoalContextChange,
  onMeetingGoalSync,
  transcripts,
  agendas,
  analysisState,
  onSyncFromMeeting,
  incomingSharedCanvasSync,
  onSharedCanvasSync,
  incomingCanvasStateRequestId,
  syncStatusText,
  autoSyncing,
  liveSpeechPreview,
  sttFlowSummaries = [],
  onImportAudioFile,
  audioImportBusy,
  audioImportStatusText,
  audioImportRevision,
  isRecording = false,
  onToggleRecording,
  onEndMeeting,
  onStopRecording,
  sttProgressText = "",
  onCanvasStageContextChange,
  recordingStatusText = "",
}: MeetingCanvasTabProps) {
  const [stage, setStage] = useState<CanvasStage>("ideation");
  const [composerTool, setComposerTool] = useState<ComposerTool>("note");
  const [armedCanvasTool, setArmedCanvasTool] = useState<CanvasTool | null>(null);
  const [composerAgendaId, setComposerAgendaId] = useState("");
  const [composerTitle, setComposerTitle] = useState("");
  const [composerBody, setComposerBody] = useState("");
  const [composerLinkedCanvasItemId, setComposerLinkedCanvasItemId] = useState("");
  const [composerLinkedCanvasItemTitle, setComposerLinkedCanvasItemTitle] = useState("");
  const [pendingPersonalNoteLinkId, setPendingPersonalNoteLinkId] = useState("");
  const [selectedAgendaId, setSelectedAgendaId] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [personalNotes, setPersonalNotes] = useState<PersonalNote[]>([]);
  const [agendaOverrides, setAgendaOverrides] = useState<Record<string, AgendaOverride>>({});
  const [canvasItems, setCanvasItems] = useState<CanvasItemViewModel[]>([]);
  const [topicCollapsedOverrides, setTopicCollapsedOverrides] = useState<Record<string, boolean>>({});
  const [latestHighlightedTopicId, setLatestHighlightedTopicId] = useState("");
  const [focusedCanvasItemId, setFocusedCanvasItemId] = useState("");
  const [customGroups, setCustomGroups] = useState<CustomGroupViewModel[]>([]);
  const [customGroupDraftTitle, setCustomGroupDraftTitle] = useState("");
  const [editingAgendaId, setEditingAgendaId] = useState("");
  const [agendaDraftTitle, setAgendaDraftTitle] = useState("");
  const [agendaDraftKeywords, setAgendaDraftKeywords] = useState("");
  const [agendaDraftSummary, setAgendaDraftSummary] = useState("");
  const [editingCanvasItemId, setEditingCanvasItemId] = useState("");
  const [canvasItemDraftTitle, setCanvasItemDraftTitle] = useState("");
  const [canvasItemDraftBody, setCanvasItemDraftBody] = useState("");
  const [editingPersonalNoteId, setEditingPersonalNoteId] = useState("");
  const [personalNoteDraftAgendaId, setPersonalNoteDraftAgendaId] = useState("");
  const [personalNoteDraftTitle, setPersonalNoteDraftTitle] = useState("");
  const [personalNoteDraftBody, setPersonalNoteDraftBody] = useState("");
  const [problemGroups, setProblemGroups] = useState<ProblemGroupViewModel[]>([]);
  const [solutionTopics, setSolutionTopics] = useState<SolutionTopicViewModel[]>([]);
  const [selectedSolutionTopicId, setSelectedSolutionTopicId] = useState("");
  const [editingSolutionTopicId, setEditingSolutionTopicId] = useState("");
  const [solutionTopicDraftTitle, setSolutionTopicDraftTitle] = useState("");
  const [solutionTopicDraftConclusion, setSolutionTopicDraftConclusion] = useState("");
  const [solutionTopicDraftIdeas, setSolutionTopicDraftIdeas] = useState("");
  const [solutionNoteDraft, setSolutionNoteDraft] = useState("");
  const [editingSolutionNoteKey, setEditingSolutionNoteKey] = useState("");
  const [solutionNoteTextDraft, setSolutionNoteTextDraft] = useState("");
  const [solutionNoteFinalCommentDraft, setSolutionNoteFinalCommentDraft] = useState("");
  const [importedState, setImportedState] = useState<MeetingState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedCanvasItemId, setSelectedCanvasItemId] = useState("");
  const [selectedProblemGroupId, setSelectedProblemGroupId] = useState("");
  const [selectedProblemSourceNodeId, setSelectedProblemSourceNodeId] = useState("");
  const [editingProblemGroupId, setEditingProblemGroupId] = useState("");
  const [problemGroupDraftTopic, setProblemGroupDraftTopic] = useState("");
  const [problemGroupDraftInsight, setProblemGroupDraftInsight] = useState("");
  const [problemGroupDraftConclusion, setProblemGroupDraftConclusion] = useState("");
  const [draggingPersonalNoteId, setDraggingPersonalNoteId] = useState("");
  const [dropProblemGroupId, setDropProblemGroupId] = useState("");
  const [, setLeftPanelTab] = useState<LeftPanelTab>("detail");
  const [meetingGoalDraft, setMeetingGoalDraft] = useState(meetingGoal);
  const [meetingGoalContextDraft, setMeetingGoalContextDraft] = useState(meetingGoalContext);
  const [meetingGoalEditorDraft, setMeetingGoalEditorDraft] = useState(meetingGoal);
  const [meetingGoalContextEditorDraft, setMeetingGoalContextEditorDraft] = useState(meetingGoalContext);
  const [meetingGoalSaving, setMeetingGoalSaving] = useState(false);
  const [conclusionRefreshingGroupId, setConclusionRefreshingGroupId] = useState("");
  const [conclusionBatchBusy, setConclusionBatchBusy] = useState(false);
  const [problemDefinitionStagePending, setProblemDefinitionStagePending] = useState(false);
  const [solutionStagePending, setSolutionStagePending] = useState(false);
  const [loadingProblemGroupIds, setLoadingProblemGroupIds] = useState<string[]>([]);
  const [solutionSuggestionBusyTopicId, setSolutionSuggestionBusyTopicId] = useState("");
  const [liveFlowHint, setLiveFlowHint] = useState("");
  const [ideaAssimilationStatus, setIdeaAssimilationStatus] = useState("");
  const [problemDiscussionStatus, setProblemDiscussionStatus] = useState("");
  const [ideaCreateStack, setIdeaCreateStack] = useState(0);
  const [ideationSuggestionBusyRootId, setIdeationSuggestionBusyRootId] = useState("");
  const [ideationSuggestionCollapsedByRootId, setIdeationSuggestionCollapsedByRootId] = useState<Record<string, boolean>>({});
  const [rightDrawerCollapsed, setRightDrawerCollapsed] = useState(true);
  const [rightDrawerContentVisible, setRightDrawerContentVisible] = useState(false);
  const [rightDrawerDetailCollapsed, setRightDrawerDetailCollapsed] = useState(false);
  const [rightDrawerNotesCollapsed, setRightDrawerNotesCollapsed] = useState(false);
  const [sharedSyncEnabled, setSharedSyncEnabled] = useState(true);
  const [importOverrideActive, setImportOverrideActive] = useState(false);
  const [nodePositions, setNodePositions] = useState<CanvasNodePositionsByStage>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [agendaDragPreview, setAgendaDragPreview] = useState<AgendaDragPreviewState | null>(null);
  const [ideationDropPreview, setIdeationDropPreview] = useState<IdeationDropPreviewState | null>(null);
  const [ideationNodeDragActive, setIdeationNodeDragActive] = useState(false);
  const [ideationDragGhost, setIdeationDragGhost] = useState<{
    itemId: string;
    x: number;
    y: number;
  } | null>(null);
  const [problemIdeaDrag, setProblemIdeaDrag] = useState<ProblemIdeaDragState | null>(null);
  const [problemIdeaDropPreview, setProblemIdeaDropPreview] = useState<ProblemIdeaDropPreviewState | null>(null);
  const [problemIdeaDragPoint, setProblemIdeaDragPoint] = useState<ProblemIdeaDragPointState | null>(null);
  const [meetingGoalEditorOpen, setMeetingGoalEditorOpen] = useState(false);
  const [endMeetingConfirmOpen, setEndMeetingConfirmOpen] = useState(false);
  const [endMeetingSaving, setEndMeetingSaving] = useState(false);
  const [endMeetingPreview, setEndMeetingPreview] = useState<{
    finalCount: number;
    topicCount: number;
    solutionTopics: SolutionTopicViewModel[];
  } | null>(null);
  const [leftPanelRatio, setLeftPanelRatio] = useState(DEFAULT_LEFT_PANEL_RATIO);
  const [rightPanelRatio, setRightPanelRatio] = useState(DEFAULT_RIGHT_PANEL_RATIO);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [solutionRightPaneWidth, setSolutionRightPaneWidth] = useState(0);
  const [placementFeedback, setPlacementFeedback] = useState<{
    id: string;
    x: number;
    y: number;
    label: string;
  } | null>(null);
  const [canvasPlacementPreview, setCanvasPlacementPreview] = useState<{
    x: number;
    y: number;
    label: string;
    hint: string;
    tone: string;
  } | null>(null);

  useEffect(() => {
    if (rightDrawerCollapsed) {
      setRightDrawerContentVisible(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setRightDrawerContentVisible(true);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [rightDrawerCollapsed]);
  const openRightDrawer = () => {
    setRightDrawerCollapsed(false);
  };
  const closeRightDrawer = () => {
    setRightDrawerContentVisible(false);
    setRightDrawerCollapsed(true);
  };
  const toggleRightDrawer = () => {
    setRightDrawerCollapsed((prev) => {
      if (!prev) {
        setRightDrawerContentVisible(false);
      }
      return !prev;
    });
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerBodyRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const ideationLeftFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const ideationRightFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const ideationLeftPaneRef = useRef<HTMLDivElement | null>(null);
  const ideationRightPaneRef = useRef<HTMLDivElement | null>(null);
  const solutionRightPaneRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{ side: "left" | "right"; startX: number; startRatio: number } | null>(null);
  const autoProblemDefinitionRef = useRef(false);
  const problemConclusionEntryHandledRef = useRef(false);
  const workspaceLoadedRef = useRef(false);
  const workspaceHydratingRef = useRef(false);
  const workspaceSaveTimerRef = useRef<number | null>(null);
  const lastWorkspaceFieldSignaturesRef = useRef<WorkspaceFieldSignatures>(createWorkspaceFieldSignatures());
  const personalNotesSaveTimerRef = useRef<number | null>(null);
  const sharedSyncTimerRef = useRef<number | null>(null);
  const applyingRemoteSharedSyncRef = useRef(false);
  const lastIncomingSharedSyncIdRef = useRef("");
  const lastSharedSyncSignatureRef = useRef("");
  const localNodeOverridesRef = useRef(createLocalNodeOverrideMap());
  const previousCanvasItemSignaturesRef = useRef<Record<string, string>>({});
  const pendingNodePlacementsRef = useRef<Record<string, { x: number; y: number }>>({});
  const hoveredProblemDropTargetElementRef = useRef<HTMLElement | null>(null);
  const agendaDragPreviewRef = useRef<AgendaDragPreviewState | null>(null);
  const ideationDropPreviewRef = useRef<IdeationDropPreviewState | null>(null);
  const stableIdeationDragRef = useRef<StableIdeationDragState | null>(null);
  const problemIdeaDragRef = useRef<ProblemIdeaDragState | null>(null);
  const problemIdeaPointerDragRef = useRef<ProblemIdeaPointerDragState | null>(null);
  const analysisSignatureAtImportRef = useRef("");
  const placementFeedbackTimerRef = useRef<number | null>(null);
  const initialLayoutLogDoneRef = useRef(false);
  const processedIdeaUtteranceIdsRef = useRef<Set<string>>(new Set());
  const processedProblemUtteranceIdsRef = useRef<Set<string>>(new Set());
  const failedIdeaAssimilationRef = useRef<{ signature: string; failedAt: number; detail: string } | null>(null);
  const failedProblemDiscussionRef = useRef<{ signature: string; failedAt: number; detail: string } | null>(null);
  const ideaBufferStartedAtRef = useRef<number | null>(null);
  const ideaFlushTimerRef = useRef<number | null>(null);
  const ideaSilenceTimerRef = useRef<number | null>(null);
  const problemDiscussionFlushTimerRef = useRef<number | null>(null);
  const ideaAssimilationInFlightRef = useRef(false);
  const problemDiscussionInFlightRef = useRef(false);
  const latestSharedWorkspaceRef = useRef<{
    meetingGoal: string;
    meetingGoalContext: string;
    stage: CanvasStage;
    agendaOverrides: Record<string, AgendaOverride>;
    canvasItems: CanvasItemViewModel[];
    customGroups: CustomGroupViewModel[];
    problemGroups: ProblemGroupViewModel[];
    solutionTopics: SolutionTopicViewModel[];
    nodePositions: CanvasNodePositionsByStage;
    importedState: MeetingState | null;
  }>({
    meetingGoal: "",
    meetingGoalContext: "",
    stage: "ideation",
    agendaOverrides: {},
    canvasItems: [],
    customGroups: [],
    problemGroups: [],
    solutionTopics: [],
    nodePositions: {},
    importedState: null,
  });
  const latestSharedSyncEnabledRef = useRef(true);
  const latestPersonalNotesPayloadRef = useRef<ReturnType<typeof buildCanvasPersonalNotesPayload> | null>(null);

  const analysisStateSignature = useMemo(
    () => buildMeetingStateSignature(analysisState),
    [analysisState],
  );
  const persistedSharedImportedState = useMemo(
    () => (importOverrideActive && importedState ? importedState : analysisState ?? importedState),
    [analysisState, importOverrideActive, importedState],
  );

  const effectiveState = importOverrideActive && importedState ? importedState : analysisState ?? importedState;
  const agendaModels = useMemo(() => {
    const baseModels = buildAgendaModels(effectiveState, agendas, transcripts);
    const hydratedBaseModels = baseModels.map((agenda) => {
      const override = agendaOverrides[agenda.id];
      if (!override) {
        return agenda;
      }

      return {
        ...agenda,
        title: override.title || agenda.title,
        keywords: override.keywords || agenda.keywords,
        summaryBullets: override.summaryBullets || agenda.summaryBullets,
      };
    });

    const customAgendaModels: AgendaViewModel[] = customGroups.map((group) => ({
      id: group.id,
      title: group.title,
      status: "프로젝트 분류",
      keywords: group.keywords || [],
      summaryBullets: [group.description || "프로젝트에서 직접 추가한 그룹 분류입니다."],
      utterances: [],
      decisions: [],
      actionItems: [],
      isCustom: true,
    }));

    return [...hydratedBaseModels, ...customAgendaModels];
  }, [effectiveState, agendas, transcripts, agendaOverrides, customGroups]);
  const ideationNodeCountSummary = useMemo(() => {
    const agendaIdSet = new Set(agendaModels.map((agenda) => agenda.id));
    const directChildCount = canvasItems.filter(
      (item) =>
        agendaIdSet.has(item.agenda_id) &&
        !item.parent_topic_id &&
        isCountableIdeationChildNode(item),
    ).length;
    const fallbackStack = getCanvasIdeaCreateStackFallback(canvasItems);
    const stack = ideaCreateStack > 0 ? ideaCreateStack : fallbackStack;

    return {
      directChildCount,
      target: 3 + Math.floor(stack / 4),
    };
  }, [agendaModels, canvasItems, ideaCreateStack]);
  const activeMeetingGoal = meetingGoalDraft.trim();
  const meetingTopicForAi = activeMeetingGoal || meetingTitle.trim() || (effectiveState?.meeting_goal || "").trim() || "회의 주제";
  const transcriptStripItems = useMemo(() => {
    const stageSummaries = sttFlowSummaries.filter((item) => !item.stage || item.stage === stage);
    const summaryRows = stageSummaries
      .slice(-3)
      .map((item, index) => ({
        speaker: `AI 요약 ${index + 1}`,
        text: item.text || "요약 생성 중",
        timestamp: item.timestamp || "",
      }));

    if (summaryRows.length > 0) {
      const placeholders = [
        { speaker: "AI 요약", text: "다음 3개 발화 요약 대기 중", timestamp: "" },
        { speaker: "AI 요약", text: "다음 3개 발화 요약 대기 중", timestamp: "" },
        { speaker: "AI 요약", text: "다음 3개 발화 요약 대기 중", timestamp: "" },
      ];
      return [...summaryRows, ...placeholders].slice(0, 3);
    }

    const normalized = normalizeTranscriptRows(transcripts).filter((row) => row.canvas_stage === stage);
    const recentRows = normalized.slice(-3);
    const rows = recentRows.length
      ? recentRows
      : liveSpeechPreview
      ? [{ speaker: liveSpeechPreview.speaker, text: liveSpeechPreview.text, timestamp: liveSpeechPreview.timestamp }]
      : [];

    if (rows.length === 0) {
      return [
        { speaker: "STT", text: "녹음을 시작하면 현재 발언이 표시됩니다.", timestamp: "" },
        { speaker: "AI", text: "발언은 2줄 이내로 요약되어 canvas와 함께 보입니다.", timestamp: "" },
        { speaker: "Canvas", text: "안건과 메모를 같은 화면에서 정리합니다.", timestamp: "" },
      ];
    }

    return rows.map((row) => ({
      speaker: row.speaker || "알 수 없음",
      text: row.text || "발언 내용 없음",
      timestamp: row.timestamp || "",
    }));
  }, [liveSpeechPreview, sttFlowSummaries, stage, transcripts]);

  useEffect(() => {
    if (!selectedAgendaId && agendaModels[0]) {
      setSelectedAgendaId(agendaModels[0].id);
    }
  }, [agendaModels, selectedAgendaId]);

  useEffect(() => {
    onCanvasStageContextChange?.({
      stage,
      targetId:
        stage === "problem-definition"
          ? selectedProblemGroupId || ""
          : stage === "ideation"
            ? selectedAgendaId || agendaModels[0]?.id || ""
            : selectedSolutionTopicId || "",
      selectedNodeId,
    });
  }, [
    agendaModels,
    onCanvasStageContextChange,
    selectedAgendaId,
    selectedNodeId,
    selectedProblemGroupId,
    selectedSolutionTopicId,
    stage,
  ]);

  useEffect(() => {
    autoProblemDefinitionRef.current = false;
    problemConclusionEntryHandledRef.current = false;
    lastIncomingSharedSyncIdRef.current = "";
    lastSharedSyncSignatureRef.current = "";
    applyingRemoteSharedSyncRef.current = false;
    localNodeOverridesRef.current = createLocalNodeOverrideMap();
    previousCanvasItemSignaturesRef.current = {};
    lastWorkspaceFieldSignaturesRef.current = createWorkspaceFieldSignatures();
    workspaceLoadedRef.current = false;
    workspaceHydratingRef.current = false;
    analysisSignatureAtImportRef.current = "";
    initialLayoutLogDoneRef.current = false;
    processedIdeaUtteranceIdsRef.current = new Set();
    processedProblemUtteranceIdsRef.current = new Set();
    failedIdeaAssimilationRef.current = null;
    failedProblemDiscussionRef.current = null;
    ideaBufferStartedAtRef.current = null;
    ideaAssimilationInFlightRef.current = false;
    problemDiscussionInFlightRef.current = false;
    latestSharedWorkspaceRef.current = {
      meetingGoal: "",
      meetingGoalContext: "",
      stage: "ideation",
      agendaOverrides: {},
      canvasItems: [],
      customGroups: [],
      problemGroups: [],
      solutionTopics: [],
      nodePositions: {},
      importedState: null,
    };
    latestSharedSyncEnabledRef.current = true;
    latestPersonalNotesPayloadRef.current = null;
    setImportOverrideActive(false);
    setAgendaOverrides({});
    setCanvasItems([]);
    setTopicCollapsedOverrides({});
    setLatestHighlightedTopicId("");
    setIdeaCreateStack(0);
    setCustomGroups([]);
    setMeetingGoalDraft("");
    setMeetingGoalContextDraft("");
    setMeetingGoalEditorDraft("");
    setMeetingGoalContextEditorDraft("");
    setMeetingGoalSaving(false);
    setMeetingGoalEditorOpen(false);
    setEndMeetingConfirmOpen(false);
    setEndMeetingSaving(false);
    setEndMeetingPreview(null);
    onMeetingGoalChange("");
    onMeetingGoalContextChange("");
    setCustomGroupDraftTitle("");
    setEditingAgendaId("");
    setEditingCanvasItemId("");
    setEditingPersonalNoteId("");
    setEditingSolutionNoteKey("");
    setSolutionNoteTextDraft("");
    setSolutionNoteFinalCommentDraft("");
    setSelectedProblemSourceNodeId("");
    setArmedCanvasTool(null);
    setLiveFlowHint("");
    setIdeaAssimilationStatus("");
    setProblemDiscussionStatus("");
    setIdeationSuggestionBusyRootId("");
    setSolutionSuggestionBusyTopicId("");
    setIdeationSuggestionCollapsedByRootId({});
    agendaDragPreviewRef.current = null;
    setAgendaDragPreview(null);
    problemIdeaDragRef.current = null;
    problemIdeaPointerDragRef.current = null;
    setProblemIdeaDrag(null);
    setProblemIdeaDropPreview(null);
    setProblemIdeaDragPoint(null);
    setPlacementFeedback(null);
    if (workspaceSaveTimerRef.current) {
      window.clearTimeout(workspaceSaveTimerRef.current);
      workspaceSaveTimerRef.current = null;
    }
    if (personalNotesSaveTimerRef.current) {
      window.clearTimeout(personalNotesSaveTimerRef.current);
      personalNotesSaveTimerRef.current = null;
    }
    if (sharedSyncTimerRef.current) {
      window.clearTimeout(sharedSyncTimerRef.current);
      sharedSyncTimerRef.current = null;
    }
    if (placementFeedbackTimerRef.current) {
      window.clearTimeout(placementFeedbackTimerRef.current);
      placementFeedbackTimerRef.current = null;
    }
    if (ideaFlushTimerRef.current) {
      window.clearTimeout(ideaFlushTimerRef.current);
      ideaFlushTimerRef.current = null;
    }
    if (ideaSilenceTimerRef.current) {
      window.clearTimeout(ideaSilenceTimerRef.current);
      ideaSilenceTimerRef.current = null;
    }
    if (problemDiscussionFlushTimerRef.current) {
      window.clearTimeout(problemDiscussionFlushTimerRef.current);
      problemDiscussionFlushTimerRef.current = null;
    }
  }, [meetingId, onMeetingGoalChange, onMeetingGoalContextChange]);

  useEffect(() => {
    setTopicCollapsedOverrides(readTopicCollapseOverrides(meetingId, userId));
  }, [meetingId, userId]);

  useEffect(() => {
    latestSharedWorkspaceRef.current = {
      meetingGoal: meetingGoalDraft.trim(),
      meetingGoalContext: meetingGoalContextDraft.trim(),
      stage,
      agendaOverrides,
      canvasItems,
      customGroups,
      problemGroups,
      solutionTopics,
      nodePositions: normalizeCanvasNodePositionsForComputedIdeation(nodePositions),
      importedState: persistedSharedImportedState,
    };
    latestSharedSyncEnabledRef.current = sharedSyncEnabled;
  }, [
    agendaOverrides,
    canvasItems,
    customGroups,
    meetingGoalContextDraft,
    meetingGoalDraft,
    nodePositions,
    persistedSharedImportedState,
    problemGroups,
    sharedSyncEnabled,
    solutionTopics,
    stage,
  ]);

  useEffect(() => {
    const nextSignatures = Object.fromEntries(
      canvasItems.map((item) => [item.id, getCanvasItemChangeSignature(item)] as const),
    );
    const previousSignatures = previousCanvasItemSignaturesRef.current;
    const hadPreviousItems = Object.keys(previousSignatures).length > 0;

    previousCanvasItemSignaturesRef.current = nextSignatures;
    if (!hadPreviousItems) {
      return;
    }

    const changedItems = canvasItems.filter((item) => previousSignatures[item.id] !== nextSignatures[item.id]);
    const removedItemIds = Object.keys(previousSignatures).filter((itemId) => !nextSignatures[itemId]);
    if (changedItems.length === 0 && removedItemIds.length === 0) {
      return;
    }

    const latestChangedItem = [...changedItems].reverse().find((item) => item.agenda_id);
    const changedTopic = [...changedItems].reverse().find(isTopicCanvasItem);
    const latestTopicId = changedTopic?.id || (latestChangedItem ? getCanvasItemTopLevelAncestorId(canvasItems, latestChangedItem.id) : "");
    setLatestHighlightedTopicId(latestTopicId);
  }, [canvasItems]);

  useEffect(() => {
    if (!importOverrideActive) {
      return;
    }

    if (!analysisSignatureAtImportRef.current) {
      return;
    }

    if (analysisStateSignature && analysisStateSignature !== analysisSignatureAtImportRef.current) {
      setImportOverrideActive(false);
    }
  }, [analysisStateSignature, importOverrideActive]);

  useEffect(() => {
    if (!workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }
    if (initialLayoutLogDoneRef.current) {
      return;
    }
    if (stage !== "ideation" || nodes.length === 0) {
      return;
    }

    initialLayoutLogDoneRef.current = true;
    console.info("[canvas initial layout]", {
      meetingId,
      stage,
      nodePositions: summarizeNodePositionsForDebug(nodePositions),
      renderedNodes: summarizeRenderedNodesForDebug(nodes),
    });
  }, [meetingId, nodePositions, nodes, stage]);

  useEffect(() => {
    let cancelled = false;

    workspaceLoadedRef.current = false;
    workspaceHydratingRef.current = true;
    setProblemGroups([]);
    setSolutionTopics([]);
    setPersonalNotes([]);
    setAgendaOverrides({});
    setCanvasItems([]);
    setCustomGroups([]);
    setCustomGroupDraftTitle("");
    setIdeaCreateStack(0);
    setNodePositions({});
    setImportedState(null);
    setStage("ideation");
    setProblemDefinitionStagePending(false);
    setSolutionStagePending(false);
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
    setSelectedNodeId("");
    setEditingProblemGroupId("");
    setEditingSolutionTopicId("");
    setLoadingProblemGroupIds([]);

    if (!meetingId) {
      workspaceHydratingRef.current = false;
      workspaceLoadedRef.current = true;
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([getCanvasWorkspaceState(meetingId), getCanvasPersonalNotes(meetingId, userId)])
      .then(([saved, savedPersonalNotes]) => {
        if (cancelled) return;

        const cachedSharedWorkspace = readSharedWorkspaceSessionCache(meetingId);
        const cachedNodePositions =
          cachedSharedWorkspace && typeof cachedSharedWorkspace === "object"
            ? (cachedSharedWorkspace.node_positions as CanvasNodePositionsByStage | undefined)
            : undefined;

        const sharedGroups = hydrateProblemGroups(saved.problem_groups || []);
        const sharedStage =
          saved.stage === "problem-definition" || saved.stage === "solution" || saved.stage === "ideation"
            ? saved.stage
            : "ideation";
        const sharedSolutionTopics = hydrateSolutionTopics(saved.solution_topics || [], sharedGroups);
        const nextPersonalNotes: PersonalNote[] = (savedPersonalNotes.personal_notes || []).map((note) => {
          const kind: ComposerTool =
            note.kind === "comment" || note.kind === "topic" || note.kind === "note"
              ? note.kind
              : "note";
          return {
            id: note.id,
            projectId: note.project_id || meetingId,
            agendaId: note.agenda_id,
            linkedCanvasItemId: note.linked_canvas_item_id || "",
            linkedCanvasItemTitle: note.linked_canvas_item_title || "",
            kind,
            title: note.title,
            body: note.body,
          };
        });
        const savedLocalCanvasState = savedPersonalNotes.local_canvas_state || null;
        const nextSharedSyncEnabled = savedLocalCanvasState?.shared_sync_enabled ?? true;
        const shouldUseLocalCanvas = nextSharedSyncEnabled === false;
        const nextAgendaOverrides = shouldUseLocalCanvas
          ? savedLocalCanvasState?.agenda_overrides || {}
          : saved.agenda_overrides || {};
        const nextCanvasItems = shouldUseLocalCanvas
          ? hydrateCanvasItems(savedLocalCanvasState?.canvas_items || [])
          : hydrateCanvasItems(saved.canvas_items || []);
        const nextCustomGroups = shouldUseLocalCanvas
          ? hydrateCustomGroups(savedLocalCanvasState?.custom_groups || [])
          : hydrateCustomGroups(saved.custom_groups || []);
        const nextGroups = shouldUseLocalCanvas
          ? hydrateProblemGroups(savedLocalCanvasState?.problem_groups || [], sharedGroups)
          : sharedGroups;
        const nextStage =
          shouldUseLocalCanvas &&
          (savedLocalCanvasState?.stage === "problem-definition" ||
            savedLocalCanvasState?.stage === "solution" ||
            savedLocalCanvasState?.stage === "ideation")
            ? savedLocalCanvasState.stage
            : sharedStage;
        const nextSolutionTopics = shouldUseLocalCanvas
          ? hydrateSolutionTopics(savedLocalCanvasState?.solution_topics || [], nextGroups, sharedSolutionTopics)
          : sharedSolutionTopics;
        const nextNodePositions = normalizeCanvasNodePositionsForComputedIdeation(
          shouldUseLocalCanvas
            ? savedLocalCanvasState?.node_positions || {}
            : Object.keys(saved.node_positions || {}).length > 0
              ? saved.node_positions || {}
              : cachedNodePositions || {},
        );
        const nextImportedState = shouldUseLocalCanvas
          ? savedLocalCanvasState?.imported_state || null
          : saved.imported_state || null;
        const nextMeetingGoal = saved.meeting_goal || "";
        const nextMeetingGoalContext = saved.meeting_goal_context || "";
        const nextImportOverrideActive = shouldUseLocalCanvas
          ? Boolean(savedLocalCanvasState?.import_override_active && nextImportedState)
          : Boolean(saved.imported_state);

        setProblemGroups(nextGroups);
        setSolutionTopics(nextSolutionTopics);
        setPersonalNotes(nextPersonalNotes);
        setAgendaOverrides(nextAgendaOverrides);
        setCanvasItems(nextCanvasItems);
        setCustomGroups(nextCustomGroups);
        setIdeaCreateStack(saved.idea_create_stack || 0);
        setMeetingGoalDraft(nextMeetingGoal);
        setMeetingGoalContextDraft(nextMeetingGoalContext);
        setMeetingGoalEditorDraft(nextMeetingGoal);
        setMeetingGoalContextEditorDraft(nextMeetingGoalContext);
        onMeetingGoalChange(nextMeetingGoal);
        onMeetingGoalContextChange(nextMeetingGoalContext);
        setSharedSyncEnabled(nextSharedSyncEnabled);
        setNodePositions(nextNodePositions);
        setImportedState(nextImportedState);
        analysisSignatureAtImportRef.current = nextImportedState
          ? buildMeetingStateSignature(nextImportedState)
          : analysisStateSignature;
        setImportOverrideActive(nextImportOverrideActive);
        setStage(nextStage);
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          meeting_goal: nextMeetingGoal,
          meeting_goal_context: nextMeetingGoalContext,
          stage: nextStage,
          agenda_overrides: nextAgendaOverrides,
          canvas_items: nextCanvasItems,
          custom_groups: serializeCustomGroups(nextCustomGroups),
          problem_groups: nextGroups,
          solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
          final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics),
          node_positions: nextNodePositions,
          imported_state: nextImportedState,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
          meetingGoal: nextMeetingGoal,
          meetingGoalContext: nextMeetingGoalContext,
          stage: nextStage,
          agendaOverrides: nextAgendaOverrides,
          canvasItems: nextCanvasItems,
          customGroups: nextCustomGroups,
          problemGroups: nextGroups,
          solutionTopics: nextSolutionTopics,
          nodePositions: nextNodePositions,
          importedState: nextImportedState,
        });
        setSelectedProblemGroupId(nextGroups[0]?.group_id || "");
        setSelectedSolutionTopicId(nextSolutionTopics[0]?.group_id || "");
        setSelectedCanvasItemId("");
        setSelectedNodeId(
          nextStage === "problem-definition"
            ? (nextGroups[0] ? `problem-${nextGroups[0].group_id}` : "")
            : nextStage === "solution"
              ? (nextSolutionTopics[0] ? `solution-${nextSolutionTopics[0].group_id}` : "")
              : "",
        );
        setEditingProblemGroupId("");
        setEditingSolutionTopicId("");

        console.info("[canvas hydrate] loaded workspace", {
          meetingId,
          sharedSyncEnabled: nextSharedSyncEnabled,
          usingLocalCanvas: shouldUseLocalCanvas,
          stage: nextStage,
          canvasItems: nextCanvasItems.length,
          customGroups: nextCustomGroups.length,
          usedCachedNodePositions:
            !shouldUseLocalCanvas &&
            Object.keys(saved.node_positions || {}).length === 0 &&
            Boolean(cachedNodePositions && Object.keys(cachedNodePositions).length > 0),
          nodePositions: summarizeNodePositionsForDebug(nextNodePositions),
          renderedNodes: summarizeRenderedNodesForDebug(nodes),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setProblemGroups([]);
        setSolutionTopics([]);
        setPersonalNotes([]);
        setAgendaOverrides({});
        setCanvasItems([]);
        setCustomGroups([]);
        setIdeaCreateStack(0);
        setSharedSyncEnabled(true);
        setNodePositions({});
        setImportedState(null);
        setStage("ideation");
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          meeting_goal: "",
          meeting_goal_context: "",
          stage: "ideation",
          agenda_overrides: {},
          canvas_items: [],
          custom_groups: [],
          problem_groups: [],
          solution_topics: [],
          final_solution_summary: buildFinalSolutionSummaryPayload([]),
          node_positions: {},
          imported_state: null,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
          meetingGoal: "",
          meetingGoalContext: "",
          stage: "ideation",
          agendaOverrides: {},
          canvasItems: [],
          customGroups: [],
          problemGroups: [],
          solutionTopics: [],
          nodePositions: {},
          importedState: null,
        });
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId("");
        setSelectedCanvasItemId("");
        setSelectedNodeId("");
        setEditingProblemGroupId("");
        setEditingSolutionTopicId("");
      })
      .finally(() => {
        if (cancelled) return;
        workspaceHydratingRef.current = false;
        workspaceLoadedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, [meetingId, userId]);

  useEffect(() => {
    if (audioImportRevision <= 0) {
      return;
    }

    setAgendaOverrides({});
    setCanvasItems([]);
    setIdeaCreateStack(0);
    setImportedState(null);
    setImportOverrideActive(false);
    setProblemGroups([]);
    setSolutionTopics([]);
    setNodePositions({});
    setStage("ideation");
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
    setSelectedCanvasItemId("");
    setSelectedNodeId("");
    setEditingProblemGroupId("");
    setEditingSolutionTopicId("");
    setAgendaOverrides({});
    setEditingAgendaId("");
    setEditingCanvasItemId("");
    setEditingPersonalNoteId("");
    setLeftPanelTab("detail");
    setActivityMessage("새 오디오 전사를 기준으로 canvas를 초기화했습니다.");
  }, [audioImportRevision]);

  useEffect(() => {
    if (problemGroups.length === 0) {
      setSelectedProblemGroupId("");
      setEditingProblemGroupId("");
      return;
    }

    if (!selectedProblemGroupId || !problemGroups.some((group) => group.group_id === selectedProblemGroupId)) {
      setSelectedProblemGroupId(problemGroups[0].group_id);
    }
  }, [problemGroups, selectedProblemGroupId]);

  useEffect(() => {
    if (solutionTopics.length === 0) {
      setSelectedSolutionTopicId("");
      setEditingSolutionTopicId("");
      return;
    }

    if (
      !selectedSolutionTopicId ||
      !solutionTopics.some((topic) => topic.group_id === selectedSolutionTopicId)
    ) {
      setSelectedSolutionTopicId(solutionTopics[0].group_id);
    }
  }, [selectedSolutionTopicId, solutionTopics]);

  useEffect(() => {
    if (canvasItems.length === 0) {
      setSelectedCanvasItemId("");
      setEditingCanvasItemId("");
      return;
    }

    if (!selectedCanvasItemId || !canvasItems.some((item) => item.id === selectedCanvasItemId)) {
      setSelectedCanvasItemId("");
      setEditingCanvasItemId("");
    }
  }, [canvasItems, selectedCanvasItemId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    if (!nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId("");
    }
  }, [nodes, selectedNodeId]);

  useEffect(() => {
    if (stage !== "problem-definition") {
      setEditingProblemGroupId("");
    }
  }, [stage]);

  useEffect(() => {
    if (stage !== "solution") {
      setEditingSolutionTopicId("");
    }
  }, [stage]);

  useEffect(() => {
    if (stage !== "ideation") {
      setEditingCanvasItemId("");
    }
  }, [stage]);

  useEffect(() => {
    if (sharedSyncEnabled) {
      localNodeOverridesRef.current = createLocalNodeOverrideMap();
    }
  }, [sharedSyncEnabled]);

  useEffect(() => {
    setMeetingGoalDraft(meetingGoal);
    if (!meetingGoalEditorOpen) {
      setMeetingGoalEditorDraft(meetingGoal);
    }
  }, [meetingGoal, meetingGoalEditorOpen]);

  useEffect(() => {
    setMeetingGoalContextDraft(meetingGoalContext);
    if (!meetingGoalEditorOpen) {
      setMeetingGoalContextEditorDraft(meetingGoalContext);
    }
  }, [meetingGoalContext, meetingGoalEditorOpen]);

  useEffect(() => {
    const syncViewportMode = () => {
      setIsDesktopLayout(window.innerWidth >= 1280);
    };

    syncViewportMode();
    window.addEventListener("resize", syncViewportMode);
    return () => window.removeEventListener("resize", syncViewportMode);
  }, []);

  useEffect(() => {
    const element = solutionRightPaneRef.current;
    if (!element) return;

    const syncWidth = () => {
      const nextWidth = Math.round(element.getBoundingClientRect().width);
      setSolutionRightPaneWidth((current) => (Math.abs(current - nextWidth) > 4 ? nextWidth : current));
    };

    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);

  const buildProblemConclusionPayload = useCallback(
    (group: ProblemGroupViewModel) => ({
      meeting_id: meetingId,
      meeting_topic: meetingTopicForAi,
      group: {
        group_id: group.group_id,
        topic: group.topic,
        insight_lens: group.insight_lens,
        agenda_titles: group.agenda_titles || [],
        source_summary_items: group.source_summary_items || [],
        ideas: (group.ideas || []).map((idea) => ({
          id: idea.id,
          kind: idea.kind,
          title: idea.title,
          body: idea.body,
        })),
      },
    }),
    [meetingId, meetingTopicForAi],
  );

  const forceBroadcastSharedCanvas = useCallback(
    (overrides?: {
      stage?: CanvasStage;
      agendaOverrides?: Record<string, AgendaOverride>;
      canvasItems?: CanvasItemViewModel[];
      customGroups?: CustomGroupViewModel[];
      problemGroups?: ProblemGroupViewModel[];
      solutionTopics?: SolutionTopicViewModel[];
      nodePositions?: CanvasNodePositionsByStage;
      importedState?: MeetingState | null;
      meetingGoal?: string;
      meetingGoalContext?: string;
    }) => {
      if (!meetingId || !userId) {
        return;
      }

      const snapshot = {
        meeting_goal: overrides?.meetingGoal ?? meetingGoalDraft.trim(),
        meeting_goal_context: overrides?.meetingGoalContext ?? meetingGoalContextDraft.trim(),
        stage: overrides?.stage ?? stage,
        agenda_overrides: serializeAgendaOverrides(overrides?.agendaOverrides ?? agendaOverrides),
        canvas_items: serializeSharedCanvasItems(overrides?.canvasItems ?? canvasItems),
        custom_groups: serializeCustomGroups(overrides?.customGroups ?? customGroups),
        problem_groups: serializeSharedProblemGroups(overrides?.problemGroups ?? problemGroups),
        solution_topics: serializeSharedSolutionTopics(overrides?.solutionTopics ?? solutionTopics),
        final_solution_summary: buildFinalSolutionSummaryPayload(overrides?.solutionTopics ?? solutionTopics),
        node_positions: normalizeCanvasNodePositionsForComputedIdeation(overrides?.nodePositions ?? nodePositions),
        imported_state:
          overrides && "importedState" in overrides
            ? (overrides.importedState ?? null)
            : persistedSharedImportedState,
      };

      lastSharedSyncSignatureRef.current = buildSharedCanvasSignature(snapshot);
      onSharedCanvasSync({
        sync_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        meeting_id: meetingId,
        updated_by: userId,
        updated_at: new Date().toISOString(),
        meeting_goal: snapshot.meeting_goal,
        meeting_goal_context: snapshot.meeting_goal_context,
        stage: snapshot.stage,
        agenda_overrides: snapshot.agenda_overrides,
        canvas_items: snapshot.canvas_items,
        custom_groups: snapshot.custom_groups,
        problem_groups: snapshot.problem_groups,
        solution_topics: snapshot.solution_topics,
        final_solution_summary: snapshot.final_solution_summary,
        node_positions: snapshot.node_positions,
        imported_state: snapshot.imported_state,
      });
    },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      nodePositions,
      onSharedCanvasSync,
      persistedSharedImportedState,
      problemGroups,
      solutionTopics,
      stage,
      userId,
    ],
  );

  const applyServerIdeaWorkspace = useCallback(
    (workspace: CanvasWorkspaceStateResponse | undefined | null) => {
      if (!workspace || workspace.meeting_id !== meetingId) return;

      const nextCanvasItems = hydrateCanvasItems(workspace.canvas_items || []);
      const nextNodePositions = normalizeCanvasNodePositionsForComputedIdeation(workspace.node_positions || {});
      const nextMeetingGoal = typeof workspace.meeting_goal === "string" ? workspace.meeting_goal : meetingGoalDraft;
      const nextMeetingGoalContext =
        typeof workspace.meeting_goal_context === "string" ? workspace.meeting_goal_context : meetingGoalContextDraft;
      (workspace.idea_processed_utterance_ids || []).forEach((id) => {
        if (id) processedIdeaUtteranceIdsRef.current.add(id);
      });

      setCanvasItems(nextCanvasItems);
      setMeetingGoalDraft(nextMeetingGoal);
      setMeetingGoalContextDraft(nextMeetingGoalContext);
      setMeetingGoalEditorDraft(nextMeetingGoal);
      setMeetingGoalContextEditorDraft(nextMeetingGoalContext);
      onMeetingGoalChange(nextMeetingGoal);
      onMeetingGoalContextChange(nextMeetingGoalContext);
      setIdeaCreateStack(workspace.idea_create_stack || 0);
      setNodePositions(nextNodePositions);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        meetingGoal: nextMeetingGoal,
        meetingGoalContext: nextMeetingGoalContext,
        canvasItems: nextCanvasItems,
        nodePositions: nextNodePositions,
        importedState: persistedSharedImportedState,
      };

      if (sharedSyncEnabled) {
        writeSharedWorkspaceSessionCache(
          meetingId,
          buildFullWorkspacePatchPayload({
            meetingId,
            meetingGoal: nextMeetingGoal,
            meetingGoalContext: nextMeetingGoalContext,
            stage,
            agendaOverrides,
            canvasItems: nextCanvasItems,
            customGroups,
            problemGroups,
            solutionTopics,
            nodePositions: nextNodePositions,
            importedState: persistedSharedImportedState,
          }),
        );
        forceBroadcastSharedCanvas({
          meetingGoal: nextMeetingGoal,
          meetingGoalContext: nextMeetingGoalContext,
          canvasItems: nextCanvasItems,
          nodePositions: nextNodePositions,
        });
      }
    },
    [
      agendaOverrides,
      customGroups,
      forceBroadcastSharedCanvas,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      onMeetingGoalChange,
      onMeetingGoalContextChange,
      persistedSharedImportedState,
      problemGroups,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  const applyServerProblemWorkspace = useCallback(
    (workspace: CanvasWorkspaceStateResponse | undefined | null) => {
      if (!workspace || workspace.meeting_id !== meetingId) return;

      const nextProblemGroups = hydrateProblemGroups(workspace.problem_groups || [], problemGroups);
      const nextNodePositions = normalizeCanvasNodePositionsForComputedIdeation(workspace.node_positions || nodePositions);
      (workspace.problem_processed_utterance_ids || []).forEach((id) => {
        if (id) processedProblemUtteranceIdsRef.current.add(id);
      });

      setProblemGroups(nextProblemGroups);
      setNodePositions(nextNodePositions);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        problemGroups: nextProblemGroups,
        nodePositions: nextNodePositions,
        importedState: persistedSharedImportedState,
      };

      if (sharedSyncEnabled) {
        writeSharedWorkspaceSessionCache(
          meetingId,
          buildFullWorkspacePatchPayload({
            meetingId,
            meetingGoal: meetingGoalDraft,
            meetingGoalContext: meetingGoalContextDraft,
            stage,
            agendaOverrides,
            canvasItems,
            customGroups,
            problemGroups: nextProblemGroups,
            solutionTopics,
            nodePositions: nextNodePositions,
            importedState: persistedSharedImportedState,
          }),
        );
        forceBroadcastSharedCanvas({
          problemGroups: nextProblemGroups,
          nodePositions: nextNodePositions,
        });
      }
    },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      forceBroadcastSharedCanvas,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  const refreshCanvasTopicSummary = useCallback(
    async (topicItemId: string) => {
      if (!meetingId || !topicItemId) return;

      setIdeaAssimilationStatus("AI가 topic 제목과 content를 생성 중");
      try {
        const started = await startCanvasTopicSummaryWorkspace({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          topic_item_id: topicItemId,
        });
        console.info("[canvas topic summary]", {
          label: "start response",
          status: started.status,
          jobId: started.job_id,
          topicItemId,
          detail: started.detail || "",
          warning: started.warning || "",
        });
        applyServerIdeaWorkspace(started.workspace);

        if (started.status !== "processing" || !started.job_id) {
          setIdeaAssimilationStatus(started.detail || "AI topic 정리 상태를 확인했습니다.");
          return;
        }

        let finalResult = started;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          finalResult = await getCanvasIdeaAssimilationWorkspaceJob(meetingId, started.job_id);
          if (finalResult.status !== "processing") {
            applyServerIdeaWorkspace(finalResult.workspace);
            break;
          }
        }

        console.info("[canvas topic summary]", {
          label: "final response",
          status: finalResult.status,
          jobId: finalResult.job_id,
          topicItemId,
          detail: finalResult.detail || "",
          warning: finalResult.warning || "",
        });
        setIdeaAssimilationStatus(
          finalResult.status === "completed"
            ? "AI topic 정리 반영됨"
            : finalResult.detail || "AI topic 정리 응답 대기 중",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[canvas topic summary]", {
          label: "request failed",
          topicItemId,
          errorDetail: message,
        });
        setIdeaAssimilationStatus(`AI topic 정리 실패: ${message}`);
      }
    },
    [applyServerIdeaWorkspace, meetingId, meetingTopicForAi],
  );

  const flushIdeaAssimilationBuffer = useCallback(
    async (reason: "timer" | "silence" | "stage-change" | "manual") => {
      if (!meetingId || stage !== "ideation" || ideaAssimilationInFlightRef.current) {
        return;
      }

      const previousFailure = failedIdeaAssimilationRef.current;
      const failedRetryAfter = previousFailure
        ? IDEA_ASSIMILATION_FAILURE_RETRY_DELAY_MS - (Date.now() - previousFailure.failedAt)
        : 0;
      const coolingFailedIds =
        previousFailure && failedRetryAfter > 0
          ? new Set(previousFailure.signature.split("|").filter(Boolean))
          : new Set<string>();
      if (previousFailure && failedRetryAfter <= 0) {
        failedIdeaAssimilationRef.current = null;
      }

      const processedIds = processedIdeaUtteranceIdsRef.current;
      const normalizedTranscriptRows = normalizeTranscriptRows(transcripts);
      const skippedCoolingRows = normalizedTranscriptRows.filter(
        (row) =>
          row.canvas_stage === "ideation" &&
          row.id &&
          row.text.trim() &&
          !processedIds.has(row.id) &&
          coolingFailedIds.has(row.id),
      ).length;
      const targetRows = normalizedTranscriptRows
        .filter(
          (row) =>
            row.canvas_stage === "ideation" &&
            row.id &&
            row.text.trim() &&
            !processedIds.has(row.id) &&
            !coolingFailedIds.has(row.id),
        );

      const targetTextLength = targetRows.reduce((sum, row) => sum + stripLeadingTimestamp(row.text).length, 0);
      if (targetRows.length === 0 || (reason !== "stage-change" && reason !== "manual" && targetTextLength < 40)) {
        if (targetRows.length > 0) {
          setIdeaAssimilationStatus(`아이디어 정리 대기 중 · ${targetRows.length}개 발화`);
        } else if (skippedCoolingRows > 0 && failedRetryAfter > 0) {
          setIdeaAssimilationStatus(`이전 LLM 실패 발화 재요청 대기 중 · ${Math.ceil(failedRetryAfter / 1000)}초`);
        }
        return;
      }

      const targetSignature = targetRows.map((row) => row.id).join("|");
      if (previousFailure?.signature === targetSignature) {
        const retryAfter = IDEA_ASSIMILATION_FAILURE_RETRY_DELAY_MS - (Date.now() - previousFailure.failedAt);
        if (retryAfter > 0) {
          const waitSeconds = Math.ceil(retryAfter / 1000);
          console.info("[canvas idea assimilation]", {
            label: "skip repeated failed request",
            hasError: false,
            errorDetail: "",
            status: "cooldown",
            detail: previousFailure.detail,
            targetCount: targetRows.length,
            waitSeconds,
            meetingId,
            reason,
          });
          setIdeaAssimilationStatus(`같은 발화 재요청 대기 중 · ${waitSeconds}초`);
          return;
        }
      }

      ideaAssimilationInFlightRef.current = true;
      setIdeaAssimilationStatus("AI가 키워드와 요약을 생성 중");

      try {
        const firstTargetIndex = transcripts.findIndex((row) => row.id === targetRows[0]?.id);
        const contextRows =
          firstTargetIndex > 0 ? normalizeTranscriptRows(transcripts.slice(Math.max(0, firstTargetIndex - 6), firstTargetIndex)) : [];
        const requestSnapshot = {
          meetingId,
          reason,
          selectedAgendaId: selectedAgendaId || agendaModels[0]?.id || "",
          targetRows: targetRows.length,
          targetTextLength,
          contextRows: contextRows.length,
        };
        console.info("[canvas idea assimilation] request", {
          ...requestSnapshot,
          hasError: false,
          errorDetail: "",
        });
        const started = await startCanvasIdeaAssimilationWorkspace({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          selected_agenda_id: selectedAgendaId || agendaModels[0]?.id || "",
          context_utterances: contextRows.map((row) => ({
            id: row.id,
            speaker: row.speaker || "참가자",
            text: stripLeadingTimestamp(row.text),
            timestamp: row.timestamp || "",
          })),
          target_utterances: targetRows.map((row) => ({
            id: row.id,
            speaker: row.speaker || "참가자",
            text: stripLeadingTimestamp(row.text),
            timestamp: row.timestamp || "",
          })),
        });
        logCanvasIdeaAssimilationJob("start response", started, requestSnapshot);

        applyServerIdeaWorkspace(started.workspace);
        if (started.status !== "processing" || !started.job_id) {
          if (started.status === "error") {
            failedIdeaAssimilationRef.current = {
              signature: targetSignature,
              failedAt: Date.now(),
              detail: started.detail || started.warning || "아이디어 정리 실패",
            };
          }
          if (started.status === "idle") {
            setIdeaAssimilationStatus(started.detail || "아이디어 정리 대기 중");
          } else {
            setIdeaAssimilationStatus(started.detail || "아이디어 정리 상태를 확인했습니다.");
          }
          return;
        }

        let finalResult = started;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          finalResult = await getCanvasIdeaAssimilationWorkspaceJob(meetingId, started.job_id);
          if (finalResult.status === "error" || finalResult.status === "missing" || finalResult.warning) {
            logCanvasIdeaAssimilationJob("poll error response", finalResult, {
              ...requestSnapshot,
              attempt: attempt + 1,
            });
          }
          if (finalResult.status !== "processing") {
            applyServerIdeaWorkspace(finalResult.workspace);
            break;
          }
        }
        logCanvasIdeaAssimilationJob("final response", finalResult, requestSnapshot);

        if (finalResult.status === "completed") {
          failedIdeaAssimilationRef.current = null;
          targetRows.forEach((row) => processedIds.add(row.id));
          ideaBufferStartedAtRef.current = null;
          setIdeaAssimilationStatus(finalResult.used_llm ? "AI 아이디어 정리 반영됨" : "LLM 응답 없음");
        } else if (finalResult.status === "error") {
          failedIdeaAssimilationRef.current = {
            signature: targetSignature,
            failedAt: Date.now(),
            detail: finalResult.detail || finalResult.warning || "아이디어 정리 실패",
          };
          setIdeaAssimilationStatus(finalResult.detail || "아이디어 정리 실패");
        } else {
          setIdeaAssimilationStatus("아이디어 정리 응답 대기 중");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[canvas idea assimilation]", {
          label: "request failed",
          hasError: true,
          errorDetail: message,
          status: "exception",
          usedLlm: false,
          warning: "",
          detail: message,
          jobId: "",
          targetCount: targetRows.length,
          meetingId,
          reason,
        });
        failedIdeaAssimilationRef.current = {
          signature: targetSignature,
          failedAt: Date.now(),
          detail: message,
        };
        setIdeaAssimilationStatus(`아이디어 정리 실패: ${message}`);
      } finally {
        ideaAssimilationInFlightRef.current = false;
        const hasRemainingRows = normalizeTranscriptRows(transcripts).some(
          (row) =>
            row.canvas_stage === "ideation" &&
            row.id &&
            row.text.trim() &&
            !processedIdeaUtteranceIdsRef.current.has(row.id),
        );
        if (stage === "ideation" && hasRemainingRows) {
          if (ideaFlushTimerRef.current) {
            window.clearTimeout(ideaFlushTimerRef.current);
          }
          ideaFlushTimerRef.current = window.setTimeout(
            () => void flushIdeaAssimilationBuffer("timer"),
            1_000,
          );
        }
      }
    },
    [
      agendaModels,
      applyServerIdeaWorkspace,
      meetingTopicForAi,
      meetingId,
      selectedAgendaId,
      stage,
      transcripts,
    ],
  );

  useEffect(() => {
    const evidenceIds = new Set<string>();
    canvasItems.forEach((item) => {
      (item.evidence_utterance_ids || []).forEach((id) => evidenceIds.add(id));
      (item.ignored_utterance_ids || []).forEach((id) => evidenceIds.add(id));
    });
    evidenceIds.forEach((id) => processedIdeaUtteranceIdsRef.current.add(id));
  }, [canvasItems]);

  useEffect(() => {
    const evidenceIds = new Set<string>();
    problemGroups.forEach((group) => {
      (group.discussion_items || []).forEach((item) => {
        (item.evidence_utterance_ids || []).forEach((id) => evidenceIds.add(id));
        (item.ignored_utterance_ids || []).forEach((id) => evidenceIds.add(id));
      });
    });
    evidenceIds.forEach((id) => processedProblemUtteranceIdsRef.current.add(id));
  }, [problemGroups]);

  useEffect(() => {
    const normalizedRows = normalizeTranscriptRows(transcripts);
    const latestRow = normalizedRows.at(-1) || null;
    setLiveFlowHint(buildLiveFlowHint(latestRow));

    if (stage !== "ideation" || !latestRow) {
      return;
    }

    const hasUnprocessedRows = normalizedRows.some(
      (row) =>
        row.canvas_stage === "ideation" &&
        row.id &&
        row.text.trim() &&
        !processedIdeaUtteranceIdsRef.current.has(row.id),
    );
    if (!hasUnprocessedRows) {
      return;
    }

    const now = Date.now();
    if (!ideaBufferStartedAtRef.current) {
      ideaBufferStartedAtRef.current = now;
    }

    if (ideaFlushTimerRef.current) {
      window.clearTimeout(ideaFlushTimerRef.current);
    }
    const elapsed = now - ideaBufferStartedAtRef.current;
    ideaFlushTimerRef.current = window.setTimeout(
      () => void flushIdeaAssimilationBuffer("timer"),
      Math.max(0, IDEA_ASSIMILATION_AUTO_FLUSH_MS - elapsed),
    );

    if (ideaSilenceTimerRef.current) {
      window.clearTimeout(ideaSilenceTimerRef.current);
    }
    ideaSilenceTimerRef.current = window.setTimeout(
      () => void flushIdeaAssimilationBuffer("silence"),
      IDEA_ASSIMILATION_SILENCE_FLUSH_MS,
    );

    return () => {
      if (ideaFlushTimerRef.current) {
        window.clearTimeout(ideaFlushTimerRef.current);
        ideaFlushTimerRef.current = null;
      }
      if (ideaSilenceTimerRef.current) {
        window.clearTimeout(ideaSilenceTimerRef.current);
        ideaSilenceTimerRef.current = null;
      }
    };
  }, [flushIdeaAssimilationBuffer, stage, transcripts]);

  useEffect(() => {
    return () => {
      if (ideaFlushTimerRef.current) {
        window.clearTimeout(ideaFlushTimerRef.current);
      }
      if (ideaSilenceTimerRef.current) {
        window.clearTimeout(ideaSilenceTimerRef.current);
      }
      if (problemDiscussionFlushTimerRef.current) {
        window.clearTimeout(problemDiscussionFlushTimerRef.current);
      }
    };
  }, []);

  const setProblemGroupsLoading = useCallback((groupIds: string[], loading: boolean) => {
    if (groupIds.length === 0) return;
    setLoadingProblemGroupIds((prev) => {
      if (loading) {
        return Array.from(new Set([...prev, ...groupIds]));
      }
      const removeSet = new Set(groupIds);
      return prev.filter((groupId) => !removeSet.has(groupId));
    });
  }, []);

  const handleGenerateProblemGroupConclusion = useCallback(
    async (group: ProblemGroupViewModel, reason: "manual" | "drop" = "manual") => {
      if (group.insight_user_edited && group.conclusion_user_edited) {
        setActivityMessage("이 그룹의 Insight와 결론은 수동 수정 상태라 AI 재생성을 건너뜁니다.");
        return;
      }

      setProblemGroupsLoading([group.group_id], true);
      setConclusionRefreshingGroupId(group.group_id);
      try {
        const result = await generateProblemGroupConclusion(buildProblemConclusionPayload(group));
        let nextGroups: ProblemGroupViewModel[] = [];
        setProblemGroups((prev) => {
          nextGroups = prev.map((item) =>
            item.group_id === group.group_id
              ? {
                  ...item,
                  insight_lens: item.insight_user_edited
                    ? item.insight_lens
                    : (result.used_llm ? result.insight_lens : "") || item.insight_lens,
                  conclusion: item.conclusion_user_edited
                    ? item.conclusion
                    : result.conclusion || item.conclusion,
                }
              : item,
          );
          return nextGroups;
        });
        if (!sharedSyncEnabled && nextGroups.length > 0) {
          forceBroadcastSharedCanvas({
            stage: "problem-definition",
            problemGroups: nextGroups,
          });
        }
        if (editingProblemGroupId === group.group_id) {
          if (!group.insight_user_edited) {
            setProblemGroupDraftInsight((result.used_llm ? result.insight_lens : "") || group.insight_lens || "");
          }
          if (!group.conclusion_user_edited) {
            setProblemGroupDraftConclusion(result.conclusion || group.conclusion);
          }
        }
        setActivityMessage(
          result.warning ||
            (reason === "drop" ? "메모 편입 내용을 반영해 결론을 다시 생성했습니다." : "문제 정의 그룹 결론을 생성했습니다."),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActivityMessage(`결론 생성 실패: ${message}`);
      } finally {
        setProblemGroupsLoading([group.group_id], false);
        setConclusionRefreshingGroupId("");
      }
    },
    [
      buildProblemConclusionPayload,
      editingProblemGroupId,
      forceBroadcastSharedCanvas,
      setProblemGroupsLoading,
      sharedSyncEnabled,
    ],
  );

  const handleGenerateAllProblemGroupConclusions = useCallback(
    async (groups: ProblemGroupViewModel[], targetGroupIds?: string[]) => {
      if (groups.length === 0) return;

      const targetGroupIdSet = targetGroupIds?.length ? new Set(targetGroupIds) : null;
      const targetGroups = groups.filter(
        (group) =>
          (!targetGroupIdSet || targetGroupIdSet.has(group.group_id)) &&
          !(group.insight_user_edited && group.conclusion_user_edited),
      );
      if (targetGroups.length === 0) {
        setActivityMessage("모든 문제 정의 그룹의 Insight와 결론이 수동 수정 상태라 AI 재생성을 건너뜁니다.");
        return;
      }

      setConclusionBatchBusy(true);
      setProblemGroupsLoading(targetGroups.map((group) => group.group_id), true);
      try {
        let lastWarning = "";
        let firstError = "";
        let workingGroups = groups;

        for (const group of targetGroups) {
          try {
            const result = await generateProblemGroupConclusion(buildProblemConclusionPayload(group));
            workingGroups = workingGroups.map((item) =>
              item.group_id === group.group_id
                ? {
                    ...item,
                    conclusion: item.conclusion_user_edited
                      ? item.conclusion
                      : result.conclusion || item.conclusion,
                    insight_lens: item.insight_user_edited
                      ? item.insight_lens
                      : (result.used_llm ? result.insight_lens : "") || item.insight_lens,
                  }
                : item,
            );
            setProblemGroups(workingGroups);
            if (!sharedSyncEnabled) {
              forceBroadcastSharedCanvas({
                stage: "problem-definition",
                problemGroups: workingGroups,
              });
            }
            if (result.warning && !lastWarning) {
              lastWarning = result.warning;
            }
          } catch (error) {
            if (!firstError) {
              firstError = error instanceof Error ? error.message : String(error);
            }
          } finally {
            setProblemGroupsLoading([group.group_id], false);
          }
        }
        setActivityMessage(
          firstError
            ? `전체 결론 생성 중 일부 실패: ${firstError}`
            : lastWarning || `문제 정의 그룹 ${targetGroups.length}개의 결론을 생성했습니다.`,
        );
      } finally {
        setConclusionBatchBusy(false);
      }
    },
    [buildProblemConclusionPayload, forceBroadcastSharedCanvas, setProblemGroupsLoading, sharedSyncEnabled],
  );

  const handleAttachPersonalNoteToProblemGroup = useCallback((groupId: string, noteId: string) => {
    const note = personalNotes.find((entry) => entry.id === noteId);
    const group = problemGroups.find((entry) => entry.group_id === groupId);
    if (!note || !group) return;

    if (group.ideas.some((idea) => idea.id === noteId)) {
      setDropProblemGroupId("");
      setDraggingPersonalNoteId("");
      setActivityMessage("이미 편입된 메모입니다.");
      return;
    }

    const nextGroup = {
      ...group,
      ideas: [
        ...group.ideas,
        {
          id: note.id,
          kind: note.kind,
          title: note.title,
          body: note.body,
        },
      ],
    };

    setProblemGroups((prev) =>
      prev.map((item) => (item.group_id === groupId ? nextGroup : item)),
    );
    setSelectedProblemGroupId(groupId);
    setSelectedNodeId(`problem-${groupId}`);
    setLeftPanelTab("detail");
    setDropProblemGroupId("");
    setDraggingPersonalNoteId("");
    void handleGenerateProblemGroupConclusion(nextGroup, "drop");
  }, [handleGenerateProblemGroupConclusion, personalNotes, problemGroups]);

  const getProblemIdeaInsertIndex = useCallback(
    (
      groupId: string,
      card: ProblemGroupDisplayCard | undefined,
      event: React.DragEvent<HTMLDivElement>,
    ) => {
      if (!problemIdeaDrag) return 0;
      const group = problemGroups.find((entry) => entry.group_id === groupId);
      if (!group) return 0;

      const visibleTargetCards = buildProblemGroupDisplayCards(group).filter(
        (item) =>
          item.cardKind === problemIdeaDrag.cardKind &&
          !(
            problemIdeaDrag.sourceGroupId === groupId &&
            item.sourceNodeId === problemIdeaDrag.sourceNodeId
          ),
      );

      if (!card || card.cardKind !== problemIdeaDrag.cardKind) {
        if (problemIdeaDrag.cardKind === "idea" && card?.cardKind === "summary") {
          return 0;
        }
        return visibleTargetCards.length;
      }

      const targetIndex = visibleTargetCards.findIndex((item) => item.sourceNodeId === card.sourceNodeId);
      if (targetIndex < 0) return visibleTargetCards.length;

      const rect = event.currentTarget.getBoundingClientRect();
      const insertAfter =
        event.clientY > rect.top + rect.height / 2 ||
        event.clientX > rect.left + rect.width / 2;
      return targetIndex + (insertAfter ? 1 : 0);
    },
    [problemGroups, problemIdeaDrag],
  );

  const getProblemIdeaDropPreviewFromPoint = useCallback(
    (clientX: number, clientY: number): ProblemIdeaDropPreviewState | null => {
      const activeProblemIdeaDrag = problemIdeaDragRef.current || problemIdeaDrag;
      if (!activeProblemIdeaDrag || typeof document === "undefined") return null;

      const elementAtPoint = document.elementFromPoint(clientX, clientY);
      const groupElement = elementAtPoint?.closest("[data-problem-group-drop-id]") as HTMLElement | null;
      const targetGroupId = groupElement?.dataset.problemGroupDropId || "";
      if (!targetGroupId || !groupElement) return null;

      const targetGroup = problemGroups.find((group) => group.group_id === targetGroupId);
      if (!targetGroup) return null;

      const cardElement = elementAtPoint?.closest("[data-problem-card-source-node-id]") as HTMLElement | null;
      const cardGroupElement = cardElement?.closest("[data-problem-group-drop-id]") as HTMLElement | null;
      const card =
        cardElement && cardGroupElement === groupElement
          ? buildProblemGroupDisplayCards(targetGroup).find(
              (item) => item.sourceNodeId === cardElement.dataset.problemCardSourceNodeId,
            )
          : undefined;

      const visibleTargetCards = buildProblemGroupDisplayCards(targetGroup).filter(
        (item) =>
          item.cardKind === activeProblemIdeaDrag.cardKind &&
          !(
            activeProblemIdeaDrag.sourceGroupId === targetGroupId &&
            item.sourceNodeId === activeProblemIdeaDrag.sourceNodeId
          ),
      );
      let insertIndex = visibleTargetCards.length;
      const cardElements = Array.from(
        groupElement.querySelectorAll<HTMLElement>("[data-problem-card-source-node-id]"),
      );
      const targetCardEntries = visibleTargetCards
        .map((item) => ({
          item,
          element: cardElements.find((candidate) => candidate.dataset.problemCardSourceNodeId === item.sourceNodeId),
        }))
        .filter((entry): entry is { item: ProblemGroupDisplayCard; element: HTMLElement } => Boolean(entry.element));

      if (targetCardEntries.length > 0) {
        const nearest = targetCardEntries.reduce((best, entry) => {
          const rect = entry.element.getBoundingClientRect();
          const sameRow = clientY >= rect.top - 12 && clientY <= rect.bottom + 12;
          const rowPenalty = sameRow ? 0 : Math.abs(clientY - (rect.top + rect.height / 2)) * 2;
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const distance = Math.hypot(clientX - centerX, clientY - centerY) + rowPenalty;
          return !best || distance < best.distance
            ? {
                ...entry,
                rect,
                distance,
              }
            : best;
        }, null as null | {
          item: ProblemGroupDisplayCard;
          element: HTMLElement;
          rect: DOMRect;
          distance: number;
        });

        if (nearest) {
          const targetIndex = visibleTargetCards.findIndex((item) => item.sourceNodeId === nearest.item.sourceNodeId);
          const sameRow = clientY >= nearest.rect.top - 12 && clientY <= nearest.rect.bottom + 12;
          const insertAfter = sameRow
            ? clientX > nearest.rect.left + nearest.rect.width / 2
            : clientY > nearest.rect.top + nearest.rect.height / 2;
          insertIndex = targetIndex + (insertAfter ? 1 : 0);
        }
      } else if (card && card.cardKind !== activeProblemIdeaDrag.cardKind) {
        insertIndex = activeProblemIdeaDrag.cardKind === "idea" && card.cardKind === "summary" ? 0 : visibleTargetCards.length;
      } else if (card) {
        const targetIndex = visibleTargetCards.findIndex((item) => item.sourceNodeId === card.sourceNodeId);
        if (targetIndex >= 0 && cardElement) {
          const rect = cardElement.getBoundingClientRect();
          const insertAfter =
            clientY > rect.top + rect.height / 2 ||
            clientX > rect.left + rect.width / 2;
          insertIndex = targetIndex + (insertAfter ? 1 : 0);
        }
      }

      return {
        targetGroupId,
        cardKind: activeProblemIdeaDrag.cardKind,
        insertIndex,
      };
    },
    [problemGroups, problemIdeaDrag],
  );

  const updateProblemIdeaDragPoint = useCallback((clientX: number, clientY: number) => {
    if (!clientX && !clientY) return;
    setProblemIdeaDragPoint((current) =>
      current?.x === clientX && current.y === clientY
        ? current
        : {
            x: clientX,
            y: clientY,
          },
    );
  }, []);

  const beginProblemCardDrag = useCallback(
    (groupId: string, card: ProblemGroupDisplayCard, clientX: number, clientY: number) => {
      const nextDrag = {
        sourceGroupId: groupId,
        sourceNodeId: card.sourceNodeId,
        sourceNodeKind: card.sourceNodeKind,
        cardKind: card.cardKind,
        sourceIndex: card.sourceIndex,
        title: card.title,
        ideaId: card.ideaId,
        summaryText: card.summaryText,
      };
      problemIdeaDragRef.current = nextDrag;
      setProblemIdeaDrag(nextDrag);
      setProblemIdeaDropPreview({
        targetGroupId: groupId,
        cardKind: card.cardKind,
        insertIndex: card.sourceIndex,
      });
      updateProblemIdeaDragPoint(clientX, clientY);
    },
    [updateProblemIdeaDragPoint],
  );

  const handleProblemIdeaPointerDown = useCallback(
    (groupId: string, event: React.PointerEvent<HTMLDivElement>, card: ProblemGroupDisplayCard) => {
      if (!card.draggable || event.button !== 0 || (card.cardKind === "idea" && !card.ideaId)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      problemIdeaPointerDragRef.current = {
        groupId,
        card,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
    },
    [],
  );

  const handleProblemIdeaDragMove = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      updateProblemIdeaDragPoint(event.clientX, event.clientY);
    },
    [updateProblemIdeaDragPoint],
  );

  const handleProblemIdeaDragStart = useCallback(
    (groupId: string, event: React.DragEvent<HTMLDivElement>, card: ProblemGroupDisplayCard) => {
      if (!card.draggable || (card.cardKind === "idea" && !card.ideaId)) {
        event.preventDefault();
        return;
      }

      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-imms-problem-card", card.sourceNodeId);
      if (card.ideaId) {
        event.dataTransfer.setData("application/x-imms-problem-idea", card.ideaId);
      }
      const dragImage = document.createElement("div");
      dragImage.style.position = "fixed";
      dragImage.style.left = "-9999px";
      dragImage.style.top = "-9999px";
      dragImage.style.width = "1px";
      dragImage.style.height = "1px";
      dragImage.style.opacity = "0";
      document.body.appendChild(dragImage);
      event.dataTransfer.setDragImage(dragImage, 0, 0);
      window.setTimeout(() => dragImage.remove(), 0);
      beginProblemCardDrag(groupId, card, event.clientX, event.clientY);
    },
    [beginProblemCardDrag],
  );

  const handleProblemIdeaDragOver = useCallback(
    (
      groupId: string,
      event: React.DragEvent<HTMLDivElement>,
      card?: ProblemGroupDisplayCard,
    ) => {
      const hasProblemIdeaDrag =
        Boolean(problemIdeaDrag) ||
        Array.from(event.dataTransfer.types || []).includes("application/x-imms-problem-card") ||
        Array.from(event.dataTransfer.types || []).includes("application/x-imms-problem-idea");
      if (!hasProblemIdeaDrag) return;

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      updateProblemIdeaDragPoint(event.clientX, event.clientY);
      const insertIndex = getProblemIdeaInsertIndex(groupId, card, event);
      setProblemIdeaDropPreview((current) =>
        current?.targetGroupId === groupId &&
        current.cardKind === problemIdeaDrag?.cardKind &&
        current.insertIndex === insertIndex
          ? current
          : {
              targetGroupId: groupId,
              cardKind: problemIdeaDrag?.cardKind || "idea",
              insertIndex,
            },
      );
    },
    [getProblemIdeaInsertIndex, problemIdeaDrag, updateProblemIdeaDragPoint],
  );

  const handleProblemIdeaDragEnd = useCallback(() => {
    problemIdeaPointerDragRef.current = null;
    setProblemIdeaDrag(null);
    setProblemIdeaDropPreview(null);
    setProblemIdeaDragPoint(null);
  }, []);

  const handleProblemIdeaDrop = useCallback(
    (
      groupId: string,
      event: React.DragEvent<HTMLDivElement>,
      dropPreviewOverride?: ProblemIdeaDropPreviewState | null,
    ) => {
      const activeProblemIdeaDrag = problemIdeaDragRef.current || problemIdeaDrag;
      const draggedSourceNodeId =
        activeProblemIdeaDrag?.sourceNodeId || event.dataTransfer.getData("application/x-imms-problem-card");
      if (!draggedSourceNodeId || !activeProblemIdeaDrag) return;

      event.preventDefault();
      event.stopPropagation();

      const targetGroupId = groupId;
      const effectiveDropPreview = dropPreviewOverride ?? problemIdeaDropPreview;
      const previewInsertIndex =
        effectiveDropPreview?.targetGroupId === targetGroupId &&
        effectiveDropPreview.cardKind === activeProblemIdeaDrag.cardKind
          ? effectiveDropPreview.insertIndex
          : undefined;
      const sourceGroup = problemGroups.find((group) => group.group_id === activeProblemIdeaDrag.sourceGroupId);
      const targetGroup = problemGroups.find((group) => group.group_id === targetGroupId);
      if (!sourceGroup || !targetGroup) {
        handleProblemIdeaDragEnd();
        return;
      }

      const sameGroup = sourceGroup.group_id === targetGroup.group_id;
      let nextProblemGroupsSnapshot: ProblemGroupViewModel[] | null = null;
      let nextSelectedSourceNodeId = draggedSourceNodeId;
      let activityMessage = "";

      if (activeProblemIdeaDrag.cardKind === "idea") {
        const draggedIdeaId =
          activeProblemIdeaDrag.ideaId || event.dataTransfer.getData("application/x-imms-problem-idea");
        const movedIdea = sourceGroup.ideas.find((idea) => idea.id === draggedIdeaId);
        if (!draggedIdeaId || !movedIdea) {
          handleProblemIdeaDragEnd();
          return;
        }

        const remainingTargetIdeas = sameGroup
          ? targetGroup.ideas.filter((idea) => idea.id !== draggedIdeaId)
          : targetGroup.ideas;
        const safeInsertIndex = Math.max(
          0,
          Math.min(previewInsertIndex ?? remainingTargetIdeas.length, remainingTargetIdeas.length),
        );
        const nextTargetIdeas = [
          ...remainingTargetIdeas.slice(0, safeInsertIndex),
          movedIdea,
          ...remainingTargetIdeas.slice(safeInsertIndex),
        ];
        const movingAttachedOpinions = sameGroup
          ? []
          : (sourceGroup.discussion_items || []).filter((item) => item.target_node_id === draggedIdeaId);

        nextProblemGroupsSnapshot = problemGroups.map((group) => {
          if (group.group_id === sourceGroup.group_id && !sameGroup) {
            return {
              ...group,
              ideas: group.ideas.filter((idea) => idea.id !== draggedIdeaId),
              discussion_items: (group.discussion_items || []).filter((item) => item.target_node_id !== draggedIdeaId),
            };
          }

          if (group.group_id === targetGroup.group_id) {
            return {
              ...group,
              ideas: nextTargetIdeas,
              discussion_items: sameGroup
                ? group.discussion_items || []
                : [
                    ...(group.discussion_items || []),
                    ...movingAttachedOpinions.map((item) => ({
                      ...item,
                      parent_group_id: targetGroup.group_id,
                      target_node_id: draggedIdeaId,
                      target_node_label: movedIdea.title,
                      target_node_kind: "idea" as const,
                    })),
                  ],
            };
          }

          return group;
        });
        nextSelectedSourceNodeId = draggedIdeaId;
        activityMessage = sameGroup
          ? `"${movedIdea.title || "아이디어"}" 순서를 변경했습니다.`
          : `"${movedIdea.title || "아이디어"}"를 "${targetGroup.topic}" 그룹으로 이동했습니다.`;
      } else {
        const sourceEntries = buildProblemSummaryEntries(sourceGroup);
        const movedEntry = sourceEntries[activeProblemIdeaDrag.sourceIndex];
        if (!movedEntry) {
          handleProblemIdeaDragEnd();
          return;
        }

        if (sameGroup) {
          const remainingEntries = sourceEntries.filter((_, index) => index !== activeProblemIdeaDrag.sourceIndex);
          const safeInsertIndex = Math.max(
            0,
            Math.min(previewInsertIndex ?? remainingEntries.length, remainingEntries.length),
          );
          const nextEntries = [
            ...remainingEntries.slice(0, safeInsertIndex),
            movedEntry,
            ...remainingEntries.slice(safeInsertIndex),
          ];

          nextProblemGroupsSnapshot = problemGroups.map((group) =>
            group.group_id === sourceGroup.group_id
              ? {
                  ...group,
                  source_summary_items: nextEntries.map((entry) => entry.value),
                  discussion_items: remapProblemSummaryDiscussionTargets(
                    group.group_id,
                    group.discussion_items,
                    nextEntries,
                  ),
                }
              : group,
          );
          nextSelectedSourceNodeId = makeProblemSummarySourceNodeId(targetGroup.group_id, safeInsertIndex);
          activityMessage = `"${activeProblemIdeaDrag.title || "요약"}" 순서를 변경했습니다.`;
        } else {
          const sourceRemainingEntries = sourceEntries.filter((_, index) => index !== activeProblemIdeaDrag.sourceIndex);
          const targetEntries = buildProblemSummaryEntries(targetGroup);
          const safeInsertIndex = Math.max(
            0,
            Math.min(previewInsertIndex ?? targetEntries.length, targetEntries.length),
          );
          const nextTargetEntries = [
            ...targetEntries.slice(0, safeInsertIndex),
            movedEntry,
            ...targetEntries.slice(safeInsertIndex),
          ];
          const movingAttachedOpinions = (sourceGroup.discussion_items || []).filter(
            (item) => item.target_node_id === movedEntry.originSourceNodeId,
          );
          const sourceRemainingDiscussions = (sourceGroup.discussion_items || []).filter(
            (item) => item.target_node_id !== movedEntry.originSourceNodeId,
          );
          const movedTargetNodeId = makeProblemSummarySourceNodeId(targetGroup.group_id, safeInsertIndex);
          const movedTargetNodeKind = getProblemSummarySourceNodeKind(safeInsertIndex);
          const movedTargetNodeLabel = makeProblemSummaryTitle(safeInsertIndex);

          nextProblemGroupsSnapshot = problemGroups.map((group) => {
            if (group.group_id === sourceGroup.group_id) {
              return {
                ...group,
                source_summary_items: sourceRemainingEntries.map((entry) => entry.value),
                discussion_items: remapProblemSummaryDiscussionTargets(
                  group.group_id,
                  sourceRemainingDiscussions,
                  sourceRemainingEntries,
                ),
              };
            }

            if (group.group_id === targetGroup.group_id) {
              return {
                ...group,
                source_summary_items: nextTargetEntries.map((entry) => entry.value),
                discussion_items: [
                  ...remapProblemSummaryDiscussionTargets(
                    group.group_id,
                    group.discussion_items,
                    nextTargetEntries,
                  ),
                  ...movingAttachedOpinions.map((item) => ({
                    ...item,
                    parent_group_id: targetGroup.group_id,
                    target_node_id: movedTargetNodeId,
                    target_node_label: movedTargetNodeLabel,
                    target_node_kind: movedTargetNodeKind,
                  })),
                ],
              };
            }

            return group;
          });
          nextSelectedSourceNodeId = movedTargetNodeId;
          activityMessage = `"${activeProblemIdeaDrag.title || "요약"}"를 "${targetGroup.topic}" 그룹으로 이동했습니다.`;
        }
      }

      if (!nextProblemGroupsSnapshot) {
        handleProblemIdeaDragEnd();
        return;
      }

      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage,
        problemGroups: nextProblemGroupsSnapshot,
        nodePositions,
        importedState: persistedSharedImportedState,
      };
      setProblemGroups(nextProblemGroupsSnapshot);
      setSelectedProblemGroupId(targetGroup.group_id);
      setSelectedProblemSourceNodeId(nextSelectedSourceNodeId);
      setSelectedNodeId(`problem-${targetGroup.group_id}`);
      setLeftPanelTab("detail");
      setActivityMessage(activityMessage);
      handleProblemIdeaDragEnd();

      if (sharedSyncEnabled) {
        if (meetingId) {
          writeSharedWorkspaceSessionCache(
            meetingId,
            buildFullWorkspacePatchPayload({
              meetingId,
              meetingGoal: meetingGoalDraft,
              meetingGoalContext: meetingGoalContextDraft,
              stage,
              agendaOverrides,
              canvasItems,
              customGroups,
              problemGroups: nextProblemGroupsSnapshot,
              solutionTopics,
              nodePositions,
              importedState: persistedSharedImportedState,
            }),
          );
        }
        forceBroadcastSharedCanvas({
          problemGroups: nextProblemGroupsSnapshot,
          nodePositions,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            problem_groups: serializeSharedProblemGroups(nextProblemGroupsSnapshot),
            node_positions: nodePositions,
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save problem idea reorder:", error);
          });
        }
      }
    },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      forceBroadcastSharedCanvas,
      handleProblemIdeaDragEnd,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      problemIdeaDrag,
      problemIdeaDropPreview,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  useEffect(() => {
    if (
      !meetingId ||
      !workspaceLoadedRef.current ||
      workspaceHydratingRef.current ||
      problemDefinitionStagePending ||
      solutionStagePending ||
      conclusionBatchBusy ||
      applyingRemoteSharedSyncRef.current
    ) {
      return;
    }

    const nextProblemGroupsPayload = buildWorkspaceProblemGroupsPayload(problemGroups);
    const nextSolutionTopicsPayload = buildWorkspaceSolutionTopicsPayload(solutionTopics);
    const nextMeetingGoal = meetingGoalDraft.trim();
    const nextMeetingGoalContext = meetingGoalContextDraft.trim();
    const nextSignatures = buildWorkspaceFieldSignatures({
      meetingGoal: nextMeetingGoal,
      meetingGoalContext: nextMeetingGoalContext,
      stage,
      agendaOverrides,
      canvasItems,
      customGroups,
      problemGroups,
      solutionTopics,
      nodePositions,
      importedState: persistedSharedImportedState,
    });
    const previousSignatures = lastWorkspaceFieldSignaturesRef.current;
    const patch: {
      meeting_id: string;
      meeting_goal?: string;
      meeting_goal_context?: string;
      stage?: CanvasStage;
      agenda_overrides?: ReturnType<typeof serializeAgendaOverrides>;
      canvas_items?: ReturnType<typeof serializeSharedCanvasItems>;
      custom_groups?: ReturnType<typeof serializeCustomGroups>;
      problem_groups?: ReturnType<typeof buildWorkspaceProblemGroupsPayload>;
      solution_topics?: ReturnType<typeof buildWorkspaceSolutionTopicsPayload>;
      final_solution_summary?: CanvasFinalSolutionSummary;
      node_positions?: CanvasNodePositionsByStage;
      imported_state?: MeetingState | null;
    } = {
      meeting_id: meetingId,
    };

    let hasChanges = false;
    let meetingGoalChanged = false;
    if (
      nextSignatures.meeting_goal !== previousSignatures.meeting_goal ||
      nextSignatures.meeting_goal_context !== previousSignatures.meeting_goal_context
    ) {
      patch.meeting_goal = nextMeetingGoal;
      patch.meeting_goal_context = nextMeetingGoalContext;
      hasChanges = true;
      meetingGoalChanged = true;
    }
    if (sharedSyncEnabled && nextSignatures.stage !== previousSignatures.stage) {
      patch.stage = stage;
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.agenda_overrides !== previousSignatures.agenda_overrides) {
      patch.agenda_overrides = serializeAgendaOverrides(agendaOverrides);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.canvas_items !== previousSignatures.canvas_items) {
      patch.canvas_items = serializeSharedCanvasItems(canvasItems);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.custom_groups !== previousSignatures.custom_groups) {
      patch.custom_groups = serializeCustomGroups(customGroups);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.problem_groups !== previousSignatures.problem_groups) {
      patch.problem_groups = nextProblemGroupsPayload;
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.solution_topics !== previousSignatures.solution_topics) {
      patch.solution_topics = nextSolutionTopicsPayload;
      patch.final_solution_summary = buildFinalSolutionSummaryPayload(solutionTopics);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.node_positions !== previousSignatures.node_positions) {
      patch.node_positions = normalizeCanvasNodePositionsForComputedIdeation(nodePositions);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.imported_state !== previousSignatures.imported_state) {
      patch.imported_state = persistedSharedImportedState;
      hasChanges = true;
    }

    if (!hasChanges) {
      return;
    }

    if (workspaceSaveTimerRef.current) {
      window.clearTimeout(workspaceSaveTimerRef.current);
    }

    workspaceSaveTimerRef.current = window.setTimeout(() => {
      void saveCanvasWorkspacePatch(patch)
        .then(() => {
          if (meetingGoalChanged) {
            onMeetingGoalSync?.(nextMeetingGoal, nextMeetingGoalContext);
          }
          lastWorkspaceFieldSignaturesRef.current = sharedSyncEnabled
            ? nextSignatures
            : {
                ...lastWorkspaceFieldSignaturesRef.current,
                meeting_goal: nextSignatures.meeting_goal,
                meeting_goal_context: nextSignatures.meeting_goal_context,
              };
        })
        .catch((error) => {
          console.error("Failed to save canvas workspace patch:", error);
        });
    }, 450);

    return () => {
      if (workspaceSaveTimerRef.current) {
        window.clearTimeout(workspaceSaveTimerRef.current);
        workspaceSaveTimerRef.current = null;
      }
    };
  }, [
    agendaOverrides,
    canvasItems,
    conclusionBatchBusy,
    customGroups,
    meetingGoalContextDraft,
    meetingGoalDraft,
    meetingId,
    nodePositions,
    onMeetingGoalSync,
    persistedSharedImportedState,
    problemDefinitionStagePending,
    problemGroups,
    sharedSyncEnabled,
    solutionStagePending,
    solutionTopics,
    stage,
  ]);

  const localCanvasState = useMemo<CanvasLocalState>(
    () =>
      sharedSyncEnabled
        ? {
            shared_sync_enabled: true,
            meeting_goal: meetingGoalDraft.trim(),
            meeting_goal_context: meetingGoalContextDraft.trim(),
            agenda_overrides: serializeAgendaOverrides(agendaOverrides),
            canvas_items: serializeSharedCanvasItems(canvasItems),
            custom_groups: serializeCustomGroups(customGroups),
          }
        : {
            shared_sync_enabled: false,
            meeting_goal: meetingGoalDraft.trim(),
            meeting_goal_context: meetingGoalContextDraft.trim(),
            agenda_overrides: serializeAgendaOverrides(agendaOverrides),
            canvas_items: serializeSharedCanvasItems(canvasItems),
            custom_groups: serializeCustomGroups(customGroups),
            stage,
            problem_groups: serializeSharedProblemGroups(problemGroups),
            solution_topics: serializeSharedSolutionTopics(solutionTopics),
            final_solution_summary: buildFinalSolutionSummaryPayload(solutionTopics),
            node_positions: normalizeCanvasNodePositionsForComputedIdeation(nodePositions),
            imported_state: persistedSharedImportedState,
            import_override_active: importOverrideActive,
          },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      importOverrideActive,
      meetingGoalContextDraft,
      meetingGoalDraft,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  useEffect(() => {
    if (!meetingId || !userId || !workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }

    if (personalNotesSaveTimerRef.current) {
      window.clearTimeout(personalNotesSaveTimerRef.current);
    }

    personalNotesSaveTimerRef.current = window.setTimeout(() => {
      void saveCanvasPersonalNotes({
        meeting_id: meetingId,
        user_id: userId,
        personal_notes: personalNotes.map((note) => ({
          id: note.id,
          project_id: note.projectId || meetingId,
          agenda_id: note.agendaId,
          linked_canvas_item_id: note.linkedCanvasItemId || "",
          linked_canvas_item_title: note.linkedCanvasItemTitle || "",
          kind: note.kind,
          title: note.title,
          body: note.body,
        })),
        local_canvas_state: localCanvasState,
      }).catch((error) => {
        console.error("Failed to save canvas personal notes:", error);
      });
    }, 300);

    return () => {
      if (personalNotesSaveTimerRef.current) {
        window.clearTimeout(personalNotesSaveTimerRef.current);
        personalNotesSaveTimerRef.current = null;
      }
    };
  }, [localCanvasState, meetingId, personalNotes, userId]);

  const sharedCanvasSnapshot = useMemo(
    () => ({
      meeting_goal: meetingGoalDraft.trim(),
      meeting_goal_context: meetingGoalContextDraft.trim(),
      stage,
      agenda_overrides: serializeAgendaOverrides(agendaOverrides),
      canvas_items: serializeSharedCanvasItems(canvasItems),
      custom_groups: serializeCustomGroups(customGroups),
      problem_groups: serializeSharedProblemGroups(problemGroups),
      solution_topics: serializeSharedSolutionTopics(solutionTopics),
      final_solution_summary: buildFinalSolutionSummaryPayload(solutionTopics),
      node_positions: normalizeCanvasNodePositionsForComputedIdeation(nodePositions),
      imported_state: persistedSharedImportedState,
    }),
    [agendaOverrides, canvasItems, customGroups, meetingGoalContextDraft, meetingGoalDraft, nodePositions, persistedSharedImportedState, problemGroups, solutionTopics, stage],
  );

  const flushProblemDiscussionBuffer = useCallback(
    async (reason: "timer" | "silence" | "stage-change" | "manual") => {
      if (!meetingId || problemDiscussionInFlightRef.current || problemGroups.length === 0) {
        return;
      }

      const processedIds = processedProblemUtteranceIdsRef.current;
      const normalizedTranscriptRows = normalizeTranscriptRows(transcripts);
      const selectedGroupId = selectedProblemGroupId || problemGroups[0]?.group_id || "";
      const validGroupIds = new Set(problemGroups.map((group) => group.group_id));
      const eligibleRows = normalizedTranscriptRows.filter(
        (row) =>
          row.canvas_stage === "problem-definition" &&
          row.id &&
          row.text.trim() &&
          !processedIds.has(row.id),
      );
      const hasRowsForSelectedGroup = eligibleRows.some(
        (row) => !row.canvas_target_id || row.canvas_target_id === selectedGroupId,
      );
      const fallbackTargetGroupId =
        eligibleRows.find((row) => row.canvas_target_id && validGroupIds.has(row.canvas_target_id))?.canvas_target_id || "";
      const targetGroupId = hasRowsForSelectedGroup ? selectedGroupId : fallbackTargetGroupId || selectedGroupId;
      const targetRows = eligibleRows.filter((row) =>
        row.canvas_target_id ? row.canvas_target_id === targetGroupId : targetGroupId === selectedGroupId,
      );
      const targetTextLength = targetRows.reduce((sum, row) => sum + stripLeadingTimestamp(row.text).length, 0);
      if (targetRows.length === 0 || (reason !== "stage-change" && reason !== "manual" && targetTextLength < 30)) {
        if (eligibleRows.length > 0) {
          setProblemDiscussionStatus(`문제정의 의견 정리 대기 중 · ${eligibleRows.length}개 발화`);
        }
        return;
      }

      const targetSignature = targetRows.map((row) => row.id).join("|");
      const previousFailure = failedProblemDiscussionRef.current;
      if (previousFailure?.signature === targetSignature) {
        const retryAfter = IDEA_ASSIMILATION_FAILURE_RETRY_DELAY_MS - (Date.now() - previousFailure.failedAt);
        if (retryAfter > 0) {
          setProblemDiscussionStatus(`같은 문제정의 발화 재요청 대기 중 · ${Math.ceil(retryAfter / 1000)}초`);
          return;
        }
      }

      problemDiscussionInFlightRef.current = true;
      setProblemDiscussionStatus("AI가 문제정의 의견을 정리 중");

      try {
        const firstTargetIndex = transcripts.findIndex((row) => row.id === targetRows[0]?.id);
        const contextRows =
          firstTargetIndex > 0 ? normalizeTranscriptRows(transcripts.slice(Math.max(0, firstTargetIndex - 6), firstTargetIndex)) : [];
        const started = await startCanvasProblemDiscussionWorkspace({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          selected_group_id: targetGroupId,
          context_utterances: contextRows.map((row) => ({
            id: row.id,
            speaker: row.speaker || "참가자",
            text: stripLeadingTimestamp(row.text),
            timestamp: row.timestamp || "",
          })),
          target_utterances: targetRows.map((row) => ({
            id: row.id,
            speaker: row.speaker || "참가자",
            text: stripLeadingTimestamp(row.text),
            timestamp: row.timestamp || "",
          })),
        });

        applyServerProblemWorkspace(started.workspace);
        if (started.status !== "processing" || !started.job_id) {
          if (started.status === "error") {
            failedProblemDiscussionRef.current = {
              signature: targetSignature,
              failedAt: Date.now(),
              detail: started.detail || started.warning || "문제정의 의견 정리 실패",
            };
          }
          setProblemDiscussionStatus(started.detail || "문제정의 의견 정리 상태를 확인했습니다.");
          return;
        }

        let finalResult = started;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          finalResult = await getCanvasProblemDiscussionWorkspaceJob(meetingId, started.job_id);
          if (finalResult.status !== "processing") {
            applyServerProblemWorkspace(finalResult.workspace);
            break;
          }
        }

        if (finalResult.status === "completed") {
          failedProblemDiscussionRef.current = null;
          targetRows.forEach((row) => processedIds.add(row.id));
          setProblemDiscussionStatus(finalResult.used_llm ? "AI 문제정의 의견 반영됨" : "LLM 응답 없음");
        } else if (finalResult.status === "error") {
          failedProblemDiscussionRef.current = {
            signature: targetSignature,
            failedAt: Date.now(),
            detail: finalResult.detail || finalResult.warning || "문제정의 의견 정리 실패",
          };
          setProblemDiscussionStatus(finalResult.detail || "문제정의 의견 정리 실패");
        } else {
          setProblemDiscussionStatus("문제정의 의견 정리 응답 대기 중");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedProblemDiscussionRef.current = {
          signature: targetSignature,
          failedAt: Date.now(),
          detail: message,
        };
        setProblemDiscussionStatus(`문제정의 의견 정리 실패: ${message}`);
      } finally {
        problemDiscussionInFlightRef.current = false;
        const hasRemainingRows = normalizeTranscriptRows(transcripts).some(
          (row) =>
            row.canvas_stage === "problem-definition" &&
            row.id &&
            row.text.trim() &&
            !processedProblemUtteranceIdsRef.current.has(row.id),
        );
        if (stage === "problem-definition" && hasRemainingRows) {
          if (problemDiscussionFlushTimerRef.current) {
            window.clearTimeout(problemDiscussionFlushTimerRef.current);
          }
          problemDiscussionFlushTimerRef.current = window.setTimeout(
            () => void flushProblemDiscussionBuffer("timer"),
            1_000,
          );
        }
      }
    },
    [
      applyServerProblemWorkspace,
      meetingId,
      meetingTopicForAi,
      problemGroups,
      selectedProblemGroupId,
      stage,
      transcripts,
    ],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const pointerDrag = problemIdeaPointerDragRef.current;
      if (!pointerDrag) return;

      const deltaX = event.clientX - pointerDrag.startX;
      const deltaY = event.clientY - pointerDrag.startY;
      if (!pointerDrag.active && Math.hypot(deltaX, deltaY) < 4) {
        return;
      }

      event.preventDefault();
      if (!pointerDrag.active) {
        pointerDrag.active = true;
        beginProblemCardDrag(pointerDrag.groupId, pointerDrag.card, event.clientX, event.clientY);
      }

      updateProblemIdeaDragPoint(event.clientX, event.clientY);
      const preview = getProblemIdeaDropPreviewFromPoint(event.clientX, event.clientY);
      setProblemIdeaDropPreview((current) =>
        current?.targetGroupId === preview?.targetGroupId &&
        current?.cardKind === preview?.cardKind &&
        current?.insertIndex === preview?.insertIndex
          ? current
          : preview,
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      const pointerDrag = problemIdeaPointerDragRef.current;
      if (!pointerDrag) return;

      problemIdeaPointerDragRef.current = null;
      if (!pointerDrag.active) {
        return;
      }

      event.preventDefault();
      const preview = getProblemIdeaDropPreviewFromPoint(event.clientX, event.clientY);
      if (!preview) {
        problemIdeaDragRef.current = null;
        setProblemIdeaDrag(null);
        setProblemIdeaDropPreview(null);
        setProblemIdeaDragPoint(null);
        setActivityMessage("문제정의 그룹 밖에 놓아서 이동을 취소했습니다.");
        return;
      }

      setProblemIdeaDropPreview(preview);
      handleProblemIdeaDrop(preview.targetGroupId, {
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
          getData(type: string) {
            if (type === "application/x-imms-problem-idea") return pointerDrag.card.ideaId || "";
            if (type === "application/x-imms-problem-card") return pointerDrag.card.sourceNodeId;
            return "";
          },
        },
      } as unknown as React.DragEvent<HTMLDivElement>, preview);
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
    };
  }, [
    beginProblemCardDrag,
    getProblemIdeaDropPreviewFromPoint,
    handleProblemIdeaDrop,
    updateProblemIdeaDragPoint,
  ]);

  useEffect(() => {
    if (!problemIdeaDrag) return;

    const handleWindowDragOver = (event: DragEvent) => {
      updateProblemIdeaDragPoint(event.clientX, event.clientY);
    };
    const handleWindowDrop = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-problem-group-drop-id]")) {
        return;
      }

      event.preventDefault();
      problemIdeaDragRef.current = null;
      setProblemIdeaDrag(null);
      setProblemIdeaDropPreview(null);
      setProblemIdeaDragPoint(null);
      setActivityMessage("문제정의 그룹 밖에 놓아서 이동을 취소했습니다.");
    };

    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);

    return () => {
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [problemIdeaDrag, updateProblemIdeaDragPoint]);

  useEffect(() => {
    if (stage !== "problem-definition" || problemGroups.length === 0) {
      return;
    }

    const normalizedRows = normalizeTranscriptRows(transcripts);
    const hasUnprocessedRows = normalizedRows.some(
      (row) =>
        row.canvas_stage === "problem-definition" &&
        row.id &&
        row.text.trim() &&
        !processedProblemUtteranceIdsRef.current.has(row.id),
    );
    if (!hasUnprocessedRows) {
      return;
    }

    const timer = window.setTimeout(() => {
      void flushProblemDiscussionBuffer("silence");
    }, IDEA_ASSIMILATION_SILENCE_FLUSH_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [flushProblemDiscussionBuffer, problemGroups.length, stage, transcripts]);

  useEffect(() => {
    if (!meetingId || !sharedSyncEnabled || !workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }

    writeSharedWorkspaceSessionCache(
      meetingId,
      buildFullWorkspacePatchPayload({
        meetingId,
        meetingGoal: meetingGoalDraft,
        meetingGoalContext: meetingGoalContextDraft,
        stage,
        agendaOverrides,
        canvasItems,
        customGroups,
        problemGroups,
        solutionTopics,
        nodePositions,
        importedState: persistedSharedImportedState,
      }),
    );
  }, [
    agendaOverrides,
    canvasItems,
    customGroups,
    meetingGoalContextDraft,
    meetingGoalDraft,
    meetingId,
    nodePositions,
    persistedSharedImportedState,
    problemGroups,
    sharedSyncEnabled,
    solutionTopics,
    stage,
  ]);

  const sharedCanvasSignature = useMemo(
    () => buildSharedCanvasSignature(sharedCanvasSnapshot),
    [sharedCanvasSnapshot],
  );

  const currentPersonalNotesPayload = useMemo(() => {
    if (!meetingId || !userId || !workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return null;
    }
    return buildCanvasPersonalNotesPayload(meetingId, userId, personalNotes, localCanvasState);
  }, [localCanvasState, meetingId, personalNotes, userId]);

  useEffect(() => {
    latestPersonalNotesPayloadRef.current = currentPersonalNotesPayload;
  }, [currentPersonalNotesPayload]);

  useEffect(() => {
    if (!incomingSharedCanvasSync || incomingSharedCanvasSync.meeting_id !== meetingId) {
      return;
    }

    if (workspaceHydratingRef.current) {
      return;
    }

    if (incomingSharedCanvasSync.updated_by === userId) {
      return;
    }

    if (lastIncomingSharedSyncIdRef.current === incomingSharedCanvasSync.sync_id) {
      return;
    }

    const hasLocalNodePositions = CANVAS_STAGES.some(
      (stageKey) => Object.keys(nodePositions[stageKey] || {}).length > 0,
    );
    if (
      incomingSharedCanvasSync.updated_by === "__server__" &&
      workspaceLoadedRef.current &&
      hasLocalNodePositions
    ) {
      return;
    }

    lastIncomingSharedSyncIdRef.current = incomingSharedCanvasSync.sync_id;
    const incomingStage =
      incomingSharedCanvasSync.stage === "problem-definition" ||
      incomingSharedCanvasSync.stage === "solution"
        ? incomingSharedCanvasSync.stage
            : "ideation";
    const incomingCanvasItems = hydrateCanvasItems(incomingSharedCanvasSync.canvas_items || []);
    const incomingCustomGroups = hydrateCustomGroups(incomingSharedCanvasSync.custom_groups || []);
    const incomingMeetingGoal = incomingSharedCanvasSync.meeting_goal || "";
    const incomingMeetingGoalContext = incomingSharedCanvasSync.meeting_goal_context || "";
    const editingCanvasItem =
      incomingStage === "ideation" && editingCanvasItemId
        ? canvasItems.find((item) => item.id === editingCanvasItemId) || null
        : null;
    let nextIncomingCanvasItems = incomingCanvasItems;
    let nextIncomingNodePositions = normalizeCanvasNodePositionsForComputedIdeation(
      incomingSharedCanvasSync.node_positions || {},
    );

    if (editingCanvasItem) {
      let foundEditingItem = false;
      nextIncomingCanvasItems = incomingCanvasItems.map((item) => {
        if (item.id !== editingCanvasItem.id) return item;
        foundEditingItem = true;
        return {
          ...item,
          title: canvasItemDraftTitle,
          body: canvasItemDraftBody,
          user_edited: true,
        };
      });

      if (!foundEditingItem) {
        nextIncomingCanvasItems = [
          {
            ...editingCanvasItem,
            title: canvasItemDraftTitle,
            body: canvasItemDraftBody,
            user_edited: true,
          },
          ...nextIncomingCanvasItems,
        ];
      }

      nextIncomingNodePositions = normalizeCanvasNodePositionsForComputedIdeation(nextIncomingNodePositions);
    }

    const nextProblemGroups = hydrateProblemGroups(incomingSharedCanvasSync.problem_groups || [], problemGroups);
    const incomingSolutionTopics = hydrateSolutionTopics(
      incomingSharedCanvasSync.solution_topics || [],
      nextProblemGroups,
      solutionTopics,
    );
    const nextSolutionTopics =
      incomingStage === "solution" && editingSolutionNoteKey
        ? preserveEditingSolutionNoteDraft(
            incomingSolutionTopics,
            solutionTopics,
            editingSolutionNoteKey,
            solutionNoteTextDraft,
            solutionNoteFinalCommentDraft,
          )
        : incomingSolutionTopics;

    lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
      meeting_goal: incomingMeetingGoal,
      meeting_goal_context: incomingMeetingGoalContext,
      stage: incomingStage,
      agenda_overrides: incomingSharedCanvasSync.agenda_overrides || {},
      canvas_items: nextIncomingCanvasItems,
      custom_groups: serializeCustomGroups(incomingCustomGroups),
      problem_groups: incomingSharedCanvasSync.problem_groups || [],
      solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
      final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics),
      node_positions: nextIncomingNodePositions,
      imported_state: incomingSharedCanvasSync.imported_state || null,
    });
    applyingRemoteSharedSyncRef.current = true;

    setProblemGroups(nextProblemGroups);
    setSolutionTopics(nextSolutionTopics);
    setMeetingGoalDraft(incomingMeetingGoal);
    setMeetingGoalContextDraft(incomingMeetingGoalContext);
    setMeetingGoalEditorDraft(incomingMeetingGoal);
    setMeetingGoalContextEditorDraft(incomingMeetingGoalContext);
    onMeetingGoalChange(incomingMeetingGoal);
    onMeetingGoalContextChange(incomingMeetingGoalContext);
    setAgendaOverrides(incomingSharedCanvasSync.agenda_overrides || {});
    setCanvasItems(nextIncomingCanvasItems);
    setCustomGroups(incomingCustomGroups);
    setNodePositions((prev) =>
      sharedSyncEnabled
        ? nextIncomingNodePositions
        : mergeNodePositionsWithLocalOverrides(
            prev,
            nextIncomingNodePositions,
            localNodeOverridesRef.current,
        ),
    );
    setImportedState(incomingSharedCanvasSync.imported_state || null);
    if (incomingSharedCanvasSync.imported_state) {
      analysisSignatureAtImportRef.current = buildMeetingStateSignature(incomingSharedCanvasSync.imported_state);
      setImportOverrideActive(true);
    } else {
      analysisSignatureAtImportRef.current = "";
      setImportOverrideActive(false);
    }
    setStage(incomingStage);
    lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
      meetingGoal: incomingMeetingGoal,
      meetingGoalContext: incomingMeetingGoalContext,
      stage: incomingStage,
      agendaOverrides: incomingSharedCanvasSync.agenda_overrides || {},
      canvasItems: nextIncomingCanvasItems,
      customGroups: incomingCustomGroups,
      problemGroups: nextProblemGroups,
      solutionTopics: nextSolutionTopics,
      nodePositions: nextIncomingNodePositions,
      importedState: incomingSharedCanvasSync.imported_state || null,
    });
    setLeftPanelTab("detail");
    if (incomingStage === "problem-definition") {
      const nextGroupId = nextProblemGroups[0]?.group_id || "";
      setSelectedProblemGroupId(nextGroupId);
      setSelectedSolutionTopicId("");
      setSelectedNodeId(nextGroupId ? `problem-${nextGroupId}` : "");
    } else if (incomingStage === "solution") {
      const nextTopicId = nextSolutionTopics[0]?.group_id || "";
      setSelectedProblemGroupId("");
      setSelectedSolutionTopicId(nextTopicId);
      setSelectedNodeId(nextTopicId ? `solution-${nextTopicId}` : "");
    } else {
      setSelectedProblemGroupId("");
      setSelectedSolutionTopicId("");
      const canKeepSelectedCanvasItem =
        selectedCanvasItemId && nextIncomingCanvasItems.some((item) => item.id === selectedCanvasItemId);
      const nextSelectedCanvasItemId =
        editingCanvasItem?.id || (canKeepSelectedCanvasItem ? selectedCanvasItemId : "");
      setSelectedCanvasItemId(nextSelectedCanvasItemId);
      setSelectedNodeId(nextSelectedCanvasItemId ? `canvas-item-${nextSelectedCanvasItemId}` : "");
    }
    setActivityMessage("다른 참가자의 canvas 변경사항이 반영되었습니다.");

    window.setTimeout(() => {
      applyingRemoteSharedSyncRef.current = false;
    }, 0);
  }, [
    analysisStateSignature,
    canvasItemDraftBody,
    canvasItemDraftTitle,
    canvasItems,
    editingCanvasItemId,
    editingSolutionNoteKey,
    incomingSharedCanvasSync,
    meetingId,
    nodePositions,
    onMeetingGoalChange,
    onMeetingGoalContextChange,
    problemGroups,
    selectedCanvasItemId,
    sharedSyncEnabled,
    solutionNoteFinalCommentDraft,
    solutionNoteTextDraft,
    solutionTopics,
    userId,
  ]);

  useEffect(() => {
    const flushPendingCanvasState = () => {
      if (
        meetingId &&
        latestSharedSyncEnabledRef.current &&
        workspaceLoadedRef.current &&
        !workspaceHydratingRef.current
      ) {
        console.info("[canvas pagehide flush] sending workspace snapshot", {
          meetingId,
          stage: latestSharedWorkspaceRef.current.stage,
          canvasItems: latestSharedWorkspaceRef.current.canvasItems.length,
          nodePositions: summarizeNodePositionsForDebug(latestSharedWorkspaceRef.current.nodePositions),
          renderedNodes: summarizeRenderedNodesForDebug(nodes),
        });
        flushCanvasWorkspacePatch(
          buildFullWorkspacePatchPayload({
            meetingId,
            ...latestSharedWorkspaceRef.current,
          }),
        );
      }
      if (latestPersonalNotesPayloadRef.current) {
        flushCanvasPersonalNotes(latestPersonalNotesPayloadRef.current);
      }
    };

    window.addEventListener("pagehide", flushPendingCanvasState);
    return () => {
      window.removeEventListener("pagehide", flushPendingCanvasState);
    };
  }, [meetingId]);

  useEffect(() => {
    if (
      !meetingId ||
      !userId ||
      !sharedSyncEnabled ||
      !workspaceLoadedRef.current ||
      workspaceHydratingRef.current ||
      applyingRemoteSharedSyncRef.current ||
      lastSharedSyncSignatureRef.current === sharedCanvasSignature
    ) {
      return;
    }

    if (sharedSyncTimerRef.current) {
      window.clearTimeout(sharedSyncTimerRef.current);
    }

    sharedSyncTimerRef.current = window.setTimeout(() => {
      if (workspaceHydratingRef.current || applyingRemoteSharedSyncRef.current) {
        return;
      }

      lastSharedSyncSignatureRef.current = sharedCanvasSignature;
      onSharedCanvasSync({
        sync_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        meeting_id: meetingId,
        meeting_goal: sharedCanvasSnapshot.meeting_goal,
        meeting_goal_context: sharedCanvasSnapshot.meeting_goal_context,
        updated_by: userId,
        updated_at: new Date().toISOString(),
        stage: sharedCanvasSnapshot.stage,
        agenda_overrides: sharedCanvasSnapshot.agenda_overrides,
        canvas_items: sharedCanvasSnapshot.canvas_items,
        custom_groups: sharedCanvasSnapshot.custom_groups,
        problem_groups: sharedCanvasSnapshot.problem_groups,
        solution_topics: sharedCanvasSnapshot.solution_topics,
        final_solution_summary: sharedCanvasSnapshot.final_solution_summary,
        node_positions: sharedCanvasSnapshot.node_positions,
        imported_state: sharedCanvasSnapshot.imported_state,
      });
    }, 140);

    return () => {
      if (sharedSyncTimerRef.current) {
        window.clearTimeout(sharedSyncTimerRef.current);
        sharedSyncTimerRef.current = null;
      }
    };
  }, [meetingId, onSharedCanvasSync, sharedCanvasSignature, sharedCanvasSnapshot, sharedSyncEnabled, userId]);

  useEffect(() => {
    if (
      !incomingCanvasStateRequestId ||
      !sharedSyncEnabled ||
      !workspaceLoadedRef.current ||
      workspaceHydratingRef.current ||
      applyingRemoteSharedSyncRef.current
    ) {
      return;
    }

    forceBroadcastSharedCanvas();
  }, [forceBroadcastSharedCanvas, incomingCanvasStateRequestId, sharedSyncEnabled]);

  const getTopicCollapsed = useCallback(
    (item: CanvasItemViewModel) => topicCollapsedOverrides[item.id] ?? Boolean(item.topic_collapsed),
    [topicCollapsedOverrides],
  );

  const handleToggleTopicCollapsed = useCallback(
    (itemId: string) => {
      if (!itemId) return;
      const targetTopic = canvasItems.find((item) => item.id === itemId && isTopicCanvasItem(item));
      if (!targetTopic) return;

      setTopicCollapsedOverrides((current) => {
        const next = {
          ...current,
          [itemId]: !(current[itemId] ?? Boolean(targetTopic.topic_collapsed)),
        };
        writeTopicCollapseOverrides(meetingId, userId, next);
        return next;
      });
    },
    [canvasItems, meetingId, userId],
  );

  const handleGenerateSolutionSuggestions = useCallback(
    async (topicId: string) => {
      const targetTopic = solutionTopics.find((topic) => topic.group_id === topicId);
      if (!targetTopic || !meetingId) {
        setActivityMessage("AI 추천을 생성할 해결책 항목을 먼저 선택해 주세요.");
        return;
      }

      setSolutionSuggestionBusyTopicId(topicId);
      setActivityMessage("해결책 AI 추천 아이디어를 생성하는 중입니다.");
      try {
        const result = await generateCanvasSolutionStage({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          topics: [
            {
              group_id: targetTopic.group_id,
              topic_no: targetTopic.topic_no,
              topic: targetTopic.problem_topic || targetTopic.topic,
              conclusion: targetTopic.problem_conclusion || targetTopic.conclusion,
            },
          ],
        });
        const generatedTopic = hydrateSolutionTopics(result.topics || [], problemGroups, [targetTopic])
          .find((topic) => topic.group_id === topicId);

        if (!generatedTopic) {
          setActivityMessage(result.warning || "AI 추천 결과를 찾지 못했습니다.");
          return;
        }

        const generatedTexts = new Set<string>();
        const generatedSuggestions = (generatedTopic.ai_suggestions || [])
          .map((suggestion, index) => {
            const text = suggestion.text.trim();
            if (!text || generatedTexts.has(text)) return null;
            generatedTexts.add(text);
            const previous = targetTopic.ai_suggestions.find((item) => item.text.trim() === text);
            return makeSolutionAiSuggestion(
              {
                ...suggestion,
                id: suggestion.id || previous?.id || `${topicId}-ai-${index + 1}`,
                status: previous?.status || suggestion.status,
              },
              `${topicId}-ai-${index + 1}`,
            );
          })
          .filter((suggestion): suggestion is SolutionAiSuggestionViewModel => Boolean(suggestion));
        const usedSuggestionIds = new Set(generatedSuggestions.map((suggestion) => suggestion.id));
        const preservedSelectedSuggestions = targetTopic.ai_suggestions
          .filter((suggestion) => suggestion.status === "selected" && !generatedTexts.has(suggestion.text.trim()))
          .map((suggestion, index) => {
            const fallbackId = `${topicId}-selected-ai-${index + 1}`;
            const nextId = usedSuggestionIds.has(suggestion.id) ? fallbackId : suggestion.id || fallbackId;
            usedSuggestionIds.add(nextId);
            return makeSolutionAiSuggestion({ ...suggestion, id: nextId }, nextId);
          });
        const nextSuggestions = [...generatedSuggestions, ...preservedSelectedSuggestions].slice(0, 8);

        setSolutionTopics((prev) =>
          prev.map((topic) =>
            topic.group_id === topicId
              ? {
                  ...topic,
                  ideas: nextSuggestions.map((suggestion) => suggestion.text),
                  ai_suggestions: nextSuggestions,
                }
              : topic,
          ),
        );
        setSelectedSolutionTopicId(topicId);
        setSelectedNodeId(`solution-${topicId}`);
        setActivityMessage(result.warning || `AI 추천 아이디어 ${nextSuggestions.length}개를 생성했습니다.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActivityMessage(`해결책 AI 추천 생성 실패: ${message}`);
      } finally {
        setSolutionSuggestionBusyTopicId("");
      }
    },
    [meetingId, meetingTopicForAi, problemGroups, solutionTopics],
  );

  const handlePruneSolutionSuggestions = useCallback(
    async (targetTopicId = "", persistImmediately = false, sourceTopics?: SolutionTopicViewModel[]) => {
      const baseSolutionTopics = sourceTopics || latestSharedWorkspaceRef.current.solutionTopics || solutionTopics;
      const { topics: nextSolutionTopics, removedCount } = pruneUnselectedSolutionSuggestions(
        baseSolutionTopics,
        targetTopicId,
      );

      if (removedCount === 0) {
        setActivityMessage("정리할 미채택 AI 추천이 없습니다.");
        return nextSolutionTopics;
      }

      setSolutionTopics(nextSolutionTopics);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage,
        solutionTopics: nextSolutionTopics,
        importedState: persistedSharedImportedState,
      };

      if (sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          solutionTopics: nextSolutionTopics,
        });

        if (meetingId) {
          const patch = {
            meeting_id: meetingId,
            solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
            final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics),
            imported_state: persistedSharedImportedState,
          };
          if (persistImmediately) {
            await saveCanvasWorkspacePatch(patch);
          } else {
            void saveCanvasWorkspacePatch(patch).catch((error) => {
              console.error("Failed to prune solution suggestions:", error);
            });
          }
        }
      }

      setActivityMessage(`미채택 AI 추천 ${removedCount}개를 정리했습니다.`);
      return nextSolutionTopics;
    },
    [
      forceBroadcastSharedCanvas,
      meetingId,
      persistedSharedImportedState,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  const handleStartSolutionNoteEdit = useCallback((topicId: string, note: SolutionNoteViewModel) => {
    setEditingSolutionNoteKey(makeSolutionNoteEditKey(topicId, note.id));
    setSolutionNoteTextDraft(note.text);
    setSolutionNoteFinalCommentDraft(note.final_comment || "");
  }, []);

  const handleCancelSolutionNoteEdit = useCallback(() => {
    setEditingSolutionNoteKey("");
    setSolutionNoteTextDraft("");
    setSolutionNoteFinalCommentDraft("");
  }, []);

  const handleSaveSolutionNoteEdit = useCallback(async () => {
    if (!editingSolutionNoteKey) return;

    const nextSolutionTopics = applySolutionNoteDraft(
      solutionTopics,
      editingSolutionNoteKey,
      solutionNoteTextDraft,
      solutionNoteFinalCommentDraft,
    );

    setSolutionTopics(nextSolutionTopics);
    setEditingSolutionNoteKey("");
    setSolutionNoteTextDraft("");
    setSolutionNoteFinalCommentDraft("");
    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      stage,
      solutionTopics: nextSolutionTopics,
      importedState: persistedSharedImportedState,
    };

    if (sharedSyncEnabled) {
      forceBroadcastSharedCanvas({
        solutionTopics: nextSolutionTopics,
      });

      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
          final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics),
          imported_state: persistedSharedImportedState,
        }).catch((error) => {
          console.error("Failed to save solution note edit:", error);
        });
      }
    }

    setActivityMessage("해결책 카드를 저장했습니다.");
  }, [
    editingSolutionNoteKey,
    forceBroadcastSharedCanvas,
    meetingId,
    persistedSharedImportedState,
    sharedSyncEnabled,
    solutionNoteFinalCommentDraft,
    solutionNoteTextDraft,
    solutionTopics,
    stage,
  ]);

  const handleCopyFinalSolutionMarkdown = useCallback(async () => {
    const markdown = buildFinalSolutionSummaryPayload(solutionTopics).markdown.trim();
    if (!markdown) {
      setActivityMessage("복사할 최종 해결책 결론이 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      setActivityMessage("최종 해결책 결론을 마크다운으로 복사했습니다.");
    } catch (error) {
      console.error("Failed to copy final solution markdown:", error);
      setActivityMessage("브라우저 권한 문제로 마크다운 복사에 실패했습니다.");
    }
  }, [solutionTopics]);

  const graphBlueprint = useMemo(() => {
    if (stage === "problem-definition") {
      const heights = problemGroups.map((group) => estimateProblemGroupNodeHeight(group));
      const positions = buildGridPositions(heights, 600, 92, 80, 120);
      const groupPositionById = new Map(
        problemGroups.map((group, index) => {
          const nodeId = `problem-${group.group_id}`;
          return [group.group_id, nodePositions["problem-definition"]?.[nodeId] || positions[index]] as const;
        }),
      );

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          ...problemGroups.flatMap((group) => [
            group.group_id,
            ...(group.discussion_items || []).flatMap((item) => [
              item.id,
              item.parent_group_id,
              item.target_node_id || "",
              item.target_node_label || "",
              item.target_node_kind || "",
              item.ai_pending ? "pending" : "ready",
            ]),
          ]),
        ]),
        nodeDescriptors: [
          ...problemGroups.map((group, index) => {
          const selected = selectedProblemGroupId === group.group_id;
          const loading = loadingProblemGroupIds.includes(group.group_id);
          const dropTarget = dropProblemGroupId === group.group_id;
          const nodeId = `problem-${group.group_id}`;
          const savedPosition = nodePositions["problem-definition"]?.[nodeId];
          const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition
            ? "persisted"
            : "fallback";

          return {
            id: nodeId,
            position: savedPosition || positions[index],
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "rounded-3xl border border-violet-200 bg-violet-50 shadow-sm",
            style: { width: 520, minHeight: heights[index], borderRadius: 28, padding: 0 },
            data: {
              contentSignature: buildNodeContentSignature([
                group.group_id,
                group.topic,
                group.status,
                selected,
                loading,
                dropTarget,
                selectedProblemSourceNodeId,
                group.insight_lens,
                group.conclusion,
                problemIdeaDrag?.sourceGroupId,
                problemIdeaDrag?.sourceNodeId,
                problemIdeaDrag?.cardKind,
                problemIdeaDropPreview?.targetGroupId,
                problemIdeaDropPreview?.cardKind,
                problemIdeaDropPreview?.insertIndex,
                ...(group.keywords || []),
                ...(group.agenda_titles || []),
                ...(group.source_summary_items || []),
                ...(group.ideas || []).flatMap((idea) => [
                  idea.id,
                  idea.kind,
                  idea.title,
                  idea.body,
                ]),
              ]),
              label: makeProblemGroupNodeLabel(
                group,
                index,
                selected,
                loading,
                dropTarget,
                selectedProblemSourceNodeId,
                problemIdeaDrag,
                problemIdeaDropPreview,
                (sourceNodeId) => {
                  setSelectedProblemGroupId(group.group_id);
                  setSelectedProblemSourceNodeId(sourceNodeId);
                  setLeftPanelTab("detail");
                },
                (event, card) => handleProblemIdeaDragStart(group.group_id, event, card),
                handleProblemIdeaDragMove,
                (event, card) => handleProblemIdeaPointerDown(group.group_id, event, card),
                (event, card) => handleProblemIdeaDragOver(group.group_id, event, card),
                (event) => handleProblemIdeaDrop(group.group_id, event),
                handleProblemIdeaDragEnd,
                (event) => {
                  const types = Array.from(event.dataTransfer.types || []);
                  const isNoteDrag =
                    types.includes("application/x-imms-note-id") ||
                    types.includes("text/plain");
                  if (!isNoteDrag) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setDropProblemGroupId(group.group_id);
                },
                () => {
                  if (dropProblemGroupId === group.group_id) {
                    setDropProblemGroupId("");
                  }
                },
                (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const noteId =
                    event.dataTransfer.getData("application/x-imms-note-id") ||
                    event.dataTransfer.getData("text/plain");
                  if (!noteId) return;
                  handleAttachPersonalNoteToProblemGroup(group.group_id, noteId);
                },
              ),
            },
          };
          }),
          ...problemGroups.flatMap((group) => {
            const groupPosition = groupPositionById.get(group.group_id) || { x: 80, y: 120 };
            let nextY = groupPosition.y;
            return (group.discussion_items || []).filter((item) => !item.target_node_id).map((item) => {
              const nodeId = `problem-discussion-${item.id}`;
              const savedPosition = nodePositions["problem-definition"]?.[nodeId];
              const itemHeight = estimateProblemDiscussionNodeHeight(item);
              const position = savedPosition || {
                x: groupPosition.x + 560,
                y: nextY,
              };
              const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition ? "persisted" : "computed";
              nextY += itemHeight + 18;

              return {
                id: nodeId,
                position,
                positionSource,
                sourcePosition: Position.Right,
                targetPosition: Position.Left,
                className: "!border-0 !bg-transparent !p-0 !shadow-none",
                style: { width: 340, minHeight: itemHeight, padding: 0 },
                data: {
                  contentSignature: buildNodeContentSignature([
                    item.id,
                    item.parent_group_id,
                    item.title,
                    item.body,
                    item.ai_pending,
                    selectedNodeId === nodeId,
                    ...(item.keywords || []),
                    ...(item.evidence_utterance_ids || []),
                  ]),
                  label: makeProblemDiscussionNodeLabel(item, selectedNodeId === nodeId),
                },
              };
            });
          }),
        ],
      };
    }

    if (stage === "solution") {
      const heights = solutionTopics.map((topic) => estimateSolutionNodeHeight(topic));
      const positions: Array<{ x: number; y: number }> = [];
      let nextY = 32;
      heights.forEach((height) => {
        positions.push({ x: 24, y: nextY });
        nextY += height + 18;
      });
      const activeSolutionTopic =
        solutionTopics.find((topic) => topic.group_id === selectedSolutionTopicId) ||
        solutionTopics[0] ||
        null;
      const adoptSolutionSuggestion = (topicId: string, suggestionId: string) => {
        setSolutionTopics((prev) =>
          prev.map((topic) => {
            if (topic.group_id !== topicId) return topic;
            const suggestion = topic.ai_suggestions.find((item) => item.id === suggestionId);
            if (!suggestion || suggestion.status === "selected") return topic;
            const hasExistingNote = topic.notes.some((note) => note.source_ai_id === suggestion.id);
            const nextSuggestions = topic.ai_suggestions.map((item) =>
              item.id === suggestionId
                ? makeSolutionAiSuggestion({ ...item, status: "selected" }, item.id)
                : makeSolutionAiSuggestion(item, item.id),
            );
            const nextNotes = hasExistingNote
              ? topic.notes
              : [
                  ...topic.notes,
                  makeSolutionNote(
                    {
                      text: suggestion.text,
                      source: "ai",
                      source_ai_id: suggestion.id,
                      is_final_candidate: false,
                      final_comment: "",
                    },
                    `solution-note-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                  ),
                ];

            return {
              ...topic,
              ai_suggestions: nextSuggestions,
              notes: nextNotes,
            };
          }),
        );
        setSelectedSolutionTopicId(topicId);
        setSelectedNodeId(`solution-${topicId}`);
        setActivityMessage("AI 추천 아이디어를 해결책 카드로 채택했습니다.");
      };
      const addSolutionUserNote = (topicId: string) => {
        const nextText = solutionNoteDraft.trim();
        if (!nextText) {
          setActivityMessage("추가할 해결책 메모를 입력해 주세요.");
          return;
        }

        setSolutionTopics((prev) =>
          prev.map((topic) =>
            topic.group_id === topicId
              ? {
                  ...topic,
                  notes: [
                    ...topic.notes,
                    makeSolutionNote(
                      {
                        text: nextText,
                        source: "user",
                        is_final_candidate: false,
                        final_comment: "",
                      },
                      `solution-user-note-${Date.now()}`,
                    ),
                  ],
                }
              : topic,
          ),
        );
        setSolutionNoteDraft("");
        setSelectedSolutionTopicId(topicId);
        setSelectedNodeId(`solution-${topicId}`);
        setActivityMessage("사용자 해결책 카드를 추가했습니다.");
      };
      const toggleSolutionFinalNote = (topicId: string, noteId: string) => {
        setSolutionTopics((prev) => {
          const nextSolutionTopics = prev.map((topic) =>
            topic.group_id === topicId
              ? {
                  ...topic,
                  notes: topic.notes.map((note) =>
                    note.id === noteId
                      ? makeSolutionNote(
                          {
                            ...note,
                            is_final_candidate: !note.is_final_candidate,
                          },
                          note.id,
                        )
                      : makeSolutionNote(note, note.id),
                  ),
                }
              : topic,
          );
          latestSharedWorkspaceRef.current = {
            ...latestSharedWorkspaceRef.current,
            stage,
            solutionTopics: nextSolutionTopics,
            importedState: persistedSharedImportedState,
          };
          return nextSolutionTopics;
        });
        setSelectedSolutionTopicId(topicId);
        setSelectedNodeId(`solution-${topicId}`);
      };
      const finalNotes = solutionTopics.flatMap((topic) =>
        solutionTopicFinalNotes(topic).map((note) => ({
          id: `${topic.group_id}-${note.id}`,
          topicId: topic.group_id,
          topicTitle: topic.topic,
          text: note.text,
          final_comment: note.final_comment || "",
        })),
      );
      const rightDescriptors: CanvasNodeDescriptor[] = [];

      if (activeSolutionTopic) {
        const measuredPaneWidth = solutionRightPaneWidth || (isDesktopLayout ? 920 : 520);
        const rightBaseX = Math.max(20, Math.min(44, Math.round(measuredPaneWidth * 0.045)));
        const availableWidth = Math.max(300, measuredPaneWidth - rightBaseX * 2);
        const solutionCanvasColumns = availableWidth >= 740 ? 2 : 1;
        const rightColumnGap = solutionCanvasColumns > 1
          ? Math.max(20, Math.min(36, Math.round(availableWidth * 0.04)))
          : 0;
        const rightCardWidth = solutionCanvasColumns > 1
          ? Math.min(400, Math.floor((availableWidth - rightColumnGap) / 2))
          : Math.min(520, availableWidth);
        const rightContentWidth = solutionCanvasColumns > 1
          ? rightCardWidth * 2 + rightColumnGap
          : rightCardWidth;
        const rightGapX = rightCardWidth + rightColumnGap;
        const rightGapY = solutionCanvasColumns > 1 ? 18 : 14;
        const cardLineChars = estimateSolutionCardLineChars(rightCardWidth);
        const overviewHeight = solutionCanvasColumns > 1 ? 270 : 330;
        const sectionHeaderHeight = solutionCanvasColumns > 1 ? 72 : 108;
        const solutionSuggestionBusy = solutionSuggestionBusyTopicId === activeSolutionTopic.group_id;
        let rightBaseY = 32;

        rightDescriptors.push({
          id: `solution-detail::${activeSolutionTopic.group_id}`,
          position: { x: rightBaseX, y: rightBaseY },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: rightContentWidth, minHeight: overviewHeight, padding: 0 },
          draggable: false,
          data: {
            contentSignature: buildNodeContentSignature([
              "solution-detail",
              activeSolutionTopic.group_id,
              activeSolutionTopic.topic,
              activeSolutionTopic.conclusion,
              activeSolutionTopic.problem_topic,
              activeSolutionTopic.problem_insight,
              activeSolutionTopic.problem_conclusion,
              activeSolutionTopic.status,
            ]),
            label: makeSolutionOverviewNodeLabel(activeSolutionTopic),
          },
        });

        rightBaseY += overviewHeight + 34;
        rightDescriptors.push({
          id: `solution-ai-header::${activeSolutionTopic.group_id}`,
          position: { x: rightBaseX, y: rightBaseY },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: rightContentWidth, minHeight: sectionHeaderHeight, padding: 0 },
          draggable: false,
          selectable: false,
          data: {
            contentSignature: buildNodeContentSignature([
              "solution-ai-header",
              activeSolutionTopic.group_id,
              activeSolutionTopic.ai_suggestions.length,
              activeSolutionTopic.ai_suggestions.filter((item) => item.status !== "selected").length,
              solutionSuggestionBusy,
            ]),
            label: (
              <div className="nopan flex h-full items-center justify-between border border-black/10 bg-white px-5 py-4 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">AI 추천 아이디어</p>
                  <h4 className="mt-1 text-lg font-semibold text-slate-950">참고용 제안</h4>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    className="nodrag nopan inline-flex cursor-pointer items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-70"
                    disabled={solutionSuggestionBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleGenerateSolutionSuggestions(activeSolutionTopic.group_id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {solutionSuggestionBusy ? (
                      <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                    ) : null}
                    {solutionSuggestionBusy ? "생성 중" : "추천 생성"}
                  </button>
                  <button
                    type="button"
                    className="nodrag nopan inline-flex cursor-pointer items-center border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8]"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handlePruneSolutionSuggestions(activeSolutionTopic.group_id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    미채택 정리
                  </button>
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    {activeSolutionTopic.ai_suggestions.length}개
                  </span>
                </div>
              </div>
            ),
          },
        });

        rightBaseY += sectionHeaderHeight + 14;
        const suggestionEmptyText = solutionSuggestionBusy
          ? "AI 추천 아이디어를 생성하는 중입니다."
          : "아직 제안된 AI 추천 아이디어가 없습니다.";
        const suggestionItems: SolutionAiSuggestionViewModel[] = activeSolutionTopic.ai_suggestions.length > 0
          ? activeSolutionTopic.ai_suggestions
          : [
              makeSolutionAiSuggestion(
                {
                  id: "empty",
                  text: suggestionEmptyText,
                  status: "draft",
                },
                "empty",
              ),
            ];
        const suggestionHeights = suggestionItems.map((suggestion) =>
          suggestion.id === "empty"
            ? 120
            : 142 + Math.min(3, Math.max(0, estimateWrappedLines(suggestion.text, cardLineChars) - 2)) * 18,
        );
        const suggestionPositions = buildColumnPositions(
          suggestionHeights,
          solutionCanvasColumns,
          rightGapX,
          rightGapY,
          rightBaseX,
          rightBaseY,
        );
        suggestionItems.forEach((suggestion, index) => {
          const isEmpty = suggestion.id === "empty";
          rightDescriptors.push({
            id: isEmpty
              ? `solution-ai::${activeSolutionTopic.group_id}::empty`
              : `solution-ai::${activeSolutionTopic.group_id}::${suggestion.id}`,
            position: suggestionPositions[index],
            positionSource: "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: rightCardWidth, minHeight: suggestionHeights[index], padding: 0 },
            draggable: false,
            selectable: !isEmpty,
            data: {
              contentSignature: buildNodeContentSignature([
                "solution-ai",
                activeSolutionTopic.group_id,
                suggestion.id,
                suggestion.text,
                suggestion.status,
                solutionSuggestionBusy,
              ]),
              label: isEmpty ? (
                <div className="nopan flex h-full min-h-[120px] items-center border border-dashed border-black/10 bg-[#fafafa] px-4 py-5 text-sm leading-6 text-[#777]">
                  {suggestionEmptyText}
                </div>
              ) : makeSolutionAiSuggestionNodeLabel(
                suggestion,
                index,
                (event) => {
                  event.stopPropagation();
                  adoptSolutionSuggestion(activeSolutionTopic.group_id, suggestion.id);
                },
              ),
            },
          });
        });

        const suggestionBottom = suggestionPositions.reduce(
          (bottom, position, index) => Math.max(bottom, position.y + suggestionHeights[index]),
          rightBaseY + 120,
        );
        rightBaseY = suggestionBottom + 34;
        rightDescriptors.push({
          id: `solution-note-header::${activeSolutionTopic.group_id}`,
          position: { x: rightBaseX, y: rightBaseY },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: rightContentWidth, minHeight: sectionHeaderHeight, padding: 0 },
          draggable: false,
          selectable: false,
          data: {
            contentSignature: buildNodeContentSignature([
              "solution-note-header",
              activeSolutionTopic.group_id,
              activeSolutionTopic.notes.length,
            ]),
            label: (
              <div className="nopan flex h-full items-center justify-between border border-black/10 bg-white px-5 py-4 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">채택 카드</p>
                  <h4 className="mt-1 text-lg font-semibold text-slate-950">회의에서 남길 해결책</h4>
                </div>
                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                  {activeSolutionTopic.notes.length}개
                </span>
              </div>
            ),
          },
        });

        rightBaseY += sectionHeaderHeight + 14;
        const noteItems: SolutionNoteViewModel[] = activeSolutionTopic.notes.length > 0 ? activeSolutionTopic.notes : [];
        const noteHeights = noteItems.map((note) => {
          const editing = editingSolutionNoteKey === makeSolutionNoteEditKey(activeSolutionTopic.group_id, note.id);
          if (editing) return note.is_final_candidate ? 360 : 282;
          return note.is_final_candidate
            ? 240
            : 146 + Math.min(3, Math.max(0, estimateWrappedLines(note.text, cardLineChars) - 2)) * 18;
        });
        const notePositions = buildColumnPositions(noteHeights, solutionCanvasColumns, rightGapX, rightGapY, rightBaseX, rightBaseY);
        if (noteItems.length === 0) {
          rightDescriptors.push({
            id: `solution-note::${activeSolutionTopic.group_id}::empty`,
            position: { x: rightBaseX, y: rightBaseY },
            positionSource: "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: rightContentWidth, minHeight: 120, padding: 0 },
            draggable: false,
            selectable: false,
            data: {
              contentSignature: buildNodeContentSignature(["solution-note-empty", activeSolutionTopic.group_id]),
              label: (
                <div className="nopan flex h-full min-h-[120px] items-center border border-dashed border-black/10 bg-[#fafafa] px-4 py-5 text-sm leading-6 text-[#777]">
                  AI 추천을 채택하거나 사용자 메모를 추가하면 이 영역에 카드로 쌓입니다.
                </div>
              ),
            },
          });
        }
        noteItems.forEach((note, index) => {
          const noteEditKey = makeSolutionNoteEditKey(activeSolutionTopic.group_id, note.id);
          const noteEditing = editingSolutionNoteKey === noteEditKey;
          rightDescriptors.push({
            id: `solution-note::${activeSolutionTopic.group_id}::${note.id}`,
            position: notePositions[index],
            positionSource: "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: rightCardWidth, minHeight: noteHeights[index], padding: 0 },
            draggable: false,
            data: {
              contentSignature: buildNodeContentSignature([
                "solution-note",
                activeSolutionTopic.group_id,
                note.id,
                note.text,
                note.source,
                note.is_final_candidate,
                note.final_comment,
                noteEditing,
                noteEditing ? solutionNoteTextDraft : "",
                noteEditing ? solutionNoteFinalCommentDraft : "",
              ]),
              label: makeSolutionNoteNodeLabel(
                note,
                index,
                (event) => {
                  event.stopPropagation();
                  toggleSolutionFinalNote(activeSolutionTopic.group_id, note.id);
                },
                noteEditing,
                noteEditing ? solutionNoteTextDraft : note.text,
                noteEditing ? solutionNoteFinalCommentDraft : note.final_comment || "",
                (event) => {
                  event.stopPropagation();
                  handleStartSolutionNoteEdit(activeSolutionTopic.group_id, note);
                },
                setSolutionNoteTextDraft,
                setSolutionNoteFinalCommentDraft,
                (event) => {
                  event.stopPropagation();
                  void handleSaveSolutionNoteEdit();
                },
                (event) => {
                  event.stopPropagation();
                  handleCancelSolutionNoteEdit();
                },
              ),
            },
          });
        });

        const noteBottom = noteItems.length > 0
          ? notePositions.reduce((bottom, position, index) => Math.max(bottom, position.y + noteHeights[index]), rightBaseY)
          : rightBaseY + 120;
        rightBaseY = noteBottom + 18;
        rightDescriptors.push({
          id: `solution-composer::${activeSolutionTopic.group_id}`,
          position: { x: rightBaseX, y: rightBaseY },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: rightContentWidth, minHeight: 220, padding: 0 },
          draggable: false,
          data: {
            contentSignature: buildNodeContentSignature([
              "solution-composer",
              activeSolutionTopic.group_id,
              solutionNoteDraft,
            ]),
            label: makeSolutionComposerNodeLabel(
              solutionNoteDraft,
              setSolutionNoteDraft,
              (event) => {
                event.stopPropagation();
                addSolutionUserNote(activeSolutionTopic.group_id);
              },
            ),
          },
        });

        rightBaseY += 254;
        rightDescriptors.push({
          id: `solution-final-header::${activeSolutionTopic.group_id}`,
          position: { x: rightBaseX, y: rightBaseY },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: rightContentWidth, minHeight: sectionHeaderHeight, padding: 0 },
          draggable: false,
          selectable: false,
          data: {
            contentSignature: buildNodeContentSignature([
              "solution-final-header",
              activeSolutionTopic.group_id,
              finalNotes.length,
            ]),
            label: (
              <div className="nopan flex h-full items-center justify-between border border-black/10 bg-white px-5 py-4 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">최종 결론 모음</p>
                  <h4 className="mt-1 text-lg font-semibold text-slate-950">표시된 해결책</h4>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                  {finalNotes.length}개
                </span>
              </div>
            ),
          },
        });

        rightBaseY += sectionHeaderHeight + 14;
        const finalHeights = finalNotes.length > 0 ? finalNotes.map(() => 150) : [120];
        const finalPositions = buildColumnPositions(finalHeights, solutionCanvasColumns, rightGapX, rightGapY, rightBaseX, rightBaseY);
        if (finalNotes.length === 0) {
          rightDescriptors.push({
            id: `solution-final::${activeSolutionTopic.group_id}::empty`,
            position: finalPositions[0],
            positionSource: "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: rightContentWidth, minHeight: 120, padding: 0 },
            draggable: false,
            selectable: false,
            data: {
              contentSignature: buildNodeContentSignature(["solution-final-empty", activeSolutionTopic.group_id]),
              label: (
                <div className="nopan flex h-full min-h-[120px] items-center border border-dashed border-black/10 bg-[#fafafa] px-4 py-5 text-sm leading-6 text-[#777]">
                  결론 후보를 최종 결론으로 표시하면 여기에서 전체 모아볼 수 있습니다.
                </div>
              ),
            },
          });
        }
        finalNotes.forEach((note, index) => {
          rightDescriptors.push({
            id: `solution-final::${note.topicId}::${note.id}`,
            position: finalPositions[index],
            positionSource: "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: rightCardWidth, minHeight: finalHeights[index], padding: 0 },
            draggable: false,
            data: {
              contentSignature: buildNodeContentSignature([
                "solution-final",
                note.id,
                note.topicId,
                note.topicTitle,
                note.text,
                note.final_comment,
                activeSolutionTopic.group_id === note.topicId,
              ]),
              label: makeSolutionFinalNoteNodeLabel(
                note,
                activeSolutionTopic.group_id === note.topicId,
                (event) => {
                  event.stopPropagation();
                  setSelectedSolutionTopicId(note.topicId);
                  setSelectedNodeId(`solution-${note.topicId}`);
                },
              ),
            },
          });
        });
      } else {
        rightDescriptors.push({
          id: "solution-empty::none",
          position: { x: 80, y: 80 },
          positionSource: "computed",
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: 420, minHeight: 180, padding: 0 },
          draggable: false,
          selectable: false,
          data: {
            contentSignature: "solution-empty",
            label: makeSolutionEmptyNodeLabel(),
          },
        });
      }

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          ...solutionTopics.map((topic) => topic.group_id),
          activeSolutionTopic?.group_id || "",
          solutionNoteDraft,
          solutionRightPaneWidth,
          isDesktopLayout,
        ]),
        nodeDescriptors: [
          ...solutionTopics.map((topic, index) => {
          const nodeId = `solution-${topic.group_id}`;
          const selected = selectedSolutionTopicId === topic.group_id;
          const positionSource: CanvasNodeDescriptor["positionSource"] = "computed";

          return {
            id: nodeId,
            position: positions[index],
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "imms-solution-canvas-node !border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: 360, minHeight: heights[index], borderRadius: 22, padding: 0 },
            data: {
              contentSignature: buildNodeContentSignature([
                topic.group_id,
                topic.topic_no,
                topic.topic,
                topic.conclusion,
                topic.status,
                selected,
                topic.problem_topic,
                topic.problem_insight,
                topic.problem_conclusion,
                ...(topic.problem_keywords || []),
                ...(topic.agenda_titles || []),
                ...(topic.ai_suggestions || []).flatMap((item) => [item.id, item.text, item.status]),
                ...(topic.notes || []).flatMap((note) => [
                  note.id,
                  note.text,
                  note.source,
                  note.source_ai_id,
                  note.is_final_candidate,
                  note.final_comment,
                ]),
              ]),
              label: makeSolutionNodeLabel(topic, selected),
            },
          };
          }),
          ...rightDescriptors,
        ],
      };
    }

    if (stage === "ideation") {
      const selectedAgendaForIdeation = selectedAgendaId || agendaModels[0]?.id || "";
      const canvasItemById = new Map(canvasItems.map((item) => [item.id, item]));
      const canvasItemHeights = new Map(canvasItems.map((item) => [item.id, estimateCanvasItemNodeHeight(item)]));
      const originalOrder = new Map(canvasItems.map((item, index) => [item.id, index]));
      const sortByCanvasOrder = (items: CanvasItemViewModel[]) =>
        [...items].sort((left, right) => (originalOrder.get(left.id) || 0) - (originalOrder.get(right.id) || 0));
      const selectedRootId = selectedCanvasItemId
        ? getCanvasItemTopLevelAncestorId(canvasItems, selectedCanvasItemId)
        : "";
      const selectedRootCandidate = selectedRootId ? canvasItemById.get(selectedRootId) || null : null;
      const activeRootItem =
        selectedRootCandidate?.agenda_id === selectedAgendaForIdeation
          ? selectedRootCandidate
          : null;
      const topLevelItems = sortByCanvasOrder(
        canvasItems.filter(
          (item) => item.agenda_id === selectedAgendaForIdeation && !item.parent_topic_id,
        ),
      );
      const descendantIdsByItem = new Map(
        topLevelItems.map((item) => [item.id, getCanvasItemDescendantIds(canvasItems, item.id)] as const),
      );
      const activeDescendantItems = activeRootItem
        ? (descendantIdsByItem.get(activeRootItem.id) || getCanvasItemDescendantIds(canvasItems, activeRootItem.id))
            .map((itemId) => canvasItemById.get(itemId))
            .filter((item): item is CanvasItemViewModel => Boolean(item))
        : [];
      const selectedAgendaModel = agendaModels.find((agenda) => agenda.id === selectedAgendaForIdeation) || agendaModels[0] || null;
      const leftHeights = topLevelItems.map((item) => {
        const descendantCount = descendantIdsByItem.get(item.id)?.length || 0;
        return Math.max(190, 156 + Math.min(descendantCount, 3) * 24 + (descendantCount > 3 ? 18 : 0));
      });
      const leftPositions: Array<{ x: number; y: number }> = [];
      let nextLeftY = CANVAS_IDEATION_FRAME_Y + CANVAS_IDEATION_HEADER_HEIGHT;
      leftHeights.forEach((height) => {
        leftPositions.push({
          x: CANVAS_IDEATION_LEFT_X + 24,
          y: nextLeftY,
        });
        nextLeftY += height + CANVAS_IDEATION_GROUP_GAP_Y;
      });

      const rightUsesGroupSelector = !activeRootItem;
      const agendaHeights = agendaModels.map((agenda) =>
        estimateAgendaNodeHeight(
          agenda.title,
          stripLeadingTimestamp(agenda.summaryBullets[0] || "요약이 아직 없습니다."),
          agenda.keywords.length,
        ),
      );
      const rightItemHeights = rightUsesGroupSelector
        ? agendaHeights
        : activeDescendantItems.map((item) => canvasItemHeights.get(item.id) || estimateCanvasItemNodeHeight(item));
      const rightPositions = buildGridPositions(
        rightItemHeights,
        CANVAS_ITEM_NODE_WIDTH + CANVAS_IDEATION_DETAIL_GAP_X,
        CANVAS_IDEATION_DETAIL_GAP_Y,
        CANVAS_IDEATION_RIGHT_X + 28,
        CANVAS_IDEATION_FRAME_Y + CANVAS_IDEATION_HEADER_HEIGHT,
      );
      const leftBottom = leftPositions.reduce(
        (maxBottom, position, index) => Math.max(maxBottom, position.y + (leftHeights[index] || 0)),
        CANVAS_IDEATION_FRAME_Y + CANVAS_IDEATION_HEADER_HEIGHT + 180,
      );
      const rightBottom = rightPositions.reduce(
        (maxBottom, position, index) => Math.max(maxBottom, position.y + (rightItemHeights[index] || 0)),
        CANVAS_IDEATION_FRAME_Y + CANVAS_IDEATION_HEADER_HEIGHT + 220,
      );
      const frameHeight = Math.max(640, leftBottom, rightBottom) - CANVAS_IDEATION_FRAME_Y + 56;
      const frameDescriptors: CanvasNodeDescriptor[] = [
        {
          id: "ideation-left-frame",
          position: { x: CANVAS_IDEATION_LEFT_X, y: CANVAS_IDEATION_FRAME_Y },
          positionSource: "computed",
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          className: "pointer-events-none !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: CANVAS_IDEATION_LEFT_WIDTH, height: frameHeight, padding: 0 },
          draggable: false,
          selectable: false,
          zIndex: 0,
          data: {
            contentSignature: buildNodeContentSignature([
              "ideation-left-frame",
              selectedAgendaForIdeation,
              topLevelItems.length,
              frameHeight,
            ]),
            label: makeIdeationFrameLabel(
              "Group Canvas",
              selectedAgendaModel
                ? `${selectedAgendaModel.title}의 1차 그룹`
                : "그룹분류를 선택해 주세요.",
              `${topLevelItems.length}개`,
            ),
          },
        },
        {
          id: "ideation-right-frame",
          position: { x: CANVAS_IDEATION_RIGHT_X, y: CANVAS_IDEATION_FRAME_Y },
          positionSource: "computed",
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          className: "pointer-events-none !border-0 !bg-transparent !p-0 !shadow-none",
          style: { width: CANVAS_IDEATION_RIGHT_WIDTH, height: frameHeight, padding: 0 },
          draggable: false,
          selectable: false,
          zIndex: 0,
          data: {
            contentSignature: buildNodeContentSignature([
              "ideation-right-frame",
              activeRootItem?.id || "agenda-selector",
              rightUsesGroupSelector,
              activeDescendantItems.length,
              frameHeight,
            ]),
            label: makeIdeationFrameLabel(
              rightUsesGroupSelector ? "Group Selector" : "Detail Canvas",
              rightUsesGroupSelector
                ? "빈공간에서는 그룹분류를 선택합니다."
                : `${activeRootItem?.title || "선택 그룹"} 하위 내용을 전체 펼침으로 표시합니다.`,
              rightUsesGroupSelector ? `${agendaModels.length}개 분류` : `${activeDescendantItems.length}개`,
            ),
          },
        },
      ];
      const leftGroupDescriptors: CanvasNodeDescriptor[] = topLevelItems.map((item, index) => {
        const descendantIds = descendantIdsByItem.get(item.id) || [];
        const childItems = descendantIds
          .slice(0, 3)
          .map((itemId) => canvasItemById.get(itemId))
          .filter((child): child is CanvasItemViewModel => Boolean(child));
        const highlighted =
          focusedCanvasItemId === item.id ||
          (isTopicCanvasItem(item) && latestHighlightedTopicId === item.id);
        const dropTarget =
          Boolean(ideationDropPreview) &&
          ideationDropPreview?.targetId === item.id &&
          ideationDropPreview.mode !== "detach";
        const dropTargetLabel =
          dropTarget && ideationDropPreview?.mode === "topic"
            ? "이 토픽으로 이동"
            : dropTarget
            ? ideationDropPreview?.label || "여기로 이동"
            : "";
        const dropTargetHint =
          dropTarget && ideationDropPreview?.mode === "topic"
            ? "마우스를 놓으면 이 토픽의 오른쪽 상세 캔버스로 이동합니다."
            : dropTarget
            ? ideationDropPreview?.hint || ""
            : "";

        return {
          id: `canvas-item-${item.id}`,
          position: leftPositions[index],
          positionSource: "computed",
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          className: "nopan imms-canvas-node-drag-handle !border-0 !bg-transparent !p-0 !shadow-none",
          style: {
            width: CANVAS_IDEATION_LEFT_WIDTH - 48,
            height: leftHeights[index],
            background: "transparent",
            border: "none",
            boxShadow: "none",
            padding: 0,
          },
          draggable: true,
          dragHandle: ".imms-canvas-node-drag-handle",
          zIndex: 2,
          data: {
            contentSignature: buildNodeContentSignature([
              "ideation-left-group",
              item.id,
              item.kind,
              item.status || "",
              item.title,
              item.body,
              item.ai_pending,
              activeRootItem?.id === item.id,
              highlighted,
              dropTarget,
              ...descendantIds,
              ...childItems.map((child) => child.title),
            ]),
            label: makeIdeationGroupNodeLabel(
              item,
              activeRootItem?.id === item.id,
              childItems,
              descendantIds.length,
              highlighted,
              dropTarget,
              dropTargetLabel,
              dropTargetHint,
            ),
          },
        };
      });
      const rightDetailDescriptors: CanvasNodeDescriptor[] = rightUsesGroupSelector
        ? agendaModels.map((agenda, index) => ({
            id: `agenda-${agenda.id}`,
            position: rightPositions[index],
            positionSource: "computed" as const,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "rounded-[28px] border border-amber-200 bg-white shadow-[0_18px_40px_rgba(148,163,184,0.16)]",
            style: { width: 300, minHeight: agendaHeights[index], borderRadius: 28, padding: 0 },
            draggable: false,
            zIndex: 2,
            data: {
              contentSignature: buildNodeContentSignature([
                "ideation-agenda-selector",
                agenda.id,
                agenda.title,
                agenda.status,
                selectedAgendaForIdeation === agenda.id,
                ...(agenda.keywords || []),
                ...(agenda.summaryBullets || []),
              ]),
              label: makeAgendaNodeLabel(
                agenda.title,
                stripLeadingTimestamp(agenda.summaryBullets[0] || "요약이 아직 없습니다."),
                selectedAgendaForIdeation === agenda.id ? "SELECTED" : agenda.status,
                agenda.keywords || [],
              ),
            },
          }))
        : activeDescendantItems.length > 0
          ? activeDescendantItems.map((item, index) => {
              const nodeId = `canvas-item-${item.id}`;
              const linkedAgendaTitle =
                agendaModels.find((agenda) => agenda.id === item.agenda_id)?.title || "";
              const itemHeight = canvasItemHeights.get(item.id) || estimateCanvasItemNodeHeight(item);
              const depth = getCanvasItemDepth(canvasItems, item.id);

              return {
                id: nodeId,
                position: {
                  x: rightPositions[index].x + Math.min(depth, 3) * 18,
                  y: rightPositions[index].y,
                },
                positionSource: "computed" as const,
                sourcePosition: Position.Bottom,
                targetPosition: Position.Top,
                className: "nopan imms-canvas-node-drag-handle !border-0 !bg-transparent !p-0 !shadow-none",
                style: {
                  width: CANVAS_ITEM_NODE_WIDTH,
                  height: itemHeight,
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  padding: 0,
                },
                draggable: true,
                dragHandle: ".imms-canvas-node-drag-handle",
                zIndex: 2,
                data: {
                  contentSignature: buildNodeContentSignature([
                    "ideation-detail-item",
                    item.id,
                    item.kind,
                    item.status || "",
                    item.title,
                    item.body,
                    ...(item.keywords || []),
                    item.agenda_id,
                    item.point_id,
                    item.parent_topic_id || "",
                    depth,
                    selectedCanvasItemId === item.id,
                    ...(item.child_item_ids || []),
                  ]),
                  label: makeCanvasItemNodeLabel(
                    item,
                    selectedCanvasItemId === item.id,
                    linkedAgendaTitle,
                    handleToggleTopicCollapsed,
                    isTopicCanvasItem(item) && latestHighlightedTopicId === item.id,
                  ),
                },
              };
            })
          : [
              {
                id: "ideation-empty-detail",
                position: {
                  x: CANVAS_IDEATION_RIGHT_X + 110,
                  y: CANVAS_IDEATION_FRAME_Y + CANVAS_IDEATION_HEADER_HEIGHT + 60,
                },
                positionSource: "computed" as const,
                sourcePosition: Position.Bottom,
                targetPosition: Position.Top,
                className: "!border-0 !bg-transparent !p-0 !shadow-none",
                style: { width: 420, minHeight: 180, padding: 0 },
                draggable: false,
                selectable: false,
                zIndex: 2,
                data: {
                  contentSignature: buildNodeContentSignature([
                    "ideation-empty-detail",
                    activeRootItem?.id || "",
                    activeRootItem?.title || "",
                  ]),
                  label: makeIdeationEmptyDetailLabel(
                    "아직 하위 내용이 없습니다.",
                    "오른쪽 캔버스에 메모/댓글을 추가하거나 STT로 생성된 아이디어가 병합되면 이 영역에 표시됩니다.",
                  ),
                },
              },
            ];

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          selectedAgendaForIdeation,
          activeRootItem?.id || "",
          ...agendaModels.map((agenda) => agenda.id),
          ...canvasItems.flatMap((item) => [
            item.id,
            item.kind,
            item.status || "",
            item.parent_topic_id || "",
            item.agenda_id || "",
            ...(item.child_item_ids || []),
          ]),
        ]),
        nodeDescriptors: [
          ...frameDescriptors,
          ...leftGroupDescriptors,
          ...rightDetailDescriptors,
          ...(ideationDropPreview
            ? [
                {
                  id: "ideation-drop-placeholder",
                  position: ideationDropPreview.position,
                  positionSource: "computed" as const,
                  sourcePosition: Position.Right,
                  targetPosition: Position.Left,
                  className: "imms-ideation-drop-placeholder pointer-events-none !border-0 !bg-transparent !p-0 !shadow-none",
                  style: {
                    width: CANVAS_ITEM_NODE_WIDTH,
                    height: 158,
                    background: "transparent",
                    border: "none",
                    boxShadow: "none",
                    padding: 0,
                  },
                  draggable: false,
                  selectable: false,
                  zIndex: 3,
                  data: {
                    contentSignature: buildNodeContentSignature([
                      "ideation-drop-placeholder",
                      ideationDropPreview.draggedItemId,
                      ideationDropPreview.targetId,
                      ideationDropPreview.mode,
                      ideationDropPreview.agendaId,
                      ideationDropPreview.position.x,
                      ideationDropPreview.position.y,
                    ]),
                    label: (
                      <div className="flex h-full min-h-[158px] flex-col items-center justify-center rounded-[18px] border-2 border-dashed border-[#1b59f8]/55 bg-[#eef4ff]/80 px-5 py-4 text-center shadow-[inset_0_0_0_5px_rgba(27,89,248,0.08),0_16px_34px_rgba(27,89,248,0.12)]">
                        <p className="text-[15px] font-semibold text-[#1b59f8]">{ideationDropPreview.label}</p>
                        <p className="mt-2 text-[13px] leading-5 text-[#4d4d4d]">{ideationDropPreview.hint}</p>
                      </div>
                    ),
                  },
                },
              ]
            : []),
        ],
      };
    }

    const agendaHeights = agendaModels.map((agenda) =>
      estimateAgendaNodeHeight(
        agenda.title,
        stripLeadingTimestamp(agenda.summaryBullets[0] || "요약이 아직 없습니다."),
        agenda.keywords.length,
      ),
    );
    const canvasItemById = new Map(canvasItems.map((item) => [item.id, item]));
    const canvasItemHeights = new Map(canvasItems.map((item) => [item.id, estimateCanvasItemNodeHeight(item)]));
    const topicById = new Map(canvasItems.filter(isTopicCanvasItem).map((item) => [item.id, item]));
    const childIdsByTopic = new Map<string, string[]>();
    canvasItems.forEach((item) => {
      if (item.parent_topic_id) {
        const current = childIdsByTopic.get(item.parent_topic_id) || [];
        if (!current.includes(item.id)) current.push(item.id);
        childIdsByTopic.set(item.parent_topic_id, current);
      }
    });
    topicById.forEach((topic) => {
      const explicitIds = (topic.child_item_ids || []).filter(Boolean);
      const derivedIds = childIdsByTopic.get(topic.id) || [];
      childIdsByTopic.set(topic.id, [...new Set([...explicitIds, ...derivedIds])]);
    });
    const visibleCanvasItems = canvasItems.filter((item) => {
      if (!item.parent_topic_id) return true;
      const parentTopic = topicById.get(item.parent_topic_id);
      return Boolean(parentTopic && !getTopicCollapsed(parentTopic));
    });

    const sortAgendaLaneItems = (items: CanvasItemViewModel[]) => {
      const originalOrder = new Map(canvasItems.map((item, index) => [item.id, index]));
      return [...items].sort((left, right) => {
        const leftTopic = isTopicCanvasItem(left) ? 0 : 1;
        const rightTopic = isTopicCanvasItem(right) ? 0 : 1;
        if (leftTopic !== rightTopic) return leftTopic - rightTopic;
        return (originalOrder.get(left.id) || 0) - (originalOrder.get(right.id) || 0);
      });
    };

    const getAgendaTopLevelItems = (agendaId: string) =>
      sortAgendaLaneItems(canvasItems.filter((item) => item.agenda_id === agendaId && !item.parent_topic_id));

    const getTopicChildItems = (topicId: string) =>
      (childIdsByTopic.get(topicId) || [])
        .map((childId) => canvasItemById.get(childId))
        .filter((item): item is CanvasItemViewModel => Boolean(item));

    const estimateTopicChildLaneHeight = (topic: CanvasItemViewModel) => {
      if (getTopicCollapsed(topic)) return 0;

      const childItems = getTopicChildItems(topic.id);
      if (childItems.length === 0) return 0;

      const rowHeights: number[] = [];
      childItems.forEach((child, index) => {
        const row = Math.floor(index / CANVAS_TOPIC_CHILDS_PER_ROW);
        rowHeights[row] = Math.max(
          rowHeights[row] || 0,
          canvasItemHeights.get(child.id) || estimateCanvasItemNodeHeight(child),
        );
      });

      return rowHeights.reduce(
        (sum, height, index) => sum + height + (index === 0 ? 0 : CANVAS_TOPIC_CHILD_GAP_Y),
        0,
      );
    };

    const agendaBlockHeights = agendaModels.map((agenda, agendaIndex) => {
      const topLevelItems = getAgendaTopLevelItems(agenda.id);
      if (topLevelItems.length === 0) return agendaHeights[agendaIndex];

      const itemStackHeight = topLevelItems.reduce((sum, item, itemIndex) => {
        const itemHeight = canvasItemHeights.get(item.id) || estimateCanvasItemNodeHeight(item);
        const childChainHeight = isTopicCanvasItem(item) ? estimateTopicChildLaneHeight(item) : 0;
        const rowHeight = Math.max(itemHeight, childChainHeight);
        const gap = itemIndex === 0 ? 0 : CANVAS_TOP_LEVEL_GAP_Y;
        return sum + gap + rowHeight;
      }, 0);

      return agendaHeights[agendaIndex] + CANVAS_AGENDA_TO_ITEMS_GAP_Y + itemStackHeight;
    });
    const positions = buildGridPositions(
      agendaBlockHeights,
      CANVAS_AGENDA_BLOCK_GAP_X,
      CANVAS_AGENDA_BLOCK_GAP_Y,
      120,
      80,
    );
    const agendaPositionById = new Map(
      agendaModels.map((agenda, agendaIndex) => {
        const nodeId = `agenda-${agenda.id}`;
        return [
          agenda.id,
          nodePositions.ideation?.[nodeId] || positions[agendaIndex],
        ] as const;
      }),
    );
    const computedCanvasPositions = new Map<string, { x: number; y: number }>();
    agendaModels.forEach((agenda, agendaIndex) => {
      const agendaPosition = agendaPositionById.get(agenda.id) || positions[agendaIndex];
      const topLevelItems = getAgendaTopLevelItems(agenda.id);
      let nextTopY = agendaPosition.y + agendaHeights[agendaIndex] + CANVAS_AGENDA_TO_ITEMS_GAP_Y;

      topLevelItems.forEach((item) => {
        const itemHeight = canvasItemHeights.get(item.id) || estimateCanvasItemNodeHeight(item);
        const topPosition = {
          x: agendaPosition.x + 20,
          y: nextTopY,
        };
        computedCanvasPositions.set(item.id, topPosition);

        let childChainHeight = 0;
        if (isTopicCanvasItem(item) && !getTopicCollapsed(item)) {
          const childItems = getTopicChildItems(item.id);
          const childRowHeights: number[] = [];
          let childBaseY = topPosition.y;

          childItems.forEach((child, childIndex) => {
            const childHeight = canvasItemHeights.get(child.id) || estimateCanvasItemNodeHeight(child);
            const row = Math.floor(childIndex / CANVAS_TOPIC_CHILDS_PER_ROW);
            const column = childIndex % CANVAS_TOPIC_CHILDS_PER_ROW;
            if (column === 0 && row > 0) {
              childBaseY += (childRowHeights[row - 1] || childHeight) + CANVAS_TOPIC_CHILD_GAP_Y;
            }
            const computedChildPosition = {
              x: topPosition.x + CANVAS_ITEM_NODE_WIDTH + CANVAS_TOPIC_CHILD_GAP_X + column * (CANVAS_ITEM_NODE_WIDTH + CANVAS_TOPIC_CHILD_GAP_X),
              y: childBaseY,
            };
            computedCanvasPositions.set(child.id, computedChildPosition);
            childRowHeights[row] = Math.max(childRowHeights[row] || 0, childHeight);
            childChainHeight = Math.max(
              childChainHeight,
              childBaseY - topPosition.y + childHeight,
            );
          });
        }

        const rowHeight = Math.max(itemHeight, childChainHeight);
        nextTopY = Math.max(nextTopY, topPosition.y + rowHeight + CANVAS_TOP_LEVEL_GAP_Y);
      });
    });

    return {
      layoutSignature: buildNodeContentSignature([
        stage,
        ...agendaModels.map((agenda) => agenda.id),
        ...canvasItems.flatMap((item) => [
          item.id,
          item.kind,
          item.status || "",
          item.parent_topic_id || "",
          isTopicCanvasItem(item) && getTopicCollapsed(item) ? "collapsed" : "expanded",
          ...(item.child_item_ids || []),
        ]),
      ]),
      nodeDescriptors: [
        ...agendaModels.map((agenda, agendaIndex) => {
          const nodeId = `agenda-${agenda.id}`;
          const savedPosition = nodePositions.ideation?.[nodeId];
          const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition
            ? "persisted"
            : "fallback";
          const isAgendaDragSource = agendaDragPreview?.agendaId === agenda.id;

          return {
            id: nodeId,
            position: savedPosition || positions[agendaIndex],
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: `imms-agenda-node rounded-[28px] border border-amber-200 bg-white shadow-[0_18px_40px_rgba(148,163,184,0.16)] ${isAgendaDragSource ? "z-20" : ""}`,
            style: { width: 300, minHeight: agendaHeights[agendaIndex], borderRadius: 28, padding: 0 },
            data: {
              contentSignature: buildNodeContentSignature([
                agenda.id,
                agenda.title,
                agenda.status,
                ...(agenda.keywords || []),
                ...(agenda.summaryBullets || []),
              ]),
              label: makeAgendaNodeLabel(
                agenda.title,
                stripLeadingTimestamp(agenda.summaryBullets[0] || "요약이 아직 없습니다."),
                agenda.status,
                agenda.keywords || [],
              ),
            },
          };
        }),
        ...(agendaDragPreview
          ? agendaModels
              .filter((agenda) => agenda.id === agendaDragPreview.agendaId)
              .map((agenda) => {
                const agendaIndex = agendaModels.findIndex((candidate) => candidate.id === agenda.id);
                const agendaHeight = agendaHeights[Math.max(0, agendaIndex)] || 160;
                return {
                  id: `agenda-drag-placeholder-${agenda.id}`,
                  position: agendaDragPreview.originPosition,
                  positionSource: "persisted" as const,
                  sourcePosition: Position.Bottom,
                  targetPosition: Position.Top,
                  className: "imms-agenda-drag-placeholder rounded-[28px] border border-dashed border-blue-300 bg-blue-50/70 shadow-[0_18px_40px_rgba(37,99,235,0.10)]",
                  style: { width: 300, minHeight: agendaHeight, borderRadius: 28, padding: 0 },
                  draggable: false,
                  selectable: false,
                  zIndex: 0,
                  data: {
                    contentSignature: buildNodeContentSignature([
                      "agenda-placeholder",
                      agenda.id,
                      agenda.title,
                      agendaDragPreview.originPosition.x,
                      agendaDragPreview.originPosition.y,
                    ]),
                    label: (
                      <div className="p-5">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600">
                          기존 위치
                        </p>
                        <p className="mt-2 text-lg font-semibold leading-7 text-slate-800">{agenda.title}</p>
                        <p className="mt-2 text-sm leading-6 text-slate-500">
                          드롭하면 아래 콘텐츠와 함께 이동합니다.
                        </p>
                      </div>
                    ),
                  },
                };
              })
          : []),
        ...(ideationDropPreview
          ? [
              {
                id: "ideation-drop-placeholder",
                position: ideationDropPreview.position,
                positionSource: "computed" as const,
                sourcePosition: Position.Right,
                targetPosition: Position.Left,
                className: "imms-ideation-drop-placeholder pointer-events-none !border-0 !bg-transparent !p-0 !shadow-none",
                style: {
                  width: CANVAS_ITEM_NODE_WIDTH,
                  height: 158,
                  background: "transparent",
                  border: "none",
                  boxShadow: "none",
                  padding: 0,
                },
                draggable: false,
                selectable: false,
                zIndex: 1,
                data: {
                  contentSignature: buildNodeContentSignature([
                    "ideation-drop-placeholder",
                    ideationDropPreview.draggedItemId,
                    ideationDropPreview.targetId,
                    ideationDropPreview.mode,
                    ideationDropPreview.agendaId,
                    ideationDropPreview.position.x,
                    ideationDropPreview.position.y,
                  ]),
                  label: (
                    <div className="flex h-full min-h-[158px] flex-col items-center justify-center rounded-[18px] border-2 border-dashed border-[#1b59f8]/55 bg-[#eef4ff]/80 px-5 py-4 text-center shadow-[inset_0_0_0_5px_rgba(27,89,248,0.08),0_16px_34px_rgba(27,89,248,0.12)]">
                      <p className="text-[15px] font-semibold text-[#1b59f8]">{ideationDropPreview.label}</p>
                      <p className="mt-2 text-[13px] leading-5 text-[#4d4d4d]">{ideationDropPreview.hint}</p>
                    </div>
                  ),
                },
              },
            ]
          : []),
        ...visibleCanvasItems.map((item, index) => {
          const nodeId = `canvas-item-${item.id}`;
          const displayItem =
            isTopicCanvasItem(item)
              ? {
                  ...item,
                  topic_collapsed: getTopicCollapsed(item),
                }
              : item;
          const highlighted =
            focusedCanvasItemId === item.id ||
            (isTopicCanvasItem(item) && latestHighlightedTopicId === item.id);
          const computedPosition = computedCanvasPositions.get(item.id);
          const preferredPosition = computedPosition;
          const positionSource: CanvasNodeDescriptor["positionSource"] =
            computedPosition ? "computed" : "fallback";
          const linkedAgendaTitle =
            agendaModels.find((agenda) => agenda.id === item.agenda_id)?.title || "";
          const itemHeight = canvasItemHeights.get(item.id) || estimateCanvasItemNodeHeight(item);
          const fallbackPosition = {
            x: 180 + ((index % 3) * (CANVAS_ITEM_NODE_WIDTH + 36)),
            y: 320 + Math.floor(index / 3) * (itemHeight + CANVAS_TOP_LEVEL_GAP_Y),
          };

          return {
            id: nodeId,
            position: preferredPosition || fallbackPosition,
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "nopan imms-canvas-node-drag-handle !border-0 !bg-transparent !p-0 !shadow-none",
            style: {
              width: CANVAS_ITEM_NODE_WIDTH,
              height: itemHeight,
              background: "transparent",
              border: "none",
              boxShadow: "none",
              padding: 0,
            },
            data: {
              contentSignature: buildNodeContentSignature([
                item.id,
                item.kind,
                item.status || "",
                item.title,
                item.body,
                ...(item.keywords || []),
                item.agenda_id,
                item.point_id,
                item.parent_topic_id || "",
                isTopicCanvasItem(item) && getTopicCollapsed(item) ? "collapsed" : "expanded",
                highlighted,
                ...(item.child_item_ids || []),
                selectedCanvasItemId === item.id,
              ]),
              label: makeCanvasItemNodeLabel(
                displayItem,
                selectedCanvasItemId === item.id,
                linkedAgendaTitle,
                handleToggleTopicCollapsed,
                highlighted,
              ),
            },
          };
        }),
      ],
    };
  }, [
    stage,
    agendaModels,
    agendaDragPreview,
    canvasItems,
    dropProblemGroupId,
    focusedCanvasItemId,
    getTopicCollapsed,
    handleGenerateSolutionSuggestions,
    handleCancelSolutionNoteEdit,
    handlePruneSolutionSuggestions,
    handleSaveSolutionNoteEdit,
    handleStartSolutionNoteEdit,
    handleToggleTopicCollapsed,
    handleAttachPersonalNoteToProblemGroup,
    handleProblemIdeaDragEnd,
    handleProblemIdeaDragMove,
    handleProblemIdeaPointerDown,
    handleProblemIdeaDragOver,
    handleProblemIdeaDragStart,
    handleProblemIdeaDrop,
    ideationDropPreview,
    latestHighlightedTopicId,
    loadingProblemGroupIds,
    nodePositions,
    persistedSharedImportedState,
    problemGroups,
    problemIdeaDrag,
    problemIdeaDropPreview,
    selectedAgendaId,
    selectedCanvasItemId,
    selectedNodeId,
    selectedProblemGroupId,
    selectedProblemSourceNodeId,
    selectedSolutionTopicId,
    editingSolutionNoteKey,
    solutionNoteDraft,
    solutionNoteFinalCommentDraft,
    solutionNoteTextDraft,
    solutionRightPaneWidth,
    solutionSuggestionBusyTopicId,
    solutionTopics,
    isDesktopLayout,
  ]);

  useEffect(() => {
    if (!workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }

    const stageKey = stage;
    setNodePositions((prev) => {
      const currentStagePositions = prev[stageKey] || {};
      const validNodeIds = new Set(graphBlueprint.nodeDescriptors.map((descriptor) => descriptor.id));
      const nextStageEntries = Object.entries(currentStagePositions).filter(
        ([nodeId]) => validNodeIds.has(nodeId) && (stageKey !== "ideation" || nodeId.startsWith("agenda-")),
      );

      if (nextStageEntries.length === Object.keys(currentStagePositions).length) {
        return prev;
      }

      return normalizeCanvasNodePositionsForComputedIdeation({
        ...prev,
        [stageKey]: Object.fromEntries(nextStageEntries),
      });
    });
  }, [graphBlueprint.layoutSignature, graphBlueprint.nodeDescriptors, stage]);

  useEffect(() => {
    CANVAS_STAGES.forEach((stageKey) => {
      Object.keys(nodePositions[stageKey] || {}).forEach((nodeId) => {
        delete pendingNodePlacementsRef.current[nodeId];
      });
    });
  }, [nodePositions]);

  useEffect(() => {
    const activeDragNodeId = stableIdeationDragRef.current?.nodeId || "";
    const preserveNodeIds = activeDragNodeId ? new Set([activeDragNodeId]) : new Set<string>();
    setNodes((current) =>
      reconcileNodes(current, graphBlueprint.nodeDescriptors, preserveNodeIds),
    );
    setEdges((current) => {
      const validNodeIds = new Set(graphBlueprint.nodeDescriptors.map((node) => node.id));
      const nextEdges = current.filter(
        (edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target),
      );
      return nextEdges.length === current.length ? current : nextEdges;
    });
  }, [graphBlueprint]);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      if (!resizeStateRef.current) return;

      const viewportWidth = Math.max(window.innerWidth, 1);
      const deltaRatio = (event.clientX - resizeStateRef.current.startX) / viewportWidth;
      if (resizeStateRef.current.side === "left") {
        const nextRatio = clampNumber(
          resizeStateRef.current.startRatio + deltaRatio,
          MIN_LEFT_PANEL_RATIO,
          MAX_LEFT_PANEL_RATIO,
        );
        setLeftPanelRatio(nextRatio);
        return;
      }

      const nextRatio = clampNumber(
        resizeStateRef.current.startRatio - deltaRatio,
        MIN_RIGHT_PANEL_RATIO,
        MAX_RIGHT_PANEL_RATIO,
      );
      setRightPanelRatio(nextRatio);
    };

    const handlePointerUp = () => {
      resizeStateRef.current = null;
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, []);

  const selectedNode = useMemo(() => nodes.find((item) => item.id === selectedNodeId) || null, [nodes, selectedNodeId]);
  const selectedAgenda = useMemo(
    () => agendaModels.find((agenda) => agenda.id === selectedAgendaId) || agendaModels[0] || null,
    [agendaModels, selectedAgendaId],
  );
  const selectedCanvasItem = useMemo(
    () => canvasItems.find((item) => item.id === selectedCanvasItemId) || null,
    [canvasItems, selectedCanvasItemId],
  );
  const projectPersonalNotes = useMemo(
    () => personalNotes.filter((note) => !note.projectId || note.projectId === meetingId),
    [meetingId, personalNotes],
  );
  const autoLinkEdges = useMemo<Edge[]>(() => {
    return [];
  }, []);
  const displayEdges = useMemo<Edge[]>(() => {
    return [];
  }, []);
  const selectedEdge = useMemo(
    () => displayEdges.find((edge) => edge.id === selectedEdgeId) || null,
    [displayEdges, selectedEdgeId],
  );
  const renderedEdges = useMemo<Edge[]>(
    () =>
      displayEdges.map((edge): Edge => {
        const isSelected = edge.id === selectedEdgeId;
        return {
          ...edge,
          selected: isSelected,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isSelected ? "#0f172a" : "#475569",
          },
          interactionWidth: isSelected ? 36 : 28,
          zIndex: isSelected ? 20 : 10,
          style: {
            ...(edge.style || {}),
            stroke: isSelected ? "#0f172a" : edge.style?.stroke || "#475569",
            strokeOpacity: 0.95,
            strokeWidth: isSelected ? 3 : edge.style?.strokeWidth || 2,
          } as React.CSSProperties,
        };
      }),
    [displayEdges, selectedEdgeId],
  );
  useEffect(() => {
    if (!selectedEdgeId) return;
    if (!displayEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId("");
    }
  }, [displayEdges, selectedEdgeId]);
  const selectedProblemGroup = useMemo(
    () => problemGroups.find((group) => group.group_id === selectedProblemGroupId) || problemGroups[0] || null,
    [problemGroups, selectedProblemGroupId],
  );
  const selectedProblemSourceCards = useMemo(
    () => (selectedProblemGroup ? buildProblemGroupDisplayCards(selectedProblemGroup).filter((card) => card.attachable) : []),
    [selectedProblemGroup],
  );
  const selectedProblemSourceCard = useMemo(
    () => selectedProblemSourceCards.find((card) => card.sourceNodeId === selectedProblemSourceNodeId) || null,
    [selectedProblemSourceCards, selectedProblemSourceNodeId],
  );
  const selectedProblemSourceOpinions = useMemo(
    () =>
      selectedProblemGroup && selectedProblemSourceCard
        ? (selectedProblemGroup.discussion_items || []).filter(
            (item) => item.target_node_id === selectedProblemSourceCard.sourceNodeId,
          )
        : [],
    [selectedProblemGroup, selectedProblemSourceCard],
  );
  const selectedSolutionTopic = useMemo(
    () => solutionTopics.find((topic) => topic.group_id === selectedSolutionTopicId) || solutionTopics[0] || null,
    [selectedSolutionTopicId, solutionTopics],
  );
  const finalSolutionSummary = useMemo(
    () => buildFinalSolutionSummaryPayload(solutionTopics),
    [solutionTopics],
  );
  const allSolutionFinalNotes = useMemo(
    () =>
      solutionTopics.flatMap((topic) =>
        topic.notes
          .filter((note) => note.is_final_candidate)
          .map((note) => ({
            ...note,
            topicId: topic.group_id,
            topicTitle: topic.topic,
          })),
      ),
    [solutionTopics],
  );
  const isEditingSelectedProblemGroup =
    stage === "problem-definition" &&
    Boolean(selectedProblemGroup) &&
    editingProblemGroupId === selectedProblemGroup?.group_id;
  const isEditingSelectedAgenda =
    stage === "ideation" &&
    Boolean(selectedAgenda) &&
    editingAgendaId === selectedAgenda?.id;
  const isEditingSelectedCanvasItem =
    stage === "ideation" &&
    Boolean(selectedCanvasItem) &&
    editingCanvasItemId === selectedCanvasItem?.id;
  const isEditingSelectedSolutionTopic =
    stage === "solution" &&
    Boolean(selectedSolutionTopic) &&
    editingSolutionTopicId === selectedSolutionTopic?.group_id;

  useEffect(() => {
    if (stage !== "problem-definition" || !selectedProblemGroup) {
      if (selectedProblemSourceNodeId) {
        setSelectedProblemSourceNodeId("");
      }
      return;
    }

    if (!selectedProblemSourceNodeId) {
      return;
    }

    if (!selectedProblemSourceCards.some((card) => card.sourceNodeId === selectedProblemSourceNodeId)) {
      setSelectedProblemSourceNodeId("");
    }
  }, [selectedProblemGroup, selectedProblemSourceCards, selectedProblemSourceNodeId, stage]);

  useEffect(() => {
    if (!focusedCanvasItemId) return;
    const timeoutId = window.setTimeout(() => {
      setFocusedCanvasItemId("");
    }, 4200);

    return () => window.clearTimeout(timeoutId);
  }, [focusedCanvasItemId]);

  const leftPanelDetail = useMemo(() => {
    if (stage === "problem-definition") {
      const selectedGroup = selectedProblemGroup;
      if (!selectedGroup) return null;

      return {
        title: selectedGroup.topic,
        subtitle: "문제 정의 그룹",
        badges: [
          problemGroupStatusLabel(selectedGroup.status),
          `${selectedGroup.agenda_titles.length}개 안건`,
          `${selectedGroup.ideas.length}개 메모`,
          selectedGroup.insight_user_edited ? "Insight 수동 수정" : "",
          selectedGroup.conclusion_user_edited ? "결론 수동 수정" : "",
        ].filter(Boolean),
        insightLens: selectedGroup.insight_lens || "",
        keywords: (selectedGroup.keywords || []).slice(0, 3),
        summaryItems: [selectedGroup.conclusion, ...(selectedGroup.source_summary_items || []).slice(0, 2)]
          .filter(Boolean)
          .map((value, index) => ({
            label: index === 0 ? "결론" : `요약 ${index}`,
            value: stripLeadingTimestamp(value),
          })),
        organizeItems: [
          {
            label: "연결 안건",
            value: selectedGroup.agenda_titles.length > 0 ? selectedGroup.agenda_titles.join(", ") : "연결된 안건이 아직 없습니다.",
          },
          {
            label: "메모 수",
            value: `${selectedGroup.ideas.length}개`,
          },
          {
            label: "속한 의견",
            value: `${(selectedGroup.discussion_items || []).filter((item) => item.target_node_id).length}개`,
          },
        ],
        organizeTitle: "문제정의 정리",
        selectedSourceNode: selectedProblemSourceCard
          ? {
              id: selectedProblemSourceCard.sourceNodeId,
              label: selectedProblemSourceCard.title,
              kind: selectedProblemSourceCard.sourceNodeKind,
              body: selectedProblemSourceCard.body,
            }
          : null,
        sourceNodes: selectedProblemSourceCards.map((card) => ({
          id: card.sourceNodeId,
          label: card.title,
          kind: card.sourceNodeKind,
          body: card.body,
          opinionCount: (selectedGroup.discussion_items || []).filter((item) => item.target_node_id === card.sourceNodeId).length,
        })),
        attachedOpinions: selectedProblemSourceOpinions.map((item) => ({
          id: item.id,
          label: item.title || "의견",
          value: item.body || "의견 내용이 없습니다.",
          keywords: item.keywords || [],
          createdAt: item.created_at || "",
        })),
        floatingOpinions: (selectedGroup.discussion_items || [])
          .filter((item) => !item.target_node_id)
          .map((item) => ({
            id: item.id,
            label: item.title || "의견",
            value: item.body || "의견 내용이 없습니다.",
            keywords: item.keywords || [],
          })),
        evidenceItems: (selectedGroup.source_summary_items || []).filter(Boolean).map((value, index) => ({
          label: `근거 ${index + 1}`,
          value: stripLeadingTimestamp(value),
        })),
        noteItems: (selectedGroup.ideas || []).map((idea) => ({
          id: idea.id,
          label: idea.title || "메모",
          value: stripLeadingTimestamp(idea.body || ""),
          kind: idea.kind || "note",
        })),
        status: selectedGroup.status,
      };
    }

    if (stage === "solution") {
      const selectedTopic = selectedSolutionTopic;
      if (!selectedTopic) return null;

      return {
        title: selectedTopic.topic,
        subtitle: "해결책 그룹",
        badges: [
          problemGroupStatusLabel(selectedTopic.status),
          `주제 ${selectedTopic.topic_no}`,
          `AI 초안 ${selectedTopic.ai_suggestions.length}개`,
          `메모 ${selectedTopic.notes.length}개`,
        ],
        insightLens: "",
        keywords: (selectedTopic.problem_keywords || []).slice(0, 3),
        summaryItems: [selectedTopic.conclusion]
          .filter(Boolean)
          .map((value, index) => ({
            label: index === 0 ? "해결 방향" : `아이디어 ${index}`,
            value: stripLeadingTimestamp(value),
          })),
        organizeItems: [
          {
            label: "연결 문제정의",
            value: selectedTopic.problem_topic || "연결된 문제정의가 아직 없습니다.",
          },
          {
            label: "소결론",
            value: selectedTopic.problem_insight || "연결된 소결론이 아직 없습니다.",
          },
          {
            label: "문제정의 결론",
            value: selectedTopic.problem_conclusion || "연결된 결론이 아직 없습니다.",
          },
        ],
        organizeTitle: "해결책 정리",
      };
    }

    if (stage === "ideation" && selectedCanvasItem) {
      const refinedItems = normalizeRefinedUtterances(selectedCanvasItem.refined_utterances);
      const topicChildIds = new Set([
        ...(selectedCanvasItem.child_item_ids || []),
        ...canvasItems
          .filter((item) => item.parent_topic_id === selectedCanvasItem.id)
          .map((item) => item.id),
      ]);
      const topicChildren = isTopicCanvasItem(selectedCanvasItem)
        ? canvasItems.filter((item) => topicChildIds.has(item.id))
        : [];
      const commentItems = canvasItems.filter(
        (item) => item.parent_topic_id === selectedCanvasItem.id && item.kind === "comment",
      );
      const childIdeaItems = topicChildren.filter((item) => item.kind !== "comment");

      return {
        title: selectedCanvasItem.title,
        subtitle: `${toolLabel((selectedCanvasItem.kind as ComposerTool) || "note")} · 공용 캔버스 아이템`,
        badges: [
          toolLabel((selectedCanvasItem.kind as ComposerTool) || "note"),
          childIdeaItems.length > 0 ? `하위 아이디어 ${childIdeaItems.length}개` : "",
          commentItems.length > 0 ? `댓글 ${commentItems.length}개` : "",
        ].filter(Boolean),
        insightLens: "",
        keywords: (selectedCanvasItem.keywords || []).slice(0, 5),
        summaryItems: [
          {
            label: "내용",
            value: selectedCanvasItem.body || "내용이 아직 없습니다.",
          },
        ],
        organizeItems: [],
        organizeTitle: "",
        refinedItems: refinedItems.map((item, index) => ({
          id: item.utterance_id || `${selectedCanvasItem.id}-refined-${index}`,
          sourceItemId: selectedCanvasItem.id,
          label: item.speaker || `발화 ${index + 1}`,
          value: item.text,
        })),
        commentItems: commentItems.map((comment, index) => ({
          id: comment.id || `${selectedCanvasItem.id}-comment-${index}`,
          label: comment.title || `댓글 ${index + 1}`,
          value: comment.body || "댓글 내용이 없습니다.",
          keywords: comment.keywords || [],
        })),
        mergedItems: childIdeaItems.map((child, index) => ({
          id: child.id || `${selectedCanvasItem.id}-child-${index}`,
          label: child.title || `하위 아이디어 ${index + 1}`,
          value: child.body || "내용이 없습니다.",
          keywords: child.keywords || [],
          sourceCount: 1,
        })),
      };
    }

    const agendaFromNodeId = selectedNodeId ? extractAgendaIdFromNodeId(selectedNodeId) : "";
    const resolvedAgenda = agendaModels.find((agenda) => agenda.id === agendaFromNodeId) || selectedAgenda;
    if (!resolvedAgenda) return null;

    const summaryMatch = selectedNodeId.match(/^summary-(.+)-(\d+)$/);
    const summaryIndex = summaryMatch ? Number(summaryMatch[2]) : -1;
    const summaryLine =
      summaryIndex >= 0 ? resolvedAgenda.summaryBullets[summaryIndex] || resolvedAgenda.summaryBullets[0] : "";

    return {
      title: summaryIndex >= 0 ? `맥락 ${summaryIndex + 1}` : resolvedAgenda.title,
      subtitle: summaryIndex >= 0 ? resolvedAgenda.title : "그룹 디테일",
      badges: [
        summaryIndex >= 0 ? `POINT ${summaryIndex + 1}` : resolvedAgenda.status,
        `${resolvedAgenda.decisions.length}개 결정`,
      ].filter(Boolean),
      insightLens: "",
      keywords: (resolvedAgenda.keywords || []).slice(0, 3),
      summaryItems: [
        {
          label: "요약",
          value: stripLeadingTimestamp(
            summaryIndex >= 0
              ? summaryLine || "요약이 아직 없습니다."
              : resolvedAgenda.summaryBullets[0] || "요약이 아직 없습니다.",
          ),
        },
      ],
      organizeItems: [
        ...(resolvedAgenda.summaryBullets.length > 0
          ? resolvedAgenda.summaryBullets.slice(0, 3).map((value, index) => ({
              label: `맥락 ${index + 1}`,
              value: stripLeadingTimestamp(value),
            }))
          : [
              {
                label: "맥락 1",
                value: "맥락이 아직 없습니다.",
              },
            ]),
      ],
      organizeTitle: "맥락",
    };
  }, [agendaModels, canvasItems, problemGroups, selectedAgenda, selectedCanvasItem, selectedNodeId, selectedProblemGroup, selectedProblemSourceCard, selectedProblemSourceCards, selectedProblemSourceOpinions, selectedSolutionTopic, stage]);

  const handleGenerateProblemDefinition = useCallback(async () => {
    setProblemDefinitionStagePending(true);
    setBusy(true);
    try {
      const agendaInputs = buildProblemDefinitionAgendaInputs(agendaModels);
      const ideaInputs = buildProblemDefinitionIdeaInputs(canvasItems, projectPersonalNotes);
      const agendaSignatures = buildProblemDefinitionAgendaSignatures(agendaModels);
      const ideaSignatures = buildProblemDefinitionIdeaSourceSignatures(canvasItems, projectPersonalNotes);
      const agendaById = new Map(agendaInputs.map((agenda) => [agenda.agenda_id, agenda]));
      const agendaIdSet = new Set(agendaInputs.map((agenda) => agenda.agenda_id));
      const ideaIdSet = new Set(ideaInputs.map((idea) => idea.id));
      const ideasForTarget = (agendaIds: string[], ideaIds?: string[]) => {
        if (ideaIds?.length) {
          const targetIdeaIds = new Set(ideaIds);
          return ideaInputs.filter((idea) => targetIdeaIds.has(idea.id));
        }
        const targetAgendaIds = new Set(agendaIds);
        return ideaInputs.filter((idea) => targetAgendaIds.has(idea.agenda_id));
      };

      let nextGroups: ProblemGroupViewModel[] = [];
      let refreshedGroupIds: string[] = [];
      let warning = "";

      if (problemGroups.length === 0) {
        const result = await generateCanvasProblemDefinition({
          meeting_id: meetingId,
          topic: meetingTopicForAi,
          agendas: agendaInputs,
          ideas: ideaInputs,
        });
        warning = result.warning || "";
        nextGroups = hydrateProblemGroups(result.groups, []).map((group) =>
          stampProblemGroupSource(group, agendaSignatures, ideaSignatures),
        );
        refreshedGroupIds = nextGroups.map((group) => group.group_id);
      } else {
        let workingGroups = problemGroups.filter((group) => {
          const groupAgendaIds = group.agenda_ids || [];
          if (groupAgendaIds.length === 0) return true;
          return groupAgendaIds.some((agendaId) => agendaIdSet.has(agendaId));
        });
        const usedGroupIds = new Set(workingGroups.map((group) => group.group_id));
        const refreshTargets: Array<{
          agendaIds: string[];
          ideaIds?: string[];
          previousGroup?: ProblemGroupViewModel;
        }> = [];
        const coveredIdeaIds = new Set<string>();

        workingGroups.forEach((group) => {
          const agendaIds = (group.agenda_ids || []).filter((agendaId) => agendaIdSet.has(agendaId));
          const sourceIdeaIds = getProblemGroupSourceIdeaIds(group, ideaIdSet);
          if (sourceIdeaIds.length > 0) {
            sourceIdeaIds.forEach((ideaId) => coveredIdeaIds.add(ideaId));
          } else {
            const agendaFallbackIds = new Set(agendaIds);
            ideaInputs
              .filter((idea) => agendaFallbackIds.has(idea.agenda_id))
              .forEach((idea) => coveredIdeaIds.add(idea.id));
          }

          if (shouldRefreshProblemGroup(group, agendaSignatures, agendaIdSet, ideaSignatures)) {
            refreshTargets.push({
              agendaIds,
              ideaIds: sourceIdeaIds.length > 0 ? sourceIdeaIds : undefined,
              previousGroup: group,
            });
          }
        });

        const coveredAgendaIds = new Set(
          workingGroups.flatMap((group) => (group.agenda_ids || []).filter((agendaId) => agendaIdSet.has(agendaId))),
        );
        const agendaFallbackTargetIds = new Set<string>();
        agendaInputs.forEach((agenda) => {
          if (!coveredAgendaIds.has(agenda.agenda_id)) {
            refreshTargets.push({
              agendaIds: [agenda.agenda_id],
            });
            agendaFallbackTargetIds.add(agenda.agenda_id);
          }
        });
        const uncoveredIdeaIdsByAgenda = new Map<string, string[]>();
        ideaInputs.forEach((idea) => {
          if (coveredIdeaIds.has(idea.id) || agendaFallbackTargetIds.has(idea.agenda_id)) return;
          const ids = uncoveredIdeaIdsByAgenda.get(idea.agenda_id) || [];
          ids.push(idea.id);
          uncoveredIdeaIdsByAgenda.set(idea.agenda_id, ids);
        });
        uncoveredIdeaIdsByAgenda.forEach((ideaIds, agendaId) => {
          if (!agendaById.has(agendaId)) return;
          refreshTargets.push({
            agendaIds: [agendaId],
            ideaIds,
          });
        });

        for (const target of refreshTargets) {
          const targetAgendas = target.agendaIds
            .map((agendaId) => agendaById.get(agendaId))
            .filter((agenda): agenda is ReturnType<typeof buildProblemDefinitionAgendaInputs>[number] => Boolean(agenda));
          if (targetAgendas.length === 0) continue;
          const targetIdeas = ideasForTarget(target.agendaIds, target.ideaIds);
          if (target.previousGroup && target.ideaIds?.length && targetIdeas.length === 0) {
            workingGroups = workingGroups.filter((group) => group.group_id !== target.previousGroup?.group_id);
            refreshedGroupIds.push(target.previousGroup.group_id);
            continue;
          }

          const result = await generateCanvasProblemDefinition({
            meeting_id: meetingId,
            topic: meetingTopicForAi,
            agendas: targetAgendas,
            ideas: targetIdeas,
          });
          if (result.warning && !warning) {
            warning = result.warning;
          }

          const generatedGroups = hydrateProblemGroups(result.groups, []).map((group, index) => {
            const previousGroup = index === 0 ? target.previousGroup : undefined;
            const nextGroupId =
              previousGroup?.group_id ||
              makeUniqueProblemGroupId(
                group.group_id || `problem-group-${group.agenda_ids[0] || target.agendaIds[0] || Date.now()}`,
                usedGroupIds,
              );
            const mergedGroup: ProblemGroupViewModel = {
              ...group,
              group_id: nextGroupId,
              insight_lens: previousGroup?.insight_user_edited
                ? previousGroup.insight_lens
                : group.insight_lens,
              insight_user_edited: previousGroup?.insight_user_edited ?? group.insight_user_edited ?? false,
              conclusion: previousGroup?.conclusion_user_edited
                ? previousGroup.conclusion
                : group.conclusion,
              conclusion_user_edited:
                previousGroup?.conclusion_user_edited ?? group.conclusion_user_edited ?? false,
              status: "draft",
            };
            return stampProblemGroupSource(mergedGroup, agendaSignatures, ideaSignatures);
          });

          if (target.previousGroup) {
            const replacement = generatedGroups[0];
            if (replacement) {
              workingGroups = workingGroups.map((group) =>
                group.group_id === target.previousGroup?.group_id ? replacement : group,
              );
              refreshedGroupIds.push(replacement.group_id);
            }
            if (generatedGroups.length > 1) {
              const extras = generatedGroups.slice(1);
              workingGroups = [...workingGroups, ...extras];
              refreshedGroupIds.push(...extras.map((group) => group.group_id));
            }
          } else if (generatedGroups.length > 0) {
            workingGroups = [...workingGroups, ...generatedGroups];
            refreshedGroupIds.push(...generatedGroups.map((group) => group.group_id));
          }
        }

        nextGroups = workingGroups.map((group) =>
          refreshedGroupIds.includes(group.group_id)
            ? group
            : stampProblemGroupSource(group, agendaSignatures, ideaSignatures),
        );
      }

      problemConclusionEntryHandledRef.current = false;
      setProblemGroups(nextGroups);
      const nextSelectedGroupId = refreshedGroupIds[0] || nextGroups[0]?.group_id || "";
      setSelectedProblemGroupId(nextSelectedGroupId);
      setSelectedSolutionTopicId("");
      setSelectedNodeId(nextSelectedGroupId ? `problem-${nextSelectedGroupId}` : "");
      setEditingProblemGroupId("");
      setEditingSolutionTopicId("");
      setStage("problem-definition");
      if (!sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          stage: "problem-definition",
          problemGroups: nextGroups,
        });
      }
      setActivityMessage(
        warning ||
          (refreshedGroupIds.length > 0
            ? `변경된 그룹분류 ${refreshedGroupIds.length}개만 문제 정의를 갱신했습니다.`
            : "변경된 그룹분류가 없어 기존 문제 정의를 유지했습니다."),
      );
      if (refreshedGroupIds.length > 0) {
        problemConclusionEntryHandledRef.current = true;
        await handleGenerateAllProblemGroupConclusions(nextGroups, refreshedGroupIds);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`문제 정의 생성 실패: ${message}`);
    } finally {
      setProblemDefinitionStagePending(false);
      setBusy(false);
    }
  }, [
    agendaModels,
    canvasItems,
    forceBroadcastSharedCanvas,
    handleGenerateAllProblemGroupConclusions,
    meetingId,
    meetingTopicForAi,
    projectPersonalNotes,
    problemGroups,
    sharedSyncEnabled,
  ]);

  const handleGenerateSolutionStage = async () => {
    const finalizedGroups = problemGroups.filter((group) => group.status === "final");
    setStage("solution");
    setLeftPanelTab("detail");
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
    setSelectedNodeId("");
    setEditingSolutionTopicId("");

    if (finalizedGroups.length === 0) {
      setActivityMessage("확정된 문제 정의 그룹이 없습니다. 먼저 그룹을 확정해 주세요.");
      return;
    }

    setSolutionStagePending(true);
    setBusy(true);
    try {
      const result = await generateCanvasSolutionStage({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        topics: finalizedGroups.map((group, index) => ({
          group_id: group.group_id,
          topic_no: index + 1,
          topic: group.topic,
          conclusion: group.conclusion,
        })),
      });
      const nextSolutionTopics = hydrateSolutionTopics(result.topics, problemGroups, solutionTopics);
      setSolutionTopics(nextSolutionTopics);
      setSelectedSolutionTopicId(nextSolutionTopics[0]?.group_id || "");
      setSelectedNodeId(nextSolutionTopics[0] ? `solution-${nextSolutionTopics[0].group_id}` : "");
      if (!sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          stage: "solution",
          solutionTopics: nextSolutionTopics,
        });
      }
      setActivityMessage(result.warning || `확정된 문제 정의 ${finalizedGroups.length}개 기준으로 해결책을 생성했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`해결책 생성 실패: ${message}`);
    } finally {
      setSolutionStagePending(false);
      setBusy(false);
    }
  };

  const handleStageSelect = useCallback(
    async (nextStage: CanvasStage) => {
      if (stage === "ideation" && nextStage !== "ideation") {
        await flushIdeaAssimilationBuffer("stage-change");
      }
      if (stage === "problem-definition" && nextStage !== "problem-definition") {
        await flushProblemDiscussionBuffer("stage-change");
      }

      if (nextStage === "solution") {
        if (busy || solutionStagePending) {
          setActivityMessage(
            solutionStagePending
              ? "해결책 단계를 준비하는 중이라 잠시 후 다시 시도해 주세요."
              : "다른 작업이 진행 중이라 아직 해결책 단계로 전환할 수 없습니다.",
          );
          return;
        }

        if (solutionTopics.length === 0) {
          await handleGenerateSolutionStage();
          return;
        }

        setStage("solution");
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId(solutionTopics[0]?.group_id || "");
        setSelectedNodeId(solutionTopics[0] ? `solution-${solutionTopics[0].group_id}` : "");
        setLeftPanelTab("detail");
        return;
      }

      if (nextStage !== "problem-definition") {
        setStage(nextStage);
        return;
      }

      if (busy || conclusionBatchBusy) {
        setActivityMessage(
          conclusionBatchBusy
            ? "문제정의 결론을 생성 중이라 잠시 후 다시 시도해 주세요."
            : "다른 작업이 진행 중이라 아직 문제정의 단계로 전환할 수 없습니다.",
        );
        return;
      }

      await handleGenerateProblemDefinition();
      setLeftPanelTab("detail");
      return;
    },
    [
      busy,
      conclusionBatchBusy,
      flushIdeaAssimilationBuffer,
      flushProblemDiscussionBuffer,
      handleGenerateProblemDefinition,
      handleGenerateSolutionStage,
      solutionStagePending,
      solutionTopics,
      stage,
    ],
  );

  const handleAddPersonalNote = () => {
    const nextNote: PersonalNote = {
      id: `note-${Date.now()}`,
      projectId: meetingId,
      agendaId: composerAgendaId,
      linkedCanvasItemId: composerLinkedCanvasItemId,
      linkedCanvasItemTitle: composerLinkedCanvasItemTitle,
      kind: composerTool,
      title: composerTitle.trim() || `${toolLabel(composerTool)} ${projectPersonalNotes.length + 1}`,
      body: composerBody.trim() || "개인 메모를 입력해 두면 나중에 그룹 보드로 이동시킬 수 있습니다.",
    };

    setPersonalNotes((prev) => [nextNote, ...prev]);
    setComposerTitle("");
    setComposerBody("");
    setComposerLinkedCanvasItemId("");
    setComposerLinkedCanvasItemTitle("");
    if (pendingPersonalNoteLinkId === COMPOSER_PERSONAL_NOTE_LINK_ID) {
      setPendingPersonalNoteLinkId("");
    }
    setActivityMessage("개인 메모에 저장했습니다.");
  };

  const canUseCanvasToolbar = stage === "ideation" || stage === "problem-definition";
  const visibleCanvasTools = useMemo<CanvasTool[]>(
    () =>
      stage === "problem-definition"
        ? ["note", "problem-idea", "comment", "group"]
        : ["note", "comment", "topic", "group"],
    [stage],
  );

  const armCanvasTool = (tool: CanvasTool) => {
    if (!canUseCanvasToolbar || !visibleCanvasTools.includes(tool)) {
      setActivityMessage("현재 단계에서는 이 도구를 사용할 수 없습니다.");
      return;
    }
    if (isComposerTool(tool)) {
      setComposerTool(tool);
    }
    const isDisarming = armedCanvasTool === tool;
    setArmedCanvasTool(isDisarming ? null : tool);
    setCanvasPlacementPreview((prev) =>
      !prev || isDisarming
        ? null
        : {
            ...prev,
            label: toolLabel(tool, stage),
            hint: toolPreviewHint(tool, stage),
            tone: toolPreviewTone(tool, stage),
          },
    );
    setActivityMessage(
      isDisarming
        ? "보드 클릭 도구를 해제했습니다."
        : stage === "problem-definition" && tool === "group"
          ? "문제정의 그룹 도구를 선택했습니다. 보드를 클릭하면 새 문제정의 그룹이 생성됩니다."
          : stage === "problem-definition" && tool === "problem-idea"
            ? "아이디어 추가 도구를 선택했습니다. 문제정의 그룹을 클릭하면 아이디어 카드가 추가됩니다."
          : stage === "ideation" && tool === "group"
            ? "그룹 도구를 선택했습니다. 보드를 클릭하면 프로젝트 그룹 분류가 생성됩니다."
            : stage === "problem-definition"
              ? `${toolLabel(tool, stage)} 도구를 선택했습니다. 보드를 클릭하면 문제정의 의견 노드가 생성됩니다.`
              : `${toolLabel(tool, stage)} 도구를 선택했습니다. 보드를 클릭하면 공용 canvas 아이템이 생성됩니다.`,
    );
  };

  useEffect(() => {
    if (!canUseCanvasToolbar || !armedCanvasTool || !visibleCanvasTools.includes(armedCanvasTool)) {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
    }
  }, [armedCanvasTool, canUseCanvasToolbar, visibleCanvasTools]);

  const updateCanvasPlacementPreview = useCallback(
    (clientX: number, clientY: number) => {
      if (!canUseCanvasToolbar || !armedCanvasTool || !visibleCanvasTools.includes(armedCanvasTool) || !canvasSurfaceRef.current) {
        setCanvasPlacementPreview(null);
        return;
      }

      if (
        stage === "ideation" &&
        (armedCanvasTool === "note" || armedCanvasTool === "comment")
      ) {
        const rightPaneRect = ideationRightPaneRef.current?.getBoundingClientRect() || null;
        const insideRightPane =
          Boolean(rightPaneRect) &&
          clientX >= rightPaneRect!.left &&
          clientX <= rightPaneRect!.right &&
          clientY >= rightPaneRect!.top &&
          clientY <= rightPaneRect!.bottom;
        if (!insideRightPane) {
          setCanvasPlacementPreview(null);
          return;
        }
      }

      const rect = canvasSurfaceRef.current.getBoundingClientRect();
      const previewWidth = 232;
      const previewHeight = 112;
      const x = Math.max(0, Math.min(clientX - rect.left, Math.max(rect.width - previewWidth, 0)));
      const y = Math.max(0, Math.min(clientY - rect.top, Math.max(rect.height - previewHeight, 0)));

      setCanvasPlacementPreview({
        x,
        y,
        label: toolLabel(armedCanvasTool, stage),
        hint: toolPreviewHint(armedCanvasTool, stage),
        tone: toolPreviewTone(armedCanvasTool, stage),
      });
    },
    [armedCanvasTool, canUseCanvasToolbar, stage, visibleCanvasTools],
  );

  const clearCanvasPlacementPreview = useCallback(() => {
    setCanvasPlacementPreview(null);
  }, []);

  const handleCanvasPlacementStart = useCallback(
    async (tool: CanvasTool, clientX: number, clientY: number, agendaId?: string, pointId?: string) => {
      if (!flowRef.current || !canvasSurfaceRef.current) {
        return;
      }

      if (stage === "ideation" && (tool === "note" || tool === "comment")) {
        const rightPaneRect = ideationRightPaneRef.current?.getBoundingClientRect() || null;
        const insideRightPane =
          Boolean(rightPaneRect) &&
          clientX >= rightPaneRect!.left &&
          clientX <= rightPaneRect!.right &&
          clientY >= rightPaneRect!.top &&
          clientY <= rightPaneRect!.bottom;
        if (!insideRightPane) {
          setArmedCanvasTool(null);
          setCanvasPlacementPreview(null);
          setActivityMessage("메모와 댓글은 오른쪽 상세 캔버스에서 추가해 주세요.");
          return;
        }
      }

      const canvasRect = canvasSurfaceRef.current.getBoundingClientRect();
      const uiX = Math.max(0, Math.min(clientX - canvasRect.left, canvasRect.width));
      const uiY = Math.max(0, Math.min(clientY - canvasRect.top, canvasRect.height));
      const flowPosition = flowRef.current.screenToFlowPosition({ x: clientX, y: clientY });

      if (stage === "problem-definition") {
        const now = new Date().toISOString();
        const makeUserProblemGroup = (groupId: string): ProblemGroupViewModel => ({
          group_id: groupId,
          topic: `문제정의 그룹 ${problemGroups.length + 1}`,
          insight_lens: "",
          insight_user_edited: false,
          keywords: [],
          agenda_ids: [],
          agenda_titles: [],
          ideas: [],
          discussion_items: [],
          source_summary_items: [],
          conclusion: "직접 추가한 문제정의 그룹입니다. 관련 의견을 드래그해서 편입해 주세요.",
          conclusion_user_edited: false,
          status: "draft",
          source_signature: `user:${groupId}`,
          source_agenda_signatures: {},
          source_idea_signatures: {},
        });

        let nextProblemGroupsSnapshot: ProblemGroupViewModel[] = problemGroups;
        let nextNodePositionsSnapshot: CanvasNodePositionsByStage = nodePositions;
        const clickedProblemGroupId =
          pointId?.startsWith("problem-") && !pointId.startsWith("problem-discussion-")
            ? pointId.slice("problem-".length)
            : "";
        const clickedDiscussionGroupId =
          pointId?.startsWith("problem-discussion-")
            ? problemGroups.find((group) =>
                (group.discussion_items || []).some(
                  (item) => `problem-discussion-${item.id}` === pointId,
                ),
              )?.group_id || ""
            : "";
        let nextSelectedGroupId =
          clickedProblemGroupId ||
          clickedDiscussionGroupId ||
          selectedProblemGroupId ||
          problemGroups[0]?.group_id ||
          "";
        let nextSelectedNodeId = "";
        let nextSelectedProblemSourceNodeId = "";
        let nextLeftPanelTab: LeftPanelTab = "detail";

        if (tool === "group") {
          const groupId = `user-problem-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextGroup = makeUserProblemGroup(groupId);
          nextProblemGroupsSnapshot = [nextGroup, ...problemGroups];
          nextNodePositionsSnapshot = {
            ...nodePositions,
            "problem-definition": {
              ...(nodePositions["problem-definition"] || {}),
              [`problem-${groupId}`]: {
                x: flowPosition.x,
                y: flowPosition.y,
              },
            },
          };
          nextSelectedGroupId = groupId;
          nextSelectedNodeId = `problem-${groupId}`;
          setEditingProblemGroupId(groupId);
          setProblemGroupDraftTopic(nextGroup.topic);
          setProblemGroupDraftInsight("");
          setProblemGroupDraftConclusion(nextGroup.conclusion);
          setActivityMessage("새 문제정의 그룹을 추가했습니다. 다른 의견 노드를 드래그해서 편입할 수 있습니다.");
        } else if (tool === "problem-idea") {
          let workingGroups = problemGroups;
          if (!nextSelectedGroupId) {
            const groupId = `user-problem-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
            const nextGroup = makeUserProblemGroup(groupId);
            workingGroups = [nextGroup, ...problemGroups];
            nextSelectedGroupId = groupId;
            nextNodePositionsSnapshot = {
              ...nodePositions,
              "problem-definition": {
                ...(nodePositions["problem-definition"] || {}),
                [`problem-${groupId}`]: {
                  x: Math.max(80, flowPosition.x - 560),
                  y: flowPosition.y,
                },
              },
            };
          }

          const targetGroup = workingGroups.find((group) => group.group_id === nextSelectedGroupId);
          const ideaId = `user-problem-idea-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextIdea = {
            id: ideaId,
            kind: "idea",
            title: `아이디어 ${(targetGroup?.ideas.length || 0) + 1}`,
            body: "문제정의 그룹에 추가할 아이디어를 입력해 주세요.",
          };

          nextProblemGroupsSnapshot = workingGroups.map((group) =>
            group.group_id === nextSelectedGroupId
              ? {
                  ...group,
                  ideas: [
                    ...(group.ideas || []),
                    nextIdea,
                  ],
                }
              : group,
          );
          nextSelectedNodeId = `problem-${nextSelectedGroupId}`;
          nextSelectedProblemSourceNodeId = ideaId;
          nextLeftPanelTab = "detail";
          setActivityMessage("아이디어 카드를 문제정의 그룹에 추가했습니다.");
        } else {
          let workingGroups = problemGroups;
          if (!nextSelectedGroupId) {
            const groupId = `user-problem-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
            const nextGroup = makeUserProblemGroup(groupId);
            workingGroups = [nextGroup, ...problemGroups];
            nextSelectedGroupId = groupId;
            nextNodePositionsSnapshot = {
              ...nodePositions,
              "problem-definition": {
                ...(nodePositions["problem-definition"] || {}),
                [`problem-${groupId}`]: {
                  x: Math.max(80, flowPosition.x - 560),
                  y: flowPosition.y,
                },
              },
            };
          }

          const discussionId = `user-problem-note-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextDiscussion: ProblemDiscussionViewModel = {
            id: discussionId,
            parent_group_id: nextSelectedGroupId,
            title: tool === "comment" ? "댓글" : "문제 의견",
            body:
              tool === "comment"
                ? "문제정의 단계에서 남길 댓글을 입력해 주세요."
                : "문제정의에 반영할 의견을 입력해 주세요.",
            keywords: [],
            key_evidence: [],
            refined_utterances: [],
            evidence_utterance_ids: [],
            ignored_utterance_ids: [],
            ai_pending: false,
            ai_generated: false,
            user_edited: true,
            created_by: "user",
            created_at: now,
          };

          nextProblemGroupsSnapshot = workingGroups.map((group) =>
            group.group_id === nextSelectedGroupId
              ? {
                  ...group,
                  discussion_items: [
                    ...(group.discussion_items || []),
                    nextDiscussion,
                  ],
                }
              : group,
          );
          nextNodePositionsSnapshot = {
            ...nextNodePositionsSnapshot,
            "problem-definition": {
              ...(nextNodePositionsSnapshot["problem-definition"] || {}),
              [`problem-discussion-${discussionId}`]: {
                x: flowPosition.x,
                y: flowPosition.y,
              },
            },
          };
          nextSelectedNodeId = `problem-discussion-${discussionId}`;
          setActivityMessage(`${toolLabel(tool, stage)} 노드를 문제정의 단계에 추가했습니다.`);
        }

        latestSharedWorkspaceRef.current = {
          ...latestSharedWorkspaceRef.current,
          stage,
          problemGroups: nextProblemGroupsSnapshot,
          nodePositions: nextNodePositionsSnapshot,
          importedState: persistedSharedImportedState,
        };

        setArmedCanvasTool(null);
        setCanvasPlacementPreview(null);
        setProblemGroups(nextProblemGroupsSnapshot);
        setNodePositions(nextNodePositionsSnapshot);
        setSelectedProblemGroupId(nextSelectedGroupId);
        setSelectedProblemSourceNodeId(nextSelectedProblemSourceNodeId);
        setSelectedCanvasItemId("");
        setSelectedSolutionTopicId("");
        setSelectedNodeId(nextSelectedNodeId);
        setLeftPanelTab(nextLeftPanelTab);
        setPlacementFeedback({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          x: uiX,
          y: uiY,
          label: toolLabel(tool, stage),
        });
        if (placementFeedbackTimerRef.current) {
          window.clearTimeout(placementFeedbackTimerRef.current);
        }
        placementFeedbackTimerRef.current = window.setTimeout(() => {
          setPlacementFeedback(null);
          placementFeedbackTimerRef.current = null;
        }, 1500);

        if (sharedSyncEnabled) {
          writeSharedWorkspaceSessionCache(
            meetingId,
            buildFullWorkspacePatchPayload({
              meetingId,
              meetingGoal: meetingGoalDraft,
              meetingGoalContext: meetingGoalContextDraft,
              stage,
              agendaOverrides,
              canvasItems,
              customGroups,
              problemGroups: nextProblemGroupsSnapshot,
              solutionTopics,
              nodePositions: nextNodePositionsSnapshot,
              importedState: persistedSharedImportedState,
            }),
          );
          forceBroadcastSharedCanvas({
            problemGroups: nextProblemGroupsSnapshot,
            nodePositions: nextNodePositionsSnapshot,
          });
          if (meetingId) {
            void saveCanvasWorkspacePatch({
              meeting_id: meetingId,
              problem_groups: serializeSharedProblemGroups(nextProblemGroupsSnapshot),
              node_positions: nextNodePositionsSnapshot,
              imported_state: persistedSharedImportedState,
            }).catch((error) => {
              console.error("Failed to save shared problem-definition tool placement:", error);
            });
          }
        }
        return;
      }

      if (tool === "group") {
        const now = new Date().toISOString();
        const draftTitle = customGroupDraftTitle.trim() || `그룹 분류 ${customGroups.length + 1}`;
        const nextGroup: CustomGroupViewModel = {
          id: `project-group-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          title: draftTitle,
          description: "프로젝트에서 직접 추가한 그룹 분류입니다.",
          keywords: [],
          color: "",
          created_by: userId,
          created_at: now,
        };
        const nextNodeId = `agenda-${nextGroup.id}`;
        const nextCustomGroupsSnapshot = [nextGroup, ...customGroups];
        const nextNodePositionsSnapshot: CanvasNodePositionsByStage = normalizeCanvasNodePositionsForComputedIdeation({
          ...nodePositions,
          ideation: {
            ...(nodePositions.ideation || {}),
            [nextNodeId]: {
              x: flowPosition.x,
              y: flowPosition.y,
            },
          },
        });

        pendingNodePlacementsRef.current[nextNodeId] = {
          x: flowPosition.x,
          y: flowPosition.y,
        };
        latestSharedWorkspaceRef.current = {
          ...latestSharedWorkspaceRef.current,
          stage,
          customGroups: nextCustomGroupsSnapshot,
          nodePositions: nextNodePositionsSnapshot,
          importedState: persistedSharedImportedState,
        };

        setArmedCanvasTool(null);
        setCanvasPlacementPreview(null);
        setCustomGroups(nextCustomGroupsSnapshot);
        setNodePositions(nextNodePositionsSnapshot);
        setSelectedAgendaId(nextGroup.id);
        setSelectedCanvasItemId("");
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId("");
        setSelectedNodeId(nextNodeId);
        setEditingAgendaId(nextGroup.id);
        setAgendaDraftTitle(nextGroup.title);
        setAgendaDraftKeywords("");
        setAgendaDraftSummary(nextGroup.description || "");
        setCustomGroupDraftTitle("");
        setLeftPanelTab("detail");
        setPlacementFeedback({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          x: uiX,
          y: uiY,
          label: toolLabel(tool),
        });
        if (placementFeedbackTimerRef.current) {
          window.clearTimeout(placementFeedbackTimerRef.current);
        }
        placementFeedbackTimerRef.current = window.setTimeout(() => {
          setPlacementFeedback(null);
          placementFeedbackTimerRef.current = null;
        }, 1500);
        setActivityMessage("보드 위치에 프로젝트 그룹 분류를 생성했습니다. 이름을 바로 수정할 수 있습니다.");

        if (sharedSyncEnabled) {
          writeSharedWorkspaceSessionCache(
            meetingId,
            buildFullWorkspacePatchPayload({
              meetingId,
              meetingGoal: meetingGoalDraft,
              meetingGoalContext: meetingGoalContextDraft,
              stage,
              agendaOverrides,
              canvasItems,
              customGroups: nextCustomGroupsSnapshot,
              problemGroups,
              solutionTopics,
              nodePositions: nextNodePositionsSnapshot,
              importedState: persistedSharedImportedState,
            }),
          );
          forceBroadcastSharedCanvas({
            customGroups: nextCustomGroupsSnapshot,
            nodePositions: nextNodePositionsSnapshot,
          });
          if (meetingId) {
            void saveCanvasWorkspacePatch({
              meeting_id: meetingId,
              custom_groups: serializeCustomGroups(nextCustomGroupsSnapshot),
              node_positions: nextNodePositionsSnapshot,
              imported_state: persistedSharedImportedState,
            }).catch((error) => {
              console.error("Failed to save shared project group placement:", error);
            });
          }
        }

        try {
          await confirmCanvasPlacement({
            tool,
            ui_x: uiX,
            ui_y: uiY,
            flow_x: flowPosition.x,
            flow_y: flowPosition.y,
            title: draftTitle,
            body: "",
          });
        } catch (error) {
          console.error("Failed to confirm project group placement:", error);
        }
        return;
      }

      if (!isComposerTool(tool)) {
        setActivityMessage("현재 단계에서는 이 도구를 사용할 수 없습니다.");
        return;
      }

      const clickedCanvasItemId = extractCanvasItemIdFromNodeId(pointId || "");
      const clickedCanvasItem = clickedCanvasItemId
        ? canvasItems.find((item) => item.id === clickedCanvasItemId) || null
        : null;
      const selectedRootItemId = selectedCanvasItemId
        ? getCanvasItemTopLevelAncestorId(canvasItems, selectedCanvasItemId)
        : "";
      const selectedRootItem = selectedRootItemId
        ? canvasItems.find((item) => item.id === selectedRootItemId) || null
        : null;
      const parentItemForPlacement =
        stage === "ideation" && tool !== "topic"
          ? clickedCanvasItem || selectedRootItem
          : null;

      if (stage === "ideation" && tool !== "topic" && !parentItemForPlacement) {
        setActivityMessage("먼저 왼쪽 그룹을 선택한 뒤 오른쪽 캔버스에 메모나 댓글을 추가해 주세요.");
        setArmedCanvasTool(null);
        setCanvasPlacementPreview(null);
        return;
      }

      const nextAgendaId =
        agendaId ||
        parentItemForPlacement?.agenda_id ||
        selectedAgendaId ||
        agendaModels[0]?.id ||
        "";
      const nextParentItemId = parentItemForPlacement?.id || "";
      const draftTitle = `${toolLabel(tool)} ${canvasItems.filter((item) => item.kind === tool).length + 1}`;
      const nextItemId = `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const nextNodeId = `canvas-item-${nextItemId}`;
      const draftBody =
        tool === "topic"
          ? "새 주제를 정리해 주세요."
          : tool === "comment"
            ? "코멘트 내용을 입력해 주세요."
            : "메모 내용을 입력해 주세요.";
      const nextItem: CanvasItemViewModel = {
        id: nextItemId,
        agenda_id: nextAgendaId,
        point_id: pointId || "",
        kind: tool,
        status: "discussion",
        title: draftTitle,
        keywords: [],
        key_evidence: [],
        refined_utterances: [],
        evidence_utterance_ids: [],
        ignored_utterance_ids: [],
        parent_topic_id: nextParentItemId,
        parent_topic_source: nextParentItemId ? "user" : "",
        parent_topic_locked: Boolean(nextParentItemId),
        child_item_ids: [],
        topic_collapsed: tool === "topic" ? false : undefined,
        created_by: "user",
        manual_position: false,
        ai_generated: false,
        user_edited: true,
        body: draftBody,
      };
      const nextCanvasItemsSnapshot: CanvasItemViewModel[] = [
        nextItem,
        ...canvasItems.map((item) =>
          item.id === nextParentItemId
            ? {
                ...item,
                child_item_ids: [...new Set([...(item.child_item_ids || []), nextItemId])],
              }
            : item,
        ),
      ];
      const nextNodePositionsSnapshot = normalizeCanvasNodePositionsForComputedIdeation(nodePositions);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage,
        canvasItems: nextCanvasItemsSnapshot,
        nodePositions: nextNodePositionsSnapshot,
        importedState: persistedSharedImportedState,
      };

      if (nextAgendaId) {
        setSelectedAgendaId(nextAgendaId);
      }
      setComposerTool(tool);
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setCanvasItems(nextCanvasItemsSnapshot);
      setSelectedCanvasItemId(nextItemId);
      setSelectedNodeId(nextNodeId);
      setEditingCanvasItemId(nextItemId);
      setCanvasItemDraftTitle(nextItem.title);
      setCanvasItemDraftBody(nextItem.body);
      setLeftPanelTab("detail");
      setPlacementFeedback({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        x: uiX,
        y: uiY,
        label: toolLabel(tool),
      });
      if (placementFeedbackTimerRef.current) {
        window.clearTimeout(placementFeedbackTimerRef.current);
      }
      placementFeedbackTimerRef.current = window.setTimeout(() => {
        setPlacementFeedback(null);
        placementFeedbackTimerRef.current = null;
      }, 1500);

      setActivityMessage("보드 위치에 공용 canvas 아이템을 생성했습니다.");

      if (sharedSyncEnabled) {
        writeSharedWorkspaceSessionCache(
          meetingId,
            buildFullWorkspacePatchPayload({
              meetingId,
              meetingGoal: meetingGoalDraft,
              meetingGoalContext: meetingGoalContextDraft,
              stage,
            agendaOverrides,
            canvasItems: nextCanvasItemsSnapshot,
            customGroups,
            problemGroups,
            solutionTopics,
            nodePositions: nextNodePositionsSnapshot,
            importedState: persistedSharedImportedState,
          }),
        );
        forceBroadcastSharedCanvas({
          canvasItems: nextCanvasItemsSnapshot,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save shared canvas item placement:", error);
          });
        }
      }

      try {
        await confirmCanvasPlacement({
          tool,
          ui_x: uiX,
          ui_y: uiY,
          flow_x: flowPosition.x,
          flow_y: flowPosition.y,
          agenda_id: nextAgendaId || undefined,
          point_id: pointId || undefined,
          title: draftTitle,
          body: "",
        });
      } catch (error) {
        console.error("Failed to confirm canvas placement:", error);
      }
    },
    [
      agendaOverrides,
      agendaModels,
      canvasItems,
      customGroupDraftTitle,
      customGroups,
      forceBroadcastSharedCanvas,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      selectedAgendaId,
      selectedCanvasItemId,
      selectedProblemGroupId,
      sharedSyncEnabled,
      solutionTopics,
      stage,
      userId,
    ],
  );

  const onNodesChange = (changes: NodeChange[]) => {
    if (!workspaceLoadedRef.current || workspaceHydratingRef.current || applyingRemoteSharedSyncRef.current) {
      setNodes((current) => applyNodeChanges(changes, current));
      return;
    }

    setNodes((current) => applyNodeChanges(changes, current));
    setNodePositions((prev) => {
      const stagePositions = { ...(prev[stage] || {}) };
      let changed = false;

      changes.forEach((change) => {
        if (change.type === "remove" && stagePositions[change.id]) {
          delete stagePositions[change.id];
          changed = true;
        }
      });

      if (!changed) {
        return prev;
      }

      if (!sharedSyncEnabled) {
        changes.forEach((change) => {
          if (change.type === "remove") {
            localNodeOverridesRef.current[stage].delete(change.id);
          }
        });
      }

      return {
        ...prev,
        [stage]: stagePositions,
      };
    });
  };

  const setProblemDropHighlight = (target: ProblemSourceDropTarget | null) => {
    const previousElement = hoveredProblemDropTargetElementRef.current;
    if (previousElement && previousElement !== target?.element) {
      previousElement.classList.remove("imms-problem-source-drop-active");
    }

    if (target?.element) {
      target.element.classList.add("imms-problem-source-drop-active");
      hoveredProblemDropTargetElementRef.current = target.element;
      if (typeof document !== "undefined") {
        document.body.style.cursor = "copy";
      }
      return;
    }

    hoveredProblemDropTargetElementRef.current = null;
    if (typeof document !== "undefined") {
      document.body.style.cursor = "";
    }
  };

  const getStableIdeationDragPosition = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const dragState = stableIdeationDragRef.current;
      if (!flowRef.current || !dragState || dragState.nodeId !== node.id) {
        return node.position;
      }

      const pointerPosition = flowRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      return {
        x: pointerPosition.x - dragState.anchor.x,
        y: pointerPosition.y - dragState.anchor.y,
      };
    },
    [],
  );

  const getIdeationDropPlaceholderPosition = useCallback(
    (pane: "left" | "right", clientX: number, clientY: number, fallback: { x: number; y: number }) => {
      const instance = pane === "left" ? ideationLeftFlowRef.current : ideationRightFlowRef.current;
      if (!instance) {
        return fallback;
      }

      const flowPosition = instance.screenToFlowPosition({ x: clientX, y: clientY });
      return {
        x: flowPosition.x - CANVAS_ITEM_NODE_WIDTH / 2,
        y: flowPosition.y - 64,
      };
    },
    [],
  );

  const findIdeationLeftGroupDropTarget = useCallback(
    (clientX: number, clientY: number, draggedItem: CanvasItemViewModel) => {
      if (stage !== "ideation") {
        return null;
      }

      const leftPane = ideationLeftPaneRef.current;
      if (!leftPane) {
        return null;
      }

      const selectedAgendaForDrop = selectedAgendaId || agendaModels[0]?.id || "";
      const draggedRootId = getCanvasItemTopLevelAncestorId(canvasItems, draggedItem.id);
      const draggedDescendantIds = new Set(getCanvasItemDescendantIds(canvasItems, draggedItem.id));

      return Array.from(leftPane.querySelectorAll<HTMLElement>(".react-flow__node"))
        .map((element) => {
          const nodeId = element.getAttribute("data-id") || "";
          const targetItemId = extractCanvasItemIdFromNodeId(nodeId);
          const targetItem = targetItemId
            ? canvasItems.find((item) => item.id === targetItemId) || null
            : null;
          if (!targetItem) {
            return null;
          }

          const rect = element.getBoundingClientRect();
          const inside =
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;
          if (!inside) {
            return null;
          }

          if (
            targetItem.parent_topic_id ||
            targetItem.agenda_id !== selectedAgendaForDrop ||
            targetItem.id === draggedItem.id ||
            draggedDescendantIds.has(targetItem.id)
          ) {
            return null;
          }

          return {
            nodeId,
            targetItem,
            targetNode: nodes.find((candidate) => candidate.id === nodeId) || null,
            isCurrentRoot: targetItem.id === draggedRootId,
            distance: Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2)),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((left, right) => left.distance - right.distance)[0] || null;
    },
    [agendaModels, canvasItems, nodes, selectedAgendaId, stage],
  );

  const resolveIdeationDropPreview = useCallback(
    (clientX: number, clientY: number, node: Node): IdeationDropPreviewState | null => {
      if (stage !== "ideation" || !node.id.startsWith("canvas-item-")) {
        return null;
      }

      const draggedItemId = node.id.slice("canvas-item-".length);
      const draggedItem = canvasItems.find((item) => item.id === draggedItemId) || null;
      if (!draggedItem) {
        return null;
      }

      const selectedAgendaForDrop = selectedAgendaId || agendaModels[0]?.id || "";
      const draggedRootId = getCanvasItemTopLevelAncestorId(canvasItems, draggedItem.id);
      const draggedDescendantIds = getCanvasItemDescendantIds(canvasItems, draggedItem.id);
      const splitLeftDropTarget = findIdeationLeftGroupDropTarget(clientX, clientY, draggedItem);
      const pointerInsideLeftPane = pointInRect(
        clientX,
        clientY,
        getReactFlowCanvasRect(ideationLeftPaneRef.current),
      );
      const pointerInsideRightPane = pointInRect(
        clientX,
        clientY,
        getReactFlowCanvasRect(ideationRightPaneRef.current),
      );

      if (draggedItem.parent_topic_id && pointerInsideLeftPane) {
        if (splitLeftDropTarget && splitLeftDropTarget.targetNode && !splitLeftDropTarget.isCurrentRoot) {
          return {
            draggedItemId,
            targetId: splitLeftDropTarget.targetItem.id,
            mode: "topic",
            agendaId: splitLeftDropTarget.targetItem.agenda_id || draggedItem.agenda_id,
            position: splitLeftDropTarget.targetNode.position,
            label: "이 그룹으로 이동",
            hint: `"${splitLeftDropTarget.targetItem.title || "그룹"}" 상세 캔버스로 이동합니다.`,
          };
        }

        return {
          draggedItemId,
          targetId: selectedAgendaForDrop || draggedItem.agenda_id,
          mode: "detach",
          agendaId: selectedAgendaForDrop || draggedItem.agenda_id,
          position: getIdeationDropPlaceholderPosition("left", clientX, clientY, node.position),
          label: "왼쪽에 추가",
          hint: "마우스를 놓으면 현재 그룹분류의 1차 노드로 추가합니다.",
        };
      }

      if (splitLeftDropTarget && splitLeftDropTarget.targetNode) {
        if (!draggedItem.parent_topic_id && !splitLeftDropTarget.isCurrentRoot) {
          return makeIdeationMergeDropPreview(
            draggedItem,
            splitLeftDropTarget.targetItem,
            splitLeftDropTarget.targetNode.position,
          );
        }
      }

      if (!draggedItem.parent_topic_id && pointerInsideRightPane) {
        const selectedRootIdForDrop = selectedCanvasItemId
          ? getCanvasItemTopLevelAncestorId(canvasItems, selectedCanvasItemId)
          : "";
        const selectedRootItemForDrop = selectedRootIdForDrop
          ? canvasItems.find((item) => item.id === selectedRootIdForDrop) || null
          : null;

        if (
          selectedRootItemForDrop &&
          selectedRootItemForDrop.id !== draggedItem.id &&
          selectedRootItemForDrop.agenda_id === selectedAgendaForDrop
        ) {
          return makeIdeationMergeDropPreview(
            draggedItem,
            selectedRootItemForDrop,
            getIdeationDropPlaceholderPosition("right", clientX, clientY, node.position),
          );
        }
      }

      if (pointerInsideLeftPane || (!draggedItem.parent_topic_id && !pointerInsideRightPane)) {
        return null;
      }

      if (draggedItem.parent_topic_id && pointerInsideRightPane) {
        return null;
      }

      const candidateElements = Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"))
        .map((element) => ({
          element,
          nodeId: element.getAttribute("data-id") || "",
        }))
        .filter(({ nodeId }) =>
          nodeId &&
          nodeId !== node.id &&
          nodeId !== "ideation-drop-placeholder" &&
          nodeId.startsWith("canvas-item-"),
        );

      const candidateDropTargets = candidateElements
        .map(({ element, nodeId }) => {
          const targetItemId = nodeId.slice("canvas-item-".length);
          const targetItem = canvasItems.find((item) => item.id === targetItemId) || null;
          const targetNode = nodes.find((candidate) => candidate.id === nodeId) || null;
          if (!targetItem || !targetNode || targetItem.id === draggedItem.id) {
            return null;
          }

          const rect = element.getBoundingClientRect();
          const insideNodeRect =
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;
          const canDropOnSplitGroup =
            insideNodeRect &&
            Boolean(draggedItem.parent_topic_id) &&
            !targetItem.parent_topic_id &&
            targetItem.agenda_id === selectedAgendaForDrop &&
            targetItem.id !== draggedRootId &&
            !draggedDescendantIds.includes(targetItem.id);
          if (canDropOnSplitGroup) {
            return {
              nodeId,
              targetItem,
              targetNode,
              childCount: 0,
              directAction: "group-move" as const,
              distance: Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2)),
            };
          }
          const canMergeSplitGroups =
            insideNodeRect &&
            !draggedItem.parent_topic_id &&
            !targetItem.parent_topic_id &&
            targetItem.agenda_id === selectedAgendaForDrop &&
            targetItem.id !== draggedItem.id &&
            !draggedDescendantIds.includes(targetItem.id);
          if (canMergeSplitGroups) {
            return {
              nodeId,
              targetItem,
              targetNode,
              childCount: 0,
              directAction: "group-merge" as const,
              distance: Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2)),
            };
          }

          const screenGap = Math.max(10, rect.width * 0.045);
          const childCount =
            isTopicCanvasItem(targetItem) && !isTopicCanvasItem(draggedItem)
              ? getTopicDirectChildIds(canvasItems, targetItem.id).filter((childId) => childId !== draggedItem.id).length
              : 0;
          const dropLeft = rect.right + screenGap + childCount * (rect.width + screenGap);
          const dropRight = dropLeft + rect.width;
          const dropTop = rect.top - CANVAS_IDEATION_DROP_ZONE_VERTICAL_PADDING;
          const dropBottom = rect.bottom + CANVAS_IDEATION_DROP_ZONE_VERTICAL_PADDING;
          const insideDropZone =
            clientX >= dropLeft &&
            clientX <= dropRight &&
            clientY >= dropTop &&
            clientY <= dropBottom;
          if (!insideDropZone) {
            return null;
          }

          return {
            nodeId,
            targetItem,
            targetNode,
            childCount,
            directAction: "" as const,
            distance: Math.hypot(clientX - dropLeft, clientY - (rect.top + rect.height / 2)),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((left, right) => left.distance - right.distance);

      const candidateDropTarget = candidateDropTargets[0] || null;
      const candidateNodeId = candidateDropTarget?.nodeId || "";

      if (candidateNodeId.startsWith("canvas-item-")) {
        const targetItem = candidateDropTarget?.targetItem || null;
        const targetNode = candidateDropTarget?.targetNode || null;
        if (!targetItem || !targetNode) {
          return null;
        }
        const placeholderPosition = {
          x: targetNode.position.x + CANVAS_ITEM_NODE_WIDTH + CANVAS_TOPIC_CHILD_GAP_X + (candidateDropTarget?.childCount || 0) * (CANVAS_ITEM_NODE_WIDTH + CANVAS_TOPIC_CHILD_GAP_X),
          y: targetNode.position.y,
        };

        if (candidateDropTarget?.directAction === "group-merge") {
          return makeIdeationMergeDropPreview(draggedItem, targetItem, targetNode.position);
        }

        if (candidateDropTarget?.directAction === "group-move") {
          return {
            draggedItemId,
            targetId: targetItem.id,
            mode: "topic",
            agendaId: targetItem.agenda_id || draggedItem.agenda_id,
            position: targetNode.position,
            label: "이 그룹으로 이동",
            hint: `"${targetItem.title || "그룹"}" 상세 캔버스로 이동합니다.`,
          };
        }

        if (isTopicCanvasItem(targetItem)) {
          if (isTopicCanvasItem(draggedItem)) {
            return {
              draggedItemId,
              targetId: targetItem.id,
              mode: "topic-merge",
              agendaId: targetItem.agenda_id || draggedItem.agenda_id,
              position: placeholderPosition,
              label: "토픽 통합",
              hint: `"${targetItem.title || "토픽"}"과 합쳐 새 토픽으로 재구성합니다.`,
            };
          }

          return {
            draggedItemId,
            targetId: targetItem.id,
            mode: "topic",
            agendaId: targetItem.agenda_id || draggedItem.agenda_id,
            position: placeholderPosition,
            label: "이 토픽에 추가",
            hint: `"${targetItem.title || "토픽"}"의 하위 아이디어로 이동합니다.`,
          };
        }

        if (isTopicCanvasItem(draggedItem)) {
          const draggedTopicChildIds = getTopicFlattenedIdeaChildIds(canvasItems, draggedItem.id);
          if (draggedTopicChildIds.includes(targetItem.id)) {
            return null;
          }

          return {
            draggedItemId,
            targetId: targetItem.id,
            mode: "topic-idea-merge",
            agendaId: targetItem.agenda_id || draggedItem.agenda_id,
            position: placeholderPosition,
            label: "새 토픽으로 통합",
            hint: `"${targetItem.title || "대상 노드"}"와 토픽을 새 주제로 묶습니다.`,
          };
        }

        return {
          draggedItemId,
          targetId: targetItem.id,
          mode: "merge",
          agendaId: targetItem.agenda_id || draggedItem.agenda_id,
          position: placeholderPosition,
          label: "새 토픽으로 묶기",
          hint: `"${targetItem.title || "대상 노드"}"와 함께 새 토픽을 만듭니다.`,
        };
      }

      return null;
    },
    [agendaModels, canvasItems, findIdeationLeftGroupDropTarget, getIdeationDropPlaceholderPosition, nodes, selectedAgendaId, selectedCanvasItemId, stage],
  );

  const onNodeDragStop = (event: React.MouseEvent, node: Node) => {
    setProblemDropHighlight(null);
    setIdeationNodeDragActive(false);
    setIdeationDragGhost(null);
    const dragNode =
      stage === "ideation" && node.id.startsWith("canvas-item-")
        ? {
            ...node,
            position: getStableIdeationDragPosition(event, node),
          }
        : node;
    stableIdeationDragRef.current = null;
    const activeIdeationDropPreview = ideationDropPreviewRef.current || ideationDropPreview;
    ideationDropPreviewRef.current = null;
    setIdeationDropPreview(null);
    const activeAgendaDragPreview = agendaDragPreviewRef.current || agendaDragPreview;
    const agendaDragSession =
      stage === "ideation" && node.id.startsWith("agenda-") ? activeAgendaDragPreview : null;

    if (!workspaceLoadedRef.current || workspaceHydratingRef.current || applyingRemoteSharedSyncRef.current) {
      if (agendaDragSession) {
        agendaDragPreviewRef.current = null;
        setAgendaDragPreview(null);
      }
      return;
    }

    const currentPosition = nodePositions[stage]?.[node.id];
    if (currentPosition && currentPosition.x === dragNode.position.x && currentPosition.y === dragNode.position.y) {
      if (agendaDragSession) {
        agendaDragPreviewRef.current = null;
        setAgendaDragPreview(null);
      }
      return;
    }

    if (!sharedSyncEnabled) {
      localNodeOverridesRef.current[stage].add(node.id);
    }

    let nextPositionsSnapshot: CanvasNodePositionsByStage = {
      ...nodePositions,
      [stage]: {
        ...(nodePositions[stage] || {}),
        [node.id]: {
          x: dragNode.position.x,
          y: dragNode.position.y,
        },
      },
    };

    let nextCanvasItemsSnapshot: CanvasItemViewModel[] | null = null;
    let nextProblemGroupsSnapshot: ProblemGroupViewModel[] | null = null;
    let topicSummaryRefreshItemIds: string[] = [];
    if (stage === "ideation" && node.id.startsWith("agenda-")) {
      const agendaId = node.id.slice("agenda-".length);
      const nextStagePositions = {
        ...(nextPositionsSnapshot.ideation || {}),
        [`agenda-${agendaId}`]: {
          x: dragNode.position.x,
          y: dragNode.position.y,
        },
      };

      nextPositionsSnapshot = {
        ...nextPositionsSnapshot,
        ideation: nextStagePositions,
      };
      agendaDragPreviewRef.current = null;
      setAgendaDragPreview(null);
      setActivityMessage("그룹 분류와 하위 콘텐츠 위치를 함께 이동했습니다.");
    }

    if (stage === "ideation" && node.id.startsWith("canvas-item-")) {
      const canvasItemId = node.id.slice("canvas-item-".length);
      const draggedItem = canvasItems.find((item) => item.id === canvasItemId) || null;
      const droppedOnRightPane = pointInRect(
        event.clientX,
        event.clientY,
        getReactFlowCanvasRect(ideationRightPaneRef.current),
      );
      let dropPreview =
        activeIdeationDropPreview?.draggedItemId === canvasItemId
          ? activeIdeationDropPreview
          : resolveIdeationDropPreview(event.clientX, event.clientY, dragNode);
      let topicToExpandId = "";
      let ideationMoveMessage = "";
      let nextSelectedIdeationItemId = canvasItemId;

      if (draggedItem && !draggedItem.parent_topic_id && droppedOnRightPane) {
        const selectedRootIdForDrop = selectedCanvasItemId
          ? getCanvasItemTopLevelAncestorId(canvasItems, selectedCanvasItemId)
          : "";
        const selectedRootItemForDrop = selectedRootIdForDrop
          ? canvasItems.find((item) => item.id === selectedRootIdForDrop) || null
          : null;

        if (selectedRootItemForDrop && selectedRootItemForDrop.id !== draggedItem.id) {
          dropPreview = makeIdeationMergeDropPreview(
            draggedItem,
            selectedRootItemForDrop,
            dragNode.position,
          );
        } else {
          if (draggedItem.agenda_id) {
            setSelectedAgendaId(draggedItem.agenda_id);
          }
          ideationMoveMessage = `"${draggedItem.title || "그룹"}" 상세 캔버스를 열었습니다.`;
        }
      }

      if (draggedItem && dropPreview?.mode === "topic-merge") {
        const draggedTopic = isTopicCanvasItem(draggedItem) ? draggedItem : null;
        const targetTopic = canvasItems.find((item) => item.id === dropPreview.targetId && isTopicCanvasItem(item)) || null;
        if (draggedTopic && targetTopic && draggedTopic.id !== targetTopic.id) {
          const newTopicId = `user-topic-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextAgendaId = dropPreview.agendaId || targetTopic.agenda_id || draggedTopic.agenda_id;
          const childIds = [
            ...new Set([
              ...getTopicFlattenedIdeaChildIds(canvasItems, targetTopic.id),
              ...getTopicFlattenedIdeaChildIds(canvasItems, draggedTopic.id),
            ]),
          ].filter((childId) => childId !== targetTopic.id && childId !== draggedTopic.id);
          const nextTopic: CanvasItemViewModel = {
            id: newTopicId,
            agenda_id: nextAgendaId,
            point_id: "",
            kind: "topic",
            status: "discussion",
            title: buildUserMergedTopicTitle(targetTopic, draggedTopic),
            body: [targetTopic.body, draggedTopic.body].filter(Boolean).join("\n") || "통합한 토픽의 내용을 정리해 주세요.",
            keywords: [...new Set([...(targetTopic.keywords || []), ...(draggedTopic.keywords || [])])].slice(0, 5),
            key_evidence: [],
            refined_utterances: [],
            evidence_utterance_ids: [
              ...new Set([...(targetTopic.evidence_utterance_ids || []), ...(draggedTopic.evidence_utterance_ids || [])]),
            ],
            ignored_utterance_ids: [
              ...new Set([...(targetTopic.ignored_utterance_ids || []), ...(draggedTopic.ignored_utterance_ids || [])]),
            ],
            merged_children: [],
            compacted_from_ids: [
              ...new Set([
                targetTopic.id,
                draggedTopic.id,
                ...(targetTopic.compacted_from_ids || []),
                ...(draggedTopic.compacted_from_ids || []),
                ...childIds,
              ]),
            ],
            compaction_level: Math.max(targetTopic.compaction_level || 0, draggedTopic.compaction_level || 0) + 1,
            parent_topic_id: "",
            parent_topic_source: "",
            parent_topic_locked: false,
            child_item_ids: childIds,
            topic_collapsed: false,
            created_by: "user",
            manual_position: false,
            ai_generated: sharedSyncEnabled,
            user_edited: !sharedSyncEnabled,
            ai_pending: sharedSyncEnabled,
            x: undefined,
            y: undefined,
          };
          const targetIndex = canvasItems.findIndex((item) => item.id === targetTopic.id);
          const draggedIndex = canvasItems.findIndex((item) => item.id === draggedTopic.id);
          const insertIndex = Math.max(0, Math.min(
            targetIndex >= 0 ? targetIndex : canvasItems.length,
            draggedIndex >= 0 ? draggedIndex : canvasItems.length,
          ));
          const removedTopicIds = new Set([
            targetTopic.id,
            draggedTopic.id,
            ...getTopicDescendantTopicIds(canvasItems, targetTopic.id),
            ...getTopicDescendantTopicIds(canvasItems, draggedTopic.id),
          ]);
          const childIdSet = new Set(childIds);
          const nextItems: CanvasItemViewModel[] = [];
          let insertedTopic = false;

          canvasItems.forEach((item, index) => {
            if (index === insertIndex && !insertedTopic) {
              nextItems.push(nextTopic);
              insertedTopic = true;
            }

            if (removedTopicIds.has(item.id)) {
              return;
            }

            if (childIdSet.has(item.id)) {
              nextItems.push({
                ...item,
                agenda_id: nextAgendaId,
                parent_topic_id: newTopicId,
                parent_topic_source: "user",
                parent_topic_locked: true,
                manual_position: false,
                x: undefined,
                y: undefined,
              });
              return;
            }

            if (isTopicCanvasItem(item)) {
              nextItems.push({
                ...item,
                child_item_ids: (item.child_item_ids || []).filter(
                  (id) => !childIdSet.has(id) && !removedTopicIds.has(id),
                ),
              });
              return;
            }

            nextItems.push(item);
          });

          if (!insertedTopic) {
            nextItems.push(nextTopic);
          }

          nextCanvasItemsSnapshot = nextItems;
          topicToExpandId = newTopicId;
          topicSummaryRefreshItemIds = [newTopicId];
          nextSelectedIdeationItemId = newTopicId;
          ideationMoveMessage = `"${targetTopic.title || "토픽"}"과 "${draggedTopic.title || "토픽"}"을 새 토픽으로 통합했습니다.`;
        }
      } else if (draggedItem && dropPreview?.mode === "topic-idea-merge") {
        const draggedTopic = isTopicCanvasItem(draggedItem) ? draggedItem : null;
        const targetItem = canvasItems.find((item) => item.id === dropPreview.targetId && !isTopicCanvasItem(item)) || null;
        if (draggedTopic && targetItem) {
          const newTopicId = `user-topic-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextAgendaId = dropPreview.agendaId || targetItem.agenda_id || draggedTopic.agenda_id;
          const removedTopicIds = new Set([
            draggedTopic.id,
            ...getTopicDescendantTopicIds(canvasItems, draggedTopic.id),
          ]);
          const childIds = [
            ...new Set([
              ...getTopicFlattenedIdeaChildIds(canvasItems, draggedTopic.id),
              targetItem.id,
            ]),
          ].filter((childId) => !removedTopicIds.has(childId));
          const childIdSet = new Set(childIds);
          const previousTargetParentTopicId =
            targetItem.parent_topic_id && targetItem.parent_topic_id !== draggedTopic.id
              ? targetItem.parent_topic_id
              : "";
          const previousParentRemainingChildIds = previousTargetParentTopicId
            ? getTopicFlattenedIdeaChildIds(canvasItems, previousTargetParentTopicId).filter(
                (childId) => !childIdSet.has(childId),
              )
            : [];
          const nextTopic: CanvasItemViewModel = {
            id: newTopicId,
            agenda_id: nextAgendaId,
            point_id: "",
            kind: "topic",
            status: "discussion",
            title: buildUserMergedTopicTitle(draggedTopic, targetItem),
            body: [draggedTopic.body, targetItem.body].filter(Boolean).join("\n") || "통합한 토픽의 내용을 정리해 주세요.",
            keywords: [...new Set([...(draggedTopic.keywords || []), ...(targetItem.keywords || [])])].slice(0, 5),
            key_evidence: [...new Set([...(draggedTopic.key_evidence || []), ...(targetItem.key_evidence || [])])].slice(0, 6),
            refined_utterances: [],
            evidence_utterance_ids: [
              ...new Set([...(draggedTopic.evidence_utterance_ids || []), ...(targetItem.evidence_utterance_ids || [])]),
            ],
            ignored_utterance_ids: [
              ...new Set([...(draggedTopic.ignored_utterance_ids || []), ...(targetItem.ignored_utterance_ids || [])]),
            ],
            merged_children: [],
            compacted_from_ids: [
              ...new Set([
                draggedTopic.id,
                targetItem.id,
                ...(draggedTopic.compacted_from_ids || []),
                ...(targetItem.compacted_from_ids || []),
                ...childIds,
              ]),
            ],
            compaction_level: Math.max(draggedTopic.compaction_level || 0, targetItem.compaction_level || 0) + 1,
            parent_topic_id: "",
            parent_topic_source: "",
            parent_topic_locked: false,
            child_item_ids: childIds,
            topic_collapsed: false,
            created_by: "user",
            manual_position: false,
            ai_generated: sharedSyncEnabled,
            user_edited: !sharedSyncEnabled,
            ai_pending: sharedSyncEnabled,
            x: undefined,
            y: undefined,
          };
          const targetIndex = canvasItems.findIndex((item) => item.id === targetItem.id);
          const draggedIndex = canvasItems.findIndex((item) => item.id === draggedTopic.id);
          const insertIndex = Math.max(0, Math.min(
            targetIndex >= 0 ? targetIndex : canvasItems.length,
            draggedIndex >= 0 ? draggedIndex : canvasItems.length,
          ));
          const nextItems: CanvasItemViewModel[] = [];
          let insertedTopic = false;

          canvasItems.forEach((item, index) => {
            if (index === insertIndex && !insertedTopic) {
              nextItems.push(nextTopic);
              insertedTopic = true;
            }

            if (removedTopicIds.has(item.id)) {
              return;
            }

            if (childIdSet.has(item.id)) {
              nextItems.push({
                ...item,
                agenda_id: nextAgendaId,
                parent_topic_id: newTopicId,
                parent_topic_source: "user",
                parent_topic_locked: true,
                manual_position: false,
                x: undefined,
                y: undefined,
              });
              return;
            }

            if (isTopicCanvasItem(item)) {
              const remainingChildIds = (item.child_item_ids || []).filter(
                (id) => !childIdSet.has(id) && !removedTopicIds.has(id),
              );
              nextItems.push({
                ...item,
                child_item_ids: remainingChildIds,
                ...(item.id === previousTargetParentTopicId && previousParentRemainingChildIds.length > 0 && sharedSyncEnabled
                  ? {
                      ai_pending: true,
                      ai_generated: true,
                      user_edited: false,
                    }
                  : {}),
              });
              return;
            }

            nextItems.push(item);
          });

          if (!insertedTopic) {
            nextItems.push(nextTopic);
          }

          nextCanvasItemsSnapshot = nextItems;
          topicToExpandId = newTopicId;
          topicSummaryRefreshItemIds = [
            newTopicId,
            ...(previousTargetParentTopicId && previousParentRemainingChildIds.length > 0
              ? [previousTargetParentTopicId]
              : []),
          ];
          nextSelectedIdeationItemId = newTopicId;
          ideationMoveMessage = `"${draggedTopic.title || "토픽"}"과 "${targetItem.title || "대상 노드"}"를 새 토픽으로 통합했습니다.`;
        }
      } else if (draggedItem && dropPreview?.mode === "topic") {
        const targetGroup = canvasItems.find((item) => item.id === dropPreview.targetId) || null;
        if (targetGroup && targetGroup.id !== draggedItem.id) {
          const nextAgendaId = targetGroup.agenda_id || draggedItem.agenda_id;
          nextCanvasItemsSnapshot = canvasItems.map((item) =>
            item.id === canvasItemId
              ? {
                  ...item,
                  agenda_id: nextAgendaId,
                  parent_topic_id: targetGroup.id,
                  parent_topic_source: "user",
                  parent_topic_locked: true,
                  manual_position: false,
                  x: undefined,
                  y: undefined,
                }
              : item.id === targetGroup.id
                ? {
                    ...item,
                    child_item_ids: [...new Set([...(item.child_item_ids || []), canvasItemId])],
                    ...(isTopicCanvasItem(item) && sharedSyncEnabled
                      ? {
                          ai_pending: true,
                          ai_generated: true,
                          user_edited: false,
                        }
                      : {}),
                  }
              : item.child_item_ids?.includes(canvasItemId)
                ? {
                    ...item,
                    child_item_ids: (item.child_item_ids || []).filter((id) => id !== canvasItemId),
                  }
                : item,
          );
          topicToExpandId = targetGroup.id;
          topicSummaryRefreshItemIds = isTopicCanvasItem(targetGroup) ? [targetGroup.id] : [];
          ideationMoveMessage = `"${draggedItem.title || "노드"}"를 "${targetGroup.title || "그룹"}"에 추가했습니다.`;
        }
      } else if (draggedItem && dropPreview?.mode === "merge") {
        const targetItem = canvasItems.find((item) => item.id === dropPreview.targetId && !isTopicCanvasItem(item));
        if (targetItem && targetItem.id !== draggedItem.id) {
          const newTopicId = `user-topic-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
          const nextAgendaId = dropPreview.agendaId || targetItem.agenda_id || draggedItem.agenda_id;
          const childIds = [...new Set([targetItem.id, draggedItem.id])];
          const nextTopic: CanvasItemViewModel = {
            id: newTopicId,
            agenda_id: nextAgendaId,
            point_id: "",
            kind: "topic",
            status: "discussion",
            title: buildUserMergedTopicTitle(targetItem, draggedItem),
            body: "사용자가 직접 묶은 토픽입니다. 필요하면 제목과 내용을 수정해 주세요.",
            keywords: [...new Set([...(targetItem.keywords || []), ...(draggedItem.keywords || [])])].slice(0, 5),
            key_evidence: [],
            refined_utterances: [],
            evidence_utterance_ids: [],
            ignored_utterance_ids: [],
            merged_children: [],
            compacted_from_ids: childIds,
            compaction_level: Math.max(targetItem.compaction_level || 0, draggedItem.compaction_level || 0) + 1,
            parent_topic_id: "",
            parent_topic_source: "",
            parent_topic_locked: false,
            child_item_ids: childIds,
            topic_collapsed: false,
            created_by: "user",
            manual_position: false,
            ai_generated: sharedSyncEnabled,
            user_edited: !sharedSyncEnabled,
            ai_pending: sharedSyncEnabled,
            x: undefined,
            y: undefined,
          };
          const targetIndex = canvasItems.findIndex((item) => item.id === targetItem.id);
          const draggedIndex = canvasItems.findIndex((item) => item.id === draggedItem.id);
          const insertIndex = Math.max(0, Math.min(
            targetIndex >= 0 ? targetIndex : canvasItems.length,
            draggedIndex >= 0 ? draggedIndex : canvasItems.length,
          ));
          const nextItems: CanvasItemViewModel[] = [];
          canvasItems.forEach((item, index) => {
            if (index === insertIndex) {
              nextItems.push(nextTopic);
            }

            if (childIds.includes(item.id)) {
              nextItems.push({
                ...item,
                agenda_id: nextAgendaId,
                parent_topic_id: newTopicId,
                parent_topic_source: "user",
                parent_topic_locked: true,
                manual_position: false,
                x: undefined,
                y: undefined,
              });
              return;
            }

            if (isTopicCanvasItem(item)) {
              nextItems.push({
                ...item,
                child_item_ids: (item.child_item_ids || []).filter((id) => !childIds.includes(id)),
              });
              return;
            }

            nextItems.push(item);
          });
          if (insertIndex >= canvasItems.length) {
            nextItems.push(nextTopic);
          }

          nextCanvasItemsSnapshot = nextItems;
          topicToExpandId = newTopicId;
          topicSummaryRefreshItemIds = [newTopicId];
          nextSelectedIdeationItemId = newTopicId;
          ideationMoveMessage = `"${targetItem.title || "대상 노드"}"와 "${draggedItem.title || "노드"}"를 새 토픽으로 묶었습니다.`;
        }
      } else if (draggedItem && dropPreview?.mode === "detach") {
        const nextAgendaId = dropPreview.agendaId || draggedItem.agenda_id;
        nextCanvasItemsSnapshot = canvasItems.map((item) =>
          item.id === canvasItemId
            ? {
                ...item,
                agenda_id: nextAgendaId,
                parent_topic_id: "",
                parent_topic_source: "",
                parent_topic_locked: false,
                manual_position: false,
                x: undefined,
                y: undefined,
              }
            : item.child_item_ids?.includes(canvasItemId)
              ? {
                  ...item,
                child_item_ids: (item.child_item_ids || []).filter((id) => id !== canvasItemId),
              }
            : item,
        );
        nextSelectedIdeationItemId = canvasItemId;
        ideationMoveMessage = `"${draggedItem.title || "노드"}"를 왼쪽 캔버스의 1차 노드로 추가했습니다.`;
      }

      const nextStagePositions = {
        ...(nextPositionsSnapshot.ideation || {}),
      };
      delete nextStagePositions[node.id];
      nextPositionsSnapshot = {
        ...nextPositionsSnapshot,
        ideation: nextStagePositions,
      };

      if (nextCanvasItemsSnapshot) {
        setCanvasItems(nextCanvasItemsSnapshot);
      }
      if (topicToExpandId) {
        setTopicCollapsedOverrides((current) => {
          if (current[topicToExpandId] === false) return current;
          const next = {
            ...current,
            [topicToExpandId]: false,
          };
          writeTopicCollapseOverrides(meetingId, userId, next);
          return next;
        });
      }
      if (ideationMoveMessage) {
        setSelectedCanvasItemId(nextSelectedIdeationItemId);
        setSelectedNodeId(`canvas-item-${nextSelectedIdeationItemId}`);
        setActivityMessage(ideationMoveMessage);
      }
    }

    if (stage === "problem-definition" && node.id.startsWith("problem-discussion-")) {
      const discussionId = node.id.slice("problem-discussion-".length);
      const sourceDropTarget = findProblemSourceDropTarget(event.clientX, event.clientY, node.id);
      if (sourceDropTarget?.groupId && sourceDropTarget.nodeId) {
        let movedDiscussion: ProblemDiscussionViewModel | null = null;
        nextProblemGroupsSnapshot = problemGroups.map((group) => {
          const remaining = (group.discussion_items || []).filter((item) => {
            if (item.id !== discussionId) return true;
            movedDiscussion = {
              ...item,
              parent_group_id: sourceDropTarget.groupId,
              target_node_id: sourceDropTarget.nodeId,
              target_node_label: sourceDropTarget.nodeLabel,
              target_node_kind: sourceDropTarget.nodeKind,
            };
            return false;
          });
          return {
            ...group,
            discussion_items: remaining,
          };
        }).map((group) =>
          group.group_id === sourceDropTarget.groupId && movedDiscussion
            ? {
                ...group,
                discussion_items: [
                  ...(group.discussion_items || []),
                  movedDiscussion,
                ],
              }
            : group,
        );

        const nextStagePositions = {
          ...(nextPositionsSnapshot["problem-definition"] || {}),
        };
        delete nextStagePositions[node.id];
        nextPositionsSnapshot = {
          ...nextPositionsSnapshot,
          "problem-definition": nextStagePositions,
        };

        setProblemGroups(nextProblemGroupsSnapshot);
        setSelectedProblemGroupId(sourceDropTarget.groupId);
        setSelectedProblemSourceNodeId(sourceDropTarget.nodeId);
        setSelectedNodeId(`problem-${sourceDropTarget.groupId}`);
        setLeftPanelTab("detail");
        setActivityMessage(`의견 노드를 "${sourceDropTarget.nodeLabel || "선택한 노드"}"의 속한 의견으로 추가했습니다.`);
      } else {
      const nearestGroup = problemGroups
        .map((group) => {
          const groupNode = nodes.find((candidate) => candidate.id === `problem-${group.group_id}`);
          if (!groupNode) return null;
          const dx = node.position.x - groupNode.position.x;
          const dy = node.position.y - groupNode.position.y;
          return {
            group,
            distance: Math.hypot(dx, dy),
            inProblemLane: dx > 220 && dx < 760 && Math.abs(dy) < 380,
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (left!.inProblemLane !== right!.inProblemLane) return left!.inProblemLane ? -1 : 1;
          return left!.distance - right!.distance;
        })[0]?.group || null;

      if (nearestGroup) {
        let movedDiscussion: ProblemDiscussionViewModel | null = null;
        nextProblemGroupsSnapshot = problemGroups.map((group) => {
          const remaining = (group.discussion_items || []).filter((item) => {
            if (item.id !== discussionId) return true;
            movedDiscussion = {
              ...item,
              parent_group_id: nearestGroup.group_id,
            };
            return false;
          });
          return {
            ...group,
            discussion_items: remaining,
          };
        }).map((group) =>
          group.group_id === nearestGroup.group_id && movedDiscussion
            ? {
                ...group,
                discussion_items: [
                  ...(group.discussion_items || []),
                  movedDiscussion,
                ],
              }
            : group,
        );
        setProblemGroups(nextProblemGroupsSnapshot);
        setSelectedProblemGroupId(nearestGroup.group_id);
        setSelectedProblemSourceNodeId("");
        setActivityMessage(`의견 노드를 "${nearestGroup.topic}" 문제정의 아래로 이동했습니다.`);
      }
      }
    }

    nextPositionsSnapshot = normalizeCanvasNodePositionsForComputedIdeation(nextPositionsSnapshot);
    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      stage,
      canvasItems: nextCanvasItemsSnapshot || canvasItems,
      problemGroups: nextProblemGroupsSnapshot || problemGroups,
      nodePositions: nextPositionsSnapshot,
      importedState: persistedSharedImportedState,
    };
    console.info("[canvas drag stop] computed position", {
      meetingId,
      stage,
      nodeId: node.id,
      position: nextPositionsSnapshot[stage]?.[node.id],
      nodePositions: summarizeNodePositionsForDebug(nextPositionsSnapshot),
      renderedNodes: summarizeRenderedNodesForDebug(nodes),
    });
    setNodePositions(nextPositionsSnapshot);

    if (sharedSyncEnabled) {
      if (meetingId) {
        writeSharedWorkspaceSessionCache(
          meetingId,
          buildFullWorkspacePatchPayload({
            meetingId,
            meetingGoal: meetingGoalDraft,
            meetingGoalContext: meetingGoalContextDraft,
            stage,
            agendaOverrides,
          canvasItems: nextCanvasItemsSnapshot || canvasItems,
          customGroups,
          problemGroups: nextProblemGroupsSnapshot || problemGroups,
          solutionTopics,
            nodePositions: nextPositionsSnapshot,
            importedState: persistedSharedImportedState,
          }),
        );
      }
      forceBroadcastSharedCanvas({
        nodePositions: nextPositionsSnapshot,
        canvasItems: nextCanvasItemsSnapshot || undefined,
        problemGroups: nextProblemGroupsSnapshot || undefined,
      });
      if (meetingId) {
        const savePromise = saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          stage,
          canvas_items: nextCanvasItemsSnapshot
            ? serializeSharedCanvasItems(nextCanvasItemsSnapshot)
            : undefined,
          problem_groups: nextProblemGroupsSnapshot
            ? serializeSharedProblemGroups(nextProblemGroupsSnapshot)
            : undefined,
          node_positions: nextPositionsSnapshot,
          imported_state: persistedSharedImportedState,
        });
        void savePromise.catch((error) => {
          console.error("Failed to save shared node positions:", error);
        });
        const uniqueTopicSummaryRefreshItemIds = [...new Set(topicSummaryRefreshItemIds.filter(Boolean))];
        if (uniqueTopicSummaryRefreshItemIds.length > 0) {
          void savePromise
            .then(() => {
              uniqueTopicSummaryRefreshItemIds.forEach((topicItemId) => {
                void refreshCanvasTopicSummary(topicItemId);
              });
            })
            .catch(() => undefined);
        }
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removedIds = new Set(
      changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id),
    );
    if (selectedEdgeId && removedIds.has(selectedEdgeId)) {
      setSelectedEdgeId("");
    }
    setEdges((current) => applyEdgeChanges(changes, current));
  };

  const onConnect = (connection: Connection) => {
    const edgeId = `user-edge-${Date.now()}`;
    setSelectedEdgeId(edgeId);
    setEdges((current) => {
      const existingEdge = current.find(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.sourceHandle === connection.sourceHandle &&
          edge.targetHandle === connection.targetHandle,
      );
      if (existingEdge) {
        setSelectedEdgeId(existingEdge.id);
        return current;
      }

      return addEdge(
        {
          ...connection,
          id: edgeId,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#475569",
          },
          interactionWidth: 28,
          zIndex: 10,
          style: { stroke: "#475569", strokeOpacity: 0.95, strokeWidth: 2 },
        },
        current,
      );
    });
  };

  const handleDeleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId || !selectedEdge) return;

    const edgeData = (selectedEdge.data || {}) as CanvasEdgeData;
    if (edgeData.kind === "canvasItemLink" && edgeData.canvasItemId) {
      const nextCanvasItemsSnapshot = canvasItems.map((item) =>
        item.id === edgeData.canvasItemId
          ? {
              ...item,
              agenda_id: "",
              point_id: "",
            }
          : item,
      );

      setCanvasItems(nextCanvasItemsSnapshot);
      setSelectedCanvasItemId(edgeData.canvasItemId);
      setSelectedNodeId(`canvas-item-${edgeData.canvasItemId}`);
      setSelectedEdgeId("");
      setActivityMessage("노드 연결 정보와 연결선을 삭제했습니다.");

      if (sharedSyncEnabled) {
        latestSharedWorkspaceRef.current = {
          ...latestSharedWorkspaceRef.current,
          canvasItems: nextCanvasItemsSnapshot,
          importedState: persistedSharedImportedState,
        };
        forceBroadcastSharedCanvas({ canvasItems: nextCanvasItemsSnapshot });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
          }).catch((error) => {
            console.error("Failed to save shared canvas item link removal:", error);
          });
        }
      }
      return;
    }

    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId("");
    setActivityMessage("노드 연결을 삭제했습니다.");
  }, [
    canvasItems,
    forceBroadcastSharedCanvas,
    meetingId,
    persistedSharedImportedState,
    selectedEdge,
    selectedEdgeId,
    sharedSyncEnabled,
  ]);

  useEffect(() => {
    if (!selectedEdgeId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditableTarget =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        Boolean(target?.isContentEditable);

      if (isEditableTarget || (event.key !== "Delete" && event.key !== "Backspace")) {
        return;
      }

      event.preventDefault();
      handleDeleteSelectedEdge();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDeleteSelectedEdge, selectedEdgeId]);

  const handleDeletePersonalNote = (noteId: string) => {
    setPersonalNotes((prev) => prev.filter((item) => item.id !== noteId));
    if (pendingPersonalNoteLinkId === noteId) {
      setPendingPersonalNoteLinkId("");
    }
    if (editingPersonalNoteId === noteId) {
      setEditingPersonalNoteId("");
      setPersonalNoteDraftAgendaId("");
      setPersonalNoteDraftTitle("");
      setPersonalNoteDraftBody("");
    }
  };

  const handleStartAgendaEdit = () => {
    if (!selectedAgenda) return;
    setEditingAgendaId(selectedAgenda.id);
    setAgendaDraftTitle(selectedAgenda.title);
    setAgendaDraftKeywords((selectedAgenda.keywords || []).join(", "));
    setAgendaDraftSummary((selectedAgenda.summaryBullets || []).join("\n"));
  };

  const handleCancelAgendaEdit = () => {
    setEditingAgendaId("");
    setAgendaDraftTitle("");
    setAgendaDraftKeywords("");
    setAgendaDraftSummary("");
  };

  const handleSaveAgendaEdit = () => {
    if (!selectedAgenda) return;

    const nextTitle = agendaDraftTitle.trim() || selectedAgenda.title;
    const nextKeywords = agendaDraftKeywords
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const nextSummaryBullets = agendaDraftSummary
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    if (selectedAgenda.isCustom) {
      const nextCustomGroupsSnapshot = customGroups.map((group) =>
        group.id === selectedAgenda.id
          ? {
              ...group,
              title: nextTitle,
              keywords: nextKeywords,
              description:
                nextSummaryBullets.join("\n") ||
                group.description ||
                selectedAgenda.summaryBullets.join("\n"),
            }
          : group,
      );

      setCustomGroups(nextCustomGroupsSnapshot);
      setEditingAgendaId("");
      setAgendaDraftTitle("");
      setAgendaDraftKeywords("");
      setAgendaDraftSummary("");
      setActivityMessage("프로젝트 그룹 분류를 수정했습니다.");

      if (sharedSyncEnabled) {
        latestSharedWorkspaceRef.current = {
          ...latestSharedWorkspaceRef.current,
          customGroups: nextCustomGroupsSnapshot,
          importedState: persistedSharedImportedState,
        };
        forceBroadcastSharedCanvas({ customGroups: nextCustomGroupsSnapshot });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            custom_groups: serializeCustomGroups(nextCustomGroupsSnapshot),
          }).catch((error) => {
            console.error("Failed to save shared project group category edit:", error);
          });
        }
      }
      return;
    }

    let nextAgendaOverridesSnapshot: Record<string, AgendaOverride> | null = null;
    setAgendaOverrides((prev) => {
      nextAgendaOverridesSnapshot = {
        ...prev,
        [selectedAgenda.id]: {
          title: nextTitle,
          keywords: nextKeywords,
          summaryBullets:
            nextSummaryBullets.length > 0
              ? nextSummaryBullets
              : selectedAgenda.summaryBullets,
        },
      };
      return nextAgendaOverridesSnapshot;
    });
    setEditingAgendaId("");
    setAgendaDraftTitle("");
    setAgendaDraftKeywords("");
    setAgendaDraftSummary("");
    if (sharedSyncEnabled && nextAgendaOverridesSnapshot) {
      forceBroadcastSharedCanvas({ agendaOverrides: nextAgendaOverridesSnapshot });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          agenda_overrides: serializeAgendaOverrides(nextAgendaOverridesSnapshot),
        }).catch((error) => {
          console.error("Failed to save shared agenda overrides:", error);
        });
      }
    }
    setActivityMessage("안건 메모 내용을 수정했습니다.");
  };

  const handleStartCanvasItemEdit = () => {
    if (!selectedCanvasItem) return;
    setEditingCanvasItemId(selectedCanvasItem.id);
    setCanvasItemDraftTitle(selectedCanvasItem.title);
    setCanvasItemDraftBody(selectedCanvasItem.body || "");
  };

  const handleCancelCanvasItemEdit = () => {
    setEditingCanvasItemId("");
    setCanvasItemDraftTitle("");
    setCanvasItemDraftBody("");
  };

  const handleSaveCanvasItemEdit = () => {
    if (!selectedCanvasItem) return;

    const nextTitle = canvasItemDraftTitle.trim() || selectedCanvasItem.title;
    const nextBody = canvasItemDraftBody.trim() || selectedCanvasItem.body || "";
    let nextCanvasItemsSnapshot: CanvasItemViewModel[] | null = null;

    setCanvasItems((prev) => {
      nextCanvasItemsSnapshot = prev.map((item) =>
        item.id === selectedCanvasItem.id
          ? {
              ...item,
              title: nextTitle,
              body: nextBody,
              user_edited: true,
            }
          : item,
      );
      return nextCanvasItemsSnapshot;
    });

    setEditingCanvasItemId("");
    setCanvasItemDraftTitle("");
    setCanvasItemDraftBody("");
    setActivityMessage("공용 canvas 아이템을 수정했습니다.");

    if (sharedSyncEnabled && nextCanvasItemsSnapshot) {
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        canvasItems: nextCanvasItemsSnapshot,
        importedState: persistedSharedImportedState,
      };
      forceBroadcastSharedCanvas({ canvasItems: nextCanvasItemsSnapshot });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
        }).catch((error) => {
          console.error("Failed to save shared canvas items:", error);
        });
      }
    }
  };

  const handleSetCanvasItemStatus = (
    status: CanvasItemStatus,
    targetItemId = selectedCanvasItem?.id || "",
    selectAfterChange = true,
  ) => {
    const targetItem = canvasItems.find((item) => item.id === targetItemId) || null;
    if (!targetItem || targetItem.parent_topic_id) return;

    const nextStatus = normalizeCanvasItemStatus(status);
    const nextCanvasItemsSnapshot = canvasItems.map((item) =>
      item.id === targetItem.id
        ? {
            ...item,
            status: nextStatus,
            user_edited: true,
          }
        : item,
    );

    setCanvasItems(nextCanvasItemsSnapshot);
    if (selectAfterChange) {
      setSelectedCanvasItemId(targetItem.id);
      setSelectedNodeId(`canvas-item-${targetItem.id}`);
    }
    setActivityMessage(`공용 canvas 아이템 상태를 "${canvasItemStatusLabel(nextStatus)}"로 변경했습니다.`);

    if (sharedSyncEnabled) {
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        canvasItems: nextCanvasItemsSnapshot,
        importedState: persistedSharedImportedState,
      };
      forceBroadcastSharedCanvas({ canvasItems: nextCanvasItemsSnapshot });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
        }).catch((error) => {
          console.error("Failed to save shared canvas item status:", error);
        });
      }
    }
  };

  const handleExtractCanvasItemKeywords = (targetItemId?: string) => {
    if (isEditingSelectedCanvasItem) return;

    const itemId =
      targetItemId ||
      extractCanvasItemIdFromNodeId(selectedNodeId) ||
      selectedCanvasItemId ||
      selectedCanvasItem?.id ||
      "";
    const targetItem = canvasItems.find((item) => item.id === itemId);
    if (!targetItem) {
      setActivityMessage("키워드를 추출할 canvas 아이템을 먼저 선택해 주세요.");
      return;
    }

    const nextKeywords = extractCanvasItemKeywords(targetItem.title, targetItem.body || "", 5);
    if (nextKeywords.length === 0) {
      setActivityMessage("키워드로 추출할 내용이 부족합니다.");
      return;
    }

    const nextCanvasItemsSnapshot = canvasItems.map((item) =>
      item.id === itemId
        ? {
            ...item,
            keywords: nextKeywords,
          }
        : item,
    );

    setCanvasItems(nextCanvasItemsSnapshot);
    setSelectedCanvasItemId(itemId);
    setSelectedNodeId(`canvas-item-${itemId}`);
    setActivityMessage("공용 canvas 아이템의 키워드를 추출했습니다.");

    if (sharedSyncEnabled) {
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        canvasItems: nextCanvasItemsSnapshot,
        importedState: persistedSharedImportedState,
      };
      forceBroadcastSharedCanvas({ canvasItems: nextCanvasItemsSnapshot });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
        }).catch((error) => {
          console.error("Failed to save shared canvas item keywords:", error);
        });
      }
    }
  };

  const handleDeleteCanvasItem = () => {
    if (!selectedCanvasItem) return;

    const nodeId = `canvas-item-${selectedCanvasItem.id}`;
    const nextCanvasItemsSnapshot = canvasItems.filter((item) => item.id !== selectedCanvasItem.id);
    const ideationPositions = { ...(nodePositions.ideation || {}) };
    delete ideationPositions[nodeId];
    const nextNodePositionsSnapshot: CanvasNodePositionsByStage = normalizeCanvasNodePositionsForComputedIdeation({
      ...nodePositions,
      ideation: ideationPositions,
    });
    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      canvasItems: nextCanvasItemsSnapshot,
      nodePositions: nextNodePositionsSnapshot,
      importedState: persistedSharedImportedState,
    };

    setCanvasItems(nextCanvasItemsSnapshot);
    setNodePositions(nextNodePositionsSnapshot);

    setSelectedCanvasItemId("");
    setSelectedNodeId("");
    setEditingCanvasItemId("");
    setCanvasItemDraftTitle("");
    setCanvasItemDraftBody("");
    setActivityMessage("공용 canvas 아이템을 삭제했습니다.");

    if (sharedSyncEnabled) {
      if (meetingId) {
        writeSharedWorkspaceSessionCache(
          meetingId,
          buildFullWorkspacePatchPayload({
            meetingId,
            meetingGoal: meetingGoalDraft,
            meetingGoalContext: meetingGoalContextDraft,
            stage,
            agendaOverrides,
            canvasItems: nextCanvasItemsSnapshot,
            customGroups,
            problemGroups,
            solutionTopics,
            nodePositions: nextNodePositionsSnapshot,
            importedState: persistedSharedImportedState,
          }),
        );
      }
      forceBroadcastSharedCanvas({
        canvasItems: nextCanvasItemsSnapshot,
        nodePositions: nextNodePositionsSnapshot,
      });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
          node_positions: nextNodePositionsSnapshot,
        }).catch((error) => {
          console.error("Failed to delete shared canvas item:", error);
        });
      }
    }
  };

  const handleStartPersonalNoteEdit = (note: PersonalNote) => {
    setEditingPersonalNoteId(note.id);
    setPersonalNoteDraftAgendaId(note.agendaId);
    setPersonalNoteDraftTitle(note.title);
    setPersonalNoteDraftBody(note.body);
  };

  const handleCancelPersonalNoteEdit = () => {
    setEditingPersonalNoteId("");
    setPersonalNoteDraftAgendaId("");
    setPersonalNoteDraftTitle("");
    setPersonalNoteDraftBody("");
  };

  const handleSavePersonalNoteEdit = (noteId: string) => {
    setPersonalNotes((prev) =>
      prev.map((note) =>
        note.id === noteId
          ? {
              ...note,
              agendaId: personalNoteDraftAgendaId || note.agendaId,
              title: personalNoteDraftTitle.trim() || note.title,
              body: personalNoteDraftBody.trim() || note.body,
            }
          : note,
      ),
    );
    setEditingPersonalNoteId("");
    setPersonalNoteDraftAgendaId("");
    setPersonalNoteDraftTitle("");
    setPersonalNoteDraftBody("");
    setActivityMessage("개인 메모를 수정했습니다.");
  };

  const handleStartProblemGroupEdit = () => {
    if (!selectedProblemGroup) return;
    setEditingProblemGroupId(selectedProblemGroup.group_id);
    setProblemGroupDraftTopic(selectedProblemGroup.topic);
    setProblemGroupDraftInsight(selectedProblemGroup.insight_lens || "");
    setProblemGroupDraftConclusion(selectedProblemGroup.conclusion);
  };

  const handleCancelProblemGroupEdit = () => {
    setEditingProblemGroupId("");
    setProblemGroupDraftTopic("");
    setProblemGroupDraftInsight("");
    setProblemGroupDraftConclusion("");
  };

  const handleSaveProblemGroupEdit = () => {
    if (!selectedProblemGroup) return;

    const nextTopic = problemGroupDraftTopic.trim() || selectedProblemGroup.topic;
    const nextInsight = problemGroupDraftInsight.trim() || selectedProblemGroup.insight_lens || "";
    const nextConclusion = problemGroupDraftConclusion.trim() || selectedProblemGroup.conclusion;
    const insightEdited = nextInsight !== (selectedProblemGroup.insight_lens || "");
    const conclusionEdited = nextConclusion !== selectedProblemGroup.conclusion;

    setProblemGroups((prev) =>
      prev.map((group) =>
        group.group_id === selectedProblemGroup.group_id
          ? {
              ...group,
              topic: nextTopic,
              insight_lens: nextInsight,
              insight_user_edited: group.insight_user_edited || insightEdited,
              conclusion: nextConclusion,
              conclusion_user_edited: group.conclusion_user_edited || conclusionEdited,
            }
          : group,
      ),
    );
    setEditingProblemGroupId("");
    setProblemGroupDraftTopic("");
    setProblemGroupDraftInsight("");
    setProblemGroupDraftConclusion("");
    setActivityMessage("문제 정의 그룹 내용을 수정했습니다.");
  };

  const handleSetProblemGroupStatus = (status: ProblemGroupStatus) => {
    if (!selectedProblemGroup) return;

    setProblemGroups((prev) =>
      prev.map((group) =>
        group.group_id === selectedProblemGroup.group_id
          ? {
              ...group,
              status,
            }
          : group,
      ),
    );
    setActivityMessage(`문제 정의 그룹 상태를 ${problemGroupStatusLabel(status)}로 변경했습니다.`);
  };

  const handleStartSolutionTopicEdit = () => {
    if (!selectedSolutionTopic) return;
    setEditingSolutionTopicId(selectedSolutionTopic.group_id);
    setSolutionTopicDraftTitle(selectedSolutionTopic.topic);
    setSolutionTopicDraftConclusion(selectedSolutionTopic.conclusion);
    setSolutionTopicDraftIdeas((selectedSolutionTopic.ai_suggestions || []).map((item) => item.text).join("\n"));
  };

  const handleCancelSolutionTopicEdit = () => {
    setEditingSolutionTopicId("");
    setSolutionTopicDraftTitle("");
    setSolutionTopicDraftConclusion("");
    setSolutionTopicDraftIdeas("");
  };

  const handleSaveSolutionTopicEdit = () => {
    if (!selectedSolutionTopic) return;

    const nextTitle = solutionTopicDraftTitle.trim() || selectedSolutionTopic.topic;
    const nextConclusion = solutionTopicDraftConclusion.trim() || selectedSolutionTopic.conclusion;
    const nextIdeas = solutionTopicDraftIdeas
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    setSolutionTopics((prev) =>
      prev.map((topic) =>
        topic.group_id === selectedSolutionTopic.group_id
          ? {
              ...topic,
              topic: nextTitle,
              conclusion: nextConclusion,
              ideas: nextIdeas.length > 0 ? nextIdeas : topic.ideas,
              ai_suggestions:
                nextIdeas.length > 0
                  ? nextIdeas.map((text, index) => {
                      const existing = topic.ai_suggestions[index];
                      return makeSolutionAiSuggestion(
                        {
                          id: existing?.id,
                          text,
                          status: existing?.status,
                        },
                        `${topic.group_id}-ai-${index + 1}`,
                      );
                    })
                  : topic.ai_suggestions,
            }
          : topic,
      ),
    );
    setEditingSolutionTopicId("");
    setSolutionTopicDraftTitle("");
    setSolutionTopicDraftConclusion("");
    setSolutionTopicDraftIdeas("");
    setActivityMessage("해결책 그룹 내용을 수정했습니다.");
  };

  const handleSetSolutionTopicStatus = (status: ProblemGroupStatus) => {
    if (!selectedSolutionTopic) return;

    setSolutionTopics((prev) =>
      prev.map((topic) =>
        topic.group_id === selectedSolutionTopic.group_id
          ? {
              ...topic,
              status,
            }
          : topic,
      ),
    );
    setActivityMessage(`해결책 그룹 상태를 ${problemGroupStatusLabel(status)}로 변경했습니다.`);
  };

  const handleAdoptAiSuggestion = (topicId: string, suggestionId: string) => {
    setSolutionTopics((prev) =>
      prev.map((topic) => {
        if (topic.group_id !== topicId) {
          return topic;
        }

        const suggestion = topic.ai_suggestions.find((item) => item.id === suggestionId);
        if (!suggestion) return topic;

        const nextSuggestions: SolutionAiSuggestionViewModel[] = topic.ai_suggestions.map((item) =>
          item.id === suggestionId
            ? makeSolutionAiSuggestion({ ...item, status: "selected" }, item.id)
            : makeSolutionAiSuggestion(item, item.id),
        );
        const hasExistingNote = topic.notes.some((note) => note.source_ai_id === suggestionId);
        const nextNotes: SolutionNoteViewModel[] = hasExistingNote
          ? topic.notes
          : [
              ...topic.notes,
              makeSolutionNote(
                {
                  text: suggestion.text,
                  source: "ai",
                  source_ai_id: suggestionId,
                  is_final_candidate: false,
                  final_comment: "",
                },
                `solution-note-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
              ),
            ];

        return {
          ...topic,
          ai_suggestions: nextSuggestions,
          notes: nextNotes,
        };
      }),
    );
    setActivityMessage("AI 제안 아이디어를 메모로 채택했습니다.");
  };

  const handleAddSolutionUserNote = () => {
    if (!selectedSolutionTopic) return;
    const nextText = solutionNoteDraft.trim();
    if (!nextText) {
      setActivityMessage("먼저 추가할 메모 내용을 입력해 주세요.");
      return;
    }

    setSolutionTopics((prev) =>
      prev.map((topic) =>
        topic.group_id === selectedSolutionTopic.group_id
          ? {
              ...topic,
              notes: [
                ...topic.notes,
                makeSolutionNote(
                  {
                    text: nextText,
                    source: "user",
                    source_ai_id: "",
                    is_final_candidate: false,
                    final_comment: "",
                  },
                  `solution-user-note-${Date.now()}`,
                ),
              ],
            }
          : topic,
      ),
    );
    setSolutionNoteDraft("");
    setActivityMessage("사용자 메모를 해결책 카드에 추가했습니다.");
  };

  const handleToggleFinalSolutionNote = (topicId: string, noteId: string) => {
    setSolutionTopics((prev) => {
      const nextSolutionTopics = prev.map((topic) =>
        topic.group_id === topicId
          ? {
              ...topic,
              notes: topic.notes.map((note) =>
                note.id === noteId
                  ? makeSolutionNote(
                      {
                        ...note,
                        is_final_candidate: !note.is_final_candidate,
                      },
                      note.id,
                    )
                  : makeSolutionNote(note, note.id),
              ),
            }
          : topic,
      );
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage,
        solutionTopics: nextSolutionTopics,
        importedState: persistedSharedImportedState,
      };
      return nextSolutionTopics;
    });
  };

  const startPanelResize = (side: "left" | "right") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isDesktopLayout) return;
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startRatio: side === "left" ? leftPanelRatio : rightPanelRatio,
    };
  };

  useEffect(() => {
    if (stage !== "problem-definition") {
      autoProblemDefinitionRef.current = false;
      return;
    }
    if (problemGroups.length > 0 || busy || agendaModels.length === 0 || autoProblemDefinitionRef.current) {
      return;
    }

    autoProblemDefinitionRef.current = true;
    void handleGenerateProblemDefinition();
  }, [agendaModels.length, busy, handleGenerateProblemDefinition, problemGroups.length, stage]);

  const handleStopRecordingClick = async () => {
    await onStopRecording?.();
    await flushIdeaAssimilationBuffer("manual");
    await flushProblemDiscussionBuffer("manual");
  };

  const getEndingSolutionTopicsSnapshot = () =>
    latestSharedWorkspaceRef.current.solutionTopics.length > 0
      ? latestSharedWorkspaceRef.current.solutionTopics
      : solutionTopics;

  const handleEndMeetingClick = async () => {
    await flushIdeaAssimilationBuffer("stage-change");
    await flushProblemDiscussionBuffer("stage-change");

    const endingSolutionTopics = getEndingSolutionTopicsSnapshot();
    const finalSolutionSummary = buildFinalSolutionSummaryPayload(endingSolutionTopics);
    setEndMeetingPreview({
      finalCount: finalSolutionSummary.final_count,
      topicCount: finalSolutionSummary.topics.length,
      solutionTopics: endingSolutionTopics,
    });
    setEndMeetingConfirmOpen(true);
  };

  const handleCancelEndMeeting = () => {
    if (endMeetingSaving) return;
    setEndMeetingConfirmOpen(false);
    setEndMeetingPreview(null);
  };

  const handleConfirmEndMeeting = async () => {
    if (endMeetingSaving) return;
    setEndMeetingSaving(true);

    let endingSolutionTopics = endMeetingPreview?.solutionTopics || getEndingSolutionTopicsSnapshot();
    if (endingSolutionTopics.some((topic) => topic.ai_suggestions.some((suggestion) => suggestion.status !== "selected"))) {
      endingSolutionTopics = await handlePruneSolutionSuggestions("", true, endingSolutionTopics);
    }
    if (meetingId) {
      const finalSolutionSummary = buildFinalSolutionSummaryPayload(endingSolutionTopics);
      try {
        await saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          solution_topics: serializeSharedSolutionTopics(endingSolutionTopics),
          final_solution_summary: finalSolutionSummary,
          imported_state: persistedSharedImportedState,
        });
      } catch (error) {
        console.error("Failed to save final solution summary before ending meeting:", error);
        alert("최종 결과 저장에 실패했습니다. 결과 확인에 표시되지 않을 수 있어 회의 종료를 중단했습니다.");
        setEndMeetingSaving(false);
        return;
      }
    }

    try {
      await onEndMeeting?.();
      setEndMeetingConfirmOpen(false);
      setEndMeetingPreview(null);
    } catch (error) {
      console.error("Failed to end meeting after final summary save:", error);
      alert("회의 종료에 실패했습니다.");
    } finally {
      setEndMeetingSaving(false);
    }
  };

  const handleOpenMeetingGoalEditor = () => {
    setMeetingGoalEditorDraft(meetingGoalDraft);
    setMeetingGoalContextEditorDraft(meetingGoalContextDraft);
    setMeetingGoalEditorOpen(true);
  };

  const handleCancelMeetingGoalEdit = () => {
    setMeetingGoalEditorDraft(meetingGoalDraft);
    setMeetingGoalContextEditorDraft(meetingGoalContextDraft);
    setMeetingGoalEditorOpen(false);
  };

  const handleSaveMeetingGoalEdit = async () => {
    if (!meetingId || meetingGoalSaving) {
      return;
    }

    const nextGoal = meetingGoalEditorDraft.trim();
    const nextContext = meetingGoalContextEditorDraft.trim();
    setMeetingGoalSaving(true);

    try {
      setMeetingGoalDraft(nextGoal);
      setMeetingGoalContextDraft(nextContext);
      onMeetingGoalChange(nextGoal);
      onMeetingGoalContextChange(nextContext);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        meetingGoal: nextGoal,
        meetingGoalContext: nextContext,
      };

      await saveCanvasWorkspacePatch({
        meeting_id: meetingId,
        meeting_goal: nextGoal,
        meeting_goal_context: nextContext,
      });

      lastWorkspaceFieldSignaturesRef.current = {
        ...lastWorkspaceFieldSignaturesRef.current,
        meeting_goal: nextGoal,
        meeting_goal_context: nextContext,
      };
      onMeetingGoalSync?.(nextGoal, nextContext);
      setMeetingGoalEditorOpen(false);
      setActivityMessage("회의 목표와 관련 맥락을 저장하고 참가자에게 반영했습니다.");
    } catch (error) {
      console.error("Failed to save meeting goal:", error);
      setActivityMessage("회의 목표 저장에 실패했습니다.");
    } finally {
      setMeetingGoalSaving(false);
    }
  };

  const onNodeDrag = (event: React.MouseEvent, node: Node) => {
    if (stage === "ideation" && node.id.startsWith("canvas-item-")) {
      event.stopPropagation();
      setIdeationDragGhost({
        itemId: node.id.slice("canvas-item-".length),
        x: event.clientX,
        y: event.clientY,
      });
      const stablePosition = getStableIdeationDragPosition(event, node);
      const dragNode = {
        ...node,
        position: stablePosition,
      };
      setNodes((current) => {
        const targetNode = current.find((item) => item.id === node.id);
        if (!targetNode || positionsEqual(targetNode.position, stablePosition)) {
          return current;
        }

        return current.map((item) =>
          item.id === node.id
            ? {
                ...item,
                position: stablePosition,
              }
            : item,
        );
      });

      const nextPreview = resolveIdeationDropPreview(event.clientX, event.clientY, dragNode);
      ideationDropPreviewRef.current = nextPreview;
      setIdeationDropPreview((current) =>
        current?.draggedItemId === nextPreview?.draggedItemId &&
        current?.targetId === nextPreview?.targetId &&
        current?.mode === nextPreview?.mode &&
        current?.agendaId === nextPreview?.agendaId &&
        current?.position.x === nextPreview?.position.x &&
        current?.position.y === nextPreview?.position.y
          ? current
          : nextPreview,
      );
      setProblemDropHighlight(null);
      return;
    }

    if (stage !== "problem-definition" || !node.id.startsWith("problem-discussion-")) {
      setProblemDropHighlight(null);
      ideationDropPreviewRef.current = null;
      setIdeationDropPreview(null);
      setIdeationDragGhost(null);
      return;
    }

    setProblemDropHighlight(findProblemSourceDropTarget(event.clientX, event.clientY, node.id));
  };

  const onNodeDragStart = (event: React.MouseEvent, node: Node) => {
    ideationDropPreviewRef.current = null;
    setIdeationDropPreview(null);

    if (stage === "ideation" && node.id.startsWith("canvas-item-")) {
      event.stopPropagation();
      setIdeationNodeDragActive(true);
      setIdeationDragGhost({
        itemId: node.id.slice("canvas-item-".length),
        x: event.clientX,
        y: event.clientY,
      });
      stableIdeationDragRef.current = {
        nodeId: node.id,
        anchor: {
          x: CANVAS_ITEM_NODE_WIDTH / 2,
          y: 64,
        },
      };
      const stablePosition = getStableIdeationDragPosition(event, node);
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id
            ? {
                ...item,
                position: stablePosition,
              }
            : item,
        ),
      );
      agendaDragPreviewRef.current = null;
      setAgendaDragPreview(null);
      return;
    }

    stableIdeationDragRef.current = null;
    setIdeationNodeDragActive(false);
    setIdeationDragGhost(null);

    if (stage !== "ideation" || !node.id.startsWith("agenda-")) {
      agendaDragPreviewRef.current = null;
      setAgendaDragPreview(null);
      return;
    }

    const agendaId = node.id.slice("agenda-".length);
    const nextPreview = {
      agendaId,
      originPosition: nodePositions.ideation?.[node.id] || node.position,
    };
    agendaDragPreviewRef.current = nextPreview;
    setAgendaDragPreview(nextPreview);
  };

  const canvasStatusMessage = activityMessage || audioImportStatusText || recordingStatusText;
  const rightDrawerShowsDetailPanel = stage === "ideation";
  const rightDrawerExpandedWidth = `clamp(17.5rem, ${(rightPanelRatio * 100).toFixed(2)}vw, 23.75rem)`;
  const rightDrawerBodyClassName = rightDrawerContentVisible
    ? `imms-drawer-body imms-overlay-scroll box-border h-full translate-x-0 overflow-y-auto px-[clamp(1rem,1.6vw,1.35rem)] py-[clamp(1rem,2vh,1.5rem)] opacity-100 xl:overflow-y-auto ${
        rightDrawerShowsDetailPanel ? "max-h-[min(48vh,500px)] xl:max-h-none" : "max-h-none"
      }`
    : `imms-drawer-body ${rightDrawerCollapsed ? "hidden " : ""}pointer-events-none translate-x-8 opacity-0`;
  const rightDrawerBodyStyle = isDesktopLayout && !rightDrawerCollapsed
    ? { width: rightDrawerExpandedWidth }
    : undefined;
  const rightDrawerWrapperClassName = `imms-drawer-pane imms-side-panel relative order-2 flex min-h-[min(34vh,420px)] flex-col overflow-visible border-b border-black/10 shadow-[inset_1px_0_0_rgba(0,0,0,0.04)] xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:min-h-0 xl:border-b-0 ${rightDrawerCollapsed ? "border border-black/10 bg-[#f7f8fb]" : "bg-white"}`;
  const rightDrawerPanelStackClassName = "flex min-h-0 flex-1 flex-col overflow-hidden";
  const rightDrawerTopPanelClassName = "imms-drawer-pane imms-side-panel imms-left-panel relative min-h-[min(34vh,420px)] flex-1 overflow-hidden bg-transparent";
  const rightDrawerToggleClassName = `pointer-events-auto absolute top-1/2 z-50 flex h-[clamp(2.25rem,3vw,2.75rem)] w-[clamp(2.25rem,3vw,2.75rem)] items-center justify-center rounded-full border border-black/10 bg-white text-[#4d4d4d] shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-all duration-300 hover:bg-[#f5f6f8] ${
    rightDrawerCollapsed ? "left-1/2 -translate-x-1/2 -translate-y-1/2" : "left-0 -translate-x-1/2 -translate-y-1/2"
  }`;
  const rightDrawerToggleIconClassName = `h-5 w-5 transition-transform duration-200 ${rightDrawerCollapsed ? "" : "rotate-180"}`;
  const rightDrawerResizeHandleClassName = "absolute left-[-7px] top-0 hidden h-full w-4 cursor-ew-resize xl:block";
  const rightDrawerBottomPanelClassName = `imms-drawer-pane imms-side-panel imms-right-panel relative flex-1 overflow-hidden bg-transparent ${
    rightDrawerShowsDetailPanel ? "min-h-[min(34vh,420px)] max-h-[min(48vh,500px)] xl:min-h-0 xl:max-h-none" : "min-h-0 max-h-none"
  } ${
    rightDrawerCollapsed && !rightDrawerContentVisible
      ? "hidden pointer-events-none -translate-x-8 px-0 py-0 opacity-0"
      : `${rightDrawerShowsDetailPanel ? "border-t-4 border-[#d5d5d5]" : ""} translate-x-0 opacity-100`
  }`;
  const workspaceGridColumns = rightDrawerCollapsed
    ? "minmax(0, 1fr) clamp(3.5rem, 4.2vw, 4.5rem)"
    : `minmax(0, 1fr) ${rightDrawerExpandedWidth}`;
  const selectedAgendaForIdeationCanvas = selectedAgendaId || agendaModels[0]?.id || "";
  const selectedRootItemForIdeationCanvas = useMemo(() => {
    if (stage !== "ideation" || !selectedCanvasItemId) return null;
    const rootId = getCanvasItemTopLevelAncestorId(canvasItems, selectedCanvasItemId);
    const rootItem = canvasItems.find((item) => item.id === rootId) || null;
    return rootItem?.agenda_id === selectedAgendaForIdeationCanvas ? rootItem : null;
  }, [canvasItems, selectedAgendaForIdeationCanvas, selectedCanvasItemId, stage]);
  const latestDiscussionRootItem = useMemo(() => {
    if (!latestHighlightedTopicId) return null;
    const latestItem = canvasItems.find((item) => item.id === latestHighlightedTopicId) || null;
    if (!latestItem) return null;
    const rootId = getCanvasItemTopLevelAncestorId(canvasItems, latestItem.id);
    return canvasItems.find((item) => item.id === rootId) || latestItem;
  }, [canvasItems, latestHighlightedTopicId]);
  const ideationSplitNodes = useMemo(() => {
    if (stage !== "ideation") {
      return { left: [] as Node[], right: [] as Node[] };
    }

    const topLevelIds = new Set(
      canvasItems
        .filter((item) => item.agenda_id === selectedAgendaForIdeationCanvas && !item.parent_topic_id)
        .map((item) => item.id),
    );
    const descendantIds = new Set(
      selectedRootItemForIdeationCanvas
        ? getCanvasItemDescendantIds(canvasItems, selectedRootItemForIdeationCanvas.id)
        : [],
    );

    const leftNodes = nodes.filter((node) => {
      if (node.id === "ideation-drop-placeholder") {
        return ideationDropPreview?.mode === "detach";
      }

      const canvasItemId = extractCanvasItemIdFromNodeId(node.id);
      return canvasItemId ? topLevelIds.has(canvasItemId) : false;
    });
    const rightNodes = nodes.filter((node) => {
      if (node.id === "ideation-drop-placeholder") {
        const targetItem = ideationDropPreview
          ? canvasItems.find((item) => item.id === ideationDropPreview.targetId) || null
          : null;
        if (!ideationDropPreview || !targetItem) {
          return false;
        }

        if (selectedRootItemForIdeationCanvas?.id === targetItem.id) {
          return true;
        }

        return Boolean(targetItem.parent_topic_id && descendantIds.has(targetItem.id));
      }

      const canvasItemId = extractCanvasItemIdFromNodeId(node.id);
      if (selectedRootItemForIdeationCanvas) {
        return canvasItemId ? descendantIds.has(canvasItemId) : node.id === "ideation-empty-detail";
      }
      return node.id.startsWith("agenda-");
    });

    return { left: leftNodes, right: rightNodes };
  }, [canvasItems, ideationDropPreview, nodes, selectedAgendaForIdeationCanvas, selectedRootItemForIdeationCanvas, stage]);
  const ideationRightTitle = selectedRootItemForIdeationCanvas ? "Detail Canvas" : "Group Selector";
  const ideationRightSubtitle = selectedRootItemForIdeationCanvas
    ? `${selectedRootItemForIdeationCanvas.title || "선택 그룹"} 하위 노드 전체`
    : "그룹분류를 선택하면 왼쪽 캔버스가 해당 그룹으로 바뀝니다.";
  const solutionSplitNodes = useMemo(() => {
    if (stage !== "solution") {
      return { left: [] as Node[], right: [] as Node[] };
    }
    const leftNodeIds = new Set(solutionTopics.map((topic) => `solution-${topic.group_id}`));

    return {
      left: nodes.filter((node) => leftNodeIds.has(node.id)),
      right: nodes.filter((node) => extractSolutionDetailTopicIdFromNodeId(node.id)),
    };
  }, [nodes, solutionTopics, stage]);
  const selectedIdeationSuggestions = selectedRootItemForIdeationCanvas?.ai_suggestions || [];
  const ideationSuggestionBusy =
    Boolean(selectedRootItemForIdeationCanvas) &&
    ideationSuggestionBusyRootId === selectedRootItemForIdeationCanvas?.id;
  const ideationSuggestionCollapsed =
    Boolean(selectedRootItemForIdeationCanvas) &&
    (ideationSuggestionCollapsedByRootId[selectedRootItemForIdeationCanvas?.id || ""] ?? true);
  const ideationDragGhostItem = useMemo(
    () =>
      ideationDragGhost
        ? canvasItems.find((item) => item.id === ideationDragGhost.itemId) || null
        : null,
    [canvasItems, ideationDragGhost],
  );

  const persistIdeationCanvasItems = (
    nextCanvasItemsSnapshot: CanvasItemViewModel[],
    message: string,
    selectedItemId = selectedCanvasItemId,
  ) => {
    const nextNodePositionsSnapshot = normalizeCanvasNodePositionsForComputedIdeation(nodePositions);

    setCanvasItems(nextCanvasItemsSnapshot);
    if (selectedItemId) {
      setSelectedCanvasItemId(selectedItemId);
      setSelectedNodeId(`canvas-item-${selectedItemId}`);
    }
    setActivityMessage(message);
    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      stage,
      canvasItems: nextCanvasItemsSnapshot,
      nodePositions: nextNodePositionsSnapshot,
      importedState: persistedSharedImportedState,
    };

    if (!sharedSyncEnabled) {
      return;
    }

    if (meetingId) {
      writeSharedWorkspaceSessionCache(
        meetingId,
        buildFullWorkspacePatchPayload({
          meetingId,
          meetingGoal: meetingGoalDraft,
          meetingGoalContext: meetingGoalContextDraft,
          stage,
          agendaOverrides,
          canvasItems: nextCanvasItemsSnapshot,
          customGroups,
          problemGroups,
          solutionTopics,
          nodePositions: nextNodePositionsSnapshot,
          importedState: persistedSharedImportedState,
        }),
      );
    }
    forceBroadcastSharedCanvas({
      canvasItems: nextCanvasItemsSnapshot,
      nodePositions: nextNodePositionsSnapshot,
    });
    if (meetingId) {
      void saveCanvasWorkspacePatch({
        meeting_id: meetingId,
        canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
        node_positions: nextNodePositionsSnapshot,
        imported_state: persistedSharedImportedState,
      }).catch((error) => {
        console.error("Failed to save shared ideation suggestions:", error);
      });
    }
  };

  const handleGenerateIdeationSuggestions = async () => {
    const rootItem = selectedRootItemForIdeationCanvas;
    if (!rootItem || !meetingId) {
      setActivityMessage("추천을 만들 topic을 먼저 선택해 주세요.");
      return;
    }

    const childItems = getCanvasItemDescendantIds(canvasItems, rootItem.id)
      .map((itemId) => canvasItems.find((item) => item.id === itemId) || null)
      .filter((item): item is CanvasItemViewModel => Boolean(item && !isTopicCanvasItem(item)))
      .slice(0, 12);

    setIdeationSuggestionBusyRootId(rootItem.id);
    setActivityMessage("AI 추천 아이디어를 생성하는 중입니다.");
    try {
      const result = await generateCanvasIdeationSuggestions({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        topic: {
          id: rootItem.id,
          title: rootItem.title,
          body: rootItem.body || "",
          keywords: rootItem.keywords || [],
        },
        child_items: childItems.map((item) => ({
          id: item.id,
          kind: item.kind || "note",
          title: item.title,
          body: item.body || "",
          keywords: item.keywords || [],
        })),
      });
      const existingByText = new Map(
        (rootItem.ai_suggestions || []).map((suggestion) => [suggestion.text.trim(), suggestion]),
      );
      const nextSuggestions: IdeationSuggestionViewModel[] = (result.suggestions || [])
        .map((suggestion, index) => {
          const text = (suggestion.text || "").trim();
          const existing = existingByText.get(text);
          return {
            id: suggestion.id || existing?.id || `ideation-suggestion-${Date.now()}-${index}`,
            text,
            status: normalizeIdeationSuggestionStatus(existing?.status || suggestion.status),
          };
        })
        .filter((suggestion) => suggestion.text)
        .slice(0, 5);
      const nextCanvasItemsSnapshot = canvasItems.map((item) =>
        item.id === rootItem.id
          ? {
              ...item,
              ai_suggestions: nextSuggestions,
            }
          : item,
      );
      persistIdeationCanvasItems(
        nextCanvasItemsSnapshot,
        result.warning || `AI 추천 아이디어 ${nextSuggestions.length}개를 생성했습니다.`,
        rootItem.id,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`AI 추천 아이디어 생성 실패: ${message}`);
    } finally {
      setIdeationSuggestionBusyRootId("");
    }
  };

  const handleAdoptIdeationSuggestion = (suggestionId: string) => {
    const rootItem = selectedRootItemForIdeationCanvas;
    if (!rootItem) return;
    const suggestion = (rootItem.ai_suggestions || []).find((item) => item.id === suggestionId);
    if (!suggestion || normalizeIdeationSuggestionStatus(suggestion.status) === "selected") return;

    const nextItemId = `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const titleSource = suggestion.text.split(/[.!?。！？\n]/)[0]?.trim() || suggestion.text;
    const title = titleSource.length > 26 ? `${titleSource.slice(0, 26)}...` : titleSource;
    const nextItem: CanvasItemViewModel = {
      id: nextItemId,
      agenda_id: rootItem.agenda_id,
      point_id: "",
      kind: "note",
      status: "discussion",
      title: title || "AI 추천 아이디어",
      body: suggestion.text,
      keywords: extractCanvasItemKeywords(title, suggestion.text, 5),
      key_evidence: [],
      refined_utterances: [],
      evidence_utterance_ids: [],
      ignored_utterance_ids: [],
      merged_children: [],
      compacted_from_ids: [],
      compaction_level: 0,
      parent_topic_id: rootItem.id,
      parent_topic_source: "user",
      parent_topic_locked: true,
      child_item_ids: [],
      topic_collapsed: false,
      created_by: "user",
      manual_position: false,
      ai_generated: true,
      user_edited: false,
      ai_pending: false,
      x: undefined,
      y: undefined,
    };
    const nextCanvasItemsSnapshot = [
      nextItem,
      ...canvasItems.map((item) =>
        item.id === rootItem.id
          ? {
              ...item,
              child_item_ids: [...new Set([...(item.child_item_ids || []), nextItemId])],
              ai_suggestions: (item.ai_suggestions || []).map((candidate) =>
                candidate.id === suggestionId
                  ? {
                      ...candidate,
                      status: "selected",
                    }
                  : candidate,
              ),
            }
          : item,
      ),
    ];
    persistIdeationCanvasItems(nextCanvasItemsSnapshot, "AI 추천 아이디어를 카드로 채택했습니다.", nextItemId);
  };

  const focusCanvasItemInIdeation = (itemId: string, reason = "원문 위치로 이동했습니다.") => {
    const item = canvasItems.find((candidate) => candidate.id === itemId) || null;
    if (!item) {
      setActivityMessage("연결된 원문 노드를 찾지 못했습니다.");
      return;
    }

    const rootId = getCanvasItemTopLevelAncestorId(canvasItems, item.id);
    setStage("ideation");
    setSelectedAgendaId(item.agenda_id || selectedAgendaId || agendaModels[0]?.id || "");
    setSelectedCanvasItemId(item.id);
    setSelectedNodeId(`canvas-item-${item.id}`);
    setSelectedProblemGroupId("");
    setSelectedProblemSourceNodeId("");
    setSelectedSolutionTopicId("");
    setSelectedEdgeId("");
    setLeftPanelTab("detail");
    setFocusedCanvasItemId(item.id);
    if (rootId && rootId !== item.id) {
      setLatestHighlightedTopicId(rootId);
    }
    setActivityMessage(reason);
  };

  const linkPendingPersonalNoteToCanvasItem = (item: CanvasItemViewModel) => {
    if (!pendingPersonalNoteLinkId) return false;

    if (isTopicCanvasItem(item)) {
      setActivityMessage("토픽 내용은 열어두고, 연결할 아이디어 노드를 선택해 주세요.");
      return false;
    }

    if (pendingPersonalNoteLinkId === COMPOSER_PERSONAL_NOTE_LINK_ID) {
      setComposerAgendaId(item.agenda_id || composerAgendaId);
      setComposerLinkedCanvasItemId(item.id);
      setComposerLinkedCanvasItemTitle(item.title || "연결 아이디어");
      setPendingPersonalNoteLinkId("");
      setFocusedCanvasItemId(item.id);
      setSelectedCanvasItemId(item.id);
      setSelectedNodeId(`canvas-item-${item.id}`);
      setActivityMessage("작성 중인 개인 메모에 연결할 아이디어를 선택했습니다.");
      return true;
    }

    setPersonalNotes((prev) =>
      prev.map((note) =>
        note.id === pendingPersonalNoteLinkId
          ? {
              ...note,
              agendaId: item.agenda_id || note.agendaId,
              linkedCanvasItemId: item.id,
              linkedCanvasItemTitle: item.title || "연결 아이디어",
            }
          : note,
      ),
    );
    setPendingPersonalNoteLinkId("");
    setFocusedCanvasItemId(item.id);
    setSelectedCanvasItemId(item.id);
    setSelectedNodeId(`canvas-item-${item.id}`);
    setActivityMessage("개인 메모를 선택한 아이디어 노드에 연결했습니다.");
    return true;
  };

  const handleMoveToCurrentDiscussionGroup = () => {
    if (!latestDiscussionRootItem) {
      setActivityMessage("아직 AI가 업데이트한 논의 그룹이 없습니다.");
      return;
    }

    setStage("ideation");
    setSelectedAgendaId(latestDiscussionRootItem.agenda_id || selectedAgendaId || agendaModels[0]?.id || "");
    setSelectedCanvasItemId(latestDiscussionRootItem.id);
    setSelectedNodeId(`canvas-item-${latestDiscussionRootItem.id}`);
    setSelectedProblemGroupId("");
    setSelectedProblemSourceNodeId("");
    setSelectedSolutionTopicId("");
    setSelectedEdgeId("");
    setFocusedCanvasItemId(latestDiscussionRootItem.id);
    setLatestHighlightedTopicId(latestDiscussionRootItem.id);
    setLeftPanelTab("detail");
    setActivityMessage("현재 논의 중인 그룹으로 이동했습니다.");
  };

  const handleCanvasNodeClick = (event: React.MouseEvent, node: Node) => {
    setSelectedEdgeId("");
    setSelectedNodeId(node.id);
    setLeftPanelTab("detail");
    openRightDrawer();
    const agendaId = extractAgendaIdFromNodeId(node.id);
    if (node.id.startsWith("canvas-item-")) {
      const canvasItemId = node.id.slice("canvas-item-".length);
      const canvasItem = canvasItems.find((item) => item.id === canvasItemId) || null;
      if (canvasItem && linkPendingPersonalNoteToCanvasItem(canvasItem)) {
        return;
      }
      setSelectedCanvasItemId(canvasItemId);
      setSelectedProblemGroupId("");
      setSelectedSolutionTopicId("");
      setEditingProblemGroupId("");
      setEditingSolutionTopicId("");
      if (canvasItem?.agenda_id) {
        setSelectedAgendaId(canvasItem.agenda_id);
      }
      if (
        armedCanvasTool &&
        stage === "ideation" &&
        (armedCanvasTool === "note" || armedCanvasTool === "comment") &&
        canvasItem &&
        !canvasItem.parent_topic_id
      ) {
        setActivityMessage("메모와 댓글은 오른쪽 상세 캔버스에서 추가해 주세요.");
        return;
      }
    } else {
      setSelectedCanvasItemId("");
    }
    if (node.id.startsWith("problem-discussion-")) {
      const discussionId = node.id.slice("problem-discussion-".length);
      const parentGroup = problemGroups.find((group) =>
        (group.discussion_items || []).some((item) => item.id === discussionId),
      );
      setSelectedProblemGroupId(parentGroup?.group_id || "");
      const discussion = parentGroup?.discussion_items?.find((item) => item.id === discussionId);
      setSelectedProblemSourceNodeId(discussion?.target_node_id || "");
      setSelectedSolutionTopicId("");
      setSelectedCanvasItemId("");
      setEditingProblemGroupId("");
    } else if (node.id.startsWith("problem-")) {
      setSelectedProblemGroupId(node.id.slice("problem-".length));
      setSelectedProblemSourceNodeId("");
      setSelectedSolutionTopicId("");
      setSelectedCanvasItemId("");
      setEditingProblemGroupId("");
    }
    const solutionDetailTopicId = extractSolutionDetailTopicIdFromNodeId(node.id);
    if (solutionDetailTopicId) {
      setSelectedSolutionTopicId(solutionDetailTopicId);
      setSelectedProblemGroupId("");
      setSelectedCanvasItemId("");
      setEditingSolutionTopicId("");
    } else if (node.id.startsWith("solution-")) {
      setSelectedSolutionTopicId(node.id.slice("solution-".length));
      setSelectedProblemGroupId("");
      setSelectedCanvasItemId("");
      setEditingSolutionTopicId("");
    }
    if (agendaId) {
      setSelectedAgendaId(agendaId);
    }
    if (armedCanvasTool) {
      void handleCanvasPlacementStart(
        armedCanvasTool,
        event.clientX,
        event.clientY,
        agendaId || selectedAgendaId || agendaModels[0]?.id,
        node.id,
      );
    }
  };

  const handleCanvasEdgeClick = (event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    setSelectedEdgeId(edge.id);
    setSelectedNodeId("");
    setSelectedCanvasItemId("");
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
  };

  const handleCanvasPaneClick = (
    event: React.MouseEvent,
    pane: "default" | "ideation-left" | "ideation-right" = "default",
  ) => {
    if (stage === "ideation" && pane === "ideation-right" && !armedCanvasTool) {
      return;
    }

    setSelectedEdgeId("");
    if (!armedCanvasTool) {
      closeRightDrawer();
      if (stage === "ideation" && pane === "ideation-left") {
        setSelectedCanvasItemId("");
        setSelectedNodeId("");
        setLeftPanelTab("detail");
      }
      return;
    }
    if (
      stage === "ideation" &&
      pane !== "ideation-right" &&
      (armedCanvasTool === "note" || armedCanvasTool === "comment")
    ) {
      setCanvasPlacementPreview(null);
      setActivityMessage("메모와 댓글은 오른쪽 상세 캔버스에서 추가해 주세요.");
      return;
    }
    setSelectedCanvasItemId("");
    void handleCanvasPlacementStart(
      armedCanvasTool,
      event.clientX,
      event.clientY,
      selectedAgendaId || agendaModels[0]?.id,
    );
  };

  const renderDetailHeaderSection = () => {
    if (!leftPanelDetail) return null;

    return (
      <section className="border-b border-slate-200/80 pb-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Detail</p>
            {isEditingSelectedAgenda || isEditingSelectedCanvasItem || isEditingSelectedProblemGroup || isEditingSelectedSolutionTopic ? (
              <input
                value={
                  isEditingSelectedAgenda
                    ? agendaDraftTitle
                    : isEditingSelectedCanvasItem
                    ? canvasItemDraftTitle
                    : isEditingSelectedProblemGroup
                    ? problemGroupDraftTopic
                    : solutionTopicDraftTitle
                }
                onChange={(event) => {
                  if (isEditingSelectedAgenda) {
                    setAgendaDraftTitle(event.target.value);
                    return;
                  }
                  if (isEditingSelectedCanvasItem) {
                    setCanvasItemDraftTitle(event.target.value);
                    return;
                  }
                  if (isEditingSelectedProblemGroup) {
                    setProblemGroupDraftTopic(event.target.value);
                    return;
                  }
                  setSolutionTopicDraftTitle(event.target.value);
                }}
                className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-lg font-semibold text-slate-900"
              />
            ) : (
              <h4 className="mt-3 text-xl font-semibold text-slate-900">{leftPanelDetail.title}</h4>
            )}
            <p className="mt-2 text-base text-slate-500">{leftPanelDetail.subtitle}</p>
          </div>
          {stage === "ideation" && selectedCanvasItem ? (
            <div className="flex shrink-0 gap-2">
              {isEditingSelectedCanvasItem ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelCanvasItemEdit}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCanvasItemEdit}
                    className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    저장
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleStartCanvasItemEdit}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteCanvasItem}
                    className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
                  >
                    삭제
                  </button>
                </>
              )}
            </div>
          ) : stage === "ideation" && selectedAgenda ? (
            <div className="flex shrink-0 gap-2">
              {isEditingSelectedAgenda ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelAgendaEdit}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveAgendaEdit}
                    className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    저장
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleStartAgendaEdit}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  수정
                </button>
              )}
            </div>
          ) : stage === "problem-definition" && selectedProblemGroup ? (
            <div className="flex shrink-0 gap-2">
              {isEditingSelectedProblemGroup ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelProblemGroupEdit}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveProblemGroupEdit}
                    className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    저장
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleStartProblemGroupEdit}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  수정
                </button>
              )}
            </div>
          ) : stage === "solution" && selectedSolutionTopic ? (
            <div className="flex shrink-0 gap-2">
              {isEditingSelectedSolutionTopic ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelSolutionTopicEdit}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveSolutionTopicEdit}
                    className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    저장
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleStartSolutionTopicEdit}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  수정
                </button>
              )}
            </div>
          ) : null}
        </div>
        {leftPanelDetail.badges.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {leftPanelDetail.badges.map((badge) => (
              <span key={`${leftPanelDetail.title}-${badge}`} className="rounded-full bg-white px-3 py-1 text-sm text-slate-600">
                {badge}
              </span>
            ))}
          </div>
        ) : null}
        {stage === "problem-definition" && selectedProblemGroup ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {(["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => handleSetProblemGroupStatus(status)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  selectedProblemGroup.status === status
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-100"
                }`}
              >
                {problemGroupStatusLabel(status)}
              </button>
            ))}
          </div>
        ) : stage === "solution" && selectedSolutionTopic ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {(["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => handleSetSolutionTopicStatus(status)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  selectedSolutionTopic.status === status
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-100"
                }`}
              >
                {problemGroupStatusLabel(status)}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  };

  const renderDetailKeywordSection = () => {
    if (!leftPanelDetail) return null;

    return (
      <section className="border-b border-slate-200/80 py-6">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-lg font-semibold text-slate-900">키워드</h4>
          {stage === "ideation" && selectedCanvasItem ? (
            <button
              type="button"
              onClick={() => handleExtractCanvasItemKeywords(selectedCanvasItem.id)}
              disabled={isEditingSelectedCanvasItem}
              title={isEditingSelectedCanvasItem ? "편집을 저장한 뒤 키워드를 추출할 수 있습니다." : "제목과 내용에서 키워드를 추출합니다."}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              키워드 추출
            </button>
          ) : null}
        </div>
        {isEditingSelectedAgenda ? (
          <>
            <input
              value={agendaDraftKeywords}
              onChange={(event) => setAgendaDraftKeywords(event.target.value)}
              placeholder="쉼표로 구분해 키워드를 입력합니다."
              className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base text-slate-700"
            />
            <p className="mt-3 text-sm leading-6 text-slate-500">예: 고객 경험, 협업 흐름, 실행 우선순위</p>
          </>
        ) : leftPanelDetail.keywords.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {leftPanelDetail.keywords.map((keyword) => (
              <span key={`${leftPanelDetail.title}-${keyword}`} className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                #{keyword}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-base leading-7 text-slate-500">아직 정리된 키워드가 없습니다.</p>
        )}
      </section>
    );
  };

  const renderProblemInsightSection = () => {
    if (stage !== "problem-definition" || !selectedProblemGroup) return null;

    return (
      <section className="border-b border-slate-200/80 py-6">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-lg font-semibold text-slate-900">Insight</h4>
          {selectedProblemGroup.insight_user_edited ? (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              수동 수정됨
            </span>
          ) : null}
        </div>
        {isEditingSelectedProblemGroup ? (
          <>
            <textarea
              value={problemGroupDraftInsight}
              onChange={(event) => setProblemGroupDraftInsight(event.target.value)}
              className="mt-4 min-h-[110px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
              placeholder="이 그룹의 인사이트를 직접 정리할 수 있습니다."
            />
            <p className="mt-3 text-sm leading-6 text-slate-500">
              저장하면 이 Insight는 이후 AI 재생성으로 덮어쓰지 않습니다.
            </p>
          </>
        ) : (
          <p className="mt-4 text-base leading-7 text-slate-500">
            Insight는 노드 내부에서 확인하고, 수정 모드에서 직접 편집할 수 있습니다.
          </p>
        )}
      </section>
    );
  };

  const renderDetailSummarySection = () => {
    if (!leftPanelDetail || stage === "solution") return null;

    return (
      <section className="border-b border-slate-200/80 py-6">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-lg font-semibold text-slate-900">
            {stage === "ideation"
              ? selectedCanvasItem
                ? "내용"
                : "요약"
              : "결론"}
          </h4>
          {stage === "problem-definition" && selectedProblemGroup?.conclusion_user_edited ? (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              수동 수정됨
            </span>
          ) : null}
        </div>
        {stage === "ideation" && isEditingSelectedAgenda ? (
          <>
            <textarea
              value={agendaDraftSummary}
              onChange={(event) => setAgendaDraftSummary(event.target.value)}
              className="mt-4 min-h-[180px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
              placeholder="한 줄에 하나씩 요약 또는 맥락을 입력합니다."
            />
            <p className="mt-3 text-sm leading-6 text-slate-500">
              줄 단위로 저장되며, ideation 안건 노드와 상세 맥락에 함께 반영됩니다.
            </p>
          </>
        ) : stage === "ideation" && isEditingSelectedCanvasItem ? (
          <>
            <textarea
              value={canvasItemDraftBody}
              onChange={(event) => setCanvasItemDraftBody(event.target.value)}
              className="mt-4 min-h-[180px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
              placeholder="공용 canvas 아이템 내용을 입력합니다."
            />
            <p className="mt-3 text-sm leading-6 text-slate-500">
              저장하면 선택한 공용 canvas 노드 본문이 바로 갱신됩니다.
            </p>
          </>
        ) : (
          <div className="mt-4 space-y-3">
            {leftPanelDetail.summaryItems.map((item, index) => (
              <div key={`${leftPanelDetail.title}-summary-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                {stage === "problem-definition" && index === 0 && isEditingSelectedProblemGroup ? (
                  <textarea
                    value={problemGroupDraftConclusion}
                    onChange={(event) => setProblemGroupDraftConclusion(event.target.value)}
                    className="mt-2 min-h-[120px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
                  />
                ) : (
                  <p className="mt-1 text-base leading-7 text-slate-700">{item.value}</p>
                )}
              </div>
            ))}
          </div>
        )}
        {stage === "problem-definition" && isEditingSelectedProblemGroup ? (
          <p className="mt-3 text-sm leading-6 text-slate-500">
            저장하면 이 결론은 이후 AI 재생성으로 덮어쓰지 않습니다.
          </p>
        ) : null}
      </section>
    );
  };

  const renderGeneralOrganizeSection = () => {
    if (!leftPanelDetail || stage === "solution" || leftPanelDetail.organizeItems.length === 0) return null;

    return (
      <section className="pt-6">
        <h4 className="text-lg font-semibold text-slate-900">{leftPanelDetail.organizeTitle || "안건 정리"}</h4>
        <div className="mt-4 space-y-3">
          {leftPanelDetail.organizeItems.map((item, index) => (
            <div key={`${leftPanelDetail.title}-organize-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-sm font-semibold text-slate-500">{item.label}</p>
              <p className="mt-1 text-base leading-7 text-slate-700">{stripLeadingTimestamp(item.value)}</p>
            </div>
          ))}
        </div>
      </section>
    );
  };

  const renderSolutionDetailSections = () => {
    if (stage !== "solution" || !selectedSolutionTopic) return null;

    return (
      <>
        <section className="border-b border-slate-200/80 py-6">
          <h4 className="text-lg font-semibold text-slate-900">해결 방향</h4>
          {isEditingSelectedSolutionTopic ? (
            <textarea
              value={solutionTopicDraftConclusion}
              onChange={(event) => setSolutionTopicDraftConclusion(event.target.value)}
              className="mt-4 min-h-[120px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
            />
          ) : (
            <div className="mt-4 rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-base leading-7 text-slate-700">
                {selectedSolutionTopic.conclusion || "아직 정리된 해결 방향이 없습니다."}
              </p>
            </div>
          )}
        </section>

        <section className="border-b border-slate-200/80 py-6">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-lg font-semibold text-slate-900">AI 초안</h4>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
              {selectedSolutionTopic.ai_suggestions.length}개
            </span>
          </div>
          {isEditingSelectedSolutionTopic ? (
            <>
              <textarea
                value={solutionTopicDraftIdeas}
                onChange={(event) => setSolutionTopicDraftIdeas(event.target.value)}
                className="mt-4 min-h-[180px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
                placeholder="한 줄에 하나씩 아이디어를 입력합니다."
              />
              <p className="mt-3 text-sm leading-6 text-slate-500">각 줄이 하나의 실행 아이디어로 저장됩니다.</p>
            </>
          ) : (
            <div className="mt-4 space-y-3">
              {selectedSolutionTopic.ai_suggestions.length > 0 ? (
                selectedSolutionTopic.ai_suggestions.map((idea, index) => (
                  <div key={idea.id} className="rounded-xl bg-[#fafafa] px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-500">AI 제안 {index + 1}</p>
                        <p className={`mt-1 text-base leading-7 ${idea.status === "selected" ? "text-blue-600" : "text-slate-700"}`}>
                          {idea.text}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAdoptAiSuggestion(selectedSolutionTopic.group_id, idea.id)}
                        disabled={idea.status === "selected"}
                        className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {idea.status === "selected" ? "채택됨" : "채택"}
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-base leading-7 text-slate-500">아직 제안된 AI 초안이 없습니다.</p>
              )}
            </div>
          )}
        </section>

        <section className="border-b border-slate-200/80 py-6">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-lg font-semibold text-slate-900">채택 메모</h4>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
              {selectedSolutionTopic.notes.length}개
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {selectedSolutionTopic.notes.length > 0 ? (
              selectedSolutionTopic.notes.map((note, index) => {
                const noteEditKey = makeSolutionNoteEditKey(selectedSolutionTopic.group_id, note.id);
                const noteEditing = editingSolutionNoteKey === noteEditKey;
                return (
                  <div key={note.id} className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-amber-700">
                          {note.source === "ai" ? `채택 메모 ${index + 1}` : `사용자 메모 ${index + 1}`}
                        </p>
                        {noteEditing ? (
                          <textarea
                            value={solutionNoteTextDraft}
                            onChange={(event) => setSolutionNoteTextDraft(event.target.value)}
                            placeholder="해결책 카드 내용을 입력합니다."
                            className="mt-2 min-h-[92px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
                          />
                        ) : (
                          <p className="mt-2 text-base leading-7 text-slate-700">{note.text}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleFinalSolutionNote(selectedSolutionTopic.group_id, note.id)}
                          className={`rounded-xl px-3 py-2 text-sm font-medium ${
                            note.is_final_candidate
                              ? "bg-slate-900 text-white"
                              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {note.is_final_candidate ? "최종 결론" : "결론 후보"}
                        </button>
                        {noteEditing ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleCancelSolutionNoteEdit}
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                            >
                              취소
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleSaveSolutionNoteEdit()}
                              className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                            >
                              저장
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              handleStartSolutionNoteEdit(
                                selectedSolutionTopic.group_id,
                                makeSolutionNote(note, note.id),
                              )
                            }
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                          >
                            편집
                          </button>
                        )}
                      </div>
                    </div>
                    {note.is_final_candidate && noteEditing ? (
                      <textarea
                        value={solutionNoteFinalCommentDraft}
                        onChange={(event) => setSolutionNoteFinalCommentDraft(event.target.value)}
                        placeholder="추가 설명을 입력할 수 있습니다."
                        className="mt-3 min-h-[84px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700"
                      />
                    ) : note.is_final_candidate ? (
                      <p className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-500">
                        {note.final_comment || "최종 결론 설명은 편집을 눌러 추가할 수 있습니다."}
                      </p>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="text-base leading-7 text-slate-500">아직 채택된 메모가 없습니다. AI 초안이나 사용자 메모를 추가해 보세요.</p>
            )}
          </div>

          <div className="mt-5 rounded-xl bg-[#fafafa] px-4 py-4">
            <p className="text-sm font-semibold text-slate-600">사용자 메모 추가</p>
            <textarea
              value={solutionNoteDraft}
              onChange={(event) => setSolutionNoteDraft(event.target.value)}
              placeholder="직접 해결책 메모를 추가합니다."
              className="mt-3 min-h-[110px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
            />
            <button
              type="button"
              onClick={handleAddSolutionUserNote}
              className="mt-3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              메모 추가
            </button>
          </div>
        </section>

        <section className="border-b border-slate-200/80 py-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-lg font-semibold text-slate-900">최종 결론 모음</h4>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                회의 종료 시 이 내용이 결과 요약으로 저장됩니다.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCopyFinalSolutionMarkdown()}
                disabled={finalSolutionSummary.final_count === 0}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                마크다운 복사
              </button>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                {finalSolutionSummary.final_count}개
              </span>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {allSolutionFinalNotes.length > 0 ? (
              allSolutionFinalNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => {
                    setSelectedSolutionTopicId(note.topicId);
                    setSelectedNodeId(`solution-${note.topicId}`);
                  }}
                  className={`w-full rounded-xl border px-4 py-3 text-left ${
                    note.topicId === selectedSolutionTopic.group_id
                      ? "border-slate-300 bg-white"
                      : "border-slate-200 bg-[#fafafa]"
                  }`}
                >
                  <p className="text-sm font-semibold text-slate-700">{note.topicTitle}</p>
                  <p className="mt-1 text-base leading-7 text-slate-700">{note.text}</p>
                  {note.final_comment ? (
                    <p className="mt-2 text-sm leading-6 text-slate-500">{note.final_comment}</p>
                  ) : null}
                </button>
              ))
            ) : (
              <p className="text-base leading-7 text-slate-500">최종 결론으로 표시된 메모가 아직 없습니다.</p>
            )}
          </div>
        </section>

        <section className="pt-6">
          <h4 className="text-lg font-semibold text-slate-900">연결 문제정의</h4>
          <div className="mt-4 space-y-3">
            <div className="rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-sm font-semibold text-slate-500">문제 정의 주제</p>
              <p className="mt-1 text-base leading-7 text-slate-700">
                {selectedSolutionTopic.problem_topic || "연결된 문제정의가 아직 없습니다."}
              </p>
            </div>
            <div className="rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-sm font-semibold text-slate-500">소결론</p>
              <p className="mt-1 text-base leading-7 text-slate-700">
                {selectedSolutionTopic.problem_insight || "연결된 소결론이 아직 없습니다."}
              </p>
            </div>
            <div className="rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-sm font-semibold text-slate-500">문제 정의 결론</p>
              <p className="mt-1 text-base leading-7 text-slate-700">
                {selectedSolutionTopic.problem_conclusion || "연결된 결론이 아직 없습니다."}
              </p>
            </div>
            <div className="rounded-xl bg-[#fafafa] px-4 py-3">
              <p className="text-sm font-semibold text-slate-500">연결 안건</p>
              <p className="mt-1 text-base leading-7 text-slate-700">
                {selectedSolutionTopic.agenda_titles.length > 0
                  ? selectedSolutionTopic.agenda_titles.join(", ")
                  : "연결된 안건이 아직 없습니다."}
              </p>
            </div>
          </div>
        </section>
      </>
    );
  };

  const renderIdeationRelatedSections = () => {
    if (!leftPanelDetail || stage !== "ideation" || !selectedCanvasItem) return null;

    return (
      <>
        {leftPanelDetail.mergedItems?.length ? (
          <section className="pt-6">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-lg font-semibold text-slate-900">포함된 하위 아이디어</h4>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                {leftPanelDetail.mergedItems.length}개 묶음
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {leftPanelDetail.mergedItems.map((item) => (
                <div key={`${leftPanelDetail.title}-merged-${item.id}`} className="rounded-xl border border-slate-200 bg-[#fafafa] px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-700">{item.label}</p>
                      <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-700">
                        {stripLeadingTimestamp(item.value)}
                      </p>
                    </div>
                    {item.sourceCount > 1 ? (
                      <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs text-slate-500">
                        {item.sourceCount}개
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => focusCanvasItemInIdeation(item.id, "하위 아이디어 위치로 이동했습니다.")}
                      className="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                    >
                      원문 이동
                    </button>
                  </div>
                  {item.keywords.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.keywords.slice(0, 4).map((keyword) => (
                        <span key={`${item.id}-${keyword}`} className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500">
                          #{keyword}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {leftPanelDetail.refinedItems?.length ? (
          <section className="pt-6">
            <h4 className="text-lg font-semibold text-slate-900">정리된 발화</h4>
            <div className="mt-4 space-y-3">
              {leftPanelDetail.refinedItems.map((item, index) => (
                <div key={`${leftPanelDetail.title}-refined-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                    <button
                      type="button"
                      onClick={() => focusCanvasItemInIdeation(item.sourceItemId, "정리된 발화의 원문 노드로 이동했습니다.")}
                      className="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                    >
                      원문 이동
                    </button>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-700">{stripLeadingTimestamp(item.value)}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="pt-6">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-lg font-semibold text-slate-900">댓글</h4>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
              {leftPanelDetail.commentItems?.length || 0}개
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {leftPanelDetail.commentItems?.length ? (
              leftPanelDetail.commentItems.map((item) => (
                <div key={`${leftPanelDetail.title}-comment-${item.id}`} className="rounded-xl border border-sky-100 bg-sky-50/60 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-700">{item.label}</p>
                      <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-700">
                        {stripLeadingTimestamp(item.value)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => focusCanvasItemInIdeation(item.id, "댓글 위치로 이동했습니다.")}
                      className="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] hover:bg-[#eff0f6]"
                    >
                      원문 이동
                    </button>
                  </div>
                  {item.keywords.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.keywords.slice(0, 4).map((keyword) => (
                        <span key={`${item.id}-comment-keyword-${keyword}`} className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500">
                          #{keyword}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 bg-[#fafafa] px-4 py-4 text-sm leading-6 text-slate-500">
                아직 이 내용에 연결된 댓글이 없습니다.
              </p>
            )}
          </div>
        </section>
      </>
    );
  };

  const renderProblemRelatedSections = () => {
    if (!leftPanelDetail || stage !== "problem-definition") return null;

    return (
      <>
        {leftPanelDetail.evidenceItems?.length ? (
          <section className="pt-6">
            <h4 className="text-lg font-semibold text-slate-900">근거 요약</h4>
            <div className="mt-4 space-y-3">
              {leftPanelDetail.evidenceItems.map((item, index) => (
                <div key={`${leftPanelDetail.title}-evidence-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                  <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                  <p className="mt-1 text-base leading-7 text-slate-700">{item.value}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="pt-6">
          <h4 className="text-lg font-semibold text-slate-900">연결 메모</h4>
          <div className="mt-4 space-y-3">
            {leftPanelDetail.noteItems?.length ? (
              leftPanelDetail.noteItems.map((item, index) => (
                <div key={`${leftPanelDetail.title}-note-${item.id}-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-700">{item.label}</p>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500">{toolLabel((item.kind as ComposerTool) || "note")}</span>
                  </div>
                  <p className="mt-2 text-base leading-7 text-slate-600">{item.value || "메모 내용이 없습니다."}</p>
                </div>
              ))
            ) : (
              <p className="text-base leading-7 text-slate-500">아직 연결된 메모가 없습니다. 오른쪽 개인 메모를 그룹 카드로 드래그하면 여기에 표시됩니다.</p>
            )}
          </div>
        </section>
      </>
    );
  };

  return (
    <div className="h-full min-h-0 bg-[#f9f9f9] text-black">
      <section className="flex h-full min-h-0 flex-col bg-[#f9f9f9]">
        <div className="relative z-20 border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]">
          <div className="grid min-h-[clamp(96px,13vh,141px)] grid-cols-1 items-center justify-items-center gap-3 px-[clamp(16px,2.4vw,33px)] py-[clamp(12px,1.8vh,16px)] lg:grid-cols-[minmax(0,1fr)_minmax(260px,1.35fr)_minmax(0,1fr)] lg:justify-items-stretch">
            <div className="flex w-full flex-wrap items-center justify-center gap-2 lg:justify-start lg:justify-self-start">
              <button
                type="button"
                onClick={() => void handleEndMeetingClick()}
                disabled={endMeetingSaving}
                className="h-[clamp(36px,4.4vh,43px)] rounded-[8px] bg-[#ef4e4e] px-[clamp(14px,1.7vw,24px)] text-[clamp(16px,1.2vw,20px)] font-semibold text-white hover:bg-[#df3f3f] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {endMeetingSaving ? "종료 중" : "종료"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isRecording) {
                    void handleStopRecordingClick();
                  } else {
                    void onToggleRecording?.();
                  }
                }}
                className={`h-[clamp(36px,4.4vh,43px)] rounded-[8px] px-[clamp(12px,1.2vw,16px)] text-[clamp(12px,0.95vw,14px)] font-semibold ${
                  isRecording ? "bg-red-50 text-[#ef4e4e] ring-1 ring-red-100" : "bg-[#1b59f8] text-white"
                }`}
              >
                {isRecording ? "녹음 중지" : "녹음 시작"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSharedSyncEnabled((prev) => {
                    const next = !prev;
                    setActivityMessage(
                      next
                        ? "이제 내 canvas 변경사항이 다른 참가자들과 공유됩니다."
                        : "이제 내 canvas 변경사항은 로컬에서만 유지되고, 다른 참가자의 변경만 받아옵니다.",
                    );
                    return next;
                  });
                }}
                className="h-[clamp(36px,4.4vh,43px)] rounded-[8px] bg-[#eff0f6] px-[clamp(10px,1vw,12px)] text-[clamp(12px,0.95vw,14px)] font-semibold text-[#4d4d4d] hover:bg-[#e3e5ee]"
              >
                {syncModeLabel(sharedSyncEnabled)}
              </button>
              <button
                type="button"
                onClick={handleMoveToCurrentDiscussionGroup}
                className={`h-[clamp(36px,4.4vh,43px)] rounded-[8px] px-[clamp(10px,1vw,12px)] text-[clamp(12px,0.95vw,14px)] font-semibold ${
                  latestDiscussionRootItem
                    ? "bg-[#eef4ff] text-[#1b59f8] hover:bg-[#e0ebff]"
                    : "bg-[#eff0f6] text-[#8b8f9a]"
                }`}
              >
                논의 그룹
              </button>
              <button
                type="button"
                disabled={audioImportBusy}
                onClick={() => fileInputRef.current?.click()}
                className="h-[clamp(36px,4.4vh,43px)] rounded-[8px] bg-[#eff0f6] px-[clamp(10px,1vw,12px)] text-[clamp(12px,0.95vw,14px)] font-semibold text-[#4d4d4d] hover:bg-[#e3e5ee] disabled:cursor-not-allowed disabled:opacity-50"
              >
                불러오기
              </button>
              <span className="inline-flex h-[30px] items-center rounded-full border border-black/10 bg-[#f9f9f9] px-3 text-[11px] font-semibold leading-none text-[#6f6f6f]">
                1차 노드 {ideationNodeCountSummary.directChildCount} · 기준 {ideationNodeCountSummary.target}
              </span>
            </div>

            <div className="relative min-w-0 justify-self-center text-center">
              <div className="flex items-center justify-center gap-2 text-[clamp(14px,1.2vw,20px)] font-normal leading-[1.25] text-[#4d4d4d]">
                <span>{meetingTitle || "회의 제목"}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${isRecording ? "bg-[#34c759]" : "bg-[#d9d9d9]"}`} />
              </div>
              <button
                type="button"
                onClick={meetingGoalEditorOpen ? handleCancelMeetingGoalEdit : handleOpenMeetingGoalEditor}
                className="mx-auto mt-2 block w-full max-w-[min(760px,100%)] rounded-xl border border-transparent px-3 py-1 text-center transition hover:border-black/10 hover:bg-[#f9f9f9] focus:border-[#1b59f8]/30 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#1b59f8]/10"
              >
                <span
                  className={`block truncate text-[clamp(20px,2.2vw,32px)] font-semibold leading-[1.2] tracking-normal ${
                    meetingGoalDraft.trim() ? "text-black" : "text-black/30"
                  }`}
                >
                  {meetingGoalDraft.trim() || "회의 목표를 입력해 주세요"}
                </span>
                <span className="mt-1 block truncate text-[clamp(11px,0.85vw,13px)] font-normal leading-[1.35] text-[#4d4d4d]">
                  {meetingGoalContextDraft.trim()
                    ? `관련 맥락: ${meetingGoalContextDraft.trim()}`
                    : "클릭해서 회의 목표와 관련 맥락을 입력"}
                </span>
              </button>

              {meetingGoalEditorOpen ? (
                <div className="absolute left-1/2 top-[calc(100%+12px)] z-30 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-[16px] border border-black/10 bg-white p-4 text-left shadow-[0_5.64px_22.56px_rgba(0,0,0,0.08)]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[18px] font-semibold leading-[24.811px] text-black">회의 목표 설정</p>
                      <p className="mt-1 text-[13px] leading-5 text-[#4d4d4d]">
                        입력한 내용은 저장을 누른 뒤 STT와 AI 분석의 참고 정보로 사용됩니다.
                      </p>
                    </div>
                  </div>
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold text-[#4d4d4d]">회의 목표</span>
                    <input
                      value={meetingGoalEditorDraft}
                      onChange={(event) => {
                        const nextGoal = event.target.value;
                        setMeetingGoalEditorDraft(nextGoal);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          handleCancelMeetingGoalEdit();
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSaveMeetingGoalEdit();
                        }
                      }}
                      placeholder="예: 신규 회의 관리 시스템의 핵심 기능 우선순위 결정"
                      className="mt-2 w-full rounded-[12px] border border-black/10 bg-[#f9f9f9] px-4 py-3 text-[16px] leading-6 text-black outline-none transition placeholder:text-black/30 focus:border-[#1b59f8]/30 focus:bg-white focus:ring-2 focus:ring-[#1b59f8]/10"
                    />
                  </label>
                  <label className="mt-3 block">
                    <span className="text-xs font-semibold text-[#4d4d4d]">관련 맥락</span>
                    <textarea
                      value={meetingGoalContextEditorDraft}
                      onChange={(event) => {
                        const nextContext = event.target.value;
                        setMeetingGoalContextEditorDraft(nextContext);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          handleCancelMeetingGoalEdit();
                        }
                      }}
                      placeholder="회의에서 자주 나올 제품명, 고유명사, 참가자 역할, 논의 범위 등을 입력해 주세요."
                      className="mt-2 min-h-[92px] w-full resize-none rounded-[12px] border border-black/10 bg-[#f9f9f9] px-4 py-3 text-[15px] leading-6 text-[#4d4d4d] outline-none transition placeholder:text-black/30 focus:border-[#1b59f8]/30 focus:bg-white focus:ring-2 focus:ring-[#1b59f8]/10"
                    />
                  </label>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleCancelMeetingGoalEdit}
                      disabled={meetingGoalSaving}
                      className="rounded-[8px] bg-[#eff0f6] px-4 py-2 text-sm font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveMeetingGoalEdit()}
                      disabled={meetingGoalSaving}
                      className="rounded-[8px] bg-[#1b59f8] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#164be0] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {meetingGoalSaving ? "저장 중" : "저장"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex w-full flex-wrap items-center justify-center gap-3 lg:justify-end lg:justify-self-end">
              <div className="flex flex-wrap items-center justify-center gap-[clamp(8px,1.4vw,20px)]">
                {(["ideation", "problem-definition", "solution"] as CanvasStage[]).map((item, index) => (
                  <div key={item} className="flex items-center gap-[clamp(6px,1vw,16px)]">
                    <button
                      type="button"
                      onClick={() => void handleStageSelect(item)}
                      className={`rounded-[8px] border px-[clamp(12px,1.2vw,16px)] py-[clamp(7px,0.9vh,8px)] text-[clamp(14px,1.2vw,20px)] font-semibold leading-[1.25] transition ${
                        stage === item
                          ? "border-[#1b59f8]/20 bg-[rgba(27,89,248,0.1)] text-[#1b59f8]"
                          : "border-black/10 bg-white text-black/50 hover:border-[#1b59f8]/20 hover:bg-[rgba(27,89,248,0.1)] hover:text-[#1b59f8]"
                      }`}
                    >
                      {stageLabel(item)}
                    </button>
                    {index < 2 ? <span className="text-[clamp(18px,1.5vw,24px)] text-black/30">›</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="application/json,.wav,.mp3,.m4a,.webm,audio/wav,audio/mpeg,audio/mp4,audio/webm"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    if (isAudioImportFile(file)) {
                      void onImportAudioFile(file).then(() => {
                        setActivityMessage(`오디오 파일 불러오기를 시작했습니다: ${file.name}`);
                      });
                    } else {
                      void importAgendaSnapshot({ file, reset_state: true }).then((result) => {
                        setImportedState(result.state);
                        analysisSignatureAtImportRef.current = analysisStateSignature;
                        setImportOverrideActive(true);
                        setCanvasItems([]);
                        setIdeaCreateStack(0);
                        setCustomGroups([]);
                        setProblemGroups([]);
                        setSolutionTopics([]);
                        setNodePositions({});
                        setStage("ideation");
                        setSelectedProblemGroupId("");
                        setSelectedSolutionTopicId("");
                        setSelectedNodeId("");
                        setEditingProblemGroupId("");
                        setEditingSolutionTopicId("");
                        setActivityMessage(`스냅샷을 불러왔습니다: ${result.import_debug.filename}`);
                        analysisSignatureAtImportRef.current = buildMeetingStateSignature(result.state);
                        if (sharedSyncEnabled) {
                          forceBroadcastSharedCanvas({
                            stage: "ideation",
                            agendaOverrides: {},
                            canvasItems: [],
                            customGroups: [],
                            problemGroups: [],
                            solutionTopics: [],
                            nodePositions: {},
                            importedState: result.state,
                          });
                          void saveCanvasWorkspacePatch({
                            meeting_id: meetingId,
                            stage: "ideation",
                            agenda_overrides: {},
                            canvas_items: [],
                            custom_groups: [],
                            problem_groups: [],
                            solution_topics: [],
                            final_solution_summary: buildFinalSolutionSummaryPayload([]),
                            node_positions: {},
                            imported_state: result.state,
                          }).catch((error) => {
                            console.error("Failed to save imported canvas snapshot:", error);
                          });
                        }
                      });
                    }
                  }
                  event.currentTarget.value = "";
                }}
              />
            </div>

        <div
          className="imms-workspace-grid grid flex-1 min-h-0 grid-cols-1 overflow-y-auto bg-black/10 xl:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] xl:overflow-hidden xl:gap-[clamp(0.25rem,0.45vw,0.5rem)] xl:border-x xl:border-b xl:border-black/10"
          style={isDesktopLayout ? { gridTemplateColumns: workspaceGridColumns } : undefined}
        >
          <section ref={canvasSurfaceRef} className="relative order-1 flex min-h-[min(72vh,720px)] flex-col overflow-hidden border-b border-black/10 bg-[#f9f9f9] shadow-[inset_0_1px_0_rgba(0,0,0,0.04)] xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:h-full xl:min-h-0 xl:border-b-0">
            <div className="relative grid min-h-[clamp(88px,12vh,135px)] shrink-0 grid-cols-1 divide-y divide-black/10 border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)] md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="pointer-events-none absolute left-4 top-3 z-10 flex max-w-[calc(100%-2rem)] flex-wrap gap-2">
                <span className="rounded-full border border-blue-100 bg-blue-50/95 px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm">
                  {sttProgressText || liveFlowHint || "현재 발언 흐름 대기 중"}
                </span>
                {ideaAssimilationStatus ? (
                  <span className="rounded-full border border-black/10 bg-white/95 px-3 py-1 text-xs font-medium text-[#4d4d4d] shadow-sm">
                    {ideaAssimilationStatus}
                  </span>
                ) : null}
                {problemDiscussionStatus ? (
                  <span className="rounded-full border border-violet-100 bg-violet-50/95 px-3 py-1 text-xs font-medium text-violet-700 shadow-sm">
                    {problemDiscussionStatus}
                  </span>
                ) : null}
              </div>
              {transcriptStripItems.slice(0, 3).map((item, index) => (
                <div key={`${item.timestamp || index}-${index}`} className="flex min-h-[clamp(88px,12vh,135px)] items-center gap-[clamp(12px,2vw,32px)] px-[clamp(16px,3vw,36px)] py-[clamp(12px,1.8vh,16px)]">
                  <span className="h-[clamp(36px,4vw,48px)] w-[clamp(36px,4vw,48px)] shrink-0 rounded-full bg-[#d9d9d9]" />
                  <div className="min-w-0 text-[clamp(13px,1vw,16px)] leading-[1.55] text-[#4d4d4d]">
                    <p className="line-clamp-2">{item.text}</p>
                    <p className="mt-1 text-xs text-black/35">{item.speaker}</p>
                  </div>
                </div>
              ))}
            </div>
            <div
              className="min-h-0 w-full flex-1"
              onMouseMove={(event) => {
                if (!armedCanvasTool) {
                  return;
                }
                updateCanvasPlacementPreview(event.clientX, event.clientY);
              }}
              onMouseLeave={() => {
                clearCanvasPlacementPreview();
              }}
            >
              {stage === "ideation" ? (
                <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[minmax(17rem,38%)_minmax(0,1fr)]">
                  <div
                    ref={ideationLeftPaneRef}
                    className="flex min-h-[320px] flex-col overflow-hidden border-b border-black/10 bg-white xl:border-b-0 xl:border-r"
                    onMouseEnter={() => {
                      if (stableIdeationDragRef.current) {
                        return;
                      }
                      flowRef.current = ideationLeftFlowRef.current;
                    }}
                  >
                    <div className="shrink-0 border-b border-black/10 px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#1b59f8]">Group Canvas</p>
                          <h3 className="mt-1 text-lg font-semibold text-slate-950">
                            {selectedAgenda?.title || "그룹분류"}
                          </h3>
                        </div>
                        <span className="rounded-full bg-[#eef4ff] px-3 py-1 text-xs font-semibold text-[#1b59f8]">
                          {ideationSplitNodes.left.length}개
                        </span>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 bg-[#f5f6f8]">
                      <ReactFlow<Node, Edge>
                        nodes={ideationSplitNodes.left}
                        edges={[] as Edge[]}
                        onInit={(instance) => {
                          ideationLeftFlowRef.current = instance;
                          flowRef.current = instance;
                        }}
                        onNodeClick={handleCanvasNodeClick}
                        onPaneClick={(event) => handleCanvasPaneClick(event, "ideation-left")}
                        onNodesChange={onNodesChange}
                        onNodeDragStart={onNodeDragStart}
                        onNodeDrag={onNodeDrag}
                        onNodeDragStop={onNodeDragStop}
                        nodesConnectable={false}
                        panOnDrag={!ideationNodeDragActive}
                        autoPanOnNodeDrag={false}
                        noPanClassName="nopan"
                        nodesDraggable
                        minZoom={0.45}
                        maxZoom={1.6}
                        proOptions={{ hideAttribution: true }}
                      >
                        <Controls />
                      </ReactFlow>
                    </div>
                  </div>

                  <div
                    ref={ideationRightPaneRef}
                    className="flex min-h-[420px] flex-col overflow-hidden bg-white"
                    onMouseEnter={() => {
                      if (stableIdeationDragRef.current) {
                        return;
                      }
                      flowRef.current = ideationRightFlowRef.current;
                    }}
                  >
                    <div className="shrink-0 border-b border-black/10 px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#1b59f8]">{ideationRightTitle}</p>
                          <h3 className="mt-1 text-lg font-semibold text-slate-950">{ideationRightSubtitle}</h3>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          {selectedRootItemForIdeationCanvas ? (
                            CANVAS_ITEM_STATUSES.map((status) => {
                              const selectedStatus = normalizeCanvasItemStatus(selectedRootItemForIdeationCanvas.status);
                              const active = selectedStatus === status;
                              return (
                                <button
                                  key={`ideation-root-status-${status}`}
                                  type="button"
                                  onClick={() => handleSetCanvasItemStatus(status, selectedRootItemForIdeationCanvas.id, false)}
                                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                    active
                                      ? canvasItemStatusTone(status)
                                      : "border-black/10 bg-white text-[#4d4d4d] hover:bg-[#f5f6f8]"
                                  }`}
                                >
                                  {canvasItemStatusLabel(status)}
                                </button>
                              );
                            })
                          ) : null}
                          <span className="rounded-full bg-[#eef4ff] px-3 py-1 text-xs font-semibold text-[#1b59f8]">
                            {ideationSplitNodes.right.length}개
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col bg-[#f5f6f8]">
                      {selectedRootItemForIdeationCanvas ? (
                        <section className={`shrink-0 border-b border-black/10 bg-white px-5 ${ideationSuggestionCollapsed ? "py-2.5" : "py-4"}`}>
                          <div className={`flex justify-between gap-4 ${ideationSuggestionCollapsed ? "items-center" : "items-start"}`}>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">AI 추천 아이디어</p>
                              {ideationSuggestionCollapsed ? null : (
                              <p className="mt-1 text-sm leading-6 text-[#777]">
                                선택한 topic의 하위 내용을 바탕으로 참고용 아이디어를 제안합니다.
                              </p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-wrap justify-end gap-2">
                              {ideationSuggestionCollapsed ? null : (
                              <button
                                type="button"
                                onClick={() => void handleGenerateIdeationSuggestions()}
                                disabled={ideationSuggestionBusy}
                                className="rounded-full border border-black/10 bg-[#f5f6f8] px-4 py-2 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#eff0f6] disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {ideationSuggestionBusy ? "생성 중" : "추천 생성"}
                              </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  const rootId = selectedRootItemForIdeationCanvas.id;
                                  setIdeationSuggestionCollapsedByRootId((current) => ({
                                    ...current,
                                    [rootId]: !Boolean(current[rootId]),
                                  }));
                                }}
                                aria-label={ideationSuggestionCollapsed ? "AI 추천 아이디어 펼치기" : "AI 추천 아이디어 접기"}
                                title={ideationSuggestionCollapsed ? "펼치기" : "접기"}
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10 bg-white text-base font-bold leading-none text-[#4d4d4d] transition hover:bg-[#f5f6f8]"
                              >
                                <KeyboardDoubleArrowDownIcon
                                  className={`h-5 w-5 transition-transform ${
                                    ideationSuggestionCollapsed ? "" : "rotate-180"
                                  }`}
                                />
                              </button>
                            </div>
                          </div>
                          {ideationSuggestionCollapsed ? null : (
                            <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                              {selectedIdeationSuggestions.length > 0 ? (
                                selectedIdeationSuggestions.map((suggestion, index) => {
                                  const adopted = normalizeIdeationSuggestionStatus(suggestion.status) === "selected";
                                  return (
                                    <article
                                      key={suggestion.id}
                                      className={`min-w-[260px] max-w-[340px] border px-4 py-3 ${
                                        adopted
                                          ? "border-blue-200 bg-blue-50/70"
                                          : "border-black/10 bg-[#fafafa]"
                                      }`}
                                    >
                                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777]">
                                        추천 {index + 1}
                                      </p>
                                      <p className={`mt-2 line-clamp-3 text-sm leading-6 ${adopted ? "text-blue-700" : "text-[#4d4d4d]"}`}>
                                        {suggestion.text}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() => handleAdoptIdeationSuggestion(suggestion.id)}
                                        disabled={adopted}
                                        className="mt-3 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8] disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        {adopted ? "채택됨" : "카드로 채택"}
                                      </button>
                                    </article>
                                  );
                                })
                              ) : (
                                <div className="min-w-[min(17.5rem,80vw)] border border-dashed border-black/10 bg-[#fafafa] px-4 py-3 text-sm leading-6 text-[#777]">
                                  아직 추천 아이디어가 없습니다. `추천 생성`을 누르면 이 영역에 참고용 제안이 표시됩니다.
                                </div>
                              )}
                            </div>
                          )}
                        </section>
                      ) : null}
                      <div className="min-h-0 flex-1">
                      <ReactFlow<Node, Edge>
                        nodes={ideationSplitNodes.right}
                        edges={[] as Edge[]}
                        onInit={(instance) => {
                          ideationRightFlowRef.current = instance;
                          flowRef.current = instance;
                        }}
                        onNodeClick={handleCanvasNodeClick}
                        onPaneClick={(event) => handleCanvasPaneClick(event, "ideation-right")}
                        onNodesChange={onNodesChange}
                        onNodeDragStart={onNodeDragStart}
                        onNodeDrag={onNodeDrag}
                        onNodeDragStop={onNodeDragStop}
                        nodesConnectable={false}
                        panOnDrag={!ideationNodeDragActive}
                        autoPanOnNodeDrag={false}
                        noPanClassName="nopan"
                        nodesDraggable={true}
                        minZoom={0.45}
                        maxZoom={1.6}
                        proOptions={{ hideAttribution: true }}
                      >
                        <MiniMap
                          zoomable
                          pannable
                          maskColor="rgba(15, 23, 42, 0.08)"
                          nodeColor="#0f766e"
                        />
                        <Controls />
                      </ReactFlow>
                      </div>
                    </div>
                  </div>
                </div>
              ) : stage === "solution" ? (
                <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[minmax(17rem,36%)_minmax(0,1fr)]">
                  <div className="flex min-h-[320px] flex-col overflow-hidden border-b border-black/10 bg-white xl:border-b-0 xl:border-r">
                    <div className="shrink-0 border-b border-black/10 px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Insight Canvas</p>
                          <h3 className="mt-1 text-lg font-semibold text-slate-950">해결책 인사이트</h3>
                        </div>
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                          {solutionSplitNodes.left.length}개
                        </span>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 bg-[#f5f6f8]">
                      <ReactFlow<Node, Edge>
                        nodes={solutionSplitNodes.left}
                        edges={[] as Edge[]}
                        onInit={(instance) => {
                          flowRef.current = instance;
                        }}
                        onNodeClick={handleCanvasNodeClick}
                        onPaneClick={handleCanvasPaneClick}
                        nodesConnectable={false}
                        nodesDraggable={false}
                        panOnDrag
                        noPanClassName="nopan"
                        minZoom={0.45}
                        maxZoom={1.6}
                        proOptions={{ hideAttribution: true }}
                      >
                        <Controls />
                      </ReactFlow>
                    </div>
                  </div>

                  <div ref={solutionRightPaneRef} className="flex min-h-[420px] flex-col overflow-hidden bg-white">
                    <div className="shrink-0 border-b border-black/10 px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Solution Canvas</p>
                          <h3 className="mt-1 line-clamp-1 text-lg font-semibold text-slate-950">
                            {selectedSolutionTopic?.topic || "해결책 토픽을 선택해 주세요"}
                          </h3>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          {selectedSolutionTopic ? (
                            (["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => {
                              const active = selectedSolutionTopic.status === status;
                              return (
                                <button
                                  key={`solution-header-status-${status}`}
                                  type="button"
                                  onClick={() => handleSetSolutionTopicStatus(status)}
                                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                    active
                                      ? problemGroupStatusTone(status)
                                      : "border-black/10 bg-white text-[#4d4d4d] hover:bg-[#f5f6f8]"
                                  }`}
                                >
                                  {problemGroupStatusLabel(status)}
                                </button>
                              );
                            })
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 bg-[#f5f6f8]">
                      <ReactFlow<Node, Edge>
                        nodes={solutionSplitNodes.right}
                        edges={[] as Edge[]}
                        onInit={(instance) => {
                          flowRef.current = instance;
                        }}
                        onNodeClick={handleCanvasNodeClick}
                        onPaneClick={handleCanvasPaneClick}
                        nodesConnectable={false}
                        nodesDraggable={false}
                        panOnDrag
                        noPanClassName="nopan"
                        minZoom={0.45}
                        maxZoom={1.6}
                        proOptions={{ hideAttribution: true }}
                      >
                        <MiniMap
                          zoomable
                          pannable
                          maskColor="rgba(15, 23, 42, 0.08)"
                          nodeColor="#047857"
                        />
                        <Controls />
                      </ReactFlow>
                    </div>

                  </div>
                </div>
              ) : (
                <ReactFlow
                  nodes={nodes}
                  edges={renderedEdges}
                  onInit={(instance) => {
                    flowRef.current = instance;
                  }}
                  onNodeClick={handleCanvasNodeClick}
                  onEdgeClick={handleCanvasEdgeClick}
                  onPaneClick={handleCanvasPaneClick}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDrag={onNodeDrag}
                  onNodeDragStop={onNodeDragStop}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  nodesConnectable={false}
                  elevateEdgesOnSelect
                  connectionLineStyle={{ stroke: "#0f172a", strokeOpacity: 0.9, strokeWidth: 2 }}
                  minZoom={0.45}
                  maxZoom={1.6}
                  defaultEdgeOptions={{
                    type: "smoothstep",
                    markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" },
                    interactionWidth: 28,
                    zIndex: 10,
                    style: { stroke: "#475569", strokeOpacity: 0.95, strokeWidth: 2 },
                  }}
                  proOptions={{ hideAttribution: true }}
                >
                  <MiniMap
                    zoomable
                    pannable
                    maskColor="rgba(15, 23, 42, 0.08)"
                    nodeColor="#0f766e"
                  />
                  <Controls />
                </ReactFlow>
              )}
            </div>

            {selectedEdge ? (
              <div className="absolute right-4 top-4 z-[9] w-[260px] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_18px_46px_rgba(15,23,42,0.16)] backdrop-blur">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Connection</p>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-800">
                    {selectedEdge.source} → {selectedEdge.target}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDeleteSelectedEdge}
                  className="mt-3 w-full rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                >
                  연결 삭제
                </button>
                <p className="mt-2 text-xs leading-5 text-slate-500">연결선을 클릭해 선택한 뒤 Delete 또는 Backspace로도 삭제할 수 있습니다.</p>
              </div>
            ) : null}

            {placementFeedback ? (
              <div
                className="pointer-events-none absolute z-[9] -translate-x-1/2 -translate-y-1/2"
                style={{ left: placementFeedback.x, top: placementFeedback.y }}
              >
                <div className="rounded-full bg-[#10243f] px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-slate-300/80">
                  {placementFeedback.label} 생성됨
                </div>
              </div>
            ) : null}

            {canvasPlacementPreview ? (
              <div
                className="pointer-events-none absolute z-[9]"
                style={{ left: canvasPlacementPreview.x, top: canvasPlacementPreview.y }}
              >
                <div className={`w-[232px] rounded-[24px] border px-4 py-3 shadow-lg backdrop-blur ${canvasPlacementPreview.tone}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold">
                      {canvasPlacementPreview.label}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-70">
                      Preview
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold">
                    {canvasPlacementPreview.hint}
                  </p>
                  <p className="mt-1 text-xs leading-5 opacity-75">
                    클릭하면 이 위치에 공용 아이템이 생성됩니다.
                  </p>
                </div>
              </div>
            ) : null}

            {problemIdeaDrag && problemIdeaDragPoint ? (
              <div
                className="pointer-events-none fixed z-[80] w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-violet-200 bg-white/95 px-4 py-3 shadow-[0_18px_42px_rgba(15,23,42,0.20)] backdrop-blur"
                style={{
                  left: problemIdeaDragPoint.x,
                  top: problemIdeaDragPoint.y,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
                    {problemIdeaDrag.cardKind === "summary" ? "요약/토픽" : "아이디어"}
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    이동 중
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-slate-900">
                  {problemIdeaDrag.title || "이동 중인 카드"}
                </p>
              </div>
            ) : null}

            {ideationDragGhost && ideationDragGhostItem ? (
              <div
                className="pointer-events-none fixed z-[85] w-[min(17.5rem,72vw)] -translate-x-1/2 -translate-y-[18%] opacity-95"
                style={{
                  left: ideationDragGhost.x,
                  top: ideationDragGhost.y,
                }}
              >
                {makeIdeationDragGhostLabel(
                  ideationDragGhostItem,
                  ideationDropPreview?.mode === "detach"
                    ? "왼쪽에 추가"
                    : ideationDropPreview?.mode === "topic"
                    ? "토픽으로 이동"
                    : "이동 중",
                )}
              </div>
            ) : null}

            {stage === "problem-definition" && problemGroups.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
                <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-lg shadow-slate-200/70">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-600">Problem Definition</p>
                  <p className="mt-2 text-base text-slate-700">
                    {busy ? "문제 정의 그룹을 생성하는 중입니다." : "문제 정의 그룹이 아직 없습니다."}
                  </p>
                </div>
              </div>
            ) : null}

            {stage === "solution" && solutionTopics.length === 0 && !solutionStagePending ? (
              <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
                <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-lg shadow-slate-200/70">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-600">Solution Stage</p>
                  <p className="mt-2 text-base text-slate-700">
                    {problemGroups.some((group) => group.status === "final")
                      ? "해결책 토픽을 준비하는 중입니다."
                      : "확정된 문제 정의 그룹이 있어야 해결책을 만들 수 있습니다."}
                  </p>
                </div>
              </div>
            ) : null}

            {problemDefinitionStagePending ? (
              <div className="absolute inset-0 z-[6] flex items-center justify-center bg-white/78 backdrop-blur-[2px]">
                <div className="w-[min(440px,90%)] rounded-[28px] border border-slate-200 bg-white px-8 py-7 text-center shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-violet-100 text-4xl">
                    ⏳
                  </div>
                  <p className="mt-5 text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                    Problem Definition
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold text-slate-900">
                    문제정의 단계를 준비하고 있습니다
                  </h3>
                  <p className="mt-3 text-base leading-7 text-slate-500">
                    안건과 메모를 묶어서 문제정의 그룹을 만드는 중입니다.
                  </p>
                </div>
              </div>
            ) : null}

            {solutionStagePending ? (
              <div className="absolute inset-0 z-[6] flex items-center justify-center bg-white/78 backdrop-blur-[2px]">
                <div className="w-[min(520px,92%)] rounded-[28px] border border-slate-200 bg-white px-8 py-7 text-center shadow-[0_28px_70px_rgba(15,23,42,0.12)]">
                  <div className="mx-auto flex w-full max-w-[320px] items-center justify-center gap-5">
                    <div className="grid grid-cols-2 gap-3">
                      {[0, 1, 2, 3].map((item) => (
                        <div
                          key={`loading-problem-${item}`}
                          className="h-16 w-16 animate-pulse rounded-2xl bg-violet-100 shadow-sm"
                        />
                      ))}
                    </div>
                    <div className="flex flex-col items-center gap-2 text-slate-400">
                      <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-slate-700" />
                      <span className="text-xs font-semibold uppercase tracking-[0.18em]">AI</span>
                    </div>
                    <div className="space-y-3">
                      <div className="h-8 w-28 animate-pulse rounded-2xl bg-emerald-100" />
                      <div className="h-16 w-28 animate-pulse rounded-2xl bg-emerald-50" />
                    </div>
                  </div>
                  <p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Solution Stage
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold text-slate-900">
                    해결책 단계를 준비하고 있습니다
                  </h3>
                  <p className="mt-3 text-base leading-7 text-slate-500">
                    확정된 문제 정의 그룹을 바탕으로 해결 방향과 실행 아이디어를 정리하는 중입니다.
                  </p>
                </div>
              </div>
            ) : null}

            {canvasStatusMessage ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-[clamp(84px,12vh,112px)] z-10 flex justify-center px-4">
                <div className="max-w-[min(640px,calc(100%-32px))] rounded-full border border-black/10 bg-white/95 px-4 py-2 text-center text-xs leading-5 text-[#4d4d4d] shadow-[0_5.64px_22.56px_rgba(0,0,0,0.05)] backdrop-blur-sm">
                  {canvasStatusMessage}
                </div>
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-x-0 bottom-[clamp(16px,3vh,32px)] z-10 flex justify-center px-3">
              <div className="pointer-events-auto flex min-h-[clamp(52px,7vh,60px)] w-auto max-w-[min(720px,calc(100%-24px))] flex-wrap items-center justify-center gap-2 rounded-[16px] border border-black/10 bg-white px-[clamp(10px,1.2vw,12px)] py-2 text-[#4d4d4d] shadow-[0_5.64px_22.56px_rgba(0,0,0,0.05)]">
                {visibleCanvasTools.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => armCanvasTool(item)}
                    disabled={!canUseCanvasToolbar}
                    className={`flex h-[clamp(36px,4.4vh,40px)] min-w-[clamp(74px,7vw,92px)] shrink-0 items-center justify-center rounded-[12px] px-[clamp(12px,1.2vw,16px)] text-[clamp(13px,1vw,16px)] font-medium transition-all duration-150 ease-out ${
                      armedCanvasTool === item
                        ? "bg-[#1b59f8]/10 text-[#1b59f8]"
                        : "text-[#4d4d4d] hover:bg-black/5"
                    } disabled:cursor-not-allowed disabled:opacity-45`}
                  >
                    <span>{toolLabel(item, stage)}</span>
                  </button>
                ))}
                {armedCanvasTool ? (
                  <span className="hidden shrink-0 rounded-full bg-[#eff0f6] px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] sm:inline-flex">
                    클릭 대기
                  </span>
                ) : null}
              </div>
            </div>
          </section>

          <div className={rightDrawerWrapperClassName}>
            <button
              type="button"
              aria-label={rightDrawerCollapsed ? "오른쪽 패널 열기" : "오른쪽 패널 접기"}
              onClick={toggleRightDrawer}
              className={rightDrawerToggleClassName}
            >
              <KeyboardDoubleArrowLeftIcon className={rightDrawerToggleIconClassName} />
            </button>
            <button
              type="button"
              aria-label="오른쪽 패널 너비 조절"
              onMouseDown={startPanelResize("right")}
              className={rightDrawerResizeHandleClassName}
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-black/10" />
            </button>
            <div className={rightDrawerPanelStackClassName}>
            {rightDrawerShowsDetailPanel ? (
              <RightDrawerPanel
                className={rightDrawerTopPanelClassName}
                bodyClassName={rightDrawerBodyClassName}
                bodyStyle={rightDrawerBodyStyle}
              >
                <RightDetailPanelShell
                  collapsed={rightDrawerDetailCollapsed}
                  onToggleCollapsed={() => setRightDrawerDetailCollapsed((prev) => !prev)}
                >
                  {leftPanelDetail ? (
                    <>
                      {renderDetailHeaderSection()}

                      {renderDetailKeywordSection()}

                      {renderProblemInsightSection()}

                      {renderDetailSummarySection()}

                      {renderSolutionDetailSections()}
                      {renderGeneralOrganizeSection()}
                      {renderIdeationRelatedSections()}
                      {renderProblemRelatedSections()}
                    </>
                  ) : (
                    <RightDetailEmptyState />
                  )}
                </RightDetailPanelShell>
              </RightDrawerPanel>
            ) : null}

            <RightDrawerPanel
              className={rightDrawerBottomPanelClassName}
              bodyClassName={rightDrawerBodyClassName}
              bodyStyle={rightDrawerBodyStyle}
            >
            <RightDrawerNotesPanel
              collapsed={rightDrawerNotesCollapsed}
              noteCount={projectPersonalNotes.length}
              onToggleCollapsed={() => setRightDrawerNotesCollapsed((prev) => !prev)}
            >
                <PersonalNoteComposer
                  agendaModels={agendaModels}
                  composerAgendaId={composerAgendaId}
                  composerTitle={composerTitle}
                  composerBody={composerBody}
                  composerLinkedCanvasItemId={composerLinkedCanvasItemId}
                  composerLinkedCanvasItemTitle={composerLinkedCanvasItemTitle}
                  pendingPersonalNoteLinkId={pendingPersonalNoteLinkId}
                  composerBodyRef={composerBodyRef}
                  onAgendaChange={setComposerAgendaId}
                  onTitleChange={setComposerTitle}
                  onBodyChange={setComposerBody}
                  onStartLinkSelection={() => {
                    setPendingPersonalNoteLinkId(COMPOSER_PERSONAL_NOTE_LINK_ID);
                    setStage("ideation");
                    setLeftPanelTab("detail");
                    setActivityMessage("캔버스에서 이 메모에 미리 연결할 아이디어 노드를 클릭해 주세요.");
                  }}
                  onClearLinkedIdea={() => {
                    setComposerLinkedCanvasItemId("");
                    setComposerLinkedCanvasItemTitle("");
                  }}
                  onCancelPendingLink={() => setPendingPersonalNoteLinkId("")}
                  onSave={handleAddPersonalNote}
                />
            </RightDrawerNotesPanel>

            {rightDrawerNotesCollapsed ? null : (
              <PersonalNoteList
                notes={projectPersonalNotes}
                stage={stage}
                agendaModels={agendaModels}
                editingPersonalNoteId={editingPersonalNoteId}
                draggingPersonalNoteId={draggingPersonalNoteId}
                personalNoteDraftAgendaId={personalNoteDraftAgendaId}
                personalNoteDraftTitle={personalNoteDraftTitle}
                personalNoteDraftBody={personalNoteDraftBody}
                onDragStartNote={setDraggingPersonalNoteId}
                onDragEndNote={() => {
                  setDraggingPersonalNoteId("");
                  setDropProblemGroupId("");
                }}
                onDraftAgendaChange={setPersonalNoteDraftAgendaId}
                onDraftTitleChange={setPersonalNoteDraftTitle}
                onDraftBodyChange={setPersonalNoteDraftBody}
                onCancelEdit={handleCancelPersonalNoteEdit}
                onSaveEdit={handleSavePersonalNoteEdit}
                onStartEdit={handleStartPersonalNoteEdit}
                onDelete={handleDeletePersonalNote}
                onFocusLinkedIdea={(itemId) => focusCanvasItemInIdeation(itemId, "개인 메모와 연결된 아이디어로 이동했습니다.")}
                onStartRelink={(noteId, hasExistingLink) => {
                  setPendingPersonalNoteLinkId(noteId);
                  setStage("ideation");
                  setActivityMessage(hasExistingLink ? "캔버스에서 새로 연결할 아이디어 노드를 클릭해 주세요." : "캔버스에서 연결할 아이디어 노드를 클릭해 주세요.");
                }}
                onUnlinkIdea={(noteId) =>
                  setPersonalNotes((prev) =>
                    prev.map((item) =>
                      item.id === noteId
                        ? {
                            ...item,
                            linkedCanvasItemId: "",
                            linkedCanvasItemTitle: "",
                          }
                        : item,
                    ),
                  )
                }
              />
            )}
            </RightDrawerPanel>
            </div>
          </div>
        </div>
      </section>

      {endMeetingConfirmOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-[560px] overflow-hidden rounded-[18px] border border-black/10 bg-white shadow-2xl">
            <div className="border-b border-black/10 px-7 py-6">
              <p className="text-sm font-semibold text-[#ef4e4e]">회의 종료 확인</p>
              <h2 className="mt-2 text-2xl font-semibold text-black">
                {(endMeetingPreview?.finalCount || 0) > 0 ? "회의를 종료할까요?" : "최종 결과 없이 종료할까요?"}
              </h2>
              <p className="mt-3 text-sm leading-6 text-[#4d4d4d]">
                {(endMeetingPreview?.finalCount || 0) > 0
                  ? `최종 결과 ${endMeetingPreview?.finalCount || 0}개가 대시보드 결과 확인에 저장됩니다.`
                  : "현재 최종 결과로 선택된 항목이 없습니다. 그대로 종료하면 대시보드 결과 확인에 표시할 내용이 없습니다."}
              </p>
            </div>
            <div className="space-y-3 px-7 py-5">
              <div className="rounded-[14px] bg-[#f9f9f9] px-4 py-3">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium text-[#4d4d4d]">저장될 최종 항목</span>
                  <span className="font-semibold text-black">{endMeetingPreview?.finalCount || 0}개</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium text-[#4d4d4d]">포함된 해결책 그룹</span>
                  <span className="font-semibold text-black">{endMeetingPreview?.topicCount || 0}개</span>
                </div>
              </div>
              {(endMeetingPreview?.finalCount || 0) === 0 ? (
                <p className="rounded-[14px] border border-[#f0c6c6] bg-[#fff5f5] px-4 py-3 text-sm font-medium leading-6 text-[#b23b3b]">
                  결과를 남기려면 해결책 단계에서 카드의 `최종 결론` 표시를 먼저 선택해 주세요.
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-black/10 px-7 py-5">
              <button
                type="button"
                onClick={handleCancelEndMeeting}
                disabled={endMeetingSaving}
                className="inline-flex h-11 items-center justify-center rounded-[12px] bg-[#eff0f6] px-5 text-sm font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee] disabled:cursor-not-allowed disabled:opacity-50"
              >
                돌아가기
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmEndMeeting()}
                disabled={endMeetingSaving}
                className="inline-flex h-11 items-center justify-center rounded-[12px] bg-[#ef4e4e] px-5 text-sm font-semibold text-white transition hover:bg-[#df3f3f] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {endMeetingSaving ? "저장 중" : (endMeetingPreview?.finalCount || 0) > 0 ? "저장하고 종료" : "결과 없이 종료"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
