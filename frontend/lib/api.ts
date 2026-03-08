// API functions for backend communication
const API_BASE_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8001/gateway'

export const connectLlm = async () => {
  // Placeholder
}

export const disconnectLlm = async () => {
  // Placeholder
}

export const getLastLlmJson = async () => {
  // Placeholder
  return null
}

export const getLlmStatus = async () => {
  // Placeholder
  return { status: 'ok' }
}

export const getState = async () => {
  // Placeholder
  return null
}

export const importJsonDir = async (dir: string) => {
  // Placeholder
}

export const importJsonFiles = async (files: File[]) => {
  // Placeholder
}

export const importJsonFilesReplay = async (files: File[]) => {
  // Placeholder
}

export const pingLlm = async () => {
  // Placeholder
  return { ok: true }
}

export const replayStep = async () => {
  // Placeholder
}

export const resetState = async () => {
  // Placeholder
}

export const saveConfig = async (config: any) => {
  // Placeholder
}

export const tickAnalysis = async () => {
  // Placeholder
}

export const transcribeChunk = async (audioBlob: Blob, speaker: string) => {
  const formData = new FormData()
  formData.append('audio_file', audioBlob, 'audio.webm')
  formData.append('speaker', speaker)

  const response = await fetch(`${API_BASE_URL}/transcribe`, {
    method: 'POST',
    body: formData
  })

  return response.json()
}
