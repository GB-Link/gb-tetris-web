/**
 * The link of Tetris DX and Tetris Attack, from player 1's side: 4-byte packets, [0, m0, m1, m2]
 * out and the Game Boy's four bytes back. Player 1 clocks bytes 0 and 2, the Game Boy bytes 1
 * and 3; byte 0 is a filler. On its title the game waits with 0xDD and links when player 1
 * clocks 0xFE.
 *
 * Two ways to the player's Game Boy, alike to their users:
 *   PortPacketLink: the in-page emulator's link port, byte by byte in step with the emulation
 *   AdapterPacketLink: the adapter's hybrid mode (HybridAdapter.js), whole packets queued
 *
 * tryLink() asks for the link, true once linked. start(packet) sends one; busy until the
 * Game Boy's four bytes are back, through onPacket(bytes). onTitle(): byte 0 came back 0xDD,
 * so the Game Boy is on its title and the link is gone.
 */
import { ON_TITLE } from './HybridAdapter.js';

const LINK_REQUEST = 0xFE;
// Linked, but the Game Boy stopped taking its turns this long ago: it left the game
const IDLE_MS = 250;

export class PortPacketLink {
    /** port: the emulator's linkPort() */
    constructor(port) {
        this.port = port;
        this.packet = null;
        this.onPacket = null;
        this.onTitle = null;
    }

    get busy() {
        return !!this.packet;
    }

    tryLink() {
        if (this.port.listening && this.port.listening() !== ON_TITLE) return false;
        if (this.port.exchange(LINK_REQUEST, 0) !== ON_TITLE) return false;
        this.port.setFollower(0);
        return true;
    }

    unlink() {
        this.packet = null;
        this.port.setFollower(-1);
    }

    start(out) {
        this.packet = { out, in: [], index: 0 };
        this._clock();
    }

    /** After every slice of emulation: the Game Boy's bytes, then ours when it's our turn. */
    step() {
        for (const byte of this.port.takeMaster()) {
            const p = this.packet;
            if (!p || (p.index !== 1 && p.index !== 3)) continue;
            p.in[p.index++] = byte;
            if (p.index === 4) this._finish();
        }
        const p = this.packet;
        if (p && (p.index === 0 || p.index === 2)) this._clock();
    }

    _clock() {
        const p = this.packet;
        const reply = this.port.exchange(p.out[p.index]);
        if (reply === null) return;
        // Byte 0 is always 0 from a linked Game Boy
        if (p.index === 0 && reply === ON_TITLE) {
            this.packet = null;
            if (this.onTitle) this.onTitle();
            return;
        }
        p.in[p.index++] = reply;
        this.port.setFollower(p.out[p.index]);
    }

    _finish() {
        const bytes = this.packet.in;
        this.packet = null;
        this.port.setFollower(0);
        if (this.onPacket) this.onPacket(bytes);
    }
}

export class AdapterPacketLink {
    /** adapter: a HybridAdapter, maybe linked already */
    constructor(adapter) {
        this.adapter = adapter;
        this.packet = null;
        this.onPacket = null;
        this.onTitle = null;
        // Linked and not yet reported by tryLink()
        this._fresh = adapter.hybrid;
        this._linking = false;
        adapter.onData = (bytes) => this._data(bytes);
    }

    get busy() {
        return !!this.packet;
    }

    tryLink() {
        if (this._fresh) {
            this._fresh = false;
            return true;
        }
        if (this.adapter.hybrid) {
            if (performance.now() - this.adapter.lastDataAt > IDLE_MS) this.adapter.toActive();
            return false;
        }
        if (!this._linking) {
            this._linking = true;
            this.adapter.link().then((linked) => {
                this._linking = false;
                if (linked) this._fresh = true;
            });
        }
        return false;
    }

    unlink() {
        this.packet = null;
        this._fresh = false;
        this.adapter.toActive();
    }

    start(out) {
        this.packet = { in: [] };
        this.adapter.queue(out);
    }

    step() {}

    _data(bytes) {
        for (const byte of bytes) {
            const p = this.packet;
            if (!p) continue;
            if (!p.in.length && byte === ON_TITLE) {
                this.unlink();
                if (this.onTitle) this.onTitle();
                return;
            }
            p.in.push(byte);
            if (p.in.length === 4) {
                this.packet = null;
                if (this.onPacket) this.onPacket(p.in);
            }
        }
    }
}
