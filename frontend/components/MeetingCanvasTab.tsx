"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
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
  generateMeetingGoal,
  generateProblemGroupConclusion,
  generateCanvasProblemDefinition,
  generateCanvasSolutionStage,
  importAgendaSnapshot,
  saveCanvasPersonalNotes,
  saveCanvasWorkspacePatch,
} from "@/lib/api";
import type {
  AgendaActionItemDetail,
  AgendaDecisionDetail,
  CanvasNodePositionsByStage,
  CanvasProblemDefinitionGroup,
  CanvasRealtimeSyncPayload,
  CanvasSolutionTopicResponse,
  MeetingState,
  TranscriptUtterance,
} from "@/lib/types";

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
  problem_groups: string;
  solution_topics: string;
  node_positions: string;
  imported_state: string;
};

function createWorkspaceFieldSignatures(): WorkspaceFieldSignatures {
  return {
    stage: "",
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

function buildWorkspaceFieldSignatures(input: {
  stage: CanvasStage;
  problemGroups: ProblemGroupViewModel[];
  solutionTopics: SolutionTopicViewModel[];
  nodePositions: CanvasNodePositionsByStage;
  importedState: MeetingState | null;
}): WorkspaceFieldSignatures {
  return {
    stage: input.stage,
    problem_groups: JSON.stringify(buildWorkspaceProblemGroupsPayload(input.problemGroups)),
    solution_topics: JSON.stringify(buildWorkspaceSolutionTopicsPayload(input.solutionTopics)),
    node_positions: JSON.stringify(input.nodePositions || {}),
    imported_state: JSON.stringify(input.importedState || null),
  };
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
  syncStatusText: string;
  autoSyncing: boolean;
};

function stageLabel(stage: CanvasStage) {
  if (stage === "ideation") return "아이디어";
  if (stage === "problem-definition") return "문제정의";
  return "해결책";
}

function syncModeLabel(enabled: boolean) {
  return enabled ? "공유 ON" : "공유 OFF";
}

function toolLabel(tool: ComposerTool) {
  if (tool === "note") return "메모";
  if (tool === "comment") return "코멘트";
  return "주제";
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

function stripLeadingTimestamp(text: string) {
  return text.replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/, "").trim();
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
        title: outcome.agenda_title || `안건 ${index + 1}`,
        status: outcome.agenda_state || "PROPOSED",
        keywords: outcome.agenda_keywords || [],
        summaryBullets:
          (outcome.agenda_summary_items || []).filter(Boolean).slice(0, 4).length > 0
            ? (outcome.agenda_summary_items || []).filter(Boolean).slice(0, 4)
            : [outcome.summary].filter(Boolean),
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

type CanvasNodeDescriptor = {
  id: string;
  position: { x: number; y: number };
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
    const nextPosition = descriptor.position;
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
  syncStatusText,
  autoSyncing,
}: MeetingCanvasTabProps) {
  const [stage, setStage] = useState<CanvasStage>("ideation");
  const [composerTool, setComposerTool] = useState<ComposerTool>("note");
  const [composerTitle, setComposerTitle] = useState("");
  const [composerBody, setComposerBody] = useState("");
  const [selectedAgendaId, setSelectedAgendaId] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [personalNotes, setPersonalNotes] = useState<PersonalNote[]>([]);
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
  const [sharedSyncEnabled, setSharedSyncEnabled] = useState(true);
  const [nodePositions, setNodePositions] = useState<CanvasNodePositionsByStage>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const resizeStateRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);
  const autoProblemDefinitionRef = useRef(false);
  const problemConclusionEntryHandledRef = useRef(false);
  const lastAutoFitSignatureRef = useRef("");
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

  const effectiveState = importedState ?? analysisState;
  const agendaModels = useMemo(() => buildAgendaModels(effectiveState, agendas, transcripts), [effectiveState, agendas, transcripts]);
  const meetingGoalTopic = useMemo(
    () => meetingTitle.trim() || (effectiveState?.meeting_goal || "").trim(),
    [effectiveState?.meeting_goal, meetingTitle],
  );
  const displayMeetingGoal = generatedMeetingGoal || buildFallbackMeetingGoal(meetingGoalTopic);

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
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;

    workspaceLoadedRef.current = false;
    workspaceHydratingRef.current = true;
    setProblemGroups([]);
    setSolutionTopics([]);
    setPersonalNotes([]);
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

        const nextGroups = hydrateProblemGroups(saved.problem_groups || []);
        const nextStage =
          saved.stage === "problem-definition" || saved.stage === "solution" || saved.stage === "ideation"
            ? saved.stage
            : "ideation";
        const nextSolutionTopics = hydrateSolutionTopics(saved.solution_topics || [], nextGroups);
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

        setProblemGroups(nextGroups);
        setSolutionTopics(nextSolutionTopics);
        setPersonalNotes(nextPersonalNotes);
        setNodePositions(saved.node_positions || {});
        setImportedState(saved.imported_state || null);
        setStage(nextStage);
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          stage: nextStage,
          problem_groups: nextGroups,
          solution_topics: serializeSharedSolutionTopics(nextSolutionTopics),
          node_positions: saved.node_positions || {},
          imported_state: saved.imported_state || null,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
          stage: nextStage,
          problemGroups: nextGroups,
          solutionTopics: nextSolutionTopics,
          nodePositions: saved.node_positions || {},
          importedState: saved.imported_state || null,
        });
        setSelectedProblemGroupId(nextGroups[0]?.group_id || "");
        setSelectedSolutionTopicId(nextSolutionTopics[0]?.group_id || "");
        setSelectedNodeId(
          nextStage === "problem-definition"
            ? (nextGroups[0] ? `problem-${nextGroups[0].group_id}` : "")
            : nextStage === "solution"
              ? (nextSolutionTopics[0] ? `solution-${nextSolutionTopics[0].group_id}` : "")
              : "",
        );
        setEditingProblemGroupId("");
        setEditingSolutionTopicId("");
      })
      .catch(() => {
        if (cancelled) return;
        setProblemGroups([]);
        setSolutionTopics([]);
        setPersonalNotes([]);
        setNodePositions({});
        setImportedState(null);
        setStage("ideation");
        lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
          stage: "ideation",
          problem_groups: [],
          solution_topics: [],
          node_positions: {},
          imported_state: null,
        });
        lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
          stage: "ideation",
          problemGroups: [],
          solutionTopics: [],
          nodePositions: {},
          importedState: null,
        });
        setSelectedProblemGroupId("");
        setSelectedSolutionTopicId("");
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
        problem_groups: serializeSharedProblemGroups(overrides?.problemGroups ?? problemGroups),
        solution_topics: serializeSharedSolutionTopics(overrides?.solutionTopics ?? solutionTopics),
        node_positions: overrides?.nodePositions ?? nodePositions,
        imported_state: overrides?.importedState ?? importedState,
      };

      lastSharedSyncSignatureRef.current = buildSharedCanvasSignature(snapshot);
      onSharedCanvasSync({
        sync_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        meeting_id: meetingId,
        updated_by: userId,
        updated_at: new Date().toISOString(),
        stage: snapshot.stage,
        problem_groups: snapshot.problem_groups,
        solution_topics: snapshot.solution_topics,
        node_positions: snapshot.node_positions,
        imported_state: snapshot.imported_state,
      });
    },
    [
      importedState,
      meetingId,
      nodePositions,
      onSharedCanvasSync,
      problemGroups,
      solutionTopics,
      stage,
      userId,
    ],
  );

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
      problemGroups,
      solutionTopics,
      nodePositions,
      importedState,
    });
    const previousSignatures = lastWorkspaceFieldSignaturesRef.current;
    const patch: {
      meeting_id: string;
      stage?: CanvasStage;
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
      patch.imported_state = importedState;
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
        .catch(() => {
          // 저장 실패는 작업 흐름을 끊지 않고 다음 변경 시 다시 시도한다.
        });
    }, 450);

    return () => {
      if (workspaceSaveTimerRef.current) {
        window.clearTimeout(workspaceSaveTimerRef.current);
        workspaceSaveTimerRef.current = null;
      }
    };
  }, [
    conclusionBatchBusy,
    importedState,
    meetingId,
    nodePositions,
    problemDefinitionStagePending,
    problemGroups,
    sharedSyncEnabled,
    solutionStagePending,
    solutionTopics,
    stage,
  ]);

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
      }).catch(() => {
        // 개인 메모 저장 실패는 다음 변경 시 다시 시도한다.
      });
    }, 300);

    return () => {
      if (personalNotesSaveTimerRef.current) {
        window.clearTimeout(personalNotesSaveTimerRef.current);
        personalNotesSaveTimerRef.current = null;
      }
    };
  }, [meetingId, personalNotes, userId]);

  const sharedCanvasSnapshot = useMemo(
    () => ({
      stage,
      problem_groups: serializeSharedProblemGroups(problemGroups),
      solution_topics: serializeSharedSolutionTopics(solutionTopics),
      node_positions: nodePositions,
      imported_state: importedState,
    }),
    [importedState, nodePositions, problemGroups, solutionTopics, stage],
  );

  const sharedCanvasSignature = useMemo(
    () => buildSharedCanvasSignature(sharedCanvasSnapshot),
    [sharedCanvasSnapshot],
  );

  useEffect(() => {
    if (!incomingSharedCanvasSync || incomingSharedCanvasSync.meeting_id !== meetingId) {
      return;
    }

    if (incomingSharedCanvasSync.updated_by === userId) {
      return;
    }

    if (lastIncomingSharedSyncIdRef.current === incomingSharedCanvasSync.sync_id) {
      return;
    }

    lastIncomingSharedSyncIdRef.current = incomingSharedCanvasSync.sync_id;
    const incomingStage =
      incomingSharedCanvasSync.stage === "problem-definition" ||
      incomingSharedCanvasSync.stage === "solution"
        ? incomingSharedCanvasSync.stage
        : "ideation";
    lastSharedSyncSignatureRef.current = buildSharedCanvasSignature({
      stage: incomingStage,
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
    setStage(incomingStage);
    lastWorkspaceFieldSignaturesRef.current = buildWorkspaceFieldSignatures({
      stage: incomingStage,
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
      setSelectedNodeId("");
    }
    setActivityMessage("다른 참가자의 canvas 변경사항이 반영되었습니다.");

    window.setTimeout(() => {
      applyingRemoteSharedSyncRef.current = false;
    }, 0);
  }, [incomingSharedCanvasSync, meetingId, problemGroups, sharedSyncEnabled, solutionTopics, userId]);

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

          return {
            id: nodeId,
            position: savedPosition || positions[index],
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

          return {
            id: nodeId,
            position: savedPosition || positions[index],
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
      ]),
      nodeDescriptors: agendaModels.map((agenda, agendaIndex) => {
        const nodeId = `agenda-${agenda.id}`;
        const savedPosition = nodePositions.ideation?.[nodeId];

        return {
          id: nodeId,
          position: savedPosition || positions[agendaIndex],
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
    };
  }, [stage, agendaModels, dropProblemGroupId, loadingProblemGroupIds, nodePositions, problemGroups, selectedProblemGroupId, selectedSolutionTopicId, solutionTopics, handleAttachPersonalNoteToProblemGroup]);

  useEffect(() => {
    const stageKey = stage;
    setNodePositions((prev) => {
      const currentStagePositions = prev[stageKey] || {};
      let changed = false;
      const nextStagePositions = { ...currentStagePositions };

      graphBlueprint.nodeDescriptors.forEach((descriptor) => {
        if (!nextStagePositions[descriptor.id]) {
          nextStagePositions[descriptor.id] = descriptor.position;
          changed = true;
        }
      });

      if (!changed) {
        return prev;
      }

      return {
        ...prev,
        [stageKey]: nextStagePositions,
      };
    });
  }, [graphBlueprint.layoutSignature, graphBlueprint.nodeDescriptors, stage]);

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
  }, [agendaModels, problemGroups, selectedAgenda, selectedNodeId, selectedProblemGroup, selectedSolutionTopic, stage]);

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
    [busy, conclusionBatchBusy, handleGenerateSolutionStage, problemGroups, solutionStagePending, solutionTopics],
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

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    setNodePositions((prev) => {
      const stagePositions = { ...(prev[stage] || {}) };
      let changed = false;

      changes.forEach((change) => {
        if (change.type === "position" && change.position) {
          stagePositions[change.id] = change.position;
          changed = true;
          return;
        }
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
          if (change.type === "position" && change.position) {
            localNodeOverridesRef.current[stage].add(change.id);
          }
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

  const onEdgesChange = (changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  };

  const onConnect = (connection: Connection) => {
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: `user-edge-${Date.now()}`,
          type: "smoothstep",
          style: { stroke: "#94a3b8", strokeWidth: 1.25 },
        },
        current,
      ),
    );
  };

  const handleDeletePersonalNote = (noteId: string) => {
    setPersonalNotes((prev) => prev.filter((item) => item.id !== noteId));
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

  return (
    <div className="h-full min-h-0 bg-slate-50">
      <section className="flex h-full min-h-0 flex-col border-t border-slate-200 bg-white">
        <div className="relative border-b border-slate-200 bg-slate-800 text-white">
          <div className="border-b border-white/10 px-4 py-4 pr-36 sm:px-6 sm:pr-44">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-100">Group Canvas</p>
                <h2 className="mt-2 text-lg font-semibold sm:text-xl">{meetingTitle || "회의 그룹 보드"}</h2>
                {activityMessage ? <p className="mt-1 text-xs text-slate-300">{activityMessage}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
                  className={`min-h-[42px] rounded-xl border px-4 py-2 text-sm font-medium backdrop-blur-md ${
                    sharedSyncEnabled
                      ? "border-emerald-300/70 bg-emerald-400/20 text-emerald-50 hover:bg-emerald-400/25"
                      : "border-amber-300/70 bg-amber-300/20 text-amber-50 hover:bg-amber-300/25"
                  }`}
                >
                  {syncModeLabel(sharedSyncEnabled)}
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="min-h-[42px] rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur-md hover:bg-white/15">
                  불러오기
                </button>
              </div>
            </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void importAgendaSnapshot({ file, reset_state: true }).then((result) => {
                      setImportedState(result.state);
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
                    });
                  }
                  event.currentTarget.value = "";
                }}
              />
            </div>
          <div className="bg-slate-500/45 px-4 py-4 pr-36 sm:px-6 sm:pr-44">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-200">Meeting Goal</p>
            <p className="mt-2 text-base font-medium leading-7 text-slate-100 sm:text-lg">
              {meetingGoalBusy ? "회의 목표를 정리하는 중입니다." : displayMeetingGoal}
            </p>
          </div>
          <div className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-[20px] border border-white/20 bg-white px-2 py-2 text-slate-700 shadow-sm">
            <div className="flex flex-col gap-1">
              {(["ideation", "problem-definition", "solution"] as CanvasStage[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => void handleStageSelect(item)}
                  className={`min-w-[96px] rounded-xl px-4 py-2 text-sm font-semibold ${stage === item ? "bg-slate-200 text-slate-900" : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"}`}
                >
                  {stageLabel(item)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          className="grid flex-1 min-h-0 grid-cols-1"
          style={isDesktopLayout ? { gridTemplateColumns: `${leftPanelWidth}px minmax(0,1fr) ${rightPanelWidth}px` } : undefined}
        >
          <aside className="relative border-b border-slate-200 bg-[#f3f3f3] xl:min-h-0 xl:border-b-0 xl:border-r">
            <button
              type="button"
              aria-label="왼쪽 패널 너비 조절"
              onMouseDown={startPanelResize("left")}
              className="absolute right-[-12px] top-0 z-10 hidden h-full w-5 cursor-ew-resize xl:block"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-300" />
            </button>
            <div className="h-full px-6 py-7 sm:px-7 xl:overflow-y-auto xl:pr-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Detail</p>
                <h3 className="mt-2 text-xl font-semibold text-slate-900">디테일</h3>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-sm text-slate-500">
                {leftPanelTab === "detail" ? "선택 정보" : `${agendaModels.length}개 그룹`}
              </span>
            </div>

            <div className="mt-5 flex border-b border-slate-200/90">
              <button
                type="button"
                onClick={() => setLeftPanelTab("detail")}
                className={`border-b-2 px-4 py-3 text-base font-semibold transition ${leftPanelTab === "detail" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              >
                디테일
              </button>
              <button
                type="button"
                onClick={() => setLeftPanelTab("agenda-list")}
                className={`border-b-2 px-4 py-3 text-base font-semibold transition ${leftPanelTab === "agenda-list" ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              >
                안건 목록
              </button>
            </div>

            {leftPanelTab === "detail" ? (
              <div className="mt-6">
                {leftPanelDetail ? (
                  <>
                    <section className="border-b border-slate-200/80 pb-6">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Detail</p>
                          {isEditingSelectedProblemGroup || isEditingSelectedSolutionTopic ? (
                            <input
                              value={
                                isEditingSelectedProblemGroup
                                  ? problemGroupDraftTopic
                                  : solutionTopicDraftTitle
                              }
                              onChange={(event) => {
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
                        {stage === "problem-definition" && selectedProblemGroup ? (
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
                      <h4 className="text-lg font-semibold text-slate-900">키워드</h4>
                      {leftPanelDetail.keywords.length > 0 ? (
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
                        <h4 className="text-lg font-semibold text-slate-900">결론</h4>
                        {stage === "problem-definition" && selectedProblemGroup?.conclusion_user_edited ? (
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                            수동 수정됨
                          </span>
                        ) : null}
                      </div>
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
                    )}
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
              <div className="mt-6 space-y-6">
                <section className="border-b border-slate-200/80 pb-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-lg font-semibold text-slate-900">안건 목록</h4>
                    <span className="text-sm text-slate-500">{agendaModels.length}개 그룹</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {agendaModels.map((agenda) => (
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
                        <strong className="text-base text-slate-900">{agenda.title}</strong>
                        <p className="mt-2 text-sm leading-6 text-slate-500">{agenda.summaryBullets[0] || "요약이 아직 없습니다."}</p>
                      </button>
                    ))}
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

          <section className="relative min-h-[620px] border-b border-slate-200 bg-white xl:min-h-0 xl:border-b-0">
            <div className="h-[620px] w-full xl:h-full">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                onNodeClick={(_, node) => {
                  setSelectedNodeId(node.id);
                  setLeftPanelTab("detail");
                  if (node.id.startsWith("problem-")) {
                    setSelectedProblemGroupId(node.id.slice("problem-".length));
                    setSelectedSolutionTopicId("");
                    setEditingProblemGroupId("");
                  }
                  if (node.id.startsWith("solution-")) {
                    setSelectedSolutionTopicId(node.id.slice("solution-".length));
                    setSelectedProblemGroupId("");
                    setEditingSolutionTopicId("");
                  }
                  const agendaId = extractAgendaIdFromNodeId(node.id);
                  if (agendaId) {
                    setSelectedAgendaId(agendaId);
                  }
                }}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                minZoom={0.45}
                maxZoom={1.6}
                defaultEdgeOptions={{ type: "smoothstep" }}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#dbe3f0" />
                <MiniMap zoomable pannable />
                <Controls />
              </ReactFlow>
            </div>

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

            <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
              <div className="pointer-events-auto inline-flex items-center gap-2 rounded-[20px] border border-slate-200 bg-white/96 px-5 py-3.5 shadow-xl shadow-slate-200/80 backdrop-blur-md">
                {(["note", "comment", "topic"] as ComposerTool[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setComposerTool(item)}
                    className={`rounded-xl px-4 py-2.5 text-base font-semibold ${composerTool === item ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    {toolLabel(item)}
                  </button>
                ))}
                <div className="mx-1 h-8 w-px bg-slate-200" />
                <button type="button" onClick={() => void handleGenerateProblemDefinition()} disabled={busy || agendaModels.length === 0} className="rounded-xl px-4 py-2.5 text-base font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60">
                  문제 정의
                </button>
                <button type="button" onClick={() => void handleGenerateSolutionStage()} disabled={busy || !problemGroups.some((group) => group.status === "final")} className="rounded-xl px-4 py-2.5 text-base font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60">
                  해결책
                </button>
              </div>
            </div>
          </section>

          <aside className="relative bg-[#f3f3f3] px-6 py-7 sm:px-7 xl:min-h-0 xl:overflow-y-auto xl:border-l">
            <button
              type="button"
              aria-label="오른쪽 패널 너비 조절"
              onMouseDown={startPanelResize("right")}
              className="absolute left-[-7px] top-0 hidden h-full w-4 cursor-ew-resize xl:block"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-300" />
            </button>
            <section className="border-b border-slate-200/80 pb-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xl font-semibold text-slate-900">개인 메모장</h3>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-500">{personalNotes.length}개</span>
              </div>
              <div className="mt-4 space-y-3">
                <select value={selectedAgendaId} onChange={(event) => setSelectedAgendaId(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-700">
                  {agendaModels.map((agenda) => (
                    <option key={agenda.id} value={agenda.id}>
                      {agenda.title}
                    </option>
                  ))}
                </select>
                <input value={composerTitle} onChange={(event) => setComposerTitle(event.target.value)} placeholder="메모 제목" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-700" />
                <textarea value={composerBody} onChange={(event) => setComposerBody(event.target.value)} placeholder="개인 메모를 작성해 두고, 이후 그룹 보드로 이동시키는 흐름을 기준으로 둡니다." className="min-h-[220px] w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-base leading-7 text-slate-700" />
                <button type="button" onClick={handleAddPersonalNote} className="w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800">
                  개인 메모 저장
                </button>
              </div>
            </section>

            <section className="mt-6">
              <h3 className="text-lg font-semibold text-slate-900">내 메모 목록</h3>
              {stage === "problem-definition" ? (
                <p className="mt-2 text-sm leading-6 text-slate-500">메모 카드를 문제 정의 그룹으로 드래그해서 편입할 수 있습니다.</p>
              ) : null}
              <div className="mt-4 space-y-3">
                {personalNotes.length === 0 ? (
                  <p className="text-base leading-7 text-slate-500">아직 저장한 개인 메모가 없습니다.</p>
                ) : (
                  personalNotes.map((note) => (
                    <article
                      key={note.id}
                      draggable={stage === "problem-definition"}
                      onDragStart={(event) => {
                        if (stage !== "problem-definition") return;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-imms-note-id", note.id);
                        event.dataTransfer.setData("text/plain", note.id);
                        setDraggingPersonalNoteId(note.id);
                      }}
                      onDragEnd={() => {
                        setDraggingPersonalNoteId("");
                        setDropProblemGroupId("");
                      }}
                      className={`rounded-xl border border-slate-200 bg-[#fafafa] p-4 ${stage === "problem-definition" ? "cursor-grab active:cursor-grabbing" : ""} ${draggingPersonalNoteId === note.id ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600">{toolLabel(note.kind)}</p>
                          <h4 className="mt-1 text-base font-semibold text-slate-900">{note.title}</h4>
                        </div>
                        <button type="button" onClick={() => handleDeletePersonalNote(note.id)} className="text-sm font-medium text-slate-400 hover:text-slate-600">
                          삭제
                        </button>
                      </div>
                      <p className="mt-2 text-base leading-7 text-slate-600">{note.body}</p>
                      <p className="mt-3 text-sm text-slate-400">연결 그룹: {agendaModels.find((agenda) => agenda.id === note.agendaId)?.title || "미지정"}</p>
                    </article>
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}
