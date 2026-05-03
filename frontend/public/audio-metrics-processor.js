function createAccumulator() {
  return {
    frames: 0,
    speechFrames: 0,
    sumRms: 0,
    sumZeroCrossingRate: 0,
    peak: 0,
    noiseSamples: 0,
    noiseRmsSum: 0,
    sampleCount: 0,
  }
}

class AudioMetricsProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.intervalMs = 7000
    this.minFlushDurationMs = 350
    this.targetSamples = Math.max(1, Math.round((sampleRate * this.intervalMs) / 1000))
    this.chunkIndex = 0
    this.writeIndex = 0
    this.chunkBuffer = new Float32Array(this.targetSamples)
    this.chunkMetrics = createAccumulator()
    this.meterMetrics = createAccumulator()
    this.meterSampleTarget = Math.max(1, Math.round(sampleRate * 0.5))
    this.learnedNoiseFloor = 0.0025
    this.recording = false

    this.port.onmessage = (event) => {
      const data = event.data || {}
      if (data.type === 'configure') {
        this.configure(data)
        return
      }
      if (data.type === 'start') {
        this.configure(data)
        this.resetChunkState()
        this.recording = true
        return
      }
      if (data.type === 'flush') {
        this.emitChunk(true)
        this.port.postMessage({ type: 'flush_complete' })
        return
      }
      if (data.type === 'stop') {
        this.emitChunk(true)
        this.port.postMessage({ type: 'flush_complete' })
        this.recording = false
      }
    }
  }

  configure(data) {
    const nextIntervalMs = Number(data.intervalMs || this.intervalMs)
    const nextMinFlushDurationMs = Number(data.minFlushDurationMs || this.minFlushDurationMs)
    this.intervalMs = Math.max(1000, nextIntervalMs)
    this.minFlushDurationMs = Math.max(0, nextMinFlushDurationMs)
    this.targetSamples = Math.max(1, Math.round((sampleRate * this.intervalMs) / 1000))
    if (this.chunkBuffer.length !== this.targetSamples) {
      const preserved = this.chunkBuffer.slice(0, Math.min(this.writeIndex, this.targetSamples))
      this.chunkBuffer = new Float32Array(this.targetSamples)
      this.chunkBuffer.set(preserved, 0)
      this.writeIndex = preserved.length
    }
  }

  resetChunkState() {
    this.chunkIndex = 0
    this.writeIndex = 0
    this.chunkBuffer = new Float32Array(this.targetSamples)
    this.chunkMetrics = createAccumulator()
    this.meterMetrics = createAccumulator()
  }

  mergeMetrics(target, metrics) {
    target.frames += 1
    target.sumRms += metrics.rms
    target.sumZeroCrossingRate += metrics.zeroCrossingRate
    target.peak = Math.max(target.peak, metrics.peak)
    target.sampleCount += metrics.sampleCount

    if (metrics.voiced) {
      target.speechFrames += 1
    } else {
      target.noiseSamples += 1
      target.noiseRmsSum += metrics.rms
      const instantNoise = metrics.rms > 0 ? metrics.rms : this.learnedNoiseFloor
      this.learnedNoiseFloor = this.learnedNoiseFloor * 0.92 + instantNoise * 0.08
    }
  }

  measureSamples(input, offset, count) {
    let sumSquares = 0
    let peak = 0
    let zeroCrossings = 0
    let prev = input[offset] || 0

    for (let index = 0; index < count; index += 1) {
      const sample = input[offset + index] || 0
      const abs = Math.abs(sample)
      sumSquares += sample * sample
      if (abs > peak) {
        peak = abs
      }
      if (index > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) {
        zeroCrossings += 1
      }
      prev = sample
    }

    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0
    const zeroCrossingRate = count > 1 ? zeroCrossings / (count - 1) : 0
    const voiced = rms > 0.015 || (rms > 0.006 && zeroCrossingRate > 0.01 && zeroCrossingRate < 0.35)

    return {
      rms,
      peak,
      zeroCrossingRate,
      voiced,
      sampleCount: count,
    }
  }

  summarizeMetrics(accumulator, sampleCount) {
    const frames = Math.max(accumulator.frames, 1)
    return {
      durationMs: Math.max(1, Math.round((sampleCount / sampleRate) * 1000)),
      rms: accumulator.sumRms / frames,
      peak: accumulator.peak,
      speechRatio: accumulator.speechFrames / frames,
      zeroCrossingRate: accumulator.sumZeroCrossingRate / frames,
      noiseFloor:
        accumulator.noiseSamples > 0
          ? accumulator.noiseRmsSum / accumulator.noiseSamples
          : this.learnedNoiseFloor,
      sampleCount,
    }
  }

  emitMeterIfReady() {
    if (this.meterMetrics.sampleCount < this.meterSampleTarget) {
      return
    }
    const sampleCount = this.meterMetrics.sampleCount
    this.port.postMessage({
      type: 'meter',
      sampleRate,
      metrics: this.summarizeMetrics(this.meterMetrics, sampleCount),
    })
    this.meterMetrics = createAccumulator()
  }

  emitChunk(force) {
    if (this.writeIndex <= 0) {
      return false
    }

    const durationMs = Math.round((this.writeIndex / sampleRate) * 1000)
    if (force && durationMs < this.minFlushDurationMs) {
      this.writeIndex = 0
      this.chunkMetrics = createAccumulator()
      return false
    }

    if (!force && this.writeIndex < this.targetSamples) {
      return false
    }

    const samples = this.chunkBuffer.slice(0, this.writeIndex)
    const metrics = this.summarizeMetrics(this.chunkMetrics, this.writeIndex)
    this.port.postMessage(
      {
        type: 'audio_chunk',
        chunkIndex: this.chunkIndex,
        sampleRate,
        samples,
        metrics,
      },
      [samples.buffer],
    )

    this.chunkIndex += 1
    this.writeIndex = 0
    this.chunkBuffer = new Float32Array(this.targetSamples)
    this.chunkMetrics = createAccumulator()
    return true
  }

  appendSamples(channelData) {
    let offset = 0

    while (offset < channelData.length) {
      const remaining = this.targetSamples - this.writeIndex
      const count = Math.min(remaining, channelData.length - offset)
      this.chunkBuffer.set(channelData.subarray(offset, offset + count), this.writeIndex)

      const metrics = this.measureSamples(channelData, offset, count)
      this.mergeMetrics(this.chunkMetrics, metrics)
      this.mergeMetrics(this.meterMetrics, metrics)

      this.writeIndex += count
      offset += count
      this.emitMeterIfReady()

      if (this.writeIndex >= this.targetSamples) {
        this.emitChunk(false)
      }
    }
  }

  process(inputs) {
    const input = inputs[0]
    const channelData = input && input[0]

    if (!channelData || channelData.length === 0) {
      return true
    }

    if (this.recording) {
      this.appendSamples(channelData)
    } else {
      const metrics = this.measureSamples(channelData, 0, channelData.length)
      this.mergeMetrics(this.meterMetrics, metrics)
      this.emitMeterIfReady()
    }

    return true
  }
}

registerProcessor('audio-metrics-processor', AudioMetricsProcessor)
