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

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();
  
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newMeetingTitle, setNewMeetingTitle] = useState('');

  // 인증 체크
  useEffect(() => {
    console.log('📊 Dashboard - Auth check:', { authLoading, userEmail: user?.email });
    if (!authLoading && !user) {
      console.log('❌ Dashboard - No user, redirecting to /login');
      router.push('/login');
    }
  }, [user, authLoading, router]);

  // 회의 목록 로드
  useEffect(() => {
    if (user) {
      console.log('📊 Dashboard - Loading meetings for user:', user.email);
      loadMeetings();
    }
  }, [user]);

  const loadMeetings = async () => {
    try {
      setLoading(true);
      console.log('📊 Dashboard - Fetching meetings from Supabase...');
      
      const { data, error } = await supabase
        .from('meetings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('❌ Dashboard - Failed to load meetings:', error);
        throw error;
      }

      console.log('✅ Dashboard - Loaded meetings:', data?.length || 0);
      setMeetings(data || []);
    } catch (error) {
      console.error('Error loading meetings:', error);
      alert('회의 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMeeting = async () => {
    if (!user) return;
    if (!newMeetingTitle.trim()) {
      alert('회의 제목을 입력해주세요.');
      return;
    }

    try {
      console.log('📊 Dashboard - Creating new meeting:', newMeetingTitle);
      
      const { data, error } = await supabase
        .from('meetings')
        .insert([
          {
            title: newMeetingTitle,
            host_id: user.id,
            status: 'scheduled'
          }
        ])
        .select()
        .single();

      if (error) {
        console.error('❌ Dashboard - Failed to create meeting:', error);
        throw error;
      }

      console.log('✅ Dashboard - Meeting created:', data.id);
      setShowCreateModal(false);
      setNewMeetingTitle('');
      
      // 회의 목록 새로고침
      await loadMeetings();
      
      // 회의 페이지로 이동
      router.push(`/?meeting_id=${data.id}`);
    } catch (error) {
      console.error('Error creating meeting:', error);
      alert('회의 생성에 실패했습니다: ' + (error as any).message);
    }
  };

  const handleJoinMeeting = (meetingId: string) => {
    console.log('📊 Dashboard - Joining meeting:', meetingId);
    router.push(`/?meeting_id=${meetingId}`);
  };

  const handleLogout = async () => {
    console.log('📊 Dashboard - Logging out...');
    await signOut();
    router.push('/login');
  };

  // 로딩 중
  if (authLoading) {
    console.log('⏳ Dashboard - Auth loading...');
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">로딩 중...</p>
        </div>
      </div>
    );
  }

  // 인증되지 않은 경우
  if (!user) {
    console.log('❌ Dashboard - No user, showing redirect message');
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-gray-600">로그인이 필요합니다. 리다이렉트 중...</p>
        </div>
      </div>
    );
  }

  console.log('🎨 Dashboard - Rendering UI with', meetings.length, 'meetings');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">회의 대시보드</h1>
              <p className="text-sm text-gray-600 mt-1">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition font-medium"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        
        {/* Create Meeting Button */}
        <div className="mb-6">
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition shadow-md"
          >
            + 새 회의 만들기
          </button>
        </div>

        {/* Meetings List */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">내 회의 목록</h2>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-gray-600">회의 목록을 불러오는 중...</p>
            </div>
          ) : meetings.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <p>아직 생성된 회의가 없습니다.</p>
              <p className="text-sm mt-2">위의 "새 회의 만들기" 버튼을 눌러 회의를 시작하세요.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {meetings.map((meeting) => (
                <div
                  key={meeting.id}
                  className="px-6 py-4 hover:bg-gray-50 transition cursor-pointer"
                  onClick={() => handleJoinMeeting(meeting.id)}
                >
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-gray-900">{meeting.title}</h3>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                          meeting.status === 'active' || meeting.status === 'in_progress'
                            ? 'bg-green-100 text-green-800'
                            : meeting.status === 'scheduled' || meeting.status === 'waiting'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {meeting.status === 'active' || meeting.status === 'in_progress' ? '진행 중' :
                           meeting.status === 'scheduled' || meeting.status === 'waiting' ? '예정됨' :
                           meeting.status === 'completed' ? '종료됨' : meeting.status}
                        </span>
                        <span className="text-sm text-gray-500">
                          {new Date(meeting.created_at).toLocaleDateString('ko-KR')}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleJoinMeeting(meeting.id);
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-medium"
                    >
                      {meeting.status === 'completed' ? '열기' : '참여하기'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Create Meeting Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold text-gray-900 mb-4">새 회의 만들기</h2>
            <input
              type="text"
              value={newMeetingTitle}
              onChange={(e) => setNewMeetingTitle(e.target.value)}
              placeholder="회의 제목을 입력하세요"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateMeeting();
              }}
            />
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewMeetingTitle('');
                }}
                className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition font-medium"
              >
                취소
              </button>
              <button
                onClick={handleCreateMeeting}
                disabled={!newMeetingTitle.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                생성
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
