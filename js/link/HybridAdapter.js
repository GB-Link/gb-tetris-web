/**
 * The adapter's GB Link mode for the games whose two Game Boys take turns driving the clock:
 * Tetris DX, Tetris Attack and Tetris Plus. It needs GB-Link firmware 3.0.0 or newer.
 *
 * The link is asked for in active mode: 0xFE to the game's title, which answers 0xDD. Then the
 * adapter switches to hybrid mode, where it and the Game Boy take turns clocking one byte each,
 * the adapter first. The bytes queued here go out in order, whoever clocks, and each brings back
 * the Game Boy's byte of that exchange through onData. The GB Link mode takes its commands in
 * turn with the data, so a switch acts between the packets around it.
 *
 * While it lives, this takes all of the transport's reads.
 */
export const HYBRID_FIRMWARE = [3, 0, 0];
export const ON_TITLE = 0xDD;

// The GB Link mode's commands
const SET_ACTIVE = 0x33;
const SET_HYBRID = 0x35;
const LINK_REQUEST = 0xFE;
// The adapter's wait after the Game Boy's byte before it clocks its own; the games' own is ~0.32 ms
const GAP_US = 320;
// Back in active mode, the adapter's last bytes have all come once nothing came for this long
const QUIET_MS = 40;

const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HybridAdapter {
    /** serial: js/serial.js or js/serial_ws.js, connected */
    constructor(serial) {
        this.serial = serial;
        this.hybrid = false;
        this.onData = null;
        this.disposed = false;
        // The transport failed: the adapter is gone
        this.dead = false;
        this.lastDataAt = performance.now();
        this._waiter = null;
        this._leaving = null;
        this._read();
    }

    async _read() {
        while (!this.disposed) {
            let bytes;
            try {
                bytes = await this.serial.readData();
            } catch (e) {
                if (!this.disposed) this.dead = true;
                return;
            }
            if (this.disposed) return;
            this.lastDataAt = performance.now();
            if (this._waiter) {
                const waiter = this._waiter;
                this._waiter = null;
                waiter(bytes);
            } else if (this.hybrid && this.onData) {
                this.onData(bytes);
            }
        }
    }

    // Active mode: a packet out and its answer back, or null when none came in time
    _request(bytes, timeoutMs = 500) {
        return new Promise((resolve) => {
            const waiter = (answer) => {
                clearTimeout(timer);
                resolve(answer);
            };
            const timer = setTimeout(() => {
                if (this._waiter === waiter) this._waiter = null;
                resolve(null);
            }, timeoutMs);
            this._waiter = waiter;
            this.serial.send(new Uint8Array(bytes)).catch(() => {});
        });
    }

    /** Asks for the link once: true when the Game Boy linked and hybrid mode is on. */
    async link() {
        if (this._leaving) await this._leaving;
        if (this.hybrid) return true;
        if (this.disposed || this.dead) return false;
        const answer = await this._request([LINK_REQUEST]);
        if (!answer || answer[0] !== ON_TITLE || this.disposed) return false;
        // The adapter first, which waits for the first byte queued
        await this.serial.sendCommand([SET_HYBRID, ...u32(GAP_US), 0]).catch(() => {});
        if (this.disposed) return false;
        this.hybrid = true;
        this.lastDataAt = performance.now();
        return true;
    }

    /** Hybrid mode: bytes for the Game Boy, used in order whoever clocks. */
    queue(bytes) {
        if (this.hybrid) this.serial.send(new Uint8Array(bytes)).catch(() => {});
    }

    /** Back to active mode, for asking for the link again. Resolves once the adapter is quiet. */
    toActive() {
        if (!this.hybrid) return this._leaving || Promise.resolve();
        this.hybrid = false;
        this._leaving = (async () => {
            await this.serial.sendCommand([SET_ACTIVE]).catch(() => {});
            const start = performance.now();
            this.lastDataAt = start;
            while (performance.now() - this.lastDataAt < QUIET_MS && performance.now() - start < 500) await sleep(10);
            this._leaving = null;
        })();
        return this._leaving;
    }

    /** Leaves the adapter in active mode with nothing in flight, and the transport to others. */
    async dispose() {
        if (this.disposed) return;
        await this.toActive();
        this.disposed = true;
        if (this.serial.cancelReads) this.serial.cancelReads();
        if (this.serial.flushReads) this.serial.flushReads();
    }
}

/**
 * Which of the three games linked. Tetris DX says hello (01) at once. Tetris Attack and Tetris
 * Plus say nothing until their players press buttons, and then either may, so the timing tells
 * them apart: now and then a Tetris Attack packet comes back in well under a frame, while Tetris
 * Plus clocks its turns from its frame routine and never does. Sends empty 4-byte packets about
 * once a frame, at varying points of the Game Boy's frame, and stops between packets. Resolves
 * { game: 'dx' | 'attack' | 'plus', hello }, or null when the Game Boy stopped answering or went
 * back to its title.
 */
export async function identify(adapter) {
    const HELLO_MS = 400;
    const FAST_MS = 20;
    const PLUS_AFTER_MS = 3000;
    const LOST_MS = 1000;
    const start = performance.now();
    let fast = false;
    let got = [];
    let done = null;
    adapter.onData = (bytes) => {
        got.push(...bytes);
        if (done && (got.length >= 4 || got[0] === ON_TITLE)) done();
    };
    try {
        for (;;) {
            got = [];
            const sentAt = performance.now();
            const finished = new Promise((resolve) => { done = resolve; });
            adapter.queue([0, 0, 0, 0]);
            const timeout = sleep(LOST_MS).then(() => 'lost');
            if ((await Promise.race([finished, timeout])) === 'lost' || got[0] === ON_TITLE) {
                await adapter.toActive();
                return null;
            }
            const now = performance.now();
            if (now - sentAt < FAST_MS) fast = true;
            const [m0, m1, m2] = got.slice(1, 4);
            if (now - start < HELLO_MS) {
                if (m0 === 0x01 && !m1 && !m2) return { game: 'dx', hello: [m0, m1, m2] };
            } else if (fast) {
                return { game: 'attack' };
            }
            if (now - start >= PLUS_AFTER_MS) return { game: 'plus' };
            await sleep((1000 / 60) * (0.5 + Math.random()));
        }
    } finally {
        adapter.onData = null;
    }
}
