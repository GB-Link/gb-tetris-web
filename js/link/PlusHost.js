/**
 * Tetris Plus link host. The player's Game Boy runs as player 2 and this page
 * plays player 1 for it, through the emulator's link port (see PacketHost.js).
 *
 * Link: when the Game Boy listens with 0xDD (it does on every screen while not
 * linked) player 1 clocks 0xFE; the game jumps to VS mode. After power-on the
 * page waits 5 seconds first: the game's start-up stalls the link. Then one byte each way
 * per exchange, the clock switching sides every exchange; 0x00 is nothing. The
 * Game Boy takes one byte a frame, so this page sends its bytes on its own clock
 * only (once a frame) and answers the Game Boy's clock with 0x00.
 *
 * Setup, on the player's Game Boy alone:
 * - match size: player 2 takes any byte from player 1 as the size, so this page
 *   sends 0x81 (3 games) until the level screen opens (player 2 sends 0x01).
 * - level: the player picks it (player 2 sends 0x01-0x03 as the cursor moves,
 *   then 0x04 every frame once picked) and waits there for player 1's 0x04 for
 *   as long as it takes: that is the hold point (ready).
 *
 * Match:
 * - start: 0x04 until player 2 stops sending its 0x04s, then 0x01 once a frame
 *   until the round. Player 2 takes the bytes it gets during the round's start as
 *   its piece table and starting point: 0x01 (any other byte there breaks the
 *   game), so both Game Boys deal the same pieces.
 * - round: player 2 sends 0x40 + ceiling, 0x80 + professor row, 0xC1-0xC3
 *   attacks, 0xC4 (it lost) or 0xC8 (it won). These go to the other Game Boy
 *   while both play. A rival's end code counts on the Game Boy only within a
 *   few frames of its own end; later ones are not passed on.
 * - after a round player 2 sends 0x40 every frame and waits; once both Game Boys
 *   wait, each page releases its own (0x40, then 0x80 for the results screen).
 *   The page whose Game Boy got there last waits a network delay longer, the
 *   time the other page takes to learn it, so the next round starts together.
 *   Then 0xF0 during the tally and 0x01 again until the next round.
 * - the match is over when player 2 sends 0x20 (A on the match result) or no
 *   round follows within 10 seconds of the release. The page then sends 0xFF:
 *   the game drops the link and goes to its title, the page links again and the
 *   player picks a level. A new link starts the game's stage count (each round's
 *   well) from the first stage, so both Game Boys play the same wells. 0xFF also
 *   abandons a match.
 *
 * Messages to and from the other page: { t: 'm', v: [byte] } from their Game Boy
 * in a round, { t: 'at' } their Game Boy waits after a round, { t: 'over' }
 * their match is over or abandoned, { t: 'ping' / 'pong', f } to measure the
 * network delay.
 */
import { PacketHost } from './PacketHost.js';

const LINK = 0xFE;
const ON_TITLE = 0xDD;
const MATCH_SIZE = 0x81;
const WINS = 2;
const LEVEL_SCREEN = 0x01;
const LEVEL_PICKED = 0x04;
const SEED = 0x01;
const WAITING = 0x40;
const RESULTS = 0x80;
const TALLY = 0xF0;
const MATCH_A = 0x20;
const LOST = 0xC4;
const WON = 0xC8;
const QUIT = 0xFF;
const isEnd = (b) => (b & 0xC0) === 0xC0 && (b & 0x0C) !== 0;
const inRound = (b) => (b & 0xC0) !== 0 && b !== TALLY;
// Frames after power-on (attach, relink) before linking: the game's start-up screens
// (on a Super Game Boy) stall the link for a while, which breaks a link made before
const START_FRAMES = 300;
// Frames without a reply before the Game Boy counts as gone
const LOST_FRAMES = 60;
// A rival's end code is passed on until this many frames after our own end
const END_WINDOW = 6;
// Frames after the release with no round that mean the match is over (a next round speaks
// after ~520); the player's A on the match result ends it sooner
const OVER_FRAMES = 600;
// Frames both Game Boys show the round result before the pages release them
const SHOW_FRAMES = 60;
// Frames between delay measurements while matched
const PING_FRAMES = 300;
// Frames to wait for the game's title after 0xFF before sending it again
const QUIT_FRAMES = 240;

export class PlusHost extends PacketHost {
    constructor({ send, onEvent = () => {} }) {
        super({ send, onEvent });
        this.frames = 0;
        this.linkAt = START_FRAMES;
        this.delay = 0;
        this.timers = [];
        this.game = 0;
        this.matched = false;
        this.ready = false;
        this._playing = false;
        this._reset();
    }

    // A match is on until its result is known; the Game Boy then shows it and goes back to setup
    get playing() {
        return this._playing && !this.resultSent;
    }

    clearRemote() {
        this.inbox = [];
        this.theirWait = false;
    }

    match(leader) {
        this.leader = leader;
        this.matched = true;
        this.clearRemote();
        this._ping();
    }

    unmatch() {
        this.matched = false;
        this.clearRemote();
        if (this._playing && this.phase !== 'quit') this._quit();
    }

    /** Our Game Boy was reset: link again once it listens. */
    relink() {
        this.clearRemote();
        this.game++;
        this._setReady(false);
        this._setPlaying(false);
        this._unlink();
        this.linkAt = this.frames + START_FRAMES;
        this._phase('link');
    }

    start() {
        if (!this.ready) return;
        this._setReady(false);
        this._setPlaying(true);
        this.game++;
        this.resultSent = false;
        this.score = { mine: 0, theirs: 0 };
        this._phase('start');
        this.sending04 = false;
        // The leader's page gets go first: it starts its own Game Boy a network delay later
        this._after(this.leader ? this.delay : 0, () => {
            if (this.phase !== 'start') return;
            this.sending04 = true;
            this.last04 = this.frames;
        });
    }

    onRemote(msg) {
        switch (msg.t) {
        case 'ping': this.send({ t: 'pong', f: msg.f }); return;
        case 'pong': this.delay = Math.round((this.frames - msg.f) / 2); return;
        case 'm':
            if (this.phase === 'round' || (this.phase === 'roundOver' && isEnd(msg.v[0]))) this.inbox.push(msg.v[0]);
            return;
        case 'at':
            this.theirWait = true;
            // Ours was waiting already: we learn it a network delay after theirs did
            this._release(0);
            return;
        case 'over':
            // Their match ended while ours goes on (the two counted a round differently)
            if (this._playing && !['matchOver', 'quit'].includes(this.phase)) {
                this._result(this.score.mine > this.score.theirs ? true : this.score.mine < this.score.theirs ? false : null);
                this._quit();
            }
        }
    }

    attach(port) {
        this.port = port;
        this._unlink();
        this.linkAt = this.frames + START_FRAMES;
        return { step: () => this.step(), frame: () => this.frame() };
    }

    frame() {
        this.frames++;
        this._timers();
        if (this.matched && this.frames % PING_FRAMES === 0) this._ping();
        if (this.phase === 'link' || this.phase === 'quit') {
            if (this.phase === 'quit') {
                // Still linked after a while: the 0xFF didn't arrive
                if (!this.quitByte && this.frames - this.quitAt > QUIT_FRAMES) this.quitByte = true;
                if (this.quitByte) {
                    this._clock();
                    return;
                }
            }
            if (this.frames >= this.linkAt && this.port.listening() === ON_TITLE && this.port.exchange(LINK, 0) === ON_TITLE) this._linked();
            return;
        }
        if (++this.quiet > LOST_FRAMES) {
            this._gone();
            return;
        }
        this._clock();
    }

    // The Game Boy's turn: it clocked the byte we left for it (always 0x00)
    step() {
        const bytes = this.port.takeMaster();
        if (this.phase === 'link' || !bytes.length) return;
        this.ourTurn = true;
        this.quiet = 0;
        if (this.phase === 'quit') return;
        for (const byte of bytes) this._got(byte);
    }

    // ---- Link ----

    _reset() {
        this.ourTurn = false;
        this.pending = null;
        this.queue = [];
        this.waits = [];
        this.level = 1;
        this.score = { mine: 0, theirs: 0 };
        this.over = false;
    }

    _unlink() {
        this._reset();
        this.quitByte = false;
        if (this.port) this.port.setFollower(-1);
    }

    _linked() {
        this._reset();
        this.quitByte = false;
        this.ourTurn = true;
        this.quiet = 0;
        this.port.setFollower(0);
        this._setPlaying(false);
        this._phase('size');
    }

    // The Game Boy stopped answering or went back to its title by itself
    _gone() {
        if (this._playing) this.send({ t: 'over' });
        this.relink();
        this.linkAt = this.frames;
    }

    // Drops the link: the game goes to its title, then links again from there
    _quit() {
        if (this._playing) this.send({ t: 'over' });
        this.game++;
        this._setReady(false);
        this.queue = [];
        this.inbox = [];
        this.quitByte = true;
        this.quitAt = this.frames;
        this._phase('quit');
    }

    // Our turn to clock, once a frame
    _clock() {
        if (!this.ourTurn) return;
        const out = this.pending !== null ? this.pending : this._out();
        const reply = this.port.exchange(out);
        if (reply === null) {
            this.pending = out;
            return;
        }
        this.pending = null;
        this.ourTurn = false;
        this.quiet = 0;
        if (out === QUIT) {
            // The game leaves VS mode; it listens on its title soon after
            this.quitByte = false;
            this.quitAt = this.frames;
            return;
        }
        if (reply === ON_TITLE) {
            this._gone();
            return;
        }
        this._got(reply);
    }

    // ---- Player 1 ----

    // Our next byte, sent on our own clock
    _out() {
        if (this.queue.length) return this.queue.shift();
        switch (this.phase) {
        case 'quit': return QUIT;
        case 'size': return MATCH_SIZE;
        case 'start': return this.sending04 ? LEVEL_PICKED : 0;
        case 'seed': case 'next': case 'matchOver': return SEED;
        case 'round': {
            const b = this.inbox.length ? this.inbox.shift() : 0;
            this._rivalEnd(b);
            return b;
        }
        case 'roundOver':
            // Only a rival's end code that still counts on our Game Boy
            while (this.inbox.length) {
                const b = this.inbox.shift();
                if (this.ownEnd === null || this.frames - this.ownEndAt <= END_WINDOW) {
                    this._rivalEnd(b);
                    return b;
                }
            }
            return 0;
        default: return 0;
        }
    }

    // A byte from our Game Boy
    _got(b) {
        if (!b) return;
        switch (this.phase) {
        case 'size':
            if (b === LEVEL_SCREEN) this._phase('level');
            break;
        case 'level':
        case 'hold':
            if (b >= 1 && b <= 3) this.level = b;
            if (b === LEVEL_PICKED && this.phase === 'level') {
                this._phase('hold');
                this._setReady(true);
            }
            break;
        case 'start':
            if (b === LEVEL_PICKED) this.last04 = this.frames;
            else if (inRound(b)) this._round(b);
            break;
        case 'seed':
            if (inRound(b)) this._round(b);
            break;
        case 'round':
            this.send({ t: 'm', v: [b] });
            if (isEnd(b)) this._ownEnd(b);
            break;
        case 'roundOver':
            if (isEnd(b)) {
                this.send({ t: 'm', v: [b] });
                if (this.ownEnd === null) this._ownEnd(b);
            } else if (b === WAITING) {
                this.waits.push(this.frames);
                // 0x40 every frame: waiting after the round (in a round it comes every 4th frame)
                if (!this.atWait && this.waits.length >= 3 && this.frames - this.waits[this.waits.length - 3] <= 4) this._waiting();
            }
            break;
        case 'next':
        case 'matchOver':
            if (b === TALLY) this.tallyAt = this.frames;
            else if (b === MATCH_A && !this.over) this._matchOver();
            else if (inRound(b) && this.tallyAt !== null) this._round(b);
            break;
        }
    }

    _round(b) {
        this.queue = [];
        this.inbox = [];
        this.ownEnd = null;
        this.rivalEnd = null;
        this.atWait = false;
        this.releasing = false;
        this.waits = [];
        this._phase('round');
        this.send({ t: 'm', v: [b] });
    }

    _ownEnd(b) {
        this.ownEnd = b;
        this.ownEndAt = this.frames;
        if (this.phase === 'round') this._roundOver();
    }

    // We passed a byte to our Game Boy: an end code ends its round
    _rivalEnd(b) {
        if (!isEnd(b) || this.rivalEnd !== null) return;
        this.rivalEnd = b;
        if (this.phase === 'round') this._roundOver();
    }

    _roundOver() {
        this.inbox = this.inbox.filter(isEnd);
        this._phase('roundOver');
    }

    // Our Game Boy waits after the round: the result is the one it shows
    _waiting() {
        this.atWait = true;
        let won;
        if (this.ownEnd !== null) won = this.rivalEnd === this.ownEnd ? null : this.ownEnd === WON;
        else won = this.rivalEnd === LOST;
        if (won === true) this.score.mine++;
        if (won === false) this.score.theirs++;
        this.onEvent('round', { mine: this.score.mine, theirs: this.score.theirs, won });
        // The deciding round: the Game Boy shows the match result after the tally
        if (this.score.mine >= WINS || this.score.theirs >= WINS) this._result(this.score.mine > this.score.theirs);
        this.send({ t: 'at' });
        // Theirs was waiting already: their page learns of ours a network delay from now
        this._release(this.delay);
    }

    // Once both Game Boys wait, each page releases its own, both at the same moment
    _release(later) {
        if (!this.atWait || !this.theirWait || this.releasing || this.phase !== 'roundOver') return;
        this.releasing = true;
        this._after(SHOW_FRAMES + later, () => this._go());
    }

    _go() {
        if (this.phase !== 'roundOver') return;
        this.theirWait = false;
        this.queue = [WAITING, RESULTS, RESULTS];
        this.tallyAt = null;
        this.releasedAt = this.frames;
        this.over = false;
        this._phase(this.score.mine >= WINS || this.score.theirs >= WINS ? 'matchOver' : 'next');
    }

    _matchOver() {
        this.over = true;
        if (this.phase !== 'matchOver') this._phase('matchOver');
        this._result(this.score.mine > this.score.theirs);
        this._quit();
    }

    _result(won) {
        if (this.resultSent) return;
        this.resultSent = true;
        this.onEvent('match', { won });
    }

    _setReady(ready) {
        if (this.ready === ready) return;
        this.ready = ready;
        this.onEvent('ready', ready);
    }

    _setPlaying(playing) {
        this._playing = playing;
    }

    _ping() {
        this.send({ t: 'ping', f: this.frames });
    }

    // ---- Frame timers ----

    // Runs fn after some frames, unless the match ended or another began meanwhile
    _after(frames, fn) {
        this.timers.push({ at: this.frames + Math.max(0, frames), fn, game: this.game });
    }

    _timers() {
        if (this.phase === 'start' && this.sending04 && this.frames - this.last04 >= 3) {
            // Player 2 left its wait: the round's start, where only 0x01 may come
            this._phase('seed');
        }
        if ((this.phase === 'next' || this.phase === 'matchOver') && !this.over
            && this.frames - this.releasedAt > OVER_FRAMES) this._matchOver();
        const due = this.timers.filter((t) => t.at <= this.frames);
        if (!due.length) return;
        this.timers = this.timers.filter((t) => t.at > this.frames);
        for (const t of due) if (t.game === this.game) t.fn();
    }
}
