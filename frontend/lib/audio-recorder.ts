export interface AudioChunkMetrics {
  startedAt: string
  endedAt: string
  durationMs: number
  rms: number
  peak: number
  speechRatio: number
  zeroCrossingRate: number
  noiseFloor: number
}

export interface RecordedAudioChunk {
  blob: Blob
  metrics: AudioChunkMetrics
}

type ChunkMetricsAccumulator = {
  frames: number
  speechFrames: number
  sumRms: number
  sumZeroCrossingRate: number
  peak: number
  noiseSamples: number
  noiseRmsSum: number
}

function createAccumulator(): ChunkMetricsAccumulator {
  return {
    frames: 0,
    speechFrames: 0,
    sumRms: 0,
    sumZeroCrossingRate: 0,
    peak: 0,
    noiseSamples: 0,
    noiseRmsSum: 0,
  }
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private recordingInterval = 7000
  private onChunkReady: ((chunk: RecordedAudioChunk) => void) | null = null

  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private metricsNode: AudioWorkletNode | null = null
  private sinkGainNode: GainNode | null = null

  private chunkStartedAt: number | null = null
  private chunkMetrics: ChunkMetricsAccumulator = createAccumulator()
  private learnedNoiseFloor = 0.0025
  private teardownPromise: Promise<void> | null = null

  private consumeMetrics = (event: MessageEvent) => {
    const data = event.data as {
      rms?: number
      peak?: number
      zeroCrossingRate?: number
      voiced?: boolean
    }

    const rms = Number(data?.rms || 0)
    const peak = Number(data?.peak || 0)
    const zeroCrossingRate = Number(data?.zeroCrossingRate || 0)
    const voiced = Boolean(data?.voiced)

    this.chunkMetrics.frames += 1
    this.chunkMetrics.sumRms += rms
    this.chunkMetrics.sumZeroCrossingRate += zeroCrossingRate
    this.chunkMetrics.peak = Math.max(this.chunkMetrics.peak, peak)

    if (voiced) {
      this.chunkMetrics.speechFrames += 1
    } else {
      this.chunkMetrics.noiseSamples += 1
      this.chunkMetrics.noiseRmsSum += rms
      const instantNoise = rms > 0 ? rms : this.learnedNoiseFloor
      this.learnedNoiseFloor = this.learnedNoiseFloor * 0.92 + instantNoise * 0.08
    }
  }

  async initialize(): Promise<boolean> {
    try {
      console.log('🎤 Requesting microphone access...')
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      })

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: 'audio/webm;codecs=opus',
      })

      this.mediaRecorder.ondataavailable = (event) => {
        if (!event.data || event.data.size <= 0 || !this.onChunkReady) {
          return
        }

        const endedAtMs = Date.now()
        const startedAtMs = this.chunkStartedAt ?? endedAtMs - this.recordingInterval
        const frameCount = Math.max(this.chunkMetrics.frames, 1)
        const noiseFloor =
          this.chunkMetrics.noiseSamples > 0
            ? this.chunkMetrics.noiseRmsSum / this.chunkMetrics.noiseSamples
            : this.learnedNoiseFloor

        const metrics: AudioChunkMetrics = {
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: Math.max(endedAtMs - startedAtMs, 1),
          rms: this.chunkMetrics.sumRms / frameCount,
          peak: this.chunkMetrics.peak,
          speechRatio: this.chunkMetrics.speechFrames / frameCount,
          zeroCrossingRate: this.chunkMetrics.sumZeroCrossingRate / frameCount,
          noiseFloor,
        }

        this.onChunkReady({
          blob: event.data,
          metrics,
        })

        this.chunkMetrics = createAccumulator()
        this.chunkStartedAt = endedAtMs
      }

      this.audioContext = new AudioContext()
      await this.audioContext.audioWorklet.addModule('/audio-metrics-processor.js')
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.metricsNode = new AudioWorkletNode(this.audioContext, 'audio-metrics-processor')
      this.metricsNode.port.onmessage = this.consumeMetrics

      this.sinkGainNode = this.audioContext.createGain()
      this.sinkGainNode.gain.value = 0

      this.sourceNode.connect(this.metricsNode)
      this.metricsNode.connect(this.sinkGainNode)
      this.sinkGainNode.connect(this.audioContext.destination)

      console.log('✅ Audio recorder initialized')
      return true
    } catch (error) {
      console.error('❌ Failed to initialize audio recorder:', error)
      return false
    }
  }

  start(onChunkReady: (chunk: RecordedAudioChunk) => void) {
    if (!this.mediaRecorder) {
      console.error('❌ MediaRecorder not initialized')
      return
    }

    if (this.mediaRecorder.state === 'recording') {
      return
    }

    this.onChunkReady = onChunkReady
    this.chunkMetrics = createAccumulator()
    this.chunkStartedAt = Date.now()
    void this.audioContext?.resume()
    this.mediaRecorder.start(this.recordingInterval)
    console.log('🎙️ Recording started')
  }

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop()
      console.log('⏹️ Recording stopped')
    }
  }

  private async releaseResources() {
    if (this.metricsNode) {
      this.metricsNode.port.onmessage = null
      try {
        this.metricsNode.disconnect()
      } catch {}
      this.metricsNode = null
    }

    if (this.sinkGainNode) {
      try {
        this.sinkGainNode.disconnect()
      } catch {}
      this.sinkGainNode = null
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {}
      this.sourceNode = null
    }

    if (this.audioContext) {
      try {
        await this.audioContext.close()
      } catch {}
      this.audioContext = null
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }

    this.mediaRecorder = null
    this.onChunkReady = null
    this.chunkMetrics = createAccumulator()
    this.chunkStartedAt = null
    this.teardownPromise = null
    console.log('🧹 Audio recorder cleaned up')
  }

  async stopAndCleanup() {
    if (this.teardownPromise) {
      await this.teardownPromise
      return
    }

    const recorder = this.mediaRecorder
    if (!recorder || recorder.state === 'inactive') {
      await this.releaseResources()
      return
    }

    this.teardownPromise = new Promise<void>((resolve) => {
      const finalize = () => {
        window.setTimeout(() => {
          void this.releaseResources().finally(resolve)
        }, 0)
      }

      recorder.addEventListener('stop', finalize, { once: true })
      recorder.addEventListener('error', finalize, { once: true })
      this.stop()
    })

    await this.teardownPromise
  }

  cleanup() {
    void this.stopAndCleanup()
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording'
  }

  setRecordingInterval(intervalMs: number) {
    this.recordingInterval = intervalMs
  }
}
