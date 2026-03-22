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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMeetingGoal,
  generateCanvasProblemDefinition,
  generateCanvasSolutionStage,
  importAgendaSnapshot,
} from "@/lib/api";
import type {
  AgendaActionItemDetail,
  AgendaDecisionDetail,
  CanvasProblemDefinitionGroup,
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

type PersonalNote = {
  id: string;
  agendaId: string;
  kind: ComposerTool;
  title: string;
  body: string;
};

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

type MeetingCanvasTabProps = {
  meetingId: string;
  meetingTitle: string;
  transcripts: MeetingTranscript[];
  agendas: MeetingAgenda[];
  analysisState: MeetingState | null;
  onSyncFromMeeting: (analyze?: boolean) => Promise<MeetingState | null>;
  syncStatusText: string;
  autoSyncing: boolean;
};

function stageLabel(stage: CanvasStage) {
  if (stage === "ideation") return "아이디어";
  if (stage === "problem-definition") return "문제정의";
  return "해결책";
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

function makeNodeLabel(badge: string, title: string, body: string, meta: string[], accent: string) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${accent}`}>{badge}</span>
        {meta[0] ? <span className="text-xs text-slate-400">{meta[0]}</span> : null}
      </div>
      <strong className="mt-3 block text-base text-slate-900">{title}</strong>
      {body ? <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p> : null}
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

export default function MeetingCanvasTab({
  meetingId,
  meetingTitle,
  transcripts,
  agendas,
  analysisState,
  onSyncFromMeeting,
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
  const [problemGroups, setProblemGroups] = useState<CanvasProblemDefinitionGroup[]>([]);
  const [solutionTopics, setSolutionTopics] = useState<CanvasSolutionTopicResponse[]>([]);
  const [importedState, setImportedState] = useState<MeetingState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>("detail");
  const [generatedMeetingGoal, setGeneratedMeetingGoal] = useState("");
  const [meetingGoalBusy, setMeetingGoalBusy] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const resizeStateRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);

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
    void generateMeetingGoal({ topic })
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
  }, [meetingGoalTopic]);

  useEffect(() => {
    const syncViewportMode = () => {
      setIsDesktopLayout(window.innerWidth >= 1280);
    };

    syncViewportMode();
    window.addEventListener("resize", syncViewportMode);
    return () => window.removeEventListener("resize", syncViewportMode);
  }, []);

  const graph = useMemo(() => {
    if (stage === "problem-definition") {
      return {
        nodes: problemGroups.map((group, index) => ({
          id: `problem-${group.group_id}`,
          position: { x: 120 + index * 360, y: 140 },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "rounded-3xl border border-violet-200 bg-violet-50 shadow-sm",
          style: { width: 320, borderRadius: 20, padding: 0 },
          data: {
            label: makeNodeLabel(
              `TOPIC ${index + 1}`,
              group.topic,
              group.conclusion,
              [`${group.agenda_titles.length}개 그룹`, `${group.ideas.length}개 메모`, ...(group.keywords || []).slice(0, 2).map((item) => `#${item}`)],
              "bg-violet-100 text-violet-700",
            ),
          },
        })),
        edges: [] as Edge[],
      };
    }

    if (stage === "solution") {
      return {
        nodes: solutionTopics.map((topic, index) => ({
          id: `solution-${topic.group_id}`,
          position: { x: 120 + index * 360, y: 140 },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "rounded-3xl border border-emerald-200 bg-emerald-50 shadow-sm",
          style: { width: 340, borderRadius: 20, padding: 0 },
          data: {
            label: makeNodeLabel(
              `SOLUTION ${topic.topic_no || index + 1}`,
              topic.topic,
              topic.ideas.join(" / "),
              [`아이디어 ${topic.ideas.length}개`, topic.conclusion || "결론 없음"],
              "bg-emerald-100 text-emerald-700",
            ),
          },
        })),
        edges: [] as Edge[],
      };
    }

    const nextNodes: Node[] = [];
    const nextEdges: Edge[] = [];
    const laneWidth = 320;

    agendaModels.forEach((agenda, agendaIndex) => {
      const laneX = 120 + agendaIndex * laneWidth;
      nextNodes.push({
        id: `agenda-${agenda.id}`,
        position: { x: laneX, y: 80 },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        className: "rounded-3xl border border-amber-200 bg-amber-100 shadow-sm",
        style: { width: 240, borderRadius: 16, padding: 0 },
        data: {
          label: makeNodeLabel(
            "GROUP",
            agenda.title,
            agenda.summaryBullets[0] || "요약이 아직 없습니다.",
            [agenda.status, ...(agenda.keywords || []).slice(0, 3).map((item) => `#${item}`)],
            "bg-amber-200 text-amber-800",
          ),
        },
      });

      agenda.summaryBullets.slice(0, 3).forEach((summary, summaryIndex) => {
        const summaryId = `summary-${agenda.id}-${summaryIndex}`;
        nextNodes.push({
          id: summaryId,
          position: { x: laneX, y: 250 + summaryIndex * 136 },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          className: "rounded-3xl border border-amber-100 bg-amber-50 shadow-sm",
          style: { width: 240, borderRadius: 16, padding: 0 },
          data: {
            label: makeNodeLabel(
              `POINT ${summaryIndex + 1}`,
              `핵심 포인트 ${summaryIndex + 1}`,
              summary,
              [`${agenda.utterances.length}개 발화`, ...(agenda.keywords || []).slice(0, 2).map((item) => `#${item}`)],
              "bg-amber-100 text-amber-700",
            ),
          },
        });
        nextEdges.push({
          id: `edge-agenda-${agenda.id}-${summaryIndex}`,
          source: `agenda-${agenda.id}`,
          target: summaryId,
          type: "smoothstep",
          style: { stroke: "#c7d2fe", strokeWidth: 1.4 },
        });
      });
    });

    return { nodes: nextNodes, edges: nextEdges };
  }, [stage, agendaModels, problemGroups, solutionTopics]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph]);

  useEffect(() => {
    if (!flowRef.current || nodes.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.2, duration: 250 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [nodes, edges, stage]);

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

  const leftPanelDetail = useMemo(() => {
    if (stage === "problem-definition") {
      const selectedGroup = problemGroups.find((group) => `problem-${group.group_id}` === selectedNodeId) || problemGroups[0] || null;
      if (!selectedGroup) return null;

      return {
        title: selectedGroup.topic,
        subtitle: "문제 정의 그룹",
        badges: [`${selectedGroup.agenda_titles.length}개 안건`, `${selectedGroup.ideas.length}개 메모`],
        keywords: (selectedGroup.keywords || []).slice(0, 3),
        summaryItems: [selectedGroup.conclusion, ...(selectedGroup.source_summary_items || []).slice(0, 2)]
          .filter(Boolean)
          .map((value, index) => ({
            label: index === 0 ? "핵심 결론" : `요약 ${index}`,
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
      };
    }

    if (stage === "solution") {
      const selectedTopic = solutionTopics.find((topic) => `solution-${topic.group_id}` === selectedNodeId) || solutionTopics[0] || null;
      if (!selectedTopic) return null;
      const linkedGroup = problemGroups.find((group) => group.group_id === selectedTopic.group_id);

      return {
        title: selectedTopic.topic,
        subtitle: "해결책 그룹",
        badges: [`주제 ${selectedTopic.topic_no}`, `${selectedTopic.ideas.length}개 아이디어`],
        keywords: (linkedGroup?.keywords || []).slice(0, 3),
        summaryItems: [selectedTopic.conclusion, ...selectedTopic.ideas.slice(0, 2)]
          .filter(Boolean)
          .map((value, index) => ({
            label: index === 0 ? "해결 방향" : `아이디어 ${index}`,
            value: stripLeadingTimestamp(value),
          })),
        organizeItems: [
          {
            label: "연결 안건",
            value: linkedGroup?.agenda_titles?.length ? linkedGroup.agenda_titles.join(", ") : "연결된 안건이 아직 없습니다.",
          },
          {
            label: "주제 번호",
            value: `${selectedTopic.topic_no}`,
          },
        ],
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
      keywords: (resolvedAgenda.keywords || []).slice(0, 3),
      summaryItems:
        summaryIndex >= 0
          ? [
              {
                label: `요약 ${summaryIndex + 1}`,
                value: stripLeadingTimestamp(summaryLine || "요약이 아직 없습니다."),
              },
            ]
          : (resolvedAgenda.summaryBullets.length > 0
              ? resolvedAgenda.summaryBullets.slice(0, 3)
              : ["요약이 아직 없습니다."]
            ).map((value, index) => ({
              label: `요약 ${index + 1}`,
              value: stripLeadingTimestamp(value),
            })),
      organizeItems: [
        {
          label: "안건",
          value: resolvedAgenda.title,
        },
        {
          label: "상태",
          value: resolvedAgenda.status,
        },
        {
          label: "결정",
          value:
            resolvedAgenda.decisions.length > 0
              ? summarizeDecision(resolvedAgenda.decisions[0])
              : "아직 정리된 결정이 없습니다.",
        },
        {
          label: "액션",
          value:
            resolvedAgenda.actionItems.length > 0
              ? summarizeActionItem(resolvedAgenda.actionItems[0])
              : "아직 정리된 액션이 없습니다.",
        },
      ],
    };
  }, [agendaModels, problemGroups, selectedAgenda, selectedNodeId, solutionTopics, stage]);

  const handleGenerateProblemDefinition = async () => {
    setBusy(true);
    try {
      const result = await generateCanvasProblemDefinition({
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
      setProblemGroups(result.groups);
      setStage("problem-definition");
      setActivityMessage(result.warning || `문제 정의 주제 ${result.groups.length}개를 생성했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`문제 정의 생성 실패: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateSolutionStage = async () => {
    setBusy(true);
    try {
      const result = await generateCanvasSolutionStage({
        meeting_topic: generatedMeetingGoal || meetingTitle || effectiveState?.meeting_goal || "회의 주제",
        topics: problemGroups.map((group, index) => ({
          group_id: group.group_id,
          topic_no: index + 1,
          topic: group.topic,
          conclusion: group.conclusion,
        })),
      });
      setSolutionTopics(result.topics);
      setStage("solution");
      setActivityMessage(result.warning || `해결책 묶음 ${result.topics.length}개를 생성했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivityMessage(`해결책 생성 실패: ${message}`);
    } finally {
      setBusy(false);
    }
  };

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

  const startPanelResize = (side: "left" | "right") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isDesktopLayout) return;
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftPanelWidth : rightPanelWidth,
    };
  };

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
              <button type="button" onClick={() => fileInputRef.current?.click()} className="min-h-[42px] shrink-0 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur-md hover:bg-white/15">
                불러오기
              </button>
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
                      setStage("ideation");
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
                  onClick={() => setStage(item)}
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
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Detail</p>
                      <h4 className="mt-3 text-xl font-semibold text-slate-900">{leftPanelDetail.title}</h4>
                      <p className="mt-2 text-base text-slate-500">{leftPanelDetail.subtitle}</p>
                      {leftPanelDetail.badges.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {leftPanelDetail.badges.map((badge) => (
                            <span key={`${leftPanelDetail.title}-${badge}`} className="rounded-full bg-white px-3 py-1 text-sm text-slate-600">
                              {badge}
                            </span>
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

                    <section className="border-b border-slate-200/80 py-6">
                      <h4 className="text-lg font-semibold text-slate-900">요약</h4>
                      <div className="mt-4 space-y-3">
                        {leftPanelDetail.summaryItems.map((item, index) => (
                          <div key={`${leftPanelDetail.title}-summary-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                            <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                            <p className="mt-1 text-base leading-7 text-slate-700">{item.value}</p>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="pt-6">
                      <h4 className="text-lg font-semibold text-slate-900">안건 정리</h4>
                      <div className="mt-4 space-y-3">
                        {leftPanelDetail.organizeItems.map((item, index) => (
                          <div key={`${leftPanelDetail.title}-organize-${index}`} className="rounded-xl bg-[#fafafa] px-4 py-3">
                            <p className="text-sm font-semibold text-slate-500">{item.label}</p>
                            <p className="mt-1 text-base leading-7 text-slate-700">{stripLeadingTimestamp(item.value)}</p>
                          </div>
                        ))}
                      </div>
                    </section>
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
                      <article key={group.group_id} className="rounded-xl border border-slate-200 bg-[#fafafa] p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600">문제 정의</p>
                        <h4 className="mt-1 text-base font-semibold text-slate-900">{group.topic}</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{group.conclusion}</p>
                      </article>
                    ))}
                    {solutionTopics.map((topic) => (
                      <article key={topic.group_id} className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">해결책</p>
                        <h4 className="mt-1 text-base font-semibold text-slate-900">{topic.topic}</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{topic.ideas.join(" / ") || topic.conclusion}</p>
                      </article>
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
                  const agendaId = extractAgendaIdFromNodeId(node.id);
                  if (agendaId) {
                    setSelectedAgendaId(agendaId);
                  }
                }}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                fitView
                fitViewOptions={{ padding: 0.16, duration: 300 }}
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
                <button type="button" onClick={() => void handleGenerateSolutionStage()} disabled={busy || problemGroups.length === 0} className="rounded-xl px-4 py-2.5 text-base font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60">
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
              <div className="mt-4 space-y-3">
                {personalNotes.length === 0 ? (
                  <p className="text-base leading-7 text-slate-500">아직 저장한 개인 메모가 없습니다.</p>
                ) : (
                  personalNotes.map((note) => (
                    <article key={note.id} className="rounded-xl border border-slate-200 bg-[#fafafa] p-4">
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
