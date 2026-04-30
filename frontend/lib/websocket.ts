type WebSocketMessage = Record<string, unknown>
type WebSocketMessageHandler = (data: WebSocketMessage) => void

export class WebSocketClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private reconnectDelay = 2000
  private maxReconnectDelay = 15000
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private meetingId: string
  private userId: string
  private messageHandlers: Map<string, WebSocketMessageHandler> = new Map()
  private connectionStateHandler: ((connected: boolean) => void) | null = null

  constructor(meetingId: string, userId: string) {
    this.meetingId = meetingId
    this.userId = userId
  }

  private emitConnectionState(connected: boolean) {
    this.connectionStateHandler?.(connected)
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
      this.emitConnectionState(true)
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage
        console.log('📨 WebSocket message:', message)

        const messageType = typeof message.type === 'string' ? message.type : ''
        if (messageType && this.messageHandlers.has(messageType)) {
          const handler = this.messageHandlers.get(messageType)
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
      this.emitConnectionState(false)
      if (this.shouldReconnect) {
        this.attemptReconnect()
      }
    }
  }

  private attemptReconnect() {
    if (!this.shouldReconnect) {
      return
    }

    if (this.reconnectTimer) {
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), this.maxReconnectDelay)
    console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) {
        this.connect()
      }
    }, delay)
  }

  on(eventType: string, handler: WebSocketMessageHandler) {
    this.messageHandlers.set(eventType, handler)
  }

  onConnectionStateChange(handler: (connected: boolean) => void) {
    this.connectionStateHandler = handler
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

  sendMessage(type: string, data: Record<string, unknown>) {
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
    this.emitConnectionState(false)
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}
