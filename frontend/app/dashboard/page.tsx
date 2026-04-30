"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

interface Meeting {
  id: string;
  title: string;
  status: string;
  created_at: string;
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
  return status === "completed" ? "열기" : "참여";
}

function formatDashboardDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(value))
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newMeetingTitle, setNewMeetingTitle] = useState("");

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
                  onClick={() => handleJoinMeeting(meeting.id)}
                >
                  <div className="grid w-full gap-4 grid-cols-[minmax(0,1fr)_87px] items-center">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold leading-[24.811px] text-black">{meeting.title}</h3>
                      <div className="mt-[26px] flex flex-wrap items-center gap-3">
                        <span className="inline-flex min-w-[76px] justify-center rounded-[16px] bg-[#eff0f6] px-4 py-1 text-[14px] font-medium leading-normal tracking-[-0.1737px] text-[#4d4d4d]">
                          {getMeetingStatusLabel(meeting.status)}
                        </span>
                        <span className="text-[14px] font-normal leading-[24.811px] text-[#4d4d4d]">
                          {formatDashboardDate(meeting.created_at)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleJoinMeeting(meeting.id);
                      }}
                      className="inline-flex h-[41px] w-[87px] items-center justify-center justify-self-end rounded-[16px] bg-[#e9efff] text-[18px] font-medium leading-normal tracking-[-0.1737px] text-[#1b59f8] transition hover:bg-[#dfe8ff]"
                    >
                      {getMeetingActionLabel(meeting.status)}
                    </button>
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
    </div>
  );
}
