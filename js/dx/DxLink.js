/**
 * Tetris DX's link layer, from the side of the copy that asked for a 2-player
 * game (the host). The other Game Boy is the in-page emulator.
 *
 * On the title screen the game waits as follower with 0xDD; the host clocks
 * 0xFE and the link is up. Then the two sides swap 4-byte packets, the clock
 * alternating every byte: the host clocks bytes 0 and 2, the Game Boy bytes 1
 * and 3 (the host's byte is ready for it). Byte 0 is a filler; bytes 1-3 carry
 * one 3-byte message, all zero for "nothing to say". The host starts one packet
 * a frame, as the game does.
 */
const LINK_REQUEST = 0xFE;
const LINK_ANSWER = 0xDD;
// A packet the Game Boy stops answering (reset, back on the title) ends the link
const PACKET_TIMEOUT_FRAMES = 60;

export class DxLink {
    /** port: the emulator's linkPort() */
    constructor(port) {
        this.port = port;
        this.session = false;
        this.onMessage = null;
        this.onLost = null;
        this._queue = [];
        this._packet = null;
    }

    /** Queues a message for the Game Boy. */
    send(m0 = 0, m1 = 0, m2 = 0) {
        this._queue.push([m0 & 0xFF, m1 & 0xFF, m2 & 0xFF]);
    }

    /** Ends the link (the next frame asks for it again). */
    reset() {
        this.session = false;
        this._queue = [];
        this._packet = null;
        this.port.setFollower(-1);
    }

    /** Once a frame: ask for the link, or start the next packet. */
    frame() {
        if (!this.session) {
            if (this.port.exchange(LINK_REQUEST, 0) === LINK_ANSWER) {
                this.session = true;
                this.port.setFollower(0);
            }
            return;
        }
        if (this._packet) {
            if (++this._packet.frames > PACKET_TIMEOUT_FRAMES) {
                this.reset();
                if (this.onLost) this.onLost();
            }
            return;
        }
        const message = this._queue.shift() || [0, 0, 0];
        this._packet = { out: [0, ...message], in: [], index: 0, frames: 0 };
        this._clock();
    }

    /** After every slice of play: the Game Boy's bytes, then ours when it's our turn. */
    step() {
        for (const byte of this.port.takeMaster()) {
            const p = this._packet;
            if (!p || (p.index !== 1 && p.index !== 3)) continue;
            p.in[p.index++] = byte;
            if (p.index === 4) this._finish();
        }
        const p = this._packet;
        if (p && (p.index === 0 || p.index === 2)) this._clock();
    }

    _clock() {
        const p = this._packet;
        const reply = this.port.exchange(p.out[p.index]);
        if (reply === null) return;
        p.in[p.index] = reply;
        p.index++;
        this.port.setFollower(p.out[p.index]);
    }

    _finish() {
        const message = this._packet.in.slice(1);
        this._packet = null;
        this.port.setFollower(0);
        if (this.onMessage && message.some((b) => b)) this.onMessage(message);
    }
}
