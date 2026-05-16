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
  canvas_stage TEXT NOT NULL DEFAULT 'ideation',
  canvas_target_id TEXT NOT NULL DEFAULT '',
  turn_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Existing projects created before stage-aware STT need these columns.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS canvas_stage TEXT NOT NULL DEFAULT 'ideation';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS canvas_target_id TEXT NOT NULL DEFAULT '';

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

-- Helpful indexes for meeting-scoped queries
CREATE INDEX IF NOT EXISTS idx_meetings_host_created ON meetings(host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_participants_user_meeting ON participants(user_id, meeting_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_timestamp ON transcripts(meeting_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_runtime_user_states_user_meeting ON meeting_user_states(user_id, meeting_id);

-- RLS helper functions. SECURITY DEFINER avoids recursive RLS checks between meetings and participants.
-- Keep privileged helper functions out of the exposed public schema.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

DROP TRIGGER IF EXISTS ensure_meeting_host_participant ON meetings;
DROP FUNCTION IF EXISTS public.ensure_meeting_host_participant() CASCADE;
DROP FUNCTION IF EXISTS public.is_meeting_participant(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.is_meeting_host(UUID) CASCADE;

CREATE OR REPLACE FUNCTION private.is_meeting_host(target_meeting_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.meetings
    WHERE id = target_meeting_id
      AND host_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION private.is_meeting_participant(target_meeting_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT private.is_meeting_host(target_meeting_id)
    OR EXISTS (
      SELECT 1
      FROM public.participants
      WHERE meeting_id = target_meeting_id
        AND user_id = (SELECT auth.uid())
    );
$$;

GRANT EXECUTE ON FUNCTION private.is_meeting_host(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_meeting_participant(UUID) TO authenticated;

-- Always register the host as a participant so transcript/report RLS works after reload.
CREATE OR REPLACE FUNCTION private.ensure_meeting_host_participant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.participants (meeting_id, user_id, role)
  VALUES (NEW.id, NEW.host_id, 'host')
  ON CONFLICT (meeting_id, user_id)
  DO UPDATE SET role = 'host', left_at = NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ensure_meeting_host_participant
AFTER INSERT ON meetings
FOR EACH ROW
EXECUTE FUNCTION private.ensure_meeting_host_participant();

INSERT INTO public.participants (meeting_id, user_id, role)
SELECT id, host_id, 'host'
FROM public.meetings
ON CONFLICT (meeting_id, user_id)
DO UPDATE SET role = 'host', left_at = NULL;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON user_profiles;
CREATE POLICY "Users can view own profile" ON user_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON user_profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON user_profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Anyone can view meetings they participate in" ON meetings;
DROP POLICY IF EXISTS "Users can create meetings" ON meetings;
DROP POLICY IF EXISTS "Hosts can update own meetings" ON meetings;
CREATE POLICY "Anyone can view meetings they participate in" ON meetings FOR SELECT USING (
  private.is_meeting_participant(id)
);
CREATE POLICY "Users can create meetings" ON meetings FOR INSERT WITH CHECK (auth.uid() = host_id);
CREATE POLICY "Hosts can update own meetings" ON meetings FOR UPDATE USING (auth.uid() = host_id) WITH CHECK (auth.uid() = host_id);

DROP POLICY IF EXISTS "Anyone can view participants of their meetings" ON participants;
DROP POLICY IF EXISTS "Users can join meetings" ON participants;
DROP POLICY IF EXISTS "Users can update participants of their meetings" ON participants;
CREATE POLICY "Anyone can view participants of their meetings" ON participants FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);
CREATE POLICY "Users can join meetings" ON participants FOR INSERT WITH CHECK (
  auth.uid() = user_id OR private.is_meeting_host(meeting_id)
);
CREATE POLICY "Users can update participants of their meetings" ON participants FOR UPDATE USING (
  auth.uid() = user_id OR private.is_meeting_host(meeting_id)
) WITH CHECK (
  auth.uid() = user_id OR private.is_meeting_host(meeting_id)
);

DROP POLICY IF EXISTS "Participants can view transcripts" ON transcripts;
DROP POLICY IF EXISTS "Participants can insert transcripts" ON transcripts;
CREATE POLICY "Participants can view transcripts" ON transcripts FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);
CREATE POLICY "Participants can insert transcripts" ON transcripts FOR INSERT WITH CHECK (
  auth.uid() = user_id AND private.is_meeting_participant(meeting_id)
);

DROP POLICY IF EXISTS "Participants can view agendas" ON agendas;
DROP POLICY IF EXISTS "Participants can view decisions" ON decisions;
DROP POLICY IF EXISTS "Participants can view action_items" ON action_items;
DROP POLICY IF EXISTS "Participants can view reports" ON reports;
CREATE POLICY "Participants can view agendas" ON agendas FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);

CREATE POLICY "Participants can view decisions" ON decisions FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);

CREATE POLICY "Participants can view action_items" ON action_items FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);

CREATE POLICY "Participants can view reports" ON reports FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);

DROP POLICY IF EXISTS "Participants can view runtime states" ON meeting_runtime_states;
CREATE POLICY "Participants can view runtime states" ON meeting_runtime_states FOR SELECT USING (
  private.is_meeting_participant(meeting_id)
);

DROP POLICY IF EXISTS "Participants can view own meeting user states" ON meeting_user_states;
DROP POLICY IF EXISTS "Participants can insert own meeting user states" ON meeting_user_states;
DROP POLICY IF EXISTS "Participants can update own meeting user states" ON meeting_user_states;
CREATE POLICY "Participants can view own meeting user states" ON meeting_user_states FOR SELECT USING (
  user_id = auth.uid()
  AND private.is_meeting_participant(meeting_id)
);

CREATE POLICY "Participants can insert own meeting user states" ON meeting_user_states FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND private.is_meeting_participant(meeting_id)
);

CREATE POLICY "Participants can update own meeting user states" ON meeting_user_states FOR UPDATE USING (
  user_id = auth.uid()
  AND private.is_meeting_participant(meeting_id)
) WITH CHECK (
  user_id = auth.uid()
  AND private.is_meeting_participant(meeting_id)
);
