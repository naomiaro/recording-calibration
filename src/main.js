import { calibrateLatency, scheduleTake } from "./recorder-utils.js";

const $ = (id) => document.getElementById(id);

const btnInit = $("init");
const btnCalibrate = $("calibrate");
const btnTake = $("take");
const $lat = $("latency");
const $clickStart = $("clickStart");
const $recordStart = $("recordStart");
const $chunks = $("chunks");

let ctx;
let recNode;
let micNode;
let refGain;      // reference path into worklet (not audible)
let latencySeconds = 0;
let chunkCount = 0;
let clickBuffer;

// Simple click buffer generator: 1 bar (4 beats) at given BPM
function makeClickBuffer(sampleRate, bpm = 120, beats = 4) {
    const secondsPerBeat = 60 / bpm;
    const totalDur = secondsPerBeat * beats;
    const frames = Math.floor(totalDur * sampleRate);
    const buf = new AudioBuffer({ length: frames, sampleRate, numberOfChannels: 1 });
    const ch0 = buf.getChannelData(0);

    // short “tick” at each beat: 2ms burst at start of each beat
    const burstLen = Math.max(1, Math.floor(0.002 * sampleRate));
    for (let b = 0; b < beats; b++) {
        const start = Math.floor(b * secondsPerBeat * sampleRate);
        for (let i = 0; i < burstLen && start + i < ch0.length; i++) {
            // simple high click
            ch0[start + i] = 1.0;
        }
    }
    return buf;
}

// A very short pulse for calibration (10ms with one big spike)
function makePulseBuffer(sampleRate) {
    const dur = 0.01;
    const len = Math.floor(sampleRate * dur);
    const buf = new AudioBuffer({ length: len, sampleRate, numberOfChannels: 1 });
    const d = buf.getChannelData(0);
    d[0] = 1.0;
    return buf;
}

btnInit.onclick = async () => {
    try {
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule(new URL("./recorder-processor.js", import.meta.url));

        // Prepare node with 2 inputs (mic, reference)
        recNode = new AudioWorkletNode(ctx, "recorder-processor", {
            numberOfInputs: 2,  // IMPORTANT: we want mic on input 0, ref on input 1
            numberOfOutputs: 0, // recording-only node (no audio output)
            channelCountMode: "explicit",
            channelInterpretation: "speakers"
        });

        recNode.port.onmessage = (e) => {
            if (e.data.type === "chunk") {
                chunkCount++;
                $chunks.textContent = String(chunkCount);
                // In a real app: buffer/encode e.data.mic (and optionally use e.data.ref)
            }
        };

        // Mic
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micNode = ctx.createMediaStreamSource(stream);
        micNode.connect(recNode, 0, 0); // mic → input 0

        // Reference path (silent to speakers; only feeds the worklet)
        refGain = ctx.createGain();
        refGain.gain.value = 1.0; // full into worklet input (not the destination)
        refGain.connect(recNode, 0, 1); // ref → input 1

        // Prepare click buffer now that sampleRate is known
        clickBuffer = makeClickBuffer(ctx.sampleRate, 120, 4);

        btnCalibrate.disabled = false;
        btnTake.disabled = true;
        btnInit.disabled = true;
    } catch (err) {
        console.error(err);
        alert("Init failed. Check console.");
    }
};

btnCalibrate.onclick = async () => {
    try {
        // Reset counters
        chunkCount = 0;
        $chunks.textContent = "0";

        latencySeconds = await calibrateLatency(ctx, recNode, refGain, makePulseBuffer);
        $lat.textContent = `${(latencySeconds * 1000).toFixed(1)} ms`;
        btnTake.disabled = false;
    } catch (err) {
        console.error(err);
        alert("Calibration failed. Check console.");
    }
};

btnTake.onclick = () => {
    try {
        chunkCount = 0;
        $chunks.textContent = "0";

        const { clickStart, recordStart } = scheduleTake(
            ctx,
            recNode,
            clickBuffer,
            latencySeconds,
            120, // bpm
            4    // beats per bar
        );
        $clickStart.textContent = `${clickStart.toFixed(3)} s`;
        $recordStart.textContent = `${recordStart.toFixed(3)} s`;
    } catch (err) {
        console.error(err);
        alert("Take scheduling failed. Check console.");
    }
};