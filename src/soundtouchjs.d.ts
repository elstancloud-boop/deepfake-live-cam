declare module 'soundtouchjs' {
  export class PitchShifter {
    constructor(ctx: AudioContext, source: AudioNode, bufferSize: number)
    tempo: number
    pitch: number
    connect(node: AudioNode): void
    disconnect(): void
  }
}
