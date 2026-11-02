/**
 * Tetris Attack link host. The player's Game Boy runs as player 2 and this page
 * plays player 1 for it. The link (see PacketHost.js): 4-byte packets, one a
 * frame, player 1 clocks bytes 0 and 2, the Game Boy bytes 1 and 3; bytes 1-3
 * carry a 3-byte message (all zero: nothing). On the title the game waits with
 * 0xDD; player 1 clocks 0xFE and the Game Boy goes straight to SET LEVEL.
 *
 * Setup is the player's own. On SET LEVEL and SELECT STAGE the Game Boy sends
 * [keys 00 00] (buttons just pressed), [keys 00 02] ready, [00 00 01] not ready
 * any more, [02 00 03] back (B): answered [00 00 03], SET LEVEL goes back to the
 * title, SELECT STAGE to SET LEVEL. Player 1 says ready with [01 00 02]; 16
 * frames after both are ready the Game Boy goes on. Player 1's level and stage
 * only show on player 2's screen, so the page keeps the defaults: it is ready on
 * SET LEVEL right after the player, and on SELECT STAGE only to start a match. A
 * Game Boy ready on SELECT STAGE waits there for as long as it takes.
 *
 * Every round starts with both sides sending a board: 14 rows, the third byte's
 * bit 7 set. Player 2 plays player 1's first 13 and the music in its 14th,
 * [00 n 80|n+1] (n: the round's song, n+1 while the stack is high). Rows sent
 * before the Game Boy sends its first are lost. Both Game Boys play the leader's
 * rows: the leader's page sends its Game Boy's rows back to it and to the other
 * page, each page with its own music. READY lasts 240 frames after the last row;
 * messages from the other Game Boy are held until then.
 *
 * In a round: [80 h 00] stack height, [n 00 00] an attack, [00 00 01] topped
 * out, answered [00 00 02] (or [00 00 01]: both topped out, a draw). The frame
 * after answering, the Game Boy takes what comes in as the other's answer, so a
 * repeated [00 00 01] (sent again in case READY swallowed it) keeps 8 frames
 * apart. The result screen goes on with a key on either Game Boy, [00 00 0f];
 * during play that would read as topped out, so it only goes to our Game Boy
 * while it shows a result. Two won rounds win the match; the Game Boy then goes
 * back to SET LEVEL by itself, keeping its choices.
 *
 * If the player takes back their ready as a match starts, player 1 stays ready
 * and the Game Boy starts as soon as they press A again.
 *
 * A round can't be quit: to abandon a match the page tops out ([00 00 01] until
 * the Game Boy answers), moves the result screens on and plays the Game Boy's own
 * boards back to it until it has won.
 *
 * Messages to and from the other page: { t: 'm', v } a round message of their
 * Game Boy; { t: 'board', m, n, v } the leader's 13 rows for round n of match m;
 * { t: 'quit' } their Game Boy left a match before it began.
 *
 * attach(port) returns the emulator's link partner for its linkPort(): step()
 * runs after every slice of emulation, frame() once a frame.
 */
import { PacketHost } from './PacketHost.js';

const LINK = 0xFE;
const ON_TITLE = 0xDD;
// Frames without a reply before linking again (the Game Boy went back to its title)
const LOST_FRAMES = 60;
const READY = [0x01, 0x00, 0x02];
const NOT_READY = [0x02, 0x00, 0x01];
const BACK = [0x00, 0x00, 0x03];
const TOPPED_OUT = [0x00, 0x00, 0x01];
const GO_ON = [0x00, 0x00, 0x0F];
const ROWS = 14;
// From our last board row to the end of READY, with a little to spare
const READY_FRAMES = 246;
// Repeated messages (topping out, going on) every few frames
const REPEAT_FRAMES = 4;
// A Game Boy that answers [00 00 01] reads the next frame's message as its result: another
// [00 00 01] there would make it a draw, so repeats of it keep this far apart
const TOPPED_OUT_FRAMES = 8;
// After the deciding round the result screen is up within ~200 frames; going on from it leads to SET LEVEL
const MATCH_END_FRAMES = 300;
const WINS = 2;

/** setMusic() values: -1 follows the stage the player picks; otherwise a stage's song. */
export const ATTACK_MUSIC = [
    { value: -1, label: 'Your stage' },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((value) => ({ value, label: `Stage ${value + 1}` })),
    { value: 8, label: 'Secret stages 9-11' },
    { value: 11, label: 'Secret stage 12' },
];
const song = (stage) => (stage < 8 ? 2 * stage + 7 : stage < 11 ? 0x17 : 0x19);

export class AttackHost extends PacketHost {
    /** music: see ATTACK_MUSIC. */
    constructor({ send, onEvent = () => {}, music = -1 }) {
        super({ send, onEvent });
        this.music = music;
        this.matched = false;
        this.ready = false;
        this.inMatch = false;
        this.linked = false;
        this.frames = 0;
        this.matchNo = 0;
        this._reset('title');
    }

    /** From start() until the deciding round or, abandoned, until the Game Boy is back on SET LEVEL. */
    get playing() {
        return this.inMatch && !this.matchOver;
    }

    setMusic(music) {
        this.music = music;
    }

    /** An opponent joined. leader: both Game Boys play this page's boards. */
    match(leader) {
        this.leader = leader;
        this.matched = true;
        this.matchNo = 0;
        this.clearRemote();
    }

    /** The opponent left: a match in progress is abandoned. */
    unmatch() {
        this.matched = false;
        this.clearRemote();
        if (this.inMatch) this._abandon();
    }

    /** Starts a match: player 1 says ready on SELECT STAGE. */
    start() {
        if (!this.linked || this.inMatch) return;
        this.inMatch = true;
        this.forfeit = false;
        this.matchNo++;
        this.boardNo = 0;
        this.score = { mine: 0, theirs: 0 };
        this.matchOver = false;
        if (this.screen === 'stage' && !this.p1Ready) this._sayReady();
        this._update();
    }

    clearRemote() {
        this.held = [];
        this.boards = new Map();
    }

    /** Our Game Boy was reset: link again from the title. */
    relink() {
        this._unlink();
        this.linked = false;
        this.inMatch = false;
        this.clearRemote();
        this._reset('title');
        this._update();
    }

    onRemote(msg) {
        if (!this.matched) return;
        if (msg.t === 'm') this._theirs(msg.v);
        else if (msg.t === 'board') {
            this.boards.set(`${msg.m}:${msg.n}`, msg.v);
            this._leaderBoard();
        } else if (msg.t === 'quit' && this.inMatch && !this.forfeit) {
            this._abandon();
        }
    }

    frame() {
        this.frames++;
        if (!this.linked) {
            if (this.port.listening() === ON_TITLE && this.port.exchange(LINK, 0) === ON_TITLE) this._linked();
            return;
        }
        if (++this.quiet > LOST_FRAMES) {
            this._lost();
            return;
        }
        this._timed();
        this._frame();
    }

    step() {
        if (this.linked) this._step();
    }

    // ---- State ----

    // Where the Game Boy is ('title', 'level', 'stage', 'board', 'round', 'result') and what it knows
    _reset(screen) {
        this.screen = screen;
        this.p1Ready = false;
        this.p2Ready = false;
        this.stage = 0;
        this.forfeit = false;
        this.packet = null;
        this.toGb = [];
        this.rowsOut = [];
        this.rows = [];
        this.boardSent = false;
        this.playAt = Infinity;
        this.myTopOut = false;
        this.theirTopOut = false;
        this.topOutAt = -Infinity;
        this.goOnUntil = null;
        this.resultAt = 0;
        this.score = { mine: 0, theirs: 0 };
        this.matchOver = false;
        this.boardNo = 0;
    }

    _update() {
        let phase;
        if (!this.linked) phase = 'link';
        else if (this.forfeit) phase = 'abandon';
        else if (this.inMatch) {
            const waiting = this.screen === 'level' || (this.screen === 'stage' && !this.p2Ready);
            phase = waiting ? 'confirm' : this.screen === 'round' ? 'round' : this.screen === 'result' ? 'result' : 'start';
        } else phase = this.screen === 'stage' ? (this.p2Ready ? 'hold' : 'stage') : 'level';
        if (phase !== this.phase) this._phase(phase);
        const ready = phase === 'hold';
        if (ready !== this.ready) {
            this.ready = ready;
            this.onEvent('ready', ready);
        }
    }

    _linked() {
        this.linked = true;
        this.quiet = 0;
        this.port.setFollower(0);
        this._reset('level');
        this._update();
    }

    // The Game Boy went back to its title (left SET LEVEL): link again
    _lost() {
        this._unlink();
        this.linked = false;
        if (this.inMatch) this._quit();
        this._reset('title');
        this._update();
    }

    _unlink() {
        this.packet = null;
        if (this.port) this.port.setFollower(-1);
    }

    _sayReady() {
        this.toGb.push(READY);
        this.p1Ready = true;
    }

    // Our Game Boy left a match before its first round
    _quit() {
        if (this.matched) this.send({ t: 'quit' });
        this.inMatch = false;
        this.forfeit = false;
    }

    _abandon() {
        this.clearRemote();
        if (this.screen === 'title' || this.screen === 'level' || (this.screen === 'stage' && !(this.p1Ready && this.p2Ready))) {
            // Not in a round yet: player 1 takes back its ready on SELECT STAGE
            if (this.screen === 'stage' && this.p1Ready) {
                this.toGb.push(NOT_READY);
                this.p1Ready = false;
            }
            this.inMatch = false;
            this._update();
            return;
        }
        this.forfeit = true;
        if (this.screen === 'round') this.theirTopOut = true;
        if (this.screen === 'result') this._goOn();
        if (this.screen === 'board' && !this.boardSent && this.rows.length >= ROWS - 1) this._sendBoard(this.rows.slice(0, ROWS - 1));
        this._update();
    }

    _endMatch() {
        this.inMatch = false;
        this.forfeit = false;
        this.screen = 'level';
        this.p1Ready = false;
        this.p2Ready = false;
        this.goOnUntil = null;
        this.held = [];
        this._update();
    }

    // ---- What our Game Boy sends ----

    _got(v) {
        if (v[2] & 0x80) {
            this._row(v);
            return;
        }
        if (this.screen === 'level') this._onLevel(v);
        else if (this.screen === 'stage') this._onStage(v);
        else if (this.screen === 'round') this._onRound(v);
        else if (this.screen === 'result') this._onResult(v);
        this._update();
    }

    _onLevel(v) {
        if (v[2] === 2) {
            if (!this.p1Ready) this._sayReady();
            // Both ready: SELECT STAGE in 16 frames, with nothing from the Game Boy meanwhile
            this.screen = 'stage';
            this.p1Ready = false;
            this.p2Ready = false;
        } else if (v[2] === 3) {
            this.toGb.push(BACK);
            if (this.inMatch) this._quit();
            this.screen = 'title';
        }
    }

    _onStage(v) {
        if (v[2] === 0) {
            this._moveStage(v[0]);
        } else if (v[2] === 2) {
            this.p2Ready = true;
            if (this.inMatch && !this.p1Ready) this._sayReady();
        } else if (v[2] === 1) {
            if (this.p2Ready) {
                this.p2Ready = false;
            } else {
                // Still on SET LEVEL: it took its ready back before ours came
                this.screen = 'level';
                this.p1Ready = true;
            }
        } else if (v[2] === 3) {
            this.toGb.push(BACK);
            if (this.inMatch) this._quit();
            this.screen = 'level';
            this.p1Ready = false;
            this.p2Ready = false;
        }
    }

    // The player's stage cursor (4 x 3), moved as the game moves it
    _moveStage(keys) {
        const s = this.stage;
        if (keys & 0x02 || keys & 0x08) return;
        if (keys & 0x04) this.stage = Math.min(s + 1, 11);
        else if (keys & 0x10) this.stage = s % 4 === 3 ? s : s + 1;
        else if (keys & 0x20) this.stage = s % 4 === 0 ? s : s - 1;
        else if (keys & 0x40) this.stage = s >= 4 ? s - 4 : s;
        else if (s < 8) this.stage = s + 4;
    }

    _row(v) {
        if (this.screen !== 'board' && !(this.screen === 'round' && this.rows.length < ROWS)) {
            // A round begins with its board
            if (!this.inMatch) {
                // Not started by this page (shouldn't happen): play it out alone
                this.inMatch = true;
                this.forfeit = true;
            }
            this.screen = 'board';
            this.rows = [];
            this.boardSent = false;
            this.boardNo++;
            this.p1Ready = false;
            this.p2Ready = false;
            this.goOnUntil = null;
            this.myTopOut = false;
            this.theirTopOut = false;
            this.playAt = Infinity;
        }
        this.rows.push(v);
        if (this.rows.length === ROWS - 1) {
            const rows = this.rows.slice();
            if (this.forfeit || !this.matched) {
                this._sendBoard(rows);
            } else if (this.leader) {
                this.send({ t: 'board', m: this.matchNo, n: this.boardNo, v: rows });
                this._sendBoard(rows);
            }
        }
        this._leaderBoard();
        this._update();
    }

    // Not the leader: the leader's rows go to our Game Boy once it is in this round's board exchange
    _leaderBoard() {
        if (this.leader || this.forfeit || this.screen !== 'board' || this.boardSent || !this.rows.length) return;
        const rows = this.boards.get(`${this.matchNo}:${this.boardNo}`);
        if (rows) this._sendBoard(rows);
    }

    _sendBoard(rows) {
        const stage = this.music < 0 ? this.stage : this.music;
        this.rowsOut = [...rows.slice(0, ROWS - 1), [0x00, song(stage), 0x80 | (song(stage) + 1)]];
        this.boardSent = true;
    }

    _onRound(v) {
        if (this.matched && !this.forfeit) this.send({ t: 'm', v });
        if (v[2] === 2) {
            // It answered player 1 topping out
            this._result(true);
        } else if (v[2] === 1) {
            this.myTopOut = true;
            if (this.forfeit) this.toGb.push(TOPPED_OUT);
            if (this.forfeit || this.theirTopOut) this._result(null);
        }
    }

    _onResult(v) {
        if (v[2] === 0x0F) {
            if (this.matched && !this.forfeit) this.send({ t: 'm', v });
            if (this.matchOver) this._endMatch();
        } else if (this.matchOver) {
            // Moved on by the other Game Boy's key: already on SET LEVEL
            this._endMatch();
            this._onLevel(v);
        }
    }

    // won: true, false, or null for a draw
    _result(won) {
        if (won === true) this.score.mine++;
        else if (won === false) this.score.theirs++;
        this.screen = 'result';
        this.resultAt = this.frames;
        this.myTopOut = false;
        this.theirTopOut = false;
        this.held = [];
        this.matchOver = this.score.mine >= WINS || this.score.theirs >= WINS;
        if (this.forfeit) {
            this._goOn();
            return;
        }
        this.onEvent('round', { mine: this.score.mine, theirs: this.score.theirs, won: won === true, draw: won === null });
        if (this.matchOver) this.onEvent('match', { won: this.score.mine >= WINS });
    }

    // Move our result screen on: [00 00 0f] until the next board, or until the Game Boy is back on SET LEVEL
    _goOn() {
        this.goOnUntil = this.matchOver ? Math.max(this.frames + 30, this.resultAt + MATCH_END_FRAMES) : Infinity;
    }

    // ---- What the other Game Boy sends ----

    _theirs(v) {
        if (!this.inMatch || this.forfeit) return;
        if (v[2] === 0x0F) {
            if (this.screen === 'result') this._goOn();
            return;
        }
        if (this.screen === 'result') return;
        if (this.screen === 'round' && this.frames >= this.playAt) this._toRound(v);
        else this.held.push(v);
    }

    _toRound(v) {
        this.toGb.push(v);
        if (v[2] === 1) {
            if (this.myTopOut) this._result(null);
            // Repeated until our Game Boy answers
            else this.theirTopOut = true;
        } else if (v[2] === 2 && this.myTopOut) {
            this._result(false);
        }
        this._update();
    }

    // ---- Link ----

    // Timed steps: held messages once READY is over, the end of a match moved on by the page
    _timed() {
        if (this.screen === 'round' && this.frames >= this.playAt && this.held.length) {
            const held = this.held;
            this.held = [];
            for (const v of held) if (this.screen === 'round') this._toRound(v);
        }
        if (this.screen === 'result' && this.matchOver && this.goOnUntil !== null && this.frames >= this.goOnUntil) this._endMatch();
    }

    // Player 1's next message: board rows, then the queue, then repeated ones
    _next() {
        if (this.rowsOut.length) {
            const row = this.rowsOut.shift();
            if (!this.rowsOut.length) {
                this.screen = 'round';
                this.playAt = this.frames + READY_FRAMES;
                if (this.forfeit) this.theirTopOut = true;
                this._update();
            }
            return row;
        }
        if (this.toGb.length) return this._sent(this.toGb.shift());
        if (this.screen === 'round' && this.theirTopOut && !this.myTopOut && this.frames - this.topOutAt >= TOPPED_OUT_FRAMES) return this._sent(TOPPED_OUT);
        if (this.frames % REPEAT_FRAMES) return null;
        if (this.screen === 'result' && this.goOnUntil !== null && this.frames < this.goOnUntil) return GO_ON;
        return null;
    }

    _sent(v) {
        if (v[2] === 1) this.topOutAt = this.frames;
        return v;
    }

    // One packet per frame
    _frame() {
        if (this.packet) return;
        this.packet = { out: [0, ...(this._next() || [0, 0, 0])], in: [], index: 0 };
        this._clock();
    }

    _step() {
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
        // Byte 0 is always 0 from a linked Game Boy; 0xDD: it is back on its title
        if (p.index === 0 && reply === ON_TITLE) {
            this._lost();
            return;
        }
        p.in[p.index++] = reply;
        this.port.setFollower(p.out[p.index]);
    }

    _finish() {
        const message = this.packet.in.slice(1);
        this.packet = null;
        this.quiet = 0;
        this.port.setFollower(0);
        if (message.some((b) => b)) this._got(message);
    }
}
