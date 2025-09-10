/* AudioWorkletProcessor: sample-accurate startAt gating, posts mic + reference chunks */

class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.startAt = null; // absolute context time (seconds)
        this.started = false;

        this.port.onmessage = (e) => {
            const { type, time } = e.data || {};
            if (type === "startAt") this.startAt = time;
        };
    }

    process(inputs /* [in0, in1] */) {
        const micIn = inputs[0];   // mic channels
        const refIn = inputs[1];   // reference click channels
        if (!micIn || micIn.length === 0) return true;

        const blockSize = micIn[0].length;      // usually 128
        const t0 = currentTime;                 // start time of this block
        const t1 = t0 + blockSize / sampleRate; // end time

        let startFrameInBlock = 0;
        if (!this.started) {
            if (this.startAt == null || this.startAt >= t1) return true;
            if (this.startAt > t0) {
                startFrameInBlock = Math.floor((this.startAt - t0) * sampleRate);
            }
            this.started = true;
        }

        const framesToCopy = blockSize - startFrameInBlock;
        if (framesToCopy > 0) {
            const copyChannels = (srcArray) => {
                if (!srcArray || srcArray.length === 0) return null;
                const out = new Array(srcArray.length);
                for (let ch = 0; ch < srcArray.length; ch++) {
                    const view = srcArray[ch].subarray(startFrameInBlock);
                    const copy = new Float32Array(view.length);
                    copy.set(view);
                    out[ch] = copy;
                }
                return out;
            };

            const micChunk = copyChannels(micIn);
            const refChunk = copyChannels(refIn);
            this.port.postMessage({ type: "chunk", mic: micChunk, ref: refChunk });
        }

        return true;
    }
}

registerProcessor("recorder-processor", RecorderProcessor);