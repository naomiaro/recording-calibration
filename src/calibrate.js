/**
 * Latency calibration with a unique sound (log-chirp by default).
 * - Generates a reference signal
 * - Plays it via WebAudio while recording mic input
 * - Estimates lag with normalized cross-correlation (non-negative lags)
 *
 * Usage:
 *   const ctx = new AudioContext({ sampleRate: 48000 });
 *   const res = await calibrateLatency(ctx, { mode: 'chirp' }); // or 'mls'
 *   console.log(res); // { lagSamples, lagMs, score }
 */

export async function calibrateLatency(audioCtx, opts = {}) {
    const {
        mode = 'chirp',           // 'chirp' | 'mls'
        sampleRate = audioCtx.sampleRate || 48000,
        // Chirp params
        chirp = { durationMs: 120, f0: 1500, f1: 8000, amp: 0.8, fadeMs: 6 },
        // MLS params
        mls = { order: 16, repeats: 4, amp: 0.35 },
        // Recording window padding
        preRollMs = 40,
        postRollMs = 180,
        // Correlation search window (must cover expected round trip)
        maxLagMs = 120,
        allowNegative = false,     // keep false to lock sign
        // Optional light high-pass to improve robustness
        filterHpHz = 150,
    } = opts;

    // 1) Build reference buffer
    const ref = mode === 'mls'
        ? makeMLSSequence(sampleRate, mls.order, mls.repeats, mls.amp)
        : makeLogChirp(sampleRate, chirp.durationMs, chirp.f0, chirp.f1, chirp.amp, chirp.fadeMs);

    // 2) Play & record
    const { mic, refPlayed } = await playAndRecordCalibration(audioCtx, ref, {
        sampleRate, preRollMs, postRollMs
    });

    // Optional light high-pass to reduce LF rumble/room noise
    const micForCorr = filterHpHz ? highPassIIR(mic, sampleRate, filterHpHz) : mic;
    const refForCorr = filterHpHz ? highPassIIR(refPlayed, sampleRate, filterHpHz) : refPlayed;

    // 3) Estimate lag (mic relative to ref)
    const res = estimateLagNormalized(micForCorr, refForCorr, sampleRate, { maxLagMs, allowNegative });

    // Debug output
    console.log(`Calibration debug: mic length=${mic.length}, ref length=${refPlayed.length}`);
    const micMin = Math.min(...mic);
    const micMax = Math.max(...mic);
    const micRms = Math.sqrt(mic.reduce((a, b) => a + b * b, 0) / mic.length);
    console.log(`Mic signal stats: min=${micMin.toFixed(3)}, max=${micMax.toFixed(3)}, rms=${micRms.toFixed(3)}`);
    console.log(`Ref signal stats: min=${Math.min(...refPlayed).toFixed(3)}, max=${Math.max(...refPlayed).toFixed(3)}, rms=${Math.sqrt(refPlayed.reduce((a, b) => a + b * b, 0) / refPlayed.length).toFixed(3)}`);

    // Validate calibration quality
    if (res.score < 0.1) {
        console.warn(`Low correlation score (${res.score.toFixed(3)}). This may indicate poor signal quality or timing issues.`);
    }
    if (res.lagMs > 100) {
        console.warn(`Unusually high latency detected (${res.lagMs.toFixed(1)}ms). This may indicate system issues.`);
    }

    return { ...res, micRms, micClipped: (micMin <= -0.98 || micMax >= 0.98) };
}

/**
 * Robust wrapper: run multiple calibrations and take the median of valid results.
 */
export async function calibrateLatencyRobust(audioCtx, opts = {}) {
    const {
        attempts = 6,
        minScore = 0.2,
        // pass-through options for calibrateLatency
        mode,
        sampleRate,
        chirp,
        mls,
        preRollMs,
        postRollMs,
        maxLagMs,
        allowNegative,
        // adaptive amplitude behavior
        adaptAmp = true,
    } = opts;

    const results = [];
    const valid = [];
    let currentAmp = chirp?.amp ?? 0.6;

    for (let i = 0; i < attempts; i++) {
        const res = await calibrateLatency(audioCtx, { mode, sampleRate, chirp: { ...chirp, amp: currentAmp }, mls, preRollMs, postRollMs, maxLagMs, allowNegative });
        results.push(res);
        if (res && typeof res.score === 'number' && res.score >= minScore) {
            valid.push(res);
        }
        if (adaptAmp) {
            if (res.micClipped) {
                currentAmp = Math.max(0.2, currentAmp * 0.6);
            } else if ((res.micRms ?? 0) < 0.03) {
                currentAmp = Math.min(0.95, currentAmp * 1.4);
            }
        }
    }

    const pickMedianByLag = (arr) => {
        const sorted = [...arr].sort((a, b) => a.lagSamples - b.lagSamples);
        return sorted[Math.floor(sorted.length / 2)];
    };

    if (valid.length >= 3) {
        return pickMedianByLag(valid);
    }
    if (valid.length > 0) {
        return pickMedianByLag(valid);
    }
    // fallback: return best score among all attempts
    const best = results.reduce((bestSoFar, cur) => (!bestSoFar || (cur.score ?? -Infinity) > bestSoFar.score ? cur : bestSoFar), null);
    return best || { lagSamples: 0, lagMs: 0, score: 0 };
}

// Simple first-order high-pass IIR filter to remove LF energy
function highPassIIR(x, sr, cutoffHz = 150) {
    const y = new Float32Array(x.length);
    const dt = 1 / sr;
    const RC = 1 / (2 * Math.PI * cutoffHz);
    const alpha = RC / (RC + dt);
    let prevY = 0, prevX = 0;
    for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        const yi = alpha * (prevY + xi - prevX);
        y[i] = yi;
        prevY = yi;
        prevX = xi;
    }
    return y;
}

/* ------------------------- Signal generation ------------------------- */

/** Logarithmic chirp with short fade in/out to avoid clicks. */
export function makeLogChirp(sr, durationMs = 120, f0 = 1500, f1 = 8000, amp = 0.5, fadeMs = 6) {
    const N = Math.max(8, Math.round((durationMs / 1000) * sr));
    const y = new Float32Array(N);
    const w0 = 2 * Math.PI * f0;
    const w1 = 2 * Math.PI * f1;
    const K = N / Math.log(w1 / w0); // for log sweep phase
    for (let n = 0; n < N; n++) {
        const t = n / sr;
        // log sweep phase ~ w0 * K * (exp(n/K) - 1) scaled into discrete form
        const ratio = n / (N - 1);
        const w = w0 * Math.pow(w1 / w0, ratio); // instantaneous angular freq
        // integrate instantaneous freq approximately (OK for short sweeps)
        // simpler: phase via cumulative sum approximation
        // For stability, approximate phase with geometric interpolation:
        // phase ≈ 2π * f0 * t * ((f1/f0)^(t/T)) / ln(f1/f0) — but we can get
        // very good results using instantaneous cosine with slow-varying phase:
        y[n] = Math.cos(2 * Math.PI * (f0 * t + (f1 - f0) * t * ratio)) * amp;
    }
    applyFades(y, sr, fadeMs);
    return y;
}

/** Maximal length sequence (MLS) generator (simple LFSR), repeated. */
export function makeMLSSequence(sr, order = 16, repeats = 4, amp = 0.35) {
    if (order < 2 || order > 20) throw new Error('MLS order 2..20 supported');
    const len = (1 << order) - 1;

    // Tap sets for some orders (primitive polynomials).
    // This list covers common orders; adjust if you use others.
    // Format: feedback taps (excluding the bit 0 tap which is implicit)
    const tapsByOrder = {
        10: [3], 11: [2], 12: [6, 4, 1], 13: [4, 3, 1], 14: [5, 3, 1],
        15: [14], 16: [15, 13, 4], 17: [14], 18: [11], 19: [6, 5, 1], 20: [17],
    };
    const taps = tapsByOrder[order] || [order - 1];
    let reg = 1; // non-zero init
    const one = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        const bit = reg & 1;
        one[i] = bit ? 1 : -1; // bipolar
        let fb = bit;
        for (const t of taps) fb ^= (reg >> t) & 1;
        reg = (reg >> 1) | (fb << (order - 1));
    }
    // Repeat the MLS block a few times to get a clear peak
    const y = new Float32Array(len * repeats);
    for (let r = 0; r < repeats; r++) y.set(one, r * len);
    // Amplitude
    for (let i = 0; i < y.length; i++) y[i] *= amp;
    return y;
}

/* ------------------------- Playback & recording ------------------------- */

async function playAndRecordCalibration(audioCtx, ref, { sampleRate, preRollMs, postRollMs }) {
    // Mic - ensure clean signal path for calibration
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: sampleRate,
            channelCount: 1
        }
    });
    const src = audioCtx.createMediaStreamSource(stream);

    // Recorder: ScriptProcessor is deprecated; use AudioWorklet if you already have one.
    // For a compact example, use MediaRecorder for raw chunks, then decode to PCM via OfflineAudioContext.
    // Here's a simple WebAudio capture into a ring buffer using an AudioWorklet if available:
    await ensureCaptureWorklet(audioCtx);
    const node = new AudioWorkletNode(audioCtx, 'capture-writer');
    src.connect(node); // Don't connect to destination to avoid feedback

    // Prepare reference buffer for playback
    const refBuf = audioCtx.createBuffer(1, ref.length, sampleRate);
    refBuf.getChannelData(0).set(ref);

    // Pre/post roll total record length
    const totalMs = preRollMs + (ref.length / sampleRate) * 1000 + postRollMs;
    const totalSamples = Math.ceil((totalMs / 1000) * sampleRate);

    // Ensure audio context is running
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    // Start recording immediately
    node.port.postMessage({ type: 'start', samples: totalSamples });

    // Pre-roll delay
    await sleep(preRollMs);

    // Play reference with precise timing
    const p = audioCtx.createBufferSource();
    p.buffer = refBuf;
    p.connect(audioCtx.destination);

    // Use precise timing to start playback
    const startTime = audioCtx.currentTime;
    p.start(startTime);

    // Wait until recording done
    const mic = await new Promise((resolve) => {
        node.port.onmessage = (e) => {
            if (e.data?.type === 'done') resolve(e.data.samples);
        };
    });

    // Slice out the exact ref we played (identical copy) for correlation
    const refPlayed = ref; // already the exact signal used

    // Cleanup
    node.disconnect();
    src.disconnect();

    return { mic: Float32Array.from(mic), refPlayed: Float32Array.from(refPlayed) };
}

// Tiny capture worklet that writes a fixed number of samples
let captureWorkletRegistered = false;

async function ensureCaptureWorklet(ctx) {
    if (captureWorkletRegistered) return;

    const code = `
      class CaptureWriter extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buf = null;
          this.writeIdx = 0;
          this.target = 0;
          this.recording = false;
          this.port.onmessage = (e) => {
            if (e.data?.type === 'start') {
              this.target = e.data.samples|0;
              this.buf = new Float32Array(this.target);
              this.writeIdx = 0;
              this.recording = true;
            }
          };
        }
        process(inputs) {
          if (!this.recording) return true;
          const ch0 = inputs[0]?.[0];
          if (ch0) {
            const need = Math.min(ch0.length, this.target - this.writeIdx);
            this.buf.set(ch0.subarray(0, need), this.writeIdx);
            this.writeIdx += need;
            if (this.writeIdx >= this.target) {
              this.recording = false;
              this.port.postMessage({ type: 'done', samples: this.buf }, [this.buf.buffer]);
            }
          }
          return true;
        }
      }
      registerProcessor('capture-writer', CaptureWriter);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    captureWorkletRegistered = true;
}

/* ------------------------- Correlation (normalized, one-sided) ------------------------- */

export function estimateLagNormalized(mic, ref, sampleRate, opts = {}) {
    const { maxLagMs = 120, allowNegative = false } = opts;

    const x = toF32(mic);
    const y = toF32(ref);
    zeroMean(x);
    zeroMean(y);

    if (x.length < 8 || y.length < 8) return { lagSamples: 0, lagMs: 0, score: 0 };

    const maxLag = Math.min(
        Math.floor((maxLagMs / 1000) * sampleRate),
        Math.floor(Math.max(x.length, y.length) / 2)
    );

    let bestLag = 0, bestScore = -Infinity;

    const evalLag = (lag) => {
        const yStart = Math.max(0, -lag);
        const yEnd = Math.min(y.length, x.length - lag);
        if (yEnd - yStart < 16) return -Infinity;

        let dot = 0, xx = 0, yy = 0;
        for (let i = yStart; i < yEnd; i++) {
            const a = y[i], b = x[i + lag];
            dot += a * b; xx += b * b; yy += a * a;
        }
        if (xx <= 1e-12 || yy <= 1e-12) return -Infinity;
        return dot / Math.sqrt(xx * yy);
    };

    if (allowNegative) {
        for (let lag = -maxLag; lag <= maxLag; lag++) {
            const s = evalLag(lag);
            if (s > bestScore) { bestScore = s; bestLag = lag; }
        }
    } else {
        for (let lag = 0; lag <= maxLag; lag++) {
            const s = evalLag(lag);
            if (s > bestScore) { bestScore = s; bestLag = lag; }
        }
    }
    return { lagSamples: bestLag, lagMs: (bestLag / sampleRate) * 1000, score: bestScore };
}

/* ------------------------- Utilities ------------------------- */

function applyFades(y, sr, fadeMs = 6) {
    const fadeN = Math.max(1, Math.round((fadeMs / 1000) * sr));
    for (let i = 0; i < fadeN; i++) {
        const g = i / fadeN;
        y[i] *= g;
        y[y.length - 1 - i] *= g;
    }
}

function toF32(a) { return a instanceof Float32Array ? a.slice() : Float32Array.from(a); }
function zeroMean(a) {
    let m = 0; for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    for (let i = 0; i < a.length; i++) a[i] -= m;
    return a;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }