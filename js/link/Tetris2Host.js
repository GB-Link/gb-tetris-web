/**
 * Tetris 2 link host. The player's Game Boy runs as player 2 and this page
 * plays player 1 for it. The player sets up on the Game Boy before any match;
 * in a match the page uses what the other player's Game Boy sends (that one is
 * player 2 on its own page too).
 *
 * out() returns the next byte to clock (null skips the frame) and got(byte)
 * takes the Game Boy's reply. 0x00 is idle both ways. Player 2 expects a byte
 * every frame and stops after about half a second without one (0xF0 brings it
 * back).
 *
 * Protocol:
 * - Link: the Game Boy answers 0xFD on its title; player 1 clocks 0xFC and the
 *   Game Boy goes to the 1P VS 2P settings screen.
 * - 0xFE is a sync: each side sends it until it receives it. A sync is only
 *   released once ours has sent 0xFE for SETTLE frames in a row. The delay
 *   matters for the loser of a cleared round, whose first sync after the round
 *   must time out after 8 frames as it does on a cable. In a match a sync also
 *   waits for the other Game Boy to reach it, except those before the score
 *   screen (below).
 * - Settings: after the first sync each side sends speed + 1, round + 1 and
 *   music + 1, at once. Player 1's speed and round are page defaults (player 2
 *   only shows them) and the music is the page's. On the screen player 1 sends
 *   0xnF (cursor row: 0 speed, 1 round, 2 music), 0x3n (music: A, B, C, off),
 *   0x2n (its round), 0x7E (start) and 0x7F (quit). Player 2 can't move the
 *   row; LEFT and RIGHT change its own value on rows 0 and 1 and send 0x1n
 *   (speed) or 0x2n (round). It sends nothing when its player is done.
 * - Player 2's three settings bytes come in consecutive frames, while it is busy
 *   drawing the screen, and on the adapter one can get lost. Then player 1 quits
 *   (0x7F, one sync; player 2 answers 0x7D, saves its values and goes back to
 *   its title) and links again.
 * - Match start: the row goes to music, so player 2 can't change its values any
 *   more, and the pages swap their players' final rounds. Player 1 then sends
 *   0x20 + the other player's round and 0x7E. Player 1's round decides how
 *   often special pieces come, for both Game Boys, so each needs the other's.
 *   Player 2 saves its own values when the sync after 0x7E is released.
 * - Round start: after the seed sync player 2 reads the next two bytes as the
 *   round seed (it ignores the third). The leader's page rolls it for both. The
 *   PUSH START sync and the last score screen sync wait for the leader's page,
 *   which lets them go after a pause, where player 1 would press START.
 * - During a round both sides send the same kind of data (stack, score,
 *   attacks). 0xE9 means topped out, 0xE8 cleared all blocks. A Game Boy stops
 *   taking the other's end byte some time after its own (about 2 s after a
 *   clear), so when both end at about the same time either can happen. After
 *   a cleared round the winner may do one sync and the loser one or two (the
 *   first times out) before the score screen; whether they do depends on that
 *   timing, so these syncs are released without the other Game Boy. They come
 *   before 0x03 (a new screen); the score screen then has two shared syncs.
 *   Three round wins take the match and the last score screen sync goes back
 *   to the settings, which start again with the first sync.
 * - 0xF0 is player 1's soft reset: player 2 goes back to its title (about 6 s)
 *   and is linked again. That is how a match is left.
 *
 * Messages to and from the other page (only during a match):
 *   { t: 'set', round }     our player's own round, whenever it changes
 *   { t: 'lock', round }    our player's final round as a match starts
 *   { t: 'sync', k }        our Game Boy is at sync k
 *   { t: 'seed', k, v }     the leader's seed for sync k
 *   { t: 'pass', k }        the leader lets the PUSH START / score sync k go
 *   { t: 'm', r, v }        bytes our Game Boy sent in round r
 */
const IDLE = 0x00;
const LINK = 0xFC;
const ON_MENU = 0xFD;
const SYNC = 0xFE;
const CONFIRM = 0x7E;
const QUIT = 0x7F;
const RESET = 0xF0;
const TOPPED_OUT = 0xE9;
const CLEARED = 0xE8;
// Player 1's speed and round on the settings screen
const DEFAULTS = { speed: 1, round: 4 };
const MUSIC_ROW = 2;
const WIN_ROUNDS = 3;
// 0xFE replies in a row before a sync is released (the game's shortest sync timeout is 8)
const SETTLE = 10;
// 0xFE bytes sent to release a sync. The game checks the last byte it received once a
// frame, so in a slow frame a single 0xFE could be overwritten by the next byte.
const PASS_SYNCS = 3;
// Replies right after a release that may still be 0xFE: the Game Boy replies with what
// it set up a frame earlier and can see our 0xFE up to two frames late
const STALE = 4;
// 0xFE replies again within this many bytes of a release mean the Game Boy missed it
const PASS_WINDOW = 16;
// Replies after the first sync's release within which player 2's three settings bytes come
const ENTRY_REPLIES = 10;
// Frames after the row moved to music in which a change made just before can still come
const LOCK_FRAMES = 6;
// Frames the leader's page waits at the PUSH START and score screen syncs
const GO_FRAMES = { push: 90, next: 150 };
// Frames from the release of the sync after 0x7E to the reset, when leaving then
const LEAVE_FRAMES = 10;
// Right after the link the Game Boy can still answer 0xFD once (its title re-armed it)
const LINK_GRACE = 30;
// 0xF0 again if the Game Boy isn't back on its title after this many frames
const RESET_RETRY = 600;
// Sync sequences. 'plain' syncs only wait for the other Game Boy.
const AFTER_CONFIRM = ['plain', 'seed', 'plain', 'push'];
const NEXT_ROUND = ['seed', 'plain', 'push'];
const AFTER_ROUND = ['plain', 'next'];
// Player 2 sends this when it switches screens
const NEW_SCREEN = 0x03;

const rowByte = (row) => (row << 4) | 0x0F;
// Seed byte the way the game makes them: never idle or a control byte
const seedByte = () => (Math.floor(Math.random() * 256) & 0xDF) + 1;

export class Tetris2Host {
    /**
     * send(msg): sends to the other page. music: 0-3 (A, B, C, off).
     * onEvent(name, data):
     *   'phase'  link, settings, start, push, round, score, next, leave
     *   'ready'  true while the Game Boy is on the settings screen and a match can start
     *   'round'  { won, mine, theirs } once a round is decided
     *   'match'  { won } when a match is over
     *   'reset'  the Game Boy left a match by itself (back on its title, or stopped)
     */
    constructor({ send, onEvent = () => {}, music = 0 }) {
        this.send = send;
        this.onEvent = onEvent;
        this.music = music;
        this.row = 0;
        this.leader = false;
        this.matched = false;
        this.startWhenReady = false;
        this.ready = false;
        this.inMatch = false;
        this.mine = { ...DEFAULTS };
        this.answer = null;
        this.last = IDLE;
        this.clock = 0;
        this.linkedAt = 0;
        this.resetFrames = 0;
        this._clearRemote();
        this._reset();
        this._phase('link');
    }

    /** True from start() until the match is over or left and the Game Boy is back on the settings. */
    get playing() {
        return this.inMatch;
    }

    /** An opponent joined. leader: this page rolls the round seeds and lets the rounds go on. */
    match(leader) {
        this.leader = leader;
        this.matched = true;
        this.startWhenReady = false;
        this._clearRemote();
        if (this.entered) this._tell({ t: 'set', round: this.mine.round });
    }

    /** The opponent left or their Game Boy was reset. A match in progress is left. */
    unmatch() {
        this._clearRemote();
        this.matched = false;
        this.startWhenReady = false;
        this.leader = false;
        if (!this.inMatch || this.phase === 'leave') return;
        // Still on the settings screen: undo the start
        const i = this.queue.indexOf(CONFIRM);
        if (this.confirmed === null || i >= 0) {
            if (i >= 0) {
                const from = i > 0 && (this.queue[i - 1] & 0xF0) === 0x20 ? i - 1 : i;
                this.queue.splice(from, i - from + 1);
            }
            this.confirmed = null;
            this.locking = null;
            this.inMatch = false;
            this.queue.push(rowByte(this.row));
            this._phase('settings');
            this._updateReady();
            return;
        }
        // Player 2 saves its values at the sync after 0x7E: that one goes first
        const started = this.syncs > this.confirmed + 1 || (this.syncs === this.confirmed + 1 && !this.waiting);
        if (started) this.leaveIn = 1;
        else this.leaving = true;
    }

    /**
     * Starts the match (both pages, while both are ready), or as soon as our Game Boy is
     * back on the settings screen if it just left it. Waits for the other page's round.
     */
    start() {
        if (!this.matched) return false;
        if (!this.ready) {
            this.startWhenReady = true;
            return true;
        }
        this.startWhenReady = false;
        this.inMatch = true;
        this.locking = { at: null, told: false };
        this.queue.push(rowByte(MUSIC_ROW));
        this._phase('start');
        this._updateReady();
        return true;
    }

    /** Links again once the Game Boy is back on its title (it was reset). */
    relink() {
        // A start waiting for our Game Boy keeps the other page's round
        if (this.inMatch) this.theirLock = null;
        this.inMatch = false;
        this.seeds = {};
        this.rounds = {};
        this.goes = new Set();
        this.theirSync = 0;
        this._reset();
        this._phase('link');
        this._updateReady();
    }

    /**
     * The page couldn't clock for longer than half a second (on the adapter, a tab in the
     * background): the Game Boy has stopped and is reset to its title.
     */
    clockLost() {
        if (this.phase === 'link' || this.phase === 'leave') return;
        const playing = this.inMatch;
        this._leave();
        if (playing) this.onEvent('reset');
    }

    /** The settings row the player changes on the Game Boy: 0 speed, 1 round. */
    setRow(row) {
        this.row = row;
        if (this.entered && !this.inMatch) this.queue.push(rowByte(row));
    }

    /** 0-3: A, B, C, off. */
    setMusic(music) {
        this.music = music;
        if (this.entered && !this.inMatch) this.queue.push(0x30 | music);
    }

    onRemote(msg) {
        if (!this.matched) return;
        switch (msg.t) {
        case 'set':
            this.theirRound = msg.round;
            break;
        case 'lock':
            this.theirRound = msg.round;
            this.theirLock = msg.round;
            break;
        case 'sync':
            this.theirSync = msg.k;
            break;
        case 'seed':
            this.seeds[msg.k] = msg.v;
            break;
        case 'pass':
            this.goes.add(msg.k);
            break;
        case 'm':
            if (msg.r < this.round) break;
            (this.rounds[msg.r] = this.rounds[msg.r] || []).push(...msg.v);
            this._deliver();
            break;
        }
    }

    /**
     * The next byte to clock, or null to skip a frame. One frame is skipped before
     * each sync release so the game is waiting for our byte when it comes. After a
     * stretch with the screen off it can still be holding one, and a frame without a
     * byte then loses what it was about to send. In a sync it has nothing to send.
     */
    out() {
        this.clock++;
        if (this.leaveIn !== null && --this.leaveIn <= 0) this._leave();
        if (this.phase === 'link' || this.phase === 'leave' || this.linking) {
            if (this.phase === 'leave' && this.resetFrames++ % RESET_RETRY === 0) this.last = RESET;
            else this.last = this.answer === ON_MENU ? LINK : IDLE;
            return this.last;
        }
        if (this.locking) this._starting();
        if (this.leader) this._leaderGo();
        if (this.waiting && this.settled >= SETTLE && this._mayPass()) {
            if (!this.skipped) {
                this.skipped = true;
                return null;
            }
            this.last = this._pass();
        } else if (this.waiting) this.last = IDLE;
        else this.last = this.queue.length ? this.queue.shift() : IDLE;
        if (this.locking && this.locking.at === null && this.last === rowByte(MUSIC_ROW)) this.locking.at = this.clock;
        return this.last;
    }

    /** The Game Boy's reply to the last byte (null: none). */
    got(byte) {
        this.answer = byte;
        if (this.phase === 'link' || this.phase === 'leave' || this.linking) {
            if (this.last === LINK && byte === ON_MENU) {
                this._reset();
                this.linkedAt = this.clock;
                this.inMatch = false;
                this._phase('settings');
                this._updateReady();
            }
            return;
        }
        if (byte === ON_MENU) {
            if (this.clock - this.linkedAt <= LINK_GRACE) return;
            // Back on its title after our quit: link again, still on the settings
            if (this.quitting) {
                this._reset();
                this.linking = true;
                return;
            }
            const playing = this.inMatch;
            this.relink();
            if (playing) this.onEvent('reset');
            return;
        }
        if (this.passed && this._afterPass(byte)) return;
        if (this.collect && ++this.collected > ENTRY_REPLIES) this._quit();
        if (byte === SYNC) {
            if (!this.waiting) this._atSync();
            this.settled++;
            return;
        }
        this.settled = 0;
        if (byte === IDLE || byte === null || byte >= 0xF8) return;
        this._fromGameBoy(byte);
    }

    _tell(msg) {
        if (this.matched) this.send(msg);
    }

    _clearRemote() {
        this.theirSync = 0;
        this.theirRound = null;
        this.theirLock = null;
        this.seeds = {};
        this.rounds = {};
        this.goes = new Set();
    }

    _reset() {
        this.queue = [];
        this.syncs = 0;
        this.waiting = false;   // held at a sync
        this.settled = 0;       // 0xFE replies in a row while held
        this.skipped = false;   // the empty frame before a release went out
        this.passed = null;     // replies since the last release
        this.script = ['entry'];
        this.kind = null;
        this.collect = null;    // our settings bytes after the first sync
        this.collected = 0;     // replies since the first sync's release
        this.quitting = false;  // we quit to redo the settings bytes
        this.linking = false;   // linking again after that quit
        this.entered = false;   // on the settings screen, past the first sync
        this.locking = null;    // match start: row moved to music, rounds being swapped
        this.confirmed = null;  // sync count when 0x7E was queued
        this.leaving = false;   // leave once the sync after 0x7E is released
        this.leaveIn = null;    // frames until the reset
        this.goWait = 0;        // leader: frames both Game Boys have waited at a go sync
        this.round = 0;
        this.open = false;      // round data goes both ways until the first sync after it
        this.ended = null;      // 'own' if our Game Boy ended the round, 'theirs' if their end byte did
        this.screen = false;    // the Game Boy went on to the score screen
        this.won = null;
        this.wins = { mine: 0, theirs: 0 };
    }

    _updateReady() {
        const ready = this.phase === 'settings' && this.entered && !this.inMatch;
        if (ready === this.ready) return;
        this.ready = ready;
        this.onEvent('ready', ready);
        if (ready && this.startWhenReady) this.start();
    }

    // Match start: once the row has been on music for a moment our round is final.
    // Then 0x20 + theirs and 0x7E as soon as theirs is known.
    _starting() {
        const lock = this.locking;
        if (!lock.told && lock.at !== null && this.clock - lock.at >= LOCK_FRAMES) {
            lock.told = true;
            this._tell({ t: 'lock', round: this.mine.round });
        }
        if (!lock.told || this.theirLock === null) return;
        this.queue.push(0x20 | this.theirLock, CONFIRM);
        this.confirmed = this.syncs;
        this.script = AFTER_CONFIRM.slice();
        this.locking = null;
        this.theirLock = null;
    }

    // Leader: where player 1 would press START, both Game Boys go on after a pause
    _leaderGo() {
        const at = this.waiting && (this.kind === 'push' || this.kind === 'next') && this.matched
            && this.theirSync >= this.syncs && !this.goes.has(this.syncs);
        if (!at) {
            this.goWait = 0;
            return;
        }
        if (++this.goWait < GO_FRAMES[this.kind]) return;
        this.goes.add(this.syncs);
        this._tell({ t: 'pass', k: this.syncs });
    }

    // Player 2's settings bytes didn't all come: quit to the title and link again
    _quit() {
        this.collect = null;
        this.quitting = true;
        this.script = ['quit'];
        this.queue.push(QUIT);
    }

    // Soft reset: the Game Boy goes back to its title and is linked again from there
    _leave() {
        this._reset();
        this.resetFrames = 0;
        this._phase('leave');
        this._updateReady();
    }

    // The Game Boy reached a sync: work out which one and tell the other page
    _atSync() {
        this.waiting = true;
        this.settled = 0;
        this.skipped = false;
        if (this.phase === 'score') {
            this.open = false;
            // Syncs before the score screen are ours alone, then the score screen's two
            if (!this.screen) this.kind = 'local';
            else if (!this.script) this.script = AFTER_ROUND.slice();
        }
        if (this.phase !== 'score' || this.screen) this.kind = this.script && this.script.length ? this.script.shift() : 'plain';
        if (this.kind === 'local') return;
        if (this.kind === 'entry') {
            // Counting starts again at the settings, on both pages
            this.syncs = 0;
            this.round = 0;
            this.theirSync = 0;
            this.seeds = {};
            this.rounds = {};
            this.goes.clear();
            this.entered = false;
            this._updateReady();
        }
        this.syncs++;
        if (this.kind === 'entry' || this.kind === 'quit') return;
        this._tell({ t: 'sync', k: this.syncs });
        if (this.kind === 'seed' && this.leader) {
            // Player 2 ignores the third byte
            const seed = [seedByte(), seedByte(), 0x03];
            this.seeds[this.syncs] = seed;
            this._tell({ t: 'seed', k: this.syncs, v: seed });
        }
        if (this.kind === 'push' || this.kind === 'next') this._phase(this.kind);
        else if (this.kind === 'seed' && this.phase === 'next') this._phase('start');
    }

    _mayPass() {
        // The settings' first sync, a quit and the syncs before a score screen are between
        // our Game Boy and this page only
        if (this.kind === 'entry' || this.kind === 'quit' || this.kind === 'local') return true;
        if (this.leaving && this.syncs === this.confirmed + 1) return true;
        if (!this.matched || this.theirSync < this.syncs) return false;
        switch (this.kind) {
        case 'seed': return !!this.seeds[this.syncs];
        case 'push':
        case 'next': return this.goes.has(this.syncs);
        default: return true;
        }
    }

    // Release the sync: 0xFE, then player 1's data for it, then whatever was queued meanwhile
    _pass() {
        const kind = this.kind;
        let data = [];
        this.waiting = false;
        this.settled = 0;
        this.goes.delete(this.syncs);
        if (kind === 'entry') {
            this.collect = [];
            this.collected = 0;
            data = [DEFAULTS.speed + 1, DEFAULTS.round + 1, this.music + 1, rowByte(this.row)];
        } else if (kind === 'seed') {
            data = this.seeds[this.syncs];
        }
        if (this.leaving && this.syncs === this.confirmed + 1) {
            this.leaving = false;
            this.leaveIn = LEAVE_FRAMES;
        }
        const lead = new Array(PASS_SYNCS - 1).fill(SYNC);
        this.queue = [...lead, ...data, ...this.queue];
        this.passed = { answers: 0, front: lead.length + data.length, direct: 1, data };
        if (kind === 'push') {
            this.round++;
            this.open = true;
            this.ended = null;
            this.screen = false;
            this.won = null;
            this._phase('round');
            this._deliver();
        } else if (kind === 'next') {
            if (Math.max(this.wins.mine, this.wins.theirs) >= WIN_ROUNDS) this._matchOver();
            else this.script = NEXT_ROUND.slice();
        }
        return SYNC;
    }

    // Replies after a release. The first few may still be 0xFE. More 0xFE after that means
    // the Game Boy missed the release (the next byte came in first), so it is sent again
    // and the unsent rest of the first one is dropped. Returns true if the reply was used.
    _afterPass(byte) {
        const p = this.passed;
        if (++p.answers > PASS_WINDOW) {
            this.passed = null;
            return false;
        }
        if (byte !== SYNC) return false;
        if (p.answers > STALE) {
            // The release queued p.front bytes and each reply is for one byte sent
            // (the first release's own 0xFE wasn't queued)
            this.queue.splice(0, Math.max(0, p.front - (p.answers - p.direct)));
            const again = [...new Array(PASS_SYNCS).fill(SYNC), ...p.data];
            this.queue.unshift(...again);
            this.passed = { answers: 0, front: again.length, direct: 0, data: p.data };
            if (this.collect) {
                this.collect = [];
                this.collected = 0;
            }
        }
        return true;
    }

    _fromGameBoy(byte) {
        if (this.collect) {
            this.collect.push(byte);
            if (this.collect.length < 3) return;
            const [speed, round, music] = this.collect;
            this.collect = null;
            // One was lost and a later byte took its place
            if (speed > 3 || round > 15 || music > 4) {
                this._quit();
                return;
            }
            this.mine = { speed: speed - 1, round: round - 1 };
            this.entered = true;
            this._tell({ t: 'set', round: this.mine.round });
            this._updateReady();
            return;
        }
        switch (this.phase) {
        case 'start':
            // A change made just before the row moved to music
            if (this.confirmed !== null) break;
            // falls through
        case 'settings':
            if ((byte & 0xF0) === 0x10) {
                this.mine.speed = byte & 0x03;
            } else if ((byte & 0xF0) === 0x20 && (byte & 0x0F) !== this.mine.round) {
                this.mine.round = byte & 0x0F;
                this._tell({ t: 'set', round: this.mine.round });
            }
            break;
        case 'round':
        case 'score':
            if (this.phase === 'score' && byte === NEW_SCREEN) this.screen = true;
            if (!this.open) break;
            this._tell({ t: 'm', r: this.round, v: [byte] });
            // Our Game Boy ended the round itself (a top-out repeats 0xE9)
            if ((byte === CLEARED || byte === TOPPED_OUT) && this.ended !== 'own') {
                this.ended = 'own';
                this._roundOver(byte === CLEARED);
            }
            break;
        }
    }

    _matchOver() {
        const won = this.wins.mine >= WIN_ROUNDS;
        this.script = ['entry'];
        this.wins = { mine: 0, theirs: 0 };
        this.confirmed = null;
        this.inMatch = false;
        this.entered = false;
        this.theirLock = null;
        this._phase('settings');
        this._updateReady();
        this.onEvent('match', { won });
    }

    // Their bytes for the round ours is playing. Their end byte ends our round unless
    // ours already ended it; taking a second end byte would make it a draw.
    _deliver() {
        for (const r of Object.keys(this.rounds)) if (+r < this.round) delete this.rounds[r];
        const bytes = this.rounds[this.round];
        if (!this.open || !bytes || !bytes.length) return;
        delete this.rounds[this.round];
        for (const byte of bytes) {
            if (byte === CLEARED || byte === TOPPED_OUT) {
                if (this.ended) continue;
                this.ended = 'theirs';
                this._roundOver(byte === TOPPED_OUT);
            }
            this.queue.push(byte);
        }
    }

    // The round is decided for our Game Boy. Its own end byte can arrive after theirs
    // was queued (it ended the round before taking theirs), and then it wins out.
    _roundOver(won) {
        if (this.phase === 'round') {
            this.wins[won ? 'mine' : 'theirs']++;
        } else if (this.phase === 'score' && this.won !== won && this.script === null) {
            this.wins[this.won ? 'mine' : 'theirs']--;
            this.wins[won ? 'mine' : 'theirs']++;
        } else {
            return;
        }
        this.won = won;
        this.script = null;
        this._phase('score');
        this.onEvent('round', { won, ...this.wins });
    }

    _phase(phase) {
        if (this.phase === phase) return;
        this.phase = phase;
        this.onEvent('phase', phase);
    }
}
