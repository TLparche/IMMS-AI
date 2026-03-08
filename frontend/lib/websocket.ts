export class WebSocketClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 2000
  private meetingId: string
  private userId: string
  private messageHandlers: Map<string, (data: any) => void> = new Map()

  constructor(meetingId: string, userId: string) {
    this.meetingId = meetingId
    this.userId = userId
  }

  connect() {
    const wsUrl = process.env.NEXT_PUBLIC_GATEWAY_WS_URL || 'ws://localhost:8001/gateway/ws'
    const url = `${wsUrl}/${this.meetingId}?user_id=${this.userId}`

    console.log('🔌 Connecting to WebSocket:', url)

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
      console.error('❌ WebSocket error:', error)
    }

    this.ws.onclose = () => {
      console.log('🔌 WebSocket disconnected')
      this.attemptReconnect()
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      console.log(`🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
      setTimeout(() => this.connect(), this.reconnectDelay)
    } else {
      console.error('❌ Max reconnect attempts reached')
    }
  }

  on(eventType: string, handler: (data: any) => void) {
    this.messageHandlers.set(eventType, handler)
  }

  sendAudioChunk(audioBlob: Blob, speaker: string) {
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
        timestamp: new Date().toISOString()
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
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}
