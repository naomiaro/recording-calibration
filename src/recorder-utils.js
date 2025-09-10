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

        // Start recording immediately for calibration
        recNode.port.postMessage({ type: "startAt", time: ctx.currentTime });

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
                resolve(0);
                return;
            }
            const lagSamples = estimateLagByCrossCorrelation(mic, ref, ctx.sampleRate);
            const lagSeconds = lagSamples / ctx.sampleRate;
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