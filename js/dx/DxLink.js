/**
 * Tetris DX's link layer, from the side of the copy that asked for a 2-player game (the host).
 * The other Game Boy is the in-page emulator or a Game Boy on the adapter.
 *
 * On the title screen the game waits as follower with 0xDD; the host clocks 0xFE and the link is
 * up. Then the two sides swap 4-byte packets, the clock alternating every byte: the host clocks
 * bytes 0 and 2, the Game Boy bytes 1 and 3. Byte 0 is a filler; bytes 1-3 carry one 3-byte
 * message, all zero for "nothing to say". The host starts one packet a frame, as the game does.
 * The packets themselves go through a packet link (js/link/PacketLink.js).
 */
import { PortPacketLink } from '../link/PacketLink.js';

// A packet the Game Boy stops answering (reset, back on the title) ends the link
const PACKET_TIMEOUT_FRAMES = 60;

export class DxLink {
    /** link: the emulator's linkPort(), or a packet link (js/link/PacketLink.js) */
    constructor(link) {
        this.packets = link.exchange ? new PortPacketLink(link) : link;
        this.packets.onPacket = (bytes) => this._finish(bytes);
        this.packets.onTitle = () => this._lose();
        this.session = false;
        this.onMessage = null;
        this.onLost = null;
        this._queue = [];
        this._frames = 0;
    }

    /** Queues a message for the Game Boy. */
    send(m0 = 0, m1 = 0, m2 = 0) {
        this._queue.push([m0 & 0xFF, m1 & 0xFF, m2 & 0xFF]);
    }

    /** Ends the link (the next frame asks for it again). */
    reset() {
        this.session = false;
        this._queue = [];
        this.packets.unlink();
    }

    /** Once a frame: ask for the link, or start the next packet. */
    frame() {
        if (!this.session) {
            if (this.packets.tryLink()) this.session = true;
            return;
        }
        if (this.packets.busy) {
            if (++this._frames > PACKET_TIMEOUT_FRAMES) this._lose();
            return;
        }
        this._frames = 0;
        this.packets.start([0, ...(this._queue.shift() || [0, 0, 0])]);
    }

    /** After every slice of play (emulator). */
    step() {
        this.packets.step();
    }

    _lose() {
        this.reset();
        if (this.onLost) this.onLost();
    }

    _finish(bytes) {
        const message = bytes.slice(1);
        if (this.onMessage && message.some((b) => b)) this.onMessage(message);
    }
}
