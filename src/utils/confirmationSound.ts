// Confirmation Sound Utility using Web Audio API
// Produces a short, unobtrusive, pleasant confirmation chime upon video upload completion

let audioCtxInstance: AudioContext | null = null;
let lastPlayedTimestamp = 0;

function getAudioContext(): AudioContext | null {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtxInstance || audioCtxInstance.state === 'closed') {
      audioCtxInstance = new AudioContextClass();
    }
    return audioCtxInstance;
  } catch {
    return null;
  }
}

/**
 * Plays a short, unobtrusive confirmation chime.
 * Ensures it strictly plays only once per completion event and doesn't interfere
 * with active playback or UI animations.
 */
export function playUploadConfirmationSound(): void {
  try {
    const nowMs = Date.now();
    // Throttle guard: prevent multiple triggers within 2 seconds
    if (nowMs - lastPlayedTimestamp < 2000) {
      return;
    }
    lastPlayedTimestamp = nowMs;

    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const startTime = ctx.currentTime;

    // Harmonic two-tone confirmation chime:
    // Tone 1: F5 (698.46 Hz) -> Tone 2: A5 (880.00 Hz)
    // Low gain, gentle sine wave, fast exponential decay for minimal unobtrusiveness
    const tones = [
      { freq: 698.46, time: 0.0, duration: 0.14, gain: 0.15 },
      { freq: 880.00, time: 0.08, duration: 0.28, gain: 0.18 },
    ];

    tones.forEach(({ freq, time, duration, gain }) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime + time);

      // Smooth attack & soft exponential decay
      gainNode.gain.setValueAtTime(0.001, startTime + time);
      gainNode.gain.exponentialRampToValueAtTime(gain, startTime + time + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + time + duration);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(startTime + time);
      osc.stop(startTime + time + duration);
    });
  } catch (err) {
    // Fail silently without affecting UI flow
    console.warn('[Confirmation Sound Notice]:', err);
  }
}
