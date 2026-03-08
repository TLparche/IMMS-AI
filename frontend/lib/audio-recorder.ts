export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private stream: MediaStream | null = null
  private recordingInterval: number = 5000 // 5초마다 청크 전송
  private intervalId: NodeJS.Timeout | null = null
  private onChunkReady: ((chunk: Blob) => void) | null = null

  async initialize(): Promise<boolean> {
    try {
      console.log('🎤 Requesting microphone access...')
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000
        } 
      })

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: 'audio/webm;codecs=opus'
      })

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstop = () => {
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
          if (this.onChunkReady) {
            this.onChunkReady(audioBlob)
          }
          this.audioChunks = []
        }
      }

      console.log('✅ Audio recorder initialized')
      return true
    } catch (error) {
      console.error('❌ Failed to initialize audio recorder:', error)
      return false
    }
  }

  start(onChunkReady: (chunk: Blob) => void) {
    if (!this.mediaRecorder) {
      console.error('❌ MediaRecorder not initialized')
      return
    }

    this.onChunkReady = onChunkReady

    // 주기적으로 녹음 재시작하여 청크 생성
    this.intervalId = setInterval(() => {
      if (this.mediaRecorder?.state === 'recording') {
        this.mediaRecorder.stop()
      }
      this.mediaRecorder?.start()
    }, this.recordingInterval)

    this.mediaRecorder.start()
    console.log('🎙️ Recording started')
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop()
      console.log('⏹️ Recording stopped')
    }
  }

  cleanup() {
    this.stop()
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }

    this.mediaRecorder = null
    this.audioChunks = []
    console.log('🧹 Audio recorder cleaned up')
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording'
  }

  setRecordingInterval(intervalMs: number) {
    this.recordingInterval = intervalMs
  }
}
