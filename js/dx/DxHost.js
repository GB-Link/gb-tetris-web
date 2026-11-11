/**
 * The host's side of Tetris DX's 2-player games, played by the page against the
 * Game Boy (the guest) over DxLink. Messages are [command, game, state] bytes:
 *
 *   hello       guest 01 -> host 02 (and the guest moves on to its player data)
 *   player      guest 01 (picked) 04 -> host 04, then each side's name in four
 *               [char, char, 01] messages and [00, 00, 01]; 'A' is 0x80, blank 0x7F
 *   menu        host F0 (VS) -> guest FE; music cursor 01-04, then 0E -> guest FF
 *   round       host 01 -> guest 04 (first round, answered with 04) or 03, then
 *               [seed, 0A] -> [_, 0B], [_, 0C] -> [_, 0D] and the round is on
 *   in a round  [n, _, _] n garbage lines; [_, 80 | height, _]; [_, _, 01] topped
 *               out, answered [_, _, 02]; [_, _, 81] paused, answered [_, _, 82]
 *               (the other pauses too), [_, _, 83] going on: only the side that
 *               paused can go on
 *   after it    each side [_, 33, _] once its result screen is passed; after a
 *               match (3 wins) the guest picks the music again and says 0E,
 *               answered 0F
 */
const BLANK = 0x7F;
// The Game Boy waits for its player on the VS, result and music screens; the
// page presses A for them when a round should start
const PRESS_EVERY_FRAMES = 40;
const PRESS_FRAMES = 6;

/** A name in the game's letters (A-Z), 8 long. */
export function dxName(text) {
    const out = [];
    for (const ch of (text || '').toUpperCase()) {
        if (out.length === 8) break;
        if (ch >= 'A' && ch <= 'Z') out.push(0x80 + ch.charCodeAt(0) - 65);
        else if (ch === ' ' && out.length) out.push(BLANK);
    }
    while (out.length < 8) out.push(BLANK);
    return out;
}

export class DxHost {
    /**
     * link: DxLink; press(mask): holds Game Boy keys (0 releases)
     * events: onReady() the Game Boy is at the menu; onHeight(rows); onAttack(lines);
     * onToppedOut() the Game Boy lost the round
     */
    constructor(link, press, { name = 'ONLINE', ...events } = {}) {
        this.link = link;
        this.press = press;
        this.name = dxName(name);
        this.events = events;
        this.phase = 'hello';
        this.frames = 0;
        this.music = 1;
        this.seed = 0x80;
        this.height = 0;
        this._sentHeight = -1;
        this._roundWanted = false;
        link.onMessage = (m) => this._message(m);
        link.onLost = () => this._go('hello');
    }

    /** The Game Boy is past its player data and names: the menus, VS screen or a round. */
    get ready() {
        return !['hello', 'player', 'names'].includes(this.phase);
    }

    _go(phase) {
        this.phase = phase;
        this.frames = 0;
        if (this.press) this.press(0);
    }

    /** Once a frame. */
    frame() {
        const f = ++this.frames;
        const every = (n) => f % n === 0;
        switch (this.phase) {
            case 'player':
                // We picked ours long ago
                if (every(8)) this.link.send(1);
                break;
            case 'vs-choice':
                if (every(4)) this.link.send(0xF0);
                break;
            case 'music':
                if (every(4)) this.link.send(0x0E);
                break;
            case 'starting':
                if (every(2)) this.link.send(1);
                if (this.press) this.press(f % PRESS_EVERY_FRAMES < PRESS_FRAMES && f > PRESS_FRAMES ? 1 : 0);
                break;
            case 'seed':
                if (every(2)) this.link.send(this.seed, 0x0A);
                break;
            case 'go':
                if (every(2)) this.link.send(0, 0x0C);
                break;
        }
    }

    /** The host picks VS and the music (1 A-type .. 4 off) at the menu. */
    chooseMusic(music) {
        this.music = Math.min(4, Math.max(1, music));
        if (this.phase === 'menu') this._go('vs-choice');
    }

    /** Starts a round with this seed (both players' pages use the same one). */
    startRound(seed) {
        this.seed = (seed & 0x7F) | 0x80;
        this._sentHeight = -1;
        this.height = 0;
        // Still at the menu: pick VS and the music first
        this._roundWanted = this.phase === 'menu' || this.phase === 'vs-choice' || this.phase === 'music';
        if (this.phase === 'menu') this._go('vs-choice');
        else if (!this._roundWanted) this._go('starting');
    }

    setOpponentHeight(rows) {
        if (this.phase !== 'playing' || rows === this._sentHeight) return;
        this._sentHeight = rows;
        this.link.send(0, 0x80 | Math.min(rows, 0x7F), 0);
    }

    attack(lines) {
        if (this.phase === 'playing' && lines > 0) this.link.send(lines);
    }

    opponentToppedOut() {
        if (this.phase === 'playing') this.link.send(0, 0, 1);
    }

    _message([m0, m1, m2]) {
        const phase = this.phase;
        if (m0 === 0x0E && phase !== 'music') {
            // After a match the guest picked the music again
            this.link.send(0x0F);
            if (phase !== 'starting') this._go('vs');
            return;
        }
        if (m1 === 0x33 && phase !== 'playing') {
            // Its result screen is passed: back to the VS screen together
            this.link.send(0, 0x33, 0);
            if (phase === 'result') this._go('vs');
            return;
        }
        if (phase === 'hello' && m0 === 1) {
            this.link.send(2);
            this._go('player');
        } else if (phase === 'player' && m0 === 4) {
            this.link.send(4);
            for (let i = 0; i < 8; i += 2) this.link.send(this.name[i], this.name[i + 1], 1);
            this.link.send(0, 0, 1);
            this._go('names');
        } else if (phase === 'names' && m0 === 0 && m1 === 0 && m2 === 1) {
            this._go('menu');
            if (this.events.onReady) this.events.onReady();
        } else if (phase === 'vs-choice' && m0 === 0xFE) {
            if (this.music > 1) this.link.send(this.music);
            this._go('music');
        } else if (phase === 'music' && m0 === 0xFF) {
            this._go(this._roundWanted ? 'starting' : 'vs');
            this._roundWanted = false;
        } else if (phase === 'starting' && (m0 === 4 || m0 === 3)) {
            if (m0 === 4) this.link.send(4);
            this._go('seed');
        } else if (phase === 'seed' && m1 === 0x0B) {
            this._go('go');
        } else if (phase === 'go' && m1 === 0x0D) {
            this._go('playing');
        } else if (phase === 'playing') {
            if (m0 && this.events.onAttack) this.events.onAttack(m0);
            if (m1 & 0x80) {
                this.height = m1 & 0x7F;
                if (this.events.onHeight) this.events.onHeight(this.height);
            }
            if (m2 === 1) {
                this.link.send(0, 0, 2);
                this._go('result');
                if (this.events.onToppedOut) this.events.onToppedOut();
            } else if (m2 === 2) {
                this._go('result');
            } else if (m2 === 0x81) {
                this.link.send(0, 0, 0x82);
            }
        }
    }
}
