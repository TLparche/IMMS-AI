"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type RefObject, type ReactNode } from "react";
import {
  getCanvasWorkspaceState,
  getCanvasPersonalNotes,
  confirmCanvasPlacement,
  getCanvasIdeaAssimilationWorkspaceJob,
  getCanvasProblemDiscussionWorkspaceJob,
  generateProblemGroupConclusion,
  generateProblemGroupingRationale,
  generateProblemStructure,
  generateCanvasProblemTaxonomy,
  generateCanvasSolutionStage,
  generateCanvasSummaryDocument,
  flushCanvasPersonalNotes,
  flushCanvasWorkspacePatch,
  importAgendaSnapshot,
  saveCanvasPersonalNotes,
  saveCanvasWorkspacePatch,
  startCanvasProblemDiscussionWorkspace,
  startCanvasTopicSummaryWorkspace,
  askCanvasQuickQuestion,
  extractCanvasIdeationKeywords,
} from "@/lib/api";
import type {
  AgendaActionItemDetail,
  AgendaDecisionDetail,
  CanvasCustomGroup,
  CanvasFinalSolutionSummary,
  CanvasLocalState,
  CanvasNodePositionsByStage,
  CanvasProblemDefinitionGroup,
  CanvasProblemStructureState,
  CanvasRealtimeSyncPayload,
  CanvasRefinedUtterance,
  CanvasProblemDiscussionItem,
  CanvasSummaryDocumentSection,
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
type ProblemCanvasToolbarAction =
  | "group"
  | "problem-link"
  | "debug-regenerate"
  | "debug-refresh-chunks"
  | "structure-start"
  | "structure-back"
  | "structure-ai-group"
  | "structure-add-group"
  | "structure-refresh"
  | "note"
  | "problem-idea"
  | "adopt";
type LeftPanelTab = "detail";
type ProblemGroupStatus = "draft" | "review" | "final";
type CanvasItemStatus = "discussion" | "confirmed" | "closed";
type SolutionAiSuggestionStatus = "draft" | "selected" | "dismissed";
type SolutionNoteSource = "ai" | "user";
type ProblemDefinitionMode = "" | "manual" | "ai";
type ProblemDefinitionPhase = "explore" | "structure";
type ProblemStructureMethod = "affinity" | "card-sorting";
const CANVAS_STAGES: CanvasStage[] = ["ideation", "problem-definition", "solution"];
const CANVAS_LLM_FAILURE_RETRY_DELAY_MS = 60_000;
const CANVAS_LLM_SILENCE_FLUSH_MS = 8_000;
const PROBLEM_STRUCTURE_NODE_DRAG_MIME = "application/x-imms-problem-structure-node";
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

function clipClientText(value: unknown, limit: number) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
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

type ProblemGroupingRationaleViewModel = {
  groupId: string;
  rationale: string;
  basisItems: string[];
  usedLlm: boolean;
  warning?: string;
  generatedAt?: string;
};

type ProblemStructureNodeViewModel = {
  id: string;
  sourceGroupId: string;
  title: string;
  body: string;
  status: ProblemGroupStatus;
  depth: number;
};

type ProblemStructureGroupViewModel = {
  id: string;
  title: string;
  nodeIds: string[];
  rationale: string;
  status: ProblemGroupStatus;
  createdBy: "ai" | "user";
};

type ProblemStructureDragState = {
  nodeId: string;
  overGroupId: string;
  overNodeId: string;
  mode: "group" | "node" | "";
};

type CanvasQuickAskMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  status: "pending" | "done" | "error";
  warning?: string;
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
  problem_structure: string;
  solution_topics: string;
  final_solution_summary: string;
  node_positions: string;
  imported_state: string;
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

function createWorkspaceFieldSignatures(): WorkspaceFieldSignatures {
  return {
    meeting_goal: "",
    meeting_goal_context: "",
    stage: "",
    agenda_overrides: "",
    canvas_items: "",
    custom_groups: "",
    problem_groups: "",
    problem_structure: "",
    solution_topics: "",
    final_solution_summary: "",
    node_positions: "",
    imported_state: "",
  };
}

function buildWorkspaceProblemGroupsPayload(groups: ProblemGroupViewModel[]) {
  return groups.map((group) => ({
    group_id: group.group_id,
    parent_group_id: group.parent_group_id || "",
    depth: group.depth || 0,
    topic: group.topic,
    insight_lens: group.insight_lens,
    insight_user_edited: group.insight_user_edited,
    keywords: group.keywords,
    agenda_ids: group.agenda_ids,
    agenda_titles: group.agenda_titles,
    ideas: group.ideas,
    source_summary_items: group.source_summary_items,
    discussion_items: group.discussion_items || [],
    linked_group_ids: group.linked_group_ids || [],
    evidence_utterance_ids: group.evidence_utterance_ids || [],
    conclusion: group.conclusion,
    conclusion_user_edited: group.conclusion_user_edited,
    status: group.status,
    source_signature: group.source_signature,
    source_agenda_signatures: group.source_agenda_signatures,
    source_idea_signatures: group.source_idea_signatures,
  }));
}

function buildProblemTaxonomyExistingGroupsPayload(groups: ProblemGroupViewModel[]) {
  return groups.map((group) => ({
    group_id: group.group_id,
    parent_group_id: group.parent_group_id || "",
    depth: group.depth || 0,
    topic: group.topic,
    evidence_utterance_ids: group.evidence_utterance_ids || [],
    source_summary_items: group.source_summary_items || [],
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

function createEmptyFinalSolutionSummary(): CanvasFinalSolutionSummary {
  return {
    final_count: 0,
    topics: [],
    items: [],
    markdown: "",
    document_status: "empty",
    generated_at: "",
    used_llm: false,
    warning: "",
    source_signature: "",
    sections: [],
  };
}

function normalizeFinalSolutionSummaryPayload(raw?: CanvasFinalSolutionSummary | null): CanvasFinalSolutionSummary {
  const fallback = createEmptyFinalSolutionSummary();
  if (!raw || typeof raw !== "object") return fallback;
  const markdown = typeof raw.markdown === "string" ? raw.markdown : "";
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map((section) => ({
        group_id: section.group_id || "",
        title: section.title || "요약 그룹",
        status: section.status || "draft",
        status_label: section.status_label || (section.status === "review" ? "검토 중" : section.status === "final" ? "확정" : "초안"),
        rationale: section.rationale || "",
        node_titles: Array.isArray(section.node_titles) ? section.node_titles.filter(Boolean) : [],
        evidence: Array.isArray(section.evidence)
          ? section.evidence
              .map((item) => ({
                utterance_id: item.utterance_id || "",
                speaker: item.speaker || "참가자",
                timestamp: item.timestamp || "",
                text: item.text || "",
              }))
              .filter((item) => item.text)
          : [],
      }))
    : [];

  return {
    final_count: Math.max(Number.isFinite(raw.final_count) ? raw.final_count : raw.items?.length || 0, sections.length),
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    items: Array.isArray(raw.items) ? raw.items : [],
    markdown,
    document_status: raw.document_status || (markdown ? "ready" : "empty"),
    generated_at: raw.generated_at || "",
    used_llm: Boolean(raw.used_llm),
    warning: raw.warning || "",
    source_signature: raw.source_signature || "",
    sections,
  };
}

function buildFinalSolutionSummaryPayload(
  topics: SolutionTopicViewModel[],
  summaryDocument?: CanvasFinalSolutionSummary | null,
): CanvasFinalSolutionSummary {
  if (summaryDocument) {
    return normalizeFinalSolutionSummaryPayload(summaryDocument);
  }
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
    document_status: markdown ? "ready" : "empty",
    sections: [],
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
  problemStructure?: CanvasProblemStructureState;
  solutionTopics: SolutionTopicViewModel[];
  finalSolutionSummary?: CanvasFinalSolutionSummary;
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
    problem_structure: JSON.stringify(input.problemStructure || createDefaultProblemStructureState()),
    solution_topics: JSON.stringify(buildWorkspaceSolutionTopicsPayload(input.solutionTopics)),
    final_solution_summary: JSON.stringify(buildFinalSolutionSummaryPayload(input.solutionTopics, input.finalSolutionSummary)),
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
  problemStructure?: CanvasProblemStructureState;
  solutionTopics: SolutionTopicViewModel[];
  finalSolutionSummary?: CanvasFinalSolutionSummary;
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
    problem_structure: input.problemStructure || createDefaultProblemStructureState(),
    solution_topics: buildWorkspaceSolutionTopicsPayload(input.solutionTopics),
    final_solution_summary: buildFinalSolutionSummaryPayload(input.solutionTopics, input.finalSolutionSummary),
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

type IdeationKeywordBubble = {
  id: string;
  text: string;
  count: number;
  weight: number;
  related: string[];
};

type IdeationKeywordBubblePlacement = {
  bubble: IdeationKeywordBubble;
  x: number;
  y: number;
  size: number;
};

type IdeationKeywordBubbleClusterBox = {
  width: number;
  height: number;
  placements: Array<{
    bubble: IdeationKeywordBubble;
    x: number;
    y: number;
    size: number;
  }>;
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
  return "요약";
}

function syncModeLabel(enabled: boolean) {
  return enabled ? "공유 ON" : "공유 OFF";
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

function extractProblemSourceCanvasNodeInfo(nodeId: string) {
  if (!nodeId.startsWith("problem-source::")) return null;
  const [, encodedGroupId = "", encodedSourceNodeId = ""] = nodeId.split("::");
  try {
    return {
      groupId: decodeURIComponent(encodedGroupId),
      sourceNodeId: decodeURIComponent(encodedSourceNodeId),
    };
  } catch {
    return null;
  }
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

function problemStructureMethodLabel(method: ProblemStructureMethod) {
  return method === "card-sorting" ? "Card Sorting" : "Affinity Diagram";
}

function problemDefinitionModeLabel(mode: ProblemDefinitionMode) {
  if (mode === "ai") return "AI 초안";
  if (mode === "manual") return "직접 구성";
  return "미선택";
}

function normalizeCanvasItemStatus(raw: string | undefined): CanvasItemStatus {
  if (raw === "confirmed" || raw === "final") return "confirmed";
  if (raw === "closed") return "closed";
  return "discussion";
}

function normalizeProblemGroupStatus(raw: string | undefined): ProblemGroupStatus {
  if (raw === "review" || raw === "final") return raw;
  return "draft";
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

function makeProblemStructureNode(group: ProblemGroupViewModel): ProblemStructureNodeViewModel {
  const body =
    group.conclusion ||
    group.insight_lens ||
    (group.source_summary_items || []).find(Boolean) ||
    "정의 1단계에서 가져온 노드입니다.";
  return {
    id: group.group_id,
    sourceGroupId: group.group_id,
    title: group.topic || "문제정의 노드",
    body: stripLeadingTimestamp(body),
    status: group.status,
    depth: Math.max(0, group.depth || 0),
  };
}

function buildProblemStructureNodesFromGroups(groups: ProblemGroupViewModel[]) {
  return groups.map(makeProblemStructureNode);
}

function makeProblemStructureGroup(index: number, createdBy: "ai" | "user" = "user"): ProblemStructureGroupViewModel {
  const id = `structure-group-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 6)}`;
  return {
    id,
    title: `구조화 그룹 ${index + 1}`,
    nodeIds: [],
    rationale: "",
    status: "draft",
    createdBy,
  };
}

function makeProblemStructurePairGroupTitle(
  sourceNode: ProblemStructureNodeViewModel,
  targetNode: ProblemStructureNodeViewModel,
) {
  const sourceTitle = sourceNode.title.trim();
  const targetTitle = targetNode.title.trim();
  if (!sourceTitle && !targetTitle) return "새 구조화 그룹";
  return [targetTitle, sourceTitle]
    .filter(Boolean)
    .map((title) => (title.length > 14 ? `${title.slice(0, 14)}...` : title))
    .join(" + ");
}

function pruneProblemStructureGroups(
  groups: ProblemStructureGroupViewModel[],
  nodes: ProblemStructureNodeViewModel[],
) {
  const validNodeIds = new Set(nodes.map((node) => node.id));
  return groups.map((group) => ({
    ...group,
    nodeIds: group.nodeIds.filter((nodeId) => validNodeIds.has(nodeId)),
  }));
}

function normalizeProblemStructureGroupsFromResponse(
  groups: Array<{
    id?: string;
    title?: string;
    node_ids?: string[];
    rationale?: string;
    status?: string;
    created_by?: string;
  }>,
  nodes: ProblemStructureNodeViewModel[],
): ProblemStructureGroupViewModel[] {
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const usedNodeIds = new Set<string>();
  const usedGroupIds = new Set<string>();

  return groups
    .map((group, index) => {
      const nodeIds = (group.node_ids || []).filter((nodeId) => {
        if (!validNodeIds.has(nodeId) || usedNodeIds.has(nodeId)) {
          return false;
        }
        usedNodeIds.add(nodeId);
        return true;
      });
      if (nodeIds.length === 0) {
        return null;
      }
      const baseId = group.id || `structure-ai-group-${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (usedGroupIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedGroupIds.add(id);
      return {
        id,
        title: group.title?.trim() || `AI 구조화 그룹 ${index + 1}`,
        nodeIds,
        rationale: group.rationale?.trim() || "",
        status: normalizeProblemGroupStatus(group.status),
        createdBy: group.created_by === "user" ? "user" : "ai",
      } satisfies ProblemStructureGroupViewModel;
    })
    .filter((group): group is ProblemStructureGroupViewModel => Boolean(group));
}

function buildProblemStructureStatePayload(input: {
  phase: ProblemDefinitionPhase;
  method: ProblemStructureMethod;
  mode: ProblemDefinitionMode;
  nodes: ProblemStructureNodeViewModel[];
  groups: ProblemStructureGroupViewModel[];
}): CanvasProblemStructureState {
  return {
    phase: input.phase,
    method: input.method,
    mode: input.mode,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      source_group_id: node.sourceGroupId,
      title: node.title,
      body: node.body,
      status: node.status,
      depth: node.depth,
    })),
    groups: input.groups.map((group) => ({
      id: group.id,
      title: group.title,
      node_ids: group.nodeIds,
      rationale: group.rationale,
      status: group.status,
      created_by: group.createdBy,
    })),
  };
}

function createDefaultProblemStructureState(): CanvasProblemStructureState {
  return buildProblemStructureStatePayload({
    phase: "explore",
    method: "affinity",
    mode: "",
    nodes: [],
    groups: [],
  });
}

function hydrateProblemStructureState(
  raw: CanvasProblemStructureState | null | undefined,
  fallbackProblemGroups: ProblemGroupViewModel[] = [],
): {
  phase: ProblemDefinitionPhase;
  method: ProblemStructureMethod;
  mode: ProblemDefinitionMode;
  nodes: ProblemStructureNodeViewModel[];
  groups: ProblemStructureGroupViewModel[];
} {
  const phase: ProblemDefinitionPhase = raw?.phase === "structure" ? "structure" : "explore";
  const method: ProblemStructureMethod = raw?.method === "card-sorting" ? "card-sorting" : "affinity";
  const mode: ProblemDefinitionMode = raw?.mode === "ai" || raw?.mode === "manual" ? raw.mode : "";
  const nodes = (raw?.nodes || [])
    .map((node) => ({
      id: node.id?.trim() || "",
      sourceGroupId: node.source_group_id?.trim() || node.id?.trim() || "",
      title: node.title?.trim() || "문제정의 노드",
      body: node.body?.trim() || "정의 1단계에서 가져온 노드입니다.",
      status: normalizeProblemGroupStatus(node.status),
      depth: Math.max(0, Number(node.depth || 0)),
    }))
    .filter((node) => node.id && node.title);
  const fallbackNodes = nodes.length > 0 ? nodes : buildProblemStructureNodesFromGroups(fallbackProblemGroups);
  const validNodeIds = new Set(fallbackNodes.map((node) => node.id));
  const groups = (raw?.groups || [])
    .map((group) => ({
      id: group.id?.trim() || "",
      title: group.title?.trim() || "구조화 그룹",
      nodeIds: (group.node_ids || []).filter((nodeId) => validNodeIds.has(nodeId)),
      rationale: group.rationale?.trim() || "",
      status: normalizeProblemGroupStatus(group.status),
      createdBy: group.created_by === "ai" ? ("ai" as const) : ("user" as const),
    }))
    .filter((group) => group.id && (group.title || group.nodeIds.length > 0));

  return {
    phase: fallbackNodes.length > 0 ? phase : "explore",
    method,
    mode,
    nodes: fallbackNodes,
    groups: pruneProblemStructureGroups(groups, fallbackNodes),
  };
}

function problemStructureStatusLabel(status: string) {
  if (status === "final") return "확정";
  if (status === "review") return "검토 중";
  return "초안";
}

function getSummaryEligibleStructureGroups(groups: ProblemStructureGroupViewModel[]) {
  return groups.filter((group) => group.status === "final" || group.status === "review");
}

function buildSummaryDocumentSourceSignature(
  groups: ProblemStructureGroupViewModel[],
  nodes: ProblemStructureNodeViewModel[],
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return JSON.stringify(
    getSummaryEligibleStructureGroups(groups).map((group) => ({
      id: group.id,
      title: group.title,
      status: group.status,
      rationale: group.rationale,
      nodeIds: group.nodeIds,
      nodes: group.nodeIds.map((nodeId) => {
        const node = nodeById.get(nodeId);
        return {
          id: nodeId,
          sourceGroupId: node?.sourceGroupId || "",
          title: node?.title || "",
          body: node?.body || "",
        };
      }),
    })),
  );
}

function buildSummaryDocumentFromResponse(input: {
  markdown: string;
  sections: CanvasSummaryDocumentSection[];
  generatedAt: string;
  usedLlm: boolean;
  warning?: string;
  sourceSignature: string;
}): CanvasFinalSolutionSummary {
  return normalizeFinalSolutionSummaryPayload({
    final_count: input.sections.length,
    topics: [],
    items: [],
    markdown: input.markdown,
    document_status: input.markdown.trim() ? "ready" : "empty",
    generated_at: input.generatedAt,
    used_llm: input.usedLlm,
    warning: input.warning || "",
    source_signature: input.sourceSignature,
    sections: input.sections,
  });
}

function renderSummaryMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`code-${match.index}`} className="rounded-[4px] bg-[#eef4ff] px-1.5 py-0.5 font-mono text-[0.92em] text-[#1b59f8]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={`strong-${match.index}`} className="font-semibold text-black">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderSummaryMarkdownPreview(markdown: string, onEdit: () => void) {
  const lines = markdown.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="my-3 space-y-1.5 pl-5 text-[15px] leading-7 text-[#334155]">
        {listItems.map((item, itemIndex) => (
          <li key={`list-${blocks.length}-${itemIndex}`} className="list-disc">
            {renderSummaryMarkdownInline(item)}
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  while (index < lines.length) {
    const rawLine = lines[index] || "";
    const line = rawLine.trim();

    if (!line) {
      flushList();
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1] || "")) {
      flushList();
      const headers = parseMarkdownTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] || "").includes("|") && (lines[index] || "").trim()) {
        rows.push(parseMarkdownTableRow(lines[index] || ""));
        index += 1;
      }
      blocks.push(
        <div key={`table-${blocks.length}`} className="my-4 overflow-x-auto border border-black/10 bg-white">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="bg-[#f5f6f8] text-black">
              <tr>
                {headers.map((header, headerIndex) => (
                  <th key={`table-head-${headerIndex}`} className="border-b border-black/10 px-3 py-2 font-semibold">
                    {renderSummaryMarkdownInline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`table-row-${rowIndex}`} className="border-b border-black/5 last:border-b-0">
                  {headers.map((_, cellIndex) => (
                    <td key={`table-cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 align-top text-[#334155]">
                      {renderSummaryMarkdownInline(row[cellIndex] || "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const content = heading[2];
      const className =
        level === 1
          ? "mb-5 mt-1 text-3xl font-semibold leading-tight text-black"
          : level === 2
            ? "mb-3 mt-8 border-t border-black/10 pt-5 text-xl font-semibold leading-8 text-black first:mt-0 first:border-t-0 first:pt-0"
            : "mb-2 mt-5 text-base font-semibold leading-7 text-[#1f2937]";
      const headingContent = renderSummaryMarkdownInline(content);
      if (level === 1) {
        blocks.push(<h1 key={`heading-${index}`} className={className}>{headingContent}</h1>);
      } else if (level === 2) {
        blocks.push(<h2 key={`heading-${index}`} className={className}>{headingContent}</h2>);
      } else if (level === 3) {
        blocks.push(<h3 key={`heading-${index}`} className={className}>{headingContent}</h3>);
      } else {
        blocks.push(<h4 key={`heading-${index}`} className={className}>{headingContent}</h4>);
      }
      index += 1;
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (listMatch) {
      listItems.push(listMatch[1]);
      index += 1;
      continue;
    }

    flushList();
    blocks.push(
      <p key={`paragraph-${index}`} className="my-3 text-[15px] leading-8 text-[#334155]">
        {renderSummaryMarkdownInline(line)}
      </p>,
    );
    index += 1;
  }

  flushList();

  return (
    <button
      type="button"
      onClick={onEdit}
      className="h-full w-full overflow-y-auto border border-black/10 bg-white px-8 py-7 text-left outline-none transition hover:border-[#1b59f8]/30 focus:border-[#1b59f8]/30 focus:ring-2 focus:ring-[#1b59f8]/10"
    >
      {blocks.length > 0 ? blocks : (
        <p className="text-sm leading-7 text-[#999]">요약 문서가 아직 없습니다.</p>
      )}
    </button>
  );
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
      linked_group_ids: [
        ...new Set([
          ...(group.linked_group_ids || []),
          ...(previous?.linked_group_ids || []),
        ]),
      ].filter((linkedGroupId) => linkedGroupId && linkedGroupId !== group.group_id),
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

function buildProblemTaxonomyUtterances(transcripts: MeetingTranscript[]) {
  return normalizeTranscriptRows(transcripts)
    .filter((row) => (!row.canvas_stage || row.canvas_stage === "ideation") && stripLeadingTimestamp(row.text).trim())
    .map((row) => ({
      id: row.id,
      speaker: row.speaker || "참가자",
      text: stripLeadingTimestamp(row.text),
      timestamp: row.timestamp || "",
    }));
}

function buildIdeationKeywordUtterances(transcripts: MeetingTranscript[]) {
  return normalizeTranscriptRows(transcripts)
    .filter((row) => (!row.canvas_stage || row.canvas_stage === "ideation") && stripLeadingTimestamp(row.text).trim())
    .slice(-180)
    .map((row) => ({
      id: row.id,
      speaker: row.speaker || "참가자",
      text: stripLeadingTimestamp(row.text),
      timestamp: row.timestamp || "",
    }));
}

function normalizeIdeationKeywordBubblesFromResponse(
  keywords: Array<{ text?: string; count?: number; related?: string[] }>,
): IdeationKeywordBubble[] {
  const normalized = keywords
    .map((keyword) => ({
      text: String(keyword.text || "").trim(),
      count: Math.max(1, Number(keyword.count || 1)),
      related: (keyword.related || []).map((item) => String(item || "").trim()).filter(Boolean),
    }))
    .filter((keyword) => keyword.text.length >= 2);
  const maxCount = Math.max(1, ...normalized.map((keyword) => keyword.count));
  const selectedTexts = new Set(normalized.map((keyword) => keyword.text));
  return normalized.map((keyword) => ({
    id: `ideation-keyword-${encodeURIComponent(keyword.text)}`,
    text: keyword.text,
    count: keyword.count,
    weight: keyword.count / maxCount,
    related: keyword.related.filter((item) => selectedTexts.has(item) && item !== keyword.text).slice(0, 5),
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
  "about",
  "there",
  "would",
  "should",
  "could",
  "메모",
  "코멘트",
  "주제",
  "내용",
  "회의",
  "아이디어",
  "의견",
  "발언",
  "논의",
  "얘기",
  "이야기",
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
  "그리고",
  "그런데",
  "근데",
  "그래서",
  "그러면",
  "그러니까",
  "하지만",
  "일단",
  "우선",
  "약간",
  "진짜",
  "그냥",
  "너무",
  "조금",
  "좀",
  "저희",
  "우리",
  "제가",
  "저는",
  "나는",
  "이거",
  "그거",
  "저거",
  "여기",
  "거기",
  "저기",
  "이런",
  "그런",
  "저런",
  "대한",
  "관련",
  "부분",
  "경우",
  "정도",
  "사람",
  "사람들",
  "생각",
  "생각해",
  "같아요",
  "같은",
  "있어",
  "있고",
  "있습니다",
  "없어",
  "없고",
  "없습니다",
  "하는",
  "하고",
  "하면",
  "해서",
  "해야",
  "되는",
  "됩니다",
  "되면",
  "되어",
  "보면",
  "말씀",
]);

const CANVAS_ITEM_KEYWORD_SUFFIXES = [
  "으로부터",
  "에서부터",
  "이라고",
  "이라는",
  "라고",
  "라는",
  "적으로",
  "에게는",
  "에서는",
  "에도",
  "에서",
  "에게",
  "까지",
  "부터",
  "처럼",
  "보다",
  "으로",
  "이랑",
  "랑",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "에",
  "와",
  "과",
  "로",
  "의",
  "만",
];

const CANVAS_IDEATION_BUBBLE_NON_NOUN_PATTERNS = [
  /(하다|했다|한다|했던|하고|하며|하면|해서|해야|하기|하자|하죠|하게|하려|하려고|하려면|하던|할까|할지|해도|해요)$/u,
  /(되다|된다|됐다|되고|되면|되어|되는|되죠|돼요|됩니다)$/u,
  /(입니다|있는|있다|있고|있어|없다|없고|없어|같다|같은|같아요|싶다|싶은)$/u,
  /(좋다|좋은|나쁘다|나쁜|어렵다|어려운|쉽다|쉬운|많다|많은|적다|적은|크다|큰|작다|작은)$/u,
  /(아요|어요|워요|네요|군요|죠|지요|고요|습니다|습니까|면서|지만|거나|니까|어서|아서|려고|다고)$/u,
  /(하기도|되기도|한다면|한다고|한다는|한다면|해가지고|해보자|해보면|해봤|해줘|해줄|하는)$/u,
];
const CANVAS_IDEATION_BUBBLE_KOREAN_NON_NOUN_ENDINGS = [
  "했다",
  "한다",
  "하면",
  "해서",
  "해야",
  "하기",
  "되고",
  "되면",
  "되는",
  "있는",
  "없는",
];

const CANVAS_IDEATION_BUBBLE_ENGLISH_STOPWORDS = new Set([
  "make",
  "made",
  "doing",
  "done",
  "think",
  "want",
  "need",
  "maybe",
  "really",
  "just",
  "very",
  "more",
  "less",
]);
const CANVAS_KEYWORD_TOKEN_PATTERN = /[A-Za-z0-9가-힣][A-Za-z0-9가-힣+#._-]{1,}/g;
const CANVAS_IDEATION_BUBBLE_MIN_PHRASE_CHARS = 5;
const CANVAS_IDEATION_BUBBLE_MAX_PHRASE_CHARS = 18;
const CANVAS_IDEATION_BUBBLE_PHRASE_GAP_PATTERN = /^[ \t·ㆍ-]+$/u;
const CANVAS_IDEATION_BUBBLE_PLANE_WIDTH = 1280;
const CANVAS_IDEATION_BUBBLE_PLANE_HEIGHT = 820;
const CANVAS_IDEATION_BUBBLE_ORGANIC_GAP = 8;
const CANVAS_IDEATION_BUBBLE_CLUSTER_GAP = 52;
const CANVAS_IDEATION_BUBBLE_CLUSTER_MAX_ITEMS = 5;

function stripKoreanKeywordSuffixes(token: string) {
  let normalized = token;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CANVAS_ITEM_KEYWORD_SUFFIXES) {
      if (normalized.length <= suffix.length + 1 || !normalized.endsWith(suffix)) continue;
      normalized = normalized.slice(0, -suffix.length);
      changed = true;
      break;
    }
  }
  return normalized;
}

function isLikelyIdeationBubbleNoun(keyword: string) {
  if (!keyword || CANVAS_ITEM_KEYWORD_STOPWORDS.has(keyword)) return false;
  if (/^[a-z][a-z0-9+#._-]+$/i.test(keyword)) {
    return !CANVAS_IDEATION_BUBBLE_ENGLISH_STOPWORDS.has(keyword.toLowerCase());
  }
  if (!/[가-힣]/.test(keyword)) return false;
  if (/[가-힣][a-z0-9+#._-]+/i.test(keyword)) return false;
  if (CANVAS_IDEATION_BUBBLE_NON_NOUN_PATTERNS.some((pattern) => pattern.test(keyword))) return false;
  if (CANVAS_IDEATION_BUBBLE_KOREAN_NON_NOUN_ENDINGS.some((ending) => keyword.endsWith(ending))) return false;
  if (/(게|고|서|죠|요)$/u.test(keyword) && keyword.length <= 4) return false;
  if (/(적|화|성)$/u.test(keyword) && keyword.length < 3) return false;
  return true;
}

function shouldJoinIdeationNounPhrase(left: string, right: string) {
  const joinedLength = `${left}${right}`.length;
  if (
    joinedLength < CANVAS_IDEATION_BUBBLE_MIN_PHRASE_CHARS ||
    joinedLength > CANVAS_IDEATION_BUBBLE_MAX_PHRASE_CHARS
  ) {
    return false;
  }
  if (left.length <= 2 && right.length <= 2) return false;
  return true;
}

function extractIdeationBubbleTerms(text: string) {
  const cleanText = stripLeadingTimestamp(text);
  const matches = [...cleanText.matchAll(CANVAS_KEYWORD_TOKEN_PATTERN)];
  const nounTokens = matches
    .map((match) => {
      const keyword = normalizeCanvasItemKeyword(match[0]);
      if (!keyword || !isLikelyIdeationBubbleNoun(keyword)) return null;
      const start = match.index || 0;
      return {
        keyword,
        start,
        end: start + match[0].length,
      };
    })
    .filter((item): item is { keyword: string; start: number; end: number } => Boolean(item));
  const phraseTerms = new Set<string>();
  const tokenTerms = new Set<string>();

  nounTokens.forEach((token) => tokenTerms.add(token.keyword));
  for (let index = 0; index < nounTokens.length - 1; index += 1) {
    const left = nounTokens[index];
    const right = nounTokens[index + 1];
    const gap = cleanText.slice(left.end, right.start);
    if (!CANVAS_IDEATION_BUBBLE_PHRASE_GAP_PATTERN.test(gap)) continue;
    if (!shouldJoinIdeationNounPhrase(left.keyword, right.keyword)) continue;
    phraseTerms.add(`${left.keyword} ${right.keyword}`);
  }

  return [...phraseTerms, ...tokenTerms];
}

function normalizeCanvasItemKeyword(raw: string) {
  const token = raw
    .trim()
    .replace(/^#+/, "")
    .replace(/^[^\w가-힣]+|[^\w가-힣]+$/g, "");
  if (!token || token.length < 2 || /^\d+$/.test(token)) return "";

  const normalized = /[A-Za-z]/.test(token)
    ? token.toLowerCase()
    : stripKoreanKeywordSuffixes(token);
  if (!normalized || normalized.length < 2) return "";
  if (CANVAS_ITEM_KEYWORD_STOPWORDS.has(normalized)) return "";

  return normalized;
}

function extractCanvasItemKeywords(title: string, body: string, limit = 5) {
  const scores = new Map<string, { value: string; score: number; firstSeen: number }>();
  let cursor = 0;

  const addSource = (source: string, weight: number) => {
    const matches = source.match(CANVAS_KEYWORD_TOKEN_PATTERN) || [];
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

function normalizeProblemTaxonomyTopicKey(value: string) {
  return stripLeadingTimestamp(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function problemTaxonomyTopicTokens(value: string) {
  const matches = stripLeadingTimestamp(value).match(CANVAS_KEYWORD_TOKEN_PATTERN) || [];
  return new Set(
    matches
      .map((match) => normalizeCanvasItemKeyword(match))
      .filter((keyword) => keyword && !CANVAS_ITEM_KEYWORD_STOPWORDS.has(keyword)),
  );
}

function problemTaxonomyTopicOverlap(left: string, right: string) {
  const leftTokens = problemTaxonomyTopicTokens(left);
  const rightTokens = problemTaxonomyTopicTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function areProblemTaxonomyTopicsSimilar(left: string, right: string) {
  const leftKey = normalizeProblemTaxonomyTopicKey(left);
  const rightKey = normalizeProblemTaxonomyTopicKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;

  const leftTokens = problemTaxonomyTopicTokens(left);
  const rightTokens = problemTaxonomyTopicTokens(right);
  if (Math.min(leftTokens.size, rightTokens.size) < 2) return false;

  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return overlap >= 2 && overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size)) >= 0.8;
}

function problemTaxonomyEvidenceOverlap(leftIds: string[] | undefined, rightIds: string[] | undefined) {
  const left = new Set((leftIds || []).map((value) => value.trim()).filter(Boolean));
  const right = new Set((rightIds || []).map((value) => value.trim()).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  left.forEach((id) => {
    if (right.has(id)) overlap += 1;
  });
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function isDuplicateProblemTaxonomyGroup(
  candidate: ProblemGroupViewModel,
  existingGroups: ProblemGroupViewModel[],
  parentGroupId: string,
  parentTopic: string,
) {
  if (parentTopic && areProblemTaxonomyTopicsSimilar(candidate.topic, parentTopic)) {
    return true;
  }

  return existingGroups.some((existing) => {
    if (existing.group_id === candidate.group_id) return true;
    if (existing.group_id === parentGroupId) {
      return areProblemTaxonomyTopicsSimilar(candidate.topic, existing.topic);
    }
    if ((existing.parent_group_id || "") !== parentGroupId) return false;
    if (areProblemTaxonomyTopicsSimilar(candidate.topic, existing.topic)) return true;
    return (
      problemTaxonomyEvidenceOverlap(candidate.evidence_utterance_ids, existing.evidence_utterance_ids) >= 0.75 &&
      problemTaxonomyTopicOverlap(candidate.topic, existing.topic) >= 0.5
    );
  });
}

function buildIdeationKeywordBubbles(transcripts: MeetingTranscript[], limit = 18): IdeationKeywordBubble[] {
  const rows = normalizeTranscriptRows(transcripts)
    .filter((row) => (!row.canvas_stage || row.canvas_stage === "ideation") && row.text.trim().length > 0)
    .slice(-180);
  const counts = new Map<string, { text: string; count: number; firstSeen: number }>();
  const cooccurrence = new Map<string, Map<string, number>>();
  let cursor = 0;

  rows.forEach((row) => {
    const rowKeywords = new Set<string>();
    extractIdeationBubbleTerms(row.text).forEach((keyword) => {
      rowKeywords.add(keyword);
      const current = counts.get(keyword);
      if (current) {
        current.count += 1;
      } else {
        counts.set(keyword, { text: keyword, count: 1, firstSeen: cursor });
        cursor += 1;
      }
    });

    const rowKeywordList = [...rowKeywords].slice(0, 12);
    rowKeywordList.forEach((left) => {
      const related = cooccurrence.get(left) || new Map<string, number>();
      rowKeywordList.forEach((right) => {
        if (left === right) return;
        related.set(right, (related.get(right) || 0) + 1);
      });
      cooccurrence.set(left, related);
    });
  });

  const minimumCount = rows.length >= 8 ? 2 : 1;
  let sorted = [...counts.values()]
    .filter((entry) => entry.count >= minimumCount)
    .sort((left, right) => right.count - left.count || left.firstSeen - right.firstSeen)
    .slice(0, limit);
  if (sorted.length === 0 && counts.size > 0) {
    sorted = [...counts.values()]
      .sort((left, right) => right.count - left.count || left.firstSeen - right.firstSeen)
      .slice(0, Math.min(limit, 8));
  }
  const maxCount = Math.max(1, ...sorted.map((entry) => entry.count));

  return sorted.map((entry) => {
    const related = [...(cooccurrence.get(entry.text) || new Map()).entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([keyword]) => keyword);
    return {
      id: `ideation-keyword-${encodeURIComponent(entry.text)}`,
      text: entry.text,
      count: entry.count,
      weight: entry.count / maxCount,
      related,
    };
  });
}

function getIdeationKeywordBubbleSize(bubble: IdeationKeywordBubble, maxCount: number) {
  const countRatio = maxCount <= 1 ? 1 : bubble.count / maxCount;
  return Math.round(74 + countRatio * 88);
}

function getIdeationKeywordBubbleFontSize(text: string, size: number) {
  const weightedLength = Array.from(text).reduce((sum, char) => {
    if (/\s/.test(char)) return sum + 0.32;
    if (/[A-Z]/.test(char)) return sum + 0.72;
    if (/[a-z0-9+#._-]/.test(char)) return sum + 0.6;
    return sum + 1;
  }, 0);
  const availableWidth = Math.max(42, size * 0.82);
  const fittedSize = Math.floor((availableWidth / Math.max(1, weightedLength)) * 0.95);
  return clampNumber(fittedSize, 5, 23);
}

function hashIdeationBubbleSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function ideationBubbleSeedRatio(value: string, salt: number) {
  const hash = hashIdeationBubbleSeed(`${value}:${salt}`);
  return (hash % 10000) / 10000;
}

function ideationBubbleCirclesOverlap(
  left: { x: number; y: number; size: number },
  right: { x: number; y: number; size: number },
  gap: number,
) {
  const leftRadius = left.size / 2;
  const rightRadius = right.size / 2;
  const dx = left.x + leftRadius - (right.x + rightRadius);
  const dy = left.y + leftRadius - (right.y + rightRadius);
  const minDistance = leftRadius + rightRadius + gap;
  return dx * dx + dy * dy < minDistance * minDistance;
}

function buildIdeationKeywordBubbleClusters(bubbles: IdeationKeywordBubble[]) {
  const remaining = new Set(bubbles.map((bubble) => bubble.text));
  const clusters: IdeationKeywordBubble[][] = [];

  bubbles.forEach((seed) => {
    if (!remaining.has(seed.text)) return;

    const cluster = [seed];
    remaining.delete(seed.text);
    while (cluster.length < CANVAS_IDEATION_BUBBLE_CLUSTER_MAX_ITEMS) {
      const next = bubbles.find((candidate) => {
        if (!remaining.has(candidate.text)) return false;
        return cluster.some(
          (item) =>
            item.related.includes(candidate.text) ||
            candidate.related.includes(item.text),
        );
      });
      if (!next) break;
      cluster.push(next);
      remaining.delete(next.text);
    }
    clusters.push(cluster);
  });

  return clusters;
}

function buildIdeationKeywordBubbleClusterBox(
  cluster: IdeationKeywordBubble[],
  maxCount: number,
): IdeationKeywordBubbleClusterBox {
  const sizedItems = cluster
    .map((bubble) => ({
      bubble,
      size: getIdeationKeywordBubbleSize(bubble, maxCount),
    }))
    .sort((left, right) => right.size - left.size || right.bubble.count - left.bubble.count);
  const placements: IdeationKeywordBubbleClusterBox["placements"] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  sizedItems.forEach((item, index) => {
    if (index === 0) {
      placements.push({ bubble: item.bubble, x: 0, y: 0, size: item.size });
      return;
    }

    const seedOffset = ideationBubbleSeedRatio(item.bubble.text, 7) * Math.PI * 2;
    let chosen: IdeationKeywordBubbleClusterBox["placements"][number] | null = null;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const ring = Math.floor(attempt / 10) + 1;
      const angle = seedOffset + (attempt + index * 2) * goldenAngle;
      const radius = 44 + ring * 22 + Math.sqrt(index) * 28;
      const candidate = {
        bubble: item.bubble,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.82,
        size: item.size,
      };
      if (!placements.some((placement) => ideationBubbleCirclesOverlap(candidate, placement, CANVAS_IDEATION_BUBBLE_ORGANIC_GAP))) {
        chosen = candidate;
        break;
      }
    }
    placements.push(chosen || {
      bubble: item.bubble,
      x: index * (item.size + 12),
      y: (index % 2) * 18,
      size: item.size,
    });
  });

  const minX = Math.min(...placements.map((placement) => placement.x));
  const minY = Math.min(...placements.map((placement) => placement.y));
  const maxX = Math.max(...placements.map((placement) => placement.x + placement.size));
  const maxY = Math.max(...placements.map((placement) => placement.y + placement.size));
  return {
    width: maxX - minX,
    height: maxY - minY,
    placements: placements.map((placement) => ({
      ...placement,
      x: placement.x - minX,
      y: placement.y - minY,
    })),
  };
}

function buildIdeationKeywordBubblePlacements(bubbles: IdeationKeywordBubble[]): IdeationKeywordBubblePlacement[] {
  const maxCount = Math.max(1, ...bubbles.map((bubble) => bubble.count));
  const clusterBoxes = buildIdeationKeywordBubbleClusters(bubbles)
    .map((cluster) => buildIdeationKeywordBubbleClusterBox(cluster, maxCount))
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const placedBubbles: IdeationKeywordBubblePlacement[] = [];
  const placedBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  const centerX = CANVAS_IDEATION_BUBBLE_PLANE_WIDTH / 2;
  const centerY = CANVAS_IDEATION_BUBBLE_PLANE_HEIGHT / 2;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  clusterBoxes.forEach((box, index) => {
    let chosen = {
      x: centerX - box.width / 2,
      y: centerY - box.height / 2,
    };

    for (let attempt = 0; attempt < 96; attempt += 1) {
      const radius = index === 0 ? 0 : 72 + Math.sqrt(attempt + index * 5) * 56;
      const angle = attempt * goldenAngle + index * 0.78;
      const candidate = {
        x: centerX + Math.cos(angle) * radius - box.width / 2,
        y: centerY + Math.sin(angle) * radius * 0.72 - box.height / 2,
      };
      const separated = placedBoxes.every((placed) => (
        candidate.x + box.width + CANVAS_IDEATION_BUBBLE_CLUSTER_GAP < placed.x ||
        placed.x + placed.width + CANVAS_IDEATION_BUBBLE_CLUSTER_GAP < candidate.x ||
        candidate.y + box.height + CANVAS_IDEATION_BUBBLE_CLUSTER_GAP < placed.y ||
        placed.y + placed.height + CANVAS_IDEATION_BUBBLE_CLUSTER_GAP < candidate.y
      ));
      if (separated) {
        chosen = candidate;
        break;
      }
    }

    const clampedBox = {
      x: clampNumber(chosen.x, 70, CANVAS_IDEATION_BUBBLE_PLANE_WIDTH - box.width - 70),
      y: clampNumber(chosen.y, 80, CANVAS_IDEATION_BUBBLE_PLANE_HEIGHT - box.height - 70),
      width: box.width,
      height: box.height,
    };
    placedBoxes.push(clampedBox);
    box.placements.forEach((placement) => {
      placedBubbles.push({
        bubble: placement.bubble,
        x: clampedBox.x + placement.x,
        y: clampedBox.y + placement.y,
        size: placement.size,
      });
    });
  });

  return placedBubbles;
}

function makeIdeationKeywordBubbleNodeLabel(bubble: IdeationKeywordBubble, size: number) {
  const fontSize = getIdeationKeywordBubbleFontSize(bubble.text, size);
  const countFontSize = clampNumber(Math.round(fontSize * 0.56), 9, 12);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center rounded-full border border-[#1b59f8]/10 bg-white/90 px-4 text-center font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_18px_44px_rgba(27,89,248,0.14)] backdrop-blur">
      <strong
        className="max-w-full whitespace-nowrap font-semibold text-[#1b59f8]"
        style={{
          fontSize,
          lineHeight: 1.08,
          maxWidth: Math.max(44, Math.round(size * 0.82)),
          wordBreak: "keep-all",
        }}
      >
        {bubble.text}
      </strong>
      <span className="mt-1 font-semibold text-[#4d4d4d]/70" style={{ fontSize: countFontSize }}>
        {bubble.count}회
      </span>
    </div>
  );
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

function estimateProblemTopicNodeHeight(group: ProblemGroupViewModel) {
  const topicLines = Math.min(3, estimateWrappedLines(group.topic || "문제정의", 20));
  const insightLines = group.insight_lens ? Math.min(3, estimateWrappedLines(group.insight_lens, 32)) : 1;
  return Math.max(176, 116 + topicLines * 22 + insightLines * 20);
}

function makeProblemTopicNodeLabel(
  group: ProblemGroupViewModel,
  index: number,
  selected: boolean,
  loading: boolean,
  dropTarget: boolean,
  sourceCount: number,
  opinionCount: number,
  childCount: number,
  childCollapsed: boolean,
  childLoading: boolean,
  criteriaLoading: boolean,
  hasGroupingRationale: boolean,
  onShowGroupingRationale: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onGenerateChildren: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onToggleChildren: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onEdit: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onDelete: (event: React.MouseEvent<HTMLButtonElement>) => void,
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void,
  onDragLeave: () => void,
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void,
) {
  const depth = Math.max(0, group.depth || 0);
  const depthLabel = depth > 0 ? `${depth + 1}차` : `분류 ${index + 1}`;
  const detailText = loading
    ? "인사이트를 정리하는 중입니다."
    : group.insight_lens || (group.conclusion && group.conclusion !== group.topic ? group.conclusion : "");

  return (
    <div
      data-problem-group-drop-id={group.group_id}
      className={`nopan box-border min-w-0 rounded-[12px] border bg-white p-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)] transition ${
        selected ? "border-[#1b59f8] ring-2 ring-[#1b59f8]/10" : "border-black/10 hover:border-[#1b59f8]/30"
      } ${dropTarget ? "ring-2 ring-blue-300 ring-offset-2" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2 rounded-[8px] bg-[#eef4ff] px-2.5 py-1 text-[11px] font-semibold text-[#1b59f8]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1b59f8]" />
          <span className="truncate">{depthLabel}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {childCount > 0 ? (
            <button
              type="button"
              aria-label={childCollapsed ? "하위 분류 펼치기" : "하위 분류 접기"}
              className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-[8px] border border-black/10 bg-[#f9f9f9] text-sm font-semibold text-[#4d4d4d] transition hover:border-[#1b59f8]/20 hover:bg-[#eef4ff] hover:text-[#1b59f8]"
              onClick={onToggleChildren}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {childCollapsed ? "+" : "-"}
            </button>
          ) : null}
          <span className={`rounded-[8px] px-2 py-1 text-[11px] font-semibold ${problemGroupStatusTone(group.status)}`}>
            {problemGroupStatusLabel(group.status)}
          </span>
        </div>
      </div>
      <strong className="mt-3 block line-clamp-2 text-[18px] font-semibold leading-6 text-black">
        {group.topic || "문제정의 토픽"}
      </strong>
      {detailText ? (
        <p className="mt-2 line-clamp-3 text-[13px] leading-5 text-[#4d4d4d]">
          {detailText}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-1.5 text-[11px] font-semibold">
        <span className="rounded-full bg-[#eef4ff] px-2.5 py-1 text-[#1b59f8]">근거 {sourceCount}</span>
        {opinionCount > 0 ? (
          <span className="rounded-full bg-violet-50 px-2.5 py-1 text-violet-700">의견 {opinionCount}</span>
        ) : null}
        {childCount > 0 ? (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">
            하위 {childCount}{childCollapsed ? " 접힘" : ""}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="nodrag nopan rounded-[8px] border border-black/10 bg-[#f9f9f9] px-2.5 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:border-[#1b59f8]/20 hover:bg-[#eef4ff] hover:text-[#1b59f8] disabled:cursor-wait disabled:opacity-60"
          disabled={criteriaLoading}
          onClick={onShowGroupingRationale}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {criteriaLoading ? "확인 중" : hasGroupingRationale ? "기준 보기" : "묶은 기준"}
        </button>
        <button
          type="button"
          className="nodrag nopan rounded-[8px] border border-[#1b59f8]/20 bg-[#eef4ff] px-2.5 py-1.5 text-xs font-semibold text-[#1b59f8] transition hover:bg-[#e1ebff] disabled:cursor-wait disabled:opacity-60"
          disabled={childLoading}
          onClick={onGenerateChildren}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {childLoading ? "생성 중" : "+ 세부"}
        </button>
        <button
          type="button"
          className="nodrag nopan rounded-[8px] border border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8]"
          onClick={onEdit}
          onPointerDown={(event) => event.stopPropagation()}
        >
          수정
        </button>
        <button
          type="button"
          className="nodrag nopan rounded-[8px] border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50"
          onClick={onDelete}
          onPointerDown={(event) => event.stopPropagation()}
        >
          삭제
        </button>
      </div>
      {dropTarget ? (
        <p className="mt-3 rounded-xl border border-[#1b59f8]/20 bg-[#eef4ff] px-3 py-2 text-xs font-semibold leading-5 text-[#1b59f8]">
          개인 메모를 놓으면 이 문제정의 그룹의 의견으로 추가됩니다.
        </p>
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
    parent_group_id: group.parent_group_id || "",
    depth: group.depth || 0,
    topic: group.topic,
    insight_lens: group.insight_lens,
    insight_user_edited: group.insight_user_edited,
    keywords: group.keywords,
    agenda_ids: group.agenda_ids,
    agenda_titles: group.agenda_titles,
    ideas: group.ideas,
    linked_group_ids: group.linked_group_ids || [],
    evidence_utterance_ids: group.evidence_utterance_ids || [],
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
  problem_structure?: unknown;
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
  incomingSharedCanvasSync,
  onSharedCanvasSync,
  incomingCanvasStateRequestId,
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
  const [problemDefinitionMode, setProblemDefinitionMode] = useState<ProblemDefinitionMode>("");
  const [problemDefinitionPhase, setProblemDefinitionPhase] = useState<ProblemDefinitionPhase>("explore");
  const [problemStructureMethod, setProblemStructureMethod] = useState<ProblemStructureMethod>("affinity");
  const [problemStructureDraftMethod, setProblemStructureDraftMethod] = useState<ProblemStructureMethod>("affinity");
  const [problemStructureDraftMode, setProblemStructureDraftMode] = useState<ProblemDefinitionMode>("ai");
  const [problemStructureSetupOpen, setProblemStructureSetupOpen] = useState(false);
  const [problemStructureNodes, setProblemStructureNodes] = useState<ProblemStructureNodeViewModel[]>([]);
  const [problemStructureGroups, setProblemStructureGroups] = useState<ProblemStructureGroupViewModel[]>([]);
  const [problemStructurePending, setProblemStructurePending] = useState(false);
  const [problemStructureDrag, setProblemStructureDrag] = useState<ProblemStructureDragState | null>(null);
  const [solutionTopics, setSolutionTopics] = useState<SolutionTopicViewModel[]>([]);
  const [finalSummaryDocument, setFinalSummaryDocument] = useState<CanvasFinalSolutionSummary>(() =>
    createEmptyFinalSolutionSummary(),
  );
  const [summaryDocumentEditMode, setSummaryDocumentEditMode] = useState(false);
  const [summaryEvidenceOpenGroupIds, setSummaryEvidenceOpenGroupIds] = useState<Set<string>>(() => new Set());
  const [quickAskOpen, setQuickAskOpen] = useState(false);
  const [quickAskDraft, setQuickAskDraft] = useState("");
  const [quickAskMessages, setQuickAskMessages] = useState<CanvasQuickAskMessage[]>([]);
  const [quickAskUnreadCount, setQuickAskUnreadCount] = useState(0);
  const [llmIdeationKeywordBubbles, setLlmIdeationKeywordBubbles] = useState<IdeationKeywordBubble[]>([]);
  const [llmIdeationKeywordSignature, setLlmIdeationKeywordSignature] = useState("");
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
  const [collapsedProblemGroupIds, setCollapsedProblemGroupIds] = useState<Set<string>>(() => new Set());
  const [problemGroupingRationaleById, setProblemGroupingRationaleById] = useState<Record<string, ProblemGroupingRationaleViewModel>>({});
  const [problemGroupingRationalePendingId, setProblemGroupingRationalePendingId] = useState("");
  const [problemGroupingRationaleOpenGroupId, setProblemGroupingRationaleOpenGroupId] = useState("");
  const [pendingProblemGroupLinkId, setPendingProblemGroupLinkId] = useState("");
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
  const [, setConclusionRefreshingGroupId] = useState("");
  const conclusionBatchBusy = false;
  const [problemDefinitionStagePending, setProblemDefinitionStagePending] = useState(false);
  const [problemChildGenerationPendingId, setProblemChildGenerationPendingId] = useState("");
  const [solutionStagePending, setSolutionStagePending] = useState(false);
  const [loadingProblemGroupIds, setLoadingProblemGroupIds] = useState<string[]>([]);
  const [solutionSuggestionBusyTopicId, setSolutionSuggestionBusyTopicId] = useState("");
  const [liveFlowHint, setLiveFlowHint] = useState("");
  const [ideaAssimilationStatus, setIdeaAssimilationStatus] = useState("");
  const [problemDiscussionStatus, setProblemDiscussionStatus] = useState("");
  const [, setIdeaCreateStack] = useState(0);
  const [rightDrawerCollapsed, setRightDrawerCollapsed] = useState(true);
  const [rightDrawerContentVisible, setRightDrawerContentVisible] = useState(false);
  const [rightDrawerDetailCollapsed, setRightDrawerDetailCollapsed] = useState(false);
  const [rightDrawerNotesCollapsed, setRightDrawerNotesCollapsed] = useState(false);
  const [sharedSyncEnabled, setSharedSyncEnabled] = useState(true);
  const [importOverrideActive, setImportOverrideActive] = useState(false);
  const [nodePositions, setNodePositions] = useState<CanvasNodePositionsByStage>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [, setEdges] = useState<Edge[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [agendaDragPreview, setAgendaDragPreview] = useState<AgendaDragPreviewState | null>(null);
  const [ideationDropPreview, setIdeationDropPreview] = useState<IdeationDropPreviewState | null>(null);
  const [, setIdeationNodeDragActive] = useState(false);
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
  const quickAskOpenRef = useRef(quickAskOpen);
  const quickAskScrollRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    quickAskOpenRef.current = quickAskOpen;
    if (quickAskOpen) {
      setQuickAskUnreadCount(0);
    }
  }, [quickAskOpen]);

  useEffect(() => {
    if (!quickAskOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (quickAskScrollRef.current) {
        quickAskScrollRef.current.scrollTop = quickAskScrollRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [quickAskMessages.length, quickAskOpen]);
  const agendaDragPreviewRef = useRef<AgendaDragPreviewState | null>(null);
  const ideationDropPreviewRef = useRef<IdeationDropPreviewState | null>(null);
  const stableIdeationDragRef = useRef<StableIdeationDragState | null>(null);
  const problemIdeaDragRef = useRef<ProblemIdeaDragState | null>(null);
  const problemIdeaPointerDragRef = useRef<ProblemIdeaPointerDragState | null>(null);
  const analysisSignatureAtImportRef = useRef("");
  const placementFeedbackTimerRef = useRef<number | null>(null);
  const initialLayoutLogDoneRef = useRef(false);
  const processedProblemUtteranceIdsRef = useRef<Set<string>>(new Set());
  const failedProblemDiscussionRef = useRef<{ signature: string; failedAt: number; detail: string } | null>(null);
  const problemDiscussionFlushTimerRef = useRef<number | null>(null);
  const problemDiscussionInFlightRef = useRef(false);
  const problemStructureRequestSeqRef = useRef(0);
  const ideationKeywordRequestSeqRef = useRef(0);
  const latestSharedWorkspaceRef = useRef<{
    meetingGoal: string;
    meetingGoalContext: string;
    stage: CanvasStage;
    agendaOverrides: Record<string, AgendaOverride>;
    canvasItems: CanvasItemViewModel[];
    customGroups: CustomGroupViewModel[];
    problemGroups: ProblemGroupViewModel[];
    problemStructure: CanvasProblemStructureState;
    solutionTopics: SolutionTopicViewModel[];
    finalSolutionSummary: CanvasFinalSolutionSummary;
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
    problemStructure: createDefaultProblemStructureState(),
    solutionTopics: [],
    finalSolutionSummary: createEmptyFinalSolutionSummary(),
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
  const activeMeetingGoal = meetingGoalDraft.trim();
  const meetingTopicForAi = activeMeetingGoal || meetingTitle.trim() || (effectiveState?.meeting_goal || "").trim() || "회의 주제";
  const ideationKeywordUtterances = useMemo(() => buildIdeationKeywordUtterances(transcripts), [transcripts]);
  const localIdeationKeywordBubbles = useMemo(() => buildIdeationKeywordBubbles(transcripts), [transcripts]);
  const ideationKeywordSourceSignature = useMemo(
    () =>
      makeStableSignature({
        version: 1,
        utterances: ideationKeywordUtterances.map((row) => ({
          id: row.id,
          text: row.text,
        })),
      }),
    [ideationKeywordUtterances],
  );
  const activeIdeationKeywordBubbles = useMemo(() => {
    if (
      llmIdeationKeywordSignature === ideationKeywordSourceSignature &&
      llmIdeationKeywordBubbles.length > 0
    ) {
      return llmIdeationKeywordBubbles;
    }
    return localIdeationKeywordBubbles;
  }, [
    ideationKeywordSourceSignature,
    llmIdeationKeywordBubbles,
    llmIdeationKeywordSignature,
    localIdeationKeywordBubbles,
  ]);
  const problemStructureStatePayload = useMemo(
    () =>
      buildProblemStructureStatePayload({
        phase: problemDefinitionPhase,
        method: problemStructureMethod,
        mode: problemDefinitionMode,
        nodes: problemStructureNodes,
        groups: problemStructureGroups,
      }),
    [
      problemDefinitionMode,
      problemDefinitionPhase,
      problemStructureGroups,
      problemStructureMethod,
      problemStructureNodes,
    ],
  );
  const quickAskPendingCount = useMemo(
    () => quickAskMessages.filter((message) => message.status === "pending").length,
    [quickAskMessages],
  );
  const buildQuickAskContext = useCallback((): Record<string, unknown> => {
    const sourceTranscriptRows = normalizeTranscriptRows(
      (effectiveState?.transcript?.length ? effectiveState.transcript : transcripts) || [],
    );
    const problemStructureNodeById = new Map(problemStructureNodes.map((node) => [node.id, node]));
    const selectedCanvasNode = nodes.find((node) => node.id === selectedNodeId);

    return {
      current_stage: stageLabel(stage),
      meeting_topic: meetingTopicForAi,
      meeting_goal: clipClientText(activeMeetingGoal || meetingGoalDraft || effectiveState?.meeting_goal || "", 600),
      meeting_goal_context: clipClientText(meetingGoalContextDraft || effectiveState?.initial_context || "", 900),
      selected_node_id: selectedNodeId,
      selected_node_label:
        selectedCanvasNode && typeof selectedCanvasNode.data === "object"
          ? clipClientText((selectedCanvasNode.data as { label?: unknown; contentSignature?: unknown }).label || selectedCanvasNode.id, 160)
          : selectedNodeId,
      recent_utterances: sourceTranscriptRows.slice(-32).map((row) => ({
        id: row.id,
        speaker: row.speaker || "참가자",
        text: clipClientText(stripLeadingTimestamp(row.text), 420),
        timestamp: row.timestamp || "",
        canvas_stage: row.canvas_stage || "ideation",
      })),
      canvas_items: canvasItems.slice(0, 30).map((item) => ({
        id: item.id,
        kind: item.kind,
        title: clipClientText(item.title, 120),
        body: clipClientText(item.body, 360),
        status: item.status,
        parent_id: item.parent_topic_id || "",
      })),
      problem_groups: problemGroups.slice(0, 24).map((group) => ({
        id: group.group_id,
        parent_id: group.parent_group_id || "",
        depth: group.depth || 0,
        topic: clipClientText(group.topic, 140),
        conclusion: clipClientText(group.conclusion, 420),
        status: group.status,
        source_summary_items: (group.source_summary_items || []).slice(0, 4).map((item) => clipClientText(item, 180)),
      })),
      problem_structure: {
        phase: problemDefinitionPhase,
        method: problemStructureMethod,
        mode: problemDefinitionMode || "unset",
        groups: problemStructureGroups.slice(0, 20).map((group) => ({
          id: group.id,
          title: clipClientText(group.title, 140),
          status: group.status,
          rationale: clipClientText(group.rationale, 360),
          node_titles: group.nodeIds
            .map((nodeId) => problemStructureNodeById.get(nodeId)?.title || "")
            .filter(Boolean)
            .slice(0, 10),
        })),
      },
      solution_topics: solutionTopics.slice(0, 18).map((topic) => ({
        id: topic.group_id,
        topic: clipClientText(topic.topic, 140),
        conclusion: clipClientText(topic.conclusion, 420),
        status: topic.status,
      })),
      summary_markdown: clipClientText(finalSummaryDocument.markdown, 5000),
    };
  }, [
    activeMeetingGoal,
    canvasItems,
    effectiveState,
    finalSummaryDocument.markdown,
    meetingGoalContextDraft,
    meetingGoalDraft,
    meetingTopicForAi,
    nodes,
    problemDefinitionMode,
    problemDefinitionPhase,
    problemGroups,
    problemStructureGroups,
    problemStructureMethod,
    problemStructureNodes,
    selectedNodeId,
    solutionTopics,
    stage,
    transcripts,
  ]);
  const handleToggleQuickAsk = useCallback(() => {
    setQuickAskOpen((prev) => {
      const next = !prev;
      if (next) {
        setQuickAskUnreadCount(0);
      }
      return next;
    });
  }, []);
  const handleSubmitQuickAsk = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const question = quickAskDraft.trim();
      if (!question || !meetingId) return;

      const now = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const userMessageId = `quick-user-${requestId}`;
      const assistantMessageId = `quick-assistant-${requestId}`;
      setQuickAskMessages((prev) => [
        ...prev,
        {
          id: userMessageId,
          role: "user",
          text: question,
          createdAt: now,
          status: "done",
        },
        {
          id: assistantMessageId,
          role: "assistant",
          text: "응답 생성 중...",
          createdAt: now,
          status: "pending",
        },
      ]);
      setQuickAskDraft("");

      void askCanvasQuickQuestion({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        stage,
        question,
        context: buildQuickAskContext(),
      })
        .then((result) => {
          setQuickAskMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    text: result.answer || "응답이 비어 있습니다.",
                    status: "done",
                    warning: result.warning || "",
                  }
                : message,
            ),
          );
          if (!quickAskOpenRef.current) {
            setQuickAskUnreadCount((prev) => prev + 1);
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setQuickAskMessages((prev) =>
            prev.map((item) =>
              item.id === assistantMessageId
                ? {
                    ...item,
                    text: `응답을 가져오지 못했습니다. ${message}`,
                    status: "error",
                  }
                : item,
            ),
          );
          if (!quickAskOpenRef.current) {
            setQuickAskUnreadCount((prev) => prev + 1);
          }
        });
    },
    [buildQuickAskContext, meetingId, meetingTopicForAi, quickAskDraft, stage],
  );
  useEffect(() => {
    if (stage !== "ideation") return;
    if (!meetingId || ideationKeywordUtterances.length === 0) {
      setLlmIdeationKeywordBubbles([]);
      setLlmIdeationKeywordSignature("");
      return;
    }
    if (llmIdeationKeywordSignature === ideationKeywordSourceSignature) return;

    const requestSeq = ideationKeywordRequestSeqRef.current + 1;
    ideationKeywordRequestSeqRef.current = requestSeq;
    const timer = window.setTimeout(() => {
      void extractCanvasIdeationKeywords({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        utterances: ideationKeywordUtterances,
        max_keywords: 18,
      })
        .then((result) => {
          if (ideationKeywordRequestSeqRef.current !== requestSeq) return;
          const nextBubbles = normalizeIdeationKeywordBubblesFromResponse(result.keywords || []);
          setLlmIdeationKeywordBubbles(nextBubbles);
          setLlmIdeationKeywordSignature(ideationKeywordSourceSignature);
        })
        .catch((error) => {
          if (ideationKeywordRequestSeqRef.current !== requestSeq) return;
          console.error("Failed to extract ideation keyword bubbles:", error);
        });
    }, 6500);

    return () => window.clearTimeout(timer);
  }, [
    ideationKeywordSourceSignature,
    ideationKeywordUtterances,
    llmIdeationKeywordSignature,
    meetingId,
    meetingTopicForAi,
    stage,
  ]);
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
    processedProblemUtteranceIdsRef.current = new Set();
    failedProblemDiscussionRef.current = null;
    problemDiscussionInFlightRef.current = false;
    latestSharedWorkspaceRef.current = {
      meetingGoal: "",
      meetingGoalContext: "",
      stage: "ideation",
      agendaOverrides: {},
      canvasItems: [],
      customGroups: [],
      problemGroups: [],
      problemStructure: createDefaultProblemStructureState(),
      solutionTopics: [],
      finalSolutionSummary: createEmptyFinalSolutionSummary(),
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
    setFinalSummaryDocument(createEmptyFinalSolutionSummary());
    setSummaryDocumentEditMode(false);
    setSummaryEvidenceOpenGroupIds(new Set());
    setSelectedProblemSourceNodeId("");
    setArmedCanvasTool(null);
    setLiveFlowHint("");
    setIdeaAssimilationStatus("");
    setProblemDiscussionStatus("");
    setSolutionSuggestionBusyTopicId("");
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
      problemStructure: problemStructureStatePayload,
      solutionTopics,
      finalSolutionSummary: finalSummaryDocument,
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
    problemStructureStatePayload,
    finalSummaryDocument,
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
    setProblemDefinitionMode("");
    setProblemDefinitionPhase("explore");
    setProblemStructureMethod("affinity");
    setProblemStructureDraftMethod("affinity");
    setProblemStructureDraftMode("ai");
    setProblemStructureSetupOpen(false);
    setProblemStructureNodes([]);
    setProblemStructureGroups([]);
    setProblemStructurePending(false);
    setProblemStructureDrag(null);
    setSolutionTopics([]);
    setFinalSummaryDocument(createEmptyFinalSolutionSummary());
    setSummaryDocumentEditMode(false);
    setSummaryEvidenceOpenGroupIds(new Set());
    setPersonalNotes([]);
    setAgendaOverrides({});
    setCanvasItems([]);
    setCustomGroups([]);
    setCustomGroupDraftTitle("");
    setIdeaCreateStack(0);
    setNodePositions({});
    setImportedState(null);
    setStage("ideation");
    setProblemDefinitionMode("");
    setProblemDefinitionPhase("explore");
    setProblemStructureMethod("affinity");
    setProblemStructureDraftMethod("affinity");
    setProblemStructureDraftMode("ai");
    setProblemStructureSetupOpen(false);
    setProblemStructureNodes([]);
    setProblemStructureGroups([]);
    setProblemStructurePending(false);
    setProblemStructureDrag(null);
    setProblemDefinitionStagePending(false);
    setSolutionStagePending(false);
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
    setSelectedNodeId("");
    setEditingProblemGroupId("");
    setEditingSolutionTopicId("");
    setLoadingProblemGroupIds([]);
    setCollapsedProblemGroupIds(new Set());
    setProblemGroupingRationaleById({});
    setProblemGroupingRationalePendingId("");
    setProblemGroupingRationaleOpenGroupId("");

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
        const nextProblemStructure = hydrateProblemStructureState(
          shouldUseLocalCanvas ? savedLocalCanvasState?.problem_structure : saved.problem_structure,
          nextGroups,
        );
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
        const nextFinalSummary = normalizeFinalSolutionSummaryPayload(
          shouldUseLocalCanvas
            ? savedLocalCanvasState?.final_solution_summary || saved.final_solution_summary || null
            : saved.final_solution_summary || null,
        );
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
        setFinalSummaryDocument(nextFinalSummary);
        setSummaryDocumentEditMode(false);
        setSummaryEvidenceOpenGroupIds(new Set());
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
        setProblemDefinitionMode(nextProblemStructure.mode);
        setProblemDefinitionPhase(nextProblemStructure.phase);
        setProblemStructureMethod(nextProblemStructure.method);
        setProblemStructureDraftMethod(nextProblemStructure.method);
        setProblemStructureDraftMode(nextProblemStructure.mode || "ai");
        setProblemStructureSetupOpen(false);
        setProblemStructureNodes(nextProblemStructure.nodes);
        setProblemStructureGroups(nextProblemStructure.groups);
        setProblemStructurePending(false);
        analysisSignatureAtImportRef.current = nextImportedState
          ? buildMeetingStateSignature(nextImportedState)
          : "";
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
          problem_structure: buildProblemStructureStatePayload(nextProblemStructure),
          solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
          final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics, nextFinalSummary),
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
          problemStructure: buildProblemStructureStatePayload(nextProblemStructure),
          solutionTopics: nextSolutionTopics,
          finalSolutionSummary: nextFinalSummary,
          nodePositions: nextNodePositions,
          importedState: nextImportedState,
        });
        setSelectedProblemGroupId(nextProblemStructure.phase === "structure" ? "" : nextGroups[0]?.group_id || "");
        setSelectedSolutionTopicId(nextSolutionTopics[0]?.group_id || "");
        setSelectedCanvasItemId("");
        setSelectedNodeId(
          nextStage === "problem-definition"
            ? (nextProblemStructure.phase === "structure" ? "" : nextGroups[0] ? `problem-${nextGroups[0].group_id}` : "")
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
        });
      })
      .catch(() => {
        if (cancelled) return;
        setProblemGroups([]);
        setSolutionTopics([]);
        setFinalSummaryDocument(createEmptyFinalSolutionSummary());
        setSummaryDocumentEditMode(false);
        setSummaryEvidenceOpenGroupIds(new Set());
        setPersonalNotes([]);
        setAgendaOverrides({});
        setCanvasItems([]);
        setCustomGroups([]);
        setIdeaCreateStack(0);
        setSharedSyncEnabled(true);
        setNodePositions({});
        setImportedState(null);
        setStage("ideation");
        setProblemDefinitionMode("");
        setProblemDefinitionPhase("explore");
        setProblemStructureMethod("affinity");
        setProblemStructureDraftMethod("affinity");
        setProblemStructureDraftMode("ai");
        setProblemStructureSetupOpen(false);
        setProblemStructureNodes([]);
        setProblemStructureGroups([]);
        setProblemStructurePending(false);
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          meeting_goal: "",
          meeting_goal_context: "",
          stage: "ideation",
          agenda_overrides: {},
          canvas_items: [],
          custom_groups: [],
          problem_groups: [],
          problem_structure: createDefaultProblemStructureState(),
          solution_topics: [],
          final_solution_summary: buildFinalSolutionSummaryPayload([], createEmptyFinalSolutionSummary()),
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
          problemStructure: createDefaultProblemStructureState(),
          solutionTopics: [],
          finalSolutionSummary: createEmptyFinalSolutionSummary(),
          nodePositions: {},
          importedState: null,
        });
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId("");
        setSelectedCanvasItemId("");
        setSelectedNodeId("");
        setEditingProblemGroupId("");
        setEditingSolutionTopicId("");
        setCollapsedProblemGroupIds(new Set());
        setProblemGroupingRationaleById({});
        setProblemGroupingRationalePendingId("");
        setProblemGroupingRationaleOpenGroupId("");
      })
      .finally(() => {
        if (cancelled) return;
        workspaceHydratingRef.current = false;
        workspaceLoadedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, [meetingId, onMeetingGoalChange, onMeetingGoalContextChange, userId]);

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
    setCollapsedProblemGroupIds(new Set());
    setProblemGroupingRationaleById({});
    setProblemGroupingRationalePendingId("");
    setProblemGroupingRationaleOpenGroupId("");
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

    if (problemDefinitionPhase === "structure") {
      return;
    }

    if (!selectedProblemGroupId || !problemGroups.some((group) => group.group_id === selectedProblemGroupId)) {
      setSelectedProblemGroupId(problemGroups[0].group_id);
    }
  }, [problemDefinitionPhase, problemGroups, selectedProblemGroupId]);

  useEffect(() => {
    const validGroupIds = new Set(problemGroups.map((group) => group.group_id));
    setCollapsedProblemGroupIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((groupId) => {
        if (validGroupIds.has(groupId)) {
          next.add(groupId);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    setProblemGroupingRationaleById((prev) => {
      const nextEntries = Object.entries(prev).filter(([groupId]) => validGroupIds.has(groupId));
      if (nextEntries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(nextEntries);
    });
    setProblemGroupingRationaleOpenGroupId((prev) => (prev && !validGroupIds.has(prev) ? "" : prev));
    setProblemGroupingRationalePendingId((prev) => (prev && !validGroupIds.has(prev) ? "" : prev));
  }, [problemGroups]);

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

  const buildProblemGroupingRationalePayload = useCallback(
    (group: ProblemGroupViewModel) => ({
      meeting_id: meetingId,
      meeting_topic: meetingTopicForAi,
      group: {
        group_id: group.group_id,
        topic: group.topic,
        insight_lens: group.insight_lens || "",
        conclusion: group.conclusion || "",
        agenda_titles: group.agenda_titles || [],
        source_summary_items: group.source_summary_items || [],
        evidence_utterance_ids: group.evidence_utterance_ids || [],
        ideas: (group.ideas || []).map((idea) => ({
          id: idea.id,
          kind: idea.kind,
          title: idea.title,
          body: idea.body,
        })),
      },
      child_groups: problemGroups
        .filter((item) => item.parent_group_id === group.group_id)
        .map((item) => ({
          group_id: item.group_id,
          topic: item.topic,
          insight_lens: item.insight_lens || "",
          conclusion: item.conclusion || "",
        })),
    }),
    [meetingId, meetingTopicForAi, problemGroups],
  );

  const forceBroadcastSharedCanvas = useCallback(
    (overrides?: {
      stage?: CanvasStage;
      agendaOverrides?: Record<string, AgendaOverride>;
      canvasItems?: CanvasItemViewModel[];
      customGroups?: CustomGroupViewModel[];
      problemGroups?: ProblemGroupViewModel[];
      problemStructure?: CanvasProblemStructureState;
      solutionTopics?: SolutionTopicViewModel[];
      finalSolutionSummary?: CanvasFinalSolutionSummary;
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
        problem_structure: overrides?.problemStructure ?? problemStructureStatePayload,
        solution_topics: serializeSharedSolutionTopics(overrides?.solutionTopics ?? solutionTopics),
        final_solution_summary: buildFinalSolutionSummaryPayload(
          overrides?.solutionTopics ?? solutionTopics,
          overrides?.finalSolutionSummary ?? finalSummaryDocument,
        ),
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
        problem_structure: snapshot.problem_structure,
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
      finalSummaryDocument,
      meetingGoalContextDraft,
      meetingGoalDraft,
      meetingId,
      nodePositions,
      onSharedCanvasSync,
      persistedSharedImportedState,
      problemGroups,
      problemStructureStatePayload,
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
            problemStructure: problemStructureStatePayload,
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
      problemStructureStatePayload,
      sharedSyncEnabled,
      solutionTopics,
      stage,
    ],
  );

  const applyServerProblemWorkspace = useCallback(
    (workspace: CanvasWorkspaceStateResponse | undefined | null) => {
      if (!workspace || workspace.meeting_id !== meetingId) return;

      const nextProblemGroups = hydrateProblemGroups(workspace.problem_groups || [], problemGroups);
      const nextProblemStructure = hydrateProblemStructureState(
        workspace.problem_structure || problemStructureStatePayload,
        nextProblemGroups,
      );
      const nextProblemStructurePayload = buildProblemStructureStatePayload(nextProblemStructure);
      const nextNodePositions = normalizeCanvasNodePositionsForComputedIdeation(workspace.node_positions || nodePositions);
      (workspace.problem_processed_utterance_ids || []).forEach((id) => {
        if (id) processedProblemUtteranceIdsRef.current.add(id);
      });

      setProblemGroups(nextProblemGroups);
      setProblemDefinitionMode(nextProblemStructure.mode);
      setProblemDefinitionPhase(nextProblemStructure.phase);
      setProblemStructureMethod(nextProblemStructure.method);
      setProblemStructureDraftMethod(nextProblemStructure.method);
      setProblemStructureDraftMode(nextProblemStructure.mode || "ai");
      setProblemStructureNodes(nextProblemStructure.nodes);
      setProblemStructureGroups(nextProblemStructure.groups);
      setProblemStructurePending(false);
      setNodePositions(nextNodePositions);
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        problemGroups: nextProblemGroups,
        problemStructure: nextProblemStructurePayload,
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
            problemStructure: nextProblemStructurePayload,
            solutionTopics,
            nodePositions: nextNodePositions,
            importedState: persistedSharedImportedState,
          }),
        );
        forceBroadcastSharedCanvas({
          problemGroups: nextProblemGroups,
          problemStructure: nextProblemStructurePayload,
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
      problemStructureStatePayload,
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
  }, [transcripts]);

  useEffect(() => {
    return () => {
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

  const handleShowProblemGroupingRationale = useCallback(
    async (group: ProblemGroupViewModel) => {
      if (!meetingId) return;
      const cached = problemGroupingRationaleById[group.group_id];
      if (cached) {
        setProblemGroupingRationaleOpenGroupId(group.group_id);
        return;
      }

      setProblemGroupingRationalePendingId(group.group_id);
      try {
        const result = await generateProblemGroupingRationale(buildProblemGroupingRationalePayload(group));
        const nextRationale: ProblemGroupingRationaleViewModel = {
          groupId: result.group_id || group.group_id,
          rationale: result.rationale || "이 분류를 묶은 기준을 찾지 못했습니다.",
          basisItems: result.basis_items || [],
          usedLlm: result.used_llm,
          warning: result.warning || "",
          generatedAt: result.generated_at,
        };
        setProblemGroupingRationaleById((prev) => ({
          ...prev,
          [group.group_id]: nextRationale,
        }));
        setProblemGroupingRationaleOpenGroupId(group.group_id);
        setActivityMessage(result.warning || "문제정의 그룹의 묶은 기준을 확인했습니다.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActivityMessage(`묶은 기준 생성 실패: ${message}`);
      } finally {
        setProblemGroupingRationalePendingId("");
      }
    },
    [buildProblemGroupingRationalePayload, meetingId, problemGroupingRationaleById],
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
              problemStructure: problemStructureStatePayload,
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
      problemStructureStatePayload,
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
      problemStructure: problemStructureStatePayload,
      solutionTopics,
      finalSolutionSummary: finalSummaryDocument,
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
      problem_structure?: CanvasProblemStructureState;
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
    if (sharedSyncEnabled && nextSignatures.problem_structure !== previousSignatures.problem_structure) {
      patch.problem_structure = problemStructureStatePayload;
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.solution_topics !== previousSignatures.solution_topics) {
      patch.solution_topics = nextSolutionTopicsPayload;
      patch.final_solution_summary = buildFinalSolutionSummaryPayload(solutionTopics, finalSummaryDocument);
      hasChanges = true;
    }
    if (sharedSyncEnabled && nextSignatures.final_solution_summary !== previousSignatures.final_solution_summary) {
      patch.final_solution_summary = buildFinalSolutionSummaryPayload(solutionTopics, finalSummaryDocument);
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
    finalSummaryDocument,
    meetingGoalContextDraft,
    meetingGoalDraft,
    meetingId,
    nodePositions,
    onMeetingGoalSync,
    persistedSharedImportedState,
    problemDefinitionStagePending,
    problemGroups,
    problemStructureStatePayload,
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
            problem_structure: problemStructureStatePayload,
            solution_topics: serializeSharedSolutionTopics(solutionTopics),
            final_solution_summary: buildFinalSolutionSummaryPayload(solutionTopics, finalSummaryDocument),
            node_positions: normalizeCanvasNodePositionsForComputedIdeation(nodePositions),
            imported_state: persistedSharedImportedState,
            import_override_active: importOverrideActive,
          },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      finalSummaryDocument,
      importOverrideActive,
      meetingGoalContextDraft,
      meetingGoalDraft,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      problemStructureStatePayload,
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
      problem_structure: problemStructureStatePayload,
      solution_topics: serializeSharedSolutionTopics(solutionTopics),
      final_solution_summary: buildFinalSolutionSummaryPayload(solutionTopics, finalSummaryDocument),
      node_positions: normalizeCanvasNodePositionsForComputedIdeation(nodePositions),
      imported_state: persistedSharedImportedState,
    }),
    [agendaOverrides, canvasItems, customGroups, finalSummaryDocument, meetingGoalContextDraft, meetingGoalDraft, nodePositions, persistedSharedImportedState, problemGroups, problemStructureStatePayload, solutionTopics, stage],
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
        const retryAfter = CANVAS_LLM_FAILURE_RETRY_DELAY_MS - (Date.now() - previousFailure.failedAt);
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
    }, CANVAS_LLM_SILENCE_FLUSH_MS);

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
        problemStructure: problemStructureStatePayload,
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
    problemStructureStatePayload,
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
    const nextProblemStructure = hydrateProblemStructureState(
      incomingSharedCanvasSync.problem_structure || createDefaultProblemStructureState(),
      nextProblemGroups,
    );
    const nextProblemStructurePayload = buildProblemStructureStatePayload(nextProblemStructure);
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
    const nextFinalSummary = normalizeFinalSolutionSummaryPayload(incomingSharedCanvasSync.final_solution_summary || null);

    lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
      meeting_goal: incomingMeetingGoal,
      meeting_goal_context: incomingMeetingGoalContext,
      stage: incomingStage,
      agenda_overrides: incomingSharedCanvasSync.agenda_overrides || {},
      canvas_items: nextIncomingCanvasItems,
      custom_groups: serializeCustomGroups(incomingCustomGroups),
      problem_groups: incomingSharedCanvasSync.problem_groups || [],
      problem_structure: nextProblemStructurePayload,
      solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
      final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics, nextFinalSummary),
      node_positions: nextIncomingNodePositions,
      imported_state: incomingSharedCanvasSync.imported_state || null,
    });
    applyingRemoteSharedSyncRef.current = true;

    setProblemGroups(nextProblemGroups);
    setProblemDefinitionMode(nextProblemStructure.mode);
    setProblemDefinitionPhase(nextProblemStructure.phase);
    setProblemStructureMethod(nextProblemStructure.method);
    setProblemStructureDraftMethod(nextProblemStructure.method);
    setProblemStructureDraftMode(nextProblemStructure.mode || "ai");
    setProblemStructureNodes(nextProblemStructure.nodes);
    setProblemStructureGroups(nextProblemStructure.groups);
    setProblemStructurePending(false);
    setSolutionTopics(nextSolutionTopics);
    setFinalSummaryDocument(nextFinalSummary);
    setSummaryDocumentEditMode(false);
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
      problemStructure: nextProblemStructurePayload,
      solutionTopics: nextSolutionTopics,
      finalSolutionSummary: nextFinalSummary,
      nodePositions: nextIncomingNodePositions,
      importedState: incomingSharedCanvasSync.imported_state || null,
    });
    setLeftPanelTab("detail");
    if (incomingStage === "problem-definition") {
      const nextGroupId = nextProblemStructure.phase === "structure" ? "" : nextProblemGroups[0]?.group_id || "";
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
        problem_structure: sharedCanvasSnapshot.problem_structure,
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
            final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics, finalSummaryDocument),
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
      finalSummaryDocument,
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
          final_solution_summary: buildFinalSolutionSummaryPayload(nextSolutionTopics, finalSummaryDocument),
          imported_state: persistedSharedImportedState,
        }).catch((error) => {
          console.error("Failed to save solution note edit:", error);
        });
      }
    }

    setActivityMessage("해결책 카드를 저장했습니다.");
  }, [
    editingSolutionNoteKey,
    finalSummaryDocument,
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
    const markdown = finalSummaryDocument.markdown.trim();
    if (!markdown) {
      setActivityMessage("복사할 요약 문서가 없습니다.");
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      setActivityMessage("요약 문서를 마크다운으로 복사했습니다.");
    } catch (error) {
      console.error("Failed to copy final solution markdown:", error);
      setActivityMessage("브라우저 권한 문제로 마크다운 복사에 실패했습니다.");
    }
  }, [finalSummaryDocument.markdown]);

  const handleSummaryDocumentMarkdownChange = useCallback((value: string) => {
    setFinalSummaryDocument((current) =>
      normalizeFinalSolutionSummaryPayload({
        ...current,
        markdown: value,
        document_status: value.trim() ? "edited" : "empty",
      }),
    );
  }, []);

  const handleToggleSummaryEvidence = useCallback((groupId: string) => {
    setSummaryEvidenceOpenGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const commitProblemGroupsSnapshot = useCallback(
    (nextGroups: ProblemGroupViewModel[], message: string, selectedGroupId?: string) => {
      const resolvedSelectedGroupId = selectedGroupId || selectedProblemGroupId || nextGroups[0]?.group_id || "";
      setProblemGroups(nextGroups);
      setSelectedProblemGroupId(resolvedSelectedGroupId);
      setSelectedNodeId(resolvedSelectedGroupId ? `problem-${resolvedSelectedGroupId}` : "");
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage,
        problemGroups: nextGroups,
        importedState: persistedSharedImportedState,
      };

      if (sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          problemGroups: nextGroups,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            problem_groups: serializeSharedProblemGroups(nextGroups),
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save problem groups:", error);
          });
        }
      }

      setActivityMessage(message);
    },
    [
      forceBroadcastSharedCanvas,
      meetingId,
      persistedSharedImportedState,
      selectedProblemGroupId,
      sharedSyncEnabled,
      stage,
    ],
  );

  const handleGenerateProblemChildren = useCallback(
    async (group: ProblemGroupViewModel) => {
      if (!meetingId || problemChildGenerationPendingId) return;

      setProblemChildGenerationPendingId(group.group_id);
      try {
        const result = await generateCanvasProblemTaxonomy({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          parent_group_id: group.group_id,
          parent_topic: group.topic,
          parent_depth: group.depth || 0,
          parent_evidence_utterance_ids: group.evidence_utterance_ids || [],
          existing_group_ids: problemGroups.map((item) => item.group_id),
          existing_groups: buildProblemTaxonomyExistingGroupsPayload(problemGroups),
          max_groups: 5,
        });
        const existingIds = new Set(problemGroups.map((item) => item.group_id));
        const generatedGroups = hydrateProblemGroups(result.groups || [], problemGroups);
        const childGroups = generatedGroups
          .filter((item) => !existingIds.has(item.group_id))
          .filter((item) => !isDuplicateProblemTaxonomyGroup(item, problemGroups, group.group_id, group.topic))
          .map((item) => ({
            ...item,
            parent_group_id: item.parent_group_id || group.group_id,
            depth: Math.max(0, item.depth ?? (group.depth || 0) + 1),
            status: "draft" as ProblemGroupStatus,
          }));

        if (childGroups.length === 0) {
          setActivityMessage(
            result.warning ||
              (generatedGroups.length > 0
                ? "이미 생성된 세부 분류와 겹쳐 새로 추가할 노드가 없습니다."
                : "실제 발화 안에서 추가 세부 분류를 찾지 못했습니다."),
          );
          return;
        }

        setCollapsedProblemGroupIds((prev) => {
          if (!prev.has(group.group_id)) return prev;
          const next = new Set(prev);
          next.delete(group.group_id);
          return next;
        });
        commitProblemGroupsSnapshot(
          [...problemGroups, ...childGroups],
          result.warning || `"${group.topic}" 아래에 세부 분류 ${childGroups.length}개를 추가했습니다.`,
          childGroups[0].group_id,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActivityMessage(`세부 분류 생성 실패: ${message}`);
      } finally {
        setProblemChildGenerationPendingId("");
      }
    },
    [
      commitProblemGroupsSnapshot,
      meetingId,
      meetingTopicForAi,
      problemChildGenerationPendingId,
      problemGroups,
    ],
  );

  const handleQuickEditProblemGroup = useCallback(
    (group: ProblemGroupViewModel) => {
      const nextTopic = window.prompt("문제정의 노드 제목", group.topic);
      if (nextTopic === null) return;
      const trimmedTopic = nextTopic.trim();
      if (!trimmedTopic) return;
      const nextSummary = window.prompt("문제정의 노드 요약", group.conclusion || group.insight_lens || "");
      if (nextSummary === null) return;

      const nextGroups = problemGroups.map((item) =>
        item.group_id === group.group_id
          ? {
              ...item,
              topic: trimmedTopic,
              conclusion: nextSummary.trim() || item.conclusion,
              conclusion_user_edited: true,
              insight_user_edited: item.insight_user_edited || trimmedTopic !== item.topic,
            }
          : item,
      );
      commitProblemGroupsSnapshot(nextGroups, "문제정의 노드를 수정했습니다.", group.group_id);
    },
    [commitProblemGroupsSnapshot, problemGroups],
  );

  const handleDeleteProblemGroup = useCallback(
    (group: ProblemGroupViewModel) => {
      const childIdsByParent = new Map<string, string[]>();
      problemGroups.forEach((item) => {
        if (!item.parent_group_id) return;
        const ids = childIdsByParent.get(item.parent_group_id) || [];
        ids.push(item.group_id);
        childIdsByParent.set(item.parent_group_id, ids);
      });
      const removedIds = new Set<string>([group.group_id]);
      const visit = (groupId: string) => {
        (childIdsByParent.get(groupId) || []).forEach((childId) => {
          if (removedIds.has(childId)) return;
          removedIds.add(childId);
          visit(childId);
        });
      };
      visit(group.group_id);

      const nextGroups = problemGroups.filter((item) => !removedIds.has(item.group_id));
      commitProblemGroupsSnapshot(
        nextGroups,
        removedIds.size > 1 ? `문제정의 노드와 하위 ${removedIds.size - 1}개를 삭제했습니다.` : "문제정의 노드를 삭제했습니다.",
        nextGroups[0]?.group_id || "",
      );
    },
    [commitProblemGroupsSnapshot, problemGroups],
  );

  const handleToggleProblemChildren = useCallback((groupId: string) => {
    setCollapsedProblemGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const syncProblemStructureNodesFromDefinition = useCallback(() => {
    const nextNodes = buildProblemStructureNodesFromGroups(problemGroups);
    setProblemStructureNodes(nextNodes);
    setProblemStructureGroups((prev) => pruneProblemStructureGroups(prev, nextNodes));
    return nextNodes;
  }, [problemGroups]);

  const handleOpenProblemStructureSetup = useCallback(() => {
    if (problemGroups.length === 0) {
      setActivityMessage("구조화할 문제정의 노드가 아직 없습니다.");
      return;
    }
    setProblemStructureDraftMethod(problemStructureMethod);
    setProblemStructureDraftMode(problemDefinitionMode || "ai");
    setProblemStructureSetupOpen(true);
  }, [problemDefinitionMode, problemGroups.length, problemStructureMethod]);

  const runProblemStructureGrouping = useCallback(
    async (options?: { nodes?: ProblemStructureNodeViewModel[]; method?: ProblemStructureMethod }) => {
      const structureNodes =
        options?.nodes && options.nodes.length > 0
          ? options.nodes
          : problemStructureNodes.length > 0
            ? problemStructureNodes
            : buildProblemStructureNodesFromGroups(problemGroups);
      if (structureNodes.length === 0) {
        setActivityMessage("AI가 묶을 문제정의 노드가 아직 없습니다.");
        return;
      }

      const requestSeq = problemStructureRequestSeqRef.current + 1;
      problemStructureRequestSeqRef.current = requestSeq;
      const method = options?.method || problemStructureMethod;
      setProblemStructurePending(true);
      setActivityMessage(`${problemStructureMethodLabel(method)} 기준으로 AI가 노드를 묶고 있습니다.`);

      try {
        const result = await generateProblemStructure({
          meeting_id: meetingId,
          meeting_topic: meetingTopicForAi,
          method,
          nodes: structureNodes.map((node) => ({
            id: node.id,
            title: node.title,
            body: node.body,
            status: node.status,
            depth: node.depth,
          })),
          existing_groups: problemStructureGroups.map((group) => ({
            id: group.id,
            title: group.title,
            node_ids: group.nodeIds,
            rationale: group.rationale,
          })),
          max_groups: Math.min(8, Math.max(1, Math.ceil(structureNodes.length / 2))),
        });
        if (problemStructureRequestSeqRef.current !== requestSeq) {
          return;
        }

        const nextGroups = normalizeProblemStructureGroupsFromResponse(result.groups || [], structureNodes);
        if (nextGroups.length === 0) {
          setActivityMessage(result.warning || "AI가 유효한 구조화 그룹을 만들지 못했습니다.");
          return;
        }

        setProblemDefinitionMode("ai");
        setProblemStructureMethod(method);
        setProblemStructureNodes(structureNodes);
        setProblemStructureGroups(nextGroups);
        setActivityMessage(
          result.warning ||
            `${result.used_llm ? "AI" : "로컬 fallback"}가 ${structureNodes.length}개 노드를 ${nextGroups.length}개 그룹으로 묶었습니다.`,
        );
      } catch (error) {
        if (problemStructureRequestSeqRef.current !== requestSeq) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setActivityMessage(`AI 구조화 실패: ${message}`);
      } finally {
        if (problemStructureRequestSeqRef.current === requestSeq) {
          setProblemStructurePending(false);
        }
      }
    },
    [
      meetingId,
      meetingTopicForAi,
      problemGroups,
      problemStructureGroups,
      problemStructureMethod,
      problemStructureNodes,
    ],
  );

  const handleStartProblemStructure = useCallback(async () => {
    if (problemGroups.length === 0) {
      setActivityMessage("구조화할 문제정의 노드가 아직 없습니다.");
      return;
    }
    const nextMode = problemStructureDraftMode || "manual";
    setProblemStructureMethod(problemStructureDraftMethod);
    setProblemDefinitionMode(nextMode);
    const nextNodes = syncProblemStructureNodesFromDefinition();
    setProblemDefinitionPhase("structure");
    setProblemStructureSetupOpen(false);
    setArmedCanvasTool(null);
    setCanvasPlacementPreview(null);
    setPendingProblemGroupLinkId("");
    setSelectedNodeId("");
    setSelectedProblemGroupId("");
    setProblemGroupingRationaleOpenGroupId("");
    setActivityMessage(
      `${problemStructureMethodLabel(problemStructureDraftMethod)} · ${problemDefinitionModeLabel(nextMode)} 방식으로 정의 2단계를 시작했습니다. 노드 ${nextNodes.length}개를 가져왔습니다.`,
    );
    if (nextMode === "ai") {
      await runProblemStructureGrouping({
        nodes: nextNodes,
        method: problemStructureDraftMethod,
      });
    }
  }, [
    problemGroups.length,
    problemStructureDraftMethod,
    problemStructureDraftMode,
    runProblemStructureGrouping,
    syncProblemStructureNodesFromDefinition,
  ]);

  const handleBackToProblemDefinitionExplore = useCallback(() => {
    setProblemDefinitionPhase("explore");
    const nextGroupId = selectedProblemGroupId || problemGroups[0]?.group_id || "";
    setSelectedProblemGroupId(nextGroupId);
    setSelectedNodeId(nextGroupId ? `problem-${nextGroupId}` : "");
    setActivityMessage("정의 1단계 캔버스로 돌아왔습니다.");
  }, [problemGroups, selectedProblemGroupId]);

  const handleRefreshProblemStructureNodes = useCallback(() => {
    const nextNodes = syncProblemStructureNodesFromDefinition();
    setActivityMessage(`정의 1단계의 현재 노드 ${nextNodes.length}개를 다시 가져왔습니다.`);
  }, [syncProblemStructureNodesFromDefinition]);

  const handleAddProblemStructureGroup = useCallback(() => {
    setProblemStructureGroups((prev) => [...prev, makeProblemStructureGroup(prev.length)]);
    setActivityMessage("정의 2단계 구조화 그룹을 추가했습니다.");
  }, []);

  const handleDeleteProblemStructureGroup = useCallback((groupId: string) => {
    setProblemStructureGroups((prev) => prev.filter((group) => group.id !== groupId));
    setActivityMessage("구조화 그룹을 삭제했습니다. 포함된 노드는 묶지 않은 노드로 돌아갑니다.");
  }, []);

  const handleAssignProblemStructureNode = useCallback((nodeId: string, groupId: string) => {
    setProblemStructureGroups((prev) =>
      prev.map((group) => {
        const withoutNode = group.nodeIds.filter((item) => item !== nodeId);
        if (group.id !== groupId) {
          return {
            ...group,
            nodeIds: withoutNode,
          };
        }
        return {
          ...group,
          nodeIds: [...withoutNode, nodeId],
          createdBy: "user",
        };
      }),
    );
  }, []);

  const handleCreateProblemStructurePairGroup = useCallback(
    (sourceNodeId: string, targetNodeId: string) => {
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return;
      const sourceNode = problemStructureNodes.find((node) => node.id === sourceNodeId);
      const targetNode = problemStructureNodes.find((node) => node.id === targetNodeId);
      if (!sourceNode || !targetNode) return;

      setProblemStructureGroups((prev) => {
        const nextGroup = {
          ...makeProblemStructureGroup(prev.length, "user"),
          title: makeProblemStructurePairGroupTitle(sourceNode, targetNode),
          nodeIds: [targetNodeId, sourceNodeId],
        };
        return [
          ...prev.map((group) => ({
            ...group,
            nodeIds: group.nodeIds.filter((nodeId) => nodeId !== sourceNodeId && nodeId !== targetNodeId),
          })),
          nextGroup,
        ];
      });
      setActivityMessage(`"${sourceNode.title}"와 "${targetNode.title}"로 새 구조화 그룹을 만들었습니다.`);
    },
    [problemStructureNodes],
  );

  const getProblemStructureDraggedNodeId = useCallback(
    (event: React.DragEvent<HTMLElement>) =>
      event.dataTransfer.getData(PROBLEM_STRUCTURE_NODE_DRAG_MIME) ||
      event.dataTransfer.getData("text/plain") ||
      problemStructureDrag?.nodeId ||
      "",
    [problemStructureDrag?.nodeId],
  );

  const handleProblemStructureNodeDragStart = useCallback((event: React.DragEvent<HTMLElement>, nodeId: string) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, button")) {
      event.preventDefault();
      return;
    }

    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PROBLEM_STRUCTURE_NODE_DRAG_MIME, nodeId);
    event.dataTransfer.setData("text/plain", nodeId);
    setProblemStructureDrag({ nodeId, overGroupId: "", overNodeId: "", mode: "" });
  }, []);

  const handleProblemStructureNodeDragEnd = useCallback(() => {
    setProblemStructureDrag(null);
  }, []);

  const handleProblemStructureGroupDragOver = useCallback((event: React.DragEvent<HTMLElement>, groupId: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setProblemStructureDrag((prev) => {
      if (!prev?.nodeId) return prev;
      if (prev.mode === "group" && prev.overGroupId === groupId && !prev.overNodeId) return prev;
      return { ...prev, mode: "group", overGroupId: groupId, overNodeId: "" };
    });
  }, []);

  const handleProblemStructureNodeDragOver = useCallback((event: React.DragEvent<HTMLElement>, targetNodeId: string) => {
    setProblemStructureDrag((prev) => {
      if (!prev?.nodeId || prev.nodeId === targetNodeId) return prev;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (prev.mode === "node" && prev.overNodeId === targetNodeId) return prev;
      return { ...prev, mode: "node", overNodeId: targetNodeId, overGroupId: "" };
    });
  }, []);

  const handleProblemStructureGroupDrop = useCallback(
    (event: React.DragEvent<HTMLElement>, groupId: string) => {
      const draggedNodeId = getProblemStructureDraggedNodeId(event);
      if (!draggedNodeId) return;

      event.preventDefault();
      event.stopPropagation();
      handleAssignProblemStructureNode(draggedNodeId, groupId);
      setProblemStructureDrag(null);

      if (!groupId) {
        setActivityMessage("구조화 노드를 묶지 않은 노드로 이동했습니다.");
        return;
      }

      const targetGroup = problemStructureGroups.find((group) => group.id === groupId);
      setActivityMessage(`구조화 노드를 "${targetGroup?.title || "선택한 그룹"}"에 추가했습니다.`);
    },
    [getProblemStructureDraggedNodeId, handleAssignProblemStructureNode, problemStructureGroups],
  );

  const handleProblemStructureNodeDrop = useCallback(
    (event: React.DragEvent<HTMLElement>, targetNodeId: string) => {
      const draggedNodeId = getProblemStructureDraggedNodeId(event);
      if (!draggedNodeId || draggedNodeId === targetNodeId) {
        setProblemStructureDrag(null);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleCreateProblemStructurePairGroup(draggedNodeId, targetNodeId);
      setProblemStructureDrag(null);
    },
    [getProblemStructureDraggedNodeId, handleCreateProblemStructurePairGroup],
  );

  const handleUpdateProblemStructureNodeTitle = useCallback((nodeId: string, title: string) => {
    setProblemStructureNodes((prev) =>
      prev.map((node) => (node.id === nodeId ? { ...node, title } : node)),
    );
  }, []);

  const handleRemoveProblemStructureNode = useCallback((nodeId: string) => {
    setProblemStructureNodes((prev) => prev.filter((node) => node.id !== nodeId));
    setProblemStructureGroups((prev) =>
      prev.map((group) => ({
        ...group,
        nodeIds: group.nodeIds.filter((item) => item !== nodeId),
      })),
    );
    setActivityMessage("정의 2단계 구조화 레이어에서 노드를 제외했습니다.");
  }, []);

  const handleUpdateProblemStructureGroupTitle = useCallback((groupId: string, title: string) => {
    setProblemStructureGroups((prev) =>
      prev.map((group) => (group.id === groupId ? { ...group, title, createdBy: "user" } : group)),
    );
  }, []);

  const handleUpdateProblemStructureGroupStatus = useCallback((groupId: string, status: ProblemGroupStatus) => {
    setProblemStructureGroups((prev) =>
      prev.map((group) => (group.id === groupId ? { ...group, status, createdBy: "user" } : group)),
    );
    setActivityMessage(`구조화 그룹 상태를 ${problemGroupStatusLabel(status)}로 변경했습니다.`);
  }, []);

  const handleUpdateProblemStructureGroupRationale = useCallback((groupId: string, rationale: string) => {
    setProblemStructureGroups((prev) =>
      prev.map((group) => (group.id === groupId ? { ...group, rationale, createdBy: "user" } : group)),
    );
  }, []);

  const graphBlueprint = useMemo(() => {
    if (stage === "problem-definition") {
      if (problemDefinitionPhase === "structure") {
        const structureNodes =
          problemStructureNodes.length > 0
            ? problemStructureNodes
            : buildProblemStructureNodesFromGroups(problemGroups);
        const nodeById = new Map(structureNodes.map((node) => [node.id, node]));
        const assignedNodeIds = new Set(
          problemStructureGroups.flatMap((group) => group.nodeIds.filter((nodeId) => nodeById.has(nodeId))),
        );
        const ungroupedNodes = structureNodes.filter((node) => !assignedNodeIds.has(node.id));
        const columns = [
          {
            id: "__ungrouped__",
            title: "아직 묶지 않은 노드",
            rationale: "정의 1단계에서 가져온 모든 노드가 먼저 여기에 놓입니다.",
            nodeIds: ungroupedNodes.map((node) => node.id),
            status: "draft" as const,
            createdBy: "user" as const,
            fixed: true,
          },
          ...problemStructureGroups.map((group) => ({
            ...group,
            fixed: false,
          })),
        ];
        const isCardSorting = problemStructureMethod === "card-sorting";
        const columnWidth = isCardSorting ? 344 : 376;
        const columnGap = isCardSorting ? 28 : 44;
        const baseX = 44;
        const baseY = isCardSorting ? 48 : 64;
        const structureDescriptors: CanvasNodeDescriptor[] = columns.map((column, index) => {
          const isUngrouped = column.id === "__ungrouped__";
          const columnNodes = column.nodeIds
            .map((nodeId) => nodeById.get(nodeId))
            .filter((node): node is ProblemStructureNodeViewModel => Boolean(node));
          const nodeId = isUngrouped ? "problem-structure-ungrouped" : `problem-structure-${column.id}`;
          const columnDropGroupId = isUngrouped ? "" : column.id;
          const isColumnDropTarget =
            problemStructureDrag?.mode === "group" &&
            problemStructureDrag.overGroupId === columnDropGroupId;
          const savedPosition = !isCardSorting ? nodePositions["problem-definition"]?.[nodeId] : undefined;
          const nodeHeight = Math.max(260, 184 + Math.max(1, columnNodes.length) * 92);
          const position = savedPosition || {
            x: baseX + index * (columnWidth + columnGap),
            y: baseY + (!isCardSorting && index % 2 === 1 ? 34 : 0),
          };
          const rationaleLabel = isCardSorting ? "그룹 설명 / 이유 카드" : "묶은 이유";

          return {
            id: nodeId,
            position,
            positionSource: savedPosition ? "persisted" : "computed",
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            className: "!border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: columnWidth, minHeight: nodeHeight, padding: 0 },
            draggable: !isCardSorting,
            data: {
              contentSignature: buildNodeContentSignature([
                "problem-structure",
                problemStructureMethod,
                problemDefinitionMode,
                column.id,
                column.title,
                column.rationale,
                column.status || "",
                columnNodes.length,
                ...columnNodes.flatMap((node) => [node.id, node.title, node.status, node.depth]),
                ...problemStructureGroups.map((group) => `${group.id}:${group.nodeIds.join(",")}`),
                problemStructureDrag?.nodeId,
                problemStructureDrag?.mode,
                problemStructureDrag?.overGroupId,
                problemStructureDrag?.overNodeId,
              ]),
              label: (
                <div
                  className={`nopan box-border min-w-0 rounded-[14px] border bg-white p-4 text-left font-['Inter','Noto_Sans_KR',sans-serif] shadow-[0_1px_0_rgba(0,0,0,0.04)] ${
                    isUngrouped
                      ? "border-dashed border-black/20"
                      : isCardSorting
                        ? "border-[#1b59f8]/20"
                        : "border-black/10"
                  } ${isColumnDropTarget ? "ring-2 ring-[#1b59f8]/35 ring-offset-2" : ""}`}
                  onDragOver={(event) => handleProblemStructureGroupDragOver(event, columnDropGroupId)}
                  onDrop={(event) => handleProblemStructureGroupDrop(event, columnDropGroupId)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="inline-flex items-center rounded-[8px] bg-[#eef4ff] px-2.5 py-1 text-[11px] font-semibold text-[#1b59f8]">
                        {isUngrouped ? "Pool" : problemStructureMethodLabel(problemStructureMethod)}
                      </span>
                      {isUngrouped ? (
                        <strong className="mt-3 block text-[17px] font-semibold leading-6 text-black">
                          {column.title}
                        </strong>
                      ) : (
                        <input
                          value={column.title}
                          onChange={(event) => handleUpdateProblemStructureGroupTitle(column.id, event.target.value)}
                          onPointerDown={(event) => event.stopPropagation()}
                          className="nodrag nopan mt-3 block w-full rounded-[8px] border border-black/10 bg-[#f9f9f9] px-3 py-2 text-[17px] font-semibold leading-6 text-black outline-none transition focus:border-[#1b59f8]/40 focus:bg-white"
                        />
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded-[8px] bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                        {columnNodes.length}개
                      </span>
                      {!isUngrouped ? (
                        <button
                          type="button"
                          onClick={() => handleDeleteProblemStructureGroup(column.id)}
                          onPointerDown={(event) => event.stopPropagation()}
                          className="nodrag nopan rounded-[8px] border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50"
                        >
                          삭제
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {!isUngrouped ? (
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[11px] font-semibold text-[#777]">그룹 상태</span>
                      <select
                        value={column.status || "draft"}
                        onChange={(event) =>
                          handleUpdateProblemStructureGroupStatus(column.id, event.target.value as ProblemGroupStatus)
                        }
                        onPointerDown={(event) => event.stopPropagation()}
                        className={`nodrag nopan w-full rounded-[8px] border border-black/10 bg-[#f9f9f9] px-2 py-1.5 text-xs font-semibold outline-none transition focus:border-[#1b59f8]/40 ${problemGroupStatusTone(column.status || "draft")}`}
                      >
                        {(["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => (
                          <option key={`${column.id}-status-${status}`} value={status}>
                            {problemGroupStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {isUngrouped ? (
                    <p className="mt-3 rounded-[10px] bg-[#f5f6f8] px-3 py-2 text-xs leading-5 text-[#4d4d4d]">
                      그룹을 만든 뒤 노드를 드래그해 넣거나, 노드끼리 겹쳐 새 그룹을 만들 수 있습니다.
                    </p>
                  ) : (
                    <div className={`mt-3 rounded-[10px] ${isCardSorting ? "border border-[#1b59f8]/10 bg-[#eef4ff]" : "bg-[#f5f6f8]"} p-3`}>
                      <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1b59f8]">
                        {rationaleLabel}
                      </label>
                      <textarea
                        value={column.rationale}
                        onChange={(event) => handleUpdateProblemStructureGroupRationale(column.id, event.target.value)}
                        onPointerDown={(event) => event.stopPropagation()}
                        placeholder={column.createdBy === "ai" ? "AI가 왜 묶었는지 나중에 여기에 표시합니다." : "이 그룹으로 묶은 이유를 적어둘 수 있습니다."}
                        className="nodrag nopan mt-2 min-h-[68px] w-full resize-none rounded-[8px] border border-black/10 bg-white px-3 py-2 text-xs leading-5 text-[#333] outline-none transition focus:border-[#1b59f8]/40"
                      />
                    </div>
                  )}

                  <div className="mt-3 space-y-2">
                    {columnNodes.length > 0 ? (
                      columnNodes.map((node) => {
                        const isDraggingNode = problemStructureDrag?.nodeId === node.id;
                        const isNodeDropTarget =
                          problemStructureDrag?.mode === "node" &&
                          problemStructureDrag.overNodeId === node.id &&
                          problemStructureDrag.nodeId !== node.id;
                        return (
                          <div
                            key={`${column.id}-${node.id}`}
                            draggable
                            onDragStart={(event) => handleProblemStructureNodeDragStart(event, node.id)}
                            onDragEnd={handleProblemStructureNodeDragEnd}
                            onDragOver={(event) => handleProblemStructureNodeDragOver(event, node.id)}
                            onDrop={(event) => handleProblemStructureNodeDrop(event, node.id)}
                            className={`nodrag nopan cursor-grab rounded-[10px] border bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.03)] transition active:cursor-grabbing ${
                              isNodeDropTarget
                                ? "border-[#1b59f8] ring-2 ring-[#1b59f8]/20"
                                : "border-black/10 hover:border-[#1b59f8]/25"
                              } ${isDraggingNode ? "opacity-55" : ""}`}
                          >
                          <div className="flex items-start gap-2">
                            <textarea
                              value={node.title}
                              onChange={(event) => handleUpdateProblemStructureNodeTitle(node.id, event.target.value)}
                              onPointerDown={(event) => event.stopPropagation()}
                              aria-label="구조화 노드 제목"
                              rows={2}
                              className="nodrag nopan block min-h-[44px] flex-1 resize-none rounded-[8px] border border-transparent bg-transparent px-1 py-1 text-sm font-semibold leading-5 text-black outline-none transition hover:border-black/10 hover:bg-[#f9f9f9] focus:border-[#1b59f8]/40 focus:bg-white"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveProblemStructureNode(node.id)}
                              onPointerDown={(event) => event.stopPropagation()}
                              aria-label="구조화 노드 제외"
                              className="nodrag nopan flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-rose-200 bg-white text-[16px] font-semibold leading-none text-rose-600 transition hover:bg-rose-50"
                            >
                              ×
                            </button>
                          </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="rounded-[10px] border border-dashed border-black/10 bg-[#f9f9f9] px-3 py-4 text-center text-xs leading-5 text-[#777]">
                        {isUngrouped ? "모든 노드가 그룹에 들어갔습니다." : "아직 이 그룹에 들어온 노드가 없습니다."}
                      </p>
                    )}
                  </div>
                </div>
              ),
            },
          };
        });

        return {
          layoutSignature: buildNodeContentSignature([
            stage,
            problemDefinitionPhase,
            problemStructureMethod,
            problemDefinitionMode,
            ...structureNodes.flatMap((node) => [node.id, node.title, node.status, node.depth]),
            ...problemStructureGroups.flatMap((group) => [
              group.id,
              group.title,
              group.rationale,
              group.status,
              group.createdBy,
              ...group.nodeIds,
            ]),
          ]),
          nodeDescriptors: structureDescriptors,
        };
      }

      const activeGroup =
        problemGroups.find((group) => group.group_id === selectedProblemGroupId) ||
        problemGroups[0] ||
        null;
      const problemGroupHeightById = new Map(
        problemGroups.map((group) => [group.group_id, estimateProblemTopicNodeHeight(group)] as const),
      );
      const childGroupsByParentId = new Map<string, ProblemGroupViewModel[]>();
      problemGroups.forEach((group) => {
        const parentId = group.parent_group_id || "";
        const children = childGroupsByParentId.get(parentId) || [];
        children.push(group);
        childGroupsByParentId.set(parentId, children);
      });

      const problemNodeWidth = 336;
      const problemNodeGapX = 72;
      const problemLevelHeight = 272;
      const problemBaseX = 64;
      const problemBaseY = 56;
      const problemGroupIds = new Set(problemGroups.map((group) => group.group_id));
      const rootProblemGroupCandidates = problemGroups.filter(
        (group) => !group.parent_group_id || !problemGroupIds.has(group.parent_group_id),
      );
      const rootProblemGroups = rootProblemGroupCandidates.length > 0 ? rootProblemGroupCandidates : problemGroups;
      const subtreeWidthCache = new Map<string, number>();
      const getVisibleChildren = (group: ProblemGroupViewModel) =>
        collapsedProblemGroupIds.has(group.group_id) ? [] : childGroupsByParentId.get(group.group_id) || [];
      const measureProblemSubtree = (group: ProblemGroupViewModel, trail = new Set<string>()): number => {
        if (trail.has(group.group_id)) return problemNodeWidth;
        const cachedWidth = subtreeWidthCache.get(group.group_id);
        if (cachedWidth !== undefined) return cachedWidth;
        const nextTrail = new Set(trail);
        nextTrail.add(group.group_id);
        const children = getVisibleChildren(group);
        if (children.length === 0) {
          subtreeWidthCache.set(group.group_id, problemNodeWidth);
          return problemNodeWidth;
        }
        const childrenWidth = children.reduce(
          (total, child, childIndex) =>
            total + measureProblemSubtree(child, nextTrail) + (childIndex > 0 ? problemNodeGapX : 0),
          0,
        );
        const width = Math.max(problemNodeWidth, childrenWidth);
        subtreeWidthCache.set(group.group_id, width);
        return width;
      };
      const positionedProblemGroups: Array<{
        group: ProblemGroupViewModel;
        position: { x: number; y: number };
        rootIndex: number;
      }> = [];
      const layoutProblemSubtree = (
        group: ProblemGroupViewModel,
        leftX: number,
        depth: number,
        rootIndex: number,
        trail = new Set<string>(),
      ) => {
        if (trail.has(group.group_id)) return;
        const nextTrail = new Set(trail);
        nextTrail.add(group.group_id);
        const subtreeWidth = measureProblemSubtree(group, trail);
        positionedProblemGroups.push({
          group,
          rootIndex,
          position: {
            x: Math.round(leftX + subtreeWidth / 2 - problemNodeWidth / 2),
            y: problemBaseY + depth * problemLevelHeight,
          },
        });
        const children = getVisibleChildren(group);
        let childLeftX = leftX;
        children.forEach((child) => {
          const childWidth = measureProblemSubtree(child, nextTrail);
          layoutProblemSubtree(child, childLeftX, depth + 1, rootIndex, nextTrail);
          childLeftX += childWidth + problemNodeGapX;
        });
      };

      let nextRootX = problemBaseX;
      rootProblemGroups.forEach((group, rootIndex) => {
        const subtreeWidth = measureProblemSubtree(group);
        layoutProblemSubtree(group, nextRootX, 0, rootIndex);
        nextRootX += subtreeWidth + problemNodeGapX;
      });

      const leftDescriptors: CanvasNodeDescriptor[] = positionedProblemGroups.map(
        ({ group, position, rootIndex }) => {
          const selected = activeGroup?.group_id === group.group_id || pendingProblemGroupLinkId === group.group_id;
          const loading = loadingProblemGroupIds.includes(group.group_id);
          const dropTarget = dropProblemGroupId === group.group_id;
          const nodeId = `problem-${group.group_id}`;
          const sourceCount = buildProblemGroupDisplayCards(group).length;
          const opinionCount = (group.discussion_items || []).length;
          const nodeHeight = problemGroupHeightById.get(group.group_id) || estimateProblemTopicNodeHeight(group);
          const savedPosition = nodePositions["problem-definition"]?.[nodeId];
          const childCount = problemGroups.filter((item) => item.parent_group_id === group.group_id).length;
          const childCollapsed = collapsedProblemGroupIds.has(group.group_id);
          const criteriaLoading = problemGroupingRationalePendingId === group.group_id;
          const hasGroupingRationale = Boolean(problemGroupingRationaleById[group.group_id]);

          return {
            id: nodeId,
            position: savedPosition || position,
            positionSource: savedPosition ? "persisted" : "computed",
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "!border-0 !bg-transparent !p-0 !shadow-none",
            style: { width: problemNodeWidth, minHeight: nodeHeight, padding: 0 },
            draggable: true,
            data: {
              contentSignature: buildNodeContentSignature([
                "problem-topic",
                group.group_id,
                group.parent_group_id || "",
                group.depth || 0,
                group.topic,
                group.status,
                selected,
                loading,
                dropTarget,
                pendingProblemGroupLinkId === group.group_id,
                group.insight_lens,
                group.conclusion,
                ...(group.linked_group_ids || []),
                sourceCount,
                opinionCount,
                childCount,
                childCollapsed,
                problemChildGenerationPendingId === group.group_id,
                criteriaLoading,
                hasGroupingRationale,
              ]),
              label: makeProblemTopicNodeLabel(
                group,
                rootIndex,
                selected,
                loading,
                dropTarget,
                sourceCount,
                opinionCount,
                childCount,
                childCollapsed,
                problemChildGenerationPendingId === group.group_id,
                criteriaLoading,
                hasGroupingRationale,
                (event) => {
                  event.stopPropagation();
                  void handleShowProblemGroupingRationale(group);
                },
                (event) => {
                  event.stopPropagation();
                  void handleGenerateProblemChildren(group);
                },
                (event) => {
                  event.stopPropagation();
                  handleToggleProblemChildren(group.group_id);
                },
                (event) => {
                  event.stopPropagation();
                  handleQuickEditProblemGroup(group);
                },
                (event) => {
                  event.stopPropagation();
                  handleDeleteProblemGroup(group);
                },
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
        },
      );
      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          activeGroup?.group_id || "",
          ...Array.from(collapsedProblemGroupIds),
          ...problemGroups.flatMap((group) => [
            group.group_id,
            group.topic,
            group.status,
            group.insight_lens || "",
            group.conclusion || "",
            ...(group.linked_group_ids || []),
            ...(group.source_summary_items || []),
            ...(group.ideas || []).flatMap((idea) => [idea.id, idea.kind, idea.title, idea.body]),
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
        nodeDescriptors: leftDescriptors,
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
      const bubbles = activeIdeationKeywordBubbles;
      const bubblePlacements = buildIdeationKeywordBubblePlacements(bubbles);
      const bubbleDescriptors: CanvasNodeDescriptor[] = bubbles.length > 0
        ? bubblePlacements.map(({ bubble, x, y, size }) => {
            return {
              id: bubble.id,
              position: {
                x,
                y,
              },
              positionSource: "computed" as const,
              sourcePosition: Position.Bottom,
              targetPosition: Position.Top,
              className: "!border-0 !bg-transparent !p-0 !shadow-none",
              style: { width: size, height: size, padding: 0 },
              draggable: false,
              selectable: false,
              data: {
                contentSignature: buildNodeContentSignature([
                  "ideation-keyword-bubble",
                  bubble.text,
                  bubble.count,
                  bubble.weight,
                  ...bubble.related,
                ]),
                label: makeIdeationKeywordBubbleNodeLabel(bubble, size),
              },
            };
          })
        : [
            {
              id: "ideation-keyword-empty",
              position: { x: 320, y: 260 },
              positionSource: "computed" as const,
              sourcePosition: Position.Bottom,
              targetPosition: Position.Top,
              className: "!border-0 !bg-transparent !p-0 !shadow-none",
              style: { width: 520, minHeight: 180, padding: 0 },
              draggable: false,
              selectable: false,
              data: {
                contentSignature: "ideation-keyword-empty",
                label: (
                  <div className="flex min-h-[180px] items-center justify-center rounded-[18px] border border-dashed border-black/10 bg-white/80 px-6 text-center text-sm leading-6 text-[#777]">
                    발화가 들어오면 자주 나온 명사가 버블로 표시됩니다.
                  </div>
                ),
              },
            },
          ];

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          "keyword-bubbles",
          ...bubbles.flatMap((bubble) => [bubble.text, bubble.count, ...bubble.related]),
        ]),
        nodeDescriptors: bubbleDescriptors,
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
    activeIdeationKeywordBubbles,
    agendaModels,
    agendaDragPreview,
    canvasItems,
    collapsedProblemGroupIds,
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
    handleDeleteProblemGroup,
    handleDeleteProblemStructureGroup,
    handleGenerateProblemChildren,
    handleProblemStructureGroupDragOver,
    handleProblemStructureGroupDrop,
    handleProblemStructureNodeDragEnd,
    handleProblemStructureNodeDragOver,
    handleProblemStructureNodeDragStart,
    handleProblemStructureNodeDrop,
    handleRemoveProblemStructureNode,
    handleUpdateProblemStructureNodeTitle,
    handleUpdateProblemStructureGroupRationale,
    handleUpdateProblemStructureGroupStatus,
    handleUpdateProblemStructureGroupTitle,
    handleQuickEditProblemGroup,
    handleShowProblemGroupingRationale,
    handleToggleProblemChildren,
    ideationDropPreview,
    latestHighlightedTopicId,
    loadingProblemGroupIds,
    nodePositions,
    pendingProblemGroupLinkId,
    persistedSharedImportedState,
    problemChildGenerationPendingId,
    problemDefinitionMode,
    problemDefinitionPhase,
    problemGroupingRationaleById,
    problemGroupingRationalePendingId,
    problemGroups,
    problemStructureDrag,
    problemStructureGroups,
    problemStructureMethod,
    problemStructureNodes,
    selectedCanvasItemId,
    selectedProblemGroupId,
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
      if (stageKey === "problem-definition") {
        problemGroups.forEach((group) => validNodeIds.add(`problem-${group.group_id}`));
      }
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
  }, [graphBlueprint.layoutSignature, graphBlueprint.nodeDescriptors, problemGroups, stage]);

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
    () =>
      problemDefinitionPhase === "structure"
        ? null
        : problemGroups.find((group) => group.group_id === selectedProblemGroupId) || problemGroups[0] || null,
    [problemDefinitionPhase, problemGroups, selectedProblemGroupId],
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
  const finalSolutionSummary = finalSummaryDocument;
  const summaryDocumentSections = useMemo(
    () => finalSummaryDocument.sections || [],
    [finalSummaryDocument.sections],
  );
  const summaryDocumentSectionByGroupId = useMemo(
    () => new Map(summaryDocumentSections.map((section) => [section.group_id, section])),
    [summaryDocumentSections],
  );
  const summaryEligibleStructureGroups = useMemo(
    () => getSummaryEligibleStructureGroups(problemStructureGroups),
    [problemStructureGroups],
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
  }, [agendaModels, canvasItems, selectedAgenda, selectedCanvasItem, selectedNodeId, selectedProblemGroup, selectedProblemSourceCard, selectedProblemSourceCards, selectedProblemSourceOpinions, selectedSolutionTopic, stage]);

  const handleGenerateProblemDefinition = useCallback(async (options?: { force?: boolean; refreshChunkSummaries?: boolean }) => {
    const forceRegenerate = Boolean(options?.force);
    const refreshChunkSummaries = Boolean(options?.refreshChunkSummaries);
    setProblemDefinitionStagePending(true);
    setBusy(true);
    try {
      setStage("problem-definition");
      setSelectedSolutionTopicId("");
      setEditingProblemGroupId("");
      setEditingSolutionTopicId("");

      if (problemGroups.length > 0 && !forceRegenerate) {
        const firstGroupId = selectedProblemGroupId || problemGroups[0]?.group_id || "";
        setSelectedProblemGroupId(firstGroupId);
        setSelectedNodeId(firstGroupId ? `problem-${firstGroupId}` : "");
        setActivityMessage("기존 문제정의 캔버스를 유지했습니다.");
        return;
      }

      const utterances = buildProblemTaxonomyUtterances(transcripts);
      if (utterances.length === 0) {
        if (forceRegenerate) {
          setProblemGroups([]);
          setProblemGroupingRationaleById({});
          setProblemGroupingRationaleOpenGroupId("");
          setProblemGroupingRationalePendingId("");
          setProblemDefinitionPhase("explore");
          setProblemStructureSetupOpen(false);
          setProblemStructureNodes([]);
          setProblemStructureGroups([]);
          setProblemStructurePending(false);
        }
        setProblemDefinitionMode("");
        setSelectedProblemGroupId("");
        setSelectedNodeId("");
        setActivityMessage("문제정의를 만들 STT 발화가 아직 없습니다.");
        return;
      }

      const nextNodePositionsSnapshot = forceRegenerate
        ? {
            ...nodePositions,
            "problem-definition": {},
            solution: {},
          }
        : nodePositions;
      if (forceRegenerate) {
        setProblemGroups([]);
        setSolutionTopics([]);
        setNodePositions(nextNodePositionsSnapshot);
        setProblemDefinitionPhase("explore");
        setProblemStructureSetupOpen(false);
        setProblemStructureNodes([]);
        setProblemStructureGroups([]);
        setProblemStructurePending(false);
        setSelectedProblemGroupId("");
        setSelectedProblemSourceNodeId("");
        setSelectedNodeId("");
        setCollapsedProblemGroupIds(new Set());
        setProblemGroupingRationaleById({});
        setProblemGroupingRationaleOpenGroupId("");
        setProblemGroupingRationalePendingId("");
      }

      const result = await generateCanvasProblemTaxonomy({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        debug_nonce: forceRegenerate ? `debug-${refreshChunkSummaries ? "chunks-" : ""}${Date.now()}` : undefined,
        refresh_chunk_summaries: refreshChunkSummaries || undefined,
        utterances,
        existing_group_ids: [],
        existing_groups: forceRegenerate ? [] : buildProblemTaxonomyExistingGroupsPayload(problemGroups),
        max_groups: 6,
      });
      const nextGroups = hydrateProblemGroups(result.groups || [], []).map((group) => ({
        ...group,
        parent_group_id: group.parent_group_id || "",
        depth: group.depth || 0,
        status: "draft" as ProblemGroupStatus,
      }));

      setProblemGroups(nextGroups);
      setProblemDefinitionPhase("explore");
      setProblemStructureSetupOpen(false);
      setProblemStructureNodes([]);
      setProblemStructureGroups([]);
      setProblemStructurePending(false);
      const nextSelectedGroupId = nextGroups[0]?.group_id || "";
      setSelectedProblemGroupId(nextSelectedGroupId);
      setSelectedNodeId(nextSelectedGroupId ? `problem-${nextSelectedGroupId}` : "");
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage: "problem-definition",
        problemGroups: nextGroups,
        solutionTopics: forceRegenerate ? [] : latestSharedWorkspaceRef.current.solutionTopics,
        nodePositions: nextNodePositionsSnapshot,
        importedState: persistedSharedImportedState,
      };

      if (sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          stage: "problem-definition",
          problemGroups: nextGroups,
          solutionTopics: forceRegenerate ? [] : undefined,
          nodePositions: nextNodePositionsSnapshot,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            stage: "problem-definition",
            problem_groups: serializeSharedProblemGroups(nextGroups),
            solution_topics: forceRegenerate ? [] : undefined,
            node_positions: nextNodePositionsSnapshot,
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save problem taxonomy:", error);
          });
        }
      }

      setActivityMessage(
        result.warning ||
          (nextGroups.length > 0
            ? forceRegenerate
              ? refreshChunkSummaries
                ? `요약 캐시까지 다시 만들고 문제정의를 재생성했습니다. 큰 분류 ${nextGroups.length}개를 만들었습니다.`
                : `문제정의를 다시 생성했습니다. 큰 분류 ${nextGroups.length}개를 만들었습니다.`
              : `STT 발화에서 큰 분류 ${nextGroups.length}개를 만들었습니다.`
            : "분류할 만큼 뚜렷한 STT 발화를 찾지 못했습니다."),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`문제 정의 생성 실패: ${message}`);
    } finally {
      setProblemDefinitionStagePending(false);
      setBusy(false);
    }
  }, [
    forceBroadcastSharedCanvas,
    meetingId,
    meetingTopicForAi,
    nodePositions,
    persistedSharedImportedState,
    problemGroups,
    selectedProblemGroupId,
    sharedSyncEnabled,
    transcripts,
  ]);

  const handleDebugRegenerateProblemDefinition = useCallback(async () => {
    if (busy || problemDefinitionStagePending) {
      setActivityMessage("문제정의 생성 작업이 이미 진행 중입니다.");
      return;
    }
    const ok = window.confirm("디버깅용으로 기존 문제정의 노드와 해결책 결과를 비우고 STT 기반으로 다시 생성할까요?");
    if (!ok) return;
    await handleGenerateProblemDefinition({ force: true });
  }, [busy, handleGenerateProblemDefinition, problemDefinitionStagePending]);

  const handleRefreshProblemChunkSummaries = useCallback(async () => {
    if (busy || problemDefinitionStagePending) {
      setActivityMessage("문제정의 생성 작업이 이미 진행 중입니다.");
      return;
    }
    const ok = window.confirm(
      "디버깅용으로 chunk summary 캐시까지 새로 만들고 문제정의 노드를 다시 생성할까요?",
    );
    if (!ok) return;
    await handleGenerateProblemDefinition({ force: true, refreshChunkSummaries: true });
  }, [busy, handleGenerateProblemDefinition, problemDefinitionStagePending]);

  const handleGenerateSolutionStage = useCallback(async (options?: { force?: boolean }) => {
    const eligibleGroups = getSummaryEligibleStructureGroups(problemStructureGroups);
    setStage("solution");
    setLeftPanelTab("detail");
    setSelectedProblemGroupId("");
    setSelectedSolutionTopicId("");
    setSelectedNodeId("");
    setEditingSolutionTopicId("");

    if (eligibleGroups.length === 0) {
      setActivityMessage("요약 문서에 포함할 검토 중/확정 구조화 그룹이 없습니다.");
      return;
    }

    const hasExistingSummaryDocument =
      finalSummaryDocument.markdown.trim() && (finalSummaryDocument.sections || []).length > 0;
    if (!options?.force && hasExistingSummaryDocument) {
      setActivityMessage("기존 요약 문서를 유지했습니다. 다시 만들려면 요약 단계의 다시 생성 버튼을 사용해 주세요.");
      return;
    }

    setSolutionStagePending(true);
    setBusy(true);
    try {
      const result = await generateCanvasSummaryDocument({
        meeting_id: meetingId,
        meeting_topic: meetingTopicForAi,
        groups: eligibleGroups.map((group) => ({
          id: group.id,
          title: group.title,
          node_ids: group.nodeIds,
          rationale: group.rationale,
          status: group.status,
          created_by: group.createdBy,
        })),
        nodes: problemStructureNodes.map((node) => ({
          id: node.id,
          source_group_id: node.sourceGroupId,
          title: node.title,
          body: node.body,
          status: node.status,
          depth: node.depth,
        })),
      });
      const nextFinalSummary = buildSummaryDocumentFromResponse({
        markdown: result.markdown || "",
        sections: result.sections || [],
        generatedAt: result.generated_at,
        usedLlm: result.used_llm,
        warning: result.warning,
        sourceSignature: result.source_signature || buildSummaryDocumentSourceSignature(eligibleGroups, problemStructureNodes),
      });

      setFinalSummaryDocument(nextFinalSummary);
      setSummaryDocumentEditMode(false);
      setSummaryEvidenceOpenGroupIds(new Set());
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        stage: "solution",
        finalSolutionSummary: nextFinalSummary,
        importedState: persistedSharedImportedState,
      };
      if (sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          stage: "solution",
          finalSolutionSummary: nextFinalSummary,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            stage: "solution",
            final_solution_summary: nextFinalSummary,
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save summary document:", error);
          });
        }
      }
      setActivityMessage(result.warning || `구조화 그룹 ${eligibleGroups.length}개 기준으로 요약 문서를 생성했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`요약 문서 생성 실패: ${message}`);
    } finally {
      setSolutionStagePending(false);
      setBusy(false);
    }
  }, [
    forceBroadcastSharedCanvas,
    finalSummaryDocument.markdown,
    finalSummaryDocument.sections,
    meetingId,
    meetingTopicForAi,
    persistedSharedImportedState,
    problemStructureGroups,
    problemStructureNodes,
    sharedSyncEnabled,
  ]);

  const handleRegenerateSummaryDocument = useCallback(async () => {
    if (busy || solutionStagePending) {
      setActivityMessage("요약 문서 생성 작업이 이미 진행 중입니다.");
      return;
    }
    await handleGenerateSolutionStage({ force: true });
  }, [busy, handleGenerateSolutionStage, solutionStagePending]);

  const handleStageSelect = useCallback(
    async (nextStage: CanvasStage) => {
      if (stage === "problem-definition" && nextStage !== "problem-definition") {
        await flushProblemDiscussionBuffer("stage-change");
      }

      if (nextStage === "solution") {
        if (busy || solutionStagePending) {
          setActivityMessage(
            solutionStagePending
              ? "요약 문서를 생성하는 중이라 잠시 후 다시 시도해 주세요."
              : "다른 작업이 진행 중이라 아직 요약 단계로 전환할 수 없습니다.",
          );
          return;
        }

        const hasExistingSummaryDocument =
          finalSummaryDocument.markdown.trim() && (finalSummaryDocument.sections || []).length > 0;
        if (!hasExistingSummaryDocument) {
          await handleGenerateSolutionStage();
          return;
        }

        setStage("solution");
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId("");
        setSelectedNodeId("");
        setLeftPanelTab("detail");
        return;
      }

      if (nextStage !== "problem-definition") {
        setProblemStructureSetupOpen(false);
        setProblemStructurePending(false);
        setProblemStructureDrag(null);
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

      setProblemDefinitionMode("");
      setProblemDefinitionPhase("explore");
      setProblemStructureSetupOpen(false);
      setProblemStructurePending(false);
      setProblemStructureDrag(null);
      await handleGenerateProblemDefinition();
      setLeftPanelTab("detail");
      return;
    },
    [
      busy,
      conclusionBatchBusy,
      finalSummaryDocument.markdown,
      finalSummaryDocument.sections,
      flushProblemDiscussionBuffer,
      handleGenerateProblemDefinition,
      handleGenerateSolutionStage,
      solutionStagePending,
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
        ? ["group"]
        : ["note", "comment", "topic", "group"],
    [stage],
  );
  const problemCanvasToolbarActions: ProblemCanvasToolbarAction[] =
    problemDefinitionPhase === "structure"
      ? ["structure-back", "structure-ai-group", "structure-add-group", "structure-refresh"]
      : ["group", "problem-link", "debug-regenerate", "debug-refresh-chunks", "structure-start"];

  const problemToolbarActionLabel = (action: ProblemCanvasToolbarAction) => {
    if (action === "group") return "문제정의 그룹 추가";
    if (action === "problem-link") return "문제정의 그룹 연결";
    if (action === "debug-regenerate") return "디버그 재생성";
    if (action === "debug-refresh-chunks") return "요약 캐시 재생성";
    if (action === "structure-start") return "구조화 시작";
    if (action === "structure-back") return "정의 1단계";
    if (action === "structure-ai-group") return problemStructurePending ? "AI 묶는 중" : "AI 묶기";
    if (action === "structure-add-group") return "그룹 추가";
    if (action === "structure-refresh") return "다시 가져오기";
    if (action === "note") return "의견추가";
    if (action === "problem-idea") return "아이디어 추가";
    return "채택";
  };

  const isProblemToolbarActionActive = (action: ProblemCanvasToolbarAction) => {
    if (action === "debug-regenerate" || action === "debug-refresh-chunks") return problemDefinitionStagePending;
    if (action === "structure-start") return problemDefinitionPhase === "structure" || problemStructureSetupOpen;
    if (action === "structure-ai-group") return problemStructurePending;
    if (action === "problem-link") return Boolean(pendingProblemGroupLinkId);
    if (action === "adopt") return selectedProblemGroup?.status === "final";
    return armedCanvasTool === action;
  };

  const armCanvasTool = (tool: CanvasTool) => {
    if (!canUseCanvasToolbar || !visibleCanvasTools.includes(tool)) {
      setActivityMessage("현재 단계에서는 이 도구를 사용할 수 없습니다.");
      return;
    }
    setPendingProblemGroupLinkId("");
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

  useEffect(() => {
    if (stage !== "problem-definition") {
      setPendingProblemGroupLinkId("");
    }
  }, [stage]);

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
        const rightPaneRect = getReactFlowCanvasRect(ideationRightPaneRef.current);
        if (!pointInRect(clientX, clientY, rightPaneRect)) {
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
        const rightPaneRect = getReactFlowCanvasRect(ideationRightPaneRef.current);
        if (!pointInRect(clientX, clientY, rightPaneRect)) {
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
              problemStructure: problemStructureStatePayload,
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
              problemStructure: problemStructureStatePayload,
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
            problemStructure: problemStructureStatePayload,
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
      problemStructureStatePayload,
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
        const nextStagePositions = {
          ...(nextPositionsSnapshot["problem-definition"] || {}),
        };
        delete nextStagePositions[node.id];
        nextPositionsSnapshot = {
          ...nextPositionsSnapshot,
          "problem-definition": nextStagePositions,
        };
        setSelectedNodeId(node.id);
        setActivityMessage("의견 노드는 오른쪽 캔버스의 아이디어/맥락 카드 위에 놓을 때만 연결됩니다.");
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
            problemStructure: problemStructureStatePayload,
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
            problemStructure: problemStructureStatePayload,
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
    await flushProblemDiscussionBuffer("manual");
  };

  const getEndingSolutionTopicsSnapshot = () =>
    latestSharedWorkspaceRef.current.solutionTopics.length > 0
      ? latestSharedWorkspaceRef.current.solutionTopics
      : solutionTopics;

  const handleEndMeetingClick = async () => {
    await flushProblemDiscussionBuffer("stage-change");

    const endingSolutionTopics = getEndingSolutionTopicsSnapshot();
    const finalSolutionSummary = buildFinalSolutionSummaryPayload(
      endingSolutionTopics,
      latestSharedWorkspaceRef.current.finalSolutionSummary || finalSummaryDocument,
    );
    setEndMeetingPreview({
      finalCount: finalSolutionSummary.final_count,
      topicCount: finalSolutionSummary.sections?.length || finalSolutionSummary.topics.length,
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
      const finalSolutionSummary = buildFinalSolutionSummaryPayload(
        endingSolutionTopics,
        latestSharedWorkspaceRef.current.finalSolutionSummary || finalSummaryDocument,
      );
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
  const activeProblemGroupingRationale = problemGroupingRationaleOpenGroupId
    ? problemGroupingRationaleById[problemGroupingRationaleOpenGroupId] || null
    : null;
  const activeProblemGroupingRationaleGroup = problemGroupingRationaleOpenGroupId
    ? problemGroups.find((group) => group.group_id === problemGroupingRationaleOpenGroupId) || null
    : null;
  const rightDrawerShowsDetailPanel = false;
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
  const quickAskLauncherClassName = rightDrawerCollapsed
    ? "absolute bottom-4 left-1/2 z-50 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-[14px] border border-black/10 bg-[#111827] text-sm font-semibold text-white shadow-[0_10px_28px_rgba(15,23,42,0.22)] transition hover:bg-black"
    : "absolute bottom-4 left-4 right-4 z-50 flex min-h-[46px] items-center justify-between gap-3 rounded-[14px] border border-black/10 bg-[#111827] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(15,23,42,0.18)] transition hover:bg-black";
  const quickAskPanelClassName = rightDrawerCollapsed
    ? "absolute bottom-20 right-2 z-50 flex w-[min(26rem,calc(100vw-1.5rem))] max-h-[min(620px,72vh)] flex-col overflow-hidden rounded-[18px] border border-black/10 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]"
    : "absolute bottom-20 right-4 z-50 flex w-[min(28rem,calc(100vw-2rem))] max-h-[min(620px,72vh)] flex-col overflow-hidden rounded-[18px] border border-black/10 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]";
  const workspaceGridColumns = rightDrawerCollapsed
    ? "minmax(0, 1fr) clamp(3.5rem, 4.2vw, 4.5rem)"
    : `minmax(0, 1fr) ${rightDrawerExpandedWidth}`;
  const latestDiscussionRootItem = useMemo(() => {
    if (!latestHighlightedTopicId) return null;
    const latestItem = canvasItems.find((item) => item.id === latestHighlightedTopicId) || null;
    if (!latestItem) return null;
    const rootId = getCanvasItemTopLevelAncestorId(canvasItems, latestItem.id);
    return canvasItems.find((item) => item.id === rootId) || latestItem;
  }, [canvasItems, latestHighlightedTopicId]);
  const problemSplitEdges = useMemo(() => {
    if (stage !== "problem-definition" || problemDefinitionPhase === "structure") {
      return { left: [] as Edge[], right: [] as Edge[] };
    }

    const problemGroupIds = new Set(problemGroups.map((group) => group.group_id));
    const childGroupsByParentId = new Map<string, ProblemGroupViewModel[]>();
    problemGroups.forEach((group) => {
      const parentId = group.parent_group_id || "";
      childGroupsByParentId.set(parentId, [...(childGroupsByParentId.get(parentId) || []), group]);
    });
    const rootProblemGroupCandidates = problemGroups.filter(
      (group) => !group.parent_group_id || !problemGroupIds.has(group.parent_group_id),
    );
    const rootProblemGroups = rootProblemGroupCandidates.length > 0 ? rootProblemGroupCandidates : problemGroups;
    const visibleProblemGroupIds = new Set<string>();
    const visitVisible = (group: ProblemGroupViewModel, trail = new Set<string>()) => {
      if (trail.has(group.group_id)) return;
      const nextTrail = new Set(trail);
      nextTrail.add(group.group_id);
      visibleProblemGroupIds.add(group.group_id);
      if (!collapsedProblemGroupIds.has(group.group_id)) {
        (childGroupsByParentId.get(group.group_id) || []).forEach((child) => {
          visitVisible(child, nextTrail);
        });
      }
    };
    rootProblemGroups.forEach((group) => {
      visitVisible(group);
    });

    const hierarchyEdges = problemGroups
      .filter(
        (group) =>
          Boolean(group.parent_group_id) &&
          problemGroupIds.has(group.parent_group_id || "") &&
          visibleProblemGroupIds.has(group.group_id) &&
          visibleProblemGroupIds.has(group.parent_group_id || ""),
      )
      .map((group): Edge => ({
        id: `problem-parent-edge::${group.parent_group_id}::${group.group_id}`,
        source: `problem-${group.parent_group_id}`,
        target: `problem-${group.group_id}`,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#a3a3a3" },
        interactionWidth: 0,
        selectable: false,
        style: { stroke: "#a3a3a3", strokeOpacity: 0.62, strokeWidth: 1.6 },
      }));
    const groupLinkEdges = problemGroups.flatMap((group) =>
      (group.linked_group_ids || [])
        .filter(
          (linkedGroupId) =>
            linkedGroupId !== group.group_id &&
            problemGroupIds.has(linkedGroupId) &&
            visibleProblemGroupIds.has(group.group_id) &&
            visibleProblemGroupIds.has(linkedGroupId),
        )
        .map((linkedGroupId): Edge => ({
          id: `problem-group-link::${group.group_id}::${linkedGroupId}`,
          source: `problem-${group.group_id}`,
          target: `problem-${linkedGroupId}`,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#1b59f8" },
          interactionWidth: 0,
          selectable: false,
          style: { stroke: "#1b59f8", strokeOpacity: 0.58, strokeWidth: 2, strokeDasharray: "5 5" },
        })),
    );

    return {
      left: [...hierarchyEdges, ...groupLinkEdges],
      right: [] as Edge[],
    };
  }, [collapsedProblemGroupIds, problemDefinitionPhase, problemGroups, stage]);
  const canvasHeaderSpeechRows = useMemo(() => {
    const fallbackCurrent = sttProgressText || liveFlowHint || "현재 발언 흐름 대기 중";
    const rows = transcriptStripItems
      .map((item) => ({
        speaker: item.speaker || "STT",
        text: item.text || "발언 내용 없음",
        timestamp: item.timestamp || "",
      }))
      .filter((item) => item.text.trim().length > 0);
    const recentRows = rows.slice(-2);

    if (recentRows.length >= 2) {
      return recentRows;
    }

    if (recentRows.length === 1) {
      return [
        { speaker: "AI", text: "이전 발언 요약 대기 중", timestamp: "" },
        recentRows[0],
      ];
    }

    return [
      { speaker: "AI", text: "이전 발언 요약 대기 중", timestamp: "" },
      { speaker: "STT", text: fallbackCurrent, timestamp: "" },
    ];
  }, [liveFlowHint, sttProgressText, transcriptStripItems]);
  const canvasHeaderLeftTitle =
    stage === "ideation"
      ? "아이디어 흐름"
      : stage === "problem-definition"
        ? selectedProblemGroup?.topic || "문제 정의"
        : "최종 정리 문서";
  const canvasHeaderLeftSummary =
    stage === "ideation"
      ? "STT에서 자주 나온 단어가 크기와 근접도로 표시됩니다."
      : stage === "problem-definition"
        ? selectedProblemGroup?.insight_lens ||
          selectedProblemGroup?.conclusion ||
          "아이디어 단계에서 도출한 내용을 바탕으로 문제 정의를 정리합니다."
        : `검토 중/확정 구조화 그룹 ${summaryEligibleStructureGroups.length}개를 바탕으로 회의 흐름을 문서화합니다.`;
  const canvasHeaderGridClassName = `relative grid min-h-[clamp(86px,9.5vh,112px)] shrink-0 grid-cols-1 border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)] ${
    stage === "solution"
      ? "xl:grid-cols-[minmax(18rem,32%)_minmax(0,1fr)]"
      : "xl:grid-cols-[minmax(17rem,38%)_minmax(0,1fr)]"
  }`;
  const canvasHeaderCellClassName = "min-h-[clamp(86px,9.5vh,112px)] px-[clamp(18px,2.8vw,38px)] py-[clamp(12px,1.7vh,18px)]";
  const canvasFloatingStatusInactiveClassName =
    "border-black/10 bg-[#eff0f6] text-[#4d4d4d] hover:bg-[#e3e5ee]";
  const ideationDragGhostItem = useMemo(
    () =>
      ideationDragGhost
        ? canvasItems.find((item) => item.id === ideationDragGhost.itemId) || null
        : null,
    [canvasItems, ideationDragGhost],
  );

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

  const handleCreateProblemGroupLink = (sourceGroupId: string, targetGroupId: string) => {
    if (!sourceGroupId || !targetGroupId) return false;
    if (sourceGroupId === targetGroupId) {
      setPendingProblemGroupLinkId("");
      setActivityMessage("같은 문제정의 그룹에는 연결할 수 없습니다.");
      return true;
    }

    const sourceGroup = problemGroups.find((group) => group.group_id === sourceGroupId);
    const targetGroup = problemGroups.find((group) => group.group_id === targetGroupId);
    if (!sourceGroup || !targetGroup) {
      setPendingProblemGroupLinkId("");
      setActivityMessage("연결할 문제정의 그룹을 찾지 못했습니다.");
      return true;
    }

    if ((sourceGroup.linked_group_ids || []).includes(targetGroupId)) {
      setSelectedProblemGroupId(targetGroupId);
      setPendingProblemGroupLinkId("");
      setActivityMessage("이미 연결된 문제정의 그룹입니다.");
      return true;
    }

    const nextProblemGroups = problemGroups.map((group) =>
      group.group_id === sourceGroupId
        ? {
            ...group,
            linked_group_ids: [...new Set([...(group.linked_group_ids || []), targetGroupId])],
          }
        : group,
    );

    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      stage,
      problemGroups: nextProblemGroups,
      importedState: persistedSharedImportedState,
    };
    setProblemGroups(nextProblemGroups);
    setSelectedProblemGroupId(targetGroupId);
    setSelectedProblemSourceNodeId("");
    setSelectedSolutionTopicId("");
    setSelectedCanvasItemId("");
    setPendingProblemGroupLinkId("");
    setActivityMessage(`"${sourceGroup.topic}"와 "${targetGroup.topic}" 문제정의 그룹을 연결했습니다.`);

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
            problemGroups: nextProblemGroups,
            problemStructure: problemStructureStatePayload,
            solutionTopics,
            nodePositions,
            importedState: persistedSharedImportedState,
          }),
        );
      }
      forceBroadcastSharedCanvas({
        problemGroups: nextProblemGroups,
      });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          problem_groups: serializeSharedProblemGroups(nextProblemGroups),
          imported_state: persistedSharedImportedState,
        }).catch((error) => {
          console.error("Failed to save problem group link:", error);
        });
      }
    }

    return true;
  };

  const handleCanvasNodeClick = (event: React.MouseEvent, node: Node) => {
    setSelectedEdgeId("");
    setSelectedNodeId(node.id);
    setLeftPanelTab("detail");
    if (stage !== "problem-definition") {
      openRightDrawer();
    }
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
    if (stage === "problem-definition" && problemDefinitionPhase === "structure") {
      setSelectedProblemGroupId("");
      setSelectedProblemSourceNodeId("");
      setSelectedSolutionTopicId("");
      setEditingProblemGroupId("");
      setEditingSolutionTopicId("");
      return;
    }
    const problemSourceInfo = extractProblemSourceCanvasNodeInfo(node.id);
    const clickedProblemGroupId =
      node.id.startsWith("problem-") && !node.id.startsWith("problem-discussion-")
        ? node.id.slice("problem-".length)
        : "";
    if (pendingProblemGroupLinkId && clickedProblemGroupId) {
      handleCreateProblemGroupLink(pendingProblemGroupLinkId, clickedProblemGroupId);
      return;
    }
    if (problemSourceInfo) {
      setSelectedProblemGroupId(problemSourceInfo.groupId);
      setSelectedProblemSourceNodeId(problemSourceInfo.sourceNodeId);
      setSelectedSolutionTopicId("");
      setSelectedCanvasItemId("");
      setEditingProblemGroupId("");
    } else if (node.id.startsWith("problem-discussion-")) {
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
    } else if (clickedProblemGroupId) {
      setSelectedProblemGroupId(clickedProblemGroupId);
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
    pane: "default" | "ideation-left" | "ideation-right" | "problem-left" | "problem-right" = "default",
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

  const handleProblemToolbarAction = (action: ProblemCanvasToolbarAction) => {
    if (action === "debug-regenerate") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setPendingProblemGroupLinkId("");
      void handleDebugRegenerateProblemDefinition();
      return;
    }

    if (action === "debug-refresh-chunks") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setPendingProblemGroupLinkId("");
      void handleRefreshProblemChunkSummaries();
      return;
    }

    if (action === "structure-start") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setPendingProblemGroupLinkId("");
      handleOpenProblemStructureSetup();
      return;
    }

    if (action === "structure-back") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setPendingProblemGroupLinkId("");
      handleBackToProblemDefinitionExplore();
      return;
    }

    if (action === "structure-ai-group") {
      void runProblemStructureGrouping();
      return;
    }

    if (action === "structure-add-group") {
      handleAddProblemStructureGroup();
      return;
    }

    if (action === "structure-refresh") {
      handleRefreshProblemStructureNodes();
      return;
    }

    if (action === "problem-link") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      if (pendingProblemGroupLinkId) {
        setPendingProblemGroupLinkId("");
        setActivityMessage("문제정의 그룹 연결을 취소했습니다.");
        return;
      }
      if (!selectedProblemGroup) {
        setActivityMessage("먼저 왼쪽 캔버스에서 연결을 시작할 문제정의 그룹을 선택해 주세요.");
        return;
      }
      setPendingProblemGroupLinkId(selectedProblemGroup.group_id);
      setActivityMessage("연결할 다른 문제정의 그룹을 왼쪽 캔버스에서 클릭해 주세요.");
      return;
    }

    if (action === "adopt") {
      setArmedCanvasTool(null);
      setCanvasPlacementPreview(null);
      setPendingProblemGroupLinkId("");
      if (!selectedProblemGroup) {
        setActivityMessage("채택할 문제정의 그룹을 먼저 선택해 주세요.");
        return;
      }
      handleSetProblemGroupStatus("final");
      return;
    }

    armCanvasTool(action);
  };

  const renderCanvasFloatingStatusControls = () => {
    const buttonClassName = (active: boolean, activeTone: string) =>
      `rounded-[8px] border px-3 py-1.5 text-xs font-semibold leading-none transition ${
        active ? activeTone : canvasFloatingStatusInactiveClassName
      }`;
    const positionClassName = stage === "solution" ? "left-1/2 xl:left-[68%]" : "left-1/2 xl:left-[69%]";

    if (stage === "ideation") return null;

    if (stage === "problem-definition" && selectedProblemGroup) {
      return (
        <div className={`pointer-events-none absolute top-[clamp(0.75rem,1.5vh,1rem)] z-[12] -translate-x-1/2 ${positionClassName}`}>
          <div className="pointer-events-auto flex items-center justify-center gap-1 rounded-[12px] border border-black/10 bg-white/95 p-1 shadow-[0_5.64px_22.56px_rgba(0,0,0,0.08)] backdrop-blur">
            {(["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => {
              const active = selectedProblemGroup.status === status;
              return (
                <button
                  key={`canvas-floating-problem-status-${status}`}
                  type="button"
                  onClick={() => handleSetProblemGroupStatus(status)}
                  className={buttonClassName(active, problemGroupStatusTone(status))}
                >
                  {problemGroupStatusLabel(status)}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    if (stage === "solution" && selectedSolutionTopic) {
      return (
        <div className={`pointer-events-none absolute top-[clamp(0.75rem,1.5vh,1rem)] z-[12] -translate-x-1/2 ${positionClassName}`}>
          <div className="pointer-events-auto flex items-center justify-center gap-1 rounded-[12px] border border-black/10 bg-white/95 p-1 shadow-[0_5.64px_22.56px_rgba(0,0,0,0.08)] backdrop-blur">
            {(["draft", "review", "final"] as ProblemGroupStatus[]).map((status) => {
              const active = selectedSolutionTopic.status === status;
              return (
                <button
                  key={`canvas-floating-solution-status-${status}`}
                  type="button"
                  onClick={() => handleSetSolutionTopicStatus(status)}
                  className={buttonClassName(active, problemGroupStatusTone(status))}
                >
                  {problemGroupStatusLabel(status)}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    return null;
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
                STT {transcripts.length}개
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
                        setFinalSummaryDocument(createEmptyFinalSolutionSummary());
                        setSummaryDocumentEditMode(false);
                        setSummaryEvidenceOpenGroupIds(new Set());
                        setNodePositions({});
                        setStage("ideation");
                        setProblemDefinitionMode("");
                        setProblemDefinitionPhase("explore");
                        setProblemStructureSetupOpen(false);
                        setProblemStructureNodes([]);
                        setProblemStructureGroups([]);
                        setProblemStructurePending(false);
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
                            finalSolutionSummary: createEmptyFinalSolutionSummary(),
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
                            final_solution_summary: buildFinalSolutionSummaryPayload([], createEmptyFinalSolutionSummary()),
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
            <div className={canvasHeaderGridClassName}>
              <div className={`${canvasHeaderCellClassName} flex items-center border-b border-black/10 xl:border-b-0 xl:border-r`}>
                <div className="flex w-full min-w-0 items-start justify-between gap-[clamp(12px,1.5vw,20px)]">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]/80">
                      {stage === "solution" ? "Summary" : stage === "problem-definition" ? "Problem" : "Idea"}
                    </p>
                    <h3 className="mt-1 truncate text-[clamp(15px,1.15vw,18px)] font-semibold leading-[24.811px] text-black">
                      {canvasHeaderLeftTitle}
                    </h3>
                    <p className="mt-1 line-clamp-2 max-w-[min(30rem,100%)] text-[clamp(12px,0.9vw,15px)] font-normal leading-[1.55] text-[#4d4d4d]">
                      {canvasHeaderLeftSummary}
                    </p>
                  </div>
                  <div className="mt-1 flex shrink-0 items-center gap-2">
                    {stage === "ideation" && selectedAgenda ? (
                      <>
                        {isEditingSelectedAgenda ? (
                          <>
                            <button
                              type="button"
                              onClick={handleCancelAgendaEdit}
                              className="rounded-[8px] bg-[#eff0f6] px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee]"
                            >
                              취소
                            </button>
                            <button
                              type="button"
                              onClick={handleSaveAgendaEdit}
                              className="rounded-[8px] bg-[#1b59f8] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#164be0]"
                            >
                              저장
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              openRightDrawer();
                              handleStartAgendaEdit();
                            }}
                            className="rounded-[8px] bg-[#e9efff] px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#dfe8ff]"
                          >
                            수정
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className={`${canvasHeaderCellClassName} relative flex flex-col items-center justify-center text-center`}>
                <div className="pointer-events-none absolute right-4 top-3 z-10 flex max-w-[calc(100%-2rem)] flex-wrap justify-end gap-2">
                  {ideaAssimilationStatus ? (
                    <span className="rounded-full border border-black/10 bg-[#f9f9f9]/95 px-2.5 py-1 text-[11px] font-medium text-[#777]">
                      {ideaAssimilationStatus}
                    </span>
                  ) : null}
                  {problemDiscussionStatus ? (
                    <span className="rounded-full border border-violet-100 bg-violet-50/95 px-2.5 py-1 text-[11px] font-medium text-violet-700">
                      {problemDiscussionStatus}
                    </span>
                  ) : null}
                </div>
                <div className="w-full max-w-[min(46rem,92%)] pt-[clamp(0.35rem,0.8vh,0.7rem)]">
                  <p className="line-clamp-1 text-[clamp(12px,0.9vw,15px)] font-normal leading-[24.811px] text-[#4d4d4d]">
                    {canvasHeaderSpeechRows[0]?.text || "이전 발언 요약 대기 중"}
                  </p>
                  <p className="mt-1 line-clamp-1 text-[clamp(14px,1.02vw,16px)] font-normal leading-[24.811px] text-black">
                    {canvasHeaderSpeechRows[1]?.text || sttProgressText || liveFlowHint || "현재 발언 흐름 대기 중"}
                  </p>
                </div>
              </div>
            </div>
            <div
              className="relative min-h-0 w-full flex-1"
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
              {renderCanvasFloatingStatusControls()}
              {stage === "ideation" || stage === "problem-definition" ? (
                <ReactFlow<Node, Edge>
                  nodes={nodes}
                  edges={stage === "problem-definition" ? problemSplitEdges.left : ([] as Edge[])}
                  onInit={(instance) => {
                    flowRef.current = instance;
                  }}
                  onNodeClick={handleCanvasNodeClick}
                  onPaneClick={handleCanvasPaneClick}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDrag={onNodeDrag}
                  onNodeDragStop={onNodeDragStop}
                  nodesConnectable={false}
                  panOnDrag={!problemIdeaDrag}
                  autoPanOnNodeDrag={false}
                  noPanClassName="nopan"
                  nodesDraggable={stage === "problem-definition"}
                  minZoom={0.45}
                  maxZoom={1.6}
                  proOptions={{ hideAttribution: true }}
                >
                  {stage === "problem-definition" ? (
                    <Background
                      id="problem-definition-grid"
                      bgColor="#f5f6f8"
                      color="#d7dce5"
                      gap={28}
                      size={1}
                      variant={BackgroundVariant.Dots}
                    />
                  ) : null}
                  <MiniMap
                    zoomable
                    pannable
                    maskColor="rgba(15, 23, 42, 0.08)"
                    nodeColor={stage === "problem-definition" ? "#1b59f8" : "#0f766e"}
                  />
                  <Controls />
                </ReactFlow>
              ) : stage === "solution" ? (
                <div className="grid h-full min-h-0 grid-cols-1 bg-[#f5f6f8] xl:grid-cols-[minmax(18rem,32%)_minmax(0,1fr)]">
                  <aside className="flex min-h-[280px] flex-col overflow-hidden border-b border-black/10 bg-white xl:border-b-0 xl:border-r">
                    <div className="border-b border-black/10 px-5 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">Summary Source</p>
                      <h4 className="mt-1 text-lg font-semibold text-black">구조화 결과</h4>
                      <p className="mt-1 text-sm leading-6 text-[#4d4d4d]">
                        검토 중/확정 그룹 {summaryEligibleStructureGroups.length}개가 요약 문서에 포함됩니다.
                      </p>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                      {summaryEligibleStructureGroups.length > 0 ? (
                        <div className="space-y-3">
                          {summaryEligibleStructureGroups.map((group, index) => {
                            const section = summaryDocumentSectionByGroupId.get(group.id);
                            const evidenceOpen = summaryEvidenceOpenGroupIds.has(group.id);
                            const groupNodes = group.nodeIds
                              .map((nodeId) => problemStructureNodes.find((node) => node.id === nodeId))
                              .filter((node): node is ProblemStructureNodeViewModel => Boolean(node));
                            return (
                              <div key={`summary-source-${group.id}`} className="border border-black/10 bg-white p-4">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold text-[#777]">#{index + 1}</p>
                                    <h5 className="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-black">
                                      {group.title}
                                    </h5>
                                  </div>
                                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                    group.status === "final" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                                  }`}>
                                    {problemStructureStatusLabel(group.status)}
                                  </span>
                                </div>
                                {groupNodes.length > 0 ? (
                                  <div className="mt-3 space-y-1.5">
                                    {groupNodes.slice(0, 4).map((node) => (
                                      <p key={`summary-node-${group.id}-${node.id}`} className="line-clamp-2 bg-[#f5f6f8] px-3 py-2 text-xs leading-5 text-[#4d4d4d]">
                                        {node.title}
                                      </p>
                                    ))}
                                    {groupNodes.length > 4 ? (
                                      <p className="px-1 text-[11px] font-medium text-[#777]">+ {groupNodes.length - 4}개 더 있음</p>
                                    ) : null}
                                  </div>
                                ) : null}
                                {section && section.evidence.length > 0 ? (
                                  <div className="mt-3 border-t border-black/10 pt-3">
                                    <button
                                      type="button"
                                      onClick={() => handleToggleSummaryEvidence(group.id)}
                                      className="text-xs font-semibold text-[#1b59f8] transition hover:text-[#164be0]"
                                    >
                                      근거 발언 {evidenceOpen ? "접기" : "보기"} ({section.evidence.length})
                                    </button>
                                    {evidenceOpen ? (
                                      <div className="mt-2 space-y-2">
                                        {section.evidence.map((item, evidenceIndex) => (
                                          <p key={`summary-evidence-${group.id}-${item.utterance_id || evidenceIndex}`} className="bg-[#eef4ff] px-3 py-2 text-xs leading-5 text-[#334155]">
                                            <span className="font-semibold text-[#1b59f8]">{item.speaker}</span>
                                            {item.timestamp ? <span className="ml-2 text-[#777]">{item.timestamp}</span> : null}
                                            <span className="mt-1 block">{item.text}</span>
                                          </p>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="border border-dashed border-black/10 bg-[#fafafa] px-4 py-5 text-sm leading-6 text-[#777]">
                          정의 2단계에서 그룹을 검토 중 또는 확정 상태로 바꾸면 요약 문서에 포함됩니다.
                        </div>
                      )}
                    </div>
                  </aside>

                  <section ref={solutionRightPaneRef} className="flex min-h-[420px] flex-col overflow-hidden bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-5 py-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">Final Document</p>
                        <h4 className="mt-1 text-lg font-semibold text-black">최종 정리 문서</h4>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {finalSummaryDocument.used_llm ? (
                          <span className="rounded-full bg-[#eef4ff] px-3 py-1 text-xs font-semibold text-[#1b59f8]">AI 초안</span>
                        ) : null}
                        {finalSummaryDocument.document_status === "edited" ? (
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">사용자 수정됨</span>
                        ) : null}
                        <div className="flex overflow-hidden rounded-[8px] border border-black/10 bg-[#f5f6f8]">
                          <button
                            type="button"
                            onClick={() => setSummaryDocumentEditMode(false)}
                            disabled={!finalSummaryDocument.markdown.trim()}
                            className={`px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              !summaryDocumentEditMode ? "bg-white text-[#1b59f8]" : "text-[#4d4d4d] hover:bg-white/70"
                            }`}
                          >
                            보기
                          </button>
                          <button
                            type="button"
                            onClick={() => setSummaryDocumentEditMode(true)}
                            className={`border-l border-black/10 px-3 py-1.5 text-xs font-semibold transition ${
                              summaryDocumentEditMode ? "bg-white text-[#1b59f8]" : "text-[#4d4d4d] hover:bg-white/70"
                            }`}
                          >
                            편집
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRegenerateSummaryDocument()}
                          disabled={solutionStagePending || summaryEligibleStructureGroups.length === 0}
                          className="rounded-[8px] border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#f5f6f8] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          다시 생성
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopyFinalSolutionMarkdown()}
                          disabled={!finalSummaryDocument.markdown.trim()}
                          className="rounded-[8px] bg-[#1b59f8] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#164be0] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          복사
                        </button>
                      </div>
                    </div>
                    {finalSummaryDocument.warning ? (
                      <div className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-xs leading-5 text-amber-700">
                        {finalSummaryDocument.warning}
                      </div>
                    ) : null}
                    <div className="min-h-0 flex-1 overflow-hidden bg-[#f5f6f8] p-5">
                      {summaryDocumentEditMode || !finalSummaryDocument.markdown.trim() ? (
                        <textarea
                          value={finalSummaryDocument.markdown}
                          onChange={(event) => handleSummaryDocumentMarkdownChange(event.target.value)}
                          placeholder={
                            solutionStagePending
                              ? "AI가 요약 문서를 생성하는 중입니다."
                              : "요약 단계로 들어오면 구조화 그룹을 기준으로 문서 초안이 자동 생성됩니다."
                          }
                          className="h-full min-h-[360px] w-full resize-none border border-black/10 bg-white px-6 py-5 font-mono text-sm leading-7 text-[#1f2937] outline-none transition placeholder:font-sans placeholder:text-[#999] focus:border-[#1b59f8]/30 focus:ring-2 focus:ring-[#1b59f8]/10"
                        />
                      ) : (
                        renderSummaryMarkdownPreview(finalSummaryDocument.markdown, () => setSummaryDocumentEditMode(true))
                      )}
                    </div>
                  </section>
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

            {stage === "solution" && !finalSummaryDocument.markdown.trim() && !solutionStagePending ? (
              <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
                <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-lg shadow-slate-200/70">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">Summary Stage</p>
                  <p className="mt-2 text-base text-slate-700">
                    {summaryEligibleStructureGroups.length > 0
                      ? "요약 문서를 준비하는 중입니다."
                      : "검토 중 또는 확정된 구조화 그룹이 있어야 요약 문서를 만들 수 있습니다."}
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
                    아이디어 단계의 STT 발화를 바탕으로 큰 분류를 만드는 중입니다.
                  </p>
                </div>
              </div>
            ) : null}

            {stage === "problem-definition" && !problemDefinitionStagePending && problemStructureSetupOpen ? (
              <div className="absolute inset-0 z-[7] flex items-center justify-center bg-white/82 px-4 backdrop-blur-[2px]">
                <div className="w-[min(820px,94%)] rounded-[20px] border border-black/10 bg-white p-6 shadow-[0_24px_60px_rgba(15,23,42,0.14)]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">Problem Structure</p>
                      <h3 className="mt-2 text-2xl font-semibold text-black">정의 2단계 시작 설정</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setProblemStructureSetupOpen(false)}
                      className="shrink-0 rounded-[8px] border border-black/10 bg-[#f9f9f9] px-3 py-2 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#eef4ff] hover:text-[#1b59f8]"
                    >
                      닫기
                    </button>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="text-sm font-semibold text-black">구조화 방식</p>
                      <div className="mt-3 grid gap-3">
                        {(["affinity", "card-sorting"] as ProblemStructureMethod[]).map((method) => {
                          const active = problemStructureDraftMethod === method;
                          return (
                            <button
                              key={method}
                              type="button"
                              onClick={() => setProblemStructureDraftMethod(method)}
                              className={`rounded-[14px] border px-5 py-4 text-left transition ${
                                active
                                  ? "border-[#1b59f8]/30 bg-[#eef4ff] text-[#1b59f8]"
                                  : "border-black/10 bg-[#f9f9f9] text-[#333] hover:border-[#1b59f8]/30 hover:bg-[#eef4ff]"
                              }`}
                            >
                              <span className="text-base font-semibold">{problemStructureMethodLabel(method)}</span>
                              <span className="mt-1 block text-sm leading-6 text-[#4d4d4d]">
                                {method === "affinity"
                                  ? "비슷한 의미의 노드를 자유로운 그룹으로 묶습니다."
                                  : "그룹 컬럼 위에 설명 카드를 두고 노드를 분류합니다."}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-black">시작 방식</p>
                      <div className="mt-3 grid gap-3">
                        {(["ai", "manual"] as Exclude<ProblemDefinitionMode, "">[]).map((mode) => {
                          const active = problemStructureDraftMode === mode;
                          return (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setProblemStructureDraftMode(mode)}
                              className={`rounded-[14px] border px-5 py-4 text-left transition ${
                                active
                                  ? "border-[#1b59f8]/30 bg-[#eef4ff] text-[#1b59f8]"
                                  : "border-black/10 bg-[#f9f9f9] text-[#333] hover:border-[#1b59f8]/30 hover:bg-[#eef4ff]"
                              }`}
                            >
                              <span className="text-base font-semibold">
                                {mode === "ai" ? "AI가 초안을 만들기" : "직접 구성하기"}
                              </span>
                              <span className="mt-1 block text-sm leading-6 text-[#4d4d4d]">
                                {mode === "ai"
                                  ? "AI가 현재 노드들을 먼저 묶고, 사용자가 이후에 수정합니다."
                                  : "사용자가 그룹을 만들고 노드를 옮기며 구조화합니다."}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-black/10 pt-4">
                    <p className="text-sm leading-6 text-[#4d4d4d]">
                      정의 1단계 캔버스의 현재 노드 {problemGroups.length}개를 모두 가져옵니다.
                    </p>
                    <button
                      type="button"
                      onClick={handleStartProblemStructure}
                      disabled={problemStructurePending}
                      className="rounded-[10px] bg-[#1b59f8] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#164be0] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {problemStructurePending ? "AI 묶는 중" : "정의 2단계로 이동"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {stage === "problem-definition" && problemDefinitionPhase === "structure" && !problemDefinitionStagePending ? (
              <div className="pointer-events-none absolute left-4 top-4 z-[8] w-[min(38rem,calc(100%-2rem))]">
                <div className="pointer-events-auto rounded-[16px] border border-black/10 bg-white/95 p-3 shadow-[0_14px_38px_rgba(15,23,42,0.12)] backdrop-blur">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-[12rem] flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">
                        정의 2단계
                      </p>
                      <p className="mt-1 text-sm font-semibold text-black">
                        {problemStructureMethodLabel(problemStructureMethod)} · {problemDefinitionModeLabel(problemDefinitionMode)}
                      </p>
                      {problemStructurePending ? (
                        <p className="mt-1 text-xs font-medium text-[#1b59f8]">AI가 구조화 그룹을 생성하는 중입니다.</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(["affinity", "card-sorting"] as ProblemStructureMethod[]).map((method) => {
                        const active = problemStructureMethod === method;
                        return (
                          <button
                            key={`structure-method-${method}`}
                            type="button"
                            disabled={problemStructurePending}
                            onClick={() => {
                              setProblemStructureMethod(method);
                              setActivityMessage(`${problemStructureMethodLabel(method)} 방식으로 시각 표현을 바꿨습니다. 기존 그룹은 유지됩니다.`);
                            }}
                            className={`rounded-[9px] px-3 py-1.5 text-xs font-semibold transition ${
                              active ? "bg-[#1b59f8] text-white" : "bg-[#f5f6f8] text-[#4d4d4d] hover:bg-[#eef4ff] hover:text-[#1b59f8]"
                            } disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            {problemStructureMethodLabel(method)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(["ai", "manual"] as Exclude<ProblemDefinitionMode, "">[]).map((mode) => {
                        const active = problemDefinitionMode === mode;
                        return (
                          <button
                            key={`structure-mode-${mode}`}
                            type="button"
                            disabled={problemStructurePending}
                            onClick={() => {
                              setProblemDefinitionMode(mode);
                              if (mode === "ai") {
                                void runProblemStructureGrouping();
                                return;
                              }
                              setActivityMessage(
                                "직접 구성 모드로 표시했습니다.",
                              );
                            }}
                            className={`rounded-[9px] px-3 py-1.5 text-xs font-semibold transition ${
                              active ? "bg-black text-white" : "bg-[#f5f6f8] text-[#4d4d4d] hover:bg-black/5 hover:text-black"
                            } disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            {problemDefinitionModeLabel(mode)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {stage === "problem-definition" && problemDefinitionPhase !== "structure" && activeProblemGroupingRationale && activeProblemGroupingRationaleGroup ? (
              <div className="absolute right-4 top-4 z-[8] w-[min(26rem,calc(100%-2rem))] rounded-[16px] border border-black/10 bg-white/95 p-4 text-left shadow-[0_18px_46px_rgba(15,23,42,0.14)] backdrop-blur">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">Grouping Rationale</p>
                    <h4 className="mt-1 line-clamp-2 text-[17px] font-semibold leading-6 text-black">
                      {activeProblemGroupingRationaleGroup.topic || "문제정의 그룹"}
                    </h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProblemGroupingRationaleOpenGroupId("")}
                    className="shrink-0 rounded-[8px] border border-black/10 bg-[#f9f9f9] px-2.5 py-1.5 text-xs font-semibold text-[#4d4d4d] transition hover:bg-[#eef4ff] hover:text-[#1b59f8]"
                  >
                    닫기
                  </button>
                </div>
                <p className="mt-3 text-sm leading-6 text-[#333]">
                  {activeProblemGroupingRationale.rationale}
                </p>
                {activeProblemGroupingRationale.basisItems.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {activeProblemGroupingRationale.basisItems.map((item, index) => (
                      <p key={`${activeProblemGroupingRationale.groupId}-basis-${index}`} className="rounded-[10px] bg-[#f5f6f8] px-3 py-2 text-xs leading-5 text-[#4d4d4d]">
                        {item}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-medium text-[#777]">
                  <span className="rounded-full bg-[#eef4ff] px-2.5 py-1 text-[#1b59f8]">
                    {activeProblemGroupingRationale.usedLlm ? "AI 추정" : "로컬 추정"}
                  </span>
                  {activeProblemGroupingRationale.warning ? (
                    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">
                      {activeProblemGroupingRationale.warning}
                    </span>
                  ) : null}
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
                    Summary Stage
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold text-slate-900">
                    요약 문서를 생성하고 있습니다
                  </h3>
                  <p className="mt-3 text-base leading-7 text-slate-500">
                    구조화 단계의 검토 중/확정 그룹과 회의 흐름을 바탕으로 문서 초안을 작성하는 중입니다.
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

            {stage === "problem-definition" ? (
              <>
                <div className="pointer-events-none absolute inset-x-0 bottom-[clamp(16px,3vh,32px)] z-10 flex justify-center px-3">
                  <div className="pointer-events-auto flex min-h-[clamp(48px,6.4vh,56px)] w-auto max-w-[min(860px,calc(100vw-24px))] flex-wrap items-center justify-center gap-2 rounded-[16px] border border-black/10 bg-white px-[clamp(10px,1.2vw,12px)] py-2 text-[#4d4d4d] shadow-[0_5.64px_22.56px_rgba(0,0,0,0.05)]">
                    {problemCanvasToolbarActions.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => handleProblemToolbarAction(item)}
                        disabled={
                          !canUseCanvasToolbar ||
                          problemDefinitionStagePending ||
                          ((item === "debug-regenerate" || item === "debug-refresh-chunks") && busy) ||
                          (item === "structure-start" && problemGroups.length === 0) ||
                          (item === "structure-ai-group" &&
                            (problemStructurePending || (problemStructureNodes.length === 0 && problemGroups.length === 0))) ||
                          ((item === "structure-add-group" || item === "structure-refresh") && problemDefinitionPhase !== "structure") ||
                          (item === "problem-link" && !selectedProblemGroup && !pendingProblemGroupLinkId)
                        }
                        className={`flex h-[clamp(34px,4vh,38px)] min-w-[clamp(110px,10vw,150px)] shrink-0 items-center justify-center rounded-[12px] px-[clamp(10px,1vw,14px)] text-[clamp(12px,0.92vw,14px)] font-medium transition-all duration-150 ease-out ${
                          isProblemToolbarActionActive(item)
                            ? "bg-[#1b59f8]/10 text-[#1b59f8]"
                            : "text-[#4d4d4d] hover:bg-black/5"
                        } disabled:cursor-not-allowed disabled:opacity-45`}
                      >
                        <span>{problemToolbarActionLabel(item)}</span>
                      </button>
                    ))}
                    {armedCanvasTool || pendingProblemGroupLinkId ? (
                      <span className="hidden shrink-0 rounded-full bg-[#eff0f6] px-3 py-1.5 text-xs font-semibold text-[#4d4d4d] sm:inline-flex">
                        클릭 대기
                      </span>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
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
            )}
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
            {quickAskOpen ? (
              <div className={quickAskPanelClassName}>
                <div className="flex items-start justify-between gap-4 border-b border-black/10 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#1b59f8]">LLM Search</p>
                    <h4 className="mt-1 text-base font-semibold leading-tight text-black">LLM 및 검색</h4>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuickAskOpen(false)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eff0f6] text-lg leading-none text-[#4d4d4d] transition hover:bg-[#e3e5ee]"
                    aria-label="LLM 및 검색 닫기"
                  >
                    ×
                  </button>
                </div>
                <div ref={quickAskScrollRef} className="imms-overlay-scroll flex-1 space-y-3 overflow-y-auto bg-[#f7f8fb] px-4 py-4">
                  {quickAskMessages.length === 0 ? (
                    <div className="rounded-[14px] border border-dashed border-black/10 bg-white px-4 py-5 text-sm leading-6 text-[#6f6f6f]">
                      아직 질문이 없습니다.
                    </div>
                  ) : (
                    quickAskMessages.map((message) => (
                      <div
                        key={message.id}
                        className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[86%] rounded-[14px] px-3.5 py-3 text-sm leading-6 shadow-sm ${
                            message.role === "user"
                              ? "bg-[#1b59f8] text-white"
                              : message.status === "error"
                              ? "border border-red-100 bg-red-50 text-red-700"
                              : "border border-black/10 bg-white text-[#2f3440]"
                          }`}
                        >
                          <div className="whitespace-pre-wrap">{message.text}</div>
                          <div
                            className={`mt-2 flex items-center gap-2 text-[11px] ${
                              message.role === "user" ? "text-white/70" : "text-[#8b8f9a]"
                            }`}
                          >
                            <span>{message.createdAt}</span>
                            {message.status === "pending" ? <span>처리 중</span> : null}
                            {message.warning && message.status === "done" ? <span>주의 있음</span> : null}
                          </div>
                          {message.warning && message.status === "done" ? (
                            <p className="mt-2 rounded-[10px] bg-[#fff8e8] px-2.5 py-2 text-xs leading-5 text-[#8a6516]">
                              {message.warning}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <form onSubmit={handleSubmitQuickAsk} className="border-t border-black/10 bg-white p-3">
                  <textarea
                    value={quickAskDraft}
                    onChange={(event) => setQuickAskDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSubmitQuickAsk();
                      }
                    }}
                    placeholder="질문 입력"
                    className="min-h-[78px] w-full resize-none rounded-[12px] border border-black/10 bg-[#f9f9f9] px-3.5 py-3 text-sm leading-6 text-black outline-none transition placeholder:text-black/30 focus:border-[#1b59f8]/30 focus:bg-white focus:ring-2 focus:ring-[#1b59f8]/10"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-[#8b8f9a]">
                      {quickAskPendingCount > 0 ? `${quickAskPendingCount}개 응답 대기 중` : "LLM 응답"}
                    </span>
                    <button
                      type="submit"
                      disabled={!quickAskDraft.trim()}
                      className="rounded-[10px] bg-[#1b59f8] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#164be0] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      보내기
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
            <button
              type="button"
              onClick={handleToggleQuickAsk}
              className={quickAskLauncherClassName}
              title="LLM 및 검색"
            >
              {rightDrawerCollapsed ? (
                <span className="relative">
                  AI
                  {quickAskUnreadCount > 0 || quickAskPendingCount > 0 ? (
                    <span className="absolute -right-2 -top-2 h-2.5 w-2.5 rounded-full bg-[#ffd166]" />
                  ) : null}
                </span>
              ) : (
                <>
                  <span>LLM 및 검색</span>
                  <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white/85">
                    {quickAskPendingCount > 0
                      ? `${quickAskPendingCount}개 처리 중`
                      : quickAskUnreadCount > 0
                      ? `새 응답 ${quickAskUnreadCount}`
                      : "바로 질문"}
                  </span>
                </>
              )}
            </button>
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
