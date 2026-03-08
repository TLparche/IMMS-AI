// Type definitions for meeting data

export interface MeetingState {
  meeting_goal: string
  initial_context: string
  window_size: number
  transcript: TranscriptUtterance[]
  agenda_stack: any[]
  llm_enabled: boolean
  analysis: any
}

export interface SttDebug {
  [key: string]: any
}

export interface TranscriptUtterance {
  turn_id: number
  speaker: string
  timestamp: string
  text: string
}
