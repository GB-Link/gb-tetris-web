/**
 * The in-page emulator as a link transport, with the same API as the USB and
 * WebSerial adapters (js/serial.js, js/serial_ws.js): every byte sent is
 * shifted into the emulated Game Boy at once, the game's byte comes back as the
 * reply frame for the next read. Replies arrive after a USB round trip's delay
 * and the adapter's 1 ms pause between bytes is kept, so the game sees the
 * link at the pace a real adapter gives it.
 */
const REPLY_DELAY_MS = 2;
const BYTE_GAP_CYCLES = 8389;

const fromHexString = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

export class SerialEmu {
    constructor(emulator) {
        this.emulator = emulator;
        this.buffer = [];
        this.send_active = false;
        this.isNewFirmware = true;
        this.ready = true;
        this._frames = [];
        this._waiters = [];
        this._closed = null;
    }

    async getDevice() {
        this.ready = true;
    }

    /** Ends the link: later sends and reads fail with the message. Reads already
     * waiting are dropped (the page stopped linking when it closed the emulator). */
    close(message = 'The emulator was closed.') {
        this.ready = false;
        this._closed = message;
        this.buffer = [];
        this._waiters = [];
        this._frames = [];
    }

    _push(frame) {
        if (this._closed) return;
        const waiter = this._waiters.shift();
        if (waiter) waiter.resolve(frame);
        else this._frames.push(frame);
    }

    _awaitFrame(timeoutMs) {
        if (this._closed) return Promise.reject(this._closed);
        if (this._frames.length > 0) return Promise.resolve(this._frames.shift());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this._waiters.push(waiter);
            if (timeoutMs > 0) {
                setTimeout(() => {
                    const i = this._waiters.indexOf(waiter);
                    if (i !== -1) {
                        this._waiters.splice(i, 1);
                        reject('The emulated Game Boy did not answer.');
                    }
                }, timeoutMs);
            }
        });
    }

    async setLed() {
        return this.ready;
    }

    // One send => one reply frame with a byte for every byte sent
    send(data) {
        if (this._closed) return Promise.reject(this._closed);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const replies = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            if (i > 0) this.emulator.wait(BYTE_GAP_CYCLES);
            replies[i] = this.emulator.exchange(bytes[i]) ?? 0x00;
        }
        setTimeout(() => this._push(replies), REPLY_DELAY_MS);
        return Promise.resolve();
    }

    sendHex(str) {
        return this.send(fromHexString(str));
    }

    sendString(str) {
        return this.send(new TextEncoder().encode(str));
    }

    // Same result shape as WebUSB's transferIn: payload from byte 0 of the buffer
    async read(num, timeoutMs = 2000) {
        const frame = await this._awaitFrame(timeoutMs);
        return { data: new DataView(frame.buffer, frame.byteOffset, frame.byteLength) };
    }

    readHex(num, timeoutMs = 2000) {
        return this.read(num, timeoutMs).then((result) => {
            const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
            return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
        });
    }

    readString() {
        return this.read(64).then((result) => new TextDecoder().decode(result.data));
    }

    /** Drops replies nobody has read yet. */
    flushReads() {
        this._frames = [];
    }

    clearBuffer() {
        this.buffer = [];
        this.send_active = false;
    }

    bufClear() {
        this.clearBuffer();
    }

    bufSendFunction() {
        this.send_active = true;
        if (this.buffer.length === 0) {
            this.send_active = false;
            return;
        }
        const [data, delay] = this.buffer.shift();
        this.send(data).then(() => {
            setTimeout(() => this.bufSendFunction(), delay);
        }, () => { this.send_active = false; });
    }

    bufSend(data, delay) {
        this.buffer.push([data, delay]);
        if (!this.send_active) this.bufSendFunction();
    }

    bufSendHex(str, delay) {
        this.bufSend(fromHexString(str), delay);
    }
}
