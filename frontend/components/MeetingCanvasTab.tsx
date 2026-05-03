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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCanvasWorkspaceState,
  getCanvasPersonalNotes,
  assimilateCanvasIdeas,
  confirmCanvasPlacement,
  generateMeetingGoal,
  generateProblemGroupConclusion,
  generateCanvasProblemDefinition,
  generateCanvasSolutionStage,
  flushCanvasPersonalNotes,
  flushCanvasWorkspacePatch,
  importAgendaSnapshot,
  saveCanvasPersonalNotes,
  saveCanvasWorkspacePatch,
} from "@/lib/api";
import type {
  AgendaActionItemDetail,
  AgendaDecisionDetail,
  CanvasCustomGroup,
  CanvasIdeaAssimilationIdea,
  CanvasIdeaAssimilationUpdate,
  CanvasLocalState,
  CanvasNodePositionsByStage,
  CanvasProblemDefinitionGroup,
  CanvasRealtimeSyncPayload,
  CanvasRefinedUtterance,
  CanvasSolutionTopicResponse,
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
};

export type MeetingAgenda = {
  id: string;
  title: string;
  status: string;
};

type CanvasStage = "ideation" | "problem-definition" | "solution";
type ComposerTool = "note" | "comment" | "topic";
type CanvasTool = ComposerTool | "group";
type LeftPanelTab = "detail" | "agenda-list";
type ProblemGroupStatus = "draft" | "review" | "final";
type SolutionAiSuggestionStatus = "draft" | "selected" | "dismissed";
type SolutionNoteSource = "ai" | "user";
const CANVAS_STAGES: CanvasStage[] = ["ideation", "problem-definition", "solution"];

type PersonalNote = {
  id: string;
  agendaId: string;
  kind: ComposerTool;
  title: string;
  body: string;
};

type ProblemGroupViewModel = CanvasProblemDefinitionGroup & {
  status: ProblemGroupStatus;
};

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
  stage: string;
  agenda_overrides: string;
  canvas_items: string;
  custom_groups: string;
  problem_groups: string;
  solution_topics: string;
  node_positions: string;
  imported_state: string;
};

function createWorkspaceFieldSignatures(): WorkspaceFieldSignatures {
  return {
    stage: "",
    agenda_overrides: "",
    canvas_items: "",
    custom_groups: "",
    problem_groups: "",
    solution_topics: "",
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
    conclusion: group.conclusion,
    conclusion_user_edited: group.conclusion_user_edited,
    status: group.status,
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

function normalizeRefinedUtterances(
  rows: CanvasRefinedUtterance[] | undefined,
  limit = 120,
): CanvasRefinedUtterance[] {
  const seen = new Set<string>();
  const normalized: CanvasRefinedUtterance[] = [];

  (rows || []).forEach((row, index) => {
    const text = stripLeadingTimestamp(row.text || "");
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

function splitRefinedUtteranceSentences(
  rows: CanvasRefinedUtterance[] | undefined,
  limit = 6,
): CanvasRefinedUtterance[] {
  const sentenceRows: CanvasRefinedUtterance[] = [];

  normalizeRefinedUtterances(rows).forEach((row) => {
    const normalizedText = stripLeadingTimestamp(row.text || "")
      .replace(/\s+/g, " ")
      .replace(/([.!?。！？])\s+/g, "$1\n")
      .replace(/(습니다|합니다|됩니다|입니다|니다|어요|예요|이에요|네요|죠|까요|다|요)\s+(?=[가-힣A-Za-z0-9])/g, "$1\n")
      .trim();

    const sentences = normalizedText
      .split(/\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    (sentences.length > 0 ? sentences : [row.text]).forEach((sentence, sentenceIndex) => {
      if (sentenceRows.length >= limit) return;
      sentenceRows.push({
        ...row,
        utterance_id: `${row.utterance_id || "refined"}-sentence-${sentenceIndex}`,
        text: sentence,
      });
    });
  });

  return sentenceRows.slice(0, limit);
}

function buildWorkspaceCanvasItemsPayload(items: CanvasItemViewModel[]) {
  return items.map((item) => ({
    id: item.id,
    agenda_id: item.agenda_id,
    point_id: item.point_id || "",
    kind: item.kind,
    title: item.title,
    body: item.body,
    keywords: (item.keywords || []).map((keyword) => keyword.trim()).filter(Boolean),
    key_evidence: (item.key_evidence || []).map((value) => value.trim()).filter(Boolean),
    refined_utterances: normalizeRefinedUtterances(item.refined_utterances),
    evidence_utterance_ids: (item.evidence_utterance_ids || []).map((value) => value.trim()).filter(Boolean),
    ignored_utterance_ids: (item.ignored_utterance_ids || []).map((value) => value.trim()).filter(Boolean),
    ai_generated: Boolean(item.ai_generated),
    user_edited: Boolean(item.user_edited),
    x: typeof item.x === "number" ? item.x : undefined,
    y: typeof item.y === "number" ? item.y : undefined,
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
    stage: input.stage,
    agenda_overrides: JSON.stringify(serializeAgendaOverrides(input.agendaOverrides)),
    canvas_items: JSON.stringify(buildWorkspaceCanvasItemsPayload(input.canvasItems)),
    custom_groups: JSON.stringify(serializeCustomGroups(input.customGroups)),
    problem_groups: JSON.stringify(buildWorkspaceProblemGroupsPayload(input.problemGroups)),
    solution_topics: JSON.stringify(buildWorkspaceSolutionTopicsPayload(input.solutionTopics)),
    node_positions: JSON.stringify(input.nodePositions || {}),
    imported_state: JSON.stringify(input.importedState || null),
  };
}

function buildFullWorkspacePatchPayload(input: {
  meetingId: string;
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
    stage: input.stage,
    agenda_overrides: serializeAgendaOverrides(input.agendaOverrides),
    canvas_items: serializeSharedCanvasItems(input.canvasItems),
    custom_groups: serializeCustomGroups(input.customGroups),
    problem_groups: buildWorkspaceProblemGroupsPayload(input.problemGroups),
    solution_topics: buildWorkspaceSolutionTopicsPayload(input.solutionTopics),
    node_positions: input.nodePositions,
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
      agenda_id: note.agendaId,
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
};

type MeetingCanvasTabProps = {
  userId: string;
  meetingId: string;
  meetingTitle: string;
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

function toolLabel(tool: CanvasTool) {
  if (tool === "note") return "추가";
  if (tool === "comment") return "댓글";
  if (tool === "group") return "그룹";
  return "주제";
}

function toolPreviewHint(tool: CanvasTool) {
  if (tool === "group") return "프로젝트 그룹을 만들 위치";
  if (tool === "topic") return "새 주제를 만들 위치";
  if (tool === "comment") return "코멘트를 남길 위치";
  return "메모를 붙일 위치";
}

function toolPreviewTone(tool: CanvasTool) {
  if (tool === "group") return "border-emerald-200 bg-emerald-50/92 text-emerald-700";
  if (tool === "topic") return "border-fuchsia-200 bg-fuchsia-50/92 text-fuchsia-700";
  if (tool === "comment") return "border-sky-200 bg-sky-50/92 text-sky-700";
  return "border-amber-200 bg-amber-50/92 text-amber-700";
}

function isAudioImportFile(file: File) {
  const suffix = file.name.split(".").pop()?.toLowerCase() || "";
  return ["wav", "mp3", "m4a", "webm"].includes(suffix);
}

function buildFallbackMeetingGoal(topic: string) {
  const cleanTopic = topic.trim();
  if (!cleanTopic) return "이번 회의에서 실행 방향과 핵심 우선순위를 정리한다.";
  return `${cleanTopic}에 대해 실행 방향과 핵심 우선순위를 정리한다.`;
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

function normalizeSolutionAiSuggestionStatus(raw: string | undefined): SolutionAiSuggestionStatus {
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

function buildProblemGroupDisplayCards(group: ProblemGroupViewModel): ProblemGroupDisplayCard[] {
  const summaryCards = (group.source_summary_items || []).map((item, index) => ({
    id: `${group.group_id}-summary-${index}`,
    title: `아이디어${index + 1}`,
    body: stripLeadingTimestamp(item) || "아직 요약된 아이디어가 없습니다.",
    kind: "summary",
  }));
  const personalCards = (group.ideas || []).map((idea, index) => ({
    id: idea.id || `${group.group_id}-idea-${index}`,
    title: idea.title || `메모${index + 1}`,
    body: idea.body || "메모 내용 없음",
    kind: idea.kind || "memo",
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

    if (previous) {
      previous.ideas.forEach((idea) => {
        if (!mergedIdeas.some((item) => item.id === idea.id)) {
          mergedIdeas.push(idea);
        }
      });
    }

    return {
      ...group,
      ideas: mergedIdeas,
      insight_user_edited: group.insight_user_edited ?? previous?.insight_user_edited ?? false,
      conclusion_user_edited:
        group.conclusion_user_edited ?? previous?.conclusion_user_edited ?? false,
      status:
        group.status === "review" || group.status === "final" || group.status === "draft"
          ? group.status
          : previous?.status || "draft",
    };
  });
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
        <div className="mt-4 rounded-[18px] border border-amber-100 bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Summary</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
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
      shell: "border-sky-200 bg-sky-50/90",
      badge: "bg-sky-100 text-sky-700",
      accent: "text-sky-700",
    };
  }
  if (kind === "topic") {
    return {
      shell: "border-fuchsia-200 bg-fuchsia-50/90",
      badge: "bg-fuchsia-100 text-fuchsia-700",
      accent: "text-fuchsia-700",
    };
  }
  return {
    shell: "border-amber-200 bg-amber-50/90",
    badge: "bg-amber-100 text-amber-700",
    accent: "text-amber-700",
  };
}

function estimateCanvasItemNodeHeight(title: string, body: string) {
  const titleLines = Math.max(1, Math.ceil(Math.max(title.length, 1) / 18));
  const bodyLines = Math.max(2, Math.ceil(Math.max(body.length, 1) / 24));
  return 150 + (titleLines - 1) * 16 + (bodyLines - 1) * 18;
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

function makeCanvasItemNodeLabel(
  item: CanvasItemViewModel,
  selected: boolean,
  linkedAgendaTitle: string,
) {
  const tone = canvasItemTone((item.kind as ComposerTool) || "note");
  const keywords = (item.keywords || []).filter(Boolean).slice(0, 3);

  return (
    <div className="min-w-0 p-1">
      <div className={`rounded-[24px] border px-4 py-4 shadow-sm transition ${tone.shell} ${selected ? "ring-2 ring-slate-900/20" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${tone.badge}`}>
            {toolLabel((item.kind as ComposerTool) || "note")}
          </span>
          {linkedAgendaTitle ? (
            <span className="rounded-full bg-white/85 px-3 py-1 text-[11px] text-slate-500">
              {linkedAgendaTitle}
            </span>
          ) : null}
        </div>
        <strong className="mt-4 block text-[17px] leading-7 text-slate-900">{item.title}</strong>
        <div className="mt-4 rounded-[18px] border border-white/90 bg-white/90 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Content</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">
            {item.body || "내용을 입력해 주세요."}
          </p>
        </div>
        {keywords.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {keywords.map((keyword) => (
              <span key={`${item.id}-${keyword}`} className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                #{keyword}
              </span>
            ))}
          </div>
        ) : null}
        {item.point_id ? (
          <p className={`mt-3 text-xs font-medium ${tone.accent}`}>연결 노드: {item.point_id}</p>
        ) : null}
      </div>
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
    <div className={`min-w-0 rounded-[22px] bg-gradient-to-br from-emerald-50 via-white to-white p-5 transition ${selected ? "ring-2 ring-emerald-300" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
            Solution {topic.topic_no || 0}
          </p>
          <strong className="mt-2 block text-[17px] leading-7 text-slate-900">{topic.topic}</strong>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${problemGroupStatusTone(topic.status)}`}>
          {problemGroupStatusLabel(topic.status)}
        </span>
      </div>
      {topic.problem_topic ? (
        <div className="mt-4 rounded-2xl border border-emerald-100 bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Sub Conclusion</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {topic.problem_insight || topic.problem_topic}
          </p>
        </div>
      ) : null}
      <div className="mt-4 rounded-2xl border border-emerald-100 bg-white px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Conclusion</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">{topic.conclusion || "해결 방향이 아직 없습니다."}</p>
      </div>
      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">AI Draft</p>
        <div className="mt-2 space-y-1.5">
          {(topic.ai_suggestions || []).slice(0, 4).map((idea) => (
            <p
              key={idea.id}
              className={`text-sm leading-6 ${
                idea.status === "selected" ? "text-blue-600" : "text-slate-500"
              }`}
            >
              • {idea.text}
            </p>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {(topic.notes || []).slice(0, 2).map((note) => (
          <div key={note.id} className="min-h-[120px] rounded-[14px] border border-amber-100 bg-amber-100/80 p-4 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700">
              {note.source === "ai" ? "채택 메모" : "사용자 메모"}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-700">{note.text}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2 text-[11px] text-slate-500">
        <span>{selectedAiCount}개 채택</span>
        <span>{finalCount}개 최종 결론</span>
      </div>
    </div>
  );
}

function makeProblemGroupNodeLabel(
  group: ProblemGroupViewModel,
  index: number,
  selected: boolean,
  loading: boolean,
  dropTarget: boolean,
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void,
  onDragLeave: () => void,
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void,
) {
  const palette = problemGroupPalette(index);
  const noteCards = buildProblemGroupDisplayCards(group);

  return (
    <div
      className={`min-w-0 rounded-[30px] p-2 transition ${selected ? "ring-2 ring-violet-300" : ""} ${dropTarget ? "ring-2 ring-blue-300 ring-offset-2" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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

        <div className="mt-6 grid grid-cols-2 gap-5">
          {noteCards.length > 0 ? (
            noteCards.map((item, itemIndex) => (
              <div key={item.id} className={`min-h-[136px] rounded-[12px] border p-5 shadow-[0_10px_22px_rgba(15,23,42,0.08)] ${palette.note}`}>
                <p className="text-[19px] font-semibold leading-7 text-slate-900">
                  {item.title || `아이디어${itemIndex + 1}`}
                </p>
                <p className={`mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${palette.noteAccent}`}>
                  {item.kind === "summary" ? "summary" : "memo"}
                </p>
                <p className="mt-3 line-clamp-4 text-[15px] leading-7 text-slate-600">
                  {item.body}
                </p>
              </div>
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

function estimateSolutionNodeHeight(topic: SolutionTopicViewModel) {
  const topicLines = estimateWrappedLines(topic.topic, 18);
  const subConclusionLines = topic.problem_insight
    ? Math.min(3, estimateWrappedLines(topic.problem_insight, 28))
    : 0;
  const conclusionLines = Math.min(4, estimateWrappedLines(topic.conclusion || "해결 방향이 아직 없습니다.", 28));
  const aiLines = Math.max(
    1,
    (topic.ai_suggestions || []).slice(0, 4).reduce((sum, item) => sum + Math.min(2, estimateWrappedLines(item.text, 30)), 0),
  );
  const noteCards = (topic.notes || []).slice(0, 2);
  const noteHeight =
    noteCards.length > 0
      ? Math.max(
          ...noteCards.map((note) => 92 + Math.min(4, estimateWrappedLines(note.text || "메모 없음", 16)) * 16),
        )
      : 0;

  return (
    108 +
    Math.max(0, topicLines - 1) * 22 +
    (subConclusionLines > 0 ? 52 + Math.max(0, subConclusionLines - 1) * 18 : 0) +
    70 +
    Math.max(0, conclusionLines - 1) * 18 +
    34 +
    aiLines * 18 +
    (noteHeight > 0 ? 36 + noteHeight : 0) +
    38
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
    conclusion: group.conclusion,
    conclusion_user_edited: group.conclusion_user_edited,
    status: group.status,
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
    return {
      ...item,
      keywords: keywords.slice(0, 8),
      key_evidence: keyEvidence.slice(0, 8),
      refined_utterances: refinedUtterances,
      evidence_utterance_ids: evidenceUtteranceIds.slice(0, 400),
      ignored_utterance_ids: ignoredUtteranceIds.slice(0, 400),
      ai_generated: Boolean(item.ai_generated),
      user_edited: Boolean(item.user_edited),
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
  stage: CanvasStage;
  agenda_overrides: Record<string, unknown>;
  canvas_items: unknown[];
  custom_groups?: unknown[];
  problem_groups: unknown[];
  solution_topics: unknown[];
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

  return nextPositions;
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
  positionSource: "persisted" | "fallback";
  sourcePosition: Position;
  targetPosition: Position;
  className: string;
  style: React.CSSProperties;
  data: CanvasNodeData;
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

function styleSignature(style?: React.CSSProperties) {
  return buildNodeContentSignature([
    style?.width,
    style?.minHeight,
    style?.borderRadius,
    style?.padding,
  ]);
}

function reconcileNodes(
  currentNodes: Node[],
  descriptors: CanvasNodeDescriptor[],
) {
  const currentNodeMap = new Map(currentNodes.map((node) => [node.id, node]));
  let changed = currentNodes.length !== descriptors.length;

  const nextNodes = descriptors.map((descriptor, index) => {
    const existingNode = currentNodeMap.get(descriptor.id);
    const nextPosition =
      existingNode && descriptor.positionSource === "fallback"
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
  recordingStatusText = "",
}: MeetingCanvasTabProps) {
  const [stage, setStage] = useState<CanvasStage>("ideation");
  const [composerTool, setComposerTool] = useState<ComposerTool>("note");
  const [armedCanvasTool, setArmedCanvasTool] = useState<CanvasTool | null>(null);
  const [composerTitle, setComposerTitle] = useState("");
  const [composerBody, setComposerBody] = useState("");
  const [selectedAgendaId, setSelectedAgendaId] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [personalNotes, setPersonalNotes] = useState<PersonalNote[]>([]);
  const [agendaOverrides, setAgendaOverrides] = useState<Record<string, AgendaOverride>>({});
  const [canvasItems, setCanvasItems] = useState<CanvasItemViewModel[]>([]);
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
  const [importedState, setImportedState] = useState<MeetingState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedCanvasItemId, setSelectedCanvasItemId] = useState("");
  const [selectedProblemGroupId, setSelectedProblemGroupId] = useState("");
  const [editingProblemGroupId, setEditingProblemGroupId] = useState("");
  const [problemGroupDraftTopic, setProblemGroupDraftTopic] = useState("");
  const [problemGroupDraftInsight, setProblemGroupDraftInsight] = useState("");
  const [problemGroupDraftConclusion, setProblemGroupDraftConclusion] = useState("");
  const [draggingPersonalNoteId, setDraggingPersonalNoteId] = useState("");
  const [dropProblemGroupId, setDropProblemGroupId] = useState("");
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>("detail");
  const [generatedMeetingGoal, setGeneratedMeetingGoal] = useState("");
  const [meetingGoalBusy, setMeetingGoalBusy] = useState(false);
  const [conclusionRefreshingGroupId, setConclusionRefreshingGroupId] = useState("");
  const [conclusionBatchBusy, setConclusionBatchBusy] = useState(false);
  const [problemDefinitionStagePending, setProblemDefinitionStagePending] = useState(false);
  const [solutionStagePending, setSolutionStagePending] = useState(false);
  const [loadingProblemGroupIds, setLoadingProblemGroupIds] = useState<string[]>([]);
  const [liveFlowHint, setLiveFlowHint] = useState("");
  const [ideaAssimilationStatus, setIdeaAssimilationStatus] = useState("");
  const [sharedSyncEnabled, setSharedSyncEnabled] = useState(true);
  const [importOverrideActive, setImportOverrideActive] = useState(false);
  const [nodePositions, setNodePositions] = useState<CanvasNodePositionsByStage>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerBodyRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const resizeStateRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);
  const autoProblemDefinitionRef = useRef(false);
  const problemConclusionEntryHandledRef = useRef(false);
  const lastAutoFitSignatureRef = useRef("");
  const suppressNextAutoFitRef = useRef(false);
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
  const pendingNodePlacementsRef = useRef<Record<string, { x: number; y: number }>>({});
  const analysisSignatureAtImportRef = useRef("");
  const placementFeedbackTimerRef = useRef<number | null>(null);
  const initialLayoutLogDoneRef = useRef(false);
  const processedIdeaUtteranceIdsRef = useRef<Set<string>>(new Set());
  const ideaBufferStartedAtRef = useRef<number | null>(null);
  const ideaFlushTimerRef = useRef<number | null>(null);
  const ideaSilenceTimerRef = useRef<number | null>(null);
  const ideaAssimilationInFlightRef = useRef(false);
  const latestSharedWorkspaceRef = useRef<{
    stage: CanvasStage;
    agendaOverrides: Record<string, AgendaOverride>;
    canvasItems: CanvasItemViewModel[];
    customGroups: CustomGroupViewModel[];
    problemGroups: ProblemGroupViewModel[];
    solutionTopics: SolutionTopicViewModel[];
    nodePositions: CanvasNodePositionsByStage;
    importedState: MeetingState | null;
  }>({
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
  const meetingGoalTopic = useMemo(
    () => meetingTitle.trim() || (effectiveState?.meeting_goal || "").trim(),
    [effectiveState?.meeting_goal, meetingTitle],
  );
  const displayMeetingGoal = generatedMeetingGoal || buildFallbackMeetingGoal(meetingGoalTopic);
  const transcriptStripItems = useMemo(() => {
    const summaryRows = sttFlowSummaries
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

    const normalized = normalizeTranscriptRows(transcripts);
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
  }, [liveSpeechPreview, sttFlowSummaries, transcripts]);

  useEffect(() => {
    if (!selectedAgendaId && agendaModels[0]) {
      setSelectedAgendaId(agendaModels[0].id);
    }
  }, [agendaModels, selectedAgendaId]);

  useEffect(() => {
    autoProblemDefinitionRef.current = false;
    problemConclusionEntryHandledRef.current = false;
    lastAutoFitSignatureRef.current = "";
    lastIncomingSharedSyncIdRef.current = "";
    lastSharedSyncSignatureRef.current = "";
    applyingRemoteSharedSyncRef.current = false;
    localNodeOverridesRef.current = createLocalNodeOverrideMap();
    lastWorkspaceFieldSignaturesRef.current = createWorkspaceFieldSignatures();
    workspaceLoadedRef.current = false;
    workspaceHydratingRef.current = false;
    analysisSignatureAtImportRef.current = "";
    initialLayoutLogDoneRef.current = false;
    processedIdeaUtteranceIdsRef.current = new Set();
    ideaBufferStartedAtRef.current = null;
    ideaAssimilationInFlightRef.current = false;
    latestSharedWorkspaceRef.current = {
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
    setCustomGroups([]);
    setCustomGroupDraftTitle("");
    setEditingAgendaId("");
    setEditingCanvasItemId("");
    setEditingPersonalNoteId("");
    setArmedCanvasTool(null);
    setLiveFlowHint("");
    setIdeaAssimilationStatus("");
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
  }, [meetingId]);

  useEffect(() => {
    latestSharedWorkspaceRef.current = {
      stage,
      agendaOverrides,
      canvasItems,
      customGroups,
      problemGroups,
      solutionTopics,
      nodePositions,
      importedState: persistedSharedImportedState,
    };
    latestSharedSyncEnabledRef.current = sharedSyncEnabled;
  }, [
    agendaOverrides,
    canvasItems,
    customGroups,
    nodePositions,
    persistedSharedImportedState,
    problemGroups,
    sharedSyncEnabled,
    solutionTopics,
    stage,
  ]);

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
            agendaId: note.agenda_id,
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
        const nextNodePositions = shouldUseLocalCanvas
          ? savedLocalCanvasState?.node_positions || {}
          : Object.keys(saved.node_positions || {}).length > 0
            ? saved.node_positions || {}
            : cachedNodePositions || {};
        const nextImportedState = shouldUseLocalCanvas
          ? savedLocalCanvasState?.imported_state || null
          : saved.imported_state || null;
        const nextImportOverrideActive = shouldUseLocalCanvas
          ? Boolean(savedLocalCanvasState?.import_override_active && nextImportedState)
          : Boolean(saved.imported_state);

        setProblemGroups(nextGroups);
        setSolutionTopics(nextSolutionTopics);
        setPersonalNotes(nextPersonalNotes);
        setAgendaOverrides(nextAgendaOverrides);
        setCanvasItems(nextCanvasItems);
        setCustomGroups(nextCustomGroups);
        setSharedSyncEnabled(nextSharedSyncEnabled);
        setNodePositions(nextNodePositions);
        setImportedState(nextImportedState);
        analysisSignatureAtImportRef.current = nextImportedState
          ? buildMeetingStateSignature(nextImportedState)
          : analysisStateSignature;
        setImportOverrideActive(nextImportOverrideActive);
        setStage(nextStage);
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          stage: nextStage,
          agenda_overrides: nextAgendaOverrides,
          canvas_items: nextCanvasItems,
          custom_groups: serializeCustomGroups(nextCustomGroups),
          problem_groups: nextGroups,
          solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
          node_positions: nextNodePositions,
          imported_state: nextImportedState,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
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
        setSharedSyncEnabled(true);
        setNodePositions({});
        setImportedState(null);
        setStage("ideation");
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          stage: "ideation",
          agenda_overrides: {},
          canvas_items: [],
          custom_groups: [],
          problem_groups: [],
          solution_topics: [],
          node_positions: {},
          imported_state: null,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
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
    let cancelled = false;
    const topic = meetingGoalTopic;

    if (!topic) {
      setGeneratedMeetingGoal(buildFallbackMeetingGoal(""));
      setMeetingGoalBusy(false);
      return () => {
        cancelled = true;
      };
    }

    setMeetingGoalBusy(true);
    void generateMeetingGoal({ meeting_id: meetingId, topic })
      .then((result) => {
        if (cancelled) return;
        setGeneratedMeetingGoal(result.goal || buildFallbackMeetingGoal(topic));
      })
      .catch(() => {
        if (cancelled) return;
        setGeneratedMeetingGoal(buildFallbackMeetingGoal(topic));
      })
      .finally(() => {
        if (!cancelled) {
          setMeetingGoalBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [meetingGoalTopic, meetingId]);

  useEffect(() => {
    const syncViewportMode = () => {
      setIsDesktopLayout(window.innerWidth >= 1280);
    };

    syncViewportMode();
    window.addEventListener("resize", syncViewportMode);
    return () => window.removeEventListener("resize", syncViewportMode);
  }, []);

  const buildProblemConclusionPayload = useCallback(
    (group: ProblemGroupViewModel) => ({
      meeting_id: meetingId,
      meeting_topic: generatedMeetingGoal || meetingTitle || effectiveState?.meeting_goal || "회의 주제",
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
    [effectiveState?.meeting_goal, generatedMeetingGoal, meetingId, meetingTitle],
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
    }) => {
      if (!meetingId || !userId) {
        return;
      }

      const snapshot = {
        stage: overrides?.stage ?? stage,
        agenda_overrides: serializeAgendaOverrides(overrides?.agendaOverrides ?? agendaOverrides),
        canvas_items: serializeSharedCanvasItems(overrides?.canvasItems ?? canvasItems),
        custom_groups: serializeCustomGroups(overrides?.customGroups ?? customGroups),
        problem_groups: serializeSharedProblemGroups(overrides?.problemGroups ?? problemGroups),
        solution_topics: serializeSharedSolutionTopics(overrides?.solutionTopics ?? solutionTopics),
        node_positions: overrides?.nodePositions ?? nodePositions,
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
        stage: snapshot.stage,
        agenda_overrides: snapshot.agenda_overrides,
        canvas_items: snapshot.canvas_items,
        custom_groups: snapshot.custom_groups,
        problem_groups: snapshot.problem_groups,
        solution_topics: snapshot.solution_topics,
        node_positions: snapshot.node_positions,
        imported_state: snapshot.imported_state,
      });
    },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
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

  const flushIdeaAssimilationBuffer = useCallback(
    async (reason: "timer" | "silence" | "stage-change" | "manual") => {
      if (!meetingId || stage !== "ideation" || ideaAssimilationInFlightRef.current) {
        return;
      }

      const processedIds = processedIdeaUtteranceIdsRef.current;
      const targetRows = normalizeTranscriptRows(transcripts)
        .filter((row) => row.id && row.text.trim() && !processedIds.has(row.id));

      const targetTextLength = targetRows.reduce((sum, row) => sum + stripLeadingTimestamp(row.text).length, 0);
      if (targetRows.length === 0 || (reason !== "stage-change" && reason !== "manual" && targetTextLength < 40)) {
        if (targetRows.length > 0) {
          setIdeaAssimilationStatus(`아이디어 정리 대기 중 · ${targetRows.length}개 발화`);
        }
        return;
      }

      ideaAssimilationInFlightRef.current = true;
      setIdeaAssimilationStatus("AI가 최근 발화를 아이디어로 정리 중");

      try {
        const firstTargetIndex = transcripts.findIndex((row) => row.id === targetRows[0]?.id);
        const contextRows =
          firstTargetIndex > 0 ? normalizeTranscriptRows(transcripts.slice(Math.max(0, firstTargetIndex - 6), firstTargetIndex)) : [];
        const existingIdeas: CanvasIdeaAssimilationIdea[] = canvasItems
          .filter((item) => item.kind !== "comment")
          .map((item) => ({
            id: item.id,
            title: item.title,
            summary: item.body || item.title,
            keywords: item.keywords || [],
            key_evidence: item.key_evidence || [],
            refined_utterances: item.refined_utterances || [],
            evidence_utterance_ids: item.evidence_utterance_ids || [],
            user_edited: Boolean(item.user_edited),
          }));

        const result = await assimilateCanvasIdeas({
          meeting_id: meetingId,
          meeting_topic: generatedMeetingGoal || meetingTitle || effectiveState?.meeting_goal || "회의 주제",
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
          existing_ideas: existingIdeas,
        });

        const updates = (result.updates || []).filter((update) => update.action === "merge" || update.action === "create");
        if (updates.length === 0) {
          targetRows.forEach((row) => processedIds.add(row.id));
          setIdeaAssimilationStatus("정리할 새 아이디어 없음");
          return;
        }

        const nextNodePositions: CanvasNodePositionsByStage = {
          ...nodePositions,
          ideation: {
            ...(nodePositions.ideation || {}),
          },
        };
        const knownItems = [...canvasItems];
        const now = Date.now();
        const createdItems: CanvasItemViewModel[] = [];

        const applyUpdateToItem = (item: CanvasItemViewModel, update: CanvasIdeaAssimilationUpdate) => {
          const nextEvidenceIds = Array.from(
            new Set([...(item.evidence_utterance_ids || []), ...(update.evidenceUtteranceIds || [])]),
          ).slice(0, 400);
          const nextIgnoredIds = Array.from(
            new Set([...(item.ignored_utterance_ids || []), ...(update.ignoredUtteranceIds || [])]),
          ).slice(0, 400);
          const nextKeyEvidence = Array.from(new Set([...(item.key_evidence || []), ...(update.keyEvidence || [])])).slice(0, 8);
          const nextKeywords = Array.from(new Set([...(item.keywords || []), ...(update.keywords || [])])).slice(0, 8);
          const nextRefinedUtterances = normalizeRefinedUtterances([
            ...(item.refined_utterances || []),
            ...(update.refinedUtterances || []),
          ]);

          return {
            ...item,
            title: item.user_edited ? item.title : update.title || item.title,
            body: item.user_edited ? item.body : update.summary || item.body,
            keywords: nextKeywords,
            key_evidence: nextKeyEvidence,
            refined_utterances: nextRefinedUtterances,
            evidence_utterance_ids: nextEvidenceIds,
            ignored_utterance_ids: nextIgnoredIds,
            ai_generated: item.ai_generated || result.used_llm,
          };
        };

        let nextCanvasItemsSnapshot = knownItems.map((item) => {
          const update = updates.find((candidate) => candidate.action === "merge" && candidate.targetIdeaId === item.id);
          return update ? applyUpdateToItem(item, update) : item;
        });

        updates
          .filter((update) => update.action === "create")
          .forEach((update, index) => {
            const id = `ai-idea-${now}-${index}-${Math.random().toString(16).slice(2, 6)}`;
            const nodeId = `canvas-item-${id}`;
            const layoutIndex = nextCanvasItemsSnapshot.length + createdItems.length;
            const x = 180 + (layoutIndex % 3) * 300;
            const y = 300 + Math.floor(layoutIndex / 3) * 230;
            const nextItem: CanvasItemViewModel = {
              id,
              agenda_id: selectedAgendaId || agendaModels[0]?.id || "",
              point_id: "",
              kind: "note",
              title: update.title || "새 아이디어",
              body: update.summary || "",
              keywords: (update.keywords || []).slice(0, 8),
              key_evidence: (update.keyEvidence || []).slice(0, 8),
              refined_utterances: normalizeRefinedUtterances(update.refinedUtterances),
              evidence_utterance_ids: (update.evidenceUtteranceIds || []).slice(0, 400),
              ignored_utterance_ids: (update.ignoredUtteranceIds || []).slice(0, 400),
              ai_generated: true,
              user_edited: false,
              x,
              y,
            };
            nextNodePositions.ideation = {
              ...(nextNodePositions.ideation || {}),
              [nodeId]: { x, y },
            };
            createdItems.push(nextItem);
          });

        nextCanvasItemsSnapshot = [...createdItems, ...nextCanvasItemsSnapshot];
        updates.forEach((update) => {
          [...(update.evidenceUtteranceIds || []), ...(update.ignoredUtteranceIds || [])].forEach((id) => {
            if (id) processedIds.add(id);
          });
        });
        targetRows.forEach((row) => processedIds.add(row.id));
        ideaBufferStartedAtRef.current = null;

        setCanvasItems(nextCanvasItemsSnapshot);
        setNodePositions(nextNodePositions);
        latestSharedWorkspaceRef.current = {
          ...latestSharedWorkspaceRef.current,
          canvasItems: nextCanvasItemsSnapshot,
          nodePositions: nextNodePositions,
          importedState: persistedSharedImportedState,
        };

        if (sharedSyncEnabled) {
          writeSharedWorkspaceSessionCache(
            meetingId,
            buildFullWorkspacePatchPayload({
              meetingId,
              stage,
              agendaOverrides,
              canvasItems: nextCanvasItemsSnapshot,
              customGroups,
              problemGroups,
              solutionTopics,
              nodePositions: nextNodePositions,
              importedState: persistedSharedImportedState,
            }),
          );
          forceBroadcastSharedCanvas({
            canvasItems: nextCanvasItemsSnapshot,
            nodePositions: nextNodePositions,
          });
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
            node_positions: nextNodePositions,
            imported_state: persistedSharedImportedState,
          }).catch((error) => {
            console.error("Failed to save AI idea assimilation:", error);
          });
        }

        setIdeaAssimilationStatus(result.used_llm ? "AI 아이디어 정리 반영됨" : "로컬 기준으로 아이디어 정리됨");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setIdeaAssimilationStatus(`아이디어 정리 실패: ${message}`);
      } finally {
        ideaAssimilationInFlightRef.current = false;
      }
    },
    [
      agendaModels,
      agendaOverrides,
      canvasItems,
      customGroups,
      effectiveState?.meeting_goal,
      forceBroadcastSharedCanvas,
      generatedMeetingGoal,
      meetingId,
      meetingTitle,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      selectedAgendaId,
      sharedSyncEnabled,
      solutionTopics,
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
    const normalizedRows = normalizeTranscriptRows(transcripts);
    const latestRow = normalizedRows.at(-1) || null;
    setLiveFlowHint(buildLiveFlowHint(latestRow));

    if (stage !== "ideation" || !latestRow) {
      return;
    }

    const hasUnprocessedRows = normalizedRows.some(
      (row) => row.id && row.text.trim() && !processedIdeaUtteranceIdsRef.current.has(row.id),
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
      Math.max(0, 90_000 - elapsed),
    );

    if (ideaSilenceTimerRef.current) {
      window.clearTimeout(ideaSilenceTimerRef.current);
    }
    ideaSilenceTimerRef.current = window.setTimeout(() => void flushIdeaAssimilationBuffer("silence"), 12_000);

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
    async (groups: ProblemGroupViewModel[]) => {
      if (groups.length === 0) return;

      const targetGroups = groups.filter(
        (group) => !(group.insight_user_edited && group.conclusion_user_edited),
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

  useEffect(() => {
    if (
      !meetingId ||
      !sharedSyncEnabled ||
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
    const nextSignatures = buildWorkspaceFieldSignatures({
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
      stage?: CanvasStage;
      agenda_overrides?: ReturnType<typeof serializeAgendaOverrides>;
      canvas_items?: ReturnType<typeof serializeSharedCanvasItems>;
      custom_groups?: ReturnType<typeof serializeCustomGroups>;
      problem_groups?: ReturnType<typeof buildWorkspaceProblemGroupsPayload>;
      solution_topics?: ReturnType<typeof buildWorkspaceSolutionTopicsPayload>;
      node_positions?: CanvasNodePositionsByStage;
      imported_state?: MeetingState | null;
    } = {
      meeting_id: meetingId,
    };

    let hasChanges = false;
    if (nextSignatures.stage !== previousSignatures.stage) {
      patch.stage = stage;
      hasChanges = true;
    }
    if (nextSignatures.agenda_overrides !== previousSignatures.agenda_overrides) {
      patch.agenda_overrides = serializeAgendaOverrides(agendaOverrides);
      hasChanges = true;
    }
    if (nextSignatures.canvas_items !== previousSignatures.canvas_items) {
      patch.canvas_items = serializeSharedCanvasItems(canvasItems);
      hasChanges = true;
    }
    if (nextSignatures.custom_groups !== previousSignatures.custom_groups) {
      patch.custom_groups = serializeCustomGroups(customGroups);
      hasChanges = true;
    }
    if (nextSignatures.problem_groups !== previousSignatures.problem_groups) {
      patch.problem_groups = nextProblemGroupsPayload;
      hasChanges = true;
    }
    if (nextSignatures.solution_topics !== previousSignatures.solution_topics) {
      patch.solution_topics = nextSolutionTopicsPayload;
      hasChanges = true;
    }
    if (nextSignatures.node_positions !== previousSignatures.node_positions) {
      patch.node_positions = nodePositions;
      hasChanges = true;
    }
    if (nextSignatures.imported_state !== previousSignatures.imported_state) {
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
          lastWorkspaceFieldSignaturesRef.current = nextSignatures;
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
    meetingId,
    nodePositions,
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
            agenda_overrides: serializeAgendaOverrides(agendaOverrides),
            canvas_items: serializeSharedCanvasItems(canvasItems),
            custom_groups: serializeCustomGroups(customGroups),
          }
        : {
            shared_sync_enabled: false,
            agenda_overrides: serializeAgendaOverrides(agendaOverrides),
            canvas_items: serializeSharedCanvasItems(canvasItems),
            custom_groups: serializeCustomGroups(customGroups),
            stage,
            problem_groups: serializeSharedProblemGroups(problemGroups),
            solution_topics: serializeSharedSolutionTopics(solutionTopics),
            node_positions: nodePositions,
            imported_state: persistedSharedImportedState,
            import_override_active: importOverrideActive,
          },
    [
      agendaOverrides,
      canvasItems,
      customGroups,
      importOverrideActive,
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
          agenda_id: note.agendaId,
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
      stage,
      agenda_overrides: serializeAgendaOverrides(agendaOverrides),
      canvas_items: serializeSharedCanvasItems(canvasItems),
      custom_groups: serializeCustomGroups(customGroups),
      problem_groups: serializeSharedProblemGroups(problemGroups),
      solution_topics: serializeSharedSolutionTopics(solutionTopics),
      node_positions: nodePositions,
      imported_state: persistedSharedImportedState,
    }),
    [agendaOverrides, canvasItems, customGroups, nodePositions, persistedSharedImportedState, problemGroups, solutionTopics, stage],
  );

  useEffect(() => {
    if (!meetingId || !sharedSyncEnabled || !workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }

    writeSharedWorkspaceSessionCache(
      meetingId,
      buildFullWorkspacePatchPayload({
        meetingId,
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
    lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
      stage: incomingStage,
      agenda_overrides: incomingSharedCanvasSync.agenda_overrides || {},
      canvas_items: incomingCanvasItems,
      custom_groups: serializeCustomGroups(incomingCustomGroups),
      problem_groups: incomingSharedCanvasSync.problem_groups || [],
      solution_topics: serializeSharedSolutionTopics(
        hydrateSolutionTopics(
          incomingSharedCanvasSync.solution_topics || [],
          hydrateProblemGroups(incomingSharedCanvasSync.problem_groups || []),
        ),
      ),
      node_positions: incomingSharedCanvasSync.node_positions || {},
      imported_state: incomingSharedCanvasSync.imported_state || null,
    });
    applyingRemoteSharedSyncRef.current = true;

    const nextProblemGroups = hydrateProblemGroups(incomingSharedCanvasSync.problem_groups || [], problemGroups);
    const nextSolutionTopics = hydrateSolutionTopics(
      incomingSharedCanvasSync.solution_topics || [],
      nextProblemGroups,
      solutionTopics,
    );

    setProblemGroups(nextProblemGroups);
    setSolutionTopics(nextSolutionTopics);
    setAgendaOverrides(incomingSharedCanvasSync.agenda_overrides || {});
    setCanvasItems(incomingCanvasItems);
    setCustomGroups(incomingCustomGroups);
    setNodePositions((prev) =>
      sharedSyncEnabled
        ? incomingSharedCanvasSync.node_positions || {}
        : mergeNodePositionsWithLocalOverrides(
            prev,
            incomingSharedCanvasSync.node_positions || {},
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
      stage: incomingStage,
      agendaOverrides: incomingSharedCanvasSync.agenda_overrides || {},
      canvasItems: incomingCanvasItems,
      customGroups: incomingCustomGroups,
      problemGroups: nextProblemGroups,
      solutionTopics: nextSolutionTopics,
      nodePositions: incomingSharedCanvasSync.node_positions || {},
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
      setSelectedCanvasItemId("");
      setSelectedNodeId("");
    }
    setActivityMessage("다른 참가자의 canvas 변경사항이 반영되었습니다.");

    window.setTimeout(() => {
      applyingRemoteSharedSyncRef.current = false;
    }, 0);
  }, [analysisStateSignature, incomingSharedCanvasSync, meetingId, problemGroups, sharedSyncEnabled, solutionTopics, userId]);

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
        updated_by: userId,
        updated_at: new Date().toISOString(),
        stage: sharedCanvasSnapshot.stage,
        agenda_overrides: sharedCanvasSnapshot.agenda_overrides,
        canvas_items: sharedCanvasSnapshot.canvas_items,
        custom_groups: sharedCanvasSnapshot.custom_groups,
        problem_groups: sharedCanvasSnapshot.problem_groups,
        solution_topics: sharedCanvasSnapshot.solution_topics,
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

  const graphBlueprint = useMemo(() => {
    if (stage === "problem-definition") {
      const heights = problemGroups.map((group) => estimateProblemGroupNodeHeight(group));
      const positions = buildGridPositions(heights, 600, 92, 80, 120);

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          ...problemGroups.map((group) => group.group_id),
        ]),
        nodeDescriptors: problemGroups.map((group, index) => {
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
                group.insight_lens,
                group.conclusion,
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
      };
    }

    if (stage === "solution") {
      const heights = solutionTopics.map((topic) => estimateSolutionNodeHeight(topic));
      const positions = buildGridPositions(heights, 410, 52, 120, 140);

      return {
        layoutSignature: buildNodeContentSignature([
          stage,
          ...solutionTopics.map((topic) => topic.group_id),
        ]),
        nodeDescriptors: solutionTopics.map((topic, index) => {
          const nodeId = `solution-${topic.group_id}`;
          const savedPosition = nodePositions.solution?.[nodeId];
          const selected = selectedSolutionTopicId === topic.group_id;
          const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition
            ? "persisted"
            : "fallback";

          return {
            id: nodeId,
            position: savedPosition || positions[index],
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "rounded-3xl border border-emerald-200 bg-emerald-50 shadow-sm",
            style: { width: 360, minHeight: heights[index], borderRadius: 22, padding: 0 },
            data: {
              contentSignature: buildNodeContentSignature([
                topic.group_id,
                topic.topic_no,
                topic.topic,
                topic.conclusion,
                topic.status,
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
      };
    }

    const agendaHeights = agendaModels.map((agenda) =>
      estimateAgendaNodeHeight(
        agenda.title,
        stripLeadingTimestamp(agenda.summaryBullets[0] || "요약이 아직 없습니다."),
        agenda.keywords.length,
      ),
    );
    const positions = buildGridPositions(agendaHeights, 370, 56, 120, 80);

    return {
      layoutSignature: buildNodeContentSignature([
        stage,
        ...agendaModels.map((agenda) => agenda.id),
        ...canvasItems.map((item) => item.id),
      ]),
      nodeDescriptors: [
        ...agendaModels.map((agenda, agendaIndex) => {
          const nodeId = `agenda-${agenda.id}`;
          const savedPosition = nodePositions.ideation?.[nodeId];
          const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition
            ? "persisted"
            : "fallback";

          return {
            id: nodeId,
            position: savedPosition || positions[agendaIndex],
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "rounded-[28px] border border-amber-200 bg-white shadow-[0_18px_40px_rgba(148,163,184,0.16)]",
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
        ...canvasItems.map((item, index) => {
          const nodeId = `canvas-item-${item.id}`;
          const savedPosition =
            nodePositions.ideation?.[nodeId] ||
            pendingNodePlacementsRef.current[nodeId] ||
            (typeof item.x === "number" && typeof item.y === "number"
              ? { x: item.x, y: item.y }
              : undefined);
          const positionSource: CanvasNodeDescriptor["positionSource"] = savedPosition
            ? "persisted"
            : "fallback";
          const linkedAgendaTitle =
            agendaModels.find((agenda) => agenda.id === item.agenda_id)?.title || "";
          const fallbackPosition = {
            x: 180 + ((index % 3) * 260),
            y: 320 + Math.floor(index / 3) * 220,
          };

          return {
            id: nodeId,
            position: savedPosition || fallbackPosition,
            positionSource,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            className: "rounded-[24px] border shadow-[0_16px_36px_rgba(148,163,184,0.16)]",
            style: {
              width: 260,
              minHeight: estimateCanvasItemNodeHeight(item.title, item.body),
              borderRadius: 24,
              padding: 0,
            },
            data: {
              contentSignature: buildNodeContentSignature([
                item.id,
                item.kind,
                item.title,
                item.body,
                ...(item.keywords || []),
                item.agenda_id,
                item.point_id,
                selectedCanvasItemId === item.id,
              ]),
              label: makeCanvasItemNodeLabel(item, selectedCanvasItemId === item.id, linkedAgendaTitle),
            },
          };
        }),
      ],
    };
  }, [stage, agendaModels, canvasItems, dropProblemGroupId, loadingProblemGroupIds, nodePositions, problemGroups, selectedCanvasItemId, selectedProblemGroupId, selectedSolutionTopicId, solutionTopics, handleAttachPersonalNoteToProblemGroup]);

  useEffect(() => {
    if (!workspaceLoadedRef.current || workspaceHydratingRef.current) {
      return;
    }

    const stageKey = stage;
    setNodePositions((prev) => {
      const currentStagePositions = prev[stageKey] || {};
      const validNodeIds = new Set(graphBlueprint.nodeDescriptors.map((descriptor) => descriptor.id));
      const nextStageEntries = Object.entries(currentStagePositions).filter(([nodeId]) => validNodeIds.has(nodeId));

      if (nextStageEntries.length === Object.keys(currentStagePositions).length) {
        return prev;
      }

      return {
        ...prev,
        [stageKey]: Object.fromEntries(nextStageEntries),
      };
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
    setNodes((current) =>
      reconcileNodes(current, graphBlueprint.nodeDescriptors),
    );
    setEdges((current) => {
      const validNodeIds = new Set(graphBlueprint.nodeDescriptors.map((node) => node.id));
      const nextEdges = current.filter(
        (edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target),
      );
      return nextEdges.length === current.length ? current : nextEdges;
    });
  }, [graphBlueprint]);

  const autoFitSignature = useMemo(
    () => `${meetingId}|${stage}|${nodes.map((node) => node.id).join("|")}`,
    [meetingId, nodes, stage],
  );

  useEffect(() => {
    if (!flowRef.current || nodes.length === 0) return;
    if (lastAutoFitSignatureRef.current === autoFitSignature) return;

    lastAutoFitSignatureRef.current = autoFitSignature;

    if (suppressNextAutoFitRef.current) {
      suppressNextAutoFitRef.current = false;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: stage === "problem-definition" ? 0.08 : 0.2, duration: 250 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [autoFitSignature, nodes.length, stage]);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      if (!resizeStateRef.current) return;

      const deltaX = event.clientX - resizeStateRef.current.startX;
      if (resizeStateRef.current.side === "left") {
        const nextWidth = Math.min(Math.max(resizeStateRef.current.startWidth + deltaX, 280), 460);
        setLeftPanelWidth(nextWidth);
        return;
      }

      const nextWidth = Math.min(Math.max(resizeStateRef.current.startWidth - deltaX, 300), 500);
      setRightPanelWidth(nextWidth);
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
  const autoLinkEdges = useMemo<Edge[]>(() => {
    if (stage !== "ideation") return [];

    const validNodeIds = new Set(nodes.map((node) => node.id));

    return canvasItems.flatMap((item): Edge[] => {
      const target = `canvas-item-${item.id}`;
      if (!validNodeIds.has(target)) return [];

      const pointSource =
        item.point_id && item.point_id !== target && validNodeIds.has(item.point_id)
          ? item.point_id
          : "";
      const agendaSource =
        item.agenda_id && validNodeIds.has(`agenda-${item.agenda_id}`)
          ? `agenda-${item.agenda_id}`
          : "";
      const source = pointSource || agendaSource;
      if (!source || source === target) return [];

      const linkField: CanvasEdgeData["linkField"] = pointSource ? "point_id" : "agenda_id";

      return [
        {
          id: `auto-link-${source}-${target}`,
          source,
          target,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#475569",
          },
          interactionWidth: 28,
          zIndex: 10,
          style: { stroke: "#475569", strokeOpacity: 0.95, strokeWidth: 2 },
          data: {
            kind: "canvasItemLink",
            canvasItemId: item.id,
            linkField,
          } satisfies CanvasEdgeData,
        },
      ];
    });
  }, [canvasItems, nodes, stage]);
  const displayEdges = useMemo<Edge[]>(() => {
    const autoPairs = new Set(autoLinkEdges.map((edge) => `${edge.source}->${edge.target}`));
    return [
      ...autoLinkEdges,
      ...edges.filter((edge) => !autoPairs.has(`${edge.source}->${edge.target}`)),
    ];
  }, [autoLinkEdges, edges]);
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
  const selectedSolutionTopic = useMemo(
    () => solutionTopics.find((topic) => topic.group_id === selectedSolutionTopicId) || solutionTopics[0] || null,
    [selectedSolutionTopicId, solutionTopics],
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
        ],
        organizeTitle: "안건 정리",
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
      const linkedAgenda =
        agendaModels.find((agenda) => agenda.id === selectedCanvasItem.agenda_id) || null;
      const refinedItems = normalizeRefinedUtterances(selectedCanvasItem.refined_utterances);

      return {
        title: selectedCanvasItem.title,
        subtitle: `${toolLabel((selectedCanvasItem.kind as ComposerTool) || "note")} · 공용 캔버스 아이템`,
        badges: [
          toolLabel((selectedCanvasItem.kind as ComposerTool) || "note"),
          linkedAgenda?.title || "",
        ].filter(Boolean),
        insightLens: "",
        keywords: (selectedCanvasItem.keywords || []).slice(0, 5),
        summaryItems: [
          {
            label: "내용",
            value: selectedCanvasItem.body || "내용이 아직 없습니다.",
          },
        ],
        organizeItems: [
          {
            label: "연결 안건",
            value: linkedAgenda?.title || "연결된 안건이 아직 없습니다.",
          },
          {
            label: "연결 위치",
            value: selectedCanvasItem.point_id || "보드 빈 영역",
          },
        ],
        organizeTitle: "연결 정보",
        refinedItems: refinedItems.map((item, index) => ({
          label: item.speaker || `발화 ${index + 1}`,
          value: item.text,
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
      title: summaryIndex >= 0 ? `핵심 포인트 ${summaryIndex + 1}` : resolvedAgenda.title,
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
              label: `포인트 ${index + 1}`,
              value: stripLeadingTimestamp(value),
            }))
          : [
              {
                label: "포인트 1",
                value: "핵심 포인트가 아직 없습니다.",
              },
            ]),
      ],
      organizeTitle: "핵심 포인트",
    };
  }, [agendaModels, problemGroups, selectedAgenda, selectedCanvasItem, selectedNodeId, selectedProblemGroup, selectedSolutionTopic, stage]);

  const handleGenerateProblemDefinition = async () => {
    setProblemDefinitionStagePending(true);
    setBusy(true);
    try {
      const result = await generateCanvasProblemDefinition({
        meeting_id: meetingId,
        topic: generatedMeetingGoal || meetingTitle || effectiveState?.meeting_goal || "회의 주제",
        agendas: agendaModels.map((agenda) => ({
          agenda_id: agenda.id,
          title: agenda.title,
          keywords: agenda.keywords,
          summary_bullets: agenda.summaryBullets,
        })),
        ideas: personalNotes.map((note) => ({
          id: note.id,
          agenda_id: note.agendaId,
          kind: note.kind,
          title: note.title,
          body: note.body,
        })),
      });
      const nextGroups = hydrateProblemGroups(result.groups, problemGroups);
      problemConclusionEntryHandledRef.current = false;
      setProblemGroups(nextGroups);
      setSelectedProblemGroupId(nextGroups[0]?.group_id || "");
      setSelectedSolutionTopicId("");
      setSelectedNodeId(nextGroups[0] ? `problem-${nextGroups[0].group_id}` : "");
      setEditingProblemGroupId("");
      setEditingSolutionTopicId("");
      setStage("problem-definition");
      if (!sharedSyncEnabled) {
        forceBroadcastSharedCanvas({
          stage: "problem-definition",
          problemGroups: nextGroups,
        });
      }
      setActivityMessage(result.warning || `문제 정의 주제 ${nextGroups.length}개를 생성했습니다.`);
      if (nextGroups.length > 0) {
        problemConclusionEntryHandledRef.current = true;
        await handleGenerateAllProblemGroupConclusions(nextGroups);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`문제 정의 생성 실패: ${message}`);
    } finally {
      setProblemDefinitionStagePending(false);
      setBusy(false);
    }
  };

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
        meeting_topic: generatedMeetingGoal || meetingTitle || effectiveState?.meeting_goal || "회의 주제",
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

      if (problemGroups.length === 0) {
        await handleGenerateProblemDefinition();
        return;
      }

      setStage("problem-definition");
      setSelectedProblemGroupId(problemGroups[0]?.group_id || "");
      setSelectedNodeId(problemGroups[0] ? `problem-${problemGroups[0].group_id}` : "");
      setLeftPanelTab("detail");
      return;
    },
    [
      busy,
      conclusionBatchBusy,
      flushIdeaAssimilationBuffer,
      handleGenerateSolutionStage,
      problemGroups,
      solutionStagePending,
      solutionTopics,
      stage,
    ],
  );

  const handleAddPersonalNote = () => {
    const agendaId = selectedAgendaId || agendaModels[0]?.id;
    if (!agendaId) {
      setActivityMessage("먼저 연결할 그룹을 선택해 주세요.");
      return;
    }

    const nextNote: PersonalNote = {
      id: `note-${Date.now()}`,
      agendaId,
      kind: composerTool,
      title: composerTitle.trim() || `${toolLabel(composerTool)} ${personalNotes.length + 1}`,
      body: composerBody.trim() || "개인 메모를 입력해 두면 나중에 그룹 보드로 이동시킬 수 있습니다.",
    };

    setPersonalNotes((prev) => [nextNote, ...prev]);
    setComposerTitle("");
    setComposerBody("");
    setActivityMessage("개인 메모에 저장했습니다. 이후 그룹 보드로 드래그 편입하는 흐름을 붙일 수 있습니다.");
  };

  const armCanvasTool = (tool: CanvasTool) => {
    if (stage !== "ideation") {
      setActivityMessage("도구 아이템은 아이디어 단계에서만 생성할 수 있습니다.");
      return;
    }
    if (tool !== "group") {
      setComposerTool(tool);
    }
    const isDisarming = armedCanvasTool === tool;
    setArmedCanvasTool(isDisarming ? null : tool);
    setCanvasPlacementPreview((prev) =>
      !prev || isDisarming
        ? null
        : {
            ...prev,
            label: toolLabel(tool),
            hint: toolPreviewHint(tool),
            tone: toolPreviewTone(tool),
          },
    );
    setActivityMessage(
      isDisarming
        ? "보드 클릭 도구를 해제했습니다."
        : tool === "group"
          ? "그룹 도구를 선택했습니다. 보드를 클릭하면 프로젝트 그룹 분류가 생성됩니다."
          : `${toolLabel(tool)} 도구를 선택했습니다. 보드를 클릭하면 공용 canvas 아이템이 생성됩니다.`,
    );
  };

  useEffect(() => {
    if (stage !== "ideation" || !armedCanvasTool) {
      setCanvasPlacementPreview(null);
    }
  }, [armedCanvasTool, stage]);

  const updateCanvasPlacementPreview = useCallback(
    (clientX: number, clientY: number) => {
      if (stage !== "ideation" || !armedCanvasTool || !canvasSurfaceRef.current) {
        setCanvasPlacementPreview(null);
        return;
      }

      const rect = canvasSurfaceRef.current.getBoundingClientRect();
      const previewWidth = 232;
      const previewHeight = 112;
      const x = Math.max(0, Math.min(clientX - rect.left, Math.max(rect.width - previewWidth, 0)));
      const y = Math.max(0, Math.min(clientY - rect.top, Math.max(rect.height - previewHeight, 0)));

      setCanvasPlacementPreview({
        x,
        y,
        label: toolLabel(armedCanvasTool),
        hint: toolPreviewHint(armedCanvasTool),
        tone: toolPreviewTone(armedCanvasTool),
      });
    },
    [armedCanvasTool, stage],
  );

  const clearCanvasPlacementPreview = useCallback(() => {
    setCanvasPlacementPreview(null);
  }, []);

  const handleCanvasPlacementStart = useCallback(
    async (tool: CanvasTool, clientX: number, clientY: number, agendaId?: string, pointId?: string) => {
      if (!flowRef.current || !canvasSurfaceRef.current) {
        return;
      }

      const canvasRect = canvasSurfaceRef.current.getBoundingClientRect();
      const uiX = Math.max(0, Math.min(clientX - canvasRect.left, canvasRect.width));
      const uiY = Math.max(0, Math.min(clientY - canvasRect.top, canvasRect.height));
      const flowPosition = flowRef.current.screenToFlowPosition({ x: clientX, y: clientY });

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
        const nextNodePositionsSnapshot: CanvasNodePositionsByStage = {
          ...nodePositions,
          ideation: {
            ...(nodePositions.ideation || {}),
            [nextNodeId]: {
              x: flowPosition.x,
              y: flowPosition.y,
            },
          },
        };

        suppressNextAutoFitRef.current = true;
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

      const nextAgendaId = agendaId || selectedAgendaId || agendaModels[0]?.id || "";
      const draftTitle = `${toolLabel(tool)} ${canvasItems.filter((item) => item.kind === tool).length + 1}`;
      const nextItemId = `item-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const nextNodeId = `canvas-item-${nextItemId}`;
      const draftBody =
        tool === "topic"
          ? "새 주제를 정리해 주세요."
          : tool === "comment"
            ? "코멘트 내용을 입력해 주세요."
            : "메모 내용을 입력해 주세요.";
      suppressNextAutoFitRef.current = true;
      pendingNodePlacementsRef.current[nextNodeId] = {
        x: flowPosition.x,
        y: flowPosition.y,
      };
      const nextItem: CanvasItemViewModel = {
        id: nextItemId,
        agenda_id: nextAgendaId,
        point_id: pointId || "",
        kind: tool,
        title: draftTitle,
        keywords: [],
        key_evidence: [],
        refined_utterances: [],
        evidence_utterance_ids: [],
        ignored_utterance_ids: [],
        ai_generated: false,
        user_edited: true,
        x: flowPosition.x,
        y: flowPosition.y,
        body: draftBody,
      };
      const nextCanvasItemsSnapshot: CanvasItemViewModel[] = [nextItem, ...canvasItems];
      const nextNodePositionsSnapshot: CanvasNodePositionsByStage = {
        ...nodePositions,
        ideation: {
          ...(nodePositions.ideation || {}),
          [nextNodeId]: {
            x: flowPosition.x,
            y: flowPosition.y,
          },
        },
      };
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
      setNodePositions(nextNodePositionsSnapshot);
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
          nodePositions: nextNodePositionsSnapshot,
        });
        if (meetingId) {
          void saveCanvasWorkspacePatch({
            meeting_id: meetingId,
            canvas_items: serializeSharedCanvasItems(nextCanvasItemsSnapshot),
            node_positions: nextNodePositionsSnapshot,
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
      meetingId,
      nodePositions,
      persistedSharedImportedState,
      problemGroups,
      selectedAgendaId,
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

  const onNodeDragStop = (_event: React.MouseEvent, node: Node) => {
    if (!workspaceLoadedRef.current || workspaceHydratingRef.current || applyingRemoteSharedSyncRef.current) {
      return;
    }

    const currentPosition = nodePositions[stage]?.[node.id];
    if (currentPosition && currentPosition.x === node.position.x && currentPosition.y === node.position.y) {
      return;
    }

    if (!sharedSyncEnabled) {
      localNodeOverridesRef.current[stage].add(node.id);
    }

    const nextPositionsSnapshot: CanvasNodePositionsByStage = {
      ...nodePositions,
      [stage]: {
        ...(nodePositions[stage] || {}),
        [node.id]: {
          x: node.position.x,
          y: node.position.y,
        },
      },
    };

    let nextCanvasItemsSnapshot: CanvasItemViewModel[] | null = null;
    if (stage === "ideation" && node.id.startsWith("canvas-item-")) {
      const canvasItemId = node.id.slice("canvas-item-".length);
      nextCanvasItemsSnapshot = canvasItems.map((item) =>
        item.id === canvasItemId
          ? {
              ...item,
              x: node.position.x,
              y: node.position.y,
            }
          : item,
      );
      setCanvasItems(nextCanvasItemsSnapshot);
    }

    latestSharedWorkspaceRef.current = {
      ...latestSharedWorkspaceRef.current,
      stage,
      canvasItems: nextCanvasItemsSnapshot || canvasItems,
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
            stage,
            agendaOverrides,
            canvasItems: nextCanvasItemsSnapshot || canvasItems,
            customGroups,
            problemGroups,
            solutionTopics,
            nodePositions: nextPositionsSnapshot,
            importedState: persistedSharedImportedState,
          }),
        );
      }
      forceBroadcastSharedCanvas({
        nodePositions: nextPositionsSnapshot,
        canvasItems: nextCanvasItemsSnapshot || undefined,
      });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          stage,
          canvas_items: nextCanvasItemsSnapshot
            ? serializeSharedCanvasItems(nextCanvasItemsSnapshot)
            : undefined,
          node_positions: nextPositionsSnapshot,
          imported_state: persistedSharedImportedState,
        }).catch((error) => {
          console.error("Failed to save shared node positions:", error);
        });
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

  const handleClearCanvasItemLink = (targetItemId: string, field: "agenda_id" | "point_id") => {
    if (!targetItemId) return;

    const targetItem = canvasItems.find((item) => item.id === targetItemId);
    if (!targetItem || !targetItem[field]) {
      setActivityMessage(field === "agenda_id" ? "해제할 연결 안건이 없습니다." : "해제할 연결 위치가 없습니다.");
      return;
    }

    const nextCanvasItemsSnapshot = canvasItems.map((item) =>
      item.id === targetItemId
        ? {
            ...item,
            [field]: "",
          }
        : item,
    );

    setCanvasItems(nextCanvasItemsSnapshot);
    setSelectedCanvasItemId(targetItemId);
    setSelectedNodeId(`canvas-item-${targetItemId}`);
    if (field === "agenda_id") {
      setActivityMessage("공용 canvas 아이템의 연결 안건을 해제했습니다.");
    } else {
      setActivityMessage("공용 canvas 아이템의 연결 위치를 해제했습니다.");
    }

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
  };

  const handleSetCanvasItemAgendaLink = (targetItemId: string, agendaId: string) => {
    if (!targetItemId || !agendaId) return;

    const targetAgenda = agendaModels.find((agenda) => agenda.id === agendaId);
    if (!targetAgenda) {
      setActivityMessage("연결할 안건을 찾을 수 없습니다.");
      return;
    }

    const nextCanvasItemsSnapshot = canvasItems.map((item) =>
      item.id === targetItemId
        ? {
            ...item,
            agenda_id: agendaId,
            point_id: "",
          }
        : item,
    );

    setCanvasItems(nextCanvasItemsSnapshot);
    setSelectedCanvasItemId(targetItemId);
    setSelectedNodeId(`canvas-item-${targetItemId}`);
    setSelectedAgendaId(agendaId);
    setActivityMessage(`공용 canvas 아이템을 "${targetAgenda.title}" 안건에 연결했습니다.`);

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
          console.error("Failed to save shared canvas item agenda link:", error);
        });
      }
    }
  };

  const handleAddProjectGroupCategory = (connectCanvasItemId?: string) => {
    const title = customGroupDraftTitle.trim();
    if (!title) {
      setActivityMessage("추가할 프로젝트 그룹 분류명을 입력해 주세요.");
      return;
    }

    const existingGroup = customGroups.find(
      (group) => group.title.trim().toLowerCase() === title.toLowerCase(),
    );
    if (existingGroup) {
      setCustomGroupDraftTitle("");
      setSelectedAgendaId(existingGroup.id);
      if (connectCanvasItemId) {
        handleSetCanvasItemAgendaLink(connectCanvasItemId, existingGroup.id);
      } else {
        setActivityMessage(`이미 있는 프로젝트 그룹 분류 "${existingGroup.title}"을 선택했습니다.`);
      }
      return;
    }

    const now = new Date().toISOString();
    const nextGroup: CustomGroupViewModel = {
      id: `project-group-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      title,
      description: "사용자가 프로젝트에 직접 추가한 그룹 분류입니다.",
      keywords: [],
      color: "",
      created_by: userId,
      created_at: now,
    };
    const nextCustomGroupsSnapshot = [nextGroup, ...customGroups];
    const nextCanvasItemsSnapshot = connectCanvasItemId
      ? canvasItems.map((item) =>
          item.id === connectCanvasItemId
            ? {
                ...item,
                agenda_id: nextGroup.id,
                point_id: "",
              }
            : item,
        )
      : canvasItems;

    setCustomGroups(nextCustomGroupsSnapshot);
    setCustomGroupDraftTitle("");
    setSelectedAgendaId(nextGroup.id);
    if (connectCanvasItemId) {
      setCanvasItems(nextCanvasItemsSnapshot);
      setSelectedCanvasItemId(connectCanvasItemId);
      setSelectedNodeId(`canvas-item-${connectCanvasItemId}`);
    }
    setActivityMessage(
      connectCanvasItemId
        ? `프로젝트 그룹 분류 "${title}"을 추가하고 선택한 아이템에 연결했습니다.`
        : `프로젝트 그룹 분류 "${title}"을 추가했습니다.`,
    );

    if (sharedSyncEnabled) {
      latestSharedWorkspaceRef.current = {
        ...latestSharedWorkspaceRef.current,
        customGroups: nextCustomGroupsSnapshot,
        canvasItems: nextCanvasItemsSnapshot,
        importedState: persistedSharedImportedState,
      };
      forceBroadcastSharedCanvas({
        customGroups: nextCustomGroupsSnapshot,
        canvasItems: connectCanvasItemId ? nextCanvasItemsSnapshot : undefined,
      });
      if (meetingId) {
        void saveCanvasWorkspacePatch({
          meeting_id: meetingId,
          custom_groups: serializeCustomGroups(nextCustomGroupsSnapshot),
          canvas_items: connectCanvasItemId ? serializeSharedCanvasItems(nextCanvasItemsSnapshot) : undefined,
        }).catch((error) => {
          console.error("Failed to save project group categories:", error);
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
    const nextNodePositionsSnapshot: CanvasNodePositionsByStage = {
      ...nodePositions,
      ideation: ideationPositions,
    };
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
    setSolutionTopics((prev) =>
      prev.map((topic) =>
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
      ),
    );
  };

  const handleUpdateFinalSolutionComment = (topicId: string, noteId: string, value: string) => {
    setSolutionTopics((prev) =>
      prev.map((topic) =>
        topic.group_id === topicId
          ? {
              ...topic,
              notes: topic.notes.map((note) =>
                note.id === noteId
                  ? makeSolutionNote(
                      {
                        ...note,
                        final_comment: value,
                      },
                      note.id,
                    )
                  : makeSolutionNote(note, note.id),
              ),
            }
          : topic,
      ),
    );
  };

  const startPanelResize = (side: "left" | "right") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isDesktopLayout) return;
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftPanelWidth : rightPanelWidth,
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
  }, [agendaModels.length, busy, problemGroups.length, stage]);

  const handleStopRecordingClick = async () => {
    await onStopRecording?.();
    await flushIdeaAssimilationBuffer("manual");
  };

  const handleEndMeetingClick = async () => {
    await flushIdeaAssimilationBuffer("stage-change");
    await onEndMeeting?.();
  };

  const canvasStatusMessage = activityMessage || audioImportStatusText || recordingStatusText;

  return (
    <div className="h-full min-h-0 bg-[#f9f9f9] text-black">
      <section className="flex h-full min-h-0 flex-col bg-[#f9f9f9]">
        <div className="relative z-20 border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]">
          <div className="grid min-h-[141px] grid-cols-[minmax(280px,1fr)_minmax(320px,760px)_minmax(360px,1fr)] items-center gap-4 px-[33px] py-4">
            <div className="flex flex-wrap items-center justify-start gap-2 justify-self-start">
              <button
                type="button"
                onClick={() => void handleEndMeetingClick()}
                className="h-[43px] rounded-[8px] bg-[#ef4e4e] px-6 text-xl font-semibold text-white hover:bg-[#df3f3f]"
              >
                종료
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
                className={`h-[43px] rounded-[8px] px-4 text-sm font-semibold ${
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
                className="h-[43px] rounded-[8px] bg-[#eff0f6] px-3 text-sm font-semibold text-[#4d4d4d] hover:bg-[#e3e5ee]"
              >
                {syncModeLabel(sharedSyncEnabled)}
              </button>
              <button
                type="button"
                disabled={audioImportBusy}
                onClick={() => fileInputRef.current?.click()}
                className="h-[43px] rounded-[8px] bg-[#eff0f6] px-3 text-sm font-semibold text-[#4d4d4d] hover:bg-[#e3e5ee] disabled:cursor-not-allowed disabled:opacity-50"
              >
                불러오기
              </button>
            </div>

            <div className="min-w-0 justify-self-center text-center">
              <div className="flex items-center justify-center gap-2 text-[20px] font-normal leading-[24.811px] text-[#4d4d4d]">
                <span>{meetingTitle || "회의 제목"}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${isRecording ? "bg-[#34c759]" : "bg-[#d9d9d9]"}`} />
              </div>
              <h2 className="mt-3 truncate text-[32px] font-semibold leading-[38px] tracking-normal text-black">
                {meetingGoalBusy ? "회의 목표를 정리하는 중입니다." : displayMeetingGoal}
              </h2>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-4 justify-self-end">
              <div className="flex items-center gap-5">
                {(["ideation", "problem-definition", "solution"] as CanvasStage[]).map((item, index) => (
                  <div key={item} className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => void handleStageSelect(item)}
                      className={`rounded-[8px] border px-4 py-2 text-[20px] font-semibold leading-[24.811px] transition ${
                        stage === item
                          ? "border-[#1b59f8]/20 bg-[rgba(27,89,248,0.1)] text-[#1b59f8]"
                          : "border-black/10 bg-white text-black/50 hover:border-[#1b59f8]/20 hover:bg-[rgba(27,89,248,0.1)] hover:text-[#1b59f8]"
                      }`}
                    >
                      {stageLabel(item)}
                    </button>
                    {index < 2 ? <span className="text-2xl text-black/30">›</span> : null}
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
          className="grid flex-1 min-h-0 grid-cols-1 bg-black/10 xl:gap-px xl:border-x xl:border-b xl:border-black/10"
          style={isDesktopLayout ? { gridTemplateColumns: `${leftPanelWidth}px minmax(0,1fr) ${rightPanelWidth}px` } : undefined}
        >
          <aside className="imms-side-panel imms-left-panel relative border-b border-black/10 bg-[#f9f9f9] shadow-[inset_-1px_0_0_rgba(0,0,0,0.04)] xl:min-h-0 xl:border-b-0">
            <button
              type="button"
              aria-label="왼쪽 패널 너비 조절"
              onMouseDown={startPanelResize("left")}
              className="absolute right-[-12px] top-0 z-10 hidden h-full w-5 cursor-ew-resize xl:block"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-black/10" />
            </button>
            <div className="imms-overlay-scroll h-full px-5 py-6 xl:overflow-y-auto">
            <div className="imms-side-panel-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-black">내용 상세보기</h3>
                <p className="mt-[18px] text-base font-normal text-[#4d4d4d]">내용</p>
              </div>
              <span className="rounded-full border border-black/10 bg-[#eff0f6] px-3 py-1 text-sm text-[#4d4d4d]">
                {leftPanelTab === "detail" ? "선택 정보" : `${agendaModels.length}개 그룹`}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-2 rounded-2xl border border-black/10 bg-[#f9f9f9] p-1">
              <button
                type="button"
                onClick={() => setLeftPanelTab("detail")}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${leftPanelTab === "detail" ? "bg-[#1b59f8] text-white" : "text-[#4d4d4d] hover:bg-white hover:text-black"}`}
              >
                디테일
              </button>
              <button
                type="button"
                onClick={() => setLeftPanelTab("agenda-list")}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${leftPanelTab === "agenda-list" ? "bg-[#1b59f8] text-white" : "text-[#4d4d4d] hover:bg-white hover:text-black"}`}
              >
                안건 목록
              </button>
            </div>
            </div>

            {leftPanelTab === "detail" ? (
              <div className="imms-left-panel-detail mt-4">
                {leftPanelDetail ? (
                  <>
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

                    {stage === "problem-definition" && selectedProblemGroup ? (
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
                    ) : null}

                    {stage !== "solution" ? (
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
                            placeholder="한 줄에 하나씩 핵심 요약 또는 포인트를 입력합니다."
                          />
                          <p className="mt-3 text-sm leading-6 text-slate-500">
                            줄 단위로 저장되며, ideation 안건 노드와 상세 포인트에 함께 반영됩니다.
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
                    ) : null}

                    {stage === "solution" && selectedSolutionTopic ? (
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
                              selectedSolutionTopic.notes.map((note, index) => (
                                <div key={note.id} className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-4">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-amber-700">
                                        {note.source === "ai" ? `채택 메모 ${index + 1}` : `사용자 메모 ${index + 1}`}
                                      </p>
                                      <p className="mt-2 text-base leading-7 text-slate-700">{note.text}</p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleToggleFinalSolutionNote(selectedSolutionTopic.group_id, note.id)}
                                      className={`shrink-0 rounded-xl px-3 py-2 text-sm font-medium ${
                                        note.is_final_candidate
                                          ? "bg-slate-900 text-white"
                                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                      }`}
                                    >
                                      {note.is_final_candidate ? "최종 결론" : "결론 후보"}
                                    </button>
                                  </div>
                                  {note.is_final_candidate ? (
                                    <textarea
                                      value={note.final_comment || ""}
                                      onChange={(event) =>
                                        handleUpdateFinalSolutionComment(
                                          selectedSolutionTopic.group_id,
                                          note.id,
                                          event.target.value,
                                        )
                                      }
                                      placeholder="추가 설명을 입력할 수 있습니다."
                                      className="mt-3 min-h-[84px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700"
                                    />
                                  ) : null}
                                </div>
                              ))
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
                            <h4 className="text-lg font-semibold text-slate-900">최종 결론 모음</h4>
                            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                              {allSolutionFinalNotes.length}개
                            </span>
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
                    ) : (
                    stage === "ideation" && selectedCanvasItem && leftPanelDetail.organizeTitle === "연결 정보" ? (
                      <section className="pt-6">
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="text-lg font-semibold text-slate-900">연결</h4>
                          <span className="rounded-full border border-black/10 bg-[#e9efff] px-3 py-1 text-xs font-semibold text-[#1b59f8]">
                            공용 아이템
                          </span>
                        </div>
                        <div className="mt-4 space-y-3">
                          <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-[#4d4d4d]">그룹 분류</p>
                                <p className="mt-1 truncate text-base font-semibold leading-7 text-slate-900">
                                  {agendaModels.find((agenda) => agenda.id === selectedCanvasItem.agenda_id)?.title || "아직 연결된 그룹이 없습니다."}
                                </p>
                              </div>
                              {selectedCanvasItem.agenda_id ? (
                                <button
                                  type="button"
                                  onClick={() => handleClearCanvasItemLink(selectedCanvasItem.id, "agenda_id")}
                                  className="shrink-0 rounded-full border border-black/10 bg-[#fafafa] px-3 py-1.5 text-xs font-medium text-[#4d4d4d] hover:bg-[#eff0f6]"
                                >
                                  해제
                                </button>
                              ) : null}
                            </div>
                            <select
                              value={selectedCanvasItem.agenda_id || ""}
                              onChange={(event) => {
                                const nextAgendaId = event.target.value;
                                if (nextAgendaId) {
                                  handleSetCanvasItemAgendaLink(selectedCanvasItem.id, nextAgendaId);
                                }
                              }}
                              className="mt-3 w-full rounded-xl border border-black/10 bg-[#fafafa] px-3 py-2.5 text-sm text-[#4d4d4d] focus:outline-none"
                            >
                              <option value="">그룹 분류 선택</option>
                              {agendaModels.map((agenda) => (
                                <option key={`${selectedCanvasItem.id}-agenda-link-${agenda.id}`} value={agenda.id}>
                                  {agenda.title}
                                </option>
                              ))}
                            </select>
                            <details className="mt-3 rounded-xl border border-dashed border-black/10 bg-[#fafafa] p-3">
                              <summary className="cursor-pointer text-xs font-semibold text-[#4d4d4d]">
                                새 그룹 분류 추가
                              </summary>
                              <div className="mt-3 flex gap-2">
                                <input
                                  value={customGroupDraftTitle}
                                  onChange={(event) => setCustomGroupDraftTitle(event.target.value)}
                                  placeholder="예: 고객 경험"
                                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-[#4d4d4d]"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleAddProjectGroupCategory(selectedCanvasItem.id)}
                                  className="shrink-0 rounded-lg bg-[#1b59f8] px-3 py-2 text-xs font-semibold text-white hover:bg-[#164be0]"
                                >
                                  추가
                                </button>
                              </div>
                            </details>
                          </div>

                          <div className="rounded-2xl border border-black/10 bg-[#fafafa] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-[#4d4d4d]">보드 위치</p>
                                <p className="mt-1 break-all text-sm leading-6 text-slate-700">
                                  {selectedCanvasItem.point_id ? selectedCanvasItem.point_id : "보드 빈 영역에 배치됨"}
                                </p>
                              </div>
                              {selectedCanvasItem.point_id ? (
                                <button
                                  type="button"
                                  onClick={() => handleClearCanvasItemLink(selectedCanvasItem.id, "point_id")}
                                  className="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-[#4d4d4d] hover:bg-[#eff0f6]"
                                >
                                  해제
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </section>
                    ) : (
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
                    )
                    )}
                    {stage === "ideation" && selectedCanvasItem && leftPanelDetail.refinedItems?.length ? (
                      <section className="pt-6">
                        <h4 className="text-lg font-semibold text-slate-900">정리된 발화</h4>
                        <div className="mt-4 space-y-3">
                          {leftPanelDetail.refinedItems.map((item, index) => (
                            <div key={`${leftPanelDetail.title}-refined-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                              <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                              <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-700">{stripLeadingTimestamp(item.value)}</p>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}
                    {stage === "problem-definition" && leftPanelDetail.evidenceItems?.length ? (
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
                    {stage === "problem-definition" ? (
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
                    ) : null}
                  </>
                ) : (
                  <p className="pt-6 text-base leading-7 text-slate-500">
                    보드에서 그룹 카드를 선택하면 요약, 키워드, 안건 정리 내용이 여기에 표시됩니다.
                  </p>
                )}
              </div>
            ) : (
              <div className="imms-left-panel-detail mt-4 space-y-3">
                <section className="border-b border-slate-200/80 pb-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-lg font-semibold text-slate-900">안건 목록</h4>
                    <span className="text-sm text-slate-500">{agendaModels.length}개 그룹</span>
                  </div>
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4">
                    <p className="text-sm font-semibold text-slate-800">프로젝트 그룹 분류 추가</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      회의에서 자동 생성된 안건과 별개로, 이 프로젝트에서 함께 쓸 분류를 추가합니다.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <input
                        value={customGroupDraftTitle}
                        onChange={(event) => setCustomGroupDraftTitle(event.target.value)}
                        placeholder="예: 고객 경험, 기술 리스크"
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddProjectGroupCategory()}
                        className="shrink-0 rounded-xl bg-[#1b59f8] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_1px_0_rgba(0,0,0,0.04)] hover:bg-[#164be0]"
                      >
                        추가
                      </button>
                    </div>
                    {!sharedSyncEnabled ? (
                      <p className="mt-2 text-xs leading-5 text-amber-700">
                        공유 OFF 상태라 지금 추가한 분류는 내 화면에만 저장됩니다.
                      </p>
                    ) : null}
                  </div>
                  <div className="mt-4 space-y-3">
                    {agendaModels.map((agenda) => {
                      const linkedRefinedSentences = splitRefinedUtteranceSentences(
                        canvasItems
                          .filter((item) => item.agenda_id === agenda.id)
                          .flatMap((item) => item.refined_utterances || []),
                        6,
                      );

                      return (
                        <button
                          key={agenda.id}
                          type="button"
                          onClick={() => {
                            setSelectedAgendaId(agenda.id);
                            setSelectedNodeId("");
                            setLeftPanelTab("detail");
                          }}
                          className={`w-full rounded-xl border px-4 py-4 text-left transition ${selectedAgendaId === agenda.id ? "border-slate-300 bg-white" : "border-slate-200 bg-[#fafafa] hover:bg-white"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <strong className="text-base text-slate-900">{agenda.title}</strong>
                            {agenda.isCustom ? (
                              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                                프로젝트 분류
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-500">{agenda.summaryBullets[0] || "요약이 아직 없습니다."}</p>
                          {linkedRefinedSentences.length > 0 ? (
                            <div className="mt-3 space-y-1.5 rounded-xl bg-white/80 px-3 py-2">
                              {linkedRefinedSentences.map((item, index) => (
                                <p key={`${agenda.id}-refined-${item.utterance_id}-${index}`} className="text-xs leading-5 text-slate-500">
                                  <span className="font-semibold text-slate-600">{item.speaker}</span>: {item.text}
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h4 className="text-lg font-semibold text-slate-900">단계 결과</h4>
                  <div className="mt-4 space-y-3">
                    {problemGroups.length === 0 && solutionTopics.length === 0 ? (
                      <p className="text-base leading-7 text-slate-500">개인 메모를 모은 뒤 문제 정의와 해결책 생성을 진행하면 결과가 이 패널에 정리됩니다.</p>
                    ) : null}
                    {problemGroups.map((group) => (
                      <button
                        key={group.group_id}
                        type="button"
                        onClick={() => {
                          setStage("problem-definition");
                          setSelectedProblemGroupId(group.group_id);
                          setSelectedNodeId(`problem-${group.group_id}`);
                          setLeftPanelTab("detail");
                        }}
                        className={`w-full rounded-xl border p-4 text-left ${selectedProblemGroupId === group.group_id ? "border-violet-200 bg-violet-50/70" : "border-slate-200 bg-[#fafafa]"}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">문제 정의</p>
                          <span className={`rounded-full px-2.5 py-1 text-xs ${problemGroupStatusTone(group.status)}`}>{problemGroupStatusLabel(group.status)}</span>
                        </div>
                        <h4 className="mt-1 text-base font-semibold text-slate-900">{group.topic}</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{group.conclusion}</p>
                      </button>
                    ))}
                    {solutionTopics.map((topic) => (
                      <button
                        key={topic.group_id}
                        type="button"
                        onClick={() => {
                          setStage("solution");
                          setSelectedSolutionTopicId(topic.group_id);
                          setSelectedProblemGroupId("");
                          setSelectedNodeId(`solution-${topic.group_id}`);
                          setLeftPanelTab("detail");
                        }}
                        className={`w-full rounded-xl border p-4 text-left ${
                          selectedSolutionTopicId === topic.group_id
                            ? "border-emerald-200 bg-emerald-50/80"
                            : "border-emerald-200 bg-emerald-50/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">해결책</p>
                          <span className={`rounded-full px-2.5 py-1 text-xs ${problemGroupStatusTone(topic.status || "draft")}`}>
                            {problemGroupStatusLabel((topic.status as ProblemGroupStatus) || "draft")}
                          </span>
                        </div>
                        <h4 className="mt-1 text-base font-semibold text-slate-900">{topic.topic}</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {topic.conclusion || topic.problem_conclusion || "해결 방향이 아직 없습니다."}
                        </p>
                        <p className="mt-2 text-xs text-slate-500">
                          AI 초안 {topic.ai_suggestions.length}개 · 메모 {topic.notes.length}개
                        </p>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}
            </div>
          </aside>

          <section ref={canvasSurfaceRef} className="relative flex h-full min-h-0 flex-col overflow-hidden border-b border-black/10 bg-[#f9f9f9] shadow-[inset_0_1px_0_rgba(0,0,0,0.04)] xl:border-b-0">
            <div className="relative grid min-h-[135px] shrink-0 grid-cols-1 divide-y divide-black/10 border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)] md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="pointer-events-none absolute left-4 top-3 z-10 flex max-w-[calc(100%-2rem)] flex-wrap gap-2">
                <span className="rounded-full border border-blue-100 bg-blue-50/95 px-3 py-1 text-xs font-semibold text-blue-700 shadow-sm">
                  {sttProgressText || liveFlowHint || "현재 발언 흐름 대기 중"}
                </span>
                {ideaAssimilationStatus ? (
                  <span className="rounded-full border border-black/10 bg-white/95 px-3 py-1 text-xs font-medium text-[#4d4d4d] shadow-sm">
                    {ideaAssimilationStatus}
                  </span>
                ) : null}
              </div>
              {transcriptStripItems.slice(0, 3).map((item, index) => (
                <div key={`${item.timestamp || index}-${index}`} className="flex min-h-[135px] items-center gap-8 px-9 py-4">
                  <span className="h-12 w-12 shrink-0 rounded-full bg-[#d9d9d9]" />
                  <div className="min-w-0 text-base leading-[1.55] text-[#4d4d4d]">
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
              <ReactFlow
                nodes={nodes}
                edges={renderedEdges}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                onNodeClick={(event, node) => {
                  setSelectedEdgeId("");
                  setSelectedNodeId(node.id);
                  setLeftPanelTab("detail");
                  const agendaId = extractAgendaIdFromNodeId(node.id);
                  if (node.id.startsWith("canvas-item-")) {
                    const canvasItemId = node.id.slice("canvas-item-".length);
                    const canvasItem = canvasItems.find((item) => item.id === canvasItemId) || null;
                    setSelectedCanvasItemId(canvasItemId);
                    setSelectedProblemGroupId("");
                    setSelectedSolutionTopicId("");
                    setEditingProblemGroupId("");
                    setEditingSolutionTopicId("");
                    if (canvasItem?.agenda_id) {
                      setSelectedAgendaId(canvasItem.agenda_id);
                    }
                  } else {
                    setSelectedCanvasItemId("");
                  }
                  if (node.id.startsWith("problem-")) {
                    setSelectedProblemGroupId(node.id.slice("problem-".length));
                    setSelectedSolutionTopicId("");
                    setSelectedCanvasItemId("");
                    setEditingProblemGroupId("");
                  }
                  if (node.id.startsWith("solution-")) {
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
                }}
                onEdgeClick={(event, edge) => {
                  event.stopPropagation();
                  setSelectedEdgeId(edge.id);
                  setSelectedNodeId("");
                  setSelectedCanvasItemId("");
                  setSelectedProblemGroupId("");
                  setSelectedSolutionTopicId("");
                }}
                onPaneClick={(event) => {
                  setSelectedEdgeId("");
                  if (!armedCanvasTool) {
                    return;
                  }
                  setSelectedCanvasItemId("");
                  void handleCanvasPlacementStart(
                    armedCanvasTool,
                    event.clientX,
                    event.clientY,
                    selectedAgendaId || agendaModels[0]?.id,
                  );
                }}
                onNodesChange={onNodesChange}
                onNodeDragStop={onNodeDragStop}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
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
              <div className="pointer-events-none absolute inset-x-0 bottom-[104px] z-10 flex justify-center px-4">
                <div className="max-w-[min(640px,calc(100%-32px))] rounded-full border border-black/10 bg-white/95 px-4 py-2 text-center text-xs leading-5 text-[#4d4d4d] shadow-[0_5.64px_22.56px_rgba(0,0,0,0.05)] backdrop-blur-sm">
                  {canvasStatusMessage}
                </div>
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-x-0 bottom-8 z-10 flex justify-center px-3">
              <div className="pointer-events-auto flex min-h-[60px] w-auto max-w-[calc(100%-24px)] items-center justify-center gap-2 rounded-[16px] border border-black/10 bg-white px-3 py-2 text-[#4d4d4d] shadow-[0_5.64px_22.56px_rgba(0,0,0,0.05)]">
                {(["note", "comment", "topic", "group"] as CanvasTool[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => armCanvasTool(item)}
                    disabled={stage !== "ideation"}
                    className={`flex h-10 min-w-[92px] shrink-0 items-center justify-center rounded-[12px] px-4 text-base font-medium transition-all duration-150 ease-out ${
                      armedCanvasTool === item
                        ? "bg-[#1b59f8]/10 text-[#1b59f8]"
                        : "text-[#4d4d4d] hover:bg-black/5"
                    } disabled:cursor-not-allowed disabled:opacity-45`}
                  >
                    <span>{toolLabel(item)}</span>
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

          <aside className="imms-side-panel imms-right-panel imms-overlay-scroll relative bg-[#f9f9f9] px-5 py-6 shadow-[inset_1px_0_0_rgba(0,0,0,0.04)] xl:min-h-0 xl:overflow-y-auto">
            <button
              type="button"
              aria-label="오른쪽 패널 너비 조절"
              onMouseDown={startPanelResize("right")}
              className="absolute left-[-7px] top-0 hidden h-full w-4 cursor-ew-resize xl:block"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-black/10" />
            </button>
            <section className="imms-side-panel-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-black/50">개인 노트</p>
                  <h3 className="mt-1 text-xl font-semibold text-black">개인 노트</h3>
                </div>
                <span className="rounded-full border border-black/10 bg-[#eff0f6] px-3 py-1 text-sm font-medium text-[#4d4d4d]">{personalNotes.length}개</span>
              </div>
              <div className="mt-4 space-y-3">
                <select value={selectedAgendaId} onChange={(event) => setSelectedAgendaId(event.target.value)} className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base text-[#4d4d4d] focus:border-black/30 focus:outline-none">
                  {agendaModels.map((agenda) => (
                    <option key={agenda.id} value={agenda.id}>
                      {agenda.title}
                    </option>
                  ))}
                </select>
                <input value={composerTitle} onChange={(event) => setComposerTitle(event.target.value)} placeholder="메모 제목" className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base text-[#4d4d4d] focus:border-black/30 focus:outline-none" />
                <textarea ref={composerBodyRef} value={composerBody} onChange={(event) => setComposerBody(event.target.value)} placeholder="메모 내용" className="min-h-[118px] w-full rounded-2xl border border-black/10 bg-white px-4 py-3.5 text-base leading-7 text-[#4d4d4d] focus:border-black/30 focus:outline-none" />
                <button type="button" onClick={handleAddPersonalNote} className="ml-auto block rounded-full bg-[#eff0f6] px-5 py-2 text-sm font-medium text-[#4d4d4d] hover:bg-[#e3e5ee]">
                  개인 메모 저장
                </button>
              </div>
            </section>

            <section className="imms-side-panel-surface mt-4 p-4">
              <h3 className="text-lg font-semibold text-black">내 메모 목록</h3>
              {stage === "problem-definition" ? (
                <p className="mt-2 text-sm leading-6 text-slate-500">메모 카드를 문제 정의 그룹으로 드래그해서 편입할 수 있습니다.</p>
              ) : null}
              <div className="mt-4 space-y-3">
                {personalNotes.length === 0 ? (
                  <p className="text-base leading-7 text-slate-500">아직 저장한 개인 메모가 없습니다.</p>
                ) : (
                  personalNotes.map((note) => {
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
                          setDraggingPersonalNoteId(note.id);
                        }}
                        onDragEnd={() => {
                          setDraggingPersonalNoteId("");
                          setDropProblemGroupId("");
                        }}
                        className={`rounded-xl border border-black/10 bg-white p-4 shadow-[0_1px_0_rgba(0,0,0,0.04)] ${stage === "problem-definition" && !isEditing ? "cursor-grab active:cursor-grabbing" : ""} ${draggingPersonalNoteId === note.id ? "opacity-60" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600">{toolLabel(note.kind)}</p>
                            {isEditing ? (
                              <input
                                value={personalNoteDraftTitle}
                                onChange={(event) => setPersonalNoteDraftTitle(event.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base font-semibold text-slate-900"
                              />
                            ) : (
                              <h4 className="mt-1 text-base font-semibold text-slate-900">{note.title}</h4>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            {isEditing ? (
                              <>
                                <button type="button" onClick={handleCancelPersonalNoteEdit} className="text-sm font-medium text-slate-500 hover:text-slate-700">
                                  취소
                                </button>
                                <button type="button" onClick={() => handleSavePersonalNoteEdit(note.id)} className="text-sm font-medium text-slate-700 hover:text-slate-900">
                                  저장
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" onClick={() => handleStartPersonalNoteEdit(note)} className="text-sm font-medium text-slate-400 hover:text-slate-600">
                                  수정
                                </button>
                                <button type="button" onClick={() => handleDeletePersonalNote(note.id)} className="text-sm font-medium text-slate-400 hover:text-slate-600">
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
                              onChange={(event) => setPersonalNoteDraftAgendaId(event.target.value)}
                              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700"
                            >
                              {agendaModels.map((agenda) => (
                                <option key={agenda.id} value={agenda.id}>
                                  {agenda.title}
                                </option>
                              ))}
                            </select>
                            <textarea
                              value={personalNoteDraftBody}
                              onChange={(event) => setPersonalNoteDraftBody(event.target.value)}
                              className="mt-3 min-h-[140px] w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base leading-7 text-slate-700"
                            />
                          </>
                        ) : (
                          <p className="mt-2 text-base leading-7 text-slate-600">{note.body}</p>
                        )}
                        <p className="mt-3 text-sm text-slate-400">연결 그룹: {agendaModels.find((agenda) => agenda.id === (isEditing ? personalNoteDraftAgendaId : note.agendaId))?.title || "미지정"}</p>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}
