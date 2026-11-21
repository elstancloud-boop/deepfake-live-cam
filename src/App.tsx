import { useState, useRef } from 'react'
import { Video, Camera, Wallet, ShieldCheck, Play, Square, CheckCircle2, AlertCircle, Mic } from 'lucide-react'

const API = 'http://localhost:3001'

export default function App() {
  const [step, setStep] = useState<'consent' | 'pay' | 'app'>('consent')
  const [ownFace, setOwnFace] = useState(false)
  const [noImpersonation, setNoImpersonation] = useState(false)
  const [session, setSession] = useState<{ sessionId: string; wallet: string; amountEth: string } | null>(null)
  const [txHash, setTxHash] = useState('')
  const [msg, setMsg] = useState('')
  const [ok, setOk] = useState(false)
  const [verified, setVerified] = useState(false)
  const [live, setLive] = useState(false)
  const [status, setStatus] = useState('idle')
  const [voice, setVoice] = useState('none')
  const [semitones, setSemitones] = useState(0)

  const localRef = useRef<HTMLVideoElement>(null)
  const remoteRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const stateRef = useRef<{ rt?: any; stream?: MediaStream; audioCtx?: AudioContext; shifter?: any }>({})

  const consentReady = ownFace && noImpersonation

  async function startPay() {
    setOk(false)
    const r = await fetch(`${API}/api/pay-request`)
    const p = await r.json()
    setSession(p)
    setStep('pay')
    setMsg(`Send ${p.amountEth} ETH to ${p.wallet}, then paste the tx hash.`)
  }

  async function verify() {
    setOk(false)
    const r = await fetch(`${API}/api/pay-verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session!.sessionId, txHash: txHash.trim() }),
    })
    const j = await r.json()
    if (j.ok) {
      setVerified(true)
      setOk(true)
      setMsg(`Payment confirmed (${j.confirms} confirmations) — access until ${new Date(j.expires).toLocaleString()}.`)
    } else {
      setMsg(j.error === 'unconfirmed'
        ? `Tx found but only ${j.confirms} confirmation(s); need 3. Try again shortly.`
        : `Verify failed: ${j.error}`)
    }
  }

  // Pitch-only shift (tempo locked at 1.0) on the mic audio, client-side.
  async function pitchShiftStream(sourceStream: MediaStream, semis: number) {
    const audioCtx = new AudioContext()
    const src = audioCtx.createMediaStreamSource(sourceStream)
    const { PitchShifter } = await import('soundtouchjs')
    const shifter = new PitchShifter(audioCtx, src, 16384)
    shifter.tempo = 1
    shifter.pitch = Math.pow(2, semis / 12)
    const dest = audioCtx.createMediaStreamDestination()
    shifter.connect(dest)
    stateRef.current.audioCtx = audioCtx
    stateRef.current.shifter = shifter
    return dest.stream
  }

  async function start() {
    const file = imgRef.current?.files?.[0]
    if (!file) { setMsg('pick a photo first'); return }
    try {
      const headers: Record<string, string> = { 'x-session-id': session!.sessionId }
      const r = await fetch(`${API}/api/realtime-token`, { method: 'POST', headers })
      if (!r.ok) throw new Error('token request failed')
      const { apiKey } = await r.json()
      const mod: any = await import('@decartai/sdk')
      const { createDecartClient, models } = mod
      const client = createDecartClient({ apiKey })
      const model = models.realtime('lucy-2.6')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { frameRate: model.fps, width: model.width, height: model.height },
        audio: true,
      })
      stateRef.current.stream = stream
      if (localRef.current) localRef.current.srcObject = stream

      // Build outgoing stream: video as-is, audio through pitch shifter if set
      let sendStream = stream
      let semis = 0
      if (voice === 'up') semis = 4
      else if (voice === 'down') semis = -4
      else if (voice === 'deep') semis = -8
      else if (voice === 'high') semis = 8
      else if (voice === 'custom') semis = semitones
      if (semis !== 0) {
        const shifted = await pitchShiftStream(stream, semis)
        sendStream = new MediaStream([...stream.getVideoTracks(), ...shifted.getAudioTracks()])
      }

      const rt = await client.realtime.connect(sendStream, {
        model,
        mirror: 'auto',
        onRemoteStream: (s: MediaStream) => { if (remoteRef.current) remoteRef.current.srcObject = s },
      })
      stateRef.current.rt = rt
      rt.on('connectionChange', (s: string) => setStatus(s))
      rt.on('error', (e: Error) => setStatus('error: ' + e.message))
      await rt.set({ prompt: 'Substitute the character in the video with the person in the reference image.', enhance: true, image: file })
      setLive(true)
    } catch (e: any) {
      setStatus('error: ' + e.message)
    }
  }

  async function stop() {
    try { stateRef.current.rt?.disconnect() } catch { /* ignore */ }
    stateRef.current.stream?.getTracks().forEach((t) => t.stop())
    try { stateRef.current.shifter?.disconnect() } catch { /* ignore */ }
    try { await stateRef.current.audioCtx?.close() } catch { /* ignore */ }
    if (localRef.current) localRef.current.srcObject = null
    if (remoteRef.current) remoteRef.current.srcObject = null
    stateRef.current = {}
    setLive(false)
    setStatus('stopped')
  }

  const card = 'rounded-2xl border border-[#2F2F2F] bg-[#262626] p-6'
  const btn = 'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition disabled:opacity-40'

  return (
    <div className="min-h-screen bg-[#171717] font-sans text-white antialiased">
      <div className="pointer-events-none fixed inset-0" aria-hidden="true">
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-[#9E7FFF]/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-[#38bdf8]/15 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-3xl px-6 py-16">
        <header className="mb-10 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#9E7FFF] to-[#38bdf8] shadow-lg shadow-[#9E7FFF]/30">
            <Video className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Deepfake Live Cam</h1>
            <p className="text-sm text-[#A3A3A3]">Consent first, crypto payments, verified on-chain.</p>
          </div>
        </header>

        {msg && (
          <div className={`mb-6 flex items-start gap-2 rounded-xl border p-4 text-sm ${ok ? 'border-[#10b981]/40 bg-[#10b981]/10 text-[#10b981]' : 'border-[#2F2F2F] bg-[#262626] text-[#A3A3A3]'}`}>
            {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {msg}
          </div>
        )}

        {/* Step 1: consent */}
        {step === 'consent' && (
          <section className={card}>
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[#9E7FFF]" />
              <h2 className="text-lg font-semibold">Consent — required before every session</h2>
            </div>
            <label className="mb-3 flex cursor-pointer items-start gap-3 text-sm text-[#A3A3A3]">
              <input type="checkbox" checked={ownFace} onChange={(e) => setOwnFace(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#9E7FFF]" />
              The face I upload is mine, or the person in it agreed to be used.
            </label>
            <label className="mb-6 flex cursor-pointer items-start gap-3 text-sm text-[#A3A3A3]">
              <input type="checkbox" checked={noImpersonation} onChange={(e) => setNoImpersonation(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#9E7FFF]" />
              I won't impersonate anyone or pass the swapped video off as a real person to deceive others.
            </label>
            <button onClick={startPay} disabled={!consentReady} className={`${btn} bg-gradient-to-r from-[#9E7FFF] to-[#38bdf8] text-white shadow-lg shadow-[#9E7FFF]/30 disabled:cursor-not-allowed`}>
              <Wallet className="h-4 w-4" /> Continue to payment
            </button>
          </section>
        )}

        {/* Step 2: pay */}
        {step === 'pay' && session && (
          <section className={card}>
            <div className="mb-4 flex items-center gap-2">
              <Wallet className="h-5 w-5 text-[#9E7FFF]" />
              <h2 className="text-lg font-semibold">Pay $1.00 in ETH</h2>
            </div>
            <p className="break-all rounded-xl border border-[#2F2F2F] bg-[#171717] p-4 font-mono text-sm text-[#38bdf8]">{session.wallet}</p>
            <p className="mt-2 text-sm text-[#A3A3A3]">Amount: <span className="font-mono text-white">{session.amountEth} ETH</span></p>
            <input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x… transaction hash"
              className="mt-4 w-full rounded-full border border-[#2F2F2F] bg-[#171717] px-5 py-3 font-mono text-sm outline-none transition placeholder-[#6b6b6b] focus:border-[#9E7FFF] focus:ring-2 focus:ring-[#9E7FFF]/30"
            />
            <button onClick={verify} disabled={!txHash.trim()} className={`${btn} mt-4 bg-white text-[#171717] hover:bg-[#9E7FFF] hover:text-white disabled:cursor-not-allowed`}>
              Verify payment
            </button>
          </section>
        )}

        {/* Step 3: the cam */}
        {step === 'app' && (
          <section className={card}>
            <div className="mb-4 flex items-center gap-2">
              <Camera className="h-5 w-5 text-[#9E7FFF]" />
              <h2 className="text-lg font-semibold">Live session</h2>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Mic className="h-4 w-4 text-[#9E7FFF]" />
              <label htmlFor="voice" className="text-sm text-[#A3A3A3]">Voice:</label>
              <select
                id="voice"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                disabled={live}
                className="rounded-full border border-[#2F2F2F] bg-[#171717] px-4 py-2 text-sm text-white outline-none transition focus:border-[#9E7FFF]"
              >
                <option value="none">no change</option>
                <option value="up">pitch up (+4)</option>
                <option value="down">pitch down (−4)</option>
                <option value="deep">deep (−8)</option>
                <option value="high">high (+8)</option>
                <option value="custom">custom…</option>
              </select>
              {voice === 'custom' && (
                <span className="flex items-center gap-2 text-sm text-[#A3A3A3]">
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    value={semitones}
                    onChange={(e) => setSemitones(parseInt(e.target.value, 10))}
                    className="w-32 accent-[#9E7FFF]"
                    aria-label="Custom semitones"
                  />
                  {semitones > 0 ? '+' : ''}{semitones} semitones
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <video ref={localRef} autoPlay playsInline muted className="w-full rounded-xl bg-black" />
              <video ref={remoteRef} autoPlay playsInline muted className="w-full rounded-xl bg-black" />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {!live ? (
                <button onClick={start} className={`${btn} bg-gradient-to-r from-[#9E7FFF] to-[#38bdf8] text-white shadow-lg shadow-[#9E7FFF]/30`}>
                  <Play className="h-4 w-4" /> Start
                </button>
              ) : (
                <button onClick={stop} className={`${btn} bg-white text-[#171717] hover:bg-[#ef4444] hover:text-white`}>
                  <Square className="h-4 w-4" /> Stop
                </button>
              )}
              <span className="text-sm text-[#A3A3A3]">Status: <span className="text-white">{status}</span></span>
            </div>
          </section>
        )}

        {verified && step === 'pay' && (
          <button onClick={() => setStep('app')} className={`${btn} mt-6 w-full bg-gradient-to-r from-[#9E7FFF] to-[#38bdf8] text-white shadow-lg shadow-[#9E7FFF]/30`}>
            Enter the studio
          </button>
        )}
      </div>
    </div>
  )
}
