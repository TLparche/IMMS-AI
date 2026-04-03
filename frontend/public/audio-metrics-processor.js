class AudioMetricsProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    const channelData = input && input[0]

    if (!channelData || channelData.length === 0) {
      return true
    }

    let sumSquares = 0
    let peak = 0
    let zeroCrossings = 0
    let prev = channelData[0]

    for (let i = 0; i < channelData.length; i += 1) {
      const sample = channelData[i]
      const abs = Math.abs(sample)
      sumSquares += sample * sample
      if (abs > peak) {
        peak = abs
      }
      if (i > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) {
        zeroCrossings += 1
      }
      prev = sample
    }

    const rms = Math.sqrt(sumSquares / channelData.length)
    const zeroCrossingRate = channelData.length > 1 ? zeroCrossings / (channelData.length - 1) : 0
    const voiced = rms > 0.015 || (rms > 0.006 && zeroCrossingRate > 0.01 && zeroCrossingRate < 0.35)

    this.port.postMessage({
      rms,
      peak,
      zeroCrossingRate,
      voiced,
    })

    return true
  }
}

registerProcessor('audio-metrics-processor', AudioMetricsProcessor)
