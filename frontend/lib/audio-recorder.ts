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
  originalStartedAt?: string
  originalEndedAt?: string
  originalDurationMs?: number
  removedSilenceMs?: number
  combinedChunkCount?: number
  trimmedFromSilence?: boolean
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
const AUDIO_WORKLET_VERSION = "pcm-wav-v4"
const LONG_SILENCE_TRIM_MS = 1000
const SILENCE_EDGE_PADDING_MS = 120
const MIN_STT_SEND_DURATION_MS = 4000

type TrimmedPcmChunk = {
  samples: Float32Array
  removedSilenceMs: number
  originalDurationMs: number
  removedRangeCount: number
}

type PendingPcmChunk = {
  samples: Float32Array
  sourceSampleRate: number
  startedAtMs: number
  endedAtMs: number
  chunkIndexes: number[]
  originalDurationMs: number
  removedSilenceMs: number
  originalStartedAtMs: number
  originalEndedAtMs: number
}

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

function concatFloat32Arrays(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function trimLongSilence(samples: Float32Array, sampleRate: number): TrimmedPcmChunk {
  if (!samples.length) {
    return {
      samples,
      removedSilenceMs: 0,
      originalDurationMs: 0,
      removedRangeCount: 0,
    }
  }

  const originalDurationMs = Math.max(1, Math.round((samples.length / Math.max(sampleRate, 1)) * 1000))
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02))
  const minSilentFrames = Math.max(1, Math.ceil(LONG_SILENCE_TRIM_MS / 20))
  const paddingFrames = Math.max(0, Math.ceil(SILENCE_EDGE_PADDING_MS / 20))
  const frameCount = Math.ceil(samples.length / frameSize)
  const chunkMetrics = calculatePcmMetrics(samples, sampleRate)
  const silenceRmsThreshold = Math.max(0.004, Math.min(0.012, (chunkMetrics.noiseFloor || 0.0015) * 2.6))
  const silencePeakThreshold = Math.max(0.014, Math.min(0.04, silenceRmsThreshold * 4))
  const silentFrames: boolean[] = []

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = frameIndex * frameSize
    const count = Math.min(frameSize, samples.length - offset)
    let sumSquares = 0
    let peak = 0

    for (let index = 0; index < count; index += 1) {
      const sample = samples[offset + index] || 0
      const abs = Math.abs(sample)
      sumSquares += sample * sample
      peak = Math.max(peak, abs)
    }

    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0
    silentFrames.push(rms <= silenceRmsThreshold && peak <= silencePeakThreshold)
  }

  const removalRanges: Array<{ start: number; end: number }> = []
  let runStart = -1

  const closeRun = (runEnd: number) => {
    if (runStart < 0) return
    const runLength = runEnd - runStart
    if (runLength >= minSilentFrames) {
      const removeStartFrame = runStart + paddingFrames
      const removeEndFrame = runEnd - paddingFrames
      if (removeEndFrame > removeStartFrame) {
        removalRanges.push({
          start: Math.min(removeStartFrame * frameSize, samples.length),
          end: Math.min(removeEndFrame * frameSize, samples.length),
        })
      }
    }
    runStart = -1
  }

  for (let frameIndex = 0; frameIndex < silentFrames.length; frameIndex += 1) {
    if (silentFrames[frameIndex]) {
      if (runStart < 0) runStart = frameIndex
    } else {
      closeRun(frameIndex)
    }
  }
  closeRun(silentFrames.length)

  if (removalRanges.length === 0) {
    return {
      samples,
      removedSilenceMs: 0,
      originalDurationMs,
      removedRangeCount: 0,
    }
  }

  let removedSamples = 0
  let cursor = 0
  const kept: Float32Array[] = []

  for (const range of removalRanges) {
    if (range.start > cursor) {
      kept.push(samples.slice(cursor, range.start))
    }
    removedSamples += Math.max(0, range.end - range.start)
    cursor = Math.max(cursor, range.end)
  }

  if (cursor < samples.length) {
    kept.push(samples.slice(cursor))
  }

  return {
    samples: concatFloat32Arrays(kept),
    removedSilenceMs: Math.round((removedSamples / Math.max(sampleRate, 1)) * 1000),
    originalDurationMs,
    removedRangeCount: removalRanges.length,
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
  private pendingPcmChunk: PendingPcmChunk | null = null

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
    this.emittedChunkCount += 1
    this.scheduleChunkWatchdog()

    const trimmedChunk = trimLongSilence(samples, sourceSampleRate)
    this.queuePcmChunkForStt(trimmedChunk, sourceSampleRate, startedAtMs, endedAtMs, chunkIndex)
    this.resolvePendingFlush()
  }

  private queuePcmChunkForStt(
    trimmedChunk: TrimmedPcmChunk,
    sourceSampleRate: number,
    startedAtMs: number,
    endedAtMs: number,
    chunkIndex: number,
  ) {
    if (!trimmedChunk.samples.length) {
      console.info("[STT] long silence trim removed entire chunk", {
        chunkIndex,
        originalDurationMs: trimmedChunk.originalDurationMs,
        removedSilenceMs: trimmedChunk.removedSilenceMs,
      })
      return
    }

    if (this.pendingPcmChunk && this.pendingPcmChunk.sourceSampleRate !== sourceSampleRate) {
      this.emitPendingPcmChunk(true)
    }

    if (!this.pendingPcmChunk) {
      this.pendingPcmChunk = {
        samples: trimmedChunk.samples,
        sourceSampleRate,
        startedAtMs,
        endedAtMs,
        chunkIndexes: [chunkIndex],
        originalDurationMs: trimmedChunk.originalDurationMs,
        removedSilenceMs: trimmedChunk.removedSilenceMs,
        originalStartedAtMs: startedAtMs,
        originalEndedAtMs: endedAtMs,
      }
    } else {
      this.pendingPcmChunk.samples = concatFloat32Arrays([this.pendingPcmChunk.samples, trimmedChunk.samples])
      this.pendingPcmChunk.endedAtMs = endedAtMs
      this.pendingPcmChunk.originalEndedAtMs = endedAtMs
      this.pendingPcmChunk.chunkIndexes.push(chunkIndex)
      this.pendingPcmChunk.originalDurationMs += trimmedChunk.originalDurationMs
      this.pendingPcmChunk.removedSilenceMs += trimmedChunk.removedSilenceMs
    }

    const pendingDurationMs = Math.round(
      (this.pendingPcmChunk.samples.length / Math.max(this.pendingPcmChunk.sourceSampleRate, 1)) * 1000,
    )

    if (pendingDurationMs < MIN_STT_SEND_DURATION_MS) {
      console.info("[STT] trimmed chunk held until next chunk", {
        chunkIndex,
        pendingDurationMs,
        minSendDurationMs: MIN_STT_SEND_DURATION_MS,
        removedSilenceMs: this.pendingPcmChunk.removedSilenceMs,
        combinedChunkCount: this.pendingPcmChunk.chunkIndexes.length,
      })
      return
    }

    this.emitPendingPcmChunk(false)
  }

  private emitPendingPcmChunk(force: boolean) {
    if (!this.pendingPcmChunk || !this.onChunkReady) {
      return
    }

    const pending = this.pendingPcmChunk
    const pendingDurationMs = Math.round((pending.samples.length / Math.max(pending.sourceSampleRate, 1)) * 1000)

    if (!force && pendingDurationMs < MIN_STT_SEND_DURATION_MS) {
      return
    }

    if (force && pendingDurationMs < MIN_FLUSH_DURATION_MS) {
      this.pendingPcmChunk = null
      return
    }

    const wav = encodeWav(pending.samples, pending.sourceSampleRate)
    const sampleMetrics = calculatePcmMetrics(pending.samples, pending.sourceSampleRate)
    const chunkIndex = pending.chunkIndexes[0] ?? 0
    const startedAtMs = pending.startedAtMs
    const endedAtMs = pending.endedAtMs
    const metrics = this.normalizeMetrics(sampleMetrics, startedAtMs, endedAtMs, pending.sourceSampleRate)
    metrics.sourceSampleRate = pending.sourceSampleRate
    metrics.sampleRate = wav.sampleRate
    metrics.chunkIndex = chunkIndex
    metrics.mimeType = "audio/wav"
    metrics.originalStartedAt = new Date(pending.originalStartedAtMs).toISOString()
    metrics.originalEndedAt = new Date(pending.originalEndedAtMs).toISOString()
    metrics.originalDurationMs = pending.originalDurationMs
    metrics.removedSilenceMs = pending.removedSilenceMs
    metrics.combinedChunkCount = pending.chunkIndexes.length
    metrics.trimmedFromSilence = pending.removedSilenceMs > 0 || pending.chunkIndexes.length > 1

    console.info("[STT] silence-trimmed WAV chunk ready", {
      chunkIndexes: pending.chunkIndexes,
      force,
      sentDurationMs: metrics.durationMs,
      originalDurationMs: metrics.originalDurationMs,
      removedSilenceMs: metrics.removedSilenceMs,
      combinedChunkCount: metrics.combinedChunkCount,
      bytes: wav.blob.size,
    })

    this.onChunkReady({
      blob: wav.blob,
      metrics,
    })
    this.pendingPcmChunk = null
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
    this.pendingPcmChunk = null
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

      this.emitPendingPcmChunk(true)
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
