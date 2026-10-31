// Audio Notification Helper using Web Audio API

export function playUploadSuccessSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Harmonious modern ascending notification chime
    // C5 (523.25Hz) -> E5 (659.25Hz) -> G5 (783.99Hz) -> C6 (1046.5Hz)
    const chords = [
      { freq: 523.25, time: 0.0, dur: 0.12, vol: 0.22 },
      { freq: 659.25, time: 0.08, dur: 0.14, vol: 0.24 },
      { freq: 783.99, time: 0.16, dur: 0.16, vol: 0.26 },
      { freq: 1046.5, time: 0.24, dur: 0.45, vol: 0.3 },
    ];

    chords.forEach(({ freq, time, dur, vol }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + time);

      // Smooth attack and soft exponential release
      gain.gain.setValueAtTime(0.0001, now + time);
      gain.gain.exponentialRampToValueAtTime(vol, now + time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + time + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + time);
      osc.stop(now + time + dur);
    });

    // Auto-close context after chime ends to release audio hardware
    setTimeout(() => {
      try {
        ctx.close();
      } catch {}
    }, 1200);
  } catch (err) {
    console.warn('Audio notification notice:', err);
  }
}
