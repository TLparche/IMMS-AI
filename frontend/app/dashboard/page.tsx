"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { getCanvasWorkspaceState, saveCanvasWorkspacePatch } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import type { CanvasFinalSolutionSummary, CanvasFinalSolutionSummaryTopic, CanvasSolutionTopicResponse } from "@/lib/types";

interface Meeting {
  id: string;
  title: string;
  status: string;
  created_at: string;
  ended_at?: string;
  scheduled_at?: string;
  host_id: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function getMeetingStatusLabel(status: string) {
  if (status === "active" || status === "in_progress") return "진행";
  if (status === "scheduled" || status === "waiting") return "예정";
  if (status === "completed") return "종료";
  return status;
}

function getMeetingActionLabel(status: string) {
  return status === "completed" ? "회의 열기" : "참여";
}

function isCompletedMeeting(status: string) {
  return status === "completed";
}

function getFinalResultCount(summary: CanvasFinalSolutionSummary | null | undefined) {
  if (!summary) return 0;
  const topicNoteCount = (summary.topics || []).reduce((count, topic) => count + (topic.final_notes || []).length, 0);
  return Math.max(summary.final_count || 0, (summary.items || []).length, topicNoteCount, (summary.sections || []).length);
}

function hasFinalResult(summary: CanvasFinalSolutionSummary | null | undefined) {
  return getFinalResultCount(summary) > 0 || Boolean(summary?.markdown?.trim());
}

function getFinalResultTopics(summary: CanvasFinalSolutionSummary | null | undefined): CanvasFinalSolutionSummaryTopic[] {
  if (!summary) return [];
  if ((summary.topics || []).length > 0) {
    return summary.topics.map((topic) => ({
      ...topic,
      final_notes:
        topic.final_notes && topic.final_notes.length > 0
          ? topic.final_notes
          : (summary.items || []).filter((item) => item.topic_id === topic.topic_id),
    }));
  }

  const topicMap = new Map<string, CanvasFinalSolutionSummaryTopic>();
  for (const item of summary.items || []) {
    const topicId = item.topic_id || item.topic_title || "result";
    const current = topicMap.get(topicId);
    if (current) {
      current.final_notes.push(item);
      continue;
    }
    topicMap.set(topicId, {
      topic_id: topicId,
      topic_no: item.topic_no || topicMap.size + 1,
      topic_title: item.topic_title || item.problem_topic || "최종 결과",
      problem_topic: item.problem_topic || "",
      solution_conclusion: item.solution_conclusion || "",
      final_notes: [item],
    });
  }
  return Array.from(topicMap.values()).sort((a, b) => a.topic_no - b.topic_no);
}

function buildFinalResultMarkdown(summary: CanvasFinalSolutionSummary | null | undefined) {
  if (!summary) return "";
  if (summary.markdown?.trim()) return summary.markdown.trim();

  return getFinalResultTopics(summary)
    .map((topic) => {
      const lines = [
        `## ${topic.topic_title || topic.problem_topic || `주제 ${topic.topic_no}`}`,
        topic.problem_topic ? `- 문제: ${topic.problem_topic}` : "",
        topic.solution_conclusion ? `- 해결책: ${topic.solution_conclusion}` : "",
        ...topic.final_notes.map((note) => `- ${note.note_text}${note.final_comment ? `: ${note.final_comment}` : ""}`),
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildFinalResultSummaryFromSolutionTopics(topics: CanvasSolutionTopicResponse[]): CanvasFinalSolutionSummary {
  const summaryTopics = (topics || [])
    .map((topic) => {
      const finalNotes = (topic.notes || [])
        .filter((note) => note.is_final_candidate)
        .map((note) => ({
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
        }))
        .filter((note) => note.note_text.trim());

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

function formatDashboardDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
}

function formatDashboardDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
}

function getMeetingStatusBadgeClass(status: string) {
  if (isCompletedMeeting(status)) return "bg-[#111827] text-white";
  if (status === "active" || status === "in_progress") return "bg-[#e9efff] text-[#1b59f8]";
  return "bg-[#eff0f6] text-[#4d4d4d]";
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newMeetingTitle, setNewMeetingTitle] = useState("");
  const [selectedResultMeeting, setSelectedResultMeeting] = useState<Meeting | null>(null);
  const [resultSummaries, setResultSummaries] = useState<Record<string, CanvasFinalSolutionSummary | null>>({});
  const [resultSolutionTopics, setResultSolutionTopics] = useState<Record<string, CanvasSolutionTopicResponse[]>>({});
  const [resultSavedAt, setResultSavedAt] = useState<Record<string, string>>({});
  const [resultErrors, setResultErrors] = useState<Record<string, string>>({});
  const [resultRebuildMessages, setResultRebuildMessages] = useState<Record<string, string>>({});
  const [resultLoadingMeetingId, setResultLoadingMeetingId] = useState<string | null>(null);
  const [resultRebuildingMeetingId, setResultRebuildingMeetingId] = useState<string | null>(null);

  useEffect(() => {
    console.log("📊 Dashboard - Auth check:", { authLoading, userEmail: user?.email });
    if (!authLoading && !user) {
      console.log("❌ Dashboard - No user, redirecting to /login");
      router.push("/login");
    }
  }, [user, authLoading, router]);

  useEffect(() => {
    if (user) {
      console.log("📊 Dashboard - Loading meetings for user:", user.email);
      void loadMeetings();
    }
  }, [user]);

  const loadMeetings = async () => {
    try {
      setLoading(true);
      console.log("📊 Dashboard - Fetching meetings from Supabase...");

      const { data, error } = await supabase
        .from("meetings")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        console.error("❌ Dashboard - Failed to load meetings:", error);
        throw error;
      }

      console.log("✅ Dashboard - Loaded meetings:", data?.length || 0);
      setMeetings(data || []);
    } catch (error) {
      console.error("Error loading meetings:", error);
      alert("회의 목록을 불러오는데 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMeeting = async () => {
    if (!user) return;
    if (!newMeetingTitle.trim()) {
      alert("회의 제목을 입력해주세요.");
      return;
    }

    try {
      console.log("📊 Dashboard - Creating new meeting:", newMeetingTitle);

      const { data, error } = await supabase
        .from("meetings")
        .insert([
          {
            title: newMeetingTitle,
            host_id: user.id,
            status: "scheduled",
          },
        ])
        .select()
        .single();

      if (error) {
        console.error("❌ Dashboard - Failed to create meeting:", error);
        throw error;
      }

      console.log("✅ Dashboard - Meeting created:", data.id);
      setShowCreateModal(false);
      setNewMeetingTitle("");

      await loadMeetings();
      router.push(`/?meeting_id=${data.id}`);
    } catch (error) {
      console.error("Error creating meeting:", error);
      alert("회의 생성에 실패했습니다: " + getErrorMessage(error, "알 수 없는 오류"));
    }
  };

  const handleJoinMeeting = (meetingId: string) => {
    console.log("📊 Dashboard - Joining meeting:", meetingId);
    router.push(`/?meeting_id=${meetingId}`);
  };

  const handleOpenMeetingResult = async (meeting: Meeting) => {
    setSelectedResultMeeting(meeting);
    if (resultLoadingMeetingId === meeting.id) return;

    try {
      setResultLoadingMeetingId(meeting.id);
      setResultErrors((prev) => {
        const next = { ...prev };
        delete next[meeting.id];
        return next;
      });
      setResultRebuildMessages((prev) => {
        const next = { ...prev };
        delete next[meeting.id];
        return next;
      });

      const workspace = await getCanvasWorkspaceState(meeting.id);
      const summary = workspace.final_solution_summary || null;
      setResultSummaries((prev) => ({ ...prev, [meeting.id]: summary }));
      setResultSolutionTopics((prev) => ({ ...prev, [meeting.id]: workspace.solution_topics || [] }));
      setResultSavedAt((prev) => ({ ...prev, [meeting.id]: workspace.saved_at || "" }));
    } catch (error) {
      console.error("Failed to load meeting final result:", error);
      setResultSummaries((prev) => ({ ...prev, [meeting.id]: null }));
      setResultErrors((prev) => ({
        ...prev,
        [meeting.id]: getErrorMessage(error, "최종 결과를 불러오지 못했습니다."),
      }));
    } finally {
      setResultLoadingMeetingId((current) => (current === meeting.id ? null : current));
    }
  };

  const handleCopyFinalResultMarkdown = async () => {
    const markdown = buildFinalResultMarkdown(selectedResultMeeting ? resultSummaries[selectedResultMeeting.id] : null);
    if (!markdown) return;

    try {
      await navigator.clipboard.writeText(markdown);
      alert("최종 결과 마크다운을 복사했습니다.");
    } catch (error) {
      console.error("Failed to copy final result markdown:", error);
      alert("마크다운 복사에 실패했습니다.");
    }
  };

  const handleRebuildFinalResult = async (meeting: Meeting) => {
    if (resultRebuildingMeetingId === meeting.id) return;

    try {
      setResultRebuildingMeetingId(meeting.id);
      setResultErrors((prev) => {
        const next = { ...prev };
        delete next[meeting.id];
        return next;
      });
      setResultRebuildMessages((prev) => {
        const next = { ...prev };
        delete next[meeting.id];
        return next;
      });

      let topics = resultSolutionTopics[meeting.id] || [];
      if (topics.length === 0) {
        const workspace = await getCanvasWorkspaceState(meeting.id);
        topics = workspace.solution_topics || [];
        setResultSolutionTopics((prev) => ({ ...prev, [meeting.id]: topics }));

        if (hasFinalResult(workspace.final_solution_summary)) {
          setResultSummaries((prev) => ({ ...prev, [meeting.id]: workspace.final_solution_summary || null }));
          setResultSavedAt((prev) => ({ ...prev, [meeting.id]: workspace.saved_at || "" }));
          setResultRebuildMessages((prev) => ({ ...prev, [meeting.id]: "이미 저장된 최종 결과를 다시 불러왔습니다." }));
          return;
        }
      }

      const rebuiltSummary = buildFinalResultSummaryFromSolutionTopics(topics);
      if (!hasFinalResult(rebuiltSummary)) {
        setResultRebuildMessages((prev) => ({
          ...prev,
          [meeting.id]: "최종 결과로 선택된 해결책 메모가 없어 재구성할 수 없습니다.",
        }));
        return;
      }

      const savedWorkspace = await saveCanvasWorkspacePatch({
        meeting_id: meeting.id,
        final_solution_summary: rebuiltSummary,
      });
      setResultSummaries((prev) => ({ ...prev, [meeting.id]: rebuiltSummary }));
      setResultSavedAt((prev) => ({ ...prev, [meeting.id]: savedWorkspace.saved_at || new Date().toISOString() }));
      setResultRebuildMessages((prev) => ({
        ...prev,
        [meeting.id]: `최종 결과 ${rebuiltSummary.final_count}개를 재구성해 저장했습니다.`,
      }));
    } catch (error) {
      console.error("Failed to rebuild final result:", error);
      setResultErrors((prev) => ({
        ...prev,
        [meeting.id]: getErrorMessage(error, "최종 결과 재구성에 실패했습니다."),
      }));
    } finally {
      setResultRebuildingMeetingId((current) => (current === meeting.id ? null : current));
    }
  };

  const handleLogout = async () => {
    console.log("📊 Dashboard - Logging out...");
    await signOut();
    router.push("/login");
  };

  if (authLoading) {
    console.log("⏳ Dashboard - Auth loading...");
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f9f9f9]">
        <div className="rounded-2xl border border-black/10 bg-white px-8 py-7 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-[#e9efff] border-t-[#1b59f8]" />
          <p className="mt-4 text-sm font-medium text-[#4d4d4d]">로딩 중...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    console.log("❌ Dashboard - No user, showing redirect message");
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f9f9f9]">
        <div className="rounded-2xl border border-black/10 bg-white px-8 py-7 text-center">
          <p className="text-sm font-medium text-[#4d4d4d]">로그인이 필요합니다. 리다이렉트 중...</p>
        </div>
      </div>
    );
  }

  console.log("🎨 Dashboard - Rendering UI with", meetings.length, "meetings");

  const selectedResultSummary = selectedResultMeeting ? resultSummaries[selectedResultMeeting.id] : null;
  const selectedResultError = selectedResultMeeting ? resultErrors[selectedResultMeeting.id] : "";
  const selectedResultRebuildMessage = selectedResultMeeting ? resultRebuildMessages[selectedResultMeeting.id] : "";
  const selectedResultSavedAt = selectedResultMeeting ? resultSavedAt[selectedResultMeeting.id] : "";
  const selectedResultLoading = selectedResultMeeting ? resultLoadingMeetingId === selectedResultMeeting.id : false;
  const selectedResultRebuilding = selectedResultMeeting ? resultRebuildingMeetingId === selectedResultMeeting.id : false;
  const selectedResultTopics = getFinalResultTopics(selectedResultSummary);
  const selectedResultCount = getFinalResultCount(selectedResultSummary);
  const selectedResultStatusLabel = selectedResultLoading
    ? "확인 중"
    : selectedResultRebuilding
      ? "재구성 중"
    : hasFinalResult(selectedResultSummary)
      ? "저장됨"
      : "없음";

  return (
    <div className="min-h-screen bg-[#f9f9f9] text-black">
      <header className="border border-black/10 bg-white">
        <div className="mx-auto grid min-h-[113px] max-w-none grid-cols-[1fr_auto_1fr] items-center px-8">
          <div aria-hidden="true" />
          <h1 className="justify-self-center text-[32px] font-semibold leading-[24.811px] tracking-normal text-black">회의 대시보드</h1>
          <div className="flex items-center justify-end gap-7 justify-self-end">
            <span className="max-w-[180px] truncate text-[16px] font-normal leading-[24.811px] text-[#4d4d4d]">
              {user.email || "아이디"}
            </span>
            <button
              onClick={handleLogout}
              className="rounded-[8px] bg-[#ef4e4e] px-6 py-2.5 text-[20px] font-semibold leading-[24.811px] text-white transition hover:bg-[#df3f3f]"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1407px] px-0 py-[47px]">
        <div className="mb-[27px] flex items-center gap-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex h-[43px] items-center gap-[4.5px] rounded-[16px] bg-[#1b59f8] px-[13.5px] py-[9px] text-[15.789px] font-semibold leading-[20.3px] text-white transition hover:bg-[#164be0]"
          >
            <svg aria-hidden="true" className="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            새 회의 생성
          </button>
          <button
            type="button"
            onClick={() => alert("불러오기 기능은 추후 회의 파일/스냅샷 선택과 연결할 수 있습니다.")}
            className="inline-flex h-[43px] items-center gap-[4.5px] rounded-[16px] bg-[#e9efff] px-[13.5px] py-[9px] text-[15.789px] font-semibold leading-[20.3px] text-[#1b59f8] transition hover:bg-[#dfe8ff]"
          >
            <svg aria-hidden="true" className="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none">
              <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5M5 19h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            불러오기
          </button>
        </div>

        <section className="overflow-hidden rounded-[16px] border border-black/10 bg-white">
          <div className="flex h-[81px] items-center border-b border-black/10 px-8">
            <h2 className="text-[18px] font-semibold leading-[24.811px] text-black">내 회의 목록</h2>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <div className="mx-auto h-9 w-9 animate-spin rounded-full border-[3px] border-[#e9efff] border-t-[#1b59f8]" />
              <p className="mt-4 text-sm font-medium text-[#4d4d4d]">회의 목록을 불러오는 중...</p>
            </div>
          ) : meetings.length === 0 ? (
            <div className="p-12 text-center">
              <p className="font-semibold text-black">아직 생성된 회의가 없습니다.</p>
              <p className="mt-2 text-sm text-[#4d4d4d]">새 회의 생성 버튼을 눌러 회의를 시작하세요.</p>
            </div>
          ) : (
            <div className="divide-y divide-black/10">
              {meetings.map((meeting) => (
                <div
                  key={meeting.id}
                  className="group flex min-h-[115px] cursor-pointer items-center px-8 transition hover:bg-[#f9f9f9]"
                  onClick={() => {
                    if (isCompletedMeeting(meeting.status)) {
                      void handleOpenMeetingResult(meeting);
                      return;
                    }
                    handleJoinMeeting(meeting.id);
                  }}
                >
                  <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold leading-[24.811px] text-black">{meeting.title}</h3>
                      <div className="mt-[26px] flex flex-wrap items-center gap-3">
                        <span className={`inline-flex min-w-[76px] justify-center rounded-[16px] px-4 py-1 text-[14px] font-medium leading-normal tracking-[-0.1737px] ${getMeetingStatusBadgeClass(meeting.status)}`}>
                          {getMeetingStatusLabel(meeting.status)}
                        </span>
                        <span className="text-[14px] font-normal leading-[24.811px] text-[#4d4d4d]">
                          {isCompletedMeeting(meeting.status) && meeting.ended_at
                            ? `종료 ${formatDashboardDate(meeting.ended_at)}`
                            : formatDashboardDate(meeting.created_at)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 justify-self-end">
                      {isCompletedMeeting(meeting.status) ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleOpenMeetingResult(meeting);
                          }}
                          className="inline-flex h-[41px] items-center justify-center rounded-[16px] bg-[#1b59f8] px-5 text-[16px] font-semibold leading-normal tracking-[-0.1737px] text-white transition hover:bg-[#164be0]"
                        >
                          결과 보기
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleJoinMeeting(meeting.id);
                        }}
                        className={`inline-flex h-[41px] items-center justify-center rounded-[16px] px-5 text-[16px] font-medium leading-normal tracking-[-0.1737px] transition ${
                          isCompletedMeeting(meeting.status)
                            ? "bg-[#eff0f6] text-[#4d4d4d] hover:bg-[#e3e5ee]"
                            : "min-w-[87px] bg-[#e9efff] text-[#1b59f8] hover:bg-[#dfe8ff]"
                        }`}
                      >
                        {getMeetingActionLabel(meeting.status)}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-[744px] rounded-[16px] bg-white px-14 py-12">
            <h2 className="text-2xl font-semibold text-black">회의 이름</h2>
            <p className="mt-5 text-base text-[#4d4d4d]">회의를 하려면 마이크 연결이 필요합니다.</p>
            <input
              type="text"
              value={newMeetingTitle}
              onChange={(e) => setNewMeetingTitle(e.target.value)}
              placeholder="회의 이름"
              className="mt-8 w-full rounded-[12px] border border-black/10 px-4 py-3 text-base text-black outline-none focus:border-[#1b59f8]"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateMeeting();
              }}
            />
            <div className="mt-8 flex justify-end gap-4">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewMeetingTitle("");
                }}
                className="min-w-[164px] rounded-[8px] bg-[#eff0f6] px-8 py-3 text-base font-semibold text-[#4d4d4d] transition hover:bg-[#e3e5ee]"
              >
                취소
              </button>
              <button
                onClick={() => void handleCreateMeeting()}
                disabled={!newMeetingTitle.trim()}
                className="min-w-[164px] rounded-[8px] bg-[#1b59f8] px-8 py-3 text-base font-semibold text-white transition hover:bg-[#164be0] disabled:cursor-not-allowed disabled:opacity-50"
              >
                시작
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedResultMeeting ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-[clamp(12px,2vw,28px)]">
          <div className="flex max-h-[90vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-[20px] bg-[#f9f9f9] shadow-2xl">
            <div className="bg-[#111827] px-[clamp(20px,3vw,36px)] py-[clamp(20px,3vh,30px)] text-white">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-white/12 px-3 py-1 text-xs font-semibold tracking-[0.12em] text-white/80">
                      FINAL REPORT
                    </span>
                    <span className="rounded-full bg-[#1b59f8] px-3 py-1 text-xs font-semibold text-white">
                      {getMeetingStatusLabel(selectedResultMeeting.status)}
                    </span>
                  </div>
                  <h2 className="mt-4 truncate text-[clamp(24px,3vw,36px)] font-semibold leading-tight text-white">
                    {selectedResultMeeting.title}
                  </h2>
                  <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/70">
                    <span>생성 {formatDashboardDateTime(selectedResultMeeting.created_at)}</span>
                    <span>종료 {formatDashboardDateTime(selectedResultMeeting.ended_at)}</span>
                    <span>결과 저장 {formatDashboardDateTime(selectedResultSavedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleJoinMeeting(selectedResultMeeting.id)}
                    className="inline-flex h-10 items-center rounded-[12px] bg-white/10 px-4 text-sm font-semibold text-white transition hover:bg-white/16"
                  >
                    회의 열기
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyFinalResultMarkdown()}
                    disabled={!hasFinalResult(selectedResultSummary)}
                    className="inline-flex h-10 items-center rounded-[12px] bg-white px-4 text-sm font-semibold text-[#111827] transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    마크다운 복사
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedResultMeeting(null)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-xl font-semibold text-white transition hover:bg-white/16"
                    aria-label="결과 닫기"
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-[16px] border border-white/10 bg-white/8 px-4 py-3">
                  <p className="text-xs font-semibold text-white/55">최종 결과</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{selectedResultCount}</p>
                </div>
                <div className="rounded-[16px] border border-white/10 bg-white/8 px-4 py-3">
                  <p className="text-xs font-semibold text-white/55">해결책 그룹</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{selectedResultTopics.length}</p>
                </div>
                <div className="rounded-[16px] border border-white/10 bg-white/8 px-4 py-3">
                  <p className="text-xs font-semibold text-white/55">결과 상태</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{selectedResultStatusLabel}</p>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-[clamp(16px,2.6vw,32px)] py-[clamp(18px,3vh,30px)]">
              {selectedResultLoading ? (
                <div className="rounded-[20px] border border-black/10 bg-white p-8">
                  <div className="flex items-center gap-4">
                    <div className="h-11 w-11 animate-spin rounded-full border-[3px] border-[#e9efff] border-t-[#1b59f8]" />
                    <div>
                      <p className="text-base font-semibold text-black">최종 결과를 불러오는 중입니다.</p>
                      <p className="mt-1 text-sm text-[#4d4d4d]">회의 종료 시 저장된 워크스페이스 결과를 확인하고 있습니다.</p>
                    </div>
                  </div>
                  <div className="mt-7 grid gap-4 md:grid-cols-2">
                    <div className="h-28 animate-pulse rounded-[16px] bg-[#f1f3f8]" />
                    <div className="h-28 animate-pulse rounded-[16px] bg-[#f1f3f8]" />
                  </div>
                </div>
              ) : selectedResultError ? (
                <div className="rounded-[20px] border border-[#f0c6c6] bg-white p-7">
                  <div className="inline-flex rounded-full bg-[#fff5f5] px-3 py-1 text-xs font-semibold text-[#b23b3b]">불러오기 실패</div>
                  <h3 className="mt-4 text-xl font-semibold text-black">최종 결과를 확인할 수 없습니다.</h3>
                  <p className="mt-3 text-sm leading-6 text-[#b23b3b]">{selectedResultError}</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void handleOpenMeetingResult(selectedResultMeeting)}
                      className="inline-flex h-10 items-center rounded-[12px] bg-[#1b59f8] px-4 text-sm font-semibold text-white transition hover:bg-[#164be0]"
                    >
                      다시 불러오기
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRebuildFinalResult(selectedResultMeeting)}
                      disabled={selectedResultRebuilding}
                      className="inline-flex h-10 items-center rounded-[12px] bg-[#111827] px-4 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {selectedResultRebuilding ? "재구성 중" : "결과 재구성"}
                    </button>
                  </div>
                </div>
              ) : selectedResultTopics.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-black/15 bg-white px-6 py-12 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#e9efff] text-2xl font-semibold text-[#1b59f8]">
                    !
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-black">저장된 최종 결과가 없습니다.</h3>
                  <p className="mx-auto mt-3 max-w-[520px] text-sm leading-6 text-[#4d4d4d]">
                    해결책 단계에서 최종 결과로 남길 항목을 선택한 뒤 회의를 종료하면 이곳에 보고서 형태로 표시됩니다.
                  </p>
                  {selectedResultRebuildMessage ? (
                    <p className="mx-auto mt-5 max-w-[520px] rounded-[14px] bg-[#f6f8ff] px-4 py-3 text-sm font-semibold leading-6 text-[#1b59f8]">
                      {selectedResultRebuildMessage}
                    </p>
                  ) : null}
                  <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => void handleRebuildFinalResult(selectedResultMeeting)}
                      disabled={selectedResultRebuilding}
                      className="inline-flex h-11 items-center rounded-[14px] bg-[#111827] px-5 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {selectedResultRebuilding ? "재구성 중" : "결과 재구성"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleJoinMeeting(selectedResultMeeting.id)}
                      className="inline-flex h-11 items-center rounded-[14px] bg-[#1b59f8] px-5 text-sm font-semibold text-white transition hover:bg-[#164be0]"
                    >
                      회의 화면으로 이동
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {selectedResultRebuildMessage ? (
                    <div className="rounded-[16px] border border-[#cfdcff] bg-[#f6f8ff] px-5 py-4 text-sm font-semibold text-[#1b59f8]">
                      {selectedResultRebuildMessage}
                    </div>
                  ) : null}
                  {selectedResultTopics.map((topic) => (
                    <section key={topic.topic_id} className="overflow-hidden rounded-[20px] border border-black/10 bg-white shadow-[0_8px_26px_rgba(15,23,42,0.05)]">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/10 bg-[#fbfcff] px-6 py-5">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#1b59f8]">Solution {topic.topic_no}</p>
                          <h3 className="mt-2 text-[clamp(18px,2vw,24px)] font-semibold leading-tight text-black">
                            {topic.topic_title || topic.problem_topic || `해결책 ${topic.topic_no}`}
                          </h3>
                        </div>
                        <span className="rounded-full bg-[#111827] px-3 py-1 text-xs font-semibold text-white">
                          최종 {(topic.final_notes || []).length}개
                        </span>
                      </div>
                      <div className="p-6">
                        {topic.problem_topic || topic.solution_conclusion ? (
                          <div className="grid gap-4 md:grid-cols-2">
                            {topic.problem_topic ? (
                              <div className="rounded-[16px] border border-black/10 bg-[#f9f9f9] p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#777]">문제 정의</p>
                                <p className="mt-2 text-sm leading-6 text-black">{topic.problem_topic}</p>
                              </div>
                            ) : null}
                            {topic.solution_conclusion ? (
                              <div className="rounded-[16px] border border-[#cfdcff] bg-[#f6f8ff] p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#1b59f8]">해결책 결론</p>
                                <p className="mt-2 text-sm leading-6 text-black">{topic.solution_conclusion}</p>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="mt-5 space-y-3">
                          <p className="text-sm font-semibold text-[#4d4d4d]">최종 선택 메모</p>
                          {(topic.final_notes || []).map((note) => (
                            <article key={note.id} className="border-l-4 border-[#1b59f8] bg-[#f9f9f9] px-4 py-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[#1b59f8]">
                                  {note.source === "ai" ? "AI 채택" : "사용자 메모"}
                                </span>
                                {(note.agenda_titles || []).length > 0 ? (
                                  <span className="text-xs text-[#777]">{(note.agenda_titles || []).join(", ")}</span>
                                ) : null}
                              </div>
                              <p className="mt-3 text-base font-semibold leading-7 text-black">{note.note_text}</p>
                              {note.final_comment ? (
                                <p className="mt-2 text-sm leading-6 text-[#4d4d4d]">{note.final_comment}</p>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
