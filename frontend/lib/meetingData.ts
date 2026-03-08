// Meeting data type definitions

export type AgendaStatus = 'Not started' | 'In progress' | 'Done'

export interface Agenda {
  id: string
  label: string
  title: string
  status: AgendaStatus
  progress: number
}

export interface ActionItem {
  id: string
  item: string
  owner: string
  due: string
  status: 'Open' | 'In progress' | 'Done'
}

export interface DecisionItem {
  id: string
  decision: string
  finalStatus: 'Approved' | 'Pending' | 'Rejected'
}

export interface EvidenceItem {
  id: string
  text: string
  supports: 'Action' | 'Decision' | 'Summary'
  turnId: number
}

export interface Participant {
  id: string
  name: string
  role: string
  status: 'Speaking' | 'Active' | 'Listening'
}

export interface TranscriptUtterance {
  turn_id: number
  speaker: string
  timestamp: string
  text: string
}
