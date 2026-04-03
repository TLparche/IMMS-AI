export class WebSocketClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 2000
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private meetingId: string
  private userId: string
  private messageHandlers: Map<string, (data: any) => void> = new Map()

  constructor(meetingId: string, userId: string) {
    this.meetingId = meetingId
    this.userId = userId
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const wsUrl = process.env.NEXT_PUBLIC_GATEWAY_WS_URL || 'ws://localhost:8001/gateway/ws'
    const url = `${wsUrl}/${this.meetingId}?user_id=${this.userId}`

    console.log('🔌 Connecting to WebSocket:', url)
    this.shouldReconnect = true

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected')
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        console.log('📨 WebSocket message:', message)

        if (message.type && this.messageHandlers.has(message.type)) {
          const handler = this.messageHandlers.get(message.type)
          if (handler) handler(message)
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    this.ws.onerror = (error) => {
      if (!this.shouldReconnect) {
        return
      }
      console.error('❌ WebSocket error:', error)
    }

    this.ws.onclose = () => {
      console.log('🔌 WebSocket disconnected')
      this.ws = null
      if (this.shouldReconnect) {
        this.attemptReconnect()
      }
    }
  }

  private attemptReconnect() {
    if (!this.shouldReconnect) {
      return
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      console.log(`🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.shouldReconnect) {
          this.connect()
        }
      }, this.reconnectDelay)
    } else {
      console.error('❌ Max reconnect attempts reached')
    }
  }

  on(eventType: string, handler: (data: any) => void) {
    this.messageHandlers.set(eventType, handler)
  }

  sendAudioChunk(
    audioBlob: Blob,
    speaker: string,
    audioMeta?: {
      startedAt: string
      endedAt: string
      durationMs: number
      rms: number
      peak: number
      speechRatio: number
      zeroCrossingRate: number
      noiseFloor: number
    },
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ WebSocket not connected, cannot send audio')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const base64Audio = (reader.result as string).split(',')[1]
      
      const message = {
        type: 'audio_chunk',
        meeting_id: this.meetingId,
        user_id: this.userId,
        speaker,
        audio_data: base64Audio,
        timestamp: new Date().toISOString(),
        audio_meta: audioMeta
      }

      this.ws?.send(JSON.stringify(message))
      console.log('🎤 Sent audio chunk')
    }
    reader.readAsDataURL(audioBlob)
  }

  sendMessage(type: string, data: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ WebSocket not connected, cannot send message')
      return
    }

    const message = {
      type,
      meeting_id: this.meetingId,
      user_id: this.userId,
      ...data
    }

    this.ws.send(JSON.stringify(message))
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}
