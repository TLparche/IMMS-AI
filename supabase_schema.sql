-- IMMS Real-time Meeting System - Supabase Schema

-- Users table (Supabase Auth 연동)
-- Supabase Auth가 자동으로 auth.users 테이블을 생성하므로 별도 users 테이블은 불필요
-- 대신 user_profiles 테이블로 추가 정보 저장

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'participant',
  team TEXT,
  job TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings table
CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  goal TEXT,
  host_id UUID NOT NULL REFERENCES auth.users(id),
  status TEXT DEFAULT 'waiting', -- waiting, in_progress, completed
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Participants table
CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  role TEXT DEFAULT 'participant', -- host, participant
  UNIQUE(meeting_id, user_id)
);

-- Transcripts table
CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  turn_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agendas table
CREATE TABLE IF NOT EXISTS agendas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT DEFAULT 'PROPOSED', -- PROPOSED, ACTIVE, CLOSING, CLOSED
  flow_type TEXT DEFAULT 'discussion', -- discussion, decision, action-planning
  summary TEXT,
  keywords TEXT[], -- PostgreSQL array type
  start_turn_id INTEGER,
  end_turn_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Decisions table
CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_id UUID REFERENCES agendas(id) ON DELETE SET NULL,
  issue TEXT NOT NULL,
  conclusion TEXT,
  final_status TEXT DEFAULT 'Pending', -- Approved, Pending, Rejected
  evidence JSONB, -- Store as JSON array
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Action Items table
CREATE TABLE IF NOT EXISTS action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_id UUID REFERENCES agendas(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  status TEXT DEFAULT 'Open', -- Open, In progress, Done
  evidence JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  content JSONB NOT NULL, -- Store full report as JSON
  pdf_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shared runtime state for each meeting
CREATE TABLE IF NOT EXISTS meeting_runtime_states (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  shared_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  llm_cache JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Personal runtime state for each user inside a meeting
CREATE TABLE IF NOT EXISTS meeting_user_states (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  personal_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (meeting_id, user_id)
);

-- Enable Row Level Security (RLS)
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendas ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_runtime_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_user_states ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- user_profiles: 본인 프로필만 읽기/쓰기
CREATE POLICY "Users can view own profile" ON user_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON user_profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON user_profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- meetings: 호스트가 생성, 참여자도 읽기 가능
CREATE POLICY "Anyone can view meetings they participate in" ON meetings FOR SELECT USING (
  auth.uid() = host_id OR 
  EXISTS (SELECT 1 FROM participants WHERE participants.meeting_id = meetings.id AND participants.user_id = auth.uid())
);
CREATE POLICY "Users can create meetings" ON meetings FOR INSERT WITH CHECK (auth.uid() = host_id);
CREATE POLICY "Hosts can update own meetings" ON meetings FOR UPDATE USING (auth.uid() = host_id);

-- participants: 참여자 본인과 호스트가 관리
CREATE POLICY "Anyone can view participants of their meetings" ON participants FOR SELECT USING (
  EXISTS (SELECT 1 FROM meetings WHERE meetings.id = participants.meeting_id AND (meetings.host_id = auth.uid() OR participants.user_id = auth.uid()))
);
CREATE POLICY "Users can join meetings" ON participants FOR INSERT WITH CHECK (auth.uid() = user_id);

-- transcripts: 회의 참여자만 읽기 가능
CREATE POLICY "Participants can view transcripts" ON transcripts FOR SELECT USING (
  EXISTS (SELECT 1 FROM participants WHERE participants.meeting_id = transcripts.meeting_id AND participants.user_id = auth.uid())
);
CREATE POLICY "Participants can insert transcripts" ON transcripts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- agendas, decisions, action_items, reports: 회의 참여자만 읽기 가능
CREATE POLICY "Participants can view agendas" ON agendas FOR SELECT USING (
  EXISTS (SELECT 1 FROM participants WHERE participants.meeting_id = agendas.meeting_id AND participants.user_id = auth.uid())
);

CREATE POLICY "Participants can view decisions" ON decisions FOR SELECT USING (
  EXISTS (SELECT 1 FROM participants WHERE participants.meeting_id = decisions.meeting_id AND participants.user_id = auth.uid())
);

CREATE POLICY "Participants can view action_items" ON action_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM participants WHERE participants.meeting_id = action_items.meeting_id AND participants.user_id = auth.uid())
);

CREATE POLICY "Participants can view reports" ON reports FOR SELECT USING (
  EXISTS (SELECT 1 FROM participants p JOIN meetings m ON p.meeting_id = m.id WHERE m.id = reports.meeting_id AND p.user_id = auth.uid())
);

CREATE POLICY "Participants can view runtime states" ON meeting_runtime_states FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM meetings
    WHERE meetings.id = meeting_runtime_states.meeting_id
      AND (
        meetings.host_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM participants
          WHERE participants.meeting_id = meeting_runtime_states.meeting_id
            AND participants.user_id = auth.uid()
        )
      )
  )
);

CREATE POLICY "Participants can view own meeting user states" ON meeting_user_states FOR SELECT USING (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM meetings
    WHERE meetings.id = meeting_user_states.meeting_id
      AND (
        meetings.host_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM participants
          WHERE participants.meeting_id = meeting_user_states.meeting_id
            AND participants.user_id = auth.uid()
        )
      )
  )
);

CREATE POLICY "Participants can insert own meeting user states" ON meeting_user_states FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM meetings
    WHERE meetings.id = meeting_user_states.meeting_id
      AND (
        meetings.host_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM participants
          WHERE participants.meeting_id = meeting_user_states.meeting_id
            AND participants.user_id = auth.uid()
        )
      )
  )
);

CREATE POLICY "Participants can update own meeting user states" ON meeting_user_states FOR UPDATE USING (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM meetings
    WHERE meetings.id = meeting_user_states.meeting_id
      AND (
        meetings.host_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM participants
          WHERE participants.meeting_id = meeting_user_states.meeting_id
            AND participants.user_id = auth.uid()
        )
      )
  )
);
