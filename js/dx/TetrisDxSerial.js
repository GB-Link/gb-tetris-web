/**
 * Tetris DX, in the in-page emulator or on the adapter, as a link transport that
 * speaks the original Tetris protocol to the site (the same API as js/serial.js):
 * the page's game logic sees an original Tetris Game Boy, while this plays the
 * host of a DX 2-player game against the player's Game Boy (DxHost over DxLink).
 *
 * What the site sends, and what this does with it:
 *   29          handshake; answered 55 once the Game Boy is past its player data
 *   1C-1F, 50   music A, B, C, off; 50 confirms (the host picks VS and the music)
 *   60 ... 20   a game's start: garbage and the piece list; the piece list seeds
 *               the round, so every player's Tetris DX deals the same pieces
 *   0-19        a poll with the opponents' height; answered with ours (rows),
 *               80+n when we sent n lines, AA when we topped out, then FF
 *   80-85       n lines from an opponent
 *   AA          an opponent topped out: we won
 */
import { DxLink } from './DxLink.js';
import { DxHost } from './DxHost.js';
import { AdapterPacketLink } from '../link/PacketLink.js';

const REPLY_DELAY_MS = 2;
// After 60: [02 02 02 79 60] 29, 100 garbage, 29, 256 pieces, 30 00 02 02 20
const START_LENGTH = 1 + 100 + 1 + 256 + 5;
const PIECES_AT = 1 + 100 + 1;

const fromHexString = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

export class TetrisDxSerial {
    /**
     * emulator: the running GameBoyEmulator, or null for a Game Boy on the adapter, given as
     * adapter: a HybridAdapter (js/link/HybridAdapter.js) linked with it; hello: the message it
     * said on linking. onPrompt(show): the Game Boy waits for its player's A, which the page
     * presses itself in the emulator. name: shown as the opponent on the Game Boy.
     */
    constructor(emulator, { name, adapter = null, hello = null, onPrompt = () => {} } = {}) {
        this.emulator = emulator;
        this.adapter = adapter;
        this.onPrompt = onPrompt;
        this.prompt = false;
        this.buffer = [];
        this.send_active = false;
        this.isNewFirmware = true;
        this.ready = true;
        this._frames = [];
        this._waiters = [];
        this._closed = null;
        this._mode = 'menu';
        this._start = [];
        this._music = 1;
        this._replies = [];
        const port = emulator ? emulator.linkPort() : null;
        this.link = new DxLink(port || new AdapterPacketLink(adapter));
        this.host = new DxHost(this.link, port ? port.press : null, {
            name,
            onHeight: (rows) => { this._height = rows; },
            onAttack: (lines) => this._replies.push(0x80 + Math.min(lines, 5)),
            onToppedOut: () => this._replies.push(0xAA, 0xFF),
        });
        this._height = 0;
        if (emulator) {
            emulator.setLinkPartner({
                step: () => this.link.step(),
                frame: () => { this.link.frame(); this.host.frame(); },
            });
            return;
        }
        // On the adapter the page keeps the time: a packet a frame
        this._timer = setInterval(() => {
            this.link.frame();
            this.host.frame();
            this._setPrompt(this.host.phase === 'starting');
        }, 1000 / 60);
        if (hello) this.link.onMessage(hello);
    }

    _setPrompt(show) {
        if (show === this.prompt) return;
        this.prompt = show;
        this.onPrompt(show);
    }

    async getDevice() {
        this.ready = true;
    }

    /** Stops the link; resolves once the adapter is free for others. */
    close(message = this.emulator ? 'The emulator was closed.' : 'The Game Boy link was closed.') {
        this.ready = false;
        this._closed = message;
        this.buffer = [];
        this._waiters = [];
        this._frames = [];
        if (this.emulator) {
            this.emulator.setLinkPartner(null);
            this.emulator.setKeys('link', 0);
            return Promise.resolve();
        }
        clearInterval(this._timer);
        this._setPrompt(false);
        return this.adapter.dispose();
    }

    _byte(b) {
        if (b === 0x60) {
            this._mode = 'start';
            this._start = [];
            return 0x00;
        }
        switch (this._mode) {
            case 'menu':
                if (b === 0x29) return this.host.ready ? 0x55 : 0x00;
                if (b >= 0x1C && b <= 0x1F) this._music = b - 0x1B;
                if (b === 0x50) this.host.chooseMusic(this._music);
                return 0x00;
            case 'start':
                this._start.push(b);
                if (this._start.length === START_LENGTH && b === 0x20) {
                    this._replies = [];
                    this._height = 0;
                    this.host.startRound(seedFrom(this._start.slice(PIECES_AT, PIECES_AT + 256)));
                    this._mode = 'round';
                }
                return 0x00;
            case 'round':
                if (b === 0xAA || b === 0x77) {
                    // AA: an opponent topped out. 77 (an opponent reached 30 lines) has no DX counterpart
                    if (b === 0xAA) this.host.opponentToppedOut();
                    this._mode = 'menu';
                    return 0x00;
                }
                if (b >= 0x80 && b <= 0x85) {
                    this.host.attack(b - 0x80);
                    return 0x00;
                }
                if (b < 20) {
                    this.host.setOpponentHeight(b);
                    return this._replies.length ? this._replies.shift() : Math.min(this._height, 19);
                }
                return 0x00;
        }
        return 0x00;
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

    send(data) {
        if (this._closed) return Promise.reject(this._closed);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (this.emulator) this.emulator.advance();
        const replies = bytes.map((b) => this._byte(b));
        setTimeout(() => this._push(replies), REPLY_DELAY_MS);
        return Promise.resolve();
    }

    sendHex(str) {
        return this.send(fromHexString(str));
    }

    sendString(str) {
        return this.send(new TextEncoder().encode(str));
    }

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

    flushReads() {
        this._frames = [];
    }

    clearBuffer() {
        this.buffer = [];
        this.send_active = false;
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

/** The round's seed from the piece list: the same for every player in the game. */
function seedFrom(pieces) {
    let hash = 2166136261;
    for (const p of pieces) hash = Math.imul(hash ^ p, 16777619);
    return (hash >>> 24) & 0x7F;
}
