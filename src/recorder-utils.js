// Concatenate Float32Array chunks
export function concatFloat32(chunks) {
    const total = chunks.reduce((s, a) => s + (a?.length || 0), 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const a of chunks) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

/**
 * Estimate mic->ref latency using normalized cross-correlation.
 * By default only searches NON-NEGATIVE lags, so the sign can't flip.
 *
 * @param {Float32Array|number[]} mic   Recorded mic slice
 * @param {Float32Array|number[]} ref   Reference slice (what was played)
 * @param {number} sampleRate           e.g., 48000
 * @param {object} [opts]
 * @param {number} [opts.maxLagMs=120]  Limit search to plausible I/O round-trip (ms)
 * @param {boolean} [opts.allowNegative=false]  If true, search ±maxLag
 * @returns {{lagSamples:number, lagMs:number, score:number}}
 */
export function estimateLagNormalized(mic, ref, sampleRate, opts = {}) {
    const { maxLagMs = 120, allowNegative = false } = opts;

    // Copy into Float32Arrays and remove DC offset
    const x = toF32(mic);
    const y = toF32(ref);
    zeroMean(x);
    zeroMean(y);

    // Early outs
    if (x.length < 8 || y.length < 8) return { lagSamples: 0, lagMs: 0, score: 0 };

    const maxLag = Math.min(
        Math.floor((maxLagMs / 1000) * sampleRate),
        Math.floor(Math.max(x.length, y.length) / 2)
    );

    let bestLag = 0;
    let bestScore = -Infinity;

    // Helper to compute normalized correlation for a given lag
    // Correlate y (ref) with shifted x (mic): ref[i] * mic[i + lag]
    const evalLag = (lag) => {
        // Overlap region indices in ref (0..yLen-1) that also exist in x shifted by lag
        const yStart = Math.max(0, -lag);
        const yEnd = Math.min(y.length, x.length - lag); // exclusive
        if (yEnd - yStart < 8) return -Infinity; // too little overlap, ignore

        // Compute dot and per-lag energy normalization over overlap
        let dot = 0, xx = 0, yy = 0;
        for (let i = yStart; i < yEnd; i++) {
            const a = y[i];
            const b = x[i + lag];
            dot += a * b;
            xx += b * b;
            yy += a * a;
        }
        if (xx <= 1e-12 || yy <= 1e-12) return -Infinity;
        return dot / Math.sqrt(xx * yy); // in [-1, 1]
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

/** Median of multiple runs to stabilize noisy measurements. */
export function medianLagSamples(results /* Array<{lagSamples:number}> */) {
    const arr = results.map(r => r.lagSamples).sort((a, b) => a - b);
    const n = arr.length;
    if (n === 0) return 0;
    return n % 2 ? arr[(n - 1) >> 1] : 0.5 * (arr[n / 2 - 1] + arr[n / 2]);
}

/** Utilities */
function toF32(a) {
    return a instanceof Float32Array ? a.slice() : Float32Array.from(a);
}
function zeroMean(a) {
    let m = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    for (let i = 0; i < a.length; i++) a[i] -= m;
    return a;
}

// Brute-force lag estimation (cross-correlation)
export function estimateLagByCrossCorrelation(mic, ref, sampleRate) {
    // cap search ±1s
    const maxLag = Math.min(sampleRate, Math.floor(ref.length / 2));
    let bestLag = 0, bestScore = -Infinity;

    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let score = 0;
        for (let i = 0; i < ref.length; i++) {
            const j = i + lag;
            if (j >= 0 && j < mic.length) score += ref[i] * mic[j];
        }
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }
    return bestLag; // + = mic lags ref
}

// 🔧 Calibrate latency once
export async function calibrateLatency(ctx, recNode, refGain, makePulseBuffer) {
    return new Promise((resolve) => {
        const pulse = ctx.createBufferSource();
        pulse.buffer = makePulseBuffer(ctx.sampleRate);

        const collectedMic = [];
        const collectedRef = [];

        const handler = (e) => {
            if (e.data.type === "chunk") {
                if (e.data.mic && e.data.mic[0]) collectedMic.push(e.data.mic[0]);
                if (e.data.ref && e.data.ref[0]) collectedRef.push(e.data.ref[0]);
            }
        };
        recNode.port.addEventListener("message", handler);

        const start = ctx.currentTime;
        const end = start + 0.5;
        recNode.port.postMessage({ type: "setWindow", start, end });

        // Play pulse in 100ms
        const t0 = ctx.currentTime + 0.1;
        pulse.connect(ctx.destination);
        pulse.connect(refGain);
        pulse.start(t0);

        setTimeout(() => {
            recNode.port.removeEventListener("message", handler);
            const mic = concatFloat32(collectedMic);
            const ref = concatFloat32(collectedRef);
            if (mic.length === 0 || ref.length === 0) {
                console.error("No data collected");
                resolve(0);
                return;
            }
            const lagSamples = estimateLagByCrossCorrelation(mic, ref, ctx.sampleRate);
            console.log("Lag samples:", lagSamples);
            const lagSeconds = lagSamples / ctx.sampleRate;
            console.log("Lag seconds:", lagSeconds);

            // Example: take 4 quick measurements and median them
            const runs = [];
            for (let k = 0; k < 4; k++) {
                // micSlice/refSlice should be aligned around your calibration sound
                const res = estimateLagNormalized(mic, ref, ctx.sampleRate, {
                    maxLagMs: 120,
                    allowNegative: false, // <-- keeps sign consistent
                });
                console.log(`Lag: ${res.lagSamples} samples (${res.lagMs.toFixed(2)} ms), score=${res.score.toFixed(3)}`);
                runs.push(res);
            }
            const lag = medianLagSamples(runs);
            console.log('Final (median) lag samples:', lag);


            resolve(Math.max(0, lagSeconds));
        }, 600);
    });
}

// 🎶 Schedule click + recording on downbeat
export function scheduleTake(ctx, recNode, clickBuffer, latencySeconds, bpm, beatsPerBar) {
    const barDur = (60 / bpm) * beatsPerBar;
    const lookahead = 0.2;
    const clickStart = ctx.currentTime + lookahead;

    const click = ctx.createBufferSource();
    click.buffer = clickBuffer;
    click.connect(ctx.destination);
    click.start(clickStart);
    click.stop(clickStart + barDur);

    const safety = 0.003; // 3ms margin
    const startAt = clickStart + barDur + latencySeconds + safety;
    recNode.port.postMessage({ type: "startAt", time: startAt });

    return { clickStart, recordStart: startAt };
}