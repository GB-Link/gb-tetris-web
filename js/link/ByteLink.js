/**
 * The link of Tetris Plus, from player 1's side: one byte each way per exchange, the clock
 * switching sides every exchange. Player 1's bytes go out on its own clock; the Game Boy's clock
 * gets 0x00. On every screen while not linked the game waits with 0xDD and links when player 1
 * clocks 0xFE.
 *
 * Two ways to the player's Game Boy, alike to their users:
 *   PortByteLink: the in-page emulator's link port
 *   AdapterByteLink: the adapter's hybrid mode (HybridAdapter.js), each byte of ours queued with
 *     the 0x00 for the Game Boy's turn after it
 *
 * tryLink() asks for the link, true once linked. clock(out) sends our byte (false: the Game Boy
 * isn't ready, try again later). onReply(out, byte): the Game Boy's byte on our clock.
 * onClocked(byte): the Game Boy clocked, with our 0x00.
 */
import { ON_TITLE } from './HybridAdapter.js';

const LINK_REQUEST = 0xFE;
// Linked, but the Game Boy stopped taking its turns this long ago: it left the game
const IDLE_MS = 250;

export class PortByteLink {
    /** port: the emulator's linkPort() */
    constructor(port) {
        this.port = port;
        this.onReply = null;
        this.onClocked = null;
    }

    tryLink() {
        if (this.port.listening() !== ON_TITLE || this.port.exchange(LINK_REQUEST, 0) !== ON_TITLE) return false;
        this.port.setFollower(0);
        return true;
    }

    unlink() {
        this.port.setFollower(-1);
    }

    clock(out) {
        const reply = this.port.exchange(out);
        if (reply === null) return false;
        this.onReply(out, reply);
        return true;
    }

    /** After every slice of emulation: the bytes the Game Boy clocked. */
    step() {
        for (const byte of this.port.takeMaster()) this.onClocked(byte);
    }
}

export class AdapterByteLink {
    /** adapter: a HybridAdapter, maybe linked already. onPair(): a whole exchange came back. */
    constructor(adapter) {
        this.adapter = adapter;
        this.onReply = null;
        this.onClocked = null;
        this.onPair = null;
        this.lastPairAt = -Infinity;
        // Our bytes whose exchanges are under way, and whether the next byte back is a reply
        this._sent = [];
        this._replyNext = true;
        // Linked and not yet reported by tryLink()
        this._fresh = adapter.hybrid;
        this._linking = false;
        adapter.onData = (bytes) => this._data(bytes);
    }

    tryLink() {
        if (this._fresh) {
            this._fresh = false;
            return true;
        }
        if (this.adapter.hybrid) {
            if (performance.now() - this.adapter.lastDataAt > IDLE_MS) this.unlink();
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
        this._sent = [];
        this._replyNext = true;
        this._fresh = false;
        this.adapter.toActive();
    }

    clock(out) {
        if (!this.adapter.hybrid) return false;
        this._sent.push(out);
        this.adapter.queue([out, 0x00]);
        return true;
    }

    step() {}

    _data(bytes) {
        for (const byte of bytes) {
            if (this._replyNext) {
                if (!this._sent.length) continue;
                this._replyNext = false;
                this.onReply(this._sent.shift(), byte);
            } else {
                this._replyNext = true;
                this.lastPairAt = performance.now();
                this.onClocked(byte);
                if (this.onPair) this.onPair();
            }
        }
    }
}
