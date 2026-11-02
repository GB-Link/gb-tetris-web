import { BlastHost } from './BlastHost.js';
import { Tetris2Host } from './Tetris2Host.js';
import { AttackHost, ATTACK_MUSIC } from './AttackHost.js';
import { PlusHost } from './PlusHost.js';

const HOSTS = { blast: BlastHost, tetris2: Tetris2Host, attack: AttackHost, plus: PlusHost };
const TITLES = { tetris: 'Tetris', dx: 'Tetris DX', attack: 'Tetris Attack', plus: 'Tetris Plus', blast: 'Tetris Blast', tetris2: 'Tetris 2' };
// Page controls: the settings row Tetris 2 changes on the Game Boy, and the music player 1 picks
const ROWS = { tetris2: true };
const MUSIC = {
    tetris2: ['MUSIC A', 'MUSIC B', 'MUSIC C', 'MUSIC OFF'].map((label, value) => ({ value, label })),
    attack: ATTACK_MUSIC,
};
// What the player does on the Game Boy at each step of the host
const STEPS = {
    blast: {
        setup: 'Pick your stage and level on the Game Boy, then press A.',
        hold: 'Ready. Press B on the Game Boy to change your stage or level.',
        start: 'The match is starting...',
        round: 'Playing against {other}.',
        result: 'Round over. Press A on the Game Boy for the next round.',
        won: 'Your Game Boy goes back to its menu...',
        again: 'Choose Yes on the Game Boy to play again.',
    },
    tetris2: {
        settings: (host) => (host.ready
            ? 'Pick your speed and round on the Game Boy with LEFT and RIGHT. Choose the row and the music here.'
            : 'Your Game Boy is going to the settings...'),
        start: 'The match is starting...',
        push: 'The round starts in a moment...',
        round: 'Playing against {other}.',
        score: (host, score) => (score && score.won ? 'You won the round!' : '{other} won the round.'),
        next: 'Next round coming up...',
        leave: 'Leaving the match: your Game Boy goes back to its title, then to the settings.',
    },
    attack: {
        level: 'Pick your level on the Game Boy and press A.',
        stage: 'Pick your stage on the Game Boy and press A.',
        hold: 'Ready. Press B on the Game Boy to change your stage.',
        confirm: 'Press A on the Game Boy to start the match.',
        start: 'The round is about to start...',
        round: 'Playing against {other}.',
        result: 'Round over. Press A on the Game Boy to go on.',
        abandon: 'Finishing the match on your Game Boy...',
    },
    plus: {
        size: 'Setting up a 2-player match...',
        level: 'Pick your level on the Game Boy and press A.',
        hold: 'Ready.',
        start: 'The match is starting...',
        seed: 'The match is starting...',
        round: 'Playing against {other}.',
        roundOver: (host) => (host.playing ? 'Round over. Waiting for {other}...' : ''),
        next: 'Next round coming up...',
        matchOver: 'Match over. Press A on the Game Boy to go on.',
        quit: 'Your Game Boy shows its title for a moment, then the level screen.',
    },
};
// Adapter pace: one byte per Game Boy frame, slightly slower than the Game Boy so it never
// falls behind. Two bytes within one frame make the game drop one of its own.
const BYTE_MS = (1000 / 59.7275) * 1.002;
// setTimeout fires late, so the last few ms before each byte are busy-waited
const SPIN_MS = 2;
// A longer gap between bytes (a page in the background) stalls some games' link
const CLOCK_LOST_MS = 500;
// Matchmaking: the first match starts by itself this long after both Game Boys are ready
const AUTO_START_MS = 1500;

const $ = (id) => document.getElementById(id);

export class LinkedGame {
    /**
     * app: the page (js/app.js). serial: the link to the Game Boy (adapter or
     * emulator). info: from identifyTetris(). emulator: the GameBoyEmulator when
     * the game runs in the page, which is then clocked in step with its frames.
     */
    constructor(app, serial, info, emulator = null) {
        this.app = app;
        this.serial = serial;
        this.emulator = emulator;
        this.kind = info.link;
        this.title = TITLES[this.kind];
        this.gb = null;
        this.host = null;
        this.matchmaking = false;
        this.opponent = null;
        this.left = null;
        this.ended = false;
        this.theirReady = false;
        this.inMatch = false;
        this.played = false;
        this.score = null;
        this.result = null;
        this.running = false;
        this.row = 0;
        this.music = MUSIC[this.kind] ? MUSIC[this.kind][0].value : 0;
        this._buildMusic();
        this._start();
    }

    get leader() {
        return !!(this.gb && this.gb.admin);
    }

    findMatch(name) {
        this.open(GBWebsocket.findMatch(name, this.kind), true);
        this.app.setState(this.app.StateMatchmaking);
    }

    create(name) {
        this.open(GBWebsocket.initiateGame(name, this.kind), false);
        this.app.setState(this.app.StateJoiningGame);
    }

    join(name, code) {
        this.open(GBWebsocket.joinGame(name, code, this.kind), false);
        this.app.setState(this.app.StateJoiningGame);
    }

    /** Leaves the lobby or the queue. The Game Boy stays linked and set up. */
    close() {
        if (this.gb) {
            this.gb._closedByUs = true;
            if (this.matchmaking && this.gb.ws.readyState === 1 && !this.opponent) this.gb.cancelMatchmaking();
            else this.gb.ws.close();
        }
        if (this.opponent) this._unmatch();
        this.gb = null;
        this.opponent = null;
        this.left = null;
    }

    dispose() {
        this.close();
        this._stop();
    }

    open(gb, matchmaking) {
        this.close();
        this.gb = gb;
        this.matchmaking = matchmaking;
        this.ended = false;
        gb.onconnected = () => {};
        gb.onuserinfo = () => {
            if (!gb.relay) this.fail(`The game server doesn't support ${this.title} yet.`);
        };
        gb.oninfoupdate = () => this.update();
        gb.onmatchfound = () => this.update();
        gb.onrelay = (_, data) => this.onRemote(data);
        gb.onerror = (_, message) => this.error(message);
        gb.onopponentdisconnect = () => this.gone();
        // Unused by linked games
        for (const name of ['ongamestart', 'ongameupdate', 'ongameend', 'onlines', 'onwin', 'onlose', 'onplayerready', 'oncountdownstarted']) gb[name] = () => {};
    }

    // The lobby changed: who's in it, who leads
    update() {
        const gb = this.gb;
        // Matchmaking: who leads comes with the lobby info that follows the match
        if (!gb || gb.game_status === gb.GAME_STATE_NONE) return;
        const opponent = gb.users.find((u) => u.uuid !== gb.uuid) || null;
        if ((opponent && opponent.uuid) !== (this.opponent && this.opponent.uuid)) {
            if (this.opponent) {
                this.left = this.opponent.name;
                this._unmatch();
            }
            this.opponent = opponent;
            this.played = false;
            this.score = null;
            this.result = null;
            if (opponent) {
                this.left = null;
                this.host.match(this.leader);
                this._sendReady();
            }
        }
        this.app.setState(this.app.StateLinked);
        this._autoStart();
        this.render();
    }

    /** Our Game Boy was reset: it links again and the player sets up again. */
    restarted() {
        if (!this.host) return;
        this.host.relink();
        this._left();
        this.render();
    }

    // The server closed the game (matched opponent left) or the connection dropped
    gone() {
        if (!this.gb) return;
        const name = this.opponent ? this.opponent.name : null;
        const matchmaking = this.matchmaking;
        this.close();
        this.matchmaking = matchmaking;
        this.left = name;
        this.ended = true;
        this.app.setState(this.app.StateLinked);
        this.render();
    }

    error(message) {
        const text = {
            'Game not found.': 'Lobby not found. Please check the code and try again.',
            'Wrong game.': `That lobby plays ${TITLES[this.gb && this.gb.errorGame] || 'another game'}.`,
            'Lobby is full.': 'That lobby already has two players.',
        }[message];
        if (!text) {
            this.fail(message);
            return;
        }
        this.close();
        this.app.setState(this.app.StateSelectHandicap);
        const joinError = $('join-error');
        joinError.textContent = text;
        joinError.style.display = 'block';
    }

    fail(message) {
        this.close();
        $('error-message').textContent = message;
        this.app.setState(this.app.StateError);
    }

    // ---- Player 1 for our Game Boy ----

    _start() {
        const host = new HOSTS[this.kind]({
            send: (msg) => this.opponent && this.gb && this.gb.sendRelay(msg),
            onEvent: (name, data) => this._onHost(name, data),
            music: this.music,
        });
        if (host.setRow) host.setRow(this.row);
        this.host = host;
        this.running = true;
        if (host.attach) {
            // The game drives the clock too, so the host becomes the emulator's link partner
            if (this.emulator) this.emulator.setLinkPartner(host.attach(this.emulator.linkPort()));
        } else if (this.emulator) {
            const port = this.emulator.linkPort();
            this.emulator.setLinkPartner({
                step() {},
                frame: () => {
                    const out = host.out();
                    if (out !== null) host.got(port.exchange(out));
                },
            });
        } else {
            this._pump(host);
        }
    }

    _stop() {
        this.running = false;
        this.host = null;
        clearTimeout(this._autoTimer);
        if (this.emulator) this.emulator.setLinkPartner(null);
    }

    // Adapter: one byte per frame to the Game Boy, its reply back to the host
    async _pump(host) {
        let last = performance.now();
        while (this.running && this.host === host) {
            const sent = performance.now();
            if (sent - last > CLOCK_LOST_MS && host.clockLost) host.clockLost();
            last = sent;
            const out = host.out();
            if (out !== null) {
                try {
                    await this.serial.send(new Uint8Array([out]));
                    const reply = await this.serial.read(64);
                    if (this.host !== host) return;
                    host.got(reply.data.getUint8(0));
                } catch (e) {
                    if (!this.serial.ready) return;
                }
            }
            const next = sent + BYTE_MS;
            const wait = next - performance.now() - SPIN_MS;
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            while (performance.now() < next);
        }
    }

    // The opponent left or their Game Boy was reset: a match in progress is abandoned
    _unmatch() {
        this.inMatch = false;
        this.theirReady = false;
        clearTimeout(this._autoTimer);
        if (this.host) this.host.unmatch();
    }

    _sendReady() {
        if (this.gb && this.opponent) this.gb.sendRelay({ t: 'ready', v: !!(this.host && this.host.ready) });
    }

    onRemote(msg) {
        if (!this.opponent) return;
        switch (msg.t) {
        case 'ready':
            this.theirReady = msg.v;
            this._autoStart();
            this.render();
            return;
        case 'go':
            this._begin();
            return;
        case 'restart':
            this._rematch();
            this.render();
            return;
        }
        if (this.host) this.host.onRemote(msg);
    }

    _onHost(name, data) {
        if (name === 'ready') {
            this._sendReady();
            this._autoStart();
        }
        if (name === 'round') this.score = data;
        if (name === 'match') {
            this.result = data;
            this.inMatch = false;
            this.played = true;
        }
        if (name === 'reset' || (name === 'phase' && data === 'link')) this._left();
        // A match that ended without a result (a player backed out as it started)
        else if (name === 'phase' && this.inMatch && !this.host.playing) this.inMatch = false;
        this.render();
    }

    // Our Game Boy left a match (reset or switched off): the other one leaves it too
    _left() {
        if (!this.inMatch || !this.opponent) return;
        this.gb.sendRelay({ t: 'restart' });
        this._rematch();
    }

    // A match ended early: both pages start again from the same point with the same opponent
    _rematch() {
        this._unmatch();
        if (this.host) this.host.match(this.leader);
        this._sendReady();
    }

    get canStart() {
        return !!(this.leader && this.opponent && this.host && this.host.ready && !this.host.playing && !this.inMatch && this.theirReady);
    }

    // Matchmaking: the leader's page starts the first match once both are ready
    _autoStart() {
        clearTimeout(this._autoTimer);
        if (!this.matchmaking || this.played || !this.canStart) return;
        this._autoTimer = setTimeout(() => this.startMatch(), AUTO_START_MS);
    }

    /** Leader only: starts a match on both Game Boys. */
    startMatch() {
        if (!this.canStart) return;
        clearTimeout(this._autoTimer);
        this.gb.sendRelay({ t: 'go' });
        this._begin();
    }

    _begin() {
        this.inMatch = true;
        this.score = null;
        this.result = null;
        if (this.host) this.host.start();
        this.render();
    }

    /** Tetris 2: the settings row the player changes on the Game Boy, 0 speed, 1 round. */
    setRow(row) {
        this.row = row;
        if (this.host && this.host.setRow) this.host.setRow(row);
        this.render();
    }

    setMusic(music) {
        this.music = music;
        if (this.host && this.host.setMusic) this.host.setMusic(music);
        this.render();
    }

    // ---- Screen ----

    _buildMusic() {
        const box = $('linked-music');
        box.innerHTML = '';
        for (const { value, label } of MUSIC[this.kind] || []) {
            const button = document.createElement('button');
            button.className = 'musicButton btn btn-lg btn-secondary';
            button.textContent = label;
            button.dataset.music = value;
            button.addEventListener('click', () => this.setMusic(value));
            box.appendChild(button);
        }
    }

    render() {
        if (this.app.currentState === this.app.StateLinkedSetup) this._renderSetup();
        else if (this.app.currentState === this.app.StateLinked) this._renderLobby();
    }

    // The setup controls move to the screen that shows them
    _renderControls(screen, show) {
        const controls = $('linked-controls');
        const slot = $(screen).querySelector('.linked-controls-slot');
        if (controls.parentNode !== slot) slot.appendChild(controls);
        controls.style.display = show && (ROWS[this.kind] || MUSIC[this.kind]) ? 'block' : 'none';
        $('linked-rows').style.display = ROWS[this.kind] ? 'block' : 'none';
        $('linked-music-picker').style.display = MUSIC[this.kind] ? 'block' : 'none';
        $('btn-linked-speed').classList.toggle('active', this.row === 0);
        $('btn-linked-round').classList.toggle('active', this.row === 1);
        for (const button of $('linked-music').children) button.classList.toggle('active', +button.dataset.music === this.music);
    }

    _renderSetup() {
        $('linked-setup-heading').textContent = `${this.title} connected`;
        $('linked-setup-status').textContent = this._step();
        this._renderControls('screen-linked-setup', true);
        $('btn-linked-next').disabled = !(this.host && this.host.ready);
    }

    _renderLobby() {
        const gb = this.gb;
        $('linked-heading').textContent = !gb && this.ended ? this.title
            : this.matchmaking ? `${this.title}: matched` : `${this.title}: lobby ${gb ? gb.game_name : ''}`;
        const players = $('linked-players');
        players.innerHTML = '';
        for (const user of gb ? gb.users : []) {
            const li = document.createElement('li');
            li.textContent = user.uuid === gb.uuid ? `${user.name} (you)` : user.name;
            players.appendChild(li);
        }
        const [status, note] = this.describe();
        $('linked-status').textContent = status;
        $('linked-note').textContent = note;
        const between = !!(gb && this.opponent && this.host && !this.host.playing && !this.inMatch);
        this._renderControls('screen-linked', between);
        const start = $('btn-linked-start');
        start.style.display = between && this.leader && (this.played || !this.matchmaking) ? 'inline-block' : 'none';
        start.textContent = this.played ? 'Play again' : 'Start the match';
        start.disabled = !this.canStart;
        $('linked-again').style.display = !gb && this.ended && this.matchmaking ? 'inline-block' : 'none';
        $('btn-leave-linked').textContent = gb ? 'Leave Lobby' : 'Back to Menu';
    }

    // What the player does now on the Game Boy
    _step(other = 'the other player') {
        const host = this.host;
        if (!host) return '';
        if (host.phase === 'link') return `Linking... leave your Game Boy on ${this.title}'s title screen.`;
        let step = STEPS[this.kind][host.phase];
        if (typeof step === 'function') step = step(host, this.score);
        if (step) return step.replace('{other}', other);
        return host.playing ? `Playing against ${other}.` : '';
    }

    describe() {
        const other = this.opponent ? this.opponent.name : null;
        // With nobody to play, still say what to do on the Game Boy
        const step = this.host && !this.host.ready ? this._step() : '';
        if (!this.gb) return [this.left ? `${this.left} left the game.` : 'The connection to the game server was lost.', step];
        if (!other) {
            return [this.left ? `${this.left} left the lobby. Waiting for another player...` : 'Waiting for a second player...',
                step || (this.matchmaking ? '' : `Share the lobby code ${this.gb.game_name} with them.`)];
        }
        const host = this.host;
        if (this.inMatch || host.playing) {
            return [this._step(other), this.score ? `Rounds: you ${this.score.mine}, ${other} ${this.score.theirs}` : ''];
        }
        let line;
        if (!host.ready) line = this._step(other);
        else if (!this.theirReady) line = `Waiting for ${other}'s Game Boy...`;
        else if (!this.leader) line = `${other} starts the match.`;
        else line = this.matchmaking && !this.played ? 'Starting...' : 'Start the match when you are both set.';
        if (!this.result) return [line, ''];
        const won = this.result.won;
        return [won ? 'You won the match!' : won === false ? `${other} won the match.` : 'The match is over.', line];
    }
}
