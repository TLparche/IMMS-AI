export interface AudioChunkMetrics {
  startedAt: string
  endedAt: string
  durationMs: number
  rms: number
  peak: number
  speechRatio: number
  zeroCrossingRate: number
  noiseFloor: number
  sourceSampleRate?: number
  sampleRate?: number
  chunkIndex?: number
  mimeType?: string
}

export interface RecordedAudioChunk {
  blob: Blob
  metrics: AudioChunkMetrics
}

type WorkletChunkMetrics = {
  durationMs?: number
  rms?: number
  peak?: number
  speechRatio?: number
  zeroCrossingRate?: number
  noiseFloor?: number
  sampleCount?: number
}

type WorkletMessage = {
  type?: string
  chunkIndex?: number
  sampleRate?: number
  samples?: Float32Array
  metrics?: WorkletChunkMetrics
}

const TARGET_WAV_SAMPLE_RATE = 16000
const MIN_FLUSH_DURATION_MS = 350
const AUDIO_WORKLET_VERSION = "pcm-wav-v3"

function clampPcm16(sample: number) {
  const clipped = Math.max(-1, Math.min(1, sample))
  return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff
}

function resampleLinear(samples: Float32Array, sourceRate: number, targetRate: number) {
  if (!samples.length || sourceRate === targetRate) {
    return samples
  }

  const ratio = sourceRate / targetRate
  const targetLength = Math.max(1, Math.round(samples.length / ratio))
  const result = new Float32Array(targetLength)

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index * ratio
    const leftIndex = Math.floor(sourceIndex)
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1)
    const weight = sourceIndex - leftIndex
    result[index] = samples[leftIndex] * (1 - weight) + samples[rightIndex] * weight
  }

  return result
}

function encodeWav(samples: Float32Array, sourceRate: number, targetRate = TARGET_WAV_SAMPLE_RATE) {
  const pcmSamples = resampleLinear(samples, sourceRate, targetRate)
  const bytesPerSample = 2
  const channelCount = 1
  const dataSize = pcmSamples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let index = 0; index < pcmSamples.length; index += 1) {
    view.setInt16(offset, clampPcm16(pcmSamples[index]), true)
    offset += bytesPerSample
  }

  return {
    blob: new Blob([buffer], { type: "audio/wav" }),
    sampleRate: targetRate,
  }
}

function calculatePcmMetrics(samples: Float32Array, sampleRate: number): WorkletChunkMetrics {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02))
  let frames = 0
  let speechFrames = 0
  let sumRms = 0
  let sumZeroCrossingRate = 0
  let peak = 0
  let noiseFrames = 0
  let noiseRmsSum = 0

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const count = Math.min(frameSize, samples.length - offset)
    if (count <= 0) continue

    let sumSquares = 0
    let zeroCrossings = 0
    let prev = samples[offset] || 0

    for (let index = 0; index < count; index += 1) {
      const sample = samples[offset + index] || 0
      const abs = Math.abs(sample)
      sumSquares += sample * sample
      peak = Math.max(peak, abs)
      if (index > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) {
        zeroCrossings += 1
      }
      prev = sample
    }

    const rms = Math.sqrt(sumSquares / count)
    const zeroCrossingRate = count > 1 ? zeroCrossings / (count - 1) : 0
    const voiced = rms > 0.015 || (rms > 0.006 && zeroCrossingRate > 0.01 && zeroCrossingRate < 0.35)

    frames += 1
    sumRms += rms
    sumZeroCrossingRate += zeroCrossingRate
    if (voiced) {
      speechFrames += 1
    } else {
      noiseFrames += 1
      noiseRmsSum += rms
    }
  }

  const safeFrames = Math.max(frames, 1)
  return {
    durationMs: Math.max(1, Math.round((samples.length / Math.max(sampleRate, 1)) * 1000)),
    rms: sumRms / safeFrames,
    peak,
    speechRatio: speechFrames / safeFrames,
    zeroCrossingRate: sumZeroCrossingRate / safeFrames,
    noiseFloor: noiseFrames > 0 ? noiseRmsSum / noiseFrames : 0.0015,
    sampleCount: samples.length,
  }
}

export class AudioRecorder {
  private stream: MediaStream | null = null
  private recordingInterval = 7000
  private onChunkReady: ((chunk: RecordedAudioChunk) => void) | null = null
  private onMeterReady: ((metrics: AudioChunkMetrics) => void) | null = null

  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private chunkNode: AudioWorkletNode | null = null
  private sinkGainNode: GainNode | null = null

  private recordingStartedAtMs = 0
  private recording = false
  private teardownPromise: Promise<void> | null = null
  private pendingFlushResolvers: Array<() => void> = []
  private chunkWatchdogTimer: number | null = null
  private emittedChunkCount = 0
  private lastMeterAtMs = 0

  private handleWorkletMessage = (event: MessageEvent<WorkletMessage>) => {
    const data = event.data || {}
    if (data.type === "flush_complete") {
      this.resolvePendingFlush()
      return
    }

    if (data.type === "meter") {
      const now = Date.now()
      const metrics = this.normalizeMetrics(data.metrics, now - Number(data.metrics?.durationMs || 0), now, data.sampleRate)
      this.lastMeterAtMs = now
      this.onMeterReady?.(metrics)
      return
    }

    if (data.type !== "audio_chunk" || !data.samples || !this.onChunkReady) {
      return
    }

    const sourceSampleRate = Number(data.sampleRate || this.audioContext?.sampleRate || TARGET_WAV_SAMPLE_RATE)
    const samples = data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples)
    const durationMs =
      Number(data.metrics?.durationMs || 0) ||
      Math.max(1, Math.round((samples.length / Math.max(sourceSampleRate, 1)) * 1000))
    const chunkIndex = Number(data.chunkIndex || 0)
    const startedAtMs = this.recordingStartedAtMs + chunkIndex * this.recordingInterval
    const endedAtMs = startedAtMs + durationMs
    const wav = encodeWav(samples, sourceSampleRate)
    this.emittedChunkCount += 1
    this.scheduleChunkWatchdog()

    const sampleMetrics = calculatePcmMetrics(samples, sourceSampleRate)
    const metrics = this.normalizeMetrics(sampleMetrics, startedAtMs, endedAtMs, sourceSampleRate)
    metrics.sourceSampleRate = sourceSampleRate
    metrics.sampleRate = wav.sampleRate
    metrics.chunkIndex = chunkIndex
    metrics.mimeType = "audio/wav"

    if (
      data.metrics &&
      Number(data.metrics.rms || 0) === 0 &&
      Number(data.metrics.peak || 0) === 0 &&
      Number(data.metrics.speechRatio || 0) === 0 &&
      (metrics.rms > 0 || metrics.peak > 0)
    ) {
      console.info("[STT] chunk metrics recovered from PCM samples", {
        chunkIndex,
        workletMetrics: data.metrics,
        recoveredMetrics: {
          rms: metrics.rms,
          peak: metrics.peak,
          speechRatio: metrics.speechRatio,
          durationMs: metrics.durationMs,
        },
      })
    }

    this.onChunkReady({
      blob: wav.blob,
      metrics,
    })
    this.resolvePendingFlush()
  }

  private normalizeMetrics(
    rawMetrics: WorkletChunkMetrics | undefined,
    startedAtMs: number,
    endedAtMs: number,
    sampleRate?: number,
  ): AudioChunkMetrics {
    const metrics = rawMetrics || {}
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(Number(metrics.durationMs || endedAtMs - startedAtMs || 1), 1),
      rms: Number(metrics.rms || 0),
      peak: Number(metrics.peak || 0),
      speechRatio: Number(metrics.speechRatio || 0),
      zeroCrossingRate: Number(metrics.zeroCrossingRate || 0),
      noiseFloor: Number(metrics.noiseFloor || 0.0015),
      sourceSampleRate: sampleRate,
    }
  }

  async initialize(): Promise<boolean> {
    try {
      console.log("🎤 Requesting microphone access...")
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: TARGET_WAV_SAMPLE_RATE,
        },
      })

      this.audioContext = new AudioContext()
      await this.audioContext.audioWorklet.addModule(`/audio-metrics-processor.js?v=${AUDIO_WORKLET_VERSION}`)
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.chunkNode = new AudioWorkletNode(this.audioContext, "audio-metrics-processor")
      this.chunkNode.port.onmessage = this.handleWorkletMessage
      this.chunkNode.onprocessorerror = (event) => {
        console.error("❌ AudioWorklet processor crashed:", event)
      }
      this.chunkNode.port.postMessage({
        type: "configure",
        intervalMs: this.recordingInterval,
        minFlushDurationMs: MIN_FLUSH_DURATION_MS,
      })

      this.sinkGainNode = this.audioContext.createGain()
      this.sinkGainNode.gain.value = 0

      this.sourceNode.connect(this.chunkNode)
      this.chunkNode.connect(this.sinkGainNode)
      this.sinkGainNode.connect(this.audioContext.destination)

      console.log("✅ PCM/WAV audio recorder initialized", {
        workletVersion: AUDIO_WORKLET_VERSION,
        sampleRate: this.audioContext.sampleRate,
        intervalMs: this.recordingInterval,
      })
      return true
    } catch (error) {
      console.error("❌ Failed to initialize audio recorder:", error)
      return false
    }
  }

  start(onChunkReady: (chunk: RecordedAudioChunk) => void) {
    if (!this.chunkNode || !this.audioContext) {
      console.error("❌ AudioWorklet recorder not initialized")
      return
    }

    if (this.recording) {
      return
    }

    this.onChunkReady = onChunkReady
    this.recordingStartedAtMs = Date.now()
    this.recording = true
    this.emittedChunkCount = 0
    this.lastMeterAtMs = 0
    void this.audioContext.resume().then(() => {
      console.info("[STT] audio context resumed", {
        state: this.audioContext?.state,
        sampleRate: this.audioContext?.sampleRate,
        intervalMs: this.recordingInterval,
      })
    })
    this.chunkNode.port.postMessage({
      type: "start",
      intervalMs: this.recordingInterval,
      minFlushDurationMs: MIN_FLUSH_DURATION_MS,
    })
    this.scheduleChunkWatchdog()
    console.log("🎙️ Recording started")
  }

  stop() {
    if (!this.recording) {
      return
    }

    this.recording = false
    this.clearChunkWatchdog()
    this.chunkNode?.port.postMessage({ type: "stop" })
    console.log("⏹️ Recording stopped")
  }

  setMeterCallback(callback: ((metrics: AudioChunkMetrics) => void) | null) {
    this.onMeterReady = callback
  }

  private resolvePendingFlush() {
    const resolvers = this.pendingFlushResolvers.splice(0)
    resolvers.forEach((resolve) => resolve())
  }

  private waitForFlush(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        resolve()
      }
      const timer = window.setTimeout(finish, timeoutMs)
      this.pendingFlushResolvers.push(finish)
    })
  }

  private clearChunkWatchdog() {
    if (this.chunkWatchdogTimer) {
      window.clearTimeout(this.chunkWatchdogTimer)
      this.chunkWatchdogTimer = null
    }
  }

  private scheduleChunkWatchdog() {
    this.clearChunkWatchdog()
    if (!this.recording) {
      return
    }

    const expectedChunkCount = this.emittedChunkCount
    this.chunkWatchdogTimer = window.setTimeout(() => {
      if (!this.recording || this.emittedChunkCount !== expectedChunkCount) {
        return
      }

      console.warn("[STT] PCM 청크가 아직 생성되지 않음", {
        elapsedMs: Date.now() - this.recordingStartedAtMs,
        emittedChunkCount: this.emittedChunkCount,
        audioContextState: this.audioContext?.state,
        sampleRate: this.audioContext?.sampleRate,
        lastMeterAgoMs: this.lastMeterAtMs ? Date.now() - this.lastMeterAtMs : null,
        intervalMs: this.recordingInterval,
      })
      this.scheduleChunkWatchdog()
    }, this.recordingInterval + 1500)
  }

  private async releaseResources() {
    if (this.chunkNode) {
      this.chunkNode.port.onmessage = null
      try {
        this.chunkNode.disconnect()
      } catch {}
      this.chunkNode = null
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

    this.recording = false
    this.clearChunkWatchdog()
    this.onChunkReady = null
    this.onMeterReady = null
    this.pendingFlushResolvers = []
    this.recordingStartedAtMs = 0
    this.teardownPromise = null
    console.log("🧹 Audio recorder cleaned up")
  }

  async stopAndCleanup() {
    if (this.teardownPromise) {
      await this.teardownPromise
      return
    }

    if (!this.chunkNode) {
      await this.releaseResources()
      return
    }

    this.teardownPromise = (async () => {
      try {
        if (this.recording) {
          this.chunkNode?.port.postMessage({ type: "flush" })
          await this.waitForFlush(1000)
        }
      } catch (error) {
        console.warn("⚠️ Failed to flush final PCM chunk before stop:", error)
      }

      this.stop()
      await this.releaseResources()
    })()

    await this.teardownPromise
  }

  cleanup() {
    void this.stopAndCleanup()
  }

  isRecording(): boolean {
    return this.recording
  }

  setRecordingInterval(intervalMs: number) {
    this.recordingInterval = intervalMs
    this.chunkNode?.port.postMessage({
      type: "configure",
      intervalMs,
      minFlushDurationMs: MIN_FLUSH_DURATION_MS,
    })
  }
}
