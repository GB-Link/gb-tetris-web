/**
 * Tetris Blast link host. The player's Game Boy runs as player 2 and this page
 * plays player 1 for it. The player sets up on the Game Boy before there is an
 * opponent; in a match the page passes on what the other player's Game Boy
 * sends during the rounds.
 *
 * out() returns the next byte to clock and got(byte) takes the Game Boy's
 * reply (null or 0xFF: no reply). 0x00 is idle both ways. Player 2's game runs
 * one frame per byte and goes back to its title after 31 frames without one.
 *
 * Protocol:
 * - Link: on its title and 1-player menus the Game Boy answers 0x81; player 1
 *   clocks 0x80, which opens the 2-player menu.
 * - Menu: the Game Boy sends 0x90 + stage and 0x82 + level every 4 frames and
 *   0xAB every frame once ready (B makes it unready again). Player 1's menu
 *   bytes only fill the "Rival" panel, so the page sends 0x00. Twelve 0xAB in a
 *   row from player 1 start the round.
 * - Seed: at each round start the Game Boy asks with 0xD7 until player 1
 *   answers 0xB7 + high nibble, 0xC7 + low nibble, then 0xD7. Both Game Boys get
 *   the lobby leader's seed.
 * - During and after a round both sides send the same kind of data: 0x6n stack
 *   height, 0xB3-0xB6 attacks, 0xAD/0xDA pause and music, 0xB0 topped out,
 *   0xAF won, 0xAE draw, 0xB2 next round. The first to win 3 rounds wins the
 *   match. The winner then waits for player 1's 0xB2 (back to the 2-player
 *   menu); the loser asks "Try Again?" and sends 0xB2 (yes, back to the menu)
 *   or 0xB1 (no, back to its title).
 * - 0xD8 resets the Game Boy to its title (it sends 0xD8 too on a soft reset).
 *
 * Messages to and from the other page (n: the match number since match()):
 *   { t: 'm', v: [bytes], n }  bytes their Game Boy sent in a round
 *   { t: 'seed', v, n }        a round seed from the leader
 */
const IDLE = 0x00;
const LINK = 0x80;
const ON_TITLE = 0x81;
const MENU_FIRST = 0x82;
const MENU_LAST = 0xA9;
const READY = 0xAB;
const SEED_ASK = 0xD7;
const SEED_HI = 0xB7;
const SEED_LO = 0xC7;
const WON = 0xAF;
const DRAW = 0xAE;
const TOPPED_OUT = 0xB0;
const RESULTS = [WON, DRAW, TOPPED_OUT];
const NEXT = 0xB2;
const RESET = 0xD8;
const NO_REPLY = 0xFF;
// Round wins that take a match
const MATCH_ROUNDS = 3;
// D8 tries before just waiting for the title
const RESET_TRIES = 8;

const isMenu = (byte) => byte >= MENU_FIRST && byte <= MENU_LAST;

export class BlastHost {
    /**
     * send(msg): sends to the other page. onEvent(name, data): 'phase' (link,
     * setup, hold, start, round, result, won, again), 'ready' (boolean), 'round'
     * ({ mine, theirs, won, draw }), 'match' ({ won }), and 'reset' when the Game
     * Boy went back to its title during a match.
     */
    constructor({ send, onEvent = () => {} }) {
        this.send = send;
        this.onEvent = onEvent;
        this.leader = false;
        this.ready = false;
        this.inMatch = false;
        this.answer = null;
        this.last = IDLE;
        this.matchNo = 0;
        this.resetTries = 0;
        this._clearRemote();
        this._phase('link');
    }

    /** True from start() until the match is over or abandoned. */
    get playing() {
        return this.inMatch;
    }

    /** An opponent joined. leader: this page rolls the round seeds. */
    match(leader) {
        this.leader = leader;
        this.matchNo = 0;
        this._clearRemote();
    }

    /** The opponent left: a match in progress is abandoned (the Game Boy resets and links again). */
    unmatch() {
        this._clearRemote();
        if (['start', 'round', 'result'].includes(this.phase)) {
            this.resetTries = RESET_TRIES;
            this._toLink();
        }
    }

    /** Starts the match: player 1 gets ready too. */
    start() {
        if (this.phase !== 'setup' && this.phase !== 'hold') return;
        this.matchNo++;
        this.inMatch = true;
        this.mine = 0;
        this.theirs = 0;
        this.outcome = null;
        this.seeding = 'idle';
        this.queue = this.early.filter((m) => m.n === this.matchNo).flatMap((m) => m.v);
        this.early = [];
        this._setReady(false);
        this._phase('start');
    }

    /** Our Game Boy was reset: link again from its title. */
    relink() {
        this.resetTries = 0;
        this._clearRemote();
        this._toLink();
    }

    onRemote(msg) {
        if (msg.n < this.matchNo) return;
        if (msg.t === 'seed') {
            if (!this.leader) this.seeds.push(msg);
            return;
        }
        if (msg.t !== 'm') return;
        // Their Game Boy may start before ours: keep its bytes for our next match
        if (msg.n > this.matchNo) this.early.push(msg);
        else if (this.phase === 'start' || this._inRound()) this.queue.push(...msg.v);
    }

    /** The byte to clock next. */
    out() {
        if (this.resetTries > 0) {
            this.resetTries--;
            this.last = RESET;
        } else if (this.phase === 'link') {
            this.last = this.answer === ON_TITLE ? LINK : IDLE;
        } else if (this.phase === 'start') {
            this.last = READY;
        } else if (this.phase === 'won') {
            this.last = NEXT;
        } else if (this._inRound() && this.seeding === 'want') {
            this.last = this._seed() ?? IDLE;
        } else if (this._inRound() && this.queue.length) {
            this.last = this.queue.shift();
        } else {
            this.last = IDLE;
        }
        return this.last;
    }

    /** The Game Boy's reply to the last byte. */
    got(byte) {
        this.answer = byte;
        if (byte === null || byte === NO_REPLY) return;
        // It took the reset, or is on its title already
        if (this.resetTries > 0 && (byte === RESET || byte === ON_TITLE)) this.resetTries = 0;
        if (this.phase === 'link') {
            if (this.last === LINK && byte === ON_TITLE) this._toSetup();
            return;
        }
        if (byte === ON_TITLE) {
            const abandoned = this._inRound() || this.phase === 'start';
            this._clearRemote();
            this._toLink();
            if (abandoned) this.onEvent('reset');
            return;
        }
        switch (this.phase) {
        case 'setup':
        case 'hold':
            if (byte === READY) this._toHold();
            else if (isMenu(byte)) this._toSetup();
            return;
        case 'start':
            if (byte === SEED_ASK) this._roundStart();
            return;
        case 'won':
        case 'again':
            // Back in the 2-player menu (0xB1 from the loser leads to its title instead)
            if (isMenu(byte)) this._toSetup();
            return;
        }
        this._roundByte(byte);
    }

    // During a round or on its result screen
    _roundByte(byte) {
        if (byte === IDLE) {
            if (this.phase === 'result' && this.outcome) this._roundOver();
            return;
        }
        if (byte === SEED_ASK) {
            if (this.outcome) this._roundOver();
            if (this.phase === 'result') this._roundStart();
            return;
        }
        if (byte === RESET || byte === LINK) return;
        if (this.seeding === 'done') this.seeding = 'idle';
        if (RESULTS.includes(byte)) {
            this.outcome = byte;
            if (this.phase === 'round') this._phase('result');
        }
        this.send({ t: 'm', v: [byte], n: this.matchNo });
    }

    _roundStart() {
        if (this.seeding === 'idle') this.seeding = 'want';
        if (this.phase !== 'round') this._phase('round');
    }

    // The last result byte our Game Boy sent decides the round
    _roundOver() {
        const outcome = this.outcome;
        this.outcome = null;
        if (outcome === WON) this.mine++;
        else if (outcome === TOPPED_OUT) this.theirs++;
        this.onEvent('round', { mine: this.mine, theirs: this.theirs, won: outcome === WON, draw: outcome === DRAW });
        if (this.mine < MATCH_ROUNDS && this.theirs < MATCH_ROUNDS) return;
        const won = this.mine >= MATCH_ROUNDS;
        this.inMatch = false;
        this.queue = [];
        this.seeding = 'idle';
        this.onEvent('match', { won });
        // The winner goes back to the menu on player 1's 0xB2; the loser's player chooses
        this._phase(won ? 'won' : 'again');
    }

    // Player 1's seed for the round. The leader picks it and sends it to the other page.
    _seed() {
        if (this.leader) {
            const seed = Math.floor(Math.random() * 256);
            this.send({ t: 'seed', v: seed, n: this.matchNo });
            this.seeds.push({ v: seed, n: this.matchNo });
        }
        while (this.seeds.length && this.seeds[0].n < this.matchNo) this.seeds.shift();
        if (!this.seeds.length || this.seeds[0].n !== this.matchNo) return null;
        const seed = this.seeds.shift().v;
        this.seeding = 'done';
        this.queue.unshift(IDLE, SEED_LO + (seed & 0x0F), IDLE, IDLE, IDLE, IDLE, SEED_ASK);
        return SEED_HI + (seed >> 4);
    }

    _inRound() {
        return this.phase === 'round' || this.phase === 'result';
    }

    _clearRemote() {
        this.queue = [];
        this.early = [];
        this.seeds = [];
        this.seeding = 'idle';
    }

    _toLink() {
        this.inMatch = false;
        this.outcome = null;
        this._setReady(false);
        if (this.phase !== 'link') this._phase('link');
    }

    _toSetup() {
        this.inMatch = false;
        this._setReady(false);
        if (this.phase !== 'setup') this._phase('setup');
    }

    _toHold() {
        this._setReady(true);
        if (this.phase !== 'hold') this._phase('hold');
    }

    _setReady(ready) {
        if (this.ready === ready) return;
        this.ready = ready;
        this.onEvent('ready', ready);
    }

    _phase(phase) {
        this.phase = phase;
        this.onEvent('phase', phase);
    }
}
