class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.startAt = null;     // seconds
        this.endAt = null;       // seconds (optional)
        this.recording = false;

        this.port.onmessage = (e) => {
            const { type, time, start, end } = e.data || {};
            if (type === "startAt") {
                this.startAt = time; this.endAt = null; this.recording = false;
            } else if (type === "setWindow") { // schedule a finite window
                this.startAt = start; this.endAt = end; this.recording = false;
            } else if (type === "stop") {
                this.recording = false; this.startAt = null; this.endAt = null;
            }
        };
    }

    process(inputs) {
        const micIn = inputs[0];
        const refIn = inputs[1];
        if (!micIn || micIn.length === 0) return true;

        const blockSize = micIn[0].length;
        const t0 = currentTime;
        const t1 = t0 + blockSize / sampleRate;

        // Not recording yet? Check if we should start inside this block.
        let startFrameInBlock = 0;
        if (!this.recording) {
            if (this.startAt == null || this.startAt >= t1) return true; // not time yet
            // start this block
            startFrameInBlock = Math.max(0, Math.floor((this.startAt - t0) * sampleRate));
            this.recording = true;
        }

        // If we have an endAt, truncate within this block (and stop thereafter)
        let endFrameInBlock = blockSize;
        if (this.endAt != null) {
            if (this.endAt <= t0) { this.recording = false; return true; }
            if (this.endAt < t1) {
                endFrameInBlock = Math.max(0, Math.floor((this.endAt - t0) * sampleRate));
                // After sending this truncated chunk, we’ll stop
                var willStopAfterThisBlock = true;
            }
        }

        const framesToCopy = Math.max(0, endFrameInBlock - startFrameInBlock);
        if (framesToCopy > 0) {
            const copyChannels = (srcArray) => {
                if (!srcArray || srcArray.length === 0) return null;
                const out = new Array(srcArray.length);
                for (let ch = 0; ch < srcArray.length; ch++) {
                    const src = srcArray[ch];
                    const view = src.subarray(startFrameInBlock, endFrameInBlock);
                    const copy = new Float32Array(view.length);
                    copy.set(view);
                    out[ch] = copy;
                }
                return out;
            };
            this.port.postMessage({
                type: "chunk",
                mic: copyChannels(micIn),
                ref: copyChannels(refIn),
            });
        }

        if (willStopAfterThisBlock) {
            this.recording = false; this.startAt = null; this.endAt = null;
        }
        return true;
    }
}
registerProcessor("recorder-processor", RecorderProcessor);