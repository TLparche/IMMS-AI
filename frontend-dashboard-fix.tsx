'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'

interface Meeting {
  id: string  // ← meeting_id가 아니라 id!
  title: string
  status: string
  created_at: string
  scheduled_at: string | null
  host_id: string  // ← host_user_id가 아니라 host_id!
}

export default function DashboardPage() {
  const router = useRouter()
  const { user, loading: authLoading, signOut } = useAuth()
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newMeetingTitle, setNewMeetingTitle] = useState('')

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      loadMeetings()
    }
  }, [user])

  const loadMeetings = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('meetings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('Failed to load meetings:', error)
    } else {
      setMeetings(data || [])
    }
    setLoading(false)
  }

  const handleCreateMeeting = async () => {
    if (!newMeetingTitle.trim() || !user) return

    const { data, error } = await supabase
      .from('meetings')
      .insert({
        title: newMeetingTitle.trim(),
        host_id: user.id,  // ← host_user_id가 아니라 host_id!
        status: 'scheduled'
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create meeting:', error)
      alert(`회의 생성에 실패했습니다: ${error.message}`)
    } else {
      setNewMeetingTitle('')
      setShowCreateModal(false)
      loadMeetings()
      // Redirect to meeting page
      router.push(`/?meeting_id=${data.id}`)  // ← meeting_id가 아니라 id!
    }
  }

  const handleJoinMeeting = (meetingId: string) => {
    router.push(`/?meeting_id=${meetingId}`)
  }

  const handleLogout = async () => {
    await signOut()
    router.push('/login')
  }

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">로딩 중...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">IMMS 대시보드</h1>
              <p className="text-sm text-gray-600 mt-1">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition font-medium"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {/* Create Meeting Button */}
        <div className="mb-8">
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold shadow-lg transition"
          >
            + 새 회의 만들기
          </button>
        </div>

        {/* Meetings List */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-900">내 회의 목록</h2>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-gray-600">회의 목록 불러오는 중...</p>
            </div>
          ) : meetings.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-gray-500 text-lg">아직 생성된 회의가 없습니다.</p>
              <p className="text-gray-400 mt-2">새 회의를 만들어보세요!</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {meetings.map((meeting) => (
                <div
                  key={meeting.id}  {/* ← meeting_id가 아니라 id! */}
                  className="p-6 hover:bg-gray-50 transition cursor-pointer"
                  onClick={() => handleJoinMeeting(meeting.id)}  {/* ← id 사용 */}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">
                        {meeting.title}
                      </h3>
                      <div className="flex items-center gap-4 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <span className={`w-2 h-2 rounded-full ${
                            meeting.status === 'active' || meeting.status === 'in_progress' ? 'bg-green-500' :
                            meeting.status === 'scheduled' || meeting.status === 'waiting' ? 'bg-blue-500' :
                            'bg-gray-400'
                          }`}></span>
                          {meeting.status === 'active' || meeting.status === 'in_progress' ? '진행 중' :
                           meeting.status === 'scheduled' || meeting.status === 'waiting' ? '예정됨' :
                           '완료됨'}
                        </span>
                        <span>생성일: {new Date(meeting.created_at).toLocaleDateString('ko-KR')}</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleJoinMeeting(meeting.id)  {/* ← id 사용 */}
                      }}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition text-sm"
                    >
                      {meeting.status === 'active' || meeting.status === 'in_progress' ? '참여하기' : '열기'}
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">새 회의 만들기</h2>
            <input
              type="text"
              value={newMeetingTitle}
              onChange={(e) => setNewMeetingTitle(e.target.value)}
              placeholder="회의 제목을 입력하세요"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-6"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateMeeting()
              }}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 px-4 py-3 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg font-medium transition"
              >
                취소
              </button>
              <button
                onClick={handleCreateMeeting}
                disabled={!newMeetingTitle.trim()}
                className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                생성
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
