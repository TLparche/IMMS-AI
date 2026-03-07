"use client";

import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter, useSearchParams } from "next/navigation";
import { WebSocketClient } from "@/lib/websocket";
import { AudioRecorder } from "@/lib/audio-recorder";
import { supabase } from "@/lib/supabase";

interface Transcript {
  id: string;
  speaker: string;
  text: string;
  timestamp: string;
}

interface Agenda {
  id: string;
  title: string;
  status: string;
}

interface Decision {
  id: string;
  text: string;
  status: string;
}

interface ActionItem {
  id: string;
  task: string;
  owner: string;
  due_date: string;
  status: string;
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const meetingId = searchParams.get('meeting_id');

  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  const wsClientRef = useRef<WebSocketClient | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);

  // 인증 및 회의 ID 체크 - 모두 useEffect 안에서 처리
  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        router.push('/login');
      } else if (!meetingId) {
        router.push('/dashboard');
      }
    }
  }, [user, authLoading, meetingId, router]);

  // WebSocket 초기화
  useEffect(() => {
    if (!user || !meetingId) return;
    
    const wsClient = new WebSocketClient(meetingId, user.id);
    wsClientRef.current = wsClient;

    // 전사 결과 수신
    wsClient.on('transcript', (data: any) => {
      console.log('📝 Received transcript:', data);
      setTranscripts(prev => [...prev, {
        id: Date.now().toString() + Math.random(),
        speaker: data.speaker || '알 수 없음',
        text: data.text || '',
        timestamp: data.timestamp || new Date().toISOString()
      }]);
    });

    // 분석 결과 수신
    wsClient.on('analysis_update', (data: any) => {
      console.log('📊 Received analysis:', data);
      if (data.agendas) setAgendas(data.agendas);
      if (data.decisions) setDecisions(data.decisions);
      if (data.actions) setActionItems(data.actions);
    });

    wsClient.connect();
    setWsConnected(true);

    return () => {
      wsClient.disconnect();
      setWsConnected(false);
    };
  }, [user, meetingId]);

  // 로딩 중이거나 인증되지 않은 경우
  if (authLoading || !user || !meetingId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">로딩 중...</p>
        </div>
      </div>
    );
  }

  // 녹음 토글
  const toggleRecording = async () => {
    if (!user) return;

    if (isRecording) {
      audioRecorderRef.current?.stop();
      setIsRecording(false);
      console.log('⏹️ 녹음 중지');
    } else {
      // AudioRecorder 초기화 (처음 시작 시)
      if (!audioRecorderRef.current) {
        const recorder = new AudioRecorder();
        const initialized = await recorder.initialize();
        
        if (!initialized) {
          alert('마이크 접근 권한이 필요합니다.');
          return;
        }
        
        audioRecorderRef.current = recorder;
      }

      // 녹음 시작
      audioRecorderRef.current.start((audioBlob: Blob) => {
        // 오디오 청크를 WebSocket으로 전송
        if (wsClientRef.current?.isConnected()) {
          wsClientRef.current.sendAudioChunk(audioBlob, user.email || 'Unknown');
          console.log('🎤 Sent audio chunk');
        }
      });
      
      setIsRecording(true);
      console.log('녹음 시작');
    }
  };

  // 분석 요청
  const requestAnalysis = () => {
    if (wsClientRef.current?.isConnected()) {
      wsClientRef.current.sendMessage('request_analysis', {});
      console.log('Requested analysis');
      alert('분석이 요청되었습니다. 잠시 후 결과가 표시됩니다.');
    } else {
      alert('WebSocket이 연결되지 않았습니다.');
    }
  };

  // 회의 종료
  const endMeeting = async () => {
    if (!meetingId) return;
    
    if (!confirm('회의를 종료하시겠습니까?')) return;

    // 녹음 중지
    if (isRecording) {
      audioRecorderRef.current?.stop();
      setIsRecording(false);
    }

    // WebSocket 연결 종료
    wsClientRef.current?.disconnect();

    try {
      // Supabase에서 회의 상태 업데이트
      const { error } = await supabase
        .from('meetings')
        .update({ 
          status: 'completed',
          ended_at: new Date().toISOString() 
        })
        .eq('id', meetingId);

      if (error) throw error;

      alert('회의가 종료되었습니다.');
      router.push('/dashboard');
    } catch (error) {
      console.error('Failed to end meeting:', error);
      alert('회의 종료에 실패했습니다.');
    }
  };

  // 리포트 생성
  const generateReport = async () => {
    if (!meetingId) return;

    try {
      const response = await fetch(`http://localhost:8001/gateway/reports/${meetingId}`, {
        method: 'POST'
      });

      if (response.ok) {
        const data = await response.json();
        alert('리포트가 생성되었습니다!');
        console.log('Report:', data);
      } else {
        alert('리포트 생성에 실패했습니다.');
      }
    } catch (error) {
      console.error('Failed to generate report:', error);
      alert('리포트 생성에 실패했습니다.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">회의 워크스페이스</h1>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-sm text-gray-600">Meeting ID: {meetingId.substring(0, 8)}...</p>
                <span className={`inline-block w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
                <span className="text-xs text-gray-500">
                  {wsConnected ? 'WebSocket 연결됨' : 'WebSocket 연결 안 됨'}
                </span>
              </div>
            </div>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition font-medium"
            >
              대시보드로 돌아가기
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left: 실시간 전사 */}
          <div className="lg:col-span-1 bg-white rounded-xl shadow-md border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">실시간 전사</h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {transcripts.length === 0 ? (
                <p className="text-gray-500 text-sm">녹음을 시작하면 전사 내용이 여기에 표시됩니다.</p>
              ) : (
                transcripts.map(t => (
                  <div key={t.id} className="bg-blue-50 p-3 rounded-lg">
                    <p className="text-sm text-gray-700">
                      <span className="font-semibold">{t.speaker}:</span> {t.text}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(t.timestamp).toLocaleTimeString('ko-KR')}
                    </p>
                  </div>
                ))
              )}
            </div>
            
            {/* 마이크 컨트롤 */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <button
                onClick={toggleRecording}
                className={`w-full px-4 py-3 rounded-lg font-semibold transition ${
                  isRecording 
                    ? 'bg-red-600 hover:bg-red-700 text-white' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {isRecording ? '녹음 중지' : '녹음 시작'}
              </button>
            </div>
          </div>

          {/* Center: 안건 분석 */}
          <div className="lg:col-span-1 bg-white rounded-xl shadow-md border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">안건 분석</h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {agendas.length === 0 ? (
                <p className="text-gray-500 text-sm">분석 요청 버튼을 눌러 AI가 안건을 분석하도록 할 수 있습니다.</p>
              ) : (
                agendas.map((agenda, idx) => (
                  <div key={agenda.id} className="border-l-4 border-blue-500 pl-3 py-2">
                    <h3 className="font-semibold text-gray-900">{idx + 1}. {agenda.title}</h3>
                    <div className="mt-2">
                      <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                        agenda.status === 'ACTIVE' ? 'bg-yellow-100 text-yellow-800' :
                        agenda.status === 'CLOSED' ? 'bg-green-100 text-green-800' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {agenda.status === 'ACTIVE' ? '진행 중' :
                         agenda.status === 'CLOSED' ? '종료됨' : '대기 중'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right: 의사결정 & 액션 */}
          <div className="lg:col-span-1 space-y-6">
            
            {/* 의사결정 */}
            <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">의사결정</h2>
              <div className="space-y-3 max-h-48 overflow-y-auto">
                {decisions.length === 0 ? (
                  <p className="text-gray-500 text-sm">AI 분석 후 의사결정 내용이 표시됩니다.</p>
                ) : (
                  decisions.map(decision => (
                    <div key={decision.id} className="bg-green-50 p-3 rounded-lg border border-green-200">
                      <p className="text-sm text-gray-700">{decision.text}</p>
                      <div className="mt-2">
                        <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                          decision.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {decision.status === 'approved' ? '✓ 승인' : '대기 중'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 액션 아이템 */}
            <div className="bg-white rounded-xl shadow-md border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">액션 아이템</h2>
              <div className="space-y-3 max-h-48 overflow-y-auto">
                {actionItems.length === 0 ? (
                  <p className="text-gray-500 text-sm">AI 분석 후 액션 아이템이 표시됩니다.</p>
                ) : (
                  actionItems.map(item => (
                    <div key={item.id} className="p-3 border border-gray-200 rounded-lg">
                      <p className="text-sm text-gray-700 font-medium">{item.task}</p>
                      <p className="text-xs text-gray-500 mt-1">담당: {item.owner}</p>
                      <p className="text-xs text-gray-500">기한: {item.due_date}</p>
                      <div className="mt-2">
                        <span className={`inline-block px-2 py-1 text-xs rounded-full ${
                          item.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
                          item.status === 'completed' ? 'bg-green-100 text-green-800' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {item.status === 'in_progress' ? '진행 중' :
                           item.status === 'completed' ? '완료' : '대기 중'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>

        {/* Bottom: 회의 컨트롤 */}
        <div className="mt-6 bg-white rounded-xl shadow-md border border-gray-200 p-6">
          <div className="flex justify-center gap-4">
            <button
              onClick={requestAnalysis}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition"
            >
              분석 요청
            </button>
            <button
              onClick={endMeeting}
              className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition"
            >
              회의 종료
            </button>
            <button
              onClick={generateReport}
              className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition"
            >
              리포트 생성
            </button>
          </div>
        </div>

      </main>
    </div>
  );
}
